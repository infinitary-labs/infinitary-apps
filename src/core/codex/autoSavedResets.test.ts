import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionAnswer, DecisionState } from "@shared/decisions";
import type { QuotaProviderView, QuotaSnapshotView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { parseCodexUsage } from "../quota/providers/codex";
import { AutoSavedResets } from "./autoSavedResets";

/**
 * Use saved resets on their own (INF-5478's accepted plan, piece 2;
 * docs/quota.md "Saved resets on their own"): with the account's switch on,
 * a spent Codex allowance holding a saved reset that applies now is weighed
 * once, and only an answered use spends one. The reading is a whole Codex
 * answer (`tests/fixtures/quota-credits`).
 */

const NOW = Date.parse("2026-11-13T21:00:00Z");
const ACCOUNT = "acct-codex";

const body = JSON.parse(
  readFileSync(
    join(__dirname, "../../../tests/fixtures/quota-credits/codex-usage-credits.json"),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;

/** The Codex row with its weekly window at `used` percent and its saved resets applying now. */
function codexRow(used: number): QuotaProviderView {
  const rateLimit = body.rate_limit as Record<string, Record<string, unknown>>;
  const resets = body.rate_limit_reset_credits as Record<string, unknown>;
  const parsed = parseCodexUsage(
    {
      ...body,
      rate_limit: {
        ...rateLimit,
        primary_window: { ...rateLimit.primary_window, used_percent: used },
      },
      rate_limit_reset_credits: { ...resets, applicable_available_count: resets.available_count },
    },
    NOW,
  );
  return {
    provider: "codex",
    label: "Codex",
    accountId: ACCOUNT,
    accountLabel: "Work",
    status: "ok",
    stale: false,
    windows: parsed.windows,
    ...(parsed.savedResets ? { savedResets: parsed.savedResets } : {}),
  };
}

function snapshot(row: QuotaProviderView): QuotaSnapshotView {
  return {
    generatedAt: new Date(NOW).toISOString(),
    fetchedAt: NOW,
    providers: [row],
  } as QuotaSnapshotView;
}

type Harness = {
  auto: AutoSavedResets;
  asked: DecisionState[];
  used: string[];
  notes: string[];
  set: (patch: { row?: QuotaProviderView; on?: boolean; allowed?: boolean }) => void;
};

function harness(answer: (state: DecisionState) => DecisionAnswer | undefined): Harness {
  let row = codexRow(100);
  let on = true;
  let allowed = true;
  const asked: DecisionState[] = [];
  const used: string[] = [];
  const notes: string[] = [];
  const auto = new AutoSavedResets({
    models: {
      decide: async (_caller, state) => {
        asked.push(state);
        const given = answer(state);
        return given ? { reset: given } : {};
      },
      allowsUse: () => allowed,
    },
    switchOn: () => on,
    latest: () => snapshot(row),
    canUse: () => true,
    use: async (accountId) => {
      used.push(accountId);
      return { outcome: "used", left: 1 };
    },
    note: (text) => notes.push(text),
    now: () => NOW,
  });
  return {
    auto,
    asked,
    used,
    notes,
    set: (patch) => {
      if (patch.row) row = patch.row;
      if (patch.on !== undefined) on = patch.on;
      if (patch.allowed !== undefined) allowed = patch.allowed;
    },
  };
}

const answered = (value: string): DecisionAnswer => ({
  value,
  outcome: "answered",
  version: "sr1-test",
});

describe("saved resets on their own", () => {
  it("weighs a spent allowance once and uses a reset when the answer is use", async () => {
    const h = harness(() => answered("use"));
    await h.auto.spentAt(["openai-codex"], "crew task");
    await h.auto.spentAt(["openai-codex"], "crew task");
    expect(h.asked).toHaveLength(1);
    expect(h.used).toEqual([ACCOUNT]);
    // The question carries how much work waits, the resets held and when the spent window refills.
    const facts = h.asked[0]?.facts ?? {};
    expect(facts.waiting_work).toBe("crew task");
    expect(facts.saved_resets_that_apply_now).toBe(codexRow(100).savedResets?.applicable);
    const window = codexRow(100).windows?.[0]?.id;
    expect(facts[`${window}_percent_left`]).toBe(0);
    // The fixture's weekly window refills 215,009 seconds after it was read.
    expect(facts[`${window}_refills_in_hours`]).toBeGreaterThan(0);
  });

  it("waits on wait, an abstention or a failed question, and the run-out card keeps its button", async () => {
    for (const answer of [
      answered("wait"),
      { value: "wait", outcome: "abstained", version: "sr1-test" } as DecisionAnswer,
      { value: "wait", outcome: "failed", version: "sr1-test", failure: "timeout" } as DecisionAnswer,
      undefined,
    ]) {
      const h = harness(() => answer);
      await h.auto.spentHere(ACCOUNT);
      expect(h.asked).toHaveLength(1);
      expect(h.used).toEqual([]);
    }
  });

  it("asks nothing while the account's switch is off, the use is off or the allowance has room", async () => {
    const off = harness(() => answered("use"));
    off.set({ on: false });
    await off.auto.spentAt(["openai-codex"], "crew task");
    expect(off.asked).toEqual([]);

    const useOff = harness(() => answered("use"));
    useOff.set({ allowed: false });
    await useOff.auto.spentAt(["openai-codex"], "crew task");
    expect(useOff.asked).toEqual([]);
    expect(useOff.used).toEqual([]);

    const room = harness(() => answered("use"));
    room.set({ row: codexRow(40) });
    await room.auto.spentAt(["openai-codex"], "crew task");
    expect(room.asked).toEqual([]);
  });

  it("uses nothing when the switch is turned off while the question runs", async () => {
    let h: Harness | undefined;
    h = harness(() => {
      h?.set({ on: false });
      return answered("use");
    });
    await h.auto.spentAt(["openai-codex"], "first mate");
    expect(h.asked).toHaveLength(1);
    expect(h.used).toEqual([]);
  });

  it("asks again once a reading shows the allowance back and it runs out again", async () => {
    const h = harness(() => answered("wait"));
    await h.auto.spentHere(ACCOUNT);
    // Still spent: a new reading keeps the one question.
    h.auto.read();
    await h.auto.spentHere(ACCOUNT);
    expect(h.asked).toHaveLength(1);
    // The allowance refilled, then ran out again.
    h.set({ row: codexRow(30) });
    h.auto.read();
    h.set({ row: codexRow(100) });
    await h.auto.spentHere(ACCOUNT);
    expect(h.asked).toHaveLength(2);
  });

  it("says a failed use in the feed", async () => {
    const h = harness(() => answered("use"));
    const auto = new AutoSavedResets({
      models: { decide: async () => ({ reset: answered("use") }), allowsUse: () => true },
      switchOn: () => true,
      latest: () => snapshot(codexRow(100)),
      canUse: () => true,
      use: async () => {
        throw new Error("Codex is not signed in to Codex · Work yet.");
      },
      note: (text) => h.notes.push(text),
      now: () => NOW,
    });
    await auto.spentHere(ACCOUNT);
    expect(h.notes).toEqual(["Codex is not signed in to Codex · Work yet."]);
  });
});
