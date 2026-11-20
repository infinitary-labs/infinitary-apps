import { existsSync } from "node:fs";
import type { CutOff } from "@shared/authFailure";
import { type Card, onStage } from "@shared/cards";
import {
  CLAUDE_ACCESS_PAUSE_TITLE,
  CLAUDE_ACCESS_PAUSED_SENTENCE,
  CLAUDE_ACCESS_REFUSED_LINE,
  CLAUDE_ACCESS_RENEW_WORDS,
  CLAUDE_ACCESS_SIGN_IN_TITLE,
  CLAUDE_ACCESS_TRY_AGAIN_LABEL,
  claudeAccessRefusedText,
} from "@shared/claudeAccess";
import { clockTime } from "@shared/quota";
import { describe, expect, it, vi } from "vitest";
import { CLAUDE_ACCOUNT } from "../../../tests/helpers/claudeFlagship";
import {
  CLAUDE_MODEL,
  CODEX_MODEL,
  claudeLogin,
  claudeLoginSeat,
  type FlagshipAccount,
  notes,
  runtimeKind,
  setupWithFlagship,
} from "../../../tests/helpers/firstmateFlagship";
import {
  type FakeSession,
  fakeClockEachTest,
  fakeSession,
  setup,
  tick,
} from "../../../tests/helpers/firstmateHarness";
import type { ModelRuntime } from "../pi/types";
import { FIRSTMATE_RECIPIENT, type InboxStore } from "../storage/inboxStore";
import type { FirstmateAgent } from "./firstmateAgent";
import { RECHECK_ALLOWANCE_LABEL } from "./hostCards";
import { ALLOWANCE_CHECKING_WORDS, keptMessageWords } from "./seat";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: the paused seat and its ways back (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

/** The seat's turn ends in a typed cut-off, as the Claude client reports one. */
async function cutOffTurn(session: FakeSession, cutOff: CutOff): Promise<void> {
  session.emit({
    type: "turn_failed",
    taskId: "firstmate",
    error: "Not logged in · Please run /login",
    cutOff,
  });
  session.emit({ type: "turn_end", taskId: "firstmate" });
  session.emit({ type: "turn_closed" });
  session.resolveNextPrompt();
  await tick();
}

/** Time passes on the tick: the clock jumps and the shared tick pokes the lane. */
async function ticksPass(agent: FirstmateAgent, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    vi.setSystemTime(Date.now() + 20 * 60_000);
    agent.pokeInbox();
    await tick();
  }
}

const captainRows = (inbox: InboxStore) =>
  inbox
    .allFor(FIRSTMATE_RECIPIENT)
    .filter((row) => row.origin === "captain")
    .map((row) => (row.facts?.kind === "captain-turn" ? row.facts.words : row.text));

describe("the paused seat: each cut-off class through the ladder (W1 S9)", () => {
  it("a lost sign-in pauses the seat, keeps the words, asks for the sign-in, and resumes when it is back", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("hello");
    const seat = t.sessions[0] as FakeSession;
    await cutOffTurn(seat, { class: "signed_out" });

    // The turn is a turn_failed with its class; the words wait on the inbox.
    expect(t.events).toContainEqual(
      expect.objectContaining({
        type: "turn_failed",
        cutOff: { class: "signed_out" },
        paused: true,
      }),
    );
    expect(captainRows(t.inbox)).toEqual(["hello"]);
    // One card for the pause, in product words: never the client's own.
    expect(t.cards().map((card) => card.id)).toEqual(["card-fm-no-headroom"]);
    const card = t.cards()[0] as Card;
    expect(card.title).toBe("Your first mate needs you to sign in again");
    expect(card.body).toBe(
      "Claude needs you to sign in again. Your messages are kept. Your first mate picks them up once you sign in.",
    );
    expect(JSON.stringify(card)).not.toContain("/login");
    expect(card.actions).toEqual([
      expect.objectContaining({
        id: "sign-in",
        effect: { kind: "host", op: "restore-account", arg: CLAUDE_ACCOUNT },
      }),
    ]);
    expect(notes(t.events)).toContain("Your first mate paused: Claude needs you to sign in again.");
    expect(t.ledger.at(-1)).toMatchObject({
      taskId: "firstmate",
      provider: "anthropic-claude",
      accountId: CLAUDE_ACCOUNT,
      reasons: ["seat paused", "Claude: signed_out", "nothing else can serve"],
    });
    // The seat lets go of its client while paused, so the sign-in's health can be read.
    expect(seat.detach).toHaveBeenCalled();

    // Paused: nothing is attempted, however long, and the card is raised once.
    await ticksPass(t.agent, 4);
    expect(seat.prompts).toHaveLength(1);
    expect(t.ledger.filter((row) => row.reasons[0] === "seat paused")).toHaveLength(1);

    // A new sign-in clears the fact: a feed line, the card goes, the words go through.
    t.account(CLAUDE_ACCOUNT).cutOff = undefined;
    await ticksPass(t.agent, 1);
    expect(notes(t.events)).toContain("Your first mate is answering again on Claude.");
    expect(t.cards()).toEqual([]);
    expect(seat.prompts).toHaveLength(2);
    expect(seat.prompts[1]).toContain("hello");
    expect(t.ledger.at(-1)?.reasons[0]).toBe("seat serves-again");
  });

  // INF-3449's approved plan: when Claude refuses access set up for Claude
  // Code, the seat says the sign-in needs renewing the way Claude Code's is,
  // and never asks for a Claude sign-in here.
  it("a refused Claude access pauses the seat and asks to renew it, never to sign in", async () => {
    const t = await claudeLoginSeat();
    t.account(CLAUDE_ACCOUNT).access = "claude-settings";
    await t.agent.converse("hello");
    const seat = t.sessions[0] as FakeSession;
    await cutOffTurn(seat, { class: "signed_out" });

    const sentence = CLAUDE_ACCESS_PAUSED_SENTENCE["claude-settings"];
    // The line under the captain's message says it too.
    expect(t.events).toContainEqual(
      expect.objectContaining({
        type: "firstmate_reply",
        text: CLAUDE_ACCESS_REFUSED_LINE["claude-settings"],
        problem: true,
      }),
    );
    const card = t.cards()[0] as Card;
    expect(card.title).toBe(CLAUDE_ACCESS_PAUSE_TITLE);
    expect(card.body).toBe(
      `${sentence} Your messages are kept. ${CLAUDE_ACCESS_RENEW_WORDS["claude-settings"]}`,
    );
    // Its way back checks the access again, as the account row's button does.
    expect(card.actions).toEqual([
      expect.objectContaining({
        label: CLAUDE_ACCESS_TRY_AGAIN_LABEL,
        effect: { kind: "host", op: "restore-account", arg: CLAUDE_ACCOUNT },
      }),
    ]);
    expect(notes(t.events)).toContain(`Your first mate paused: ${sentence}`);

    // A message kept meanwhile names the same way back.
    await t.agent.converse("still there?");
    await tick();
    const kept = keptMessageWords(sentence, "signed_out", "Claude", true);
    expect(notes(t.events)).toContain(kept);
    expect(`${card.title} ${card.body} ${kept}`).not.toMatch(/sign in/i);
  });

  // The same plan: the first mate's sign-in card, raised when a failure
  // carries no cut-off class, names the refused access in its title too.
  it("titles the first mate's sign-in card for a refused Claude access, never a sign-in", async () => {
    const t = await claudeLoginSeat();
    t.account(CLAUDE_ACCOUNT).access = "claude-settings";
    await t.agent.converse("hello");
    (t.sessions[0] as FakeSession).rejectNextPrompt("401 authentication_error: invalid x-api-key");
    await tick();
    const card = t.cards().find((each) => each.id === "card-fm-auth");
    expect(card?.title).toBe(CLAUDE_ACCESS_SIGN_IN_TITLE);
    expect(card?.body).toBe(claudeAccessRefusedText("Your first mate", "claude-settings"));
  });

  it("a Mac with no client to run the seat pauses it with the client's sentence, not a failure (W1 S12)", async () => {
    const t = await claudeLoginSeat();
    const missing = "Claude Code is not installed on this computer. Install it, then come back.";
    Object.assign(t.account(CLAUDE_ACCOUNT), { withheld: "client_missing", detail: missing });
    await t.agent.converse("hello");
    await tick();

    expect(t.cards().map((card) => card.id)).toEqual(["card-fm-no-headroom"]);
    const card = t.cards()[0] as Card;
    expect(card.title).toBe("Your first mate cannot run on this computer right now");
    expect(card.body).toBe(
      `${missing} Your messages are kept. Your first mate picks them up once it can run.`,
    );
    expect(captainRows(t.inbox)).toEqual(["hello"]);

    // The client is installed: the seat attaches and the words go through.
    Object.assign(t.account(CLAUDE_ACCOUNT), { withheld: undefined, detail: undefined });
    t.agent.onCutOffChanged();
    await tick();
    expect(t.cards()).toEqual([]);
    const seat = t.sessions[0] as FakeSession;
    expect(seat.prompts[0]).toContain("hello");
  });

  it("hears a cleared cut-off at once, without waiting for the next tick (W1 S12)", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("hello");
    const seat = t.sessions[0] as FakeSession;
    await cutOffTurn(seat, { class: "signed_out" });
    expect(seat.prompts).toHaveLength(1);

    // The login changed; the vault says so, and no tick has passed.
    t.account(CLAUDE_ACCOUNT).cutOff = undefined;
    t.agent.onCutOffChanged();
    await tick();
    expect(notes(t.events)).toContain("Your first mate is answering again on Claude.");
    expect(seat.prompts).toHaveLength(2);
    expect(seat.prompts[1]).toContain("hello");
  });

  it("a spent allowance pauses until its reset, holding the rows past it, then resumes", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("first");
    const seat = t.sessions[0] as FakeSession;
    seat.emitTurnEnd("Hi.");
    seat.resolveNextPrompt();
    await tick();

    // An operational wake meets the spent allowance.
    const resetsAt = Date.now() + 3 * 60 * 60_000;
    t.agent.notifyOp(
      { facts: { kind: "scheduled", prompt: "check the build", catchUp: false } },
      "scheduled",
    );
    await tick();
    expect(seat.prompts).toHaveLength(2);
    await cutOffTurn(seat, { class: "no_headroom", resetsAt });

    const card = t.cards().find((entry) => entry.id === "card-fm-no-headroom") as Card;
    expect(card.title).toBe("Your first mate has used up its allowance");
    expect(card.body).toContain(
      "No connected account has allowance left for your first mate right now",
    );
    expect(card.body).toContain("Your messages are kept. It will resume when one resets.");
    expect(notes(t.events)).toContain(
      "Your first mate paused: Claude has used up its allowance (resets Fri).",
    );
    // The wake is released through the honest retry, never before the reset.
    const [row] = t.inbox.allFor(FIRSTMATE_RECIPIENT);
    expect(row).toMatchObject({ attempts: 0, failures: 1, nextAttemptAt: resetsAt });

    await ticksPass(t.agent, 3);
    expect(seat.prompts).toHaveLength(2);

    // The reset passes: the fact clears, and the wake goes through at once.
    t.account(CLAUDE_ACCOUNT).cutOff = undefined;
    await ticksPass(t.agent, 1);
    expect(notes(t.events)).toContain("Your first mate is answering again on Claude.");
    expect(seat.prompts).toHaveLength(3);
    expect(seat.prompts[2]).toContain("check the build");
  });

  // INF-1079, the captain: "it would be great to have a button here to
  // trigger a recheck" after switching Claude accounts elsewhere.
  it("a spent allowance's Recheck reads it again: still spent, the card comes back; another login's room answers the kept words once", async () => {
    let rechecks = 0;
    let read!: () => void;
    let onRead = () => {};
    const t = await claudeLoginSeat({
      recheckAllowance: async () => {
        rechecks += 1;
        await new Promise<void>((resolve) => {
          read = resolve;
        });
        onRead();
        return undefined;
      },
    });
    await t.agent.converse("hello");
    const seat = t.sessions[0] as FakeSession;
    await cutOffTurn(seat, { class: "no_headroom", resetsAt: Date.now() + 3 * 60 * 60_000 });
    const card = () => t.cards().find((entry) => entry.id === "card-fm-no-headroom");
    const recheck = [
      "recheck-allowance",
      RECHECK_ALLOWANCE_LABEL,
      { kind: "host", op: "try-again", arg: CLAUDE_ACCOUNT },
    ];
    const actions = () => card()?.actions.map((action) => [action.id, action.label, action.effect]);
    expect(actions()).toEqual([
      recheck,
      ["open-settings", "Open settings", { kind: "open", target: "settings" }],
    ]);
    expect(card()?.actions.find((action) => action.default)?.id).toBe("recheck-allowance");

    // The click closes the card; it comes back saying it checks, with no
    // second recheck, and another ask shares the one running.
    t.supervisor.cardActions.act("card-fm-no-headroom", "recheck-allowance");
    await tick();
    expect(card()?.body).toContain(ALLOWANCE_CHECKING_WORDS);
    expect(actions()?.map(([id]) => id)).toEqual(["open-settings"]);
    void t.agent.recheckAllowance();
    expect(rechecks).toBe(1);

    // Still spent on the same login: the card comes back as it was, nothing tried.
    read();
    await tick();
    expect(card()?.body).not.toContain(ALLOWANCE_CHECKING_WORDS);
    expect(actions()?.[0]).toEqual(recheck);
    expect(seat.prompts).toHaveLength(1);
    // A spent allowance is not a refusal the captain's word clears.
    expect(t.tryAgains).toEqual([]);

    // Another login with room: the vault ended the old login's cut-off.
    onRead = () => {
      t.account(CLAUDE_ACCOUNT).cutOff = undefined;
    };
    t.supervisor.cardActions.act("card-fm-no-headroom", "recheck-allowance");
    await tick();
    read();
    await tick();
    expect(card()).toBeUndefined();
    expect(notes(t.events)).toContain("Your first mate is answering again on Claude.");
    expect(seat.prompts).toHaveLength(2);
    expect(seat.prompts[1]).toContain("hello");
    // Later readings deliver nothing twice.
    t.agent.onQuotaRefreshed();
    await tick();
    expect(seat.prompts).toHaveLength(2);
  });

  it("a refusal renews nothing and attempts nothing until the captain's Try again", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("hello");
    const seat = t.sessions[0] as FakeSession;
    await cutOffTurn(seat, { class: "refused" });

    expect(t.noted).toEqual([{ accountId: CLAUDE_ACCOUNT, cutOff: { class: "refused" } }]);
    const card = t.cards().find((entry) => entry.id === "card-fm-refused") as Card;
    expect(card.title).toBe("Claude is not answering your first mate right now");
    // Signing in again does not clear a refusal, so the card never says it does.
    expect(card.body).not.toMatch(/sign in/i);
    expect(card.body).toContain("Then choose Try Claude again.");
    expect(card.actions.map((action) => [action.id, action.label, action.effect])).toEqual([
      ["try-again", "Try Claude again", { kind: "host", op: "try-again", arg: CLAUDE_ACCOUNT }],
      ["open-settings", "Open settings", { kind: "open", target: "settings" }],
    ]);
    expect(notes(t.events)).toContain(
      "Claude is not answering your first mate right now; your messages are kept.",
    );

    await ticksPass(t.agent, 4);
    expect(seat.prompts).toHaveLength(1);
    expect(t.tryAgains).toEqual([]);

    // The captain's word clears it, and the one drain is the attempt.
    t.supervisor.cardActions.act("card-fm-refused", "try-again");
    await tick();
    expect(t.tryAgains).toEqual([CLAUDE_ACCOUNT]);
    expect(t.account(CLAUDE_ACCOUNT).cutOff).toBeUndefined();
    expect(t.ledger.map((row) => row.reasons[0])).toContain("seat try-again");
    expect(seat.prompts).toHaveLength(2);
    expect(seat.prompts[1]).toContain("hello");

    // Refused again: the seat pauses again, and still tries nothing on its own.
    await cutOffTurn(seat, { class: "refused" });
    expect(t.cards().map((entry) => entry.id)).toContain("card-fm-refused");
    await ticksPass(t.agent, 3);
    expect(seat.prompts).toHaveLength(2);
  });

  it("asks to move when another provider can serve, moves only on the click, and says so to the next turn", async () => {
    const t = await claudeLoginSeat({ codex: 60 });
    await t.agent.converse("hello");
    const seat = t.sessions[0] as FakeSession;
    await cutOffTurn(seat, { class: "refused" });

    // Rung 2: one card that asks, carrying the refusal's own way back too.
    expect(t.cards().map((card) => card.id)).toEqual(["card-fm-flagship-move"]);
    const card = t.cards()[0] as Card;
    expect(card.title).toBe("Claude is not answering your first mate right now");
    expect(card.body).toContain("Move your first mate to Codex in the meantime?");
    expect(card.actions.map((action) => [action.id, action.effect])).toEqual([
      ["move-flagship", { kind: "host", op: "move-flagship", arg: "openai-codex" }],
      ["try-again", { kind: "host", op: "try-again", arg: CLAUDE_ACCOUNT }],
    ]);
    expect(t.ledger.at(-1)?.reasons).toEqual([
      "seat move-offered",
      "Claude: refused",
      "offered Codex: it has headroom",
    ]);

    // Nothing moves before the click.
    await ticksPass(t.agent, 3);
    expect(t.specs).toHaveLength(1);
    expect(t.settings.getFirstmateModel()).toEqual(CLAUDE_MODEL);

    t.supervisor.cardActions.act("card-fm-flagship-move", "move-flagship");
    await tick();
    expect(t.specs[1]?.binding).toMatchObject({ backend: "pi", accountId: "acct_codex" });
    expect(t.settings.getFirstmateMovedFrom()).toEqual({
      providerId: "anthropic-claude",
      accountId: CLAUDE_ACCOUNT,
      class: "refused",
    });
    expect(notes(t.events)).toContain("Your first mate moved to Codex (gpt-5.5).");
    // The first turn on the new seat is told it moved, with what it cannot read back.
    const codex = t.sessions[1] as FakeSession;
    expect(codex.prompts).toHaveLength(1);
    expect(codex.prompts[0]).toContain(
      "Your seat moved on the captain's word: you now answer on Codex (gpt-5.5); before, you answered on Claude (claude-opus), which had stopped answering.",
    );
    expect(codex.prompts[0]).toContain(
      '- the captain said "hello"; you used no tool; the turn failed',
    );
    // ...and the words the refusal kept, as the captain's.
    expect(codex.prompts[0]).toContain("[user]\nhello");
    codex.emit({ type: "tool_start", taskId: "firstmate", callId: "c1", toolName: "emit_card" });
    codex.emitTurnEnd("Answered on Codex.");
    codex.resolveNextPrompt();
    await tick();

    // The way back asks too: Claude serves again, and nothing moves until the click.
    t.account(CLAUDE_ACCOUNT).cutOff = undefined;
    await ticksPass(t.agent, 1);
    expect(notes(t.events)).toContain("Claude can serve your first mate again.");
    const back = t.cards().find((entry) => entry.id === "card-fm-move-back") as Card;
    expect(back.title).toBe("Move your first mate back to Claude?");
    expect(back.body).toBe(
      "Claude can serve your first mate again. Your first mate stays on Codex until you choose.",
    );
    expect(back.actions.map((action) => action.effect)).toEqual([
      { kind: "host", op: "move-flagship", arg: "anthropic-claude" },
    ]);
    await ticksPass(t.agent, 3);
    expect(t.specs).toHaveLength(2);
    expect(t.cards().filter((entry) => entry.id === "card-fm-move-back")).toHaveLength(1);
    expect(t.ledger.filter((row) => row.reasons[0] === "seat move-back-offered")).toHaveLength(1);

    t.supervisor.cardActions.act("card-fm-move-back", "move-flagship");
    await tick();
    expect(t.specs[2]?.binding).toEqual({ backend: "claude", accountId: CLAUDE_ACCOUNT });
    expect(t.settings.getFirstmateMovedFrom()).toBeNull();
    t.agent.pokeInbox();
    await tick();
    const claudeAgain = t.sessions[2] as FakeSession;
    expect(claudeAgain.prompts[0]).toContain("you now answer on Claude (claude-opus)");
    // The Claude session missed only the Codex turn: that turn, and not its own.
    expect(claudeAgain.prompts[0]).toContain(
      '- the captain said "hello"; you used emit_card; you said "Answered on Codex."',
    );
    expect(claudeAgain.prompts[0]).not.toContain("the turn failed");
  });

  it("a Pi seat whose sign-in lapsed asks too (the owner's Q5 a): a move card when another provider can serve, else the sign-in", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_codex", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_grok", providerId: "xai", label: "Grok", enabled: true },
      ],
      availableModels: [CODEX_MODEL, { provider: "xai", id: "grok-4.6" }],
    });
    t.setHeadroom("acct_codex", 50);
    t.setHeadroom("acct_grok", 70);
    t.settings.setFirstmateModel(CODEX_MODEL);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    t.account("acct_codex").connected = false;
    await t.agent.converse("second");
    await tick();
    expect(t.specs).toHaveLength(1);
    const move = t.cards().find((entry) => entry.id === "card-fm-flagship-move") as Card;
    expect(move.title).toBe("Your first mate needs you to sign in again");
    expect(move.actions.map((action) => [action.label, action.effect])).toEqual([
      ["Move to Grok", { kind: "host", op: "move-flagship", arg: "xai" }],
      ["Sign in", { kind: "host", op: "restore-account", arg: "acct_codex" }],
    ]);
    expect(captainRows(t.inbox)).toEqual(["second"]);

    // With nowhere to move, the one card is the sign-in.
    t.account("acct_grok").connected = false;
    t.supervisor.close("card-fm-flagship-move");
    await ticksPass(t.agent, 1);
    const bench = t.cards().find((entry) => entry.id === "card-fm-no-headroom") as Card;
    expect(bench.title).toBe("Your first mate needs you to sign in again");
    expect(bench.actions.map((action) => action.label)).toEqual(["Sign in"]);
  });

  it("each message the paused seat keeps says it is saved, with its attention card put away too (FI3-592, INF-1879)", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("hello");
    const seat = t.sessions[0] as FakeSession;
    await cutOffTurn(seat, { class: "refused" });
    const saved = keptMessageWords(
      "Claude is not answering your first mate right now.",
      "refused",
      "Claude",
    );
    // The message that met the refusal has the pause's card and line.
    expect(notes(t.events)).not.toContain(saved);

    t.supervisor.close("card-fm-refused");
    await t.agent.converse("are you there?");
    await tick();
    await t.agent.converse("still nothing?");
    await tick();
    // The card stays down and nothing is attempted, yet each kept message
    // gets its own saved line, naming the way back the captain can still reach.
    expect(t.cards().find((card) => card.id === "card-fm-refused")).toMatchObject({
      minimized: true,
    });
    // onStage tests author readiness; visibleCards also excludes the saved minimized fact.
    expect(
      t
        .cards()
        .filter((card) => onStage(card) && !card.minimized)
        .map((card) => card.id),
    ).not.toContain("card-fm-refused");
    expect(seat.prompts).toHaveLength(1);
    expect(captainRows(t.inbox)).toEqual(["hello", "are you there?", "still nothing?"]);
    expect(notes(t.events).filter((note) => note === saved)).toHaveLength(2);
    expect(saved).toBe(
      "Your message is saved. Claude is not answering your first mate right now. Your first mate answers it once Claude answers again, or choose another model for your first mate in Settings, under Intelligence.",
    );

    // Claude answers again: the seat's own line says so and the kept words go.
    t.account(CLAUDE_ACCOUNT).cutOff = undefined;
    t.agent.onCutOffChanged();
    await tick();
    expect(notes(t.events)).toContain("Your first mate is answering again on Claude.");
    expect(seat.prompts).toHaveLength(2);
  });

  it("a sign-in holds the seat off the account it rewrites, letting go of the client first", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("first");
    const seat = t.sessions[0] as FakeSession;
    seat.emitTurnEnd("Hi.");
    seat.resolveNextPrompt();
    await tick();

    const release = await t.agent.holdSeatFor(CLAUDE_ACCOUNT);
    expect(seat.detach).toHaveBeenCalledTimes(1);
    await t.agent.converse("while signing in");
    await tick();
    expect(seat.prompts).toHaveLength(1);
    expect(captainRows(t.inbox)).toEqual(["while signing in"]);
    // No card: the sign-in is the captain's own act, already on screen.
    expect(t.cards()).toEqual([]);
    // Nor a saved line: the seat is not paused.
    expect(notes(t.events).filter((note) => note.startsWith("Your message is saved."))).toEqual([]);

    release();
    await tick();
    expect(seat.prompts).toHaveLength(2);
    expect(seat.prompts[1]).toContain("while signing in");
  });

  for (const cutOff of [
    { class: "signed_out" },
    { class: "no_headroom", resetsAt: Date.parse("2026-09-27T12:00:00Z") },
    { class: "refused" },
  ] satisfies CutOff[]) {
    it(`keeps a steer the ${cutOff.class} turn took in, as the captain's, behind the words it answered (review S1)`, async () => {
      vi.setSystemTime(Date.parse("2026-09-26T12:00:00Z"));
      const t = await claudeLoginSeat();
      await t.agent.converse("first");
      const seat = t.sessions[0] as FakeSession;
      // Mid-turn: the client takes the steer in, so it is not the queue's to give back.
      await t.agent.converse("stop that and do the other thing");
      await tick();
      expect(seat.steers).toHaveLength(1);
      expect(captainRows(t.inbox)).toEqual([]);
      await cutOffTurn(seat, cutOff);
      expect(captainRows(t.inbox)).toEqual(["first", "stop that and do the other thing"]);
    });
  }

  it("keeps a steer a cut-off that pauses nothing took in, waiting with the words it answered (re-review R2)", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("first");
    const seat = t.sessions[0] as FakeSession;
    await t.agent.converse("steer one");
    await tick();
    expect(seat.steers).toHaveLength(1);
    await cutOffTurn(seat, { class: "no_headroom" });
    expect(t.cards().map((card) => card.id)).toEqual(["card-fm-turn-failure"]);
    const rows = t.inbox.allFor(FIRSTMATE_RECIPIENT);
    expect(captainRows(t.inbox)).toEqual(["first", "steer one"]);
    for (const row of rows) {
      expect(row).toMatchObject({ attempts: 0, failures: 1 });
      expect(row.nextAttemptAt).toBeGreaterThan(Date.now());
    }
  });

  it("Retry after the way back delivers the captain's words once more, never a second copy (re-review R1)", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("hello");
    const seat = t.sessions[0] as FakeSession;
    await cutOffTurn(seat, { class: "signed_out" });

    // The way back drains the parked words, and that turn fails the ordinary way.
    t.account(CLAUDE_ACCOUNT).cutOff = undefined;
    await ticksPass(t.agent, 1);
    expect(seat.prompts).toHaveLength(2);
    seat.emitTurnFailed("500 Internal Server Error");
    seat.resolveNextPrompt();
    await tick();
    expect(t.cards().map((card) => card.id)).toEqual(["card-fm-turn-failure"]);

    t.supervisor.cardActions.act("card-fm-turn-failure", "retry-firstmate");
    await tick();
    expect(seat.prompts).toHaveLength(3);
    expect(seat.prompts[2]?.split("[user]\nhello")).toHaveLength(2);
    seat.emitTurnEnd("Hello again.");
    seat.resolveNextPrompt();
    await tick();
    // Answered: nothing is left to deliver, and the stale Retry is gone.
    await ticksPass(t.agent, 2);
    expect(seat.prompts).toHaveLength(3);
    expect(t.cards()).toEqual([]);
  });

  it("a spent allowance with no known reset pauses nothing, so it is a visible failure that waits, never an instant retry (review S2)", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("hello");
    const seat = t.sessions[0] as FakeSession;
    await cutOffTurn(seat, { class: "no_headroom" });

    // The account holds no fact, so the seat serves: the turn is an ordinary
    // failure, and the feed hears it as one (no `paused` mark).
    expect(t.cards().map((card) => card.title)).toEqual(["Your first mate hit a problem"]);
    const failed = t.events.find((event) => event.type === "turn_failed");
    expect(failed).toMatchObject({ cutOff: { class: "no_headroom" } });
    expect(failed).not.toHaveProperty("paused");
    expect(seat.prompts).toHaveLength(1);
    // The words wait through the honest retry, not due at once.
    const [row] = t.inbox.allFor(FIRSTMATE_RECIPIENT);
    expect(row).toMatchObject({ origin: "captain", attempts: 0, failures: 1 });
    expect(row?.nextAttemptAt).toBeGreaterThan(Date.now());
    t.agent.pokeInbox();
    await tick();
    expect(seat.prompts).toHaveLength(1);
    // Retry on the card makes them due now: the one attempt it asks for.
    t.supervisor.cardActions.act("card-fm-turn-failure", "retry-firstmate");
    await tick();
    expect(seat.prompts).toHaveLength(2);
    expect(seat.prompts[1]).toContain("hello");
  });

  it("a pause outlives a restart without repeating itself, and its card goes when the account serves again (review S3)", async () => {
    const before = await claudeLoginSeat();
    await before.agent.converse("hello");
    await cutOffTurn(before.sessions[0] as FakeSession, { class: "refused" });
    expect(before.supervisor.cards.snapshot().map((card) => card.id)).toEqual(["card-fm-refused"]);
    before.agent.dispose();

    const after = await claudeLoginSeat({
      restart: { accounts: before.accounts, db: before.db },
    });
    after.agent.pokeInbox();
    await tick();
    // Still refused: the restored card stands, and nothing is said or recorded twice.
    expect(after.supervisor.cards.snapshot().map((card) => card.id)).toEqual(["card-fm-refused"]);
    expect(notes(after.events)).toEqual([]);
    expect(after.ledger).toEqual([]);
    expect(after.sessions.flatMap((session) => session.prompts)).toEqual([]);

    // Another login clears the refusal: the card goes and the words go through.
    after.account(CLAUDE_ACCOUNT).cutOff = undefined;
    after.agent.pokeInbox();
    await tick();
    expect(notes(after.events)).toContain("Your first mate is answering again on Claude.");
    expect(after.supervisor.cards.snapshot()).toEqual([]);
    expect((after.sessions[0] as FakeSession).prompts[0]).toContain("hello");
  });

  it("takes down a pause card a previous run left, even with no pause on record, once the seat serves (review S3)", async () => {
    const t = await claudeLoginSeat();
    t.supervisor.cards.hostCards.addFirstmatePauseCard({
      pause: "refused",
      body: "Claude is not answering your first mate right now.",
      accountId: CLAUDE_ACCOUNT,
      providerName: "Claude",
    });
    await t.agent.converse("hello");
    const seat = t.sessions[0] as FakeSession;
    seat.emitTurnEnd("Hi.");
    seat.resolveNextPrompt();
    await tick();
    expect(seat.prompts).toHaveLength(1);
    expect(t.supervisor.cards.snapshot()).toEqual([]);
  });

  it("a Pi seat's failed sign-in shows one card: the pause card replaces the generic sign-in card (review S4)", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_codex", providerId: "openai-codex", label: "Personal", enabled: true },
        { id: "acct_grok", providerId: "xai", label: "Grok", enabled: true },
      ],
      availableModels: [CODEX_MODEL, { provider: "xai", id: "grok-4.6" }],
    });
    t.setHeadroom("acct_codex", 50);
    t.setHeadroom("acct_grok", 70);
    t.settings.setFirstmateModel(CODEX_MODEL);
    await t.agent.converse("first");
    const seat = t.sessions[0] as FakeSession;
    seat.emitTurnFailed("401 Unauthorized: invalid token");
    seat.resolveNextPrompt();
    await tick();
    // Before the proof, the turn's failure says sign in, as it always has.
    expect(t.cards().map((card) => card.id)).toEqual(["card-fm-auth"]);

    // The vault's proof follows; the next turn meets the ladder.
    t.account("acct_codex").connected = false;
    await t.agent.converse("second");
    await tick();
    expect(t.cards().map((card) => [card.id, card.title])).toEqual([
      ["card-fm-flagship-move", "Your first mate needs you to sign in again"],
    ]);
  });

  it("a move brings the rows held for the account it left into the new seat's first turn (review N1)", async () => {
    const t = await claudeLoginSeat({ codex: 60 });
    await t.agent.converse("first");
    const seat = t.sessions[0] as FakeSession;
    seat.emitTurnEnd("Hi.");
    seat.resolveNextPrompt();
    await tick();
    t.agent.notifyOp(
      { facts: { kind: "scheduled", prompt: "check the build", catchUp: false } },
      "scheduled",
    );
    await tick();
    await cutOffTurn(seat, { class: "no_headroom", resetsAt: Date.now() + 5 * 60 * 60_000 });
    t.supervisor.cardActions.act("card-fm-flagship-move", "move-flagship");
    await tick();
    const codex = t.sessions[1] as FakeSession;
    expect(codex.prompts[0]).toContain("Your seat moved on the captain's word");
    expect(codex.prompts[0]).toContain("check the build");
  });
});

// Guardrails before the first mate's split (INF-2625's plan, the seat's
// row): the seat's own test reached 78% of its branches and no other test
// reaches the seat, so each branch the split moves is pinned here first.
describe("the seat's other ways: Settings, the way back, holds and moves (INF-2625 guardrails)", () => {
  const PERSONAL = {
    id: "acct_a",
    providerId: "openai-codex",
    label: "Personal",
    enabled: true,
  } satisfies FlagshipAccount;
  const WORK = {
    id: "acct_b",
    providerId: "openai-codex",
    label: "Work #2",
    enabled: true,
  } satisfies FlagshipAccount;
  const GROK = { provider: "xai", id: "grok-4.6" };

  /** Two Codex accounts, the seat on the first after one finished turn unless `fresh`. */
  async function codexPair(options: { fresh?: boolean } = {}) {
    const t = setupWithFlagship({ accounts: [{ ...PERSONAL }, { ...WORK }] });
    t.setHeadroom("acct_a", 80);
    t.setHeadroom("acct_b", 70);
    if (options.fresh) return t;
    await t.agent.converse("first");
    const seat = t.sessions[0] as FakeSession;
    seat.emitTurnEnd("Hi.");
    seat.resolveNextPrompt();
    await tick();
    expect(t.agent.boundAccount()).toBe("acct_a");
    return t;
  }

  /** A seat on Codex that left Claude, with the way back offered by card. */
  async function movedOffClaude() {
    const t = setupWithFlagship({
      claudeSeat: true,
      accounts: [
        { id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true },
        claudeLogin(),
      ],
      availableModels: [CODEX_MODEL, CLAUDE_MODEL],
    });
    t.setHeadroom("acct_codex", 60);
    t.setHeadroom(CLAUDE_ACCOUNT, 80);
    t.settings.setFirstmateBinding(CODEX_MODEL, "acct_codex");
    t.settings.setFirstmateMovedFrom({
      providerId: "anthropic-claude",
      accountId: CLAUDE_ACCOUNT,
      class: "refused",
    });
    t.agent.onQuotaRefreshed();
    await tick();
    const back = () => t.cards().find((card) => card.id === "card-fm-move-back");
    return { t, back };
  }

  it("Observe's peek names the setting's model before a seat attaches, and nothing as its file", async () => {
    const f = setup();
    expect(f.agent.modelRef()).toBeNull();
    expect(f.agent.sessionFile()).toBeNull();
    f.settings.setFirstmateModel({ provider: "fm-mock", id: "mock-2" });
    expect(f.agent.modelRef()).toEqual({ provider: "fm-mock", id: "mock-2" });
    await f.agent.converse("first");
    expect(f.agent.modelRef()).toEqual({ provider: "fm-mock", id: "mock-1" });
    expect(f.agent.sessionFile()).toBe("/tmp/fm/sessions/session.jsonl");
  });

  it("an idle seat lets go of its session when the local seat is chosen, and the next turn opens on it", async () => {
    const f = setup();
    await f.agent.converse("first");
    f.session.emitTurnEnd("Hi.");
    f.session.resolveNextPrompt();
    await tick();
    const local = {
      model: { provider: "local", id: "fixture" },
      runtime: { kind: "local" } as unknown as ModelRuntime,
      host: "localhost",
      source: "setting" as const,
    };

    await f.agent.setLocalOrchestrator(local);
    expect(f.session.dispose).toHaveBeenCalledTimes(1);
    expect(f.agent.sessionFile()).toBeNull();
    expect(f.specs).toHaveLength(1);

    await f.agent.converse("second");
    await tick();
    expect(f.specs).toHaveLength(2);
    expect(f.specs[1]?.model).toEqual(local.model);
    expect(runtimeKind(f.specs[1])).toBe("local");
  });

  it("a Settings account pick waits for a seat to apply it: before any session, nothing opens", async () => {
    const t = await codexPair({ fresh: true });
    t.settings.setFirstmateAccount("acct_b");
    await t.agent.applyAccountSetting();
    expect(t.specs).toHaveLength(0);
    expect(t.ledger).toEqual([]);
  });

  it("a Settings account pick that names the bound account moves nothing", async () => {
    const t = await codexPair();
    const ledgered = t.ledger.length;
    t.settings.setFirstmateAccount("acct_a");
    await t.agent.applyAccountSetting();
    expect(t.specs).toHaveLength(1);
    expect(t.ledger).toHaveLength(ledgered);
  });

  it("a Settings account pick that cannot serve leaves the seat where it is", async () => {
    const t = await codexPair();
    const ledgered = t.ledger.length;
    t.account("acct_b").enabled = false;
    t.settings.setFirstmateAccount("acct_b");
    await t.agent.applyAccountSetting();
    expect(t.agent.boundAccount()).toBe("acct_a");
    expect(t.specs).toHaveLength(1);
    expect(t.ledger).toHaveLength(ledgered);
  });

  it("a Settings account pick made mid-turn applies at the next idle boundary, never mid-turn", async () => {
    const t = await codexPair();
    const seat = t.sessions[0] as FakeSession;
    await t.agent.converse("second");
    await tick();
    const ledgered = t.ledger.length;
    t.settings.setFirstmateAccount("acct_b");
    await t.agent.applyAccountSetting();
    expect(t.agent.boundAccount()).toBe("acct_a");
    expect(t.specs).toHaveLength(1);
    expect(t.ledger).toHaveLength(ledgered);

    seat.emitTurnEnd("Done.");
    seat.resolveNextPrompt();
    await tick();
    await t.agent.converse("third");
    await tick();
    expect(t.agent.boundAccount()).toBe("acct_b");
    expect(runtimeKind(t.specs[1])).toBe("runtime-acct_b");
  });

  it("a Settings account pick does not move the local seat", async () => {
    const t = await codexPair({ fresh: true });
    await t.agent.setLocalOrchestrator({
      model: { provider: "local", id: "fixture" },
      runtime: { kind: "local" } as unknown as ModelRuntime,
      host: "localhost",
      source: "setting",
    });
    await t.agent.converse("first");
    const seat = t.sessions[0] as FakeSession;
    seat.emitTurnEnd("Hi.");
    seat.resolveNextPrompt();
    await tick();
    t.settings.setFirstmateAccount("acct_b");
    await t.agent.applyAccountSetting();
    expect(t.specs).toHaveLength(1);
    expect(runtimeKind(t.specs[0])).toBe("local");
    expect(t.agent.boundAccount()).toBeUndefined();
  });

  it("a Settings model pick before any session is saved with its account and opens nothing", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true },
        { id: "acct_grok", providerId: "xai", label: "Grok", enabled: true },
      ],
      availableModels: [CODEX_MODEL, GROK],
    });
    t.setHeadroom("acct_codex", 40);
    t.setHeadroom("acct_grok", 60);
    await t.agent.applyModelSetting(GROK);
    expect(t.settings.getFirstmateModel()).toEqual(GROK);
    expect(t.settings.getFirstmateAccount()).toBe("acct_grok");
    expect(t.specs).toHaveLength(0);
    expect(t.ledger).toEqual([]);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE ref = 'seat-moved'").get()).toEqual({
      n: 0,
    });
  });

  it("choosing Auto in Settings clears the pick, records no move, and the seat reopens on the automatic pick", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true },
        { id: "acct_grok", providerId: "xai", label: "Grok", enabled: true },
      ],
      availableModels: [CODEX_MODEL, GROK],
    });
    t.setHeadroom("acct_codex", 40);
    t.setHeadroom("acct_grok", 60);
    t.settings.setFirstmateBinding(GROK, "acct_grok");
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();
    const ledgered = t.ledger.length;

    await t.agent.applyModelSetting(null);
    // With no catalog reading, the automatic pick is the first model listed.
    expect(t.specs).toHaveLength(2);
    expect(t.specs[1]?.model).toEqual(CODEX_MODEL);
    expect(t.settings.getFirstmateModel()).toEqual(CODEX_MODEL);
    expect(t.agent.boundAccount()).toBe("acct_codex");
    expect(t.ledger.slice(ledgered).filter((row) => row.reasons[0] === "seat pinned")).toEqual([]);
    expect(notes(t.events).filter((text) => text.startsWith("Your first mate moved"))).toEqual([]);
  });

  it("offers the way back before a seat attaches without naming where it stays, and a Settings pick withdraws it", async () => {
    const { t, back } = await movedOffClaude();
    expect(back()?.body).toBe("Claude can serve your first mate again.");
    expect(t.settings.getFirstmateMovedFrom()).toMatchObject({ offered: true });

    await t.agent.applyModelSetting(CODEX_MODEL);
    await tick();
    expect(t.settings.getFirstmateMovedFrom()).toBeNull();
    expect(back()).toBeUndefined();
  });

  it("withdraws the way back when the account it would return to is removed", async () => {
    const { t, back } = await movedOffClaude();
    expect(back()).toBeDefined();
    t.accounts.splice(
      t.accounts.findIndex((account) => account.id === CLAUDE_ACCOUNT),
      1,
    );
    t.agent.onQuotaRefreshed();
    await tick();
    expect(t.settings.getFirstmateMovedFrom()).toBeNull();
    expect(back()).toBeUndefined();
  });

  it("withdraws a stale way back when that account stops serving again, and offers it once more when it serves", async () => {
    const { t, back } = await movedOffClaude();
    expect(back()).toBeDefined();
    t.account(CLAUDE_ACCOUNT).cutOff = { class: "refused" };
    t.agent.onQuotaRefreshed();
    await tick();
    expect(back()).toBeUndefined();
    expect(t.settings.getFirstmateMovedFrom()).toMatchObject({ offered: false });

    t.account(CLAUDE_ACCOUNT).cutOff = undefined;
    t.agent.onCutOffChanged();
    await tick();
    expect(back()).toBeDefined();
    expect(t.ledger.filter((row) => row.reasons[0] === "seat move-back-offered")).toHaveLength(2);
  });

  it("the way back clicked mid-turn is saved at once and opens its seat at the next idle boundary", async () => {
    const { t, back } = await movedOffClaude();
    expect(back()).toBeDefined();
    await t.agent.converse("first");
    await tick();
    const codex = t.sessions[0] as FakeSession;
    expect(t.specs).toHaveLength(1);

    t.supervisor.cardActions.act("card-fm-move-back", "move-flagship");
    await tick();
    expect(t.settings.getFirstmateModel()).toEqual(CLAUDE_MODEL);
    expect(t.settings.getFirstmateMovedFrom()).toBeNull();
    expect(t.specs).toHaveLength(1);

    codex.emitTurnEnd("Answered on Codex.");
    codex.resolveNextPrompt();
    await tick();
    await t.agent.converse("second");
    await tick();
    expect(t.specs[1]?.binding).toEqual({ backend: "claude", accountId: CLAUDE_ACCOUNT });
    expect((t.sessions[1] as FakeSession).prompts[0]).toContain(
      "you now answer on Claude (claude-opus)",
    );
  });

  it("a move to a provider with no signed-in model raises the failure card and moves nothing", async () => {
    const availableModels = [CLAUDE_MODEL, CODEX_MODEL];
    const t = setupWithFlagship({
      claudeSeat: true,
      accounts: [
        claudeLogin(),
        {
          id: "acct_codex",
          providerId: "openai-codex",
          label: "Codex",
          enabled: true,
          connected: true,
        },
      ],
      availableModels,
    });
    t.settings.setFirstmateModel(CLAUDE_MODEL);
    t.setHeadroom(CLAUDE_ACCOUNT, 80);
    t.setHeadroom("acct_codex", 60);
    await t.agent.converse("hello");
    await cutOffTurn(t.sessions[0] as FakeSession, { class: "refused" });
    expect(t.cards().map((card) => card.id)).toEqual(["card-fm-flagship-move"]);

    availableModels.splice(availableModels.indexOf(CODEX_MODEL), 1);
    t.supervisor.cardActions.act("card-fm-flagship-move", "move-flagship");
    await tick();
    expect(t.specs).toHaveLength(1);
    expect(t.settings.getFirstmateModel()).toEqual(CLAUDE_MODEL);
    expect(t.settings.getFirstmateMovedFrom()).toBeNull();
    const failure = t.cards().find((card) => card.id === "card-fm-turn-failure") as Card;
    expect(failure.body).toContain("No signed-in model is available on that subscription.");
  });

  it("holds on the seat's account count up, each release counts once, and the last one lets the kept turn through", async () => {
    const t = await claudeLoginSeat();
    await t.agent.converse("first");
    const seat = t.sessions[0] as FakeSession;
    seat.emitTurnEnd("Hi.");
    seat.resolveNextPrompt();
    await tick();

    const first = await t.agent.holdSeatFor(CLAUDE_ACCOUNT);
    const second = await t.agent.holdSeatFor(CLAUDE_ACCOUNT);
    expect(seat.detach).toHaveBeenCalledTimes(2);
    await t.agent.converse("while signing in");
    await tick();
    first();
    first();
    await tick();
    expect(seat.prompts).toHaveLength(1);

    second();
    await tick();
    expect(seat.prompts).toHaveLength(2);
    expect(seat.prompts[1]).toContain("while signing in");
  });

  it("a hold on another account neither lets go of the seat's client nor keeps its turns", async () => {
    const t = await claudeLoginSeat({ codex: 60 });
    await t.agent.converse("first");
    const seat = t.sessions[0] as FakeSession;
    seat.emitTurnEnd("Hi.");
    seat.resolveNextPrompt();
    await tick();

    const release = await t.agent.holdSeatFor("acct_codex");
    expect(seat.detach).not.toHaveBeenCalled();
    await t.agent.converse("second");
    await tick();
    expect(seat.prompts).toHaveLength(2);
    release();
  });

  it("a seat whose account was removed moves to another account of its model's provider, saying why", async () => {
    const t = await codexPair();
    t.accounts.splice(0, 1);
    await t.agent.converse("second");
    await tick();
    expect(t.agent.boundAccount()).toBe("acct_b");
    expect(notes(t.events)).toContain(
      "Your first mate moved to Work #2 - its previous account is no longer available.",
    );
    expect(t.ledger.at(-1)).toMatchObject({
      accountId: "acct_b",
      reasons: [
        "seat rebound",
        "acct_a: unavailable",
        "picked Work #2: an account of the same provider that can serve",
      ],
    });
  });

  it("a spent allowance on every account of a provider counts them on the move card", async () => {
    const t = setupWithFlagship({
      accounts: [
        { ...PERSONAL },
        { ...WORK },
        { id: "acct_grok", providerId: "xai", label: "Grok", enabled: true },
      ],
      availableModels: [CODEX_MODEL, GROK],
    });
    t.setHeadroom("acct_a", 80);
    t.setHeadroom("acct_b", 70);
    t.setHeadroom("acct_grok", 60);
    t.settings.setFirstmateModel(CODEX_MODEL);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    t.setHeadroom("acct_a", 0);
    t.setHeadroom("acct_b", 0);
    await t.agent.converse("second");
    await tick();
    const card = t.cards().find((entry) => entry.id === "card-fm-flagship-move") as Card;
    expect(card.body).toBe(
      // The check time is the stand-in reading's own.
      `Your first mate's Codex accounts have used up their allowance (Personal resets Fri; Work #2 resets Fri). Your messages are kept. Checked at ${clockTime(0)}. Move your first mate to Grok until then?`,
    );
  });

  it("a seat whose only account is turned off, with nowhere to move, asks for an account", async () => {
    const t = setupWithFlagship({ accounts: [{ ...PERSONAL }] });
    t.setHeadroom("acct_a", 80);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    t.account("acct_a").enabled = false;
    await t.agent.converse("second");
    await tick();
    expect(t.cards().map((card) => [card.id, card.title, card.body])).toEqual([
      [
        "card-fm-no-headroom",
        "Your first mate needs an account",
        "Your first mate's account was disconnected and no other account can serve it. Connect an account to continue.",
      ],
    ]);
    expect(captainRows(t.inbox)).toEqual(["second"]);
  });

  it("a seat whose only account was removed pauses in its provider's name and keeps the words", async () => {
    const t = setupWithFlagship({ accounts: [{ ...PERSONAL }] });
    t.setHeadroom("acct_a", 80);
    t.settings.setFirstmateModel(CODEX_MODEL);
    await t.agent.converse("first");
    (t.sessions[0] as FakeSession).resolveNextPrompt();
    await tick();

    t.accounts.splice(0, 1);
    await t.agent.converse("second");
    await tick();
    expect(t.cards().map((card) => [card.id, card.title, card.body])).toEqual([
      [
        "card-fm-no-headroom",
        "Your first mate needs an account",
        "Your first mate's account was disconnected and no other account can serve it. Connect an account to continue.",
      ],
    ]);
    expect(notes(t.events)).toEqual([
      "Your first mate paused: That account no longer exists.",
      "Your message is saved. That account no longer exists. Your first mate answers it once an account can run it, or choose another model for your first mate in Settings, under Intelligence.",
    ]);
    expect(t.ledger.at(-1)?.reasons).toEqual([
      "seat paused",
      "acct_a: unavailable",
      "nothing else can serve",
    ]);
    expect(captainRows(t.inbox)).toEqual(["second"]);
  });

  it("a model picked mid-turn whose seat cannot attach keeps the next turn and says why", async () => {
    const t = setupWithFlagship({
      accounts: [
        { id: "acct_codex", providerId: "openai-codex", label: "Codex", enabled: true },
        claudeLogin(),
      ],
      availableModels: [CODEX_MODEL, CLAUDE_MODEL],
    });
    t.setHeadroom("acct_codex", 60);
    t.setHeadroom(CLAUDE_ACCOUNT, 80);
    t.settings.setFirstmateModel(CODEX_MODEL);
    await t.agent.converse("first");
    const codex = t.sessions[0] as FakeSession;
    await t.agent.applyModelSetting(CLAUDE_MODEL);
    expect(t.specs).toHaveLength(1);
    codex.emitTurnEnd("Answered on Codex.");
    codex.resolveNextPrompt();
    await tick();

    await t.agent.converse("second");
    await tick();
    expect(t.specs).toHaveLength(1);
    expect(codex.prompts).toHaveLength(1);
    expect(t.cards().map((card) => [card.id, card.title, card.body])).toEqual([
      [
        "card-fm-turn-failure",
        "Your first mate hit a problem",
        "Claude cannot run your first mate.",
      ],
    ]);
    expect(captainRows(t.inbox)).toEqual(["second"]);
  });

  it("a model picked mid-turn that will not open keeps the next turn off the old session", async () => {
    const session = fakeSession();
    let opens = 0;
    const f = setup({
      session,
      piSeat: async () => {
        opens += 1;
        if (opens > 1) throw new Error("The picked model would not open.");
        return session;
      },
    });
    await f.agent.converse("first");
    await f.agent.applyModelSetting({ provider: "fm-mock", id: "mock-next" });
    expect(f.specs).toHaveLength(1);
    session.emitTurnEnd("Hi.");
    session.resolveNextPrompt();
    await tick();

    await f.agent.converse("second");
    await tick();
    expect(f.specs.at(-1)?.model).toEqual({ provider: "fm-mock", id: "mock-next" });
    expect(session.prompts).toHaveLength(1);
    const failure = f.cards().find((card) => card.id === "card-fm-turn-failure") as Card;
    expect(failure.body).toContain("The picked model would not open.");
  });

  it("a Claude model with no Claude seat on this app fails its attach in the account's words", async () => {
    const t = setupWithFlagship({ accounts: [claudeLogin()], availableModels: [CLAUDE_MODEL] });
    t.settings.setFirstmateModel(CLAUDE_MODEL);
    t.setHeadroom(CLAUDE_ACCOUNT, 80);
    await t.agent.converse("hello");
    await tick();
    expect(t.specs).toEqual([]);
    // The failure card's words are owned by firstmateAgent.flagship.test.ts
    // ("the seat seam"); this path only has to reach that same failure.
    expect(t.cards().map((card) => card.id)).toEqual(["card-fm-turn-failure"]);
    expect(t.cards()[0]?.body).toContain("Claude cannot run your first mate.");
  });
});

describe("Retry on the Firstmate failure card (W1 S9 re-review R1)", () => {
  it("a failed drain turn's Retry delivers the rows it failed on, never the last captain turn again", async () => {
    const { agent, session, cards, supervisor } = setup();
    await agent.converse("first");
    session.emitTurnEnd("Done.");
    session.resolveNextPrompt();
    await tick();
    agent.notifyOp(
      { facts: { kind: "scheduled", prompt: "check the build", catchUp: false } },
      "scheduled",
    );
    await tick();
    expect(session.prompts).toHaveLength(2);
    session.emitTurnFailed("500 Internal Server Error");
    session.resolveNextPrompt();
    await tick();
    const card = cards().find((entry) => entry.id === "card-fm-turn-failure") as Card;
    expect(card).toBeDefined();

    supervisor.cardActions.act(card.id, "retry-firstmate");
    await tick();
    expect(session.prompts).toHaveLength(3);
    expect(session.prompts[2]).toContain("check the build");
    expect(session.prompts[2]).not.toContain("[user]\nfirst");
  });
});

describe("a quit while the seat attaches: nothing it started writes after the quit", () => {
  // The bug: a Linux test run found a phone fixture's scratch folder put back
  // after its cleanup, holding firstmate/home and firstmate/sessions. The core's
  // quit let go of the seat but not of an attach still in flight, which made
  // those folders once its wait ended.
  it("a quit while the local model is still starting makes no first mate folders and opens no session", async () => {
    const f = setup();
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const prepare = vi.fn(() => starting);
    await f.agent.setLocalOrchestrator({
      model: { provider: "local", id: "fixture" },
      runtime: { kind: "local" } as unknown as ModelRuntime,
      host: "localhost",
      source: "setting",
      prepare,
    });
    void f.agent.converse("hello");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));

    const quit = f.agent.dispose();
    started();
    await quit;
    await tick();

    expect(existsSync(f.paths.firstmateHomeDir)).toBe(false);
    expect(existsSync(f.paths.firstmateSessionsDir)).toBe(false);
    expect(f.specs).toEqual([]);
    expect(f.cards()).toEqual([]);
  });

  it("a quit while the session is opening waits for the open, then closes what it opened", async () => {
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const session = fakeSession();
    const f = setup({
      session,
      piSeat: async () => {
        await opening;
        return session;
      },
    });
    void f.agent.converse("hello");
    await vi.waitFor(() => expect(f.specs).toHaveLength(1));

    let quitDone = false;
    const quit = (async () => {
      await f.agent.dispose();
      quitDone = true;
    })();
    await vi.advanceTimersByTimeAsync(100);
    expect(quitDone).toBe(false);

    opened();
    await quit;
    expect(session.dispose).toHaveBeenCalledTimes(1);
    await tick();
    expect(session.prompts).toEqual([]);
    expect(f.agent.sessionFile()).toBeNull();
    expect(f.cards()).toEqual([]);
  });
});
