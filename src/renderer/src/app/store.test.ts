import type { FmEvent } from "@shared/events";
import type { LastTurn } from "@shared/lastTurn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeCharacterEmote } from "../character/emoteSignal";
import { isHeldEntry, shownCard, stackOf } from "./stack";
import { useShellStore } from "./store";
import { card, DECIDE, resetShell } from "./storeTestKit";

/** The window's own state (./store.ts): the core's events, the last turn, and how the slices meet. */

describe("the first mate's turn, the card stack and a recording move apart", () => {
  beforeEach(resetShell);

  it("heats only for Firstmate's own turn; cards are layout, not heat", () => {
    const state = () => useShellStore.getState();
    // A card is layout: it goes on the stack and heats nothing.
    state().applyCards([card({ id: "n1", status: "ready", body: "A fact." })]);
    expect(stackOf(state()).map((entry) => entry.id)).toEqual(["n1"]);
    expect(state()).toMatchObject({ firstmateBusy: false, recording: false });
    // Firstmate's own turn is the heat, with cards up or not.
    state().applyEvent({ type: "firstmate_state", busy: true });
    expect(state().firstmateBusy).toBe(true);
    state().applyCards([]);
    expect(stackOf(state())).toHaveLength(0);
    expect(state().firstmateBusy).toBe(true);
    state().applyEvent({ type: "firstmate_state", busy: false });
    expect(state()).toMatchObject({ firstmateBusy: false, recording: false });
    // Recording is a fact of its own: neither a card nor the turn moves it.
    useShellStore.setState({ recording: true });
    state().applyCards([card({ id: "n2", status: "ready", body: "Another fact." })]);
    state().applyEvent({ type: "firstmate_state", busy: true });
    expect(state()).toMatchObject({ recording: true, firstmateBusy: true });
    expect(stackOf(state())).toHaveLength(1);
  });
});

describe("the first mate shortening its conversation", () => {
  beforeEach(resetShell);

  // INF-3011: the character plays the cinch once per shortening, even one heard only ending.
  it("counts each start of a shortening once and keeps whether one runs", () => {
    const state = () => useShellStore.getState();
    const starts = state().firstmateFoldStarts;
    state().applyEvent({ type: "firstmate_state", busy: true });
    expect(state()).toMatchObject({ firstmateFolding: false, firstmateFoldStarts: starts });
    state().applyEvent({ type: "firstmate_state", busy: true, folding: true });
    state().applyEvent({ type: "firstmate_state", busy: true, folding: true });
    expect(state()).toMatchObject({ firstmateFolding: true, firstmateFoldStarts: starts + 1 });
    state().applyEvent({ type: "firstmate_state", busy: true, folding: false });
    expect(state()).toMatchObject({ firstmateFolding: false, firstmateFoldStarts: starts + 1 });
    state().applyEvent({ type: "firstmate_state", busy: true, folding: true });
    state().applyEvent({ type: "firstmate_state", busy: false });
    expect(state()).toMatchObject({
      firstmateBusy: false,
      firstmateFolding: false,
      firstmateFoldStarts: starts + 2,
    });
  });
});

describe("emotes on task_changed (task-system P5)", () => {
  const drain = () => {
    const taken: string[] = [];
    for (let emote = takeCharacterEmote(); emote; emote = takeCharacterEmote()) taken.push(emote);
    return taken;
  };
  afterEach(drain);

  const changed = (
    overrides: Partial<Extract<FmEvent, { type: "task_changed" }>>,
  ): Extract<FmEvent, { type: "task_changed" }> => ({
    type: "task_changed",
    taskId: "t1",
    key: "NIA-1",
    kind: "work",
    status: "done",
    from: "active",
    activity: null,
    closedReason: "landed",
    seq: 1,
    ...overrides,
  });

  it("celebrates work landing or merging, once per transition", () => {
    drain();
    const { applyEvent } = useShellStore.getState();
    applyEvent(changed({}));
    expect(drain()).toEqual(["celebrate"]);
    applyEvent(changed({ closedReason: "merged", from: "active" }));
    expect(drain()).toEqual(["celebrate"]);
    // The worktree going, a card resolving: later writes on the closed row.
    applyEvent(changed({ from: "done" }));
    expect(drain()).toEqual([]);
    // An answered question or a settled operation is not a landing.
    applyEvent(changed({ kind: "question", closedReason: "answered", from: "open" }));
    applyEvent(changed({ kind: "operation", closedReason: "settled", from: "open" }));
    expect(drain()).toEqual([]);
  });

  it("celebrates an answer task delivering, and never a question being answered", () => {
    drain();
    const { applyEvent } = useShellStore.getState();
    // An answer task closes done/answered when the captain resolves its card
    // (Task B): that is a delivery, so it celebrates like a landing.
    applyEvent(changed({ closedReason: "answered", from: "active" }));
    expect(drain()).toEqual(["celebrate"]);
    // The same reason on a question row is the Firstmate answering a
    // one-off: keyed on the event's kind, it fires nothing.
    applyEvent(changed({ kind: "question", closedReason: "answered", from: "active" }));
    expect(drain()).toEqual([]);
  });

  it("queues an emote requested by the Firstmate tool", () => {
    drain();
    useShellStore.getState().applyEvent({ type: "firstmate_emote", emote: "ponder" });
    expect(drain()).toEqual(["ponder"]);
  });

  it("is confused by a task failing for good and by a failed turn, deduplicated", () => {
    drain();
    const { applyEvent } = useShellStore.getState();
    applyEvent(changed({ status: "dropped", closedReason: "failed" }));
    applyEvent({ type: "turn_failed", taskId: "t1", error: "boom" });
    expect(drain()).toEqual(["confused"]);
    applyEvent(changed({ status: "dropped", closedReason: "cancelled" }));
    expect(drain()).toEqual([]);
  });
});

describe("the last turn above the input (./LastTurn, docs/composer.md)", () => {
  const T0 = 1_700_000_000_000;
  const state = () => useShellStore.getState();
  const drain = () => {
    const out: string[] = [];
    for (let next = takeCharacterEmote(); next; next = takeCharacterEmote()) out.push(next);
    return out;
  };
  const lastTurn = vi.fn(async () => null as LastTurn | null);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    lastTurn.mockReset();
    vi.stubGlobal("window", {
      infinitary: {
        conversation: { send: vi.fn(async () => ({ ok: true as const })), lastTurn },
      },
    });
    resetShell();
    drain();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetShell();
  });

  it("starts a round with each message sent, keeps the round before it, and the turn that read it fills in the reply", () => {
    state().applyEvent({ type: "user_turn", text: "How is the alpha coming along?" });
    expect(state().lastTurn).toEqual({
      you: "How is the alpha coming along?",
      reply: null,
      previous: null,
    });
    expect(state().lastTurnSeq).toBe(1);
    state().applyEvent({ type: "firstmate_reply", text: "The alpha is cut" });
    expect(state().lastTurn).toEqual({
      you: "How is the alpha coming along?",
      reply: { text: "The alpha is cut" },
      previous: null,
    });
    // INF-1771, the captain's ask: "allow last two rounds of messages
    // instead of one round". The next message becomes the newest round and
    // the round it follows the older one; its reply is not yet given.
    state().applyEvent({ type: "user_turn", text: "Merge it" });
    expect(state().lastTurn).toEqual({
      you: "Merge it",
      reply: null,
      previous: { you: "How is the alpha coming along?", reply: { text: "The alpha is cut" } },
    });
    expect(state().lastTurnSeq).toBe(2);
    state().applyEvent({ type: "firstmate_reply", text: "Something went wrong", problem: true });
    expect(state().lastTurn?.reply).toEqual({ text: "Something went wrong", problem: true });
    // A third message pushes the oldest out: two rounds, never more.
    state().applyEvent({ type: "user_turn", text: "Try again" });
    expect(state().lastTurn).toEqual({
      you: "Try again",
      reply: null,
      previous: { you: "Merge it", reply: { text: "Something went wrong", problem: true } },
    });
  });

  it("puts no reply up before any message, and leaves emote words to the reply line", () => {
    state().applyEvent({ type: "firstmate_reply", text: "Got it" });
    expect(state().lastTurn).toBeNull();
    state().applyEvent({ type: "user_turn", text: "Salute me" });
    state().applyEvent({ type: "firstmate_emote", emote: "salute", text: "On it" });
    // The motion still plays; only the core's reply line changes the area.
    expect(drain()).toEqual(["salute"]);
    expect(state().lastTurn).toEqual({ you: "Salute me", reply: null, previous: null });
  });

  it("reads the last turn back from the core as the window opens", async () => {
    lastTurn.mockResolvedValueOnce({ you: "Remember that I squash", reply: { text: "Noted" } });
    await state().loadLastTurn();
    expect(state().lastTurn).toEqual({ you: "Remember that I squash", reply: { text: "Noted" } });
  });

  it("keeps a message seen sent while the read was out, which is newer than the read", async () => {
    let answer: (turn: LastTurn | null) => void = () => {};
    lastTurn.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const reading = state().loadLastTurn();
    state().applyEvent({ type: "user_turn", text: "A newer message" });
    answer({ you: "An older message", reply: { text: "Got it" } });
    await reading;
    expect(state().lastTurn).toEqual({ you: "A newer message", reply: null, previous: null });
  });

  // INF-1103, the captain's Approve and build on INF-1102's plan: a click
  // on the reply line opens "A reading card the window holds, like a past
  // card", showing the words "As the first mate wrote them".
  it("opens the reply whole as one held note at the front, which Esc's close takes away", () => {
    useShellStore.setState({
      cards: [card({ id: "decision", status: "ready", actions: DECIDE })],
      records: [],
      cardIndex: 0,
    });
    expect(state().openReplyNote()).toBe(false);
    expect(state().records).toEqual([]);
    state().applyEvent({ type: "user_turn", text: "Can the Mac mini run the Linux checks?" });
    state().applyEvent({
      type: "firstmate_reply",
      text: "Looking at: - which checks run; - the risk.",
      words: "Looking at:\n- which checks run;\n- the risk.",
      eligibility: "completed",
    });
    expect(state().openReplyNote()).toBe(true);
    const shown = () => shownCard(state().cards, state().cardIndex, [], state().records);
    expect(shown()?.replyNote).toEqual({
      you: "Can the Mac mini run the Linux checks?",
      words: "Looking at:\n- which checks run;\n- the risk.",
      problem: false,
    });
    expect(isHeldEntry(shown())).toBe(true);
    // A newer reply: opening again brings the one note forward with it.
    state().nextCard();
    state().applyEvent({ type: "user_turn", text: "Merge it" });
    state().applyEvent({ type: "firstmate_reply", text: "Something went wrong", problem: true });
    state().openReplyNote();
    expect(state().records).toEqual([
      { replyNote: { you: "Merge it", words: "Something went wrong", problem: true } },
    ]);
    expect(shown()?.replyNote?.words).toBe("Something went wrong");
    // INF-1770's plan: the older round's reply line opens its own reply.
    state().openReplyNote("older");
    expect(state().records).toEqual([
      {
        replyNote: {
          you: "Can the Mac mini run the Linux checks?",
          words: "Looking at:\n- which checks run;\n- the risk.",
          problem: false,
        },
      },
    ]);
    state().closeRecord();
    expect(state().records).toEqual([]);
    expect(shown()?.id).toBe("decision");
  });

  it("still ends the first-run hint on the first send", () => {
    useShellStore.setState({
      firstRun: { welcomedAt: null, firstTurnAt: null, gateOpen: false },
      inputText: "hello",
      attachments: [],
      pastes: [],
      recording: false,
      cards: [],
      records: [],
    });
    state().submit();
    expect(state().firstRun?.firstTurnAt).toBe(T0);
  });
});
