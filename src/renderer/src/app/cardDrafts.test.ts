import { CARD_DRAFTS, type CardDraft } from "@shared/cardDrafts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCardDrafts } from "./cardDrafts";
import { DRAFT_QUIET_MS } from "./draftSync";
import type { ShellState } from "./store";

// Intent (INF-5446's plan): a window whose first mate's computer lacks the
// `card-drafts` change keeps today's behavior - it reads no draft and sends
// none, and its picks stay its own.

type Listener = (state: ShellState, previous: ShellState) => void;

function windowWith(changes: string[]) {
  const drafts = vi.fn(async (): Promise<CardDraft[]> => []);
  const draft = vi.fn(async (cardId: string) => ({
    draft: { cardId, revision: 1, answers: [], words: "", notes: [] },
  }));
  vi.stubGlobal("window", {
    infinitary: {
      app: { healthcheck: async () => ({ changes }) },
      cards: { drafts, draft, onDraft: () => () => {} },
    },
  });
  let state = {
    cards: [{ id: "card-1" }],
    cardAnswers: {},
    replyDrafts: {},
    replyNotes: {},
    thisMac: { role: "home", left: null },
  } as unknown as ShellState;
  let listener: Listener = () => {};
  startCardDrafts(
    () => state,
    () => {},
    (next) => {
      listener = next;
      return () => {};
    },
  );
  const type = (words: string) => {
    const previous = state;
    state = { ...state, replyDrafts: { "card-1": words } };
    listener(state, previous);
  };
  return { drafts, draft, type };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startCardDrafts", () => {
  it("reads and sends nothing when the first mate's computer lacks the change", async () => {
    vi.useFakeTimers();
    const at = windowWith([]);
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
    expect(at.drafts).toHaveBeenCalledTimes(1);
    at.type("Start after the tide");
    await vi.advanceTimersByTimeAsync(DRAFT_QUIET_MS * 2);
    expect(at.draft).toHaveBeenCalledTimes(1);
    expect(at.draft.mock.calls[0]?.[1]).toMatchObject({ words: "Start after the tide" });
  });
});
