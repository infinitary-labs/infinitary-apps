import type { InvokeChannel } from "@shared/ipc";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { REQUEST_COPY } from "../../src/preload/readableRequest";
import { type FakeBridge, fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Account action feedback, moved from `tests/e2e/card-action-feedback.spec.ts`:
 * a refused connection or sign-in says why beside the step it belongs to
 * (INF-838), without the transport's words, and leaves its control ready to
 * try again; a refusal with no reason reads the request's own fallback
 * (src/preload/readableRequest.ts). The answers are held as the test
 * chooses, not on a timer, and each refusal reaches the window as Electron
 * hands it a handler's rejection, wrapped in the remote method's name. A
 * refused attempt, and a refused allowance reading after it, leave no
 * rejection unhandled in the window. One window with one disconnected
 * account: Connect Codex first, then the account's Sign in.
 */

const ACCOUNT_ID = "acct_settings_feedback";

/** The reason a refused request gives in this story. */
const REQUEST_REASON = "The request could not be completed.";

/** Words that belong to the transport, never to a refusal a person reads. */
const TRANSPORT = /Error invoking remote method|\bfm:|(?:Type|Zod)?Error:|\[object Object\]/;

/** What Electron hands the window for a handler that rejected with `name: message`. */
function transported(channel: InvokeChannel, name: string, message: string): Error {
  return new Error(
    `Error invoking remote method '${channel}': ${message ? `${name}: ${message}` : name}`,
  );
}

/**
 * Holds `channel`'s requests until the test refuses each one with `name:
 * message`, as Electron hands a handler's rejection on: controlled latency,
 * not a timer.
 */
function holdRefusal(bridge: FakeBridge, channel: InvokeChannel, name: string, message: string) {
  const probe = { calls: 0, refuse: () => {} };
  bridge.answer(channel, () => {
    probe.calls += 1;
    return new Promise<never>((_resolve, reject) => {
      probe.refuse = () => reject(transported(channel, name, message));
    });
  });
  return probe;
}

/** A sign-in's refusal, beside the step it belongs to. */
const feedback = () => document.querySelector<HTMLElement>('[data-settings-error="sign-in"]');

/** The boundary promise: a useful reason survives, transport diagnostics do not. */
async function expectReadable(reason: string): Promise<void> {
  await expect.poll(() => feedback()?.textContent ?? "").toContain(reason);
  await expect.element(feedback() as HTMLElement).toBeVisible();
  expect(feedback()?.textContent).not.toMatch(TRANSPORT);
}

/**
 * Refuses every allowance reading the window asks for, as Electron hands a
 * handler's rejection on, and counts them.
 */
function refuseReadings(bridge: FakeBridge) {
  const probe = { calls: 0 };
  bridge.answer("inf:quota:refresh", () => {
    probe.calls += 1;
    return Promise.reject(transported("inf:quota:refresh", "Error", REQUEST_REASON));
  });
  return probe;
}

/** The test's own rejection, which `reportedSoFar` makes and waits on. */
class Mark extends Error {}

/**
 * Resolves once every rejection made before the call, that nobody handled,
 * has been reported: the browser reports unhandled rejections in the order
 * they were rejected, so once the test's own is reported, every earlier one
 * the window left unhandled has been too.
 */
async function reportedSoFar(): Promise<void> {
  const mark = new Mark();
  const reported = new Promise<void>((resolve) => {
    const seen = (event: PromiseRejectionEvent) => {
      if (event.reason !== mark) return;
      event.preventDefault();
      window.removeEventListener("unhandledrejection", seen);
      resolve();
    };
    window.addEventListener("unhandledrejection", seen);
  });
  void Promise.reject(mark);
  await reported;
}

test("account connection and sign-in failures keep readable reasons and retryable controls", async () => {
  const home = subscribed(
    await seededHome({ accountId: ACCOUNT_ID, providerId: "openrouter", label: "Personal" }),
  );
  const bridge = fakeBridge(home);
  const reading = home["inf:quota:snapshot"];
  if (reading === undefined || typeof reading === "function")
    throw new Error("The home answers no allowance reading");
  // Every rejection the window leaves unhandled, the test's own marks aside.
  const unhandled: unknown[] = [];
  const collect = (event: PromiseRejectionEvent) => {
    if (!(event.reason instanceof Mark)) unhandled.push(event.reason);
  };
  window.addEventListener("unhandledrejection", collect);
  await openSize();
  await openWindow(bridge);
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  await userEvent.click(page.getByRole("tab", { name: "Intelligence", exact: true }));
  const controls = [
    ["inf:accounts:add", () => page.getByRole("button", { name: "Connect Codex", exact: true })],
    [
      "inf:accounts:sign-in",
      () =>
        page
          .elementLocator(
            document.querySelector(`[data-account-row="${ACCOUNT_ID}"]`) as HTMLElement,
          )
          .getByRole("button", { name: "Sign in", exact: true }),
    ],
  ] as const;
  for (const [channel, control] of controls) {
    // Each attempt's end asks the core to read the allowance again; it reads
    // what it read at boot until the last section refuses it.
    bridge.answer("inf:quota:refresh", reading);

    // Section: a refused request keeps its reason readable and its control retryable.
    let held = holdRefusal(bridge, channel, "TypeError", REQUEST_REASON);
    await expect.element(control()).toBeEnabled();
    await userEvent.click(control());
    await expect.poll(() => held.calls).toBe(1);
    held.refuse();
    await expectReadable(REQUEST_REASON);
    await expect.element(control()).toBeEnabled();
    // The first refusal did not strand the control.
    await userEvent.click(control());
    await expect.poll(() => held.calls).toBe(2);
    await expect.poll(feedback).toBeNull();
    held.refuse();
    await expectReadable(REQUEST_REASON);
    await expect.element(control()).toBeEnabled();

    // Section: a refusal with no reason reads the request's own fallback.
    held = holdRefusal(bridge, channel, "Error", "");
    await userEvent.click(control());
    await expect.poll(() => held.calls).toBe(1);
    held.refuse();
    await expectReadable(REQUEST_COPY[channel].fallback);
    await expect.element(control()).toBeEnabled();

    // Section: the allowance reading after a refused attempt is refused too;
    // the attempt's reason still reads beside its step.
    const readings = refuseReadings(bridge);
    held = holdRefusal(bridge, channel, "TypeError", REQUEST_REASON);
    await userEvent.click(control());
    await expect.poll(() => held.calls).toBe(1);
    held.refuse();
    await expectReadable(REQUEST_REASON);
    await expect.element(control()).toBeEnabled();
    await expect.poll(() => readings.calls).toBe(1);
  }
  // No refused request, the window's own or its allowance reading after it,
  // is left unhandled.
  await reportedSoFar();
  window.removeEventListener("unhandledrejection", collect);
  expect(unhandled.map(String)).toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
