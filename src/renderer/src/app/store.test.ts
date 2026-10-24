import {
  CARD_ANSWER_TEXT_MAX,
  CARD_ANSWERS_TOO_LONG,
  CARD_REPLY_MAX_CHARS,
  type Card,
  CONVERSE_TEXT_MAX_CHARS,
  type ShellEffect,
  TURN_IMAGES_MAX,
} from "@shared/cards";
import type { FmEvent } from "@shared/events";
import type { LastTurn } from "@shared/lastTurn";
import { PANEL_OPEN_CARDS_MAX } from "@shared/plugins/panelCards";
import type { MicAccess } from "@shared/voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_FILES_KEY, useIntakeStore } from "../attachments/intake";
import { takeCharacterEmote, takeCharacterNotice } from "../character/emoteSignal";
import { voiceController } from "../voice/voiceController";
import {
  derivePhase,
  dismissalSuccessor,
  isHeldEntry,
  mainInputHeld,
  NOTE_COLLAPSE_MS,
  panelCardEntryId,
  reconcileStack,
  shownCard,
  taskEntryFrom,
  unreadAround,
  useShellStore,
  visibleCards,
  visibleStack,
} from "./store";

/** The metadata every card gesture carries beside it: a fresh id of its own. */
const gesture = (extra: Record<string, unknown> = {}) =>
  expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f]{32}$/), ...extra });

/** A card with an action is a decision; the store collapses only action-less notes. */
const DECIDE: Card["actions"] = [{ id: "go", label: "Go", default: true }];

function card(overrides: Partial<Card> & Pick<Card, "id" | "status">): Card {
  return {
    author: "firstmate",
    priority: 10,
    title: "Card",
    meta: "firstmate",
    body: "",
    actions: [],
    createdAt: 0,
    ...overrides,
  };
}

describe("derivePhase", () => {
  it("heats only for Firstmate's own turn; cards are layout, not heat", () => {
    expect(derivePhase(true, [], false)).toBe("recording");
    expect(derivePhase(false, [], true)).toBe("thinking");
    expect(derivePhase(false, [], false)).toBe("idle");
    const ready = [card({ id: "n1", status: "ready", body: "A fact." })];
    expect(derivePhase(false, ready, false)).toBe("working");
    expect(derivePhase(false, ready, true)).toBe("working");
  });
});

describe("shownCard", () => {
  it("picks the card at cardIndex among visible cards", () => {
    const stack = [
      card({ id: "n1", status: "ready", title: "One", body: "a" }),
      card({ id: "n2", status: "ready", actions: DECIDE, title: "Two", body: "b" }),
    ];
    expect(shownCard(stack, 0)?.id).toBe("n1");
    expect(shownCard(stack, 1)?.id).toBe("n2");
    expect(shownCard(stack, 9)?.id).toBe("n2");
  });
});

describe("applyCards", () => {
  it("does not let an inserted card replace the active card", () => {
    const active = card({ id: "active", status: "ready", body: "active" });
    useShellStore.setState({
      cards: [active],
      cardIndex: 0,
    });

    useShellStore
      .getState()
      .applyCards([card({ id: "new", status: "ready", body: "new" }), active]);

    const { cards, cardIndex } = useShellStore.getState();
    expect(cards.map((item) => item.id)).toEqual(["new", "active"]);
    expect(shownCard(cards, cardIndex)?.id).toBe("active");
  });
});

describe("stack visibility (WI-18)", () => {
  const T0 = 1_000_000_000_000;
  const ready = (id: string, overrides: Partial<Card> = {}) =>
    card({ id, status: "ready", body: id, createdAt: T0, ...overrides });
  const state = () => useShellStore.getState();
  const shownId = () => {
    const s = state();
    return shownCard(s.cards, s.cardIndex, s.collapsedCardIds, s.records)?.id;
  };
  const unread = () => {
    const s = state();
    return unreadAround(visibleCards(s.cards, s.collapsedCardIds), s.cardIndex, s.unreadCardIds);
  };

  const reset = () => {
    vi.useRealTimers();
    takeCharacterNotice();
    useShellStore.setState({
      cards: [],
      records: [],
      cardIndex: 0,
      unreadCardIds: [],
      collapsedCardIds: [],
      collapsedDigests: {},
      cardsSeeded: false,
      threads: {},
      closedThreadIds: [],
      replyDrafts: {},
      replyImages: {},
      replyNotices: {},
      replyErrors: {},
    });
  };
  beforeEach(reset);
  afterEach(reset);

  it("INF-476 removes minimized cards from paging and unread, and a revision returns unread without stealing the shown card", () => {
    const choice = ready("choice", { actions: DECIDE });
    const note = ready("note");
    state().applyCards([choice, note]);
    state().setReplyDraft("choice", "Keep the review beside it.");
    state().applyCards([{ ...choice, minimized: true }, note]);
    expect(
      visibleStack(state().cards, state().collapsedCardIds, state().records).map(
        (entry) => entry.id,
      ),
    ).toEqual(["note"]);
    expect(state().unreadCardIds).not.toContain("choice");
    expect(shownId()).toBe("note");
    expect(state().replyDrafts.choice).toBe("Keep the review beside it.");
    state().applyCards([
      { ...choice, body: "<p>Friday keeps the review beside the launch.</p>" },
      note,
    ]);
    expect(shownId()).toBe("note");
    expect(state().unreadCardIds).toContain("choice");
  });

  it("shows a card by the core's word alone: a thread message never brings a held card back", () => {
    const item = ready("a", { actions: DECIDE });
    state().applyCards([{ ...item, awaiting: "answer" }]);
    expect(shownId()).toBeUndefined();
    expect(state().phase).not.toBe("working");
    const message = (id: number, who: "captain" | "crewmate" | "host") => ({
      id,
      cardId: "a",
      who,
      text: `message ${id}`,
      at: T0,
    });

    // The author's acknowledgement and its revision line paint the thread,
    // and the card stays off the stage: it waits on the author's close-out.
    state().applyThread("a", [message(1, "captain"), message(2, "crewmate")]);
    state().applyCards([{ ...item, title: "Revised", awaiting: "close-out" }]);
    state().applyThread("a", [message(1, "captain"), message(2, "crewmate"), message(3, "host")]);
    expect(shownId()).toBeUndefined();
    expect(state().threads.a).toHaveLength(3);

    // The close-out is the core clearing `awaiting`: the card is back on
    // the stage, which is what the phase says.
    state().applyCards([{ ...item, title: "Revised" }]);
    expect(shownId()).toBe("a");
    expect(state().phase).toBe("working");
  });

  it("keeps a collapsed thread collapsed until a message arrives, and lets the collapse go with its card", () => {
    const item = ready("a", { actions: DECIDE });
    state().applyCards([item]);
    const said = (id: number, who: "captain" | "firstmate" | "host") => ({
      id,
      cardId: "a",
      who,
      text: `message ${id}`,
      at: T0 + id,
    });
    const thread = (count: number) =>
      [said(1, "captain"), said(2, "firstmate"), said(3, "captain")].slice(0, count);
    state().applyThread("a", thread(1));
    state().closeThread("a");
    state().closeThread("a");
    expect(state().closedThreadIds).toEqual(["a"]);
    // A read that brings nothing new, such as a window catching up, keeps it.
    state().applyThread("a", thread(1));
    expect(state().closedThreadIds).toEqual(["a"]);
    // The author's answer opens it again (the captain's FI3-1130 answers)...
    state().applyThread("a", thread(2));
    expect(state().closedThreadIds).toEqual([]);
    // ...and so does his own reply, sent from the collapsed card.
    state().closeThread("a");
    state().applyThread("a", thread(3));
    expect(state().closedThreadIds).toEqual([]);
    // The cue and the key open it by hand.
    state().closeThread("a");
    state().openThread("a");
    expect(state().closedThreadIds).toEqual([]);
    // It holds while the card is up, and goes with it.
    state().closeThread("a");
    state().applyCards([{ ...item, title: "Revised" }]);
    expect(state().closedThreadIds).toEqual(["a"]);
    state().applyCards([]);
    expect(state().closedThreadIds).toEqual([]);
  });

  it("refuses excess reply pictures with a notice on that card only", () => {
    const picture = (id: string) => ({
      id,
      preview: `data:image/png;base64,${id}`,
      mimeType: "image/png" as const,
      data: id,
    });
    state().attachReplyImages(
      "a",
      Array.from({ length: TURN_IMAGES_MAX + 1 }, (_, i) => picture(`${i}`)),
    );
    expect(state().replyImages.a).toHaveLength(TURN_IMAGES_MAX);
    expect(state().replyNotices.a).toBe("pictures-max");
    state().attachReplyImages("a", [picture("another")]);
    expect(state().replyImages.a).toHaveLength(TURN_IMAGES_MAX);
    state().attachReplyImages("b", [picture("b")]);
    expect(state().replyNotices.b).toBeUndefined();
    state().dismissReplyNotice("a");
    expect(state().replyNotices.a).toBeUndefined();
  });

  it("leaves the stack alone when a reply is refused, the draft kept", async () => {
    const a = ready("a", { actions: DECIDE, author: "crewmate", taskId: "t1" });
    const b = ready("b", { actions: DECIDE });
    state().applyCards([a, b]);
    const reply = vi.fn(async () => {
      throw new Error("Card is closed");
    });
    vi.stubGlobal("window", { infinitary: { cards: { reply } } });
    try {
      state().setReplyDraft("a", "why?");
      const focus = state().focusRequest;
      await state().sendReply("a");
      expect(reply).toHaveBeenCalledWith("a", "why?", gesture());
      // Refused: the core never removed the card, so nothing moved.
      expect(shownId()).toBe("a");
      expect(state().cards.map((card) => card.id)).toEqual(["a", "b"]);
      expect(state().replyDrafts.a).toBe("why?");
      expect(state().replyErrors.a).toBe("Card is closed");
      expect(state().focusRequest).toBe(focus);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds a reply while its own file is being prepared, not another card's", async () => {
    const item = ready("a", { actions: DECIDE, author: "crewmate", taskId: "t1" });
    state().applyCards([item]);
    const reply = vi.fn(async () => ({ cardId: "a", messages: [] }));
    vi.stubGlobal("window", { infinitary: { cards: { reply, list: async () => [] } } });
    try {
      state().setReplyDraft("a", "hello");
      useIntakeStore.setState({ pending: { b: [{ id: "f1", name: "other.txt" }] } });
      await state().sendReply("a");
      expect(reply).toHaveBeenCalledTimes(1);
      state().setReplyDraft("a", "again");
      useIntakeStore.setState({ pending: { a: [{ id: "f2", name: "mine.txt" }] } });
      await state().sendReply("a");
      expect(reply).toHaveBeenCalledTimes(1);
      expect(state().replyNotices.a).toBe("files-preparing");
      expect(state().replyDrafts.a).toBe("again");
    } finally {
      vi.unstubAllGlobals();
      useIntakeStore.setState({ pending: {} });
    }
  });

  it("keeps four reply file chips on refusal and sends them beside a full typed reply", async () => {
    const item = ready("a", { actions: DECIDE, author: "crewmate", taskId: "t1" });
    state().applyCards([item]);
    const reply = vi.fn(async () => {
      throw new Error("not sent");
    });
    vi.stubGlobal("window", { infinitary: { cards: { reply } } });
    try {
      state().setReplyDraft("a", "x".repeat(CARD_REPLY_MAX_CHARS));
      for (let i = 0; i < 4; i++) state().attachReplyPaste("a", "log".repeat(3000));
      state().attachReplyPaste("a", "extra");
      expect(state().replyNotices.a).toBe("files-max");
      await state().sendReply("a");
      expect(reply).toHaveBeenCalledWith(
        "a",
        expect.objectContaining({
          text: "x".repeat(CARD_REPLY_MAX_CHARS),
          files: Array.from({ length: 4 }, () => ({ text: "log".repeat(3000) })),
        }),
        gesture(),
      );
      expect(state().replyPastes.a).toHaveLength(4);
      expect(state().replyDrafts.a).toHaveLength(CARD_REPLY_MAX_CHARS);
    } finally {
      vi.unstubAllGlobals();
      state().removeReplyPaste("a", state().replyPastes.a?.[0]?.id ?? "");
      useShellStore.setState({ replyPastes: {} });
    }
  });

  it.each(["collection", "transport"])(
    "clears immediately and restores an exact draft and all chips on %s refusal",
    async (boundary) => {
      state().applyCards([ready("a", { actions: DECIDE })]);
      const draft = "  keep these spaces\n";
      state().setReplyDraft("a", draft);
      state().attachReplyPaste("a", "transcript");
      state().attachReplyImages("a", [
        {
          id: "picture",
          preview: "data:image/png;base64,png",
          mimeType: "image/png",
          data: "png",
        },
      ]);
      const pastes = state().replyPastes.a;
      const images = state().replyImages.a;
      let refuse!: (error: Error) => void;
      const collected = new Promise<never>((_, reject) => {
        refuse = reject;
      });
      const reply = vi.fn(() => collected);
      vi.stubGlobal("window", { infinitary: { cards: { reply } } });
      try {
        const sending = state().sendReply(
          "a",
          boundary === "collection" ? () => collected : undefined,
        );
        expect(state().replyDrafts.a).toBeUndefined();
        expect(state().replyPastes.a).toBeUndefined();
        expect(state().replyImages.a).toBeUndefined();
        expect(state().sendingReplies.a).toBe(true);
        refuse(new Error("could not collect"));
        await sending;
        expect(reply).toHaveBeenCalledTimes(boundary === "collection" ? 0 : 1);
        expect(state().replyDrafts.a).toBe(draft);
        expect(state().replyPastes.a).toEqual(pastes);
        expect(state().replyImages.a).toEqual(images);
        expect(state().sendingReplies.a).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
        useShellStore.setState({ replyPastes: {} });
      }
    },
  );

  it("clears before the reply round trip and releases sending before first-run refresh", async () => {
    state().applyCards([ready("a", { actions: DECIDE })]);
    state().setReplyDraft("a", "hello");
    let take!: (thread: { cardId: string; messages: [] }) => void;
    const response = new Promise<{ cardId: string; messages: [] }>((resolve) => {
      take = resolve;
    });
    let refresh!: () => void;
    const firstRun = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          refresh = resolve;
        }),
    );
    vi.stubGlobal("window", {
      infinitary: { cards: { reply: () => response }, app: { firstRun } },
    });
    try {
      const sending = state().sendReply("a");
      expect(state().replyDrafts.a).toBeUndefined();
      expect(state().sendingReplies.a).toBe(true);
      take({ cardId: "a", messages: [] });
      await sending;
      expect(firstRun).toHaveBeenCalledOnce();
      expect(state().sendingReplies.a).toBeUndefined();
      state().setReplyDraft("a", "next reply");
      refresh();
      await Promise.resolve();
      expect(state().replyDrafts.a).toBe("next reply");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads current reply settings before hiding the frame and sends partial context once", async () => {
    const item = ready("a", { actions: DECIDE, author: "crewmate", taskId: "t1" });
    state().applyCards([item]);
    const answers = [
      { name: "look", values: ['{"tiltDeg":57}'], changed: true, json: true as const },
    ];
    const reply = vi.fn(async () => ({ cardId: "a", messages: [] }));
    vi.stubGlobal("window", { infinitary: { cards: { reply } } });
    try {
      state().setReplyDraft("a", "build it as adjusted");
      const collect = vi.fn(async () => {
        expect(shownId()).toBe("a");
        await Promise.resolve();
        return { answers, of: 2, answered: 1, changed: 1, picked: 1 };
      });
      const first = state().sendReply("a", collect);
      await state().sendReply("a", collect);
      await first;
      expect(collect).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledWith(
        "a",
        { text: "build it as adjusted", answers, images: [] },
        gesture(),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends a multi-line reply with its lines, and keeps one past the limit unsent", async () => {
    const item = ready("a", { actions: DECIDE, author: "crewmate", taskId: "t1" });
    state().applyCards([item]);
    const reply = vi.fn(async () => ({ cardId: "a", messages: [] }));
    vi.stubGlobal("window", { infinitary: { cards: { reply } } });
    try {
      const tooLong = "x".repeat(CARD_REPLY_MAX_CHARS + 1);
      state().setReplyDraft("a", tooLong);
      await state().sendReply("a");
      expect(reply).not.toHaveBeenCalled();
      expect(state().replyDrafts.a).toBe(tooLong);
      expect(shownId()).toBe("a");

      // Leading blank lines and trailing whitespace go; the lines between stay.
      state().setReplyDraft("a", "\nthe second option is wrong\n\nkeep the first\n  ");
      await state().sendReply("a");
      expect(reply).toHaveBeenCalledWith(
        "a",
        "the second option is wrong\n\nkeep the first",
        gesture(),
      );
      expect(state().replyDrafts.a).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // INF-770 direction A: a reply never moves a card, whatever waits behind it.
  it("keeps the shown card up through a reply send and its core pushes, with others behind", async () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    state().applyCards([a, b]);
    const reply = vi.fn(async () => ({ cardId: "a", messages: [] }));
    vi.stubGlobal("window", { infinitary: { cards: { reply } } });
    try {
      state().setReplyDraft("a", "why this answer?");
      await state().sendReply("a");
      expect(reply).toHaveBeenCalledOnce();
      expect(shownId()).toBe("a");
      state().applyCards([{ ...a, awaiting: "answer", sentBackAt: 10 }, b]);
      expect(shownId()).toBe("a");
      expect(visibleStack(state().cards)).toHaveLength(2);
      state().applyCards([a, b]);
      expect(shownId()).toBe("a");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("brings a marked arrival forward only when it first reaches the stage", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE, holdsPlace: true });
    state().applyCards([a]);
    state().applyCards([a, { ...b, awaiting: "close-out" }]);
    expect(shownId()).toBe("a");
    state().applyCards([a, b]);
    expect(shownId()).toBe("b");
    expect(state().unreadCardIds).not.toContain("b");
    state().prevCard();
    expect(shownId()).toBe("a");
    state().applyCards([a, { ...b, body: "revised while paged away" }]);
    expect(shownId()).toBe("a");
    state().applyCards([a, { ...b, awaiting: "answer", sentBackAt: 10 }]);
    state().applyCards([a, b]);
    expect(shownId()).toBe("a");
    // A choice removed the card. The same stable id can arrive again.
    state().applyCards([a]);
    state().applyCards([a, b]);
    expect(shownId()).toBe("b");
  });

  it("brings the first card up when the shown card goes off the stage while it waits on its author", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    state().applyCards([a, b, c]);
    takeCharacterNotice();
    const idsOf = () => visibleCards(state().cards).map((card) => card.id);
    // A card an older version sent away on a reply: it is off the stack.
    state().applyCards([b, c, { ...a, awaiting: "answer" }]);
    expect(idsOf()).toEqual(["b", "c"]);
    expect(shownId()).toBe("b");
    expect(state().cardIndex).toBe(0);
    // Departure is not news.
    expect(state().unreadCardIds).toEqual([]);
    expect(takeCharacterNotice()).toBe(false);
  });

  it("reveals the first card after a middle close or reply, skipping open records", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    const d = ready("d", { actions: DECIDE });
    state().applyCards([a, b, c, d]);
    state().openRecord("t1");
    state().openRecord("t2");
    state().focusCard("c");
    state().applyCards([a, b, d]);
    expect(shownId()).toBe("a");
    expect(state().cardIndex).toBe(2);
    state().applyCards([a, b, c, d]);
    // "c" came back: it is news, and the first unread card wins.
    state().focusCard("c");
    state().focusCard("b");
    state().applyCards([a, c, d, { ...b, awaiting: "answer" }]);
    expect(shownId()).toBe("a");
    expect(state().cardIndex).toBe(2);
    // Unseen departures leave the reader in place.
    state().focusCard("d");
    state().applyCards([a, d, { ...b, awaiting: "answer" }]);
    expect(shownId()).toBe("d");
    // Hiding the shown record skips the other open record.
    state().openRecord("t2");
    state().closeTaskRecord("t2");
    expect(shownId()).toBe("a");
    expect(state().records).toEqual([{ taskId: "t1" }]);
  });

  it("wraps to the first card when the shown card was the last one", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    state().applyCards([a, b, c]);
    state().nextCard();
    state().nextCard();
    expect(shownId()).toBe("c");
    state().applyCards([a, b, { ...c, awaiting: "answer" }]);
    expect(shownId()).toBe("a");
    expect(state().cardIndex).toBe(0);
    // Repeated waiting snapshots do not move the reader.
    state().applyCards([{ ...c, awaiting: "answer" }, a, b]);
    state().applyCards([a, b, { ...c, awaiting: "answer" }]);
    expect(shownId()).toBe("a");
  });

  it("brings up the first unread card after a close or a reply, before the first card", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    const d = ready("d", { actions: DECIDE, createdAt: T0 + 1 });
    const e = ready("e", { actions: DECIDE, createdAt: T0 + 2 });
    state().applyCards([a, b, c]);
    state().focusCard("b");
    // Two arrivals behind the shown card: both unread, "d" first in stack order.
    state().applyCards([a, b, c, d, e]);
    expect(state().unreadCardIds).toEqual(["d", "e"]);
    state().applyCards([a, c, d, e]);
    expect(shownId()).toBe("d");
    expect(state().unreadCardIds).toEqual(["e"]);
    // A reply removes "d"; the same rule passes over it and finds "e".
    state().applyCards([a, c, e, { ...d, awaiting: "answer" }]);
    expect(shownId()).toBe("e");
    expect(state().unreadCardIds).toEqual([]);
    // Nothing unread: the first card, as before.
    state().applyCards([a, c, { ...d, awaiting: "answer" }]);
    expect(shownId()).toBe("a");
  });

  it("prepares the card a close would bring up, by the same rule", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    const stack = [a, b, c];
    // Shown "a": nothing unread, so "b", never the shown card itself.
    expect(dismissalSuccessor(stack, 0, [])?.id).toBe("b");
    // Shown "b": the first card, not the next arrow.
    expect(dismissalSuccessor(stack, 1, [])?.id).toBe("a");
    // An unread card wins wherever it is.
    expect(dismissalSuccessor(stack, 0, ["c"])?.id).toBe("c");
    expect(dismissalSuccessor([a], 0, [])).toBeUndefined();
    // A record comes up only when no card is left.
    state().applyCards([a]);
    state().openRecord("t1");
    const withRecord = visibleStack(state().cards, [], state().records);
    expect(dismissalSuccessor(withRecord, 1, [])?.recordTaskId).toBe("t1");
  });

  for (const held of ["record", "past"] as const) {
    for (const unread of [[], ["c"], ["b", "c"], ["c", "b"]]) {
      it(`predicts ${held} Hide's first live card with unread ${unread.join(",") || "none"}`, () => {
        const a = ready("a", { actions: DECIDE });
        const b = ready("b", { actions: DECIDE });
        const c = ready("c", { actions: DECIDE });
        state().applyCards([a, b, c]);
        state().openRecord("other");
        if (held === "record") state().openRecord("held");
        else state().openPastCard("held");
        useShellStore.setState({ unreadCardIds: unread });
        const predict = () =>
          dismissalSuccessor(
            visibleStack(state().cards, [], state().records),
            state().cardIndex,
            state().unreadCardIds,
          );
        expect(predict()?.id).toBe("a");
        // A changed candidate or order is read from the current stack, not cached.
        state().applyCards([b, c]);
        expect(predict()?.id).toBe("b");
        state().applyCards([c, b]);
        expect(predict()?.id).toBe("c");
        const predicted = predict()?.id;
        if (held === "record") state().closeTaskRecord("held");
        else state().closePastCard("held");
        expect(shownId()).toBe(predicted);
        expect(state().unreadCardIds).not.toContain(predicted);
      });
    }

    it(`predicts ${held} Hide's remaining held entry or empty stage when no live cards remain`, () => {
      state().applyCards([]);
      state().openRecord("other");
      if (held === "record") state().openRecord("held");
      else state().openPastCard("held");
      const predict = () =>
        dismissalSuccessor(visibleStack(state().cards, [], state().records), state().cardIndex, [
          "stale",
        ]);
      expect(predict()?.id).toBe("record:other");
      state().closeRecord();
      expect(shownId()).toBe("record:other");
      expect(predict()).toBeUndefined();
      state().closeRecord();
      expect(shownId()).toBeUndefined();
    });
  }

  it("predicts ordinary departure in stack order, ignoring unread-list order and stale ids", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    state().applyCards([a, b]);
    state().applyCards([a, b, c]);
    useShellStore.setState({ unreadCardIds: ["stale", "c", "b"] });
    const stack = visibleStack(state().cards);
    expect(dismissalSuccessor(stack, 0, state().unreadCardIds)?.id).toBe("b");
    state().applyCards([b, c]);
    expect(shownId()).toBe("b");
  });

  // INF-770 direction A: the reply opens the thread beside the card and
  // moves nothing; the pager and what is unread stay as they were.
  it("keeps a paged-to card shown with its thread when it is replied under", async () => {
    const a = ready("a", { actions: DECIDE, author: "crewmate", taskId: "t1" });
    const b = ready("b", { actions: DECIDE, author: "crewmate", taskId: "t2" });
    const c = ready("c", { actions: DECIDE, author: "crewmate", taskId: "t3" });
    state().applyCards([a, b]);
    state().focusCard("b");
    state().applyCards([a, b, c]);
    expect(state().unreadCardIds).toEqual(["c"]);
    const sent = [{ id: 1, cardId: "b", who: "captain" as const, text: "why", at: 1 }];
    const reply = vi.fn(async () => ({ cardId: "b", messages: sent }));
    vi.stubGlobal("window", { infinitary: { cards: { reply }, firstRun: undefined } });
    try {
      state().setReplyDraft("b", "why");
      await state().sendReply("b");
      expect(shownId()).toBe("b");
      expect(state().threads.b).toEqual(sent);
      expect(state().unreadCardIds).toEqual(["c"]);
      state().applyCards([a, { ...b, awaiting: "answer", sentBackAt: 10 }, c]);
      expect(shownId()).toBe("b");
      expect(visibleStack(state().cards)).toHaveLength(3);
      state().nextCard();
      expect(shownId()).toBe("c");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves a lone card where it is when it is replied under", () => {
    const a = ready("a", { actions: DECIDE });
    state().applyCards([a]);
    state().applyCards([{ ...a, awaiting: "answer", sentBackAt: 10 }]);
    expect(shownId()).toBe("a");
    expect(state().cardIndex).toBe(0);
    expect(visibleCards(state().cards)).toHaveLength(1);
    const reconciled = reconcileStack(
      state(),
      [{ ...a, awaiting: "answer", sentBackAt: 11 }],
      Date.now(),
    );
    expect(reconciled.lostCard).toBe(false);
    expect(reconciled.state.cardIndex).toBe(0);
  });

  it("marks a card unread when its author answers, unless it is the shown one", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    state().applyCards([a, b]);
    state().applyCards([b, { ...a, awaiting: "answer" }]);
    takeCharacterNotice();
    // Its author answered and closed out: its original place, now new.
    state().applyCards([a, b]);
    expect(shownId()).toBe("b");
    expect(unread()).toEqual({ before: 1, after: 0 });
    expect(takeCharacterNotice()).toBe(true);

    // A lone card the captain is looking at is not marked.
    reset();
    state().applyCards([a]);
    state().applyCards([{ ...a, awaiting: "answer", sentBackAt: 10 }]);
    state().applyCards([a]);
    expect(state().unreadCardIds).toEqual([]);
  });

  it("never collapses a note that waits on its author", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const shown = ready("shown", { taskId: "t1" });
    const note = ready("note", { taskId: "t1" });
    state().applyCards([shown, note]);
    state().nextCard();
    state().nextCard();
    state().prevCard();
    state().applyCards([shown, { ...note, awaiting: "answer", sentBackAt: 10 }]);
    state().collapseStaleNotes(T0 + NOTE_COLLAPSE_MS + 1);
    expect(state().collapsedCardIds).toEqual([]);
    state().applyCards([shown, { ...note, sentBackAt: 10 }]);
    state().nextCard();
    state().prevCard();
    state().collapseStaleNotes(T0 + NOTE_COLLAPSE_MS + 1);
    expect(state().collapsedCardIds).toEqual(["note"]);
  });

  it("treats the boot stack as already seen", () => {
    takeCharacterNotice();
    state().applyCards([ready("a"), ready("b")]);
    expect(state().unreadCardIds).toEqual([]);
    expect(takeCharacterNotice()).toBe(false);
  });

  it("marks a card landing behind the shown one unread, keeps the shown card, and pulses once", () => {
    const a = ready("a");
    state().applyCards([a]);
    takeCharacterNotice();
    state().applyCards([a, ready("b", { actions: DECIDE })]);
    expect(shownId()).toBe("a");
    expect(state().unreadCardIds).toEqual(["b"]);
    expect(unread()).toEqual({ before: 0, after: 1 });
    expect(takeCharacterNotice()).toBe(true);
    // A later push of the same stack (a streaming body, a reorder) is not news.
    state().applyCards([a, ready("b", { actions: DECIDE, body: "more" })]);
    expect(takeCharacterNotice()).toBe(false);
    expect(state().unreadCardIds).toEqual(["b"]);
    // Paging to it clears the badge.
    state().nextCard();
    expect(shownId()).toBe("b");
    expect(state().unreadCardIds).toEqual([]);
  });

  it("marks a higher-priority card inserted in front unread too, cleared by paging back", () => {
    const a = ready("a");
    state().applyCards([a]);
    state().applyCards([ready("urgent", { actions: DECIDE }), a]);
    expect(shownId()).toBe("a");
    expect(unread()).toEqual({ before: 1, after: 0 });
    state().prevCard();
    expect(shownId()).toBe("urgent");
    expect(unread()).toEqual({ before: 0, after: 0 });
  });

  it("does not mark the card that fills an empty stage, and forgets a card that leaves", () => {
    state().applyCards([]);
    takeCharacterNotice();
    state().applyCards([ready("a"), ready("b")]);
    expect(shownId()).toBe("a");
    expect(state().unreadCardIds).toEqual(["b"]);
    state().applyCards([ready("a")]);
    expect(state().unreadCardIds).toEqual([]);
  });

  it("clears a card brought to the front from the now panel, or paged to", () => {
    const a = ready("a");
    state().applyCards([a]);
    state().applyCards([a, ready("b"), ready("c")]);
    expect(state().focusCard("c")).toBe(true);
    expect(state().unreadCardIds).toEqual(["b"]);
    state().openRecord("t1");
    state().nextCard();
    state().nextCard();
    expect(shownId()).toBe("b");
    expect(state().unreadCardIds).toEqual([]);
  });

  it("collapses a seen, aged note on a task into its record and keeps everything else", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const shown = ready("shown", { taskId: "t1" });
    const agedNote = ready("aged", { taskId: "t1" });
    const orphan = ready("orphan");
    const decision = ready("decision", { actions: DECIDE, taskId: "t1" });
    state().applyCards([shown, agedNote, orphan, decision]);
    const before = state().focusRequest;
    state().collapseStaleNotes(T0 + NOTE_COLLAPSE_MS - 1);
    expect(state().collapsedCardIds).toEqual([]);
    state().collapseStaleNotes(T0 + NOTE_COLLAPSE_MS);
    // The shown note stays while it is shown; a note with no task has no
    // record to go to; a decision never collapses.
    expect(state().collapsedCardIds).toEqual(["aged"]);
    expect(shownId()).toBe("shown");
    expect(visibleCards(state().cards, state().collapsedCardIds)).toHaveLength(3);
    expect(state().focusRequest).toBe(before);
    // Pointing at it brings it back.
    expect(state().focusCard("aged")).toBe(true);
    expect(shownId()).toBe("aged");
    expect(state().collapsedCardIds).toEqual([]);
  });

  it("brings a collapsed note back unread when it is revised in place, and only then (M1)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const a = ready("a", { taskId: "t1" });
    const b = ready("b", { actions: DECIDE, taskId: "t1" });
    state().applyCards([a, b]);
    state().nextCard();
    expect(shownId()).toBe("b");
    state().collapseStaleNotes(T0 + NOTE_COLLAPSE_MS + 60_000);
    expect(state().collapsedCardIds).toEqual(["a"]);
    takeCharacterNotice();

    // A push that changes nothing about A leaves it collapsed and quiet.
    vi.setSystemTime(T0 + NOTE_COLLAPSE_MS + 2 * 60_000);
    state().applyCards([{ ...a, status: "streaming" }, b]);
    state().applyCards([a, b]);
    expect(state().collapsedCardIds).toEqual(["a"]);
    expect(state().unreadCardIds).toEqual([]);
    expect(takeCharacterNotice()).toBe(false);

    // The emitter revises A under the same id: it is news again.
    state().applyCards([{ ...a, body: "a, revised" }, b]);
    expect(state().collapsedCardIds).toEqual([]);
    expect(visibleCards(state().cards, state().collapsedCardIds)).toHaveLength(2);
    expect(shownId()).toBe("b");
    expect(state().unreadCardIds).toEqual(["a"]);
    expect(unread()).toEqual({ before: 1, after: 0 });
    expect(takeCharacterNotice()).toBe(true);

    // Unread, it does not collapse again; seen and aged, it does.
    state().collapseStaleNotes(T0 + NOTE_COLLAPSE_MS * 3);
    expect(state().collapsedCardIds).toEqual([]);
    state().prevCard();
    state().nextCard();
    state().collapseStaleNotes(T0 + NOTE_COLLAPSE_MS * 3);
    expect(state().collapsedCardIds).toEqual(["a"]);
    // A new title or a new action set counts as a change too.
    state().applyCards([{ ...a, body: "a, revised", title: "A, retitled" }, b]);
    expect(state().unreadCardIds).toEqual(["a"]);
  });

  it("never collapses a note that is still unread", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + NOTE_COLLAPSE_MS * 2);
    const a = ready("a");
    state().applyCards([a]);
    state().applyCards([a, ready("late", { taskId: "t1" })]);
    expect(state().unreadCardIds).toEqual(["late"]);
    state().collapseStaleNotes(T0 + NOTE_COLLAPSE_MS * 3);
    expect(state().collapsedCardIds).toEqual([]);
    state().nextCard();
    state().prevCard();
    state().collapseStaleNotes(T0 + NOTE_COLLAPSE_MS * 3);
    expect(state().collapsedCardIds).toEqual(["late"]);
    expect(shownId()).toBe("a");
  });
});

describe("task records on the card stack", () => {
  beforeEach(() =>
    useShellStore.setState({
      cards: [],
      records: [],
      cardIndex: 0,
      recording: false,
      firstmateBusy: false,
      collapsedCardIds: [],
      unreadCardIds: [],
      collapsedDigests: {},
      cardsSeeded: true,
    }),
  );
  afterEach(() => useShellStore.setState({ records: [], cards: [], cardIndex: 0 }));
  it("opens front entries, one per task, and pages with cards", () => {
    const shell = () => useShellStore.getState();
    shell().applyCards([card({ id: "decision", status: "ready", actions: DECIDE })]);
    shell().openRecord("t1");
    shell().openRecord("t2");
    shell().openRecord("t1");
    expect(shell().records).toEqual([{ taskId: "t1" }, { taskId: "t2" }]);
    expect(shell().phase).toBe("working");
    expect(shownCard(shell().cards, shell().cardIndex, [], shell().records)?.recordTaskId).toBe(
      "t1",
    );
    shell().nextCard();
    expect(shownCard(shell().cards, shell().cardIndex, [], shell().records)?.recordTaskId).toBe(
      "t2",
    );
    shell().nextCard();
    expect(shownCard(shell().cards, shell().cardIndex, [], shell().records)?.id).toBe("decision");
    shell().closeRecord();
    expect(shell().records).toHaveLength(2);
    shell().prevCard();
    shell().closeRecord();
    expect(shell().records).toEqual([{ taskId: "t1" }]);
    expect(shell().cardIndex).toBe(1);
  });
  it("keeps a record shown while arrivals wait unread behind it", () => {
    const shell = () => useShellStore.getState();
    shell().openRecord("t1");
    shell().applyCards([card({ id: "arrival", status: "ready", actions: DECIDE })]);
    expect(shell().cardIndex).toBe(0);
    expect(shell().unreadCardIds).toEqual(["arrival"]);
    shell().closeRecord();
    expect(shell().unreadCardIds).toEqual([]);
    expect(shell().cardIndex).toBe(0);
  });
  it("returns input focus only when the final entry closes", () => {
    const shell = () => useShellStore.getState();
    shell().openRecord("t1");
    shell().openRecord("t2");
    const before = shell().focusRequest;
    shell().closeRecord();
    expect(shell().focusRequest).toBe(before);
    shell().closeRecord();
    expect(shell().focusRequest).toBe(before + 1);
    expect(shell().phase).toBe("idle");
    shell().closeRecord();
    expect(shell().focusRequest).toBe(before + 1);
  });
  it("closes one task's record by task and keeps whatever is shown on screen", () => {
    const shell = () => useShellStore.getState();
    const shownId = () =>
      shownCard(shell().cards, shell().cardIndex, [], shell().records)?.id ?? null;
    shell().applyCards([card({ id: "decision", status: "ready", actions: DECIDE })]);
    shell().openRecord("t2");
    shell().openRecord("t1");
    shell().nextCard();
    expect(shownId()).toBe("record:t2");
    // A record in front of the shown one goes; the shown record stays shown.
    shell().closeTaskRecord("t1");
    expect(shell().records).toEqual([{ taskId: "t2" }]);
    expect(shownId()).toBe("record:t2");
    // The shown record goes the way Hide takes it: the next entry comes up.
    shell().closeTaskRecord("t2");
    expect(shell().records).toEqual([]);
    expect(shownId()).toBe("decision");
    // A task with no open record changes nothing.
    const before = { cardIndex: shell().cardIndex, focusRequest: shell().focusRequest };
    shell().closeTaskRecord("t3");
    expect(shownId()).toBe("decision");
    expect({ cardIndex: shell().cardIndex, focusRequest: shell().focusRequest }).toEqual(before);
  });
});

describe("past cards on the card stack", () => {
  const shell = () => useShellStore.getState();
  const shown = () => shownCard(shell().cards, shell().cardIndex, [], shell().records);
  beforeEach(() =>
    useShellStore.setState({
      cards: [],
      records: [],
      cardIndex: 0,
      recording: false,
      firstmateBusy: false,
      collapsedCardIds: [],
      unreadCardIds: [],
      collapsedDigests: {},
      cardsSeeded: true,
    }),
  );
  afterEach(() => {
    vi.unstubAllGlobals();
    useShellStore.setState({ records: [], cards: [], cardIndex: 0, inputText: "" });
  });

  it("opens one front entry per saved card beside task records, and Hide takes only that entry", () => {
    shell().applyCards([card({ id: "decision", status: "ready", actions: DECIDE })]);
    shell().openRecord("t1");
    shell().openPastCard("old-plan");
    shell().openPastCard("older-note");
    shell().openPastCard("old-plan");
    expect(shell().records).toEqual([
      { pastCardId: "old-plan" },
      { pastCardId: "older-note" },
      { taskId: "t1" },
    ]);
    expect(shown()?.pastCardId).toBe("old-plan");
    expect(shell().phase).toBe("working");
    shell().closeRecord();
    expect(shell().records).toEqual([{ pastCardId: "older-note" }, { taskId: "t1" }]);
    // The shown entry left, so the first card comes up, as it does for a record.
    expect(shown()?.id).toBe("decision");
    // Opening a record puts it at the front without touching the past card.
    shell().openRecord("t1");
    expect(shown()?.recordTaskId).toBe("t1");
    expect(shell().records).toContainEqual({ pastCardId: "older-note" });
    shell().closePastCard("older-note");
    shell().closeRecord();
    expect(shown()?.id).toBe("decision");
    // The stack of real cards is untouched by any of it.
    expect(shell().cards.map((c) => c.id)).toEqual(["decision"]);
  });

  it("opens the past card when the core says it was shown, leaving live cards and focus alone", () => {
    shell().applyCards([card({ id: "decision", status: "ready", actions: DECIDE })]);
    shell().applyEvent({ type: "past_card_shown", cardId: "old-plan" });
    expect(shown()?.pastCardId).toBe("old-plan");
    expect(shell().cards.map((c) => c.id)).toEqual(["decision"]);
    // The same card shown again is the same single entry; another event type does nothing.
    shell().applyEvent({ type: "past_card_shown", cardId: "old-plan" });
    shell().applyEvent({ type: "personalized", text: "x" });
    expect(shell().records).toEqual([{ pastCardId: "old-plan" }]);
    shell().closeRecord();
    expect(shown()?.id).toBe("decision");
  });

  it("supplies the turn hint while shown: only its card id, never a task or a visible card", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({
      cards: [card({ id: "card-fm-1", status: "ready", title: "Quota", body: "ok" })],
      records: [{ pastCardId: "old-plan" }, { taskId: "t1" }],
      cardIndex: 0,
      inputText: "build this plan again",
    });
    useShellStore.getState().submit();
    await Promise.resolve();
    expect(send).toHaveBeenLastCalledWith({
      text: "build this plan again",
      images: undefined,
      visibleCardId: undefined,
      taskId: undefined,
      pastCardId: "old-plan",
    });
    // Hidden, it supplies nothing.
    shell().closeRecord();
    shell().closeRecord();
    shell().setInputText("and now?");
    shell().submit();
    expect(send).toHaveBeenLastCalledWith({
      text: "and now?",
      images: undefined,
      visibleCardId: "card-fm-1",
      taskId: undefined,
      pastCardId: undefined,
    });
  });
});

describe("a task's browser view on the card stack (docs/task-browser.md)", () => {
  const shell = () => useShellStore.getState();
  const shown = () => shownCard(shell().cards, shell().cardIndex, [], shell().records);
  beforeEach(() =>
    useShellStore.setState({
      cards: [],
      records: [],
      cardIndex: 0,
      recording: false,
      firstmateBusy: false,
      collapsedCardIds: [],
      unreadCardIds: [],
      collapsedDigests: {},
      cardsSeeded: true,
    }),
  );
  afterEach(() => {
    vi.unstubAllGlobals();
    useShellStore.setState({ records: [], cards: [], cardIndex: 0, inputText: "" });
  });

  it("is the task card's Browser tab: it replaces the record, one entry per task, at the stage's full width", () => {
    shell().openRecord("t1");
    shell().openBrowserView("t1");
    shell().openBrowserView("t1");
    expect(shell().records).toEqual([{ browserTaskId: "t1" }]);
    expect(shown()).toMatchObject({ id: "browser:t1", browserTaskId: "t1", width: "full" });
    expect(isHeldEntry(shown())).toBe(true);
    // The Info tab brings the record back in its place.
    shell().openRecord("t1");
    expect(shell().records).toEqual([{ taskId: "t1" }]);
    expect(shown()?.recordTaskId).toBe("t1");
    // Hide or Esc closes the task's card whichever tab is shown.
    shell().closeRecord();
    expect(shell().records).toEqual([]);
  });

  it("is the task card's Crewmate tab too: it replaces the record and the browser view, at the stage's full width", () => {
    shell().openBrowserView("t1");
    shell().openCrewmateView("t1");
    shell().openCrewmateView("t1");
    expect(shell().records).toEqual([{ crewmateTaskId: "t1" }]);
    expect(shown()).toMatchObject({ id: "crewmate:t1", crewmateTaskId: "t1", width: "full" });
    expect(isHeldEntry(shown())).toBe(true);
    shell().openRecord("t1");
    expect(shell().records).toEqual([{ taskId: "t1" }]);
    shell().openCrewmateView("t1");
    shell().openBrowserView("t1");
    expect(shell().records).toEqual([{ browserTaskId: "t1" }]);
    shell().openCrewmateView("t1");
    shell().closeRecord();
    expect(shell().records).toEqual([]);
  });

  it("points the turn at its task while shown, as the record does", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    shell().openBrowserView("t2");
    shell().setInputText("how is the check going?");
    shell().submit();
    await Promise.resolve();
    expect(send).toHaveBeenLastCalledWith({
      text: "how is the check going?",
      images: undefined,
      visibleCardId: undefined,
      taskId: "t2",
      pastCardId: undefined,
    });
  });

  it("opens from a card's live attachment with the card unanswered behind it, and Hide returns to it", () => {
    const act = vi.fn();
    vi.stubGlobal("window", { infinitary: { cards: { act } } });
    const first = card({ id: "first", status: "ready", actions: DECIDE, title: "First" });
    const tryIt = card({
      id: "try",
      status: "ready",
      actions: DECIDE,
      title: "Try the page",
      taskId: "t1",
      attachment: {
        kind: "browser",
        label: "Try it",
        taskId: "t1",
        session: "run-1",
        generation: 2,
      },
    });
    useShellStore.setState({ cards: [first, tryIt], cardIndex: 1 });
    expect(shown()?.id).toBe("try");
    const from = { cardId: "try", session: "run-1", generation: 2 };
    shell().openBrowserView("t1", from);
    expect(shown()).toMatchObject({ id: "browser:t1", browserTaskId: "t1", browserFrom: from });
    // Opening asked the core nothing: the card is still there, unanswered.
    expect(act).not.toHaveBeenCalled();
    expect(shell().cards.map((c) => c.id)).toEqual(["first", "try"]);
    // Hide comes back to the card that opened it, not the stack's first.
    shell().closeRecord();
    expect(shown()?.id).toBe("try");
    // From the record, the view names no card and Hide reveals as any record does.
    shell().openBrowserView("t1", from);
    shell().openBrowserView("t1");
    expect(shell().records).toEqual([{ browserTaskId: "t1" }]);
    shell().closeRecord();
    expect(shown()?.id).toBe("first");
  });

  it("opens a task's record from its card, and Hide returns to that card from any of its tabs (INF-358)", () => {
    const first = card({ id: "first", status: "ready", actions: DECIDE, title: "First" });
    const about = card({ id: "about", status: "ready", actions: DECIDE, taskId: "t1" });
    useShellStore.setState({ cards: [first, about], cardIndex: 1 });
    // The key in the card's head, or Show Info on it: the record in front, from the card.
    shell().openRecord("t1", { cardId: "about" });
    expect(shown()?.recordTaskId).toBe("t1");
    expect(shell().records).toEqual([{ taskId: "t1", from: { cardId: "about" } }]);
    expect(taskEntryFrom(shell(), "t1")).toEqual({ cardId: "about" });
    expect(taskEntryFrom(shell(), "t2")).toBeUndefined();
    shell().closeRecord();
    expect(shown()?.id).toBe("about");
    // The task's next tab keeps the card it came from (`goToTab` hands it on).
    shell().openCrewmateView("t1", { cardId: "about" });
    expect(shown()?.crewmateTaskId).toBe("t1");
    shell().openBrowserView("t1", taskEntryFrom(shell(), "t1"));
    expect(shown()).toMatchObject({ browserTaskId: "t1", browserFrom: { cardId: "about" } });
    shell().closeRecord();
    expect(shown()?.id).toBe("about");
    // Opened from a Tasks row, the record names no card and Hide reveals as any record does.
    shell().openRecord("t1");
    expect(shell().records).toEqual([{ taskId: "t1" }]);
    shell().closeRecord();
    expect(shown()?.id).toBe("first");
    // The card gone meanwhile: Hide falls back to the stack's first card.
    shell().openRecord("t1", { cardId: "about" });
    useShellStore.setState({ cards: [first] });
    shell().closeRecord();
    expect(shown()?.id).toBe("first");
  });

  it("starts the captain's words with Report a problem's, keeping what was typed after them", () => {
    shell().setInputText("the page is blank");
    shell().beginDraft("This task's browser has a problem: ");
    expect(shell().inputText).toBe("This task's browser has a problem: the page is blank");
    expect(shell().inputCaret).toBe("This task's browser has a problem: ".length);
    shell().beginDraft("This task's browser has a problem: ");
    expect(shell().inputText).toBe("This task's browser has a problem: the page is blank");
  });

  it("lets a second starter's words take the place of the first's, keeping what was typed after them", () => {
    shell().setInputText("");
    shell().beginDraft("Clone the project at ");
    expect(shell().inputText).toBe("Clone the project at ");
    shell().setInputText("Clone the project at github.com/octo/app");
    shell().beginDraft("Start a new project called ");
    expect(shell().inputText).toBe("Start a new project called github.com/octo/app");
    expect(shell().inputCaret).toBe("Start a new project called ".length);
    // Words the captain changed at the head are his: the next draft goes in front of them.
    shell().setInputText("A new project called meterlab");
    shell().beginDraft("Work in the folder ");
    expect(shell().inputText).toBe("Work in the folder A new project called meterlab");
  });
});

describe("card action receipts", () => {
  const ready = card({ id: "choice", status: "ready", actions: DECIDE, body: "Choose." });
  function request() {
    const replies: {
      resolve: (value: { effect?: ShellEffect; refusal?: string }) => void;
      reject: (error: Error) => void;
    }[] = [];
    const act = vi.fn(
      () =>
        new Promise<{ effect?: ShellEffect; refusal?: string }>((resolve, reject) => {
          replies.push({ resolve, reject });
        }),
    );
    vi.stubGlobal("window", { infinitary: { cards: { act } } });
    useShellStore.setState({ cards: [ready], cardIndex: 0, records: [] });
    return {
      act,
      replies,
      resolve: (value: { effect?: ShellEffect; refusal?: string } = {}) =>
        replies.at(-1)?.resolve(value),
      reject: (error: Error) => replies.at(-1)?.reject(error),
    };
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    useShellStore.setState({
      cards: [],
      pendingCardActions: {},
      cardActionErrors: {},
      view: "home",
      settingsSection: null,
      pendingRestoreAccountId: null,
      pendingForgeSignIn: null,
      pendingDeviceArrival: null,
      thisMac: null,
    });
  });

  it("sets pending before IPC, deduplicates same and sibling actions, and clears on acceptance", async () => {
    const ipc = request();
    const send = ipc.act.getMockImplementation();
    if (!send) throw new Error("Missing controlled IPC implementation.");
    ipc.act.mockImplementationOnce(() => {
      expect(useShellStore.getState().pendingCardActions.choice).toEqual({ actionId: "land" });
      return send();
    });
    const first = useShellStore.getState().actOnCard("choice", "land");
    expect(useShellStore.getState().pendingCardActions.choice).toEqual({ actionId: "land" });
    await useShellStore.getState().actOnCard("choice", "land");
    await useShellStore.getState().actOnCard("choice", "discard");
    expect(ipc.act).toHaveBeenCalledTimes(1);
    expect(ipc.act).toHaveBeenCalledWith("choice", "land", "chrome", undefined, gesture());
    // A push that still contains this card never resets its pending guard.
    useShellStore.getState().applyCards([ready]);
    expect(useShellStore.getState().pendingCardActions.choice).toBeDefined();
    ipc.resolve();
    await first;
    expect(useShellStore.getState().pendingCardActions).toEqual({});
    expect(useShellStore.getState().cards).toEqual([]);
    await useShellStore.getState().actOnCard("choice", "land");
    expect(ipc.act).toHaveBeenCalledTimes(1);
  });

  it("retains an open card on a typed refusal without accepting it or applying an effect", async () => {
    const ipc = request();
    const sent = useShellStore.getState().actOnCard("choice", "land");
    ipc.resolve({
      refusal: "The choice is unavailable.",
      effect: { kind: "open", target: "settings" },
    });
    await sent;
    expect(useShellStore.getState()).toMatchObject({
      cards: [ready],
      pendingCardActions: {},
      view: "home",
      cardActionErrors: { choice: "The choice is unavailable." },
    });
  });

  // INF-1007 direction A: every forge host sign-in lives in Integrations;
  // older cards still naming Projects retain the host to start on arrival.
  it("routes every forge host sign-in card into Integrations and starts that host's sign-in", async () => {
    for (const host of [
      "github.com",
      "gitlab.com",
      "gitlab.example.com",
      "github.example.com",
      "gitlab:code.example.com",
      "github-enterprise:code.example.com",
    ]) {
      const ipc = request();
      const sent = useShellStore.getState().actOnCard("choice", "sign-in");
      ipc.resolve({ effect: { kind: "open", target: "projects", signIn: host } });
      await sent;
      expect(useShellStore.getState()).toMatchObject({
        view: "settings",
        settingsSection: "integrations",
        pendingForgeSignIn: host,
      });
    }
  });

  it("routes a connect or remove card into Devices with what to do on arrival", async () => {
    for (const [effect, arrival] of [
      [{ kind: "open", target: "devices", make: "link" }, { make: "link" }],
      [{ kind: "open", target: "devices", remove: "mac-1" }, { remove: "mac-1" }],
    ] as const) {
      const ipc = request();
      const sent = useShellStore.getState().actOnCard("choice", "open");
      ipc.resolve({ effect });
      await sent;
      expect(useShellStore.getState()).toMatchObject({
        view: "settings",
        settingsSection: "devices",
        pendingDeviceArrival: arrival,
      });
      useShellStore.setState({ pendingDeviceArrival: null, settingsSection: null, view: "home" });
    }
  });

  it("on a Mac controlling another, sends no click that opens Settings there and says where to do it (docs/view.md)", async () => {
    const ipc = request();
    // The pause card, as the host builds it: move Firstmate, or sign in again.
    const paused = card({
      id: "paused",
      author: "host",
      status: "ready",
      body: "Codex needs you to sign in again.",
      actions: [
        {
          id: "move-flagship",
          label: "Move to Grok",
          effect: { kind: "host", op: "move-flagship", arg: "xai" },
        },
        {
          id: "sign-in",
          label: "Sign in",
          effect: { kind: "host", op: "restore-account", arg: "acct_codex" },
        },
      ],
    });
    const link = card({
      id: "link",
      status: "ready",
      body: "Make a link here.",
      actions: [
        {
          id: "open",
          label: "Make a link",
          default: true,
          effect: { kind: "open", target: "devices", make: "link" },
        },
        { id: "not-now", label: "Not now" },
      ],
    });
    useShellStore.setState({
      cards: [paused, link],
      thisMac: {
        role: "view",
        name: "MacBook Pro",
        address: "192.168.1.20",
        joinedAt: 0,
        contact: "in-reach",
        readOnly: null,
        heardAt: 0,
        caughtUp: 0,
      },
    });
    await useShellStore.getState().actOnCard("paused", "sign-in");
    await useShellStore.getState().actOnCard("link", "open");
    expect(ipc.act).not.toHaveBeenCalled();
    const there = "Do this on MacBook Pro. Its settings and sign-ins stay there.";
    expect(useShellStore.getState()).toMatchObject({
      cards: [paused, link],
      pendingCardActions: {},
      cardActionErrors: { paused: there, link: there },
      view: "home",
      settingsSection: null,
      pendingRestoreAccountId: null,
      pendingDeviceArrival: null,
    });
    // The card's other button is that Mac's to answer, and is sent.
    const moved = useShellStore.getState().actOnCard("paused", "move-flagship");
    expect(ipc.act).toHaveBeenCalledWith("paused", "move-flagship", "chrome", undefined, gesture());
    ipc.resolve();
    await moved;
    expect(useShellStore.getState().cards).toEqual([link]);
    // On the Mac where Firstmate lives the same click is sent and opens Settings.
    useShellStore.setState({ thisMac: { role: "home", left: null } });
    const opened = useShellStore.getState().actOnCard("link", "open");
    expect(ipc.act).toHaveBeenLastCalledWith("link", "open", "chrome", undefined, gesture());
    ipc.resolve({ effect: { kind: "open", target: "devices", make: "link" } });
    await opened;
    expect(useShellStore.getState()).toMatchObject({
      view: "settings",
      settingsSection: "devices",
      pendingDeviceArrival: { make: "link" },
    });
  });

  it("on a Mac controlling another, sends no take-over of a task's browser and says where to do it, while a saved sign-in is sent and opens nothing here (docs/view.md)", async () => {
    const ipc = request();
    // A crewmate's request, as the host offers it once a sign-in is saved for its site.
    const asked = card({
      id: "asked",
      taskId: "t1",
      status: "ready",
      body: "The club page needs your sign-in.",
      actions: [
        { id: "leave", label: "Leave waiting" },
        { id: "own", label: "Sign in myself", effect: { kind: "open", target: "browser" } },
        {
          id: "saved",
          label: "Use my saved club.example sign-in",
          default: true,
          effect: { kind: "open", target: "browser", savedSignIn: true },
        },
      ],
    });
    useShellStore.setState({
      cards: [asked],
      thisMac: {
        role: "view",
        name: "MacBook Pro",
        address: "192.168.1.20",
        joinedAt: 0,
        contact: "in-reach",
        readOnly: null,
        heardAt: 0,
        caughtUp: 0,
      },
    });
    const own = useShellStore.getState().actOnCard("asked", "own");
    expect(ipc.act).not.toHaveBeenCalled();
    await own;
    expect(useShellStore.getState()).toMatchObject({
      cards: [asked],
      pendingCardActions: {},
      cardActionErrors: {
        asked: "Do this on MacBook Pro. This task's browser shows only there.",
      },
      records: [],
    });
    // The saved sign-in needs no one at the page: that Mac answers it.
    const granted = useShellStore.getState().actOnCard("asked", "saved");
    expect(ipc.act).toHaveBeenCalledWith("asked", "saved", "chrome", undefined, gesture());
    ipc.resolve({
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId: "t1", session: "run-1", generation: 2, cardId: "asked" },
      },
    });
    await granted;
    expect(useShellStore.getState()).toMatchObject({ cards: [], records: [], view: "home" });
  });

  it('opens a request card\'s task browser view on the stage, never Settings (docs/task-browser.md, "Asking for help")', async () => {
    const ipc = request();
    const sent = useShellStore.getState().actOnCard("choice", "sign-in");
    ipc.resolve({
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId: "t1", session: "run-1", generation: 2, cardId: "choice" },
      },
    });
    await sent;
    expect(useShellStore.getState()).toMatchObject({
      view: "home",
      settingsSection: null,
      records: [
        { browserTaskId: "t1", from: { cardId: "choice", session: "run-1", generation: 2 } },
      ],
      cardIndex: 0,
    });
    useShellStore.setState({ records: [] });
  });

  it("keeps an unaccepted card with an honest error and enables a fresh attempt", async () => {
    const ipc = request();
    const first = useShellStore.getState().actOnCard("choice", "land");
    ipc.reject(new Error("The host did not accept the action."));
    await first;
    expect(useShellStore.getState()).toMatchObject({
      cards: [ready],
      pendingCardActions: {},
      cardActionErrors: { choice: "The host did not accept the action." },
    });
    const retry = useShellStore.getState().actOnCard("choice", "land");
    expect(useShellStore.getState().cardActionErrors).toEqual({});
    ipc.resolve();
    await retry;
    expect(ipc.act).toHaveBeenCalledTimes(2);
    expect(useShellStore.getState().cards).toEqual([]);
  });

  it("forwards an explicit settings snapshot unchanged and closes its card", async () => {
    const ipc = request();
    useShellStore.setState({
      cards: [
        {
          ...ready,
          actions: [{ id: "use-settings", label: "Use these settings" }],
        },
      ],
    });
    const value = { planes: [{ name: "inner", speed: 0.5, tiltDeg: 42 }], paused: false };
    const sent = useShellStore.getState().actOnCard("choice", "use-settings", "frame", value);
    expect(ipc.act).toHaveBeenCalledWith("choice", "use-settings", "frame", value, gesture());
    ipc.resolve();
    await sent;
    expect(useShellStore.getState().cards).toHaveLength(0);
  });

  describe("the body's answers ride a footer click (contract 4.22)", () => {
    const withAnswers = card({
      id: "choice",
      status: "ready",
      body: "Choose.",
      actions: [
        { id: "try", label: "Try these" },
        { id: "go", label: "Go", default: true },
      ],
    });
    const speed = { name: "speed", values: ["fast"], labels: ["Fast"], changed: true };
    const scope = { name: "scope", values: [], changed: false };
    const answered = { answered: 2, of: 2, changed: 1, picked: 1, answers: [speed, scope] };
    const partial = { answered: 1, of: 2, changed: 1, picked: 1, answers: [speed, scope] };
    afterEach(() => useShellStore.setState({ cardAnswers: {} }));

    it("sends the frame's fresh reading with the choice", async () => {
      const ipc = request();
      useShellStore.setState({ cards: [withAnswers], cardAnswers: { choice: partial } });
      const sent = useShellStore
        .getState()
        .actOnCard("choice", "go", "chrome", undefined, async () => answered);
      // The guard is up while the frame is read, so a second click waits.
      expect(useShellStore.getState().pendingCardActions.choice).toEqual({ actionId: "go" });
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      expect(ipc.act).toHaveBeenCalledWith(
        "choice",
        "go",
        "chrome",
        { answers: [speed, scope] },
        gesture({ reading: "fresh" }),
      );
      ipc.resolve();
      await sent;
    });

    it("falls back on the last reading when the frame gives none", async () => {
      const ipc = request();
      useShellStore.setState({ cards: [withAnswers], cardAnswers: { choice: answered } });
      const sent = useShellStore
        .getState()
        .actOnCard("choice", "go", "chrome", undefined, async () => undefined);
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      // The record says the answers were the last draft, not the frame's own.
      expect(ipc.act).toHaveBeenCalledWith(
        "choice",
        "go",
        "chrome",
        { answers: [speed, scope] },
        gesture({ reading: "fallback", questionsGap: "no-fresh-reading" }),
      );
      ipc.resolve();
      await sent;
    });

    it("sends nothing extra from a body with no questions", async () => {
      const ipc = request();
      useShellStore.setState({ cards: [withAnswers] });
      const empty = { answered: 0, of: 0, changed: 0, picked: 0, answers: [] };
      const sent = useShellStore
        .getState()
        .actOnCard("choice", "go", "chrome", undefined, async () => empty);
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      expect(ipc.act).toHaveBeenCalledWith("choice", "go", "chrome", undefined, gesture());
      ipc.resolve();
      await sent;
    });

    it("a non-default closing choice sends partial picks", async () => {
      const ipc = request();
      const deferrable = {
        ...withAnswers,
        actions: [...withAnswers.actions, { id: "defer", label: "Not now" }],
      };
      useShellStore.setState({ cards: [deferrable] });
      const sent = useShellStore
        .getState()
        .actOnCard("choice", "defer", "chrome", undefined, async () => partial);
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      expect(ipc.act).toHaveBeenCalledWith(
        "choice",
        "defer",
        "chrome",
        { answers: [speed, scope] },
        gesture(),
      );
      ipc.resolve();
      await sent;
      expect(useShellStore.getState().cards).toEqual([]);
    });

    it("holds the default choice until required questions are answered; another sends what there is", async () => {
      const ipc = request();
      useShellStore.setState({ cards: [withAnswers] });
      await useShellStore
        .getState()
        .actOnCard("choice", "go", "chrome", undefined, async () => partial);
      expect(ipc.act).not.toHaveBeenCalled();
      expect(useShellStore.getState()).toMatchObject({
        cards: [withAnswers],
        pendingCardActions: {},
        cardActionErrors: { choice: "Answer every question the card asks first." },
      });

      const sent = useShellStore
        .getState()
        .actOnCard("choice", "try", "chrome", undefined, async () => partial);
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      expect(ipc.act).toHaveBeenCalledWith(
        "choice",
        "try",
        "chrome",
        { answers: [speed, scope] },
        gesture(),
      );
      ipc.resolve();
      await sent;
      expect(useShellStore.getState().cards).toEqual([]);
    });

    it("refuses answers past the value bound with an honest error", async () => {
      const ipc = request();
      useShellStore.setState({ cards: [withAnswers] });
      // One value cannot pass the per-value cap and still exceed the set bound.
      const over = Array.from({ length: 5 }, (_, index) => ({
        name: `notes-${index}`,
        values: ["x".repeat(CARD_ANSWER_TEXT_MAX)],
        changed: true,
      }));
      await useShellStore.getState().actOnCard("choice", "go", "chrome", undefined, async () => ({
        answered: over.length,
        of: over.length,
        changed: over.length,
        picked: over.length,
        answers: over,
      }));
      expect(ipc.act).not.toHaveBeenCalled();
      expect(useShellStore.getState().cardActionErrors.choice).toBe(CARD_ANSWERS_TOO_LONG);
    });

    it("reports the offer mounted at the click and the questions the fresh reading defined", async () => {
      const ipc = request();
      const mounted = { ...withAnswers, lifecycleId: "life-1", offerId: "offer-1" };
      useShellStore.setState({ cards: [mounted] });
      const question = {
        name: "speed",
        kind: "single" as const,
        control: "radio" as const,
        prompt: "How fast?",
        promptBasis: "legend" as const,
        options: [],
        defaultBasis: "none" as const,
        required: false,
        gaps: [],
        complete: true,
      };
      const sent = useShellStore.getState().actOnCard(
        "choice",
        "go",
        "chrome",
        undefined,
        async () => {
          // A newer version arrives while the frame is read.
          useShellStore.getState().applyCards([{ ...mounted, offerId: "offer-2" }]);
          return { ...answered, questions: [question] };
        },
        { lifecycleId: "life-1", offerId: "offer-1" },
      );
      await vi.waitFor(() => expect(ipc.act).toHaveBeenCalled());
      // The click names what it was made on, and says the card moved since.
      expect(ipc.act).toHaveBeenCalledWith(
        "choice",
        "go",
        "chrome",
        { answers: [speed, scope] },
        gesture({
          lifecycleId: "life-1",
          offerId: "offer-1",
          reading: "fresh",
          remounted: true,
          questions: [question],
        }),
      );
      ipc.resolve();
      await sent;
    });

    it("keeps a card's reading only while the card is up", () => {
      request();
      useShellStore.setState({ cards: [withAnswers] });
      useShellStore.getState().setCardAnswers("choice", answered);
      useShellStore.getState().applyCards([withAnswers]);
      expect(useShellStore.getState().cardAnswers).toEqual({ choice: answered });
      useShellStore.getState().applyCards([]);
      expect(useShellStore.getState().cardAnswers).toEqual({});
    });
  });

  it("returns a frame action refusal to the frame without changing the card", async () => {
    const ipc = request();
    const sent = useShellStore.getState().actOnCard("choice", "land", "frame");
    ipc.reject(new Error("This action is available only from the card controls."));
    await expect(sent).rejects.toThrow("available only from the card controls");
    expect(ipc.act).toHaveBeenCalledWith("choice", "land", "frame", undefined, gesture());
    expect(useShellStore.getState()).toMatchObject({
      cards: [ready],
      pendingCardActions: {},
      cardActionErrors: {},
    });
  });

  it("clears on a removal push and does not let a late receipt clear a reopened card's new request", async () => {
    const ipc = request();
    const first = useShellStore.getState().actOnCard("choice", "land");
    useShellStore.getState().applyCards([]);
    expect(useShellStore.getState().pendingCardActions).toEqual({});
    useShellStore.getState().applyCards([ready]);
    const second = useShellStore.getState().actOnCard("choice", "discard");
    ipc.replies[0]?.resolve({});
    await first;
    expect(useShellStore.getState().pendingCardActions.choice).toEqual({ actionId: "discard" });
    expect(useShellStore.getState().cards).toEqual([ready]);
    ipc.resolve();
    await second;
    expect(useShellStore.getState().pendingCardActions).toEqual({});
    expect(useShellStore.getState().cards).toEqual([]);
  });

  it("still applies shell effects after a removal push arrived before the receipt", async () => {
    const ipc = request();
    const first = useShellStore.getState().actOnCard("choice", "settings");
    useShellStore.getState().applyCards([]);
    ipc.resolve({ effect: { kind: "open", target: "settings" } });
    await first;
    expect(useShellStore.getState().view).toBe("settings");
  });
});

describe("submit visible card id", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useShellStore.setState({
      cards: [],
      records: [],
      cardIndex: 0,
      inputText: "",
      attachments: [],
      recording: false,
    });
  });

  it("passes only the shown record task, then only the shown card", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", {
      infinitary: { conversation: { send } },
    });
    useShellStore.setState({
      cards: [card({ id: "card-fm-1", status: "ready", title: "Quota", body: "ok" })],
      records: [{ taskId: "task-1" }],
      cardIndex: 0,
      inputText: "how is this going?",
      attachments: [],
      recording: false,
    });
    useShellStore.getState().submit();
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith({
      text: "how is this going?",
      images: undefined,
      visibleCardId: undefined,
      taskId: "task-1",
    });
    useShellStore.getState().focusCard("card-fm-1");
    useShellStore.getState().setInputText("and this?");
    useShellStore.getState().submit();
    expect(send).toHaveBeenLastCalledWith({
      text: "and this?",
      images: undefined,
      visibleCardId: "card-fm-1",
      taskId: undefined,
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

describe("never lose a draft", () => {
  const picture = (id: string) => ({
    id,
    preview: `data:image/png;base64,${id}`,
    mimeType: "image/png" as const,
    data: id,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useShellStore.setState({
      cards: [],
      records: [],
      cardIndex: 0,
      inputText: "",
      attachments: [],
      composerNotice: null,
      lastSent: null,
      pastes: [],
      inputCaret: null,
      focusCaret: null,
      recording: false,
    });
  });

  it("puts a rejected turn's words and pictures back in an empty composer", async () => {
    const send = vi.fn(async () => Promise.reject(new Error("malformed request")));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "look at this", attachments: [picture("a")] });

    useShellStore.getState().submit();
    expect(useShellStore.getState().inputText).toBe("");
    await vi.waitFor(() => expect(useShellStore.getState().composerNotice).toBe("not-sent"));

    const state = useShellStore.getState();
    expect(state.inputText).toBe("look at this");
    expect(state.attachments.map((a) => a.id)).toEqual(["a"]);
  });

  it("never overwrites a newer draft; the unsent turn waits in the recall slot", async () => {
    let reject: (reason: Error) => void = () => {};
    const send = vi.fn(
      () =>
        new Promise<never>((_resolve, rejectSend) => {
          reject = rejectSend;
        }),
    );
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "first thought", attachments: [picture("a")] });

    useShellStore.getState().submit();
    useShellStore.setState({ inputText: "second thought" });
    reject(new Error("the core refused it"));
    await vi.waitFor(() => expect(useShellStore.getState().composerNotice).toBe("not-sent"));

    const state = useShellStore.getState();
    expect(state.inputText).toBe("second thought");
    expect(state.attachments).toEqual([]);
    expect(state.lastSent?.text).toBe("first thought");
    expect(state.lastSent?.attachments.map((a) => a.id)).toEqual(["a"]);
  });

  it("keeps an over-limit draft and sends nothing", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    const draft = "x".repeat(CONVERSE_TEXT_MAX_CHARS + 1);
    useShellStore.setState({ inputText: draft, attachments: [picture("a")] });

    useShellStore.getState().submit();

    const state = useShellStore.getState();
    expect(send).not.toHaveBeenCalled();
    expect(state.inputText).toBe(draft);
    expect(state.attachments.map((a) => a.id)).toEqual(["a"]);
    expect(state.composerNotice).toBe("too-long");
  });

  it("sends a draft exactly at the limit and clears the notice", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    const draft = "x".repeat(CONVERSE_TEXT_MAX_CHARS);
    useShellStore.setState({ inputText: `\n\n${draft}  \n`, composerNotice: "too-long" });

    useShellStore.getState().submit();

    expect(send).toHaveBeenCalledWith(draft);
    expect(useShellStore.getState().inputText).toBe("");
    expect(useShellStore.getState().composerNotice).toBeNull();
  });

  it("refuses a fifth picture and keeps the four", () => {
    useShellStore.getState().attachImages([picture("a"), picture("b"), picture("c")]);
    expect(useShellStore.getState().composerNotice).toBeNull();

    useShellStore.getState().attachImages([picture("d"), picture("e")]);

    const state = useShellStore.getState();
    expect(state.attachments).toHaveLength(TURN_IMAGES_MAX);
    expect(state.attachments.map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
    expect(state.composerNotice).toBe("pictures-max");
  });
});

describe("the multi-line composer", () => {
  const picture = (id: string) => ({
    id,
    preview: `data:image/png;base64,${id}`,
    mimeType: "image/png" as const,
    data: id,
  });
  const log = Array.from({ length: 240 }, (_, i) => `line ${i + 1}`).join("\n");

  afterEach(() => {
    vi.unstubAllGlobals();
    useShellStore.setState({
      cards: [],
      records: [],
      cardIndex: 0,
      inputText: "",
      attachments: [],
      pastes: [],
      inputCaret: null,
      focusCaret: null,
      composerNotice: null,
      lastSent: null,
      recording: false,
    });
  });

  it("sends the typed words with their line breaks, then each pasted text after a blank line", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "\n  why does this fail?\n\nsee below\n" });
    useShellStore.getState().attachPastedText(log);

    useShellStore.getState().submit();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "  why does this fail?\n\nsee below",
        files: [{ text: log }],
      }),
    );
    const state = useShellStore.getState();
    expect(state.inputText).toBe("");
    expect(state.pastes).toEqual([]);
  });

  it("sends a large paste as a file without counting its text against the typed limit", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "look" });
    const text = "x".repeat(78438);
    useShellStore.getState().attachPastedText(text);
    useShellStore.getState().submit();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "look", files: [{ text }] }));
    expect(useShellStore.getState().pastes).toEqual([]);
  });
  it("sends a dropped text file by name, and a picture with its name", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({
      inputText: "see these",
      attachments: [{ ...picture("a"), name: "a.png" }],
    });
    useShellStore.getState().attachPastedText("one\r\ntwo\r\n", "notes.txt");
    expect(useShellStore.getState().pastes[0]).toMatchObject({ name: "notes.txt" });
    useShellStore.getState().submit();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [{ text: "one\r\ntwo\r\n", name: "notes.txt" }],
        images: [expect.objectContaining({ name: "a.png" })],
      }),
    );
  });

  it("holds a send while a file is still being prepared, and keeps the draft", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useIntakeStore.setState({ pending: { [MAIN_FILES_KEY]: [{ id: "f1", name: "big.csv" }] } });
    try {
      useShellStore.setState({ inputText: "look at big.csv" });
      useShellStore.getState().submit();
      expect(send).not.toHaveBeenCalled();
      expect(useShellStore.getState().inputText).toBe("look at big.csv");
      expect(useShellStore.getState().composerNotice).toBe("files-preparing");
    } finally {
      useIntakeStore.setState({ pending: {} });
    }
  });

  it("refuses oversized and fifth files out loud without changing held files", () => {
    for (let i = 0; i < 4; i++) useShellStore.getState().attachPastedText(log);
    useShellStore.getState().attachPastedText(log);
    expect(useShellStore.getState().pastes).toHaveLength(4);
    expect(useShellStore.getState().composerNotice).toBe("files-max");
    useShellStore.getState().attachPastedText("é".repeat(3 * 1024 * 1024));
    expect(useShellStore.getState().composerNotice).toBe("file-too-big");
    expect(useShellStore.getState().pastes).toHaveLength(4);
  });

  it("brings the last sent turn back, words and chips, only into an empty composer", () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "first\nsecond", attachments: [picture("a")] });
    useShellStore.getState().attachPastedText(log);
    useShellStore.getState().submit();

    useShellStore.setState({ inputText: "a new draft" });
    useShellStore.getState().recallLastSent();
    expect(useShellStore.getState().inputText).toBe("a new draft");

    useShellStore.setState({ inputText: "" });
    useShellStore.getState().recallLastSent();
    const state = useShellStore.getState();
    expect(state.inputText).toBe("first\nsecond");
    expect(state.pastes.map((p) => p.text)).toEqual([log]);
    expect(state.attachments.map((a) => a.id)).toEqual(["a"]);
    expect(state.focusCaret).toEqual({ request: state.focusRequest, at: "first\nsecond".length });
  });

  it("recalls nothing while recording", () => {
    useShellStore.setState({
      recording: true,
      lastSent: { text: "earlier", pastes: [], attachments: [] },
    });
    useShellStore.getState().recallLastSent();
    expect(useShellStore.getState().inputText).toBe("");
  });

  it("puts a rejected turn's pasted text back with its words", async () => {
    const send = vi.fn(async () => Promise.reject(new Error("the core refused it")));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({ inputText: "look at this" });
    useShellStore.getState().attachPastedText(log);

    useShellStore.getState().submit();
    expect(useShellStore.getState().pastes).toEqual([]);
    await vi.waitFor(() => expect(useShellStore.getState().composerNotice).toBe("not-sent"));

    const state = useShellStore.getState();
    expect(state.inputText).toBe("look at this");
    expect(state.pastes.map((p) => p.text)).toEqual([log]);
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
    useShellStore.setState({
      lastTurn: null,
      lastTurnSeq: 0,
      lastTurnReplySeq: 0,
      firstmateBusy: false,
    });
    drain();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useShellStore.setState({
      lastTurn: null,
      lastTurnSeq: 0,
      lastTurnReplySeq: 0,
      firstRun: null,
      firstmateBusy: false,
    });
  });

  it("starts a pair with each message sent, and the turn that read it fills in the reply", () => {
    state().applyEvent({ type: "user_turn", text: "How is the alpha coming along?" });
    expect(state().lastTurn).toEqual({ you: "How is the alpha coming along?", reply: null });
    expect(state().lastTurnSeq).toBe(1);
    state().applyEvent({ type: "firstmate_reply", text: "The alpha is cut" });
    expect(state().lastTurn).toEqual({
      you: "How is the alpha coming along?",
      reply: { text: "The alpha is cut" },
    });
    // The next message replaces the pair; its reply is not yet given.
    state().applyEvent({ type: "user_turn", text: "Merge it" });
    expect(state().lastTurn).toEqual({ you: "Merge it", reply: null });
    expect(state().lastTurnSeq).toBe(2);
    state().applyEvent({ type: "firstmate_reply", text: "Something went wrong", problem: true });
    expect(state().lastTurn?.reply).toEqual({ text: "Something went wrong", problem: true });
  });

  it("puts no reply up before any message, and leaves emote words to the reply line", () => {
    state().applyEvent({ type: "firstmate_reply", text: "Got it" });
    expect(state().lastTurn).toBeNull();
    state().applyEvent({ type: "user_turn", text: "Salute me" });
    state().applyEvent({ type: "firstmate_emote", emote: "salute", text: "On it" });
    // The motion still plays; only the core's reply line changes the area.
    expect(drain()).toEqual(["salute"]);
    expect(state().lastTurn).toEqual({ you: "Salute me", reply: null });
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
    expect(state().lastTurn).toEqual({ you: "A newer message", reply: null });
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
      collapsedCardIds: [],
    });
    state().submit();
    expect(state().firstRun?.firstTurnAt).toBe(T0);
  });
});

describe("going to the main message", () => {
  const state = () => useShellStore.getState();
  afterEach(() =>
    useShellStore.setState({
      view: "home",
      recording: false,
      pickingDictationKey: false,
      firstRun: null,
      firstRunSettled: false,
    }),
  );

  it("asks the input for focus once per press, coming home from Settings first", () => {
    useShellStore.setState({
      view: "home",
      inputText: "ship the fix",
      inputCaret: 4,
      firstRunSettled: true,
    });
    const before = state().focusRequest;
    state().focusMainMessage();
    expect(state()).toMatchObject({ view: "home", focusRequest: before + 1 });
    useShellStore.setState({ view: "settings" });
    state().focusMainMessage();
    // The words and the caret stay as they were: focus alone moves.
    expect(state()).toMatchObject({
      view: "home",
      focusRequest: before + 2,
      inputText: "ship the fix",
      inputCaret: 4,
    });
  });

  it("moves nothing while a recording, the dictation key's pick or a held main input holds the keys", () => {
    const firstRun = { welcomedAt: null, firstTurnAt: null, gateOpen: true };
    for (const holder of [
      { recording: true },
      { pickingDictationKey: true, view: "settings" as const },
      { firstRun, view: "settings" as const },
      // Before the first read of the gate settles, nobody knows yet whether it is up.
      { firstRunSettled: false, view: "settings" as const },
    ]) {
      useShellStore.setState({ view: "home", firstRunSettled: true, ...holder });
      const { view, focusRequest } = state();
      state().focusMainMessage();
      expect(state()).toMatchObject({ view, focusRequest });
      useShellStore.setState({ recording: false, pickingDictationKey: false, firstRun: null });
    }
  });
});

describe("the main input before the first read of the gate (docs/first-launch.md)", () => {
  const state = () => useShellStore.getState();
  const view = (gateOpen: boolean) => ({ welcomedAt: null, firstTurnAt: null, gateOpen });
  let answer!: { resolve: (v: ReturnType<typeof view>) => void; reject: (e: Error) => void };

  beforeEach(() => {
    const micAccess = vi.fn(async () => ({ access: "granted" as const }));
    const firstRun = vi.fn(
      () =>
        new Promise<ReturnType<typeof view>>((resolve, reject) => {
          answer = { resolve, reject };
        }),
    );
    vi.stubGlobal("window", { infinitary: { app: { firstRun }, voice: { micAccess } } });
    vi.spyOn(voiceController, "start").mockResolvedValue();
    // A launch with everything hold-to-talk needs, but no answer about the gate yet.
    useShellStore.setState({
      view: "home",
      recording: false,
      pickingDictationKey: false,
      dictation: { enabled: true, key: "AltRight" },
      voiceSupported: true,
      voiceModelReady: true,
      firstRun: null,
      firstRunSettled: false,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useShellStore.setState({ recording: false, firstRun: null, firstRunSettled: false });
  });

  /** What a person could do with the main input now: hold-to-talk and the focus key. */
  const tryInput = () => {
    const { focusRequest } = state();
    state().focusMainMessage();
    state().startRecording();
    const took = { recording: state().recording, focused: state().focusRequest > focusRequest };
    useShellStore.setState({ recording: false });
    return took;
  };

  it("takes nothing until the read settles, and stays held when it says the gate is up", async () => {
    expect(mainInputHeld(state())).toBe(true);
    const reading = state().loadFirstRun();
    expect(tryInput()).toEqual({ recording: false, focused: false });
    answer.resolve(view(true));
    await reading;
    expect(state()).toMatchObject({ firstRunSettled: true, firstRun: { gateOpen: true } });
    expect(mainInputHeld(state())).toBe(true);
    expect(tryInput()).toEqual({ recording: false, focused: false });
  });

  it("opens once the read says a model can answer", async () => {
    const reading = state().loadFirstRun();
    answer.resolve(view(false));
    await reading;
    expect(mainInputHeld(state())).toBe(false);
    expect(tryInput()).toEqual({ recording: true, focused: true });
  });

  it("opens as before any read when the first read fails, rather than holding for good", async () => {
    const reading = state().loadFirstRun();
    answer.reject(new Error("unreadable"));
    await reading;
    expect(state()).toMatchObject({ firstRunSettled: true, firstRun: null });
    expect(tryInput()).toEqual({ recording: true, focused: true });
  });
});

describe('microphone access lines under the input (docs/composer.md, "Voice")', () => {
  const state = () => useShellStore.getState();
  /** Lets the access read and the microphone's answer run through. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  let access: MicAccess;
  let micAccess: ReturnType<typeof vi.fn>;
  /** The microphone's open, answered by the test the way macOS answers its prompt. */
  let opening: { resolve: () => void; reject: (error: Error) => void };
  let start: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    access = "granted";
    micAccess = vi.fn(async () => ({ access }));
    vi.stubGlobal("window", { infinitary: { voice: { micAccess } } });
    start = vi.spyOn(voiceController, "start").mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          opening = { resolve, reject };
        }),
    );
    vi.spyOn(voiceController, "finish").mockResolvedValue(null);
    vi.spyOn(voiceController, "abandon").mockImplementation(() => {});
    useShellStore.setState({
      view: "home",
      recording: false,
      pickingDictationKey: false,
      dictation: { enabled: true, key: "AltRight" },
      voiceSupported: true,
      voiceModelReady: true,
      firstRun: null,
      firstRunSettled: true,
      voiceNotice: null,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useShellStore.setState({ recording: false, voiceNotice: null });
  });

  it("explains while macOS asks, and allowing takes the line down while listening goes on", async () => {
    access = "not-determined";
    state().startRecording();
    await settle();
    expect(state()).toMatchObject({
      recording: true,
      voiceNotice: { kind: "mic", line: "asking" },
    });
    access = "granted";
    opening.resolve();
    await settle();
    expect(state()).toMatchObject({ recording: true, voiceNotice: null });
  });

  it("says access is off after Don't Allow, even once the key is up", async () => {
    access = "not-determined";
    state().startRecording();
    await settle();
    state().acceptRecording(true);
    access = "denied";
    opening.reject(new DOMException("Permission denied", "NotAllowedError"));
    await settle();
    expect(state()).toMatchObject({ recording: false, voiceNotice: { kind: "mic", line: "off" } });
  });

  it("shows the off line at once on a later hold, and never opens the microphone", async () => {
    access = "denied";
    state().startRecording();
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(state()).toMatchObject({
      recording: false,
      phase: "idle",
      voiceNotice: { kind: "mic", line: "off" },
    });
  });

  it("says the administrator decides on a managed Mac", async () => {
    access = "restricted";
    state().startRecording();
    await settle();
    expect(start).not.toHaveBeenCalled();
    expect(state()).toMatchObject({
      recording: false,
      voiceNotice: { kind: "mic", line: "managed" },
    });
  });

  it("keeps the unavailable line for a microphone that fails with access on", async () => {
    state().startRecording();
    await settle();
    opening.reject(new DOMException("Requested device not found", "NotFoundError"));
    await settle();
    expect(state()).toMatchObject({
      recording: false,
      voiceNotice: { kind: "error", message: "The microphone is unavailable. You can still type." },
    });
  });

  it("keeps an off line up through a hold until the hold works", async () => {
    useShellStore.setState({ voiceNotice: { kind: "mic", line: "off" } });
    state().startRecording();
    await settle();
    expect(state()).toMatchObject({ recording: true, voiceNotice: { kind: "mic", line: "off" } });
    opening.resolve();
    await settle();
    expect(state().voiceNotice).toBeNull();
  });

  it("takes the off line down when access reads on again, and leaves it while still off", async () => {
    useShellStore.setState({ voiceNotice: { kind: "mic", line: "off" } });
    access = "denied";
    state().recheckMicAccess();
    await settle();
    expect(state().voiceNotice).toEqual({ kind: "mic", line: "off" });
    access = "granted";
    state().recheckMicAccess();
    await settle();
    expect(state().voiceNotice).toBeNull();
    // The asking line is the prompt's own, so a re-read leaves it alone.
    useShellStore.setState({ voiceNotice: { kind: "mic", line: "asking" } });
    state().recheckMicAccess();
    await settle();
    expect(micAccess).toHaveBeenCalledTimes(2);
    expect(state().voiceNotice).toEqual({ kind: "mic", line: "asking" });
  });

  it("drops the line when dictation goes off while macOS asks", async () => {
    access = "not-determined";
    state().startRecording();
    await settle();
    state().applyDictation({ enabled: false, key: "AltRight" });
    access = "denied";
    opening.reject(new DOMException("Permission denied", "NotAllowedError"));
    await settle();
    expect(state()).toMatchObject({ recording: false, voiceNotice: null });
  });
});

describe("appearance saves", () => {
  const SAVED = {
    theme: "dark",
    size: 100,
    washStrength: 0,
    showCrewModelNames: true,
  } as const;

  function arrange(write: (appearance: Record<string, unknown>) => Promise<unknown>) {
    const sent: Record<string, unknown>[] = [];
    const wash: string[] = [];
    vi.stubGlobal("document", {
      documentElement: {
        style: { setProperty: (_name: string, value: string) => wash.push(value) },
      },
    });
    vi.stubGlobal("window", {
      infinitary: {
        settings: {
          getAppearance: async () => SAVED,
          setAppearance: (appearance: Record<string, unknown>) => {
            sent.push(appearance);
            return write(appearance);
          },
        },
      },
    });
    useShellStore.getState().applyAppearance(SAVED);
    return { sent, wash };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    useShellStore.setState({ appearanceError: null });
  });

  it("says why a theme was refused beside Theme and shows the saved theme again", async () => {
    arrange(async () => {
      throw new Error("Could not save this setting: Locked.");
    });
    useShellStore.getState().setTheme("light");
    // The choice shows at once, as before.
    expect(useShellStore.getState().theme).toBe("light");
    await vi.waitFor(() =>
      expect(useShellStore.getState().appearanceError).toEqual({
        choice: "theme",
        message: "Could not save this setting: Locked.",
      }),
    );
    expect(useShellStore.getState().theme).toBe("dark");
  });

  it("writes the next choice over the saved look, and a saved write clears the refusal", async () => {
    let refuse = true;
    const { sent, wash } = arrange(async (appearance) => {
      if (refuse) {
        refuse = false;
        throw new Error("Could not save this setting: Locked.");
      }
      return appearance;
    });
    useShellStore.getState().setTheme("light");
    useShellStore.getState().setWashStrength(40);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    // The refused light theme is never carried into the wash's write.
    expect(sent[1]).toMatchObject({ theme: "dark", washStrength: 40 });
    await vi.waitFor(() => expect(useShellStore.getState().appearanceError).toBeNull());
    expect(useShellStore.getState()).toMatchObject({ theme: "dark", washStrength: 40 });
    expect(wash.at(-1)).toBe("40%");
  });

  it("lets a push behind the window's own write give way to that write's answer", async () => {
    let answer!: (appearance: unknown) => void;
    arrange(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    useShellStore.getState().setShowCrewModelNames(false);
    await vi.waitFor(() => expect(answer).toBeDefined());
    // An echo of an older look while the write is unanswered changes nothing shown.
    useShellStore.getState().applyAppearance(SAVED);
    expect(useShellStore.getState().showCrewModelNames).toBe(false);
    answer({ ...SAVED, showCrewModelNames: false });
    await vi.waitFor(() => expect(useShellStore.getState().showCrewModelNames).toBe(false));
    useShellStore.getState().applyAppearance({ ...SAVED, theme: "light" });
    expect(useShellStore.getState()).toMatchObject({ theme: "light", showCrewModelNames: true });
  });
});

describe("a panel's cards on the card stack (docs/ui-plugins.md, \"A panel's cards\")", () => {
  const shell = () => useShellStore.getState();
  const shown = () => shownCard(shell().cards, shell().cardIndex, [], shell().records);
  const reader = { view: "reader", title: "Reading", data: { at: 1 } };
  beforeEach(() =>
    useShellStore.setState({
      cards: [],
      records: [],
      cardIndex: 0,
      recording: false,
      firstmateBusy: false,
      collapsedCardIds: [],
      unreadCardIds: [],
      collapsedDigests: {},
      cardsSeeded: true,
    }),
  );
  afterEach(() =>
    useShellStore.setState({ records: [], cards: [], cardIndex: 0, unreadCardIds: [] }),
  );

  it("puts a card up at the front from the captain's click or key, a held entry as wide as asked", () => {
    shell().applyCards([card({ id: "decision", status: "ready", actions: DECIDE })]);
    const id = shell().emitPanelCard("reading-list", { ...reader, width: "regular" }, true);
    expect(id).toBe("card-1");
    expect(shown()).toMatchObject({
      id: panelCardEntryId("reading-list", "card-1"),
      width: "regular",
      panelCard: { panel: "reading-list", id: "card-1", view: "reader", data: { at: 1 } },
    });
    expect(isHeldEntry(shown())).toBe(true);
    expect(shell().unreadCardIds).toEqual([]);
  });

  it("puts one raised on its own behind the card being read, marked new", () => {
    shell().applyCards([card({ id: "decision", status: "ready", actions: DECIDE })]);
    const id = shell().emitPanelCard("reading-list", { ...reader, id: "later" }, false);
    expect(shown()?.id).toBe("decision");
    expect(shell().unreadCardIds).toEqual([panelCardEntryId("reading-list", id)]);
    // Paged to, it is seen.
    shell().prevCard();
    expect(shown()?.id).toBe(panelCardEntryId("reading-list", "later"));
    expect(shell().unreadCardIds).toEqual([]);
  });

  it("shows one raised on its own at once when nothing else is up", () => {
    shell().emitPanelCard("reading-list", reader, false);
    expect(shown()?.panelCard?.id).toBe("card-1");
    expect(shell().unreadCardIds).toEqual([]);
    expect(shell().phase).toBe("working");
  });

  it("revises an open card in place, and brings it forward only from a click or key", () => {
    shell().applyCards([card({ id: "decision", status: "ready", actions: DECIDE })]);
    shell().emitPanelCard("reading-list", { ...reader, id: "r" }, false);
    shell().emitPanelCard(
      "reading-list",
      { ...reader, id: "r", title: "Read later", data: 2 },
      false,
    );
    expect(shell().records).toEqual([
      {
        panelCard: {
          panel: "reading-list",
          id: "r",
          view: "reader",
          title: "Read later",
          width: "wide",
          height: "content",
          data: 2,
          // Put up twice: its view hears each time, its data new or not.
          revision: 2,
          kept: null,
          aim: null,
        },
      },
    ]);
    expect(shown()?.id).toBe("decision");
    shell().emitPanelCard("reading-list", { ...reader, id: "r", data: 3 }, true);
    expect(shown()?.panelCard).toMatchObject({ id: "r", data: 3 });
    expect(shell().records).toHaveLength(1);
  });

  it("points the turn at the task its card aims at while shown - the task board's selected tile", async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", { infinitary: { conversation: { send } } });
    useShellStore.setState({
      cards: [card({ id: "card-fm-1", status: "ready", title: "Quota", body: "ok" })],
    });
    shell().emitPanelCard("now", { id: "board", view: "board", title: "Task board" }, true);
    shell().setInputText("what about this one?");
    shell().submit();
    await Promise.resolve();
    expect(send).toHaveBeenLastCalledWith("what about this one?");
    shell().aimPanelCard("now", "board", "t2");
    shell().setInputText("and this one?");
    shell().submit();
    await Promise.resolve();
    expect(send).toHaveBeenLastCalledWith({
      text: "and this one?",
      images: undefined,
      visibleCardId: undefined,
      taskId: "t2",
      pastCardId: undefined,
    });
    // Paged away, the shown card is the hint again.
    shell().nextCard();
    shell().setInputText("and the card?");
    shell().submit();
    expect(send).toHaveBeenLastCalledWith({
      text: "and the card?",
      images: undefined,
      visibleCardId: "card-fm-1",
      taskId: undefined,
      pastCardId: undefined,
    });
    vi.unstubAllGlobals();
    useShellStore.setState({ inputText: "" });
  });

  it("keeps a card's place on its entry through a revision, until Hide lets it go", () => {
    shell().emitPanelCard("reading-list", { ...reader, id: "r" }, true);
    shell().keepPanelCard("reading-list", "r", { scroll: 120 });
    expect(shown()?.panelCard?.kept).toEqual({ scroll: 120 });
    shell().emitPanelCard("reading-list", { ...reader, id: "r", data: 2 }, false);
    expect(shown()?.panelCard).toMatchObject({ data: 2, kept: { scroll: 120 } });
    // A card that is not open keeps nothing, and keeping moves nothing on the stack.
    shell().keepPanelCard("reading-list", "gone", 1);
    expect(shell().records).toHaveLength(1);
    shell().closeRecord();
    shell().emitPanelCard("reading-list", { ...reader, id: "r" }, true);
    expect(shown()?.panelCard?.kept).toBeNull();
  });

  it("keeps any number of a panel's cards up to its bound, then says why", () => {
    for (let n = 0; n < PANEL_OPEN_CARDS_MAX; n++) {
      shell().emitPanelCard("reading-list", { ...reader, id: `c${n}` }, false);
    }
    expect(() => shell().emitPanelCard("reading-list", reader, false)).toThrow(
      `${PANEL_OPEN_CARDS_MAX} cards open`,
    );
    // A revision is not a new card, and another panel has its own bound.
    expect(shell().emitPanelCard("reading-list", { ...reader, id: "c0" }, false)).toBe("c0");
    expect(shell().emitPanelCard("notes", reader, false)).toBe("card-1");
  });

  it("hides the shown card on Hide, and takes a panel's cards off with the panel", () => {
    shell().emitPanelCard("reading-list", { ...reader, id: "a" }, true);
    shell().emitPanelCard("reading-list", { ...reader, id: "b" }, false);
    shell().emitPanelCard("notes", { ...reader, id: "n" }, false);
    shell().closeRecord();
    expect(shell().records.map((held) => ("panelCard" in held ? held.panelCard.id : null))).toEqual(
      ["n", "b"],
    );
    shell().closePanelCards("reading-list");
    expect(shell().records.map((held) => ("panelCard" in held ? held.panelCard.id : null))).toEqual(
      ["n"],
    );
    expect(shell().unreadCardIds).not.toContain(panelCardEntryId("reading-list", "b"));
    shell().closePanelCard("notes", "n");
    expect(shell().records).toEqual([]);
    expect(shell().phase).not.toBe("working");
  });
});
