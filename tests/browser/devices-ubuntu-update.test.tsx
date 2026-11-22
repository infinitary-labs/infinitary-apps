import type { DeviceView } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import type { InvokeResponse } from "@shared/ipc";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { useShellStore } from "../../src/renderer/src/app/store";
import { fakeBridge } from "./bridge";
import {
  ADDRESSES,
  button,
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

test("Ubuntu updates from the row and card keep their worker selected through the question", async () => {
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
  let received = held<UpdateAnswer>();
  bridge.answer("inf:devices:list", [worker, STUDIO]);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:update", () => received.promise);
  await openSize();
  await openWindow(bridge);
  await openDevices();
  for (const [index, source] of ["row", "card"].entries()) {
    received = held<UpdateAnswer>();
    if (source === "row") {
      await selectDevice(worker.id);
      await userEvent.click(
        button(
          await shown('[data-device-row="mini"]'),
          m.settingsDevicesMatchNamed({ device: "Ubuntu worker" }),
        ),
      );
    } else {
      await selectDevice(STUDIO.id);
      useShellStore.setState({ pendingDeviceArrival: { update: worker.id } });
    }
    await expect.poll(() => bridge.requests("inf:devices:update")).toHaveLength(index + 1);
    expect(bridge.requests("inf:devices:update").at(-1)).toEqual([
      worker.id,
      { packageFallback: true },
    ]);
    const other = await shown('[data-device-select="studio"]');
    await userEvent.click(other);
    expect(document.querySelector('[data-device-row="mini"]')).not.toBeNull();
    expect(document.querySelector("[data-device-address-question]")).toBeNull();
    received.resolve({ asks: "package-address", address });
    const form = await shown('[data-worker-update="mini"] [data-device-address-question]');
    const inset = form.parentElement;
    expect(inset?.previousElementSibling).toBe(document.querySelector('[data-device-row="mini"]'));
    expect(form.querySelector("input")?.value).toBe(address);
    await userEvent.click(other);
    expect(form.isConnected).toBe(true);
    await userEvent.click(await shown('[data-worker-update="mini"] input'));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(other);
    await shown('[data-device-row="studio"]');
    expect(form.isConnected).toBe(false);
  }

  // A consumed newer Update card must not resurrect an older Remove card.
  const oldRemove = held<DeviceView[]>();
  const beforeRemove = bridge.requests("inf:devices:list").length;
  bridge.answer("inf:devices:list", () => oldRemove.promise);
  useShellStore.setState({ pendingDeviceArrival: { remove: STUDIO.id } });
  await expect.poll(() => bridge.requests("inf:devices:list").length).toBeGreaterThan(beforeRemove);
  received = held<UpdateAnswer>();
  bridge.answer("inf:devices:list", [worker, STUDIO]);
  useShellStore.setState({ pendingDeviceArrival: { update: worker.id } });
  await expect.poll(() => bridge.requests("inf:devices:update")).toHaveLength(3);
  received.resolve({ asks: "package-address", address });
  const newQuestion = await shown('[data-worker-update="mini"] [data-device-address-question]');
  oldRemove.resolve([worker, STUDIO]);
  await oldRemove.promise;
  await userEvent.click(button(newQuestion, "Cancel"));
  await selectDevice(STUDIO.id);
  expect(document.querySelector('[data-device-removing="studio"]')).toBeNull();
  expect(bridge.requests("inf:devices:remove")).toHaveLength(0);
  expect(useShellStore.getState().pendingDeviceArrival).toBeNull();

  // A card lookup that began first must not interrupt a later row update.
  const lookup = held<DeviceView[]>();
  const beforeLookup = bridge.requests("inf:devices:list").length;
  bridge.answer("inf:devices:list", () => lookup.promise);
  useShellStore.setState({ pendingDeviceArrival: { update: STUDIO.id } });
  await expect.poll(() => bridge.requests("inf:devices:list").length).toBeGreaterThan(beforeLookup);
  received = held<UpdateAnswer>();
  await selectDevice(worker.id);
  await userEvent.click(
    button(
      await shown('[data-device-row="mini"]'),
      m.settingsDevicesMatchNamed({ device: "Ubuntu worker" }),
    ),
  );
  await expect.poll(() => bridge.requests("inf:devices:update")).toHaveLength(4);
  received.resolve({ asks: "package-address", address });
  const pending = await shown('[data-worker-update="mini"] [data-device-address-question]');
  bridge.answer("inf:devices:list", [STUDIO]);
  lookup.resolve([worker, STUDIO]);
  await expect
    .poll(() => useShellStore.getState().pendingDeviceArrival)
    .toEqual({ update: STUDIO.id });
  expect(bridge.requests("inf:devices:update")).toHaveLength(4);
  expect(pending.isConnected).toBe(true);

  // Removing the worker from the list clears the obsolete question and resumes the card.
  received = held<UpdateAnswer>();
  bridge.push("inf:devices", [STUDIO]);
  await expect.poll(() => bridge.requests("inf:devices:update")).toHaveLength(5);
  expect(bridge.requests("inf:devices:update").at(-1)).toEqual([STUDIO.id, {}]);
  expect(pending.isConnected).toBe(false);
  received.resolve(STUDIO);
});
