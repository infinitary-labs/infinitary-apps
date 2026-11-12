import type { AccountView } from "@shared/accounts";
import { type ModelSlotsView, offeringKey, providerLabel, STARTER_SLOTS } from "@shared/modelSlots";
import type { QuotaSnapshotView } from "@shared/quota";
import { SMALLEST_WINDOW } from "@shared/smallestWindow";
import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { type FakeBridge, fakeBridge } from "./bridge";
import { freshHome } from "./freshHome";
import { APP_WINDOW, openSize, openWindow } from "./window";

/**
 * Phase 5 seams (docs/architecture.md §17 + the account broker): the
 * Subscriptions tab as ONE list of accounts (the Instruments relayout),
 * per-account micro-meters, and the Models board where a model is placed in
 * levels or taken out of use. The full e2e run once caught a Models row's
 * menu item "outside of the viewport": a row low in the Models list opened a
 * menu no click could reach. The board has no row menu now; what a person
 * reaches from the bottom edge is the model's panel, and it has to stay
 * workable there, at the shortest window the app allows.
 *
 * The home is the journey's: two Codex accounts, two Grok accounts and a
 * Claude one, each with its allowance reading, and the models they serve in
 * the levels their starter maps give them. A seeded home cannot hold an
 * account yet - its core would read each account's allowance from the
 * provider over the network - so the core's lists are answered here.
 */

const CODEX_PERSONAL = "acct_e2e1";
const CODEX_WORK = "acct_e2e2";
const GROK_PERSONAL = "acct_grok1";
const GROK_TEAM = "acct_grok2";
const CLAUDE_PERSONAL = "acct_claude1";
/** The identity Claude's row follows. */
const CLAUDE_IDENTITY = "kun@example.com";
const HOUR = 3600 * 1000;

/** One account as the core lists it: on, signed in, not preferred, added on day `day`. */
function account(
  day: number,
  row: Pick<AccountView, "id" | "providerId" | "kind" | "label"> & Partial<AccountView>,
): AccountView {
  return {
    enabled: true,
    connected: true,
    pinned: false,
    createdAt: Date.parse("2026-08-01T00:00:00Z") + day * 24 * HOUR,
    ...row,
  };
}

/** The accounts the core lists, in the order they were added. */
const ACCOUNTS: AccountView[] = [
  account(0, {
    id: CODEX_PERSONAL,
    providerId: "openai-codex",
    kind: "subscription_oauth",
    label: "Personal",
  }),
  account(1, {
    id: CODEX_WORK,
    providerId: "openai-codex",
    kind: "subscription_oauth",
    label: "Work #2",
  }),
  account(2, { id: GROK_PERSONAL, providerId: "xai", kind: "api_key", label: "Personal" }),
  account(3, { id: GROK_TEAM, providerId: "xai", kind: "api_key", label: "Team" }),
  account(4, {
    id: CLAUDE_PERSONAL,
    providerId: "anthropic-claude",
    kind: "subscription_oauth",
    label: CLAUDE_IDENTITY,
    identity: CLAUDE_IDENTITY,
  }),
];

/** Each account's allowance reading, with real cycle evidence resetting after the run starts. */
function snapshotAt(now: number): QuotaSnapshotView {
  return {
    generatedAt: new Date(now).toISOString(),
    fetchedAt: now,
    providers: [
      {
        provider: "codex",
        label: "Codex",
        accountId: CODEX_PERSONAL,
        accountLabel: "Personal",
        plan: "Plus",
        account: "kun@example.com",
        status: "ok",
        stale: false,
        windows: [
          {
            id: "session",
            label: "session",
            percentRemaining: 74,
            resetText: "resets 3pm",
            pace: "behind",
            resetsAtMs: now + 2 * HOUR,
            windowSeconds: 18_000,
          },
          {
            id: "weekly",
            label: "weekly",
            percentRemaining: 9,
            resetText: "resets Fri",
            pace: "ahead",
            resetsAtMs: now + 5 * 24 * HOUR,
            windowSeconds: 604_800,
          },
        ],
      },
      {
        provider: "codex",
        label: "Codex",
        accountId: CODEX_WORK,
        accountLabel: "Work #2",
        plan: "Pro",
        status: "ok",
        stale: false,
        windows: [
          {
            id: "weekly",
            label: "weekly",
            percentRemaining: 46,
            resetText: "resets Wed",
            pace: "ahead",
          },
        ],
      },
      {
        provider: "claude",
        label: "Claude",
        accountId: CLAUDE_PERSONAL,
        accountLabel: CLAUDE_IDENTITY,
        status: "ok",
        stale: false,
        windows: [
          {
            id: "five_hour",
            label: "session",
            percentRemaining: 68,
            pace: "behind",
            resetText: "resets 6pm",
            resetsAtMs: now + 2 * HOUR,
            windowSeconds: 18_000,
          },
          {
            id: "seven_day",
            label: "weekly",
            percentRemaining: 31,
            pace: "behind",
            resetText: "resets Mon",
            resetsAtMs: now + 12 * HOUR,
            windowSeconds: 604_800,
          },
        ],
      },
      {
        provider: "grok",
        label: "Grok",
        accountId: GROK_PERSONAL,
        accountLabel: "Personal",
        plan: "SuperGrok",
        status: "ok",
        stale: true,
        windows: [{ id: "credits", label: "credits", percentRemaining: 57 }],
      },
      {
        provider: "grok",
        label: "Grok",
        accountId: GROK_TEAM,
        accountLabel: "Team",
        status: "ok",
        stale: false,
        windows: [],
      },
    ],
  };
}

/**
 * The board's lists as the core answers them, and its levels as the core
 * keeps them: each starter of the accounts' providers is a row in its
 * starter levels, and a change of one level answers the board with it.
 */
function answerModels(bridge: FakeBridge): void {
  let view: ModelSlotsView = {
    models: ["openai-codex", "xai", "anthropic-claude"].flatMap((provider) =>
      Object.entries(STARTER_SLOTS[provider] ?? {}).map(([id, slots]) => ({
        provider,
        providerLabel: providerLabel(provider),
        id,
        label: id,
        slots: [...slots],
      })),
    ),
    byName: [],
    usingDefaults: true,
  };
  bridge.answer("inf:models:slots", () => view);
  bridge.answer("inf:models:available", () =>
    view.models.map(({ provider, id }) => ({ provider, id })),
  );
  bridge.answer("inf:models:slots:set", (key, slot, on) => {
    view = {
      ...view,
      usingDefaults: false,
      models: view.models.map((model) =>
        offeringKey(model) !== key
          ? model
          : {
              ...model,
              slots: on
                ? [...new Set([...model.slots, slot])]
                : model.slots.filter((level) => level !== slot),
            },
      ),
    };
    return view;
  });
}

/** The levels panel open on `label`. */
const panelOf = (label: string) =>
  page.getByRole("complementary", { name: `${label} levels`, exact: true });

test("a model at the bottom of the shortest window can still be taken out of use and put back", async () => {
  const bridge = fakeBridge(freshHome());
  bridge.answer("inf:accounts:list", ACCOUNTS);
  const shown = snapshotAt(Date.now());
  bridge.answer("inf:quota:snapshot", shown);
  // Opening Subscriptions asks the home for any allowance read only on a press; it has none new.
  bridge.answer("inf:quota:opened", shown);
  bridge.answer("inf:settings:firstmate-account:get", CODEX_PERSONAL);
  answerModels(bridge);
  await openSize();
  await openWindow(bridge);
  await userEvent.click(page.getByRole("button", { name: "Settings", exact: true }));
  await userEvent.click(page.getByRole("tab", { name: "Intelligence", exact: true }));

  const view = await bridge.api.models.slots();
  const model = view.models.find((row) => row.slots.length === 1 && row.slots[0] === "low");
  if (!model) throw new Error("No listed model sits in low alone");
  const key = offeringKey(model);
  const rowIn = (slot: string) =>
    document.querySelector<HTMLElement>(`[data-slot-group="${slot}"] [data-model-row="${key}"]`);
  // The Models board, unfolded.
  const models = page.getByRole("region", { name: "Models" });
  const head = models.getByRole("button", { name: /^Models/ });
  await expect.element(head).toBeVisible();
  if (head.element().getAttribute("aria-expanded") !== "true") await userEvent.click(head);
  await expect.element(head).toHaveAttribute("aria-expanded", "true");

  // The shortest window the app allows, at today's width.
  await page.viewport(APP_WINDOW.width, SMALLEST_WINDOW.height);
  try {
    await expect.poll(() => rowIn("low")).not.toBeNull();
    rowIn("low")?.scrollIntoView({ block: "end" });
    await userEvent.click(
      page
        .elementLocator(rowIn("low") as HTMLElement)
        .getByRole("button", { name: model.label, exact: true }),
    );
    const panel = panelOf(model.label);
    await expect.element(panel).toBeVisible();
    await userEvent.click(
      panel.getByRole("button", { name: `Remove ${model.label} from all levels`, exact: true }),
    );
    await expect.poll(() => rowIn("off")).not.toBeNull();
    await expect.poll(() => rowIn("low")).toBeNull();
    // And back where it was, from the bottom edge again.
    rowIn("off")?.scrollIntoView({ block: "end" });
    await userEvent.click(
      panel.getByRole("checkbox", { name: `Use ${model.label} at low`, exact: true }),
    );
    await expect.poll(() => rowIn("low")).not.toBeNull();
    await userEvent.click(panel.getByRole("button", { name: `Close ${model.label}`, exact: true }));
    await expect.element(panel).not.toBeInTheDocument();
  } finally {
    await openSize();
  }
  expect(bridge.requests("inf:models:slots:set")).toEqual([
    [key, "low", false],
    [key, "low", true],
  ]);
  expect([...new Set(bridge.unanswered)]).toEqual([]);
});
