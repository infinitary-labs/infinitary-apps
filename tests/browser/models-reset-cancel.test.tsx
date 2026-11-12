import type { AccountView } from "@shared/accounts";
import type { ModelSlotsView } from "@shared/modelSlots";
import { providerLabel, STARTER_SLOTS } from "@shared/modelSlots";
import type { PiModelRefView, QuotaSnapshotView } from "@shared/quota";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { STARTING_LEVELS_RESET } from "../../src/renderer/src/settings/modelsWords";
import { fakeBridge } from "./bridge";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * A person who pressed "Reset to starting levels" on the Models card in
 * Settings → Intelligence can back out without resetting. A user report:
 * the button "turns into this, with no option to cancel/discard" - armed as
 * "Confirm reset" with only the note "Always use choices are untouched."
 * beside it. Cancel, as the provider row's reset in Subscriptions offers,
 * puts the button back unpressed and sends nothing; the keyboard reaches
 * Cancel with Tab and gets the reset button back under its focus.
 */

const CODEX = "openai-codex";
const ACCOUNT_ID = "acct_models_reset";

/**
 * A home whose person signed in to one Codex account, its models in the
 * levels Codex's starter map gives them, and the reset the core answers
 * with the same starting levels.
 */
function answerIntelligence(bridge: ReturnType<typeof fakeBridge>) {
  const starters = STARTER_SLOTS[CODEX];
  if (!starters) throw new Error("The Codex starter map is missing");
  const accounts: AccountView[] = [
    {
      id: ACCOUNT_ID,
      providerId: CODEX,
      kind: "subscription_oauth",
      label: "Personal",
      enabled: true,
      connected: true,
      pinned: false,
      createdAt: 1,
    },
  ];
  const now = Date.now();
  const snapshot: QuotaSnapshotView = {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: now,
    providers: [
      {
        provider: "codex",
        label: "Codex",
        accountId: ACCOUNT_ID,
        accountLabel: "Personal",
        status: "ok",
        stale: false,
        windows: [],
      },
    ],
  };
  const pool: PiModelRefView[] = Object.keys(starters).map((id) => ({ provider: CODEX, id }));
  const slots: ModelSlotsView = {
    models: pool.map(({ provider, id }) => ({
      provider,
      providerLabel: providerLabel(provider),
      id,
      label: id,
      slots: [...(starters[id] ?? [])],
    })),
    byName: [],
    usingDefaults: true,
  };
  bridge.answer("inf:accounts:list", accounts);
  bridge.answer("inf:quota:snapshot", snapshot);
  // Opening Subscriptions asks the home for any allowance read only on a press; it has none new.
  bridge.answer("inf:quota:opened", snapshot);
  bridge.answer("inf:models:available", pool);
  bridge.answer("inf:models:slots", slots);
  bridge.answer("inf:models:slots:reset", slots);
  bridge.answer("inf:settings:firstmate-model:get", null);
}

test("Cancel backs out of Reset to starting levels without resetting, by pointer and by keys", async () => {
  const bridge = fakeBridge(freshHome());
  answerIntelligence(bridge);
  const unhandled: string[] = [];
  window.addEventListener("error", (event) => unhandled.push(event.message));
  window.addEventListener("unhandledrejection", (event) => unhandled.push(String(event.reason)));
  await openSize();
  await openWindow(bridge);
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  await userEvent.click(page.getByRole("tab", { name: "Intelligence", exact: true }));

  const models = page.getByRole("region", { name: "Models" });
  const reset = models.getByRole("button", { name: STARTING_LEVELS_RESET.reset, exact: true });
  const confirm = models.getByRole("button", { name: STARTING_LEVELS_RESET.confirm, exact: true });
  const cancel = models.getByRole("button", { name: STARTING_LEVELS_RESET.cancel, exact: true });
  const note = models.getByText(STARTING_LEVELS_RESET.note, { exact: true });
  /** The reset button, whatever it reads; it is one element armed or not. */
  const resetElement = reset.element() as HTMLButtonElement;

  // Section: the pointer arms the reset, and Cancel puts it back unpressed.
  await userEvent.click(reset);
  await expect.element(confirm).toBeVisible();
  await expect.element(cancel).toBeVisible();
  await expect.element(note).toBeVisible();
  await userEvent.click(cancel);
  await expect.element(reset).toBeVisible();
  expect(confirm.query()).toBeNull();
  expect(cancel.query()).toBeNull();
  expect(note.query()).toBeNull();
  expect(document.activeElement).toBe(resetElement);
  expect(bridge.requests("inf:models:slots:reset")).toEqual([]);

  // Section: the keyboard arms it, reaches Cancel with Tab, and gets focus back on the reset.
  resetElement.focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(confirm).toBeVisible();
  await userEvent.tab();
  expect(document.activeElement).toBe(cancel.element());
  await userEvent.keyboard("{Enter}");
  await expect.element(reset).toBeVisible();
  expect(cancel.query()).toBeNull();
  expect(document.activeElement).toBe(resetElement);
  expect(resetElement.matches(":focus-visible")).toBe(true);
  expect(bridge.requests("inf:models:slots:reset")).toEqual([]);

  // Section: Confirm reset still resets, once.
  await userEvent.click(reset);
  await userEvent.click(confirm);
  await expect.poll(() => bridge.requests("inf:models:slots:reset")).toEqual([[]]);
  await expect.element(reset).toBeVisible();
  expect(cancel.query()).toBeNull();

  expect(unhandled).toEqual([]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
