import * as m from "@shared/i18n/messages.generated";
import type { InvokeResponse } from "@shared/ipc";
import { remoteLoginWords } from "@shared/remoteLogin";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { useShellStore } from "../../src/renderer/src/app/store";
import { fakeBridge } from "./bridge";
import {
  ADDRESSES,
  button,
  gone,
  held,
  openDevices,
  refusedAs,
  shown,
  unansweredOf,
} from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * An add by its address while it is under way in Settings -> Devices
 * (docs/devices.md, "Adding, step by step"): what the page says from the
 * press on, a second press for the same add, and where its answer lands.
 * The intent is INF-6043's change 3, from a person on a Windows PC whose
 * add from the first mate's card showed nothing for fifteen seconds, whose
 * own second press answered "is being set up already", and whose result
 * was dropped once he opened + A computer.
 */

/** An address on a private network, as that person typed it. */
const ADDRESS = "you@100.94.48.29";
/** The two lines the home rejects an add with when nothing answered there. */
const UNREACHABLE = remoteLoginWords.refused("unreachable", { address: ADDRESS });

type AddAnswer = InvokeResponse<"inf:devices:add">;

/** A Devices tab whose every add the test answers, with the adds it was asked. */
async function devicesWithHeldAdds() {
  const home = freshHome();
  const bridge = fakeBridge(home);
  bridge.answer("inf:devices:list", []);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:nearby", { state: "off", user: null, macs: [] });
  const adds: ReturnType<typeof held<AddAnswer>>[] = [];
  bridge.answer("inf:devices:add", () => {
    const add = held<AddAnswer>();
    adds.push(add);
    return add.promise;
  });
  await openSize();
  await openWindow(bridge);
  const devices = await openDevices();
  return { bridge, adds, devices, asked: () => bridge.requests("inf:devices:add") };
}

const field = () => document.querySelector<HTMLInputElement>("#device-remote-login");
const refusalLines = () =>
  [...document.querySelectorAll("[data-device-address-refusal]")].map((line) => line.textContent);

/** Whether the element is wholly inside the window, as a person sees it. */
function inView(element: Element): boolean {
  const box = element.getBoundingClientRect();
  return box.top >= 0 && box.bottom <= window.innerHeight;
}

test("an add under way says Checking from the press on, a second press waits for it, and its answer lands where it was pressed", async () => {
  const { bridge, adds, devices, asked } = await devicesWithHeldAdds();
  const checking = m.settingsDevicesCheckingRow({ address: ADDRESS });
  const refuse = (index: number) =>
    adds[index]?.reject(refusedAs("inf:devices:add", UNREACHABLE.join("\n")));
  const cancelAside = async () => {
    const aside = await shown("[data-device-address-question]");
    await userEvent.click(button(aside, m.settingsDevicesCancel()));
    await gone("[data-device-address-question]");
  };

  // Section: the form's Add it says Checking at once in the list and beside the field, and Enter
  // and the card's Add it for the same address ask the home nothing more.
  {
    await userEvent.click(devices.querySelector('[data-device-add="mac"]') as HTMLElement);
    await userEvent.fill(field() as HTMLInputElement, ADDRESS);
    const aside = await shown("[data-device-address-question]");
    await userEvent.click(button(aside, m.settingsDevicesAddIt()));
    expect((await shown(`[data-device-adding="${ADDRESS}"]`)).textContent).toContain(checking);
    expect((await shown(`[data-device-address-under-way="${ADDRESS}"]`)).textContent).toBe(
      checking,
    );
    expect(button(aside, m.settingsDevicesAddIt()).disabled).toBe(true);
    await userEvent.type(field() as HTMLInputElement, "{Enter}");
    useShellStore.setState({ pendingDeviceArrival: { add: ADDRESS } });
    await expect.poll(() => useShellStore.getState().pendingDeviceArrival).toBeNull();
    expect(asked()).toEqual([[ADDRESS, {}]]);
    expect(refusalLines()).toEqual([]);
    refuse(0);
    await expect.poll(refusalLines).toEqual(UNREACHABLE);
    await gone("[data-device-adding]");
    await gone("[data-device-address-under-way]");
    expect(field()?.value).toBe(ADDRESS);
    await cancelAside();
  }

  // Section: a card's Add it opens Devices and brings its Checking row into view while the tab
  // draws what it reads; + A computer during it holds its address and says it is being checked,
  // and its refusal lands in that form.
  {
    await userEvent.click(page.getByRole("tab", { name: "General", exact: true }));
    await gone("[data-devices]");
    useShellStore.setState({ pendingDeviceArrival: { add: ADDRESS } });
    await userEvent.click(page.getByRole("tab", { name: "Devices", exact: true }));
    const row = await shown(`[data-device-adding="${ADDRESS}"]`);
    expect(row.textContent).toContain(checking);
    await expect.poll(() => inView(row)).toBe(true);
    await userEvent.click(document.querySelector('[data-device-add="mac"]') as HTMLElement);
    await shown(`[data-device-address-under-way="${ADDRESS}"]`);
    expect(field()?.value).toBe(ADDRESS);
    refuse(1);
    await expect.poll(refusalLines).toEqual(UNREACHABLE);
    expect(field()?.value).toBe(ADDRESS);
    expect(asked()).toHaveLength(2);
    await cancelAside();
  }
  useShellStore.setState({ pendingDeviceArrival: { add: ADDRESS } });
  await shown(`[data-device-adding="${ADDRESS}"]`);
  await userEvent.click(page.getByRole("tab", { name: "General", exact: true }));
  await gone("[data-devices]");
  refuse(2);
  await userEvent.click(page.getByRole("tab", { name: "Devices", exact: true }));
  await expect.poll(refusalLines).toEqual(UNREACHABLE);
  expect(field()?.value).toBe(ADDRESS);
  await cancelAside();
  useShellStore.setState({ pendingDeviceArrival: { add: ADDRESS } });
  await shown(`[data-device-adding="${ADDRESS}"]`);
  bridge.push("inf:event", {
    type: "device_setup",
    address: ADDRESS,
    doing: "add",
    stage: "reaching",
    text: remoteLoginWords.reaching(ADDRESS),
    tone: "info",
  });
  await expect
    .poll(() => document.querySelector(`[data-device-adding="${ADDRESS}"]`)?.textContent)
    .toContain(remoteLoginWords.reachingRow(ADDRESS));
  refuse(3);
  await gone("[data-device-adding]");

  expect(adds).toHaveLength(4);
  expect(unansweredOf(bridge)).toEqual([]);
});
