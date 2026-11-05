import type { DeviceAddresses, DeviceView } from "@shared/devices";
import type { InvokeChannel } from "@shared/ipc";
import { expect } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { FakeBridge } from "./bridge";

/**
 * Settings -> Devices as the browser tests drive it (docs/devices.md, "Your
 * devices"; design skill components/devices/DevicesTab): the home's own
 * devices, as its list reads them, and the steps a person takes to reach the
 * tab. The tab's container and its two stores (the link panel and what is
 * under way over Remote Login) are reached by no unit test; these files are
 * the guardrails a restructure of `src/renderer/src/settings/DevicesTab.tsx`
 * keeps green (INF-2625's plan, the devices piece).
 */

/** When the home's list was read, in milliseconds since the epoch: the rows' times count from it. */
export const LISTED_AT = Date.now();

/** A Mac that controls this Firstmate, open on it now. */
export const AIR: DeviceView = {
  id: "air",
  kind: "view",
  name: "MacBook Air",
  pairedAt: LISTED_AT - 3_600_000,
  inReach: true,
  seenAt: LISTED_AT - 60_000,
  controlling: true,
};

/**
 * A Mac added by its address, reached over this Mac's own SSH, in reach and
 * on an older version that Remote Login updates.
 */
export const MINI: DeviceView = {
  id: "mini",
  kind: "mac",
  name: "Mac mini",
  pairedAt: LISTED_AT - 7_200_000,
  user: "sam",
  onThisMac: false,
  remoteLogin: "sam@mini.local",
  inReach: true,
  seenAt: LISTED_AT,
  connectedAt: LISTED_AT - 600_000,
  otherVersion: { than: "older", takesWork: true, updateBy: "remote-login" },
  tasks: 0,
  runs: ["website"],
  ssh: { state: "connected" },
};

/**
 * A Mac added by its address whose SSH key it stopped taking: this Mac
 * stopped trying until Try again, and it is out of reach.
 */
export const STUDIO: DeviceView = {
  id: "studio",
  kind: "mac",
  name: "Mac Studio",
  pairedAt: LISTED_AT - 86_400_000,
  user: "kim",
  onThisMac: false,
  remoteLogin: "kim@studio.local",
  inReach: false,
  seenAt: LISTED_AT - 3_600_000,
  tasks: 0,
  runs: ["api"],
  ssh: { state: "stopped", reason: "key-refused" },
};

/** Where devices find this Mac: one address on the local network. */
export const ADDRESSES: DeviceAddresses = {
  addresses: [{ address: "192.168.1.20", network: "local" }],
  chosen: null,
  current: "192.168.1.20",
  name: "kuns-macbook-pro.local",
};

/** What Electron hands the window for a handler that threw `Error(reason)`. */
export function refusedAs(channel: InvokeChannel, reason: string): Error {
  return new Error(`Error invoking remote method '${channel}': Error: ${reason}`);
}

/** One answer the test holds until it says how it ends. */
export function held<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * The system clipboard, standing in for the one a headless page has no
 * permission to write: every text written is kept in order, and `refuse`
 * makes the next write fail, as a clipboard the system refused does.
 */
export function clipboard() {
  const written: string[] = [];
  let refuseNext = false;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (refuseNext) {
          refuseNext = false;
          throw new DOMException("Write permission denied.", "NotAllowedError");
        }
        written.push(text);
      },
    },
  });
  return {
    written,
    refuse: () => {
      refuseNext = true;
    },
  };
}

/** Opens Settings on its Devices tab, and waits for the home's list to draw. */
export async function openDevices(): Promise<HTMLElement> {
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  await userEvent.click(page.getByRole("tab", { name: "Devices", exact: true }));
  await expect.poll(() => document.querySelector("[data-devices]")).not.toBeNull();
  return document.querySelector<HTMLElement>("[data-devices]") as HTMLElement;
}

/** The element `selector` names, once it is on screen; `timeout` for a step the clock takes. */
export async function shown(selector: string, timeout?: number): Promise<HTMLElement> {
  await expect
    .poll(() => document.querySelector(selector), timeout ? { timeout } : {})
    .not.toBeNull();
  return document.querySelector<HTMLElement>(selector) as HTMLElement;
}

/**
 * Returns once the window drew two frames after now, so every answer that
 * already settled has been drawn: what a test then reads is what that answer
 * left, not what was there before it.
 */
export async function afterNextFrame(): Promise<void> {
  for (let frame = 0; frame < 2; frame += 1)
    await new Promise((drawn) => requestAnimationFrame(() => drawn(undefined)));
}

/** Waits until nothing `selector` names is on screen. */
export async function gone(selector: string): Promise<void> {
  await expect.poll(() => document.querySelector(selector)).toBeNull();
}

/** A button inside `within`, by the words a person reads on it or its label. */
export function button(within: Element, name: string): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.getAttribute("aria-label") === name || each.innerText.trim() === name,
  );
  if (!found) throw new Error(`No ${name} button in ${within.outerHTML.slice(0, 200)}`);
  return found;
}

/** The problem line Settings -> Devices says above Your devices, or null. */
export function problemLine(): string | null {
  return document.querySelector('[data-settings-error="devices"]')?.textContent ?? null;
}

/** Every channel the window asked that the test gave no answer for. */
export function unansweredOf(bridge: FakeBridge): string[] {
  return [...new Set(bridge.unanswered)];
}
