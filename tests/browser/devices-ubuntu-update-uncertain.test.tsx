import type { DeviceView } from "@shared/devices";
import type { InvokeResponse } from "@shared/ipc";
import { remoteLoginWords } from "@shared/remoteLogin";
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
  problemLine,
  selectDevice,
  shown,
} from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

type UpdateAnswer = InvokeResponse<"inf:devices:update">;

test("an Ubuntu update that may already have installed after its typed address, host and password keeps its warning with nothing to try again", async () => {
  const bridge = fakeBridge(freshHome());
  const address = "sam@ubuntu.local";
  const line = "ED25519 SHA256:4mF1o0bKqv3n2WZ5c9yTt2kq8hQe8nV7rS1aLm0pXcU";
  const { remoteLogin: _address, ssh: _ssh, ...base } = MINI;
  const worker: DeviceView = {
    ...base,
    name: "Ubuntu worker",
    system: "linux",
    otherVersion: { app: "0.8.1", than: "older", takesWork: true, updateBy: "connection" },
  };
  let answer = held<UpdateAnswer>();
  bridge.answer("inf:devices:list", [worker]);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:update", () => answer.promise);
  await openSize();
  await openWindow(bridge);
  await openDevices();
  const updates = () => bridge.requests("inf:devices:update");

  // No address is known, so the worker's form opens empty and the captain types one.
  await selectDevice(worker.id);
  await userEvent.click(button(await shown('[data-device-row="mini"]'), "Update Ubuntu worker"));
  answer.resolve({ asks: "package-address" });
  const form = await shown('[data-worker-update="mini"] [data-device-address-question]');
  answer = held<UpdateAnswer>();
  await userEvent.type(form.querySelector("input") as HTMLInputElement, address);
  await userEvent.click(button(form, "Update"));
  await expect.poll(() => updates().at(-1)).toEqual([worker.id, { address }]);

  // Its host is confirmed, then its password answered.
  answer.resolve({ asks: "confirm", address, line });
  const confirm = await shown('[data-worker-update="mini"] [data-device-confirm-question]');
  answer = held<UpdateAnswer>();
  await userEvent.click(button(confirm, "This is the computer"));
  await expect.poll(() => updates().at(-1)).toEqual([worker.id, { address, confirm: line }]);
  answer.resolve({ asks: "password", address, for: "update", deviceId: worker.id });
  const password = await shown(
    `[data-worker-update="mini"] [data-device-password-question="${address}"]`,
  );
  answer = held<UpdateAnswer>();
  await userEvent.type(password.querySelector("input") as HTMLInputElement, "worker-pw");
  await userEvent.click(button(password, "Update"));
  await expect
    .poll(() => updates().at(-1))
    .toEqual([worker.id, { password: "worker-pw", address }]);

  // The install ran past its time limit: the warning stays, with no form to try again.
  const said = remoteLoginWords.uncertain("Ubuntu worker");
  answer.resolve({ refused: "failed", lines: [...said], uncertain: true });
  await expect.poll(problemLine).toContain(said[0]);
  expect(problemLine()).toContain(said[1]);
  await gone('[data-worker-update="mini"]');
  expect(document.querySelector("[data-device-address-question]")).toBeNull();
  expect(updates()).toHaveLength(4);
});
