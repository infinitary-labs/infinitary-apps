import type { DeviceView } from "@shared/devices";
import type { InvokeResponse } from "@shared/ipc";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import {
  ADDRESSES,
  button,
  gone,
  held,
  MINI,
  openDevices,
  STUDIO,
  selectDevice,
  shown,
} from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

type UpdateAnswer = InvokeResponse<"inf:devices:update">;

test("an earlier update's password question and the Ubuntu worker's each stay with their own flow", async () => {
  const bridge = fakeBridge(freshHome());
  const address = "sam@ubuntu.local";
  const { remoteLogin: _address, ssh: _ssh, ...base } = MINI;
  const worker: DeviceView = {
    ...base,
    name: "Ubuntu worker",
    system: "linux",
    packageUpdateAt: address,
    otherVersion: { app: "0.8.1", than: "older", takesWork: true, updateBy: "connection" },
  };
  const studio: DeviceView = {
    ...STUDIO,
    inReach: true,
    ssh: { state: "connected" },
    otherVersion: { than: "older", takesWork: true, updateBy: "remote-login" },
  };
  const studioAddress = studio.remoteLogin as string;
  const studioAnswer = held<UpdateAnswer>();
  let workerAnswer = held<UpdateAnswer>();
  bridge.answer("inf:devices:list", [worker, studio]);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:update", (deviceId: string) =>
    deviceId === studio.id ? studioAnswer.promise : workerAnswer.promise,
  );
  await openSize();
  await openWindow(bridge);
  await openDevices();

  // An ordinary Remote Login update of the Studio starts first and is still waiting.
  await selectDevice(studio.id);
  await userEvent.click(button(await shown('[data-device-row="studio"]'), "Update Mac Studio"));
  await expect.poll(() => bridge.requests("inf:devices:update")).toEqual([[studio.id, {}]]);
  await selectDevice(worker.id);
  await userEvent.click(button(await shown('[data-device-row="mini"]'), "Update Ubuntu worker"));
  await expect.poll(() => bridge.requests("inf:devices:update")).toHaveLength(2);

  // The worker's address was refused on its own: its form opens prefilled, saying why.
  const why = ["Another account answered at sam@ubuntu.local.", "Check the address."];
  workerAnswer.resolve({ asks: "package-address", address, lines: why });
  const form = await shown('[data-worker-update="mini"] [data-device-address-question]');
  expect(form.querySelector("input")?.value).toBe(address);
  expect(form.querySelector('[role="alert"]')?.textContent).toBe(why.join(""));

  // The worker's password question arrives, then the Studio's; neither takes the other's place.
  workerAnswer = held<UpdateAnswer>();
  await userEvent.click(button(form, "Try again"));
  await expect.poll(() => bridge.requests("inf:devices:update")).toHaveLength(3);
  workerAnswer.resolve({ asks: "password", address, for: "update", deviceId: worker.id });
  const workerQuestion = await shown(
    `[data-worker-update="mini"] [data-device-password-question="${address}"]`,
  );
  studioAnswer.resolve({
    asks: "password",
    address: studioAddress,
    for: "update",
    deviceId: studio.id,
  });
  const studioQuestion = await shown(`[data-device-password-question="${studioAddress}"]`);
  expect(workerQuestion.isConnected).toBe(true);
  expect(studioQuestion.closest("[data-worker-update]")).toBeNull();

  // Each reply goes to the flow that asked it, and the worker's ending leaves the Studio's.
  workerAnswer = held<UpdateAnswer>();
  await userEvent.type(workerQuestion.querySelector("input") as HTMLInputElement, "worker-pw");
  await userEvent.click(button(workerQuestion, "Update"));
  await expect
    .poll(() => bridge.requests("inf:devices:update").at(-1))
    .toEqual([worker.id, { password: "worker-pw", address }]);
  workerAnswer.resolve(worker);
  await gone('[data-worker-update="mini"]');
  expect(studioQuestion.isConnected).toBe(true);
  await userEvent.type(studioQuestion.querySelector("input") as HTMLInputElement, "studio-pw");
  await userEvent.click(button(studioQuestion, "Update"));
  await expect
    .poll(() => bridge.requests("inf:devices:update").at(-1))
    .toEqual([studio.id, { password: "studio-pw" }]);
});
