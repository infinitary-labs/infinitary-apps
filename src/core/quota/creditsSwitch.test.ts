import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as m from "@shared/i18n/messages.generated";
import { type QuotaProviderView, type QuotaSnapshotView, SAVED_RESETS_PAGE } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { creditsOfferCard } from "../orchestrator/hostCards";
import { selectAccount } from "../routing/accountPolicy";
import { route } from "../routing/routingEngine";
import { buildModelsCatalog, limitingResetOf, markCredits } from "./catalog";
import {
  type CreditsOffer,
  CreditsWatch,
  creditsOffers,
  forgetAnsweredOffers,
  stampSnapshot,
} from "./creditsSwitch";
import { parseCodexUsage } from "./providers/codex";

/**
 * Keep going on credits (INF-4104 piece 2, docs/quota.md "Keep going on
 * credits"): an account whose allowance is spent keeps serving on its
 * provider's credits once its switch is on - after every included allowance
 * at the level, before a weaker level - and the app says when it starts and
 * when the credits run out. The readings are whole provider answers
 * (`tests/fixtures/quota-credits`).
 */

const NOW = Date.parse("2026-11-13T21:00:00Z");

const body = JSON.parse(
  readFileSync(
    join(__dirname, "../../../tests/fixtures/quota-credits/codex-usage-credits.json"),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;

/**
 * The live Codex reading with its weekly window at `used` percent, and its
 * credits and saved resets (`rate_limit_reset_credits`) as given.
 */
function codexRow(
  accountId: string,
  used: number,
  credits: Record<string, unknown> = {},
  at = NOW,
  resets: Record<string, unknown> = {},
): QuotaProviderView {
  const rateLimit = body.rate_limit as Record<string, Record<string, unknown>>;
  const parsed = parseCodexUsage(
    {
      ...body,
      rate_limit: {
        ...rateLimit,
        primary_window: { ...rateLimit.primary_window, used_percent: used },
      },
      credits: { ...body.credits, ...credits },
      rate_limit_reset_credits: { ...body.rate_limit_reset_credits, ...resets },
    },
    at,
  );
  return {
    provider: "codex",
    label: "Codex",
    accountId,
    accountLabel: accountId,
    status: "ok",
    stale: false,
    windows: parsed.windows,
    ...(parsed.credits ? { credits: parsed.credits } : {}),
    ...(parsed.savedResets ? { savedResets: parsed.savedResets } : {}),
  };
}

const claudeRow: QuotaProviderView = {
  provider: "claude",
  label: "Claude",
  accountId: "claude-personal",
  status: "ok",
  stale: false,
  windows: [{ id: "weekly", label: "weekly", percentRemaining: 60 }],
};

const models = [
  { provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra" },
  { provider: "anthropic-claude", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { provider: "anthropic-claude", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
];

/** A hard task's route over these rows, with the switch on for the named accounts. */
function hardTask(rows: QuotaProviderView[], keepsGoing: string[], highClaude = false) {
  const providers = stampSnapshot(
    { generatedAt: new Date(NOW).toISOString(), fetchedAt: NOW, providers: rows },
    (accountId) => keepsGoing.includes(accountId),
  ).providers;
  const catalog = markCredits(
    buildModelsCatalog(models, providers, new Date(NOW).toISOString(), NOW),
    providers,
  ).models;
  return route({
    catalog,
    available: models,
    slotted: [
      { provider: "openai-codex", id: "gpt-6-astra", slot: "high" },
      ...(highClaude
        ? [{ provider: "anthropic-claude", id: "claude-opus-5-5", slot: "high" as const }]
        : []),
      { provider: "anthropic-claude", id: "claude-sonnet-5-5", slot: "medium" },
    ],
    pins: [],
    bucket: "high",
  });
}

describe("a hard task once Codex's allowance is spent", () => {
  it("stays at its level on credits with the switch on", () => {
    const decision = hardTask([codexRow("codex-work", 100), claudeRow], ["codex-work"]);
    expect(decision.choice).toEqual({ provider: "openai-codex", id: "gpt-6-astra" });
    expect(decision.bucket).toBe("high");
    expect(decision.reasons.join(" ")).toContain("spends credits past its allowance");
  });

  it("drops to a weaker level with the switch off", () => {
    const decision = hardTask([codexRow("codex-work", 100), claudeRow], []);
    expect(decision.choice).toEqual({ provider: "anthropic-claude", id: "claude-sonnet-5-5" });
  });

  it("drops once the provider says the credits are spent, switch on or not", () => {
    const spent = codexRow("codex-work", 100, { overage_limit_reached: true });
    expect(spent.credits?.state).toBe("spent");
    const decision = hardTask([spent, claudeRow], ["codex-work"]);
    expect(decision.choice).toEqual({ provider: "anthropic-claude", id: "claude-sonnet-5-5" });
  });

  it("spends credits only after every included allowance at the level", () => {
    const decision = hardTask([codexRow("codex-work", 100), claudeRow], ["codex-work"], true);
    expect(decision.choice).toEqual({ provider: "anthropic-claude", id: "claude-opus-5-5" });
  });

  it("serves the same model from another Codex account's allowance before the one on credits", () => {
    const providers = stampSnapshot(
      {
        generatedAt: new Date(NOW).toISOString(),
        fetchedAt: NOW,
        providers: [codexRow("codex-work", 100), codexRow("codex-home", 90)],
      },
      () => true,
    ).providers;
    const [astra] = buildModelsCatalog(models, providers, new Date(NOW).toISOString(), NOW).models;
    expect(astra?.effectivePercentRemaining).toBe(10);
  });
});

describe("the account a model is served from", () => {
  it("takes an account with allowance left before one on credits", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        {
          accountId: "a",
          label: "Work",
          enabled: true,
          connected: true,
          effectivePercentRemaining: 0,
          onCredits: true,
        },
        {
          accountId: "b",
          label: "Home",
          enabled: true,
          connected: true,
          effectivePercentRemaining: 5,
        },
      ],
    });
    expect(decision.accountId).toBe("b");
  });

  it("keeps going on credits when every account's allowance is spent", () => {
    const decision = selectAccount({
      providerId: "openai-codex",
      candidates: [
        {
          accountId: "a",
          label: "Work",
          enabled: true,
          connected: true,
          effectivePercentRemaining: 0,
          onCredits: true,
        },
        {
          accountId: "b",
          label: "Home",
          enabled: true,
          connected: true,
          effectivePercentRemaining: 0,
        },
      ],
    });
    expect(decision.accountId).toBe("a");
    expect(decision.reasons).toContain(
      "picked Work: every included allowance is spent; keeps going on credits",
    );
  });
});

const snapshotOf = (rows: QuotaProviderView[], keepsGoing: boolean): QuotaSnapshotView =>
  stampSnapshot({ generatedAt: "", fetchedAt: NOW, providers: rows }, () => keepsGoing);

describe("the feed lines of an account that keeps going", () => {
  it("says when it starts spending credits, when they run out and when they answer again", () => {
    const watch = new CreditsWatch(() => true);
    expect(watch.observe(snapshotOf([codexRow("Work", 40)], true), NOW).lines).toEqual([]);

    const started = watch.observe(snapshotOf([codexRow("Work", 100)], true), NOW);
    expect(started.lines).toHaveLength(1);
    expect(started.lines[0]).toMatch(
      /^Codex · Work is spending credits now: its allowance is used up until /,
    );

    const spent = watch.observe(
      snapshotOf([codexRow("Work", 100, { overage_limit_reached: true })], true),
      NOW,
    );
    expect(spent.lines).toEqual([
      "Codex · Work has used up its credits. Work on it waits until its allowance resets.",
    ]);

    expect(watch.observe(snapshotOf([codexRow("Work", 100)], true), NOW).available).toEqual([
      "Work",
    ]);
  });

  it("says nothing for an account whose switch is off", () => {
    const watch = new CreditsWatch(() => false);
    watch.observe(snapshotOf([codexRow("Work", 40)], false), NOW);
    expect(watch.observe(snapshotOf([codexRow("Work", 100)], false), NOW).lines).toEqual([]);
  });
});

describe("the crew's run-out card", () => {
  const off = () => false;

  it("is offered once while the allowance stays spent, though Codex's reset moves with each reading, and again once it answers and is spent again", () => {
    const offered = new Set<string>();
    const spent = snapshotOf([codexRow("Work", 100)], false);
    const [offer] = creditsOffers(spent, ["openai-codex"], offered, off, NOW);
    expect(offer).toMatchObject({
      accountId: "Work",
      name: "Codex · Work",
      credits: { balance: (body.credits as { balance: string }).balance },
    });
    // Five minutes on, the same reading names a reset five minutes later.
    const later = NOW + 5 * 60_000;
    const reread = snapshotOf([codexRow("Work", 100, {}, later)], false);
    expect(limitingResetOf(reread.providers[0] as QuotaProviderView, later)).not.toBe(
      limitingResetOf(spent.providers[0] as QuotaProviderView, NOW),
    );
    expect(creditsOffers(reread, ["openai-codex"], offered, off, later)).toEqual([]);
    forgetAnsweredOffers(reread, offered, later);
    expect(creditsOffers(reread, ["openai-codex"], offered, off, later)).toEqual([]);

    // The allowance answers again, then is spent again: one more offer.
    forgetAnsweredOffers(snapshotOf([codexRow("Work", 40)], false), offered, later);
    expect(creditsOffers(reread, ["openai-codex"], offered, off, later)).toHaveLength(1);
  });

  it("is not offered with the switch on, with allowance left, or without credits", () => {
    const none = (rows: QuotaProviderView[], keepsGoing: boolean) =>
      creditsOffers(
        snapshotOf(rows, keepsGoing),
        ["openai-codex"],
        new Set(),
        () => keepsGoing,
        NOW,
      );
    expect(none([codexRow("Work", 100)], true)).toEqual([]);
    expect(none([codexRow("Work", 40)], false)).toEqual([]);
    expect(none([codexRow("Work", 100, { has_credits: false })], false)).toEqual([]);
  });

  // INF-5369 piece 6 (docs/quota.md, "Saved resets"): shown, never used.
  it("says a saved reset that would refill the account now, with a link to its usage page, and none that would not yet", () => {
    const resets = body.rate_limit_reset_credits as Record<string, number>;
    const applies = codexRow("Work", 100, {}, NOW, {
      applicable_available_count: resets.available_count,
    });
    const [offer] = creditsOffers(
      snapshotOf([applies], false),
      ["openai-codex"],
      new Set(),
      off,
      NOW,
    );
    expect(offer?.savedResets).toEqual({ provider: "codex", count: resets.available_count });
    const card = creditsOfferCard(offer as CreditsOffer);
    expect(card.body).toContain(
      m.cardSavedResetsNow({ account: "Codex · Work", count: resets.available_count as number }),
    );
    expect(card.body).toContain(`<a href="${SAVED_RESETS_PAGE.codex}"`);
    // Shown only: the card's one choice stays Keep going on credits.
    const { savedResets: _shown, ...plain } = offer as CreditsOffer;
    expect(card.actions).toEqual(creditsOfferCard(plain).actions);

    // The live reading's saved reset does not apply yet: the card says nothing of it.
    const [notYet] = creditsOffers(
      snapshotOf([codexRow("Work", 100)], false),
      ["openai-codex"],
      new Set(),
      off,
      NOW,
    );
    expect(notYet?.savedResets).toBeUndefined();
    expect(creditsOfferCard(notYet as CreditsOffer).body).not.toContain(SAVED_RESETS_PAGE.codex);
  });

  it("is not offered for an account whose switch is on while a refusal leaves its row unmarked", () => {
    expect(
      creditsOffers(
        snapshotOf([codexRow("Work", 100)], false),
        ["openai-codex"],
        new Set(),
        () => true,
        NOW,
      ),
    ).toEqual([]);
  });
});
