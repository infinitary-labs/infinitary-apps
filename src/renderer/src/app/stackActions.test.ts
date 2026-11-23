import { cardCornerOf } from "@shared/cardLeave";
import { CARD_REPLY_MAX_CHARS, type Card, TURN_IMAGES_MAX } from "@shared/cards";
import { PANEL_OPEN_CARDS_MAX } from "@shared/plugins/panelCards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIntakeStore } from "../attachments/intake";
import { takeCharacterNotice } from "../character/emoteSignal";
import {
  dismissalSuccessor,
  isHeldEntry,
  panelCardEntryId,
  reconcileStack,
  shownCard,
  shownEntry,
  stackOf,
  taskEntryFrom,
  unreadAround,
  visibleCards,
  visibleStack,
} from "./stack";
import { useShellStore } from "./store";
import { card, DECIDE, gesture, picture, resetShell } from "./storeTestKit";

/**
 * The window's project focus, as the stack reads it: the focused project and
 * each task's project on the board, through the shared rule (`holdsBack`).
 * Nothing is focused unless a test focuses it.
 */
const focus = vi.hoisted(() => ({
  on: null as string | null,
  taskProjects: new Map<string, string>(),
}));
vi.mock("./projectFocus", async (importOriginal) => {
  const { holdsBack } = await import("@shared/projectFocus");
  return {
    ...(await importOriginal<typeof import("./projectFocus")>()),
    heldProjectFocus: () => focus.on,
    focusHoldsBack: (card: { taskId?: string }) => holdsBack(card, focus.on, focus.taskProjects),
  };
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
    return shownEntry(s)?.id;
  };
  const unread = () => {
    const s = state();
    return unreadAround(visibleCards(s.cards, s.heldBackCardIds), s.cardIndex, s.unreadCardIds);
  };

  const reset = () => {
    vi.useRealTimers();
    takeCharacterNotice();
    resetShell();
  };
  beforeEach(reset);
  afterEach(reset);

  // INF-1404: a later close must not return to the first already-read card.
  it("restores initial unread cards without arrival effects, and closes to the first unread", () => {
    const a = ready("a", { actions: DECIDE, seen: true });
    const b = ready("b", { actions: DECIDE, seen: false, holdsPlace: true });
    const c = ready("c", { actions: DECIDE, seen: false });
    state().applyCards([a, b, c]);
    expect(shownId()).toBe("a");
    expect(state().unreadCardIds).toEqual(["b", "c"]);
    expect(takeCharacterNotice()).toBe(false);
    state().nextCard();
    expect(shownId()).toBe("b");
    state().applyCards([a, c]);
    expect(shownId()).toBe("c");
    expect(state().unreadCardIds).toEqual([]);
    // The snapshot's historical fact must not re-mark a visited card unread.
    state().applyCards([a, c]);
    expect(state().unreadCardIds).toEqual([]);
    state().applyCards([a]);
    expect(shownId()).toBe("a");
  });

  it("INF-476 removes minimized cards from paging and unread, and a revision returns unread without stealing the shown card", () => {
    const choice = ready("choice", { actions: DECIDE });
    const note = ready("note");
    state().applyCards([choice, note]);
    state().setReplyDraft("choice", "Keep the review beside it.");
    state().applyCards([{ ...choice, minimized: true }, note]);
    expect(stackOf(state()).map((entry) => entry.id)).toEqual(["note"]);
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
    expect(stackOf(state())).toHaveLength(0);
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
    // the stage, which is what the stack says.
    state().applyCards([{ ...item, title: "Revised" }]);
    expect(shownId()).toBe("a");
    expect(stackOf(state()).length).toBeGreaterThan(0);
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
    state().closeThread("a");
    state().applyCards([{ ...item, title: "Revised" }]);
    expect(state().closedThreadIds).toEqual(["a"]);
    state().applyCards([]);
    expect(state().closedThreadIds).toEqual([]);
  });

  it("refuses excess reply pictures with a notice on that card only", () => {
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

  // INF-3155 direction A: with nothing unread, the card after the closed one comes up.
  it("reveals the next card after a middle close or reply, skipping open records", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    const d = ready("d", { actions: DECIDE });
    state().applyCards([a, b, c, d]);
    state().openRecord("t1");
    state().openRecord("t2");
    state().focusCard("c");
    state().applyCards([a, b, d]);
    expect(shownId()).toBe("d");
    expect(state().cardIndex).toBe(4);
    state().applyCards([a, b, c, d]);
    // "c" came back: it is news, and the first unread card wins.
    state().focusCard("c");
    state().focusCard("b");
    state().applyCards([a, c, d, { ...b, awaiting: "answer" }]);
    expect(shownId()).toBe("c");
    expect(state().cardIndex).toBe(3);
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

  // INF-4541, the captain's approved plan: the arrows go round past either end.
  it("pages round the stack: next on the last card shows the first, previous on the first the last", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    state().applyCards([a, b, c]);
    expect(shownId()).toBe("a");
    state().prevCard();
    expect(shownId()).toBe("c");
    state().nextCard();
    expect(shownId()).toBe("a");
  });

  // INF-4541: "N new" shows the first new card in the pager's order besides the shown one.
  it("shows each new card in the pager's order, then stays when no other card is new", () => {
    const a = ready("a", { actions: DECIDE, seen: true });
    const b = ready("b", { actions: DECIDE, seen: true });
    const c = ready("c", { actions: DECIDE, seen: false });
    const d = ready("d", { actions: DECIDE, seen: false });
    state().applyCards([a, b, c, d]);
    state().focusCard("b");
    expect(state().unreadCardIds).toEqual(["c", "d"]);
    state().showNewCard();
    expect(shownId()).toBe("c");
    state().showNewCard();
    expect(shownId()).toBe("d");
    state().showNewCard();
    expect(shownId()).toBe("d");
  });

  // INF-4547 review, the captain's answer: "Skip cards a press already showed until your computer
  // confirms them", with "the existing client-side optimistic prediction" (the intent table's seen).
  it("walks on through the new cards before the owner's seen marks come back", () => {
    const shared = (id: string, update = `${id}-1`) =>
      ready(id, {
        actions: DECIDE,
        lifecycleId: `${id}-life`,
        currentUpdateId: update,
        currentUpdateSeen: false,
      });
    const owners = [shared("a"), shared("b"), shared("c"), shared("d")];
    const see = (id: string) =>
      state().seeUpdate({ id, lifecycleId: `${id}-life`, currentUpdateId: `${id}-1` });
    state().applyCards(owners);
    expect(shownId()).toBe("a");
    see("a");
    state().showNewCard();
    expect(shownId()).toBe("b");
    see("b");
    state().showNewCard();
    expect(shownId()).toBe("c");
    see("c");
    expect(unreadAround(stackOf(state()), 2, state().unreadCardIds)).toEqual({
      before: 0,
      after: 1,
    });
    // The owner's list without the marks yet keeps them read.
    state().applyCards(owners);
    expect(state().unreadCardIds).toEqual(["d"]);
    state().showNewCard();
    expect(shownId()).toBe("d");
    // The owner's mark settles a sighting; a newer update voids one, and the card is new again.
    state().applyCards([
      { ...owners[0], currentUpdateSeen: true },
      { ...owners[1], currentUpdateId: "b-2" },
      owners[2],
      owners[3],
    ] as Card[]);
    expect(state().seenIntents.map((intent) => intent.card)).toEqual(["c"]);
    expect(state().unreadCardIds).toEqual(["b", "d"]);
    // A sighting the owner did not take leaves its card as the owner's last list says.
    const intent = state().seenIntents[0];
    if (!intent) throw new Error("The sighting of c is gone");
    state().unseeUpdate(intent);
    expect(state().unreadCardIds).toEqual(["b", "c", "d"]);
  });

  // INF-4547 review: with no sighting at all (the owner out of reach, or a card left before it
  // drew), each press still reaches a new card it has not shown, and goes round only after the last.
  it("passes over the cards it showed while another new card waits, with no sightings", () => {
    const shared = (id: string) =>
      ready(id, {
        actions: DECIDE,
        lifecycleId: `${id}-life`,
        currentUpdateId: `${id}-1`,
        currentUpdateSeen: false,
      });
    state().applyCards([shared("a"), shared("b"), shared("c"), shared("d")]);
    const pressed: (string | undefined)[] = [];
    for (let i = 0; i < 5; i++) {
      state().showNewCard();
      pressed.push(shownId());
    }
    expect(pressed).toEqual(["b", "c", "d", "a", "b"]);
  });

  // INF-3155 direction A: at the last card the one before it comes up, never the first.
  it("brings up the card before it when the shown card was the last one", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    state().applyCards([a, b, c]);
    state().nextCard();
    state().nextCard();
    expect(shownId()).toBe("c");
    state().applyCards([a, b, { ...c, awaiting: "answer" }]);
    expect(shownId()).toBe("b");
    expect(state().cardIndex).toBe(1);
    // Repeated waiting snapshots do not move the reader.
    state().applyCards([{ ...c, awaiting: "answer" }, a, b]);
    state().applyCards([a, b, { ...c, awaiting: "answer" }]);
    expect(shownId()).toBe("b");
  });

  // INF-3155: "next" is the card the next arrow would have shown; one that left too is passed over.
  it("brings up the card after the next one when both leave at once, and the stage prepared it", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    const d = ready("d", { actions: DECIDE });
    state().applyCards([a, b, c, d]);
    state().focusCard("b");
    const prepared = dismissalSuccessor(stackOf(state()), state().cardIndex, state().unreadCardIds);
    expect(prepared?.id).toBe("c");
    state().applyCards([a, c, d]);
    expect(shownId()).toBe(prepared?.id);
    state().applyCards([a]);
    expect(shownId()).toBe("a");
  });

  it("brings up the first unread card after a close or a reply, before the next card", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    const d = ready("d", { actions: DECIDE, createdAt: T0 + 1 });
    const e = ready("e", { actions: DECIDE, createdAt: T0 + 2 });
    state().applyCards([a, b, c]);
    state().focusCard("b");
    state().applyCards([a, b, c, d, e]);
    expect(state().unreadCardIds).toEqual(["d", "e"]);
    state().applyCards([a, c, d, e]);
    expect(shownId()).toBe("d");
    expect(state().unreadCardIds).toEqual(["e"]);
    // A reply removes "d"; the same rule passes over it and finds "e".
    state().applyCards([a, c, e, { ...d, awaiting: "answer" }]);
    expect(shownId()).toBe("e");
    expect(state().unreadCardIds).toEqual([]);
    // Nothing unread: "e" was last, so the card before it (INF-3155).
    state().applyCards([a, c, { ...d, awaiting: "answer" }]);
    expect(shownId()).toBe("c");
  });

  it("prepares the card a close would bring up, by the same rule", () => {
    const a = ready("a", { actions: DECIDE });
    const b = ready("b", { actions: DECIDE });
    const c = ready("c", { actions: DECIDE });
    const stack = [a, b, c];
    // Shown "a": nothing unread, so "b", never the shown card itself.
    expect(dismissalSuccessor(stack, 0, [])?.id).toBe("b");
    // Shown "b": the next arrow's card, and at the last card the one before it (INF-3155).
    expect(dismissalSuccessor(stack, 1, [])?.id).toBe("c");
    expect(dismissalSuccessor(stack, 2, [])?.id).toBe("b");
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
    const reconciled = reconcileStack(state(), [{ ...a, awaiting: "answer", sentBackAt: 11 }]);
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

    reset();
    state().applyCards([a]);
    state().applyCards([{ ...a, awaiting: "answer", sentBackAt: 10 }]);
    state().applyCards([a]);
    expect(state().unreadCardIds).toEqual([]);
  });

  // INF-2022: reading, elapsed time and paging never hide a note, including an answered note.
  it("keeps a note while its author waits and after its answer, through elapsed time and paging", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const a = ready("shown", { taskId: "t1" });
    const note = ready("note", { taskId: "t1" });
    state().applyCards([a, note]);
    state().nextCard();
    state().prevCard();
    state().applyCards([a, { ...note, awaiting: "answer", sentBackAt: 10 }]);
    vi.advanceTimersByTime(15 * 60_000);
    expect(visibleCards(state().cards, state().heldBackCardIds).map((c) => c.id)).toEqual([
      "shown",
      "note",
    ]);
    state().applyCards([a, { ...note, sentBackAt: 10 }]);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    state().nextCard();
    state().prevCard();
    expect(visibleCards(state().cards, state().heldBackCardIds).map((c) => c.id)).toEqual([
      "shown",
      "note",
    ]);
    expect(shownId()).toBe("shown");
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

  // INF-2022 / INF-2020: read findings, read a newer sampler, page away, then exceed the old boundary.
  it("keeps read task notes, taskless notes and decisions after the old boundary and longer waits", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const cards = [
      ready("findings", { taskId: "t1" }),
      ready("sampler", { taskId: "t1" }),
      ready("orphan"),
      ready("decision", { taskId: "t1", actions: DECIDE }),
    ];
    state().applyCards(cards);
    state().nextCard();
    state().prevCard();
    const focusBefore = state().focusRequest;
    for (const elapsed of [15 * 60_000 - 1, 1, 48 * 60 * 60_000]) {
      vi.advanceTimersByTime(elapsed);
      state().applyCards(cards);
      expect(visibleCards(state().cards, state().heldBackCardIds)).toEqual(cards);
      expect(shownId()).toBe("findings");
      expect(state().focusRequest).toBe(focusBefore);
    }
    expect(state().focusCard("sampler")).toBe(true);
    expect(shownId()).toBe("sampler");
  });

  it("applies shared current-update marks on every snapshot without moving selection or hiding cards", () => {
    const a = ready("a", { currentUpdateId: "release-a", currentUpdateSeen: false });
    const b = ready("b", { currentUpdateId: "release-b", currentUpdateSeen: false });
    state().applyCards([a, b]);
    expect(state().unreadCardIds).toEqual(["a", "b"]);
    state().nextCard();
    // Selection alone is not a sighting; only the owner's accepted update clears it.
    expect(state().unreadCardIds).toEqual(["a", "b"]);
    state().applyCards([{ ...a, currentUpdateSeen: true }, b]);
    expect(shownId()).toBe("b");
    expect(state().unreadCardIds).toEqual(["b"]);
    state().applyCards([
      { ...a, currentUpdateSeen: true },
      { ...b, currentUpdateSeen: true },
    ]);
    expect(state().unreadCardIds).toEqual([]);
    const revised = { ...a, currentUpdateId: "release-a-answer", currentUpdateSeen: false };
    state().applyCards([revised, { ...b, currentUpdateSeen: true }]);
    expect(state().unreadCardIds).toEqual(["a"]);
    expect(takeCharacterNotice()).toBe(true);
    state().applyCards([revised, { ...b, currentUpdateSeen: true }]);
    expect(state().unreadCardIds).toEqual(["a"]);
    expect(takeCharacterNotice()).toBe(false);
    expect(visibleCards(state().cards)).toHaveLength(2);
    expect(shownId()).toBe("b");
  });

  // INF-2022: a restoration read may finish after a newer owner push; it must not restore old newness.
  it("keeps a newer seen push when an older restoration snapshot finishes late", async () => {
    let finish: (cards: Card[]) => void = () => {};
    const response = new Promise<Card[]>((resolve) => {
      finish = resolve;
    });
    let began: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const list = vi.fn(() => {
      began();
      return response;
    });
    vi.stubGlobal("window", {
      infinitary: { cards: { minimize: async () => ({ ok: true }), list } },
    });
    const old = ready("note", {
      minimized: true,
      currentUpdateId: "released-note",
      currentUpdateSeen: false,
    });
    state().applyCards([old]);
    expect(state().focusCard("note")).toBe(true);
    await started;
    expect(list).toHaveBeenCalledOnce();
    const fresh = { ...old, minimized: undefined, currentUpdateSeen: true };
    state().applyCards([fresh]);
    finish([{ ...old, minimized: undefined }]);
    await response;
    await Promise.resolve();
    await Promise.resolve();
    expect(state().cards[0]?.currentUpdateSeen).toBe(true);
    expect(state().unreadCardIds).toEqual([]);
  });

  it("keeps an unread note after elapsed time, reading and paging away", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const a = ready("a");
    const note = ready("late", { taskId: "t1" });
    state().applyCards([a]);
    state().applyCards([a, note]);
    expect(state().unreadCardIds).toEqual(["late"]);
    vi.advanceTimersByTime(60 * 60_000);
    state().nextCard();
    state().prevCard();
    state().applyCards([a, note]);
    expect(state().unreadCardIds).toEqual([]);
    expect(visibleCards(state().cards, state().heldBackCardIds)).toEqual([a, note]);
    expect(shownId()).toBe("a");
  });
});

// INF-4243's plan, piece 5: "Notifications appear and open their card".
describe("a click on a card's notification", () => {
  const state = () => useShellStore.getState();
  const shownId = () => {
    const s = state();
    return shownCard(visibleCards(s.cards, s.heldBackCardIds), s.cardIndex)?.id;
  };
  beforeEach(resetShell);
  afterEach(() => {
    vi.unstubAllGlobals();
    resetShell();
  });

  it("brings that card to the front, reading the cards again when this window does not hold it yet", async () => {
    // Imported here: the store imports this module, so it loads after the store does.
    const { openNotifiedCard } = await import("./stackActions");
    const first = card({ id: "first", status: "ready" });
    const asked = card({ id: "asked", status: "ready" });
    const takeNotified = vi.fn(async () => ({ cardId: "asked" as string | null }));
    vi.stubGlobal("window", {
      infinitary: { cards: { takeNotified, list: async () => [first, asked] } },
    });
    state().applyCards([first]);
    expect(shownId()).toBe("first");
    await openNotifiedCard(useShellStore.getState);
    expect(shownId()).toBe("asked");

    // Taken once: nothing is asked for after.
    takeNotified.mockResolvedValue({ cardId: null });
    state().focusCard("first");
    await openNotifiedCard(useShellStore.getState);
    expect(shownId()).toBe("first");
  });
});

describe("the project focus holds other projects' cards back (docs/project-focus.md)", () => {
  // The captain's answer to INF-1091's question 2: "Hold other projects'
  // cards back until focus changes", and how they come back (INF-1098).
  const ready = (id: string, overrides: Partial<Card> = {}) =>
    card({ id, status: "ready", actions: DECIDE, body: id, ...overrides });
  const state = () => useShellStore.getState();
  const stackIds = () => {
    const s = state();
    return stackOf(s).map((entry) => entry.id);
  };
  const shownId = () => {
    const s = state();
    return shownEntry(s)?.id;
  };
  const focusOn = (project: string | null) => {
    focus.on = project;
    state().applyHold();
  };
  const reset = () => {
    focus.on = null;
    focus.taskProjects = new Map([
      ["inf-1", "repo-inf"],
      ["web-1", "repo-web"],
      ["web-2", "repo-web"],
    ]);
    takeCharacterNotice();
    resetShell();
  };
  beforeEach(reset);
  afterEach(reset);

  const inf = ready("inf", { taskId: "inf-1" });
  const web = ready("web", { taskId: "web-1" });
  const mate = ready("mate");

  it("takes another project's cards off the stack as a close would, keeping cards about no task", () => {
    state().applyCards([web, inf, mate]);
    expect(shownId()).toBe("web");
    const presses = state().focusRequest;
    focusOn("repo-inf");
    expect(stackIds()).toEqual(["inf", "mate"]);
    expect(state().heldBackCardIds).toEqual(["web"]);
    expect(shownId()).toBe("inf");
    expect(takeCharacterNotice()).toBe(false);
    expect(state().focusRequest).toBe(presses);
    state().applyCards([web, inf, mate]);
    expect(stackIds()).toEqual(["inf", "mate"]);
    // A focus move that changes nothing on the stack writes nothing.
    const before = state();
    state().applyHold();
    expect(state()).toBe(before);
  });

  it("brings a seen card back seen and an arrival made while held back unread, in their places", () => {
    state().applyCards([inf, web]);
    focusOn("repo-inf");
    takeCharacterNotice();
    const late = ready("late", { taskId: "web-2" });
    state().applyCards([inf, web, late]);
    // Held back on arrival: unread for later, and no notice now.
    expect(stackIds()).toEqual(["inf"]);
    expect(state().unreadCardIds).toEqual(["late"]);
    expect(takeCharacterNotice()).toBe(false);
    focusOn(null);
    expect(stackIds()).toEqual(["inf", "web", "late"]);
    expect(shownId()).toBe("inf");
    expect(state().unreadCardIds).toEqual(["late"]);
    expect(takeCharacterNotice()).toBe(false);
  });

  it("lets a card the captain points at through, without moving the focus, until the focus changes", () => {
    state().applyCards([inf, web]);
    focusOn("repo-inf");
    expect(state().focusCard("web")).toBe(true);
    expect(shownId()).toBe("web");
    expect(stackIds()).toEqual(["inf", "web"]);
    expect(focus.on).toBe("repo-inf");
    state().applyCards([inf, { ...web, body: "web, revised" }]);
    expect(stackIds()).toEqual(["inf", "web"]);
    focusOn("repo-web");
    expect(stackIds()).toEqual(["web"]);
    focusOn("repo-inf");
    expect(stackIds()).toEqual(["inf"]);
  });
});

describe("put every card aside or bring them back (INF-4002)", () => {
  // The captain's ask, "a keybind to minimize all cards", and their answer
  // to the plan's first question: one key both ways.
  const ready = (id: string, overrides: Partial<Card> = {}) =>
    card({
      id,
      status: "ready",
      actions: DECIDE,
      body: id,
      corner: cardCornerOf("decision"),
      ...overrides,
    });
  const state = () => useShellStore.getState();
  const stackIds = () => stackOf(state()).map((entry) => entry.id);
  const reset = () => {
    focus.on = null;
    focus.taskProjects = new Map([
      ["inf-1", "repo-inf"],
      ["web-1", "repo-web"],
      ["web-2", "repo-web"],
    ]);
    vi.unstubAllGlobals();
    resetShell();
  };
  beforeEach(reset);
  afterEach(reset);

  it("drops every entry in one move, leaves held-back cards alone, and brings back what the focus lets through", async () => {
    const inf = ready("inf", { taskId: "inf-1" });
    const mate = ready("mate");
    const web = ready("web", { taskId: "web-1" });
    const asideWeb = ready("aside-web", { taskId: "web-2", minimized: true });
    let owned: Card[] = [inf, mate, web, asideWeb];
    let answer: () => void = () => {};
    const answered = new Promise<{ ok: true }>((resolve) => {
      answer = () => resolve({ ok: true });
    });
    const close = vi.fn((_id: string, _submission?: unknown) => answered);
    const minimize = vi.fn(async () => ({ ok: true as const }));
    vi.stubGlobal("window", {
      infinitary: { cards: { close, minimize, list: async () => owned } },
    });
    state().applyCards(owned);
    focus.on = "repo-inf";
    state().applyHold();
    state().openRecord("t1");
    expect(stackIds()).toEqual(["record:t1", "inf", "mate"]);

    state().putEveryCardAside();
    // The stage empties at once: the record hides, each card goes through its minus.
    expect(stackIds()).toEqual([]);
    expect(state().records).toEqual([]);
    expect(close.mock.calls.map(([id]) => id)).toEqual(["inf", "mate"]);
    // A push the owner sent before it heard the closes draws none of them again.
    state().applyCards([inf, mate, web, asideWeb]);
    expect(stackIds()).toEqual([]);
    // Held back by the focus, so never on this window's stage, it is not touched.
    expect(state().heldBackCardIds).toEqual(["web"]);

    owned = [{ ...inf, minimized: true }, { ...mate, minimized: true }, web, asideWeb];
    answer();
    await vi.waitFor(() => expect(state().goingAsideCardIds).toEqual([]));
    await vi.waitFor(() => expect(state().cards).toEqual(owned));
    expect(stackIds()).toEqual([]);

    // On the empty stage, the way back: the cards put aside the focus lets through.
    state().bringBackEveryCard();
    expect(minimize.mock.calls).toEqual([
      ["inf", false],
      ["mate", false],
    ]);
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
      unreadCardIds: [],
      cardsSeeded: true,
    }),
  );
  afterEach(resetShell);
  it("opens front entries, one per task, and pages with cards", () => {
    const shell = () => useShellStore.getState();
    shell().applyCards([card({ id: "decision", status: "ready", actions: DECIDE })]);
    shell().openRecord("t1");
    shell().openRecord("t2");
    shell().openRecord("t1");
    expect(shell().records).toEqual([{ taskId: "t1" }, { taskId: "t2" }]);
    expect(stackOf(shell()).length).toBeGreaterThan(0);
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
  it("INF-1879: dismissing a question behind its shown record does not take focus from the record's minus", () => {
    const shell = () => useShellStore.getState();
    shell().applyCards([
      card({ id: "question", title: "Choose when to review", status: "ready", actions: DECIDE }),
    ]);
    shell().openRecord("t1");
    const before = shell().focusRequest;
    // The Dismiss action removes its question before the retained record's next key.
    shell().applyCards([]);
    expect(shownCard(shell().cards, shell().cardIndex, [], shell().records)?.recordTaskId).toBe(
      "t1",
    );
    expect(shell().focusRequest).toBe(before);
  });
  // INF-3818's accepted rule: closing an entry asks nothing of the main
  // message itself; the lost-focus fallback lands (focusLanding.ts), in the
  // main message once no card is left.
  it("never asks for the main message as entries close, the final one included", () => {
    const shell = () => useShellStore.getState();
    shell().openRecord("t1");
    shell().openRecord("t2");
    const before = shell().focusRequest;
    shell().closeRecord();
    expect(shell().focusRequest).toBe(before);
    shell().closeRecord();
    expect(stackOf(shell())).toHaveLength(0);
    expect(shell()).toMatchObject({ firstmateBusy: false, recording: false });
    expect(shell().focusRequest).toBe(before);
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
      unreadCardIds: [],
      cardsSeeded: true,
    }),
  );
  afterEach(() => {
    vi.unstubAllGlobals();
    resetShell();
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
    expect(stackOf(shell()).length).toBeGreaterThan(0);
    shell().closeRecord();
    expect(shell().records).toEqual([{ pastCardId: "older-note" }, { taskId: "t1" }]);
    // The shown entry left, so the first card comes up, as it does for a record.
    expect(shown()?.id).toBe("decision");
    shell().openRecord("t1");
    expect(shown()?.recordTaskId).toBe("t1");
    expect(shell().records).toContainEqual({ pastCardId: "older-note" });
    shell().closePastCard("older-note");
    shell().closeRecord();
    expect(shown()?.id).toBe("decision");
    expect(shell().cards.map((c) => c.id)).toEqual(["decision"]);
  });

  it("opens the past card when the core says it was shown, leaving live cards and focus alone", () => {
    shell().applyCards([card({ id: "decision", status: "ready", actions: DECIDE })]);
    shell().applyEvent({ type: "past_card_shown", cardId: "old-plan" });
    expect(shown()?.pastCardId).toBe("old-plan");
    expect(shell().cards.map((c) => c.id)).toEqual(["decision"]);
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
      unreadCardIds: [],
      cardsSeeded: true,
    }),
  );
  afterEach(() => {
    vi.unstubAllGlobals();
    resetShell();
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

  // The captain on INF-4587's review: the docked thread's waiting line
  // "should be consistent with how normal card threads behave".
  it("puts a docked request waiting on its crewmate's answer aside with the view, so it comes back with the answer", async () => {
    const minimize = vi.fn(async () => undefined);
    vi.stubGlobal("window", { infinitary: { cards: { minimize, list: async () => [] } } });
    const request = (awaiting?: "answer") =>
      card({
        id: "ask",
        status: "ready",
        actions: DECIDE,
        author: "crewmate",
        taskId: "t1",
        ...(awaiting ? { awaiting, sentBackAt: 1 } : {}),
        attachment: {
          kind: "browser",
          label: "Open browser",
          taskId: "t1",
          session: "run-1",
          generation: 2,
          handoff: true,
        },
      });
    const from = { cardId: "ask", session: "run-1", generation: 2 };
    useShellStore.setState({ cards: [request()], cardIndex: 0 });
    shell().openBrowserView("t1", from);
    shell().closeRecord();
    // Nothing waits on the crewmate: the card stays as it was.
    expect(minimize).not.toHaveBeenCalled();
    useShellStore.setState({ cards: [request("answer")], cardIndex: 0 });
    shell().openBrowserView("t1", from);
    shell().closeRecord();
    expect(shell().records).toEqual([]);
    expect(minimize).toHaveBeenCalledWith("ask", true);
  });

  // INF-4578's direction A, piece 3: "a card the task raises while its
  // Browser tab is shown arrives in the column".
  it("docks a card its task raises while the Browser tab is shown beside the page, and the view keeps the stage", () => {
    takeCharacterNotice();
    const first = card({ id: "first", status: "ready", actions: DECIDE, title: "First" });
    shell().applyCards([first]);
    shell().openBrowserView("t1");
    const raised = card({
      id: "changed",
      status: "ready",
      actions: DECIDE,
      author: "crewmate",
      taskId: "t1",
      createdAt: 2,
      holdsPlace: true,
    });
    const elsewhere = card({
      id: "other",
      status: "ready",
      actions: DECIDE,
      author: "crewmate",
      taskId: "t2",
      createdAt: 3,
    });
    shell().applyCards([first, raised, elsewhere]);
    // The view stays in front with the arrival in its column, which is no news;
    // another task's card lands behind as ever.
    expect(shown()).toMatchObject({ id: "browser:t1", browserArrived: "changed" });
    expect(shell().records).toEqual([{ browserTaskId: "t1", arrived: "changed" }]);
    expect(shell().unreadCardIds).toEqual(["other"]);
    expect(takeCharacterNotice()).toBe(true);
    shell().applyCards([first, raised]);
    expect(takeCharacterNotice()).toBe(false);
    const newer = { ...raised, id: "newer", createdAt: 4 };
    shell().applyCards([first, raised, newer]);
    expect(shell().records).toEqual([{ browserTaskId: "t1", arrived: "newer" }]);
    expect(takeCharacterNotice()).toBe(false);
    shell().closeRecord();
    const later = { ...raised, id: "later", createdAt: 5 };
    shell().applyCards([first, raised, newer, later]);
    expect(shell().records).toEqual([]);
  });

  it("leaves a card raised while a request stands, and the request itself, to land as any card does", () => {
    const request = card({
      id: "ask",
      status: "ready",
      actions: DECIDE,
      author: "crewmate",
      taskId: "t1",
      attachment: {
        kind: "browser",
        label: "Open browser",
        taskId: "t1",
        session: "run-1",
        generation: 2,
        handoff: true,
      },
    });
    const note = card({ id: "note", status: "ready", author: "crewmate", taskId: "t1" });
    shell().applyCards([]);
    shell().openBrowserView("t1");
    shell().applyCards([request]);
    expect(shell().records).toEqual([{ browserTaskId: "t1" }]);
    shell().applyCards([request, note]);
    expect(shell().records).toEqual([{ browserTaskId: "t1" }]);
    expect(shown()?.id).toBe("browser:t1");
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
      unreadCardIds: [],
      cardsSeeded: true,
    }),
  );
  afterEach(resetShell);

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
    shell().prevCard();
    expect(shown()?.id).toBe(panelCardEntryId("reading-list", "later"));
    expect(shell().unreadCardIds).toEqual([]);
  });

  it("shows one raised on its own at once when nothing else is up", () => {
    shell().emitPanelCard("reading-list", reader, false);
    expect(shown()?.panelCard?.id).toBe("card-1");
    expect(shell().unreadCardIds).toEqual([]);
    expect(stackOf(shell()).length).toBeGreaterThan(0);
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
      `${PANEL_OPEN_CARDS_MAX} cards open; close one with cards.close first`,
    );
    // A revision is not a new card, and another panel has its own bound.
    expect(shell().emitPanelCard("reading-list", { ...reader, id: "c0" }, false)).toBe("c0");
    expect(shell().emitPanelCard("notes", reader, false)).toBe("card-1");
    // The refusal names the panel API that really frees its slot.
    shell().closePanelCard("reading-list", "c0");
    expect(shell().emitPanelCard("reading-list", { ...reader, id: "replacement" }, false)).toBe(
      "replacement",
    );
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
    expect(stackOf(shell())).toHaveLength(0);
  });
});
