import type { InvokeChannel, InvokeResponse } from "@shared/ipc";
import type { QuotaSnapshotView } from "@shared/quota";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { purgedTasksText } from "../../src/renderer/src/settings/generalWords";
import { type FakeBridge, fakeBridge } from "./bridge";
import { freshHome } from "./freshHome";
import type { Rect } from "./layout";
import { openSize, openWindow } from "./window";

/**
 * Settings action feedback, moved from `tests/e2e/card-action-feedback.spec.ts`:
 * Refresh and Purge commit in place - the press disables the button at the
 * first frame, a second press in the same tick sends nothing more, and the
 * pending label keeps the button's box - and a refusal says why beside the
 * control, without the transport's words, and leaves it ready to try again.
 * A failure of the model list Refresh reloads reads the same way. The
 * answers are held as the test chooses, not on a timer, and a refusal
 * reaches the window as Electron hands it a handler's rejection, wrapped in
 * the remote method's name. One window in the dark theme: Intelligence's
 * Refresh first, then General's Purge.
 */

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
 * Holds `channel`'s answers until the test lets each one go: controlled
 * latency, not a timer. `reply` answers the newest request with `result`, or
 * rejects it as Electron would.
 */
function hold<C extends InvokeChannel>(bridge: FakeBridge, channel: C, result: InvokeResponse<C>) {
  const probe = {
    calls: 0,
    settle: (_fail: boolean) => {},
    reply(fail = false) {
      probe.settle(fail);
    },
  };
  bridge.answer(channel, () => {
    probe.calls += 1;
    return new Promise<InvokeResponse<C>>((resolve, reject) => {
      probe.settle = (fail) =>
        fail ? reject(transported(channel, "Error", REQUEST_REASON)) : resolve(result);
    });
  });
  return probe;
}

const box = (element: Element): Rect => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const button = (name: string) => page.getByRole("button", { name, exact: true });

/** Presses `name` twice in one tick, before React paints, and says whether the next frame shows it disabled. */
async function pressTwice(name: string): Promise<boolean> {
  const element = button(name).element() as HTMLButtonElement;
  element.click();
  element.click();
  await nextFrame();
  return element.disabled;
}

/** The boundary promise: a useful reason survives, transport diagnostics do not. */
async function expectReadable(feedback: () => HTMLElement | null, reason: string): Promise<void> {
  await expect.poll(() => feedback()?.textContent ?? "").toContain(reason);
  await expect.element(feedback() as HTMLElement).toBeVisible();
  expect(feedback()?.textContent).not.toMatch(TRANSPORT);
}

/** Refresh's refusal, beside the Intelligence header. */
const quotaFeedback = () =>
  document.querySelector<HTMLElement>('[data-settings-error="subscriptions"]');

/** The Purge task data row, which says a purge's refusal and its result. */
const purgeRow = () => document.querySelector<HTMLElement>('[data-setting="purge-task-data"]');

test("quota refresh and purge commit in place, refuse duplicate clicks, and show failures (dark)", async () => {
  // The Intelligence header's meta and Refresh render only once a snapshot
  // has providers (docs/first-launch.md), so the home carries one measured
  // row; no account is needed for the header.
  const now = Date.now();
  const snapshot: QuotaSnapshotView = {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: now,
    providers: [
      {
        provider: "codex",
        label: "Codex",
        accountId: "acct_feedback",
        accountLabel: "Personal",
        status: "ok",
        stale: false,
        windows: [],
      },
    ],
  };
  const bridge = fakeBridge(freshHome());
  bridge.answer("inf:quota:snapshot", snapshot);
  // Opening Subscriptions asks the home for any allowance read only on a press; it has none new.
  bridge.answer("inf:quota:opened", snapshot);
  const refreshRequest = hold(bridge, "inf:quota:refresh", snapshot);
  await openSize();
  await openWindow(bridge);

  // Section: the dark theme, chosen in Settings, which stays open.
  await userEvent.click(button("Settings"));
  const previous = page.getByRole("tab", { selected: true }).element().textContent ?? "";
  await userEvent.click(page.getByRole("tab", { name: "Appearance", exact: true }));
  const dark = page
    .getByRole("radiogroup", { name: "Theme", exact: true })
    .getByRole("radio", { name: "Dark", exact: true });
  await userEvent.click(dark);
  await expect.element(dark).toBeChecked();
  await expect.poll(() => document.body.dataset.theme).toBe("dark");
  await userEvent.click(page.getByRole("tab", { name: previous, exact: true }));

  // Section: quota refresh commits in place, refuses a duplicate click and shows its failure.
  await userEvent.click(page.getByRole("tab", { name: "Intelligence", exact: true }));
  await expect.element(button("Refresh")).toBeVisible();
  const before = box(button("Refresh").element());
  expect(await pressTwice("Refresh")).toBe(true);
  await expect.element(button("Refreshing...")).toBeDisabled();
  expect(box(button("Refreshing...").element())).toEqual(before);
  await expect.poll(() => refreshRequest.calls).toBe(1);
  refreshRequest.reply(true);
  await expectReadable(quotaFeedback, REQUEST_REASON);
  await expect.element(button("Refresh")).toBeEnabled();
  await userEvent.click(button("Refresh"));
  await expect.poll(() => refreshRequest.calls).toBe(2);
  refreshRequest.reply();
  await expect.element(button("Refresh")).toBeEnabled();
  await expect.poll(quotaFeedback).toBeNull();

  // Refresh also reloads the model list. A failure in that follow-on read
  // must not reintroduce the transport wrapper after quota itself succeeds.
  bridge.answer("inf:models:slots", () => {
    throw transported("inf:models:slots", "TypeError", REQUEST_REASON);
  });
  await userEvent.click(button("Refresh"));
  await expect.poll(() => refreshRequest.calls).toBe(3);
  refreshRequest.reply();
  await expectReadable(quotaFeedback, REQUEST_REASON);
  await expect.element(button("Refresh")).toBeEnabled();

  // Section: purge arms first, commits in place, refuses a duplicate click and shows its failure.
  const purgedTasks = 2;
  const purgeRequest = hold(bridge, "inf:retention:purge", { purgedTasks });
  await userEvent.click(page.getByRole("tab", { name: "General", exact: true }));
  await userEvent.click(button("Purge"));
  expect(purgeRequest.calls).toBe(0); // Arming is not destructive.
  await expect.element(button("Confirm purge")).toBeVisible();
  const purgeBefore = box(button("Confirm purge").element());
  expect(await pressTwice("Confirm purge")).toBe(true);
  await expect.element(button("Purging...")).toBeDisabled();
  expect(box(button("Purging...").element())).toEqual(purgeBefore);
  await expect.poll(() => purgeRequest.calls).toBe(1);
  purgeRequest.reply(true);
  await expectReadable(purgeRow, REQUEST_REASON);
  await userEvent.click(button("Purge"));
  await userEvent.click(button("Confirm purge"));
  await expect.poll(() => purgeRequest.calls).toBe(2);
  purgeRequest.reply();
  await expect
    .poll(() =>
      [...(purgeRow()?.querySelectorAll("*") ?? [])].some(
        (element) =>
          element.textContent === purgedTasksText(purgedTasks) && element.checkVisibility(),
      ),
    )
    .toBe(true);
  await expect.element(button("Purge")).toBeEnabled();
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
