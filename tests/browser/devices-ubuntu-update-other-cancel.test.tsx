import type { DeviceView } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
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

test("canceling another update's question while the Ubuntu worker's corrected address is tried keeps the worker's answer", async () => {
  const bridge = fakeBridge(freshHome());
  const tried = "sam@ubuntu.local";
  const corrected = "sam@ubuntu-box.local";
  const { remoteLogin: _address, ssh: _ssh, ...base } = MINI;
  const worker: DeviceView = {
    ...base,
    name: "Ubuntu worker",
    system: "linux",
    packageUpdateAt: tried,
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

  // An ordinary Remote Login update of the Studio asks for its password.
  await selectDevice(studio.id);
  await userEvent.click(
    button(
      await shown('[data-device-row="studio"]'),
      m.settingsDevicesMatchNamed({ device: "Mac Studio" }),
    ),
  );
  studioAnswer.resolve({
    asks: "password",
    address: studioAddress,
    for: "update",
    deviceId: studio.id,
  });
  const studioQuestion = await shown(`[data-device-password-question="${studioAddress}"]`);

  // The worker's saved address reaches another account: its form opens prefilled, saying why.
  await selectDevice(worker.id);
  await userEvent.click(
    button(
      await shown('[data-device-row="mini"]'),
      m.settingsDevicesMatchNamed({ device: "Ubuntu worker" }),
    ),
  );
  const why = [`Another account answered at ${tried}.`, "Check the address."];
  workerAnswer.resolve({ asks: "package-address", address: tried, lines: why });
  const form = await shown('[data-worker-update="mini"] [data-device-address-question]');
  const field = form.querySelector("input") as HTMLInputElement;
  expect(field.value).toBe(tried);

  // The captain corrects it and tries again; the Studio's question is canceled while that try runs.
  workerAnswer = held<UpdateAnswer>();
  await userEvent.clear(field);
  await userEvent.type(field, corrected);
  await userEvent.click(button(form, "Try again"));
  await expect
    .poll(() => bridge.requests("inf:devices:update").at(-1))
    .toEqual([worker.id, { address: corrected }]);
  await userEvent.click(button(studioQuestion, "Cancel"));
  await gone(`[data-device-password-question="${studioAddress}"]`);

  // The worker's answer to the corrected address still arrives beneath it.
  workerAnswer.resolve({
    asks: "password",
    address: corrected,
    for: "update",
    deviceId: worker.id,
  });
  const workerQuestion = await shown(
    `[data-worker-update="mini"] [data-device-password-question="${corrected}"]`,
  );
  workerAnswer = held<UpdateAnswer>();
  await userEvent.type(workerQuestion.querySelector("input") as HTMLInputElement, "worker-pw");
  await userEvent.click(button(workerQuestion, "Update"));
  await expect
    .poll(() => bridge.requests("inf:devices:update").at(-1))
    .toEqual([worker.id, { password: "worker-pw", address: corrected }]);
  workerAnswer.resolve(worker);
  await gone('[data-worker-update="mini"]');
});
