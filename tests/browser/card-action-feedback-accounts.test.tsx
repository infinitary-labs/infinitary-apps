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
 * hands it a handler's rejection, wrapped in the remote method's name. One
 * window with one disconnected account: Connect Codex first, then the
 * account's Sign in.
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
 * Whether `reason` is a refused add's own rejection, which its sign-in
 * flight leaves unhandled (`runAccountAdd`'s `void promise.finally`,
 * src/renderer/src/accounts/signInFlight.ts); the window reads the same
 * refusal through its own catch, which this test checks.
 */
const flightLeak = (reason: unknown) =>
  reason instanceof Error &&
  reason.message.startsWith(REQUEST_COPY["inf:accounts:add"].prefix.replace(/: $/, ""));

test("account connection and sign-in failures keep readable reasons and retryable controls", async () => {
  const home = subscribed(
    await seededHome({ accountId: ACCOUNT_ID, providerId: "openrouter", label: "Personal" }),
  );
  const bridge = fakeBridge(home);
  // Each attempt's end asks the core to read the allowance again; it reads
  // what it read at boot.
  const reading = home["inf:quota:snapshot"];
  if (reading === undefined || typeof reading === "function")
    throw new Error("The home answers no allowance reading");
  bridge.answer("inf:quota:refresh", reading);
  const unhandled: unknown[] = [];
  window.addEventListener("unhandledrejection", (event) => unhandled.push(event.reason));
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
  }
  expect(unhandled.filter((reason) => !flightLeak(reason)).map(String)).toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
