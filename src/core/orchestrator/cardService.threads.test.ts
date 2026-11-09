import { CARD_REPLY_MAX_CHARS } from "@shared/cards";
import { FIRSTMATE_SESSION_ID } from "@shared/observe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "../../../tests/helpers/cardServiceHarness";
import { seedTask } from "../tasks/seedTask";
import type { CardService } from "./cardService";

/**
 * Guardrails for card threads (INF-2625's plan, cardService's row: "Card
 * emission tests"), before the threads move to an owner of their own: the
 * receipt a crewmate's reply reads, every refusal of a line word for word
 * (the crewmate and the first mate act on these words), and what Observe
 * and the crew line read of a thread.
 */

const crewmate = { actor: "crewmate", taskId: "t1" } as const;
const firstmate = { actor: "firstmate" } as const;
const response = { requestId: "ask-1", responseId: "resp-1", status: "answered" } as const;

function crewCard(cards: CardService, title = "The meter reads in watts"): string {
  const id = cards.emitCrewmateCard(
    "t1",
    { title, body: "<p>The meter now reads in watts.</p>", actions: [] },
    "Fix the meter",
    "model",
  );
  cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
  return id;
}

function fixture() {
  const f = setup();
  seedTask(f.tasks, { id: "t1", title: "Fix the meter", status: "idle" });
  seedTask(f.tasks, { id: "t2", title: "Fix the footer", status: "idle" });
  return f;
}

describe("card threads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tells a crewmate on its own card whether its line answered the captain, still owes it, or is interim", () => {
    const { make } = fixture();
    const cards = make();
    const id = crewCard(cards);
    const title = "The meter reads in watts";
    expect(cards.replyFromCrewmate("t1", { cardId: id, text: "Watts it is." })).toBe(
      `Replied in the thread on "${title}" (${id}).`,
    );
    const asked = cards.addMessage(id, "captain", "Why not kilowatts?");
    expect(cards.replyFromCrewmate("t1", { cardId: id, text: "Checking.", interim: true })).toBe(
      `Posted in the thread on "${title}" (${id}); the captain's message ${asked.id} still waits for your answer when the work is done, in a line naming it in answers_message.`,
    );
    expect(cards.replyFromCrewmate("t1", { cardId: id, text: "The panel is small." })).toBe(
      `Replied in the thread on "${title}" (${id}). The captain's message ${asked.id} still waits: a line answers it only by naming it in answers_message.`,
    );
    expect(
      cards.replyFromCrewmate("t1", {
        cardId: id,
        text: "Watts fit the small panel.",
        answersMessage: asked.id,
      }),
    ).toBe(
      `Replied in the thread on "${title}" (${id}). It answers the captain's message ${asked.id}.`,
    );
    cards.dispose();
  });

  it("keeps the captain's message waiting through an interim line that names it, and ends the wait with the answer that names it", () => {
    // INF-2730, as INF-2678's card met it: the interim line named the
    // message, and every real answer after it was saved as a comment.
    const { make } = fixture();
    const cards = make();
    const id = crewCard(cards);
    const title = "The meter reads in watts";
    const asked = cards.addMessage(id, "captain", "Plan the meter's units first.");
    expect(
      cards.replyFromCrewmate("t1", {
        cardId: id,
        text: "Reading every place the units show.",
        interim: true,
        answersMessage: asked.id,
      }),
    ).toBe(
      `Posted in the thread on "${title}" (${id}); the captain's message ${asked.id} still waits for your answer when the work is done, in a line naming it in answers_message.`,
    );
    expect(cards.threadAwaitingAuthor("t1")).toBe(true);
    expect(
      cards.replyFromCrewmate("t1", {
        cardId: id,
        text: "The plan is on the card.",
        answersMessage: asked.id,
      }),
    ).toBe(
      `Replied in the thread on "${title}" (${id}). It answers the captain's message ${asked.id}.`,
    );
    expect(cards.threadAwaitingAuthor("t1")).toBe(false);
    expect(cards.messages(id).map((line) => [line.who, line.text, line.answersMessage])).toEqual([
      ["captain", "Plan the meter's units first.", undefined],
      ["crewmate", "Reading every place the units show.", undefined],
      ["crewmate", "The plan is on the card.", asked.id],
    ]);
    cards.dispose();
  });

  it("ends the wait with a revision answering the message after an interim line named it, and shows the revision once the turn ends", () => {
    // INF-2730's revision path, and INF-2803's card that kept its older
    // body on the stage after the crewmate's turn ended.
    const { make } = fixture();
    const cards = make();
    const id = crewCard(cards);
    const asked = cards.addMessage(id, "captain", "Plan it around kilowatts instead.");
    cards.replyFromCrewmate("t1", {
      cardId: id,
      text: "Reworking the plan around kilowatts.",
      interim: true,
      answersMessage: asked.id,
    });
    const revised = "<p>The meter now reads in kilowatts.</p>";
    cards.emitCrewmateCard(
      "t1",
      {
        id,
        title: "The meter reads in watts",
        body: revised,
        actions: [],
        reply: "Rebuilt the plan around kilowatts.",
        answersMessage: asked.id,
      },
      "Fix the meter",
      "model",
    );
    expect(cards.threadAwaitingAuthor("t1")).toBe(false);
    expect(
      cards
        .messages(id)
        .filter((line) => line.who === "crewmate")
        .map((line) => [line.text, line.answersMessage]),
    ).toEqual([
      ["Reworking the plan around kilowatts.", undefined],
      ["Rebuilt the plan around kilowatts.", asked.id],
    ]);
    cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(cards.snapshot().find((card) => card.id === id)?.body).toBe(revised);
    cards.dispose();
  });

  it("refuses a crewmate's reply that names no card or a card the record lacks", () => {
    const { make } = fixture();
    const cards = make();
    expect(cards.replyFromCrewmate("t1", { cardId: "  ", text: "Hello." })).toBe(
      "reply needs card_id: the id of the card whose thread you write in.",
    );
    expect(cards.replyFromCrewmate("t1", { cardId: "card-nowhere", text: "Hello." })).toBe(
      'Unknown card "card-nowhere". Read the card\'s id again; a reply names a card on the record.',
    );
    cards.dispose();
  });

  it("refuses each line it cannot keep word for word, and writes none of them", () => {
    const { cardStore, make } = fixture();
    const cards = make();
    const id = crewCard(cards);
    cards.hostCards.raiseHostCard({
      id: "card-host-note",
      title: "Allow the microphone",
      meta: "",
      body: "<p>Your Mac asks first.</p>",
      actions: [],
    });
    cards.hostCards.raiseHostCard({
      id: "card-host-quiet",
      title: "Nothing to say",
      meta: "",
      body: "<p>Read only.</p>",
      actions: [],
      replies: false,
    });
    const refusal = (mutation: ReturnType<CardService["replyAs"]>) =>
      mutation.effect === "refused" ? mutation.refusal : mutation.effect;
    expect(refusal(cards.replyAs(crewmate, { cardId: " ", text: "Hi." }))).toBe(
      "reply needs card_id.",
    );
    expect(refusal(cards.replyAs(crewmate, { cardId: "card-nowhere", text: "Hi." }))).toBe(
      "that id names no card on the record.",
    );
    expect(refusal(cards.replyAs(crewmate, { cardId: "card-host-quiet", text: "Hi." }))).toBe(
      "this card takes no reply.",
    );
    expect(refusal(cards.replyAs(crewmate, { cardId: "card-host-note", text: "Hi." }))).toBe(
      "this card has no thread.",
    );
    expect(refusal(cards.replyAs(crewmate, { cardId: id, text: "   " }))).toBe(
      "a reply needs some words.",
    );
    expect(
      refusal(cards.replyAs(crewmate, { cardId: id, text: "x".repeat(CARD_REPLY_MAX_CHARS + 1) })),
    ).toBe(
      `a reply is at most ${CARD_REPLY_MAX_CHARS} characters; say it shorter, or revise the card.`,
    );
    expect(refusal(cards.replyAs(firstmate, { cardId: id, text: "Done.", response }))).toBe(
      "only a crewmate's line carries a response.",
    );
    expect(refusal(cards.replyAs(crewmate, { cardId: id, text: "Done.", response }))).toBe(
      "this home cannot save a response with a card line.",
    );
    expect(cardStore.messages(id)).toEqual([]);
    cards.dispose();
  });

  it("saves a crewmate's response with its line once, and refuses one the home rejects", () => {
    const { make } = fixture();
    const submitted: unknown[] = [];
    const cards = make(undefined, undefined, {
      checkCardResponse: (_taskId, checked) => {
        if (checked.requestId !== "ask-1") throw new Error("that request is not this task's.");
      },
      submitCardResponse: (taskId, saved, text, at) => submitted.push([taskId, saved, text, at]),
    });
    const id = crewCard(cards);
    const refused = cards.replyAs(crewmate, {
      cardId: id,
      text: "Done.",
      response: { ...response, requestId: "ask-2" },
    });
    expect(refused).toMatchObject({
      effect: "refused",
      refusal: "that request is not this task's.",
    });
    const saved = cards.replyAs(crewmate, { cardId: id, text: "Done.", response });
    expect(saved.effect).toBe("reply-only");
    const line = cards.messages(id).at(-1);
    expect(line).toMatchObject({ who: "crewmate", text: "Done." });
    expect(submitted).toEqual([["t1", response, "Done.", { cardId: id, messageId: line?.id }]]);
    cards.dispose();
  });

  it("takes a dated clarification on a closed card and refuses one that names a question", () => {
    const { make } = fixture();
    const cards = make();
    const id = crewCard(cards);
    const asked = cards.addMessage(id, "captain", "Why watts?");
    cards.close(id, { kind: "crewmate", taskId: "t1" }, "answered elsewhere");
    expect(cards.has(id)).toBe(false);
    expect(
      cards.replyAs(crewmate, { cardId: id, text: "Watts fit.", answersMessage: asked.id }),
    ).toMatchObject({
      effect: "refused",
      refusal:
        "the card is closed, so a line on it answers no question; drop answers_message to add a dated clarification.",
    });
    expect(cards.replyAs(crewmate, { cardId: id, text: "Watts fit the panel." }).effect).toBe(
      "reply-only",
    );
    expect(cards.messages(id).at(-1)).toMatchObject({
      who: "crewmate",
      text: "Watts fit the panel.",
      clarification: true,
    });
    cards.dispose();
  });

  it("refuses a contribution that names no other writer's card or carries no revision it read", () => {
    const { make } = fixture();
    const cards = make();
    const id = crewCard(cards);
    const other = { actor: "crewmate", taskId: "t2" } as const;
    const refusal = (mutation: ReturnType<CardService["contribute"]>) =>
      mutation.effect === "refused" ? mutation.refusal : mutation.effect;
    const words = { title: "Watts", body: "<p>Watts.</p>", actions: [] };
    expect(refusal(cards.contribute(other, { ...words, id: "card-nowhere" }, {}))).toBe(
      "that id names no card on the record.",
    );
    expect(refusal(cards.contribute(crewmate, { ...words, id }, {}))).toBe(
      "that id names no card of someone else's; write your own card under your own id.",
    );
    expect(refusal(cards.contribute(other, { ...words, id }, {}))).toBe(
      "a revision of someone else's card names expected_revision, the revision you read; a reply alone carries reply. Read the card first.",
    );
    const revision = cards.cardRead(id)?.revision;
    expect(
      refusal(
        cards.contribute(
          other,
          { ...words, id, reply: "x".repeat(CARD_REPLY_MAX_CHARS + 1) },
          { expectedRevision: revision },
        ),
      ),
    ).toBe(`reply is at most ${CARD_REPLY_MAX_CHARS} characters; say it shorter.`);
    expect(cards.get(id)?.title).toBe("The meter reads in watts");
    cards.dispose();
  });

  // Who owes a thread its answer is cardEvidence.test.ts's fact, and the crew
  // line's exact words are cardThreads.test.ts's; this case owns what Observe
  // lists for each session and that retiring a task's cards closes them.
  it("says what the crew line and Observe read of a task's threads, and that retiring its cards closes them", () => {
    const { tasks, make } = fixture();
    const cards = make();
    const id = crewCard(cards);
    const fm = cards.addFirstmateCard({
      title: "Ship the meter fix?",
      body: "<p>It is ready.</p>",
      actions: [{ id: "ship", label: "Ship", default: true }],
    });
    expect(cards.observeThreads("t1")).toEqual([]);

    const asked = cards.addMessage(id, "captain", "Why watts?");
    cards.addMessage(fm, "captain", "Is it tested?");
    cards.replyFromCrewmate("t1", { cardId: id, text: "Watts fit.", answersMessage: asked.id });
    expect(cards.threadFact("t1")).toContain("last from crewmate");
    expect(
      cards.observeThreads("t1").map(({ cardId, title, messages }) => ({
        cardId,
        title,
        lines: messages.map((line) => [line.who, line.text]),
      })),
    ).toEqual([
      {
        cardId: id,
        title: "The meter reads in watts",
        lines: [
          ["captain", "Why watts?"],
          ["crewmate", "Watts fit."],
        ],
      },
    ]);
    expect(cards.observeThreads(FIRSTMATE_SESSION_ID).map((thread) => thread.cardId)).toEqual([fm]);
    // A question still waits on the card when its task's cards retire.
    cards.addMessage(id, "captain", "And for the panel?");
    tasks.close("t1", { status: "done", reason: "finished", actor: "host" });
    expect(cards.answerOwed(id)).toBe(true);
    cards.retireTaskCards("t1", "finished");
    expect(cards.owed(id)).toBe("closed");
    expect(cards.answerOwed(id)).toBe(false);
    cards.dispose();
  });

  // When the first mate owes an answer and that its closing words leave the
  // wait are cardThreads.test.ts's facts; this case owns the words it keeps.
  it("writes the first mate's closing words trimmed, and never blank words", () => {
    const { make } = fixture();
    const cards = make();
    const fm = cards.addFirstmateCard({
      title: "Ship the meter fix?",
      body: "<p>It is ready.</p>",
      actions: [{ id: "ship", label: "Ship", default: true }],
    });
    cards.addMessage(fm, "captain", "Is it tested?");
    expect(cards.recordFirstmateThreadAnswer(fm, "   ")).toBe(false);
    expect(cards.messages(fm).map((line) => line.who)).toEqual(["captain"]);
    expect(cards.recordFirstmateThreadAnswer(fm, "  I asked the crewmate.  ")).toBe(true);
    expect(cards.messages(fm).map((line) => [line.who, line.text])).toEqual([
      ["captain", "Is it tested?"],
      ["firstmate", "I asked the crewmate."],
    ]);
    cards.dispose();
  });
});
