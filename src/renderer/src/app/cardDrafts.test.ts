import { CARD_DRAFTS, type CardDraft, type CardDraftChange } from "@shared/cardDrafts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageQueue } from "../cards/markedPictures";
import { startCardDrafts } from "./cardDrafts";
import { DRAFT_QUIET_MS } from "./draftSync";
import type { ShellState } from "./store";
import { holdsUnsentWords } from "./unsentWords";

// Intent (INF-5446's plan): a window whose first mate's computer lacks the
// `card-drafts` change keeps today's behavior - it reads no draft and sends
// none, and its picks stay its own.

type Listener = (state: ShellState, previous: ShellState) => void;

const VIEW = {
  role: "view",
  name: "MacBook Pro",
  address: "127.0.0.1",
  joinedAt: 1,
  contact: "in-reach",
  readOnly: null,
  heardAt: 1,
  caughtUp: 0,
};

function windowWith(
  changes: string[],
  thisMac: object = { role: "home", left: null },
  start: Partial<ShellState> = {},
) {
  /** The drafts the first mate's computer holds, as a reading answers them. */
  const held: CardDraft[] = [];
  const drafts = vi.fn(async (): Promise<CardDraft[]> => [...held]);
  let hear: (draft: CardDraft) => void = () => {};
  const draft = vi.fn(async (cardId: string, _change: CardDraftChange) => ({
    draft: { cardId, revision: 1, answers: [], words: "", notes: [] },
  }));
  vi.stubGlobal("window", {
    infinitary: {
      app: { healthcheck: async () => ({ changes }) },
      cards: {
        drafts,
        draft,
        onDraft: (listener: (draft: CardDraft) => void) => {
          hear = listener;
          return () => {};
        },
      },
    },
  });
  let state = {
    cards: [],
    cardsSnapshotLoaded: false,
    cardAnswers: {},
    replyDrafts: {},
    replyNotes: {},
    thisMac,
    ...start,
  } as unknown as ShellState;
  let listener: Listener = () => {};
  const change = (next: Partial<ShellState>) => {
    const previous = state;
    state = { ...state, ...next };
    listener(state, previous);
  };
  startCardDrafts(
    () => state,
    (update) =>
      change(typeof update === "function" ? (update(state) as Partial<ShellState>) : update),
    (next) => {
      listener = next;
      return () => {};
    },
  );
  const type = (words: string) => {
    const previous = state;
    state = { ...state, replyDrafts: { ...state.replyDrafts, "card-1": words } };
    listener(state, previous);
  };
  /** The link to the first mate came back, as `ThisMac` says it. */
  const back = (next: object) => {
    const previous = state;
    state = { ...state, thisMac: next } as unknown as ShellState;
    listener(state, previous);
  };
  /** The stack loads, or a later snapshot arrives, holding these cards. */
  const stack = (cards: object[]) =>
    change({ cards, cardsSnapshotLoaded: true } as unknown as Partial<ShellState>);
  /** Another window's change, as its live frame arrives and as the home then holds it. */
  const live = (next: CardDraft) => {
    held.splice(0, held.length, next);
    hear(next);
  };
  return { drafts, draft, type, back, stack, live, state: () => state };
}

/** This window's own storage, as a node test has none. */
function stubStorage(seed: Record<string, string> = {}) {
  const held = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => held.set(key, value),
    removeItem: (key: string) => held.delete(key),
  });
  return held;
}

const PICKED = {
  answered: 1,
  of: 1,
  changed: 1,
  picked: 1,
  answers: [{ name: "harbour", values: ["south"], changed: true }],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startCardDrafts", () => {
  it("reads and sends nothing when the first mate's computer lacks the change", async () => {
    vi.useFakeTimers();
    const at = windowWith([]);
    at.stack([{ id: "card-1" }]);
    await vi.runAllTimersAsync();
    at.type("Start after the tide");
    await vi.advanceTimersByTimeAsync(DRAFT_QUIET_MS * 2);
    expect(at.drafts).not.toHaveBeenCalled();
    expect(at.draft).not.toHaveBeenCalled();
  });

  it("reads every draft and sends a change once typing pauses when it has the change", async () => {
    vi.useFakeTimers();
    const at = windowWith([CARD_DRAFTS]);
    await vi.runAllTimersAsync();
    // Nothing is read before the stack loads, when no card's opening is known.
    expect(at.drafts).not.toHaveBeenCalled();
    at.stack([{ id: "card-1" }]);
    await vi.runAllTimersAsync();
    expect(at.drafts).toHaveBeenCalledTimes(1);
    at.type("Start after the tide");
    await vi.advanceTimersByTimeAsync(DRAFT_QUIET_MS * 2);
    expect(at.draft).toHaveBeenCalledTimes(1);
    expect(at.draft.mock.calls[0]?.[1]).toMatchObject({ words: "Start after the tide" });
  });

  // Intent (the captain's typed-there choice on INF-5374's review): a card's
  // words or notes taken from another window hold no app's restart here, as
  // the home keeps them; words typed in this window do, even over them.
  it("holds a restart only for card words and notes typed in this window", async () => {
    vi.useFakeTimers();
    stubStorage();
    const at = windowWith([CARD_DRAFTS], VIEW, {
      inputText: "",
      attachments: [],
      pastes: [],
      replyPastes: {},
      replyImages: {},
    });
    at.stack([{ id: "card-1" }]);
    await vi.runAllTimersAsync();
    expect(holdsUnsentWords(at.state())).toBe(false);
    const note = { id: "note-1", target: { kind: "point" }, comment: "Too dark" };
    at.live({
      cardId: "card-1",
      revision: 1,
      answers: [],
      words: "Start after the tide",
      notes: [note],
    } as unknown as CardDraft);
    expect(at.state().replyDrafts["card-1"]).toBe("Start after the tide");
    expect(at.state().replyNotes["card-1"]).toHaveLength(1);
    expect(holdsUnsentWords(at.state())).toBe(false);
    at.type("Start after the tide, then wait");
    expect(holdsUnsentWords(at.state())).toBe(true);
    // The card leaves, and with it what this window took for it.
    at.stack([]);
  });

  // Intent (the captain's wait-for-draft and typed-there choices on INF-5374's
  // review): a card answered or withdrawn at another computer leaves the
  // stack, and the words it held here show in no field, so they hold nothing;
  // a page's own queue of notes, with no card, still does.
  it("holds a restart for nothing a card answered elsewhere left behind", async () => {
    vi.useFakeTimers();
    stubStorage();
    const at = windowWith([CARD_DRAFTS], VIEW, {
      inputText: "",
      attachments: [],
      pastes: [],
      replyPastes: {},
      replyImages: {},
    });
    at.stack([{ id: "card-1" }]);
    await vi.runAllTimersAsync();
    at.type("Start after the tide");
    expect(holdsUnsentWords(at.state())).toBe(true);
    // The card was answered at the other computer: the next snapshot no longer holds it.
    at.stack([]);
    expect(at.state().replyDrafts["card-1"]).toBe("Start after the tide");
    expect(holdsUnsentWords(at.state())).toBe(false);
    const note = { id: "note-1", target: { kind: "point" }, comment: "Too dark" };
    const page = { ...at.state(), replyNotes: { [pageQueue("task-1")]: [note] } };
    expect(holdsUnsentWords(page as unknown as ShellState)).toBe(true);
  });

  it("reads every draft again when a view's link comes back, however short the drop", async () => {
    vi.useFakeTimers();
    const at = windowWith([CARD_DRAFTS], VIEW);
    at.stack([{ id: "card-1" }]);
    await vi.runAllTimersAsync();
    expect(at.drafts).toHaveBeenCalledTimes(1);
    at.back({ ...VIEW, linkBack: 1 });
    await vi.runAllTimersAsync();
    expect(at.drafts).toHaveBeenCalledTimes(2);
  });

  it("drops the picks, words and notes of a card's earlier opening when it opens anew under its id", async () => {
    vi.useFakeTimers();
    stubStorage();
    const at = windowWith([CARD_DRAFTS]);
    at.stack([{ id: "card-1", lifecycleId: "opening-1" }]);
    await vi.runAllTimersAsync();
    at.type("Start after the tide");
    expect(at.state().replyDrafts).toEqual({ "card-1": "Start after the tide" });
    // The card closed and opened anew: the next snapshot names its new opening.
    at.stack([{ id: "card-1", lifecycleId: "opening-2" }]);
    expect(at.state().replyDrafts).toEqual({});
    expect(at.state().cardAnswers).toEqual({});
    expect(at.state().replyNotes).toEqual({});
  });

  it("drops picks restored at start that belong to an earlier opening of the card", async () => {
    vi.useFakeTimers();
    // Before the restart this window kept the card's draft at its first opening.
    stubStorage({
      "infinitary.cardDraftBase.card-1": JSON.stringify({
        lifecycle: "opening-1",
        revision: 0,
        parts: { "answer:harbour": 0 },
      }),
    });
    const at = windowWith([CARD_DRAFTS], undefined, { cardAnswers: { "card-1": PICKED } });
    at.stack([{ id: "card-1", lifecycleId: "opening-2" }]);
    expect(at.state().cardAnswers).toEqual({});
    await vi.advanceTimersByTimeAsync(DRAFT_QUIET_MS * 2);
    expect(at.draft).not.toHaveBeenCalled();
  });

  it("sends a pick restored at start that was never sent, even on a card with no draft yet", async () => {
    vi.useFakeTimers();
    stubStorage({
      "infinitary.cardDraftBase.card-1": JSON.stringify({
        lifecycle: "opening-1",
        revision: 0,
        parts: { "answer:harbour": 0 },
      }),
    });
    const at = windowWith([CARD_DRAFTS], undefined, { cardAnswers: { "card-1": PICKED } });
    at.stack([{ id: "card-1", lifecycleId: "opening-1" }]);
    await vi.advanceTimersByTimeAsync(DRAFT_QUIET_MS * 2);
    expect(at.draft).toHaveBeenCalledTimes(1);
    expect(at.draft.mock.calls[0]?.[1]).toMatchObject({
      since: 0,
      lifecycle: "opening-1",
      answers: [{ name: "harbour", values: ["south"] }],
    });
  });

  it("takes a reopened card's draft that arrived before the stack held the new opening", async () => {
    vi.useFakeTimers();
    stubStorage();
    const at = windowWith([CARD_DRAFTS]);
    at.stack([{ id: "card-1", lifecycleId: "opening-1" }]);
    await vi.runAllTimersAsync();
    // The card opened anew; another window's words for it arrive before this stack hears of it.
    at.live({
      cardId: "card-1",
      lifecycle: "opening-2",
      revision: 1,
      answers: [],
      words: "For the new offer",
      notes: [],
    });
    expect(at.state().replyDrafts).toEqual({});
    at.stack([{ id: "card-1", lifecycleId: "opening-2" }]);
    await vi.runAllTimersAsync();
    expect(at.state().replyDrafts).toEqual({ "card-1": "For the new offer" });
  });
});
