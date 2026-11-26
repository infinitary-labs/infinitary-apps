import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "@shared/cards";
import { inLanguage } from "@shared/i18n/current";
import { wordSaidMarks } from "@shared/i18n/said";
import type { QuotaProviderView } from "@shared/quota";
import { type ComputerSignIns, signInPlace } from "@shared/signIns";
import { describe, expect, it } from "vitest";
import { CreditsCards } from "./creditsCards";
import { parseCodexUsage } from "./providers/codex";

/**
 * The run-out card and feed lines for a computer that runs work's own
 * account (INF-4275, docs/quota.md "Keep going on credits"): the home offers
 * the switch from that computer's rows, names the computer, and its button
 * turns the switch on there. The reading is a whole Codex answer
 * (`tests/fixtures/quota-credits`).
 */

const NOW = Date.parse("2026-11-13T21:00:00Z");

const body = JSON.parse(
  readFileSync(
    join(__dirname, "../../../tests/fixtures/quota-credits/codex-usage-credits.json"),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;

/** What that computer's Codex row holds beyond its spent window. */
type Holds = { credits: boolean; savedResets: boolean };

/**
 * That computer's Codex row with its weekly window at `used` percent,
 * credits as the fixture says, and with `savedResets` the fixture's saved
 * resets applying now.
 */
function codexRow(
  used: number,
  keepGoingOnCredits = false,
  holds: Holds = { credits: true, savedResets: false },
): QuotaProviderView {
  const rateLimit = body.rate_limit as Record<string, Record<string, unknown>>;
  const resets = body.rate_limit_reset_credits as Record<string, unknown>;
  const parsed = parseCodexUsage(
    {
      ...body,
      rate_limit: {
        ...rateLimit,
        primary_window: { ...rateLimit.primary_window, used_percent: used },
      },
      ...(holds.credits ? {} : { credits: null }),
      rate_limit_reset_credits: holds.savedResets
        ? { ...resets, applicable_available_count: resets.available_count }
        : resets,
    },
    NOW,
  );
  return {
    provider: "codex",
    label: "Codex",
    accountId: "acct-codex",
    accountLabel: "Work",
    status: "ok",
    stale: false,
    windows: parsed.windows,
    ...(parsed.credits ? { credits: parsed.credits } : {}),
    ...(parsed.savedResets ? { savedResets: parsed.savedResets } : {}),
    ...(keepGoingOnCredits ? { keepGoingOnCredits: true } : {}),
  };
}

/** What Mac mini says of its sign-ins: its Codex account, its switch and its reading. */
function said(used: number, keepGoingOnCredits: boolean, holds?: Holds): ComputerSignIns {
  return {
    providers: [],
    accounts: [
      {
        id: "acct-codex",
        providerId: "openai-codex",
        kind: "subscription_oauth",
        label: "Work",
        enabled: true,
        connected: true,
        pinned: false,
        createdAt: 1,
        ...(keepGoingOnCredits ? { keepGoingOnCredits: true } : {}),
      },
    ],
    quota: {
      generatedAt: new Date(NOW).toISOString(),
      fetchedAt: NOW,
      providers: [codexRow(used, keepGoingOnCredits, holds)],
    },
  };
}

function home(
  signIns: { now: ComputerSignIns },
  canUseSavedReset = true,
  offersAutoResets = false,
) {
  const raised: Omit<Card, "author" | "priority" | "status" | "createdAt">[] = [];
  const withdrawn: string[] = [];
  const sent: [string, string, boolean][] = [];
  const notes: string[] = [];
  const cards = new CreditsCards({
    setHere: () => {
      throw new Error("this Mac's own switch is not this account's");
    },
    onHere: () => false,
    latest: () => undefined,
    noteHere: () => [],
    computers: {
      keepGoing: async (deviceId, accountId, on) => {
        sent.push([deviceId, accountId, on]);
        signIns.now = said(100, on);
      },
      lastSaid: (deviceId) => (deviceId === "mini" ? signIns.now : null),
      placeOf: (deviceId) =>
        deviceId === "mini" ? signInPlace({ name: "Mac mini", onThisMac: false }) : undefined,
      canUseSavedReset: () => canUseSavedReset,
    },
    offersAutoResets: () => offersAutoResets,
    cards: {
      raiseHostCard: (card) => raised.push(card),
      withdrawHostCard: (id) => withdrawn.push(id),
    },
    note: (text) => notes.push(text),
    now: () => NOW,
  });
  return { cards, raised, withdrawn, sent, notes };
}

describe("a computer's own account that used up its allowance", () => {
  it("is offered on a card naming that computer, whose button keeps it going there", async () => {
    const signIns = { now: said(100, false) };
    const world = home(signIns);
    world.cards.spentAt(["openai-codex"], "mini");
    expect(world.raised).toHaveLength(1);
    const [card] = world.raised;
    expect(card?.id).toBe("card-credits-offer-mini-acct-codex");
    expect(card?.title).toMatch(/^Codex · Work on Mac mini has used up its allowance until /);
    expect(card?.body).toContain("Crew work on Mac mini drops to a weaker model");
    expect(card?.actions?.[0]?.effect).toEqual({
      kind: "host",
      op: "keep-going-on-credits",
      arg: "acct-codex@mini",
    });
    world.cards.spentAt(["openai-codex"], "mini");
    expect(world.raised).toHaveLength(1);

    // The button's account key, parsed by the host, turns the switch on there.
    await world.cards.setKeepGoing("acct-codex", true, "mini");
    expect(world.sent).toEqual([["mini", "acct-codex", true]]);
    expect(world.withdrawn).toEqual(["card-credits-offer-mini-acct-codex"]);
  });

  // INF-5478's plan, piece 1: the button runs only on a computer that takes the order and is in reach.
  it("offers Use a saved reset only while that computer can use one, and raises no card with nothing to offer", () => {
    const both = { credits: true, savedResets: true };
    const ops = (world: ReturnType<typeof home>) =>
      world.raised.flatMap((card) => (card.actions ?? []).map((action) => action.effect));
    const able = home({ now: said(100, false, both) });
    able.cards.spentAt(["openai-codex"], "mini");
    expect(ops(able)).toContainEqual({
      kind: "host",
      op: "use-saved-reset",
      arg: "acct-codex@mini",
    });

    const older = home({ now: said(100, false, both) }, false);
    older.cards.spentAt(["openai-codex"], "mini");
    expect(older.raised).toHaveLength(1);
    expect(ops(older).map((effect) => effect?.kind === "host" && effect.op)).toEqual([
      "keep-going-on-credits",
    ]);

    const resetsOnly = home(
      { now: said(100, false, { credits: false, savedResets: true }) },
      false,
    );
    resetsOnly.cards.spentAt(["openai-codex"], "mini");
    expect(resetsOnly.raised).toEqual([]);
  });

  it("names the computer whose crew waits in the reader's language", () => {
    const world = home({ now: said(100, false, { credits: false, savedResets: true }) });
    world.cards.spentAt(["openai-codex"], "mini");
    const body = world.raised[0]?.body ?? "";
    expect(wordSaidMarks(body)).toContain("Crew work on Mac mini drops to a weaker model");
    const german = inLanguage("de", () => wordSaidMarks(body));
    expect(german).toContain("Crew-Arbeit auf Mac mini wechselt zu einem schwächeren Modell");
    expect(german).not.toContain("on Mac mini");
  });

  // INF-5478's plan, piece 2: the run-out card offers Use saved resets on their own beside the reset.
  it("offers Use saved resets on their own after Use a saved reset, only while that switch can be turned on", () => {
    const both = { credits: true, savedResets: true };
    const ids = (world: ReturnType<typeof home>) =>
      world.raised.flatMap((card) => (card.actions ?? []).map((action) => action.id));
    const offered = home({ now: said(100, false, both) }, true, true);
    offered.cards.spentAt(["openai-codex"], "mini");
    expect(ids(offered)).toEqual(["keep-going-on-credits", "use-saved-reset", "use-saved-resets"]);
    const action = offered.raised[0]?.actions?.find((each) => each.id === "use-saved-resets");
    expect(action?.variant).toBe("secondary");
    expect(action?.effect).toEqual({
      kind: "host",
      op: "use-saved-resets",
      arg: "acct-codex@mini",
    });

    const notOffered = home({ now: said(100, false, both) }, true, false);
    notOffered.cards.spentAt(["openai-codex"], "mini");
    expect(ids(notOffered)).toEqual(["keep-going-on-credits", "use-saved-reset"]);
  });

  it("is not offered once its switch is on there", () => {
    const world = home({ now: said(100, true) });
    world.cards.spentAt(["openai-codex"], "mini");
    expect(world.raised).toEqual([]);
  });

  it("says in the feed when it starts spending credits there, naming that computer", () => {
    const signIns = { now: said(40, true) };
    const world = home(signIns);
    world.cards.readThere("mini");
    expect(world.notes).toEqual([]);
    signIns.now = said(100, true);
    world.cards.readThere("mini");
    expect(world.notes).toHaveLength(1);
    expect(world.notes[0]).toMatch(
      /^Codex · Work on Mac mini is spending credits now: its allowance is used up until /,
    );
  });
});
