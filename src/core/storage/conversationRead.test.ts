import type { Card } from "@shared/cards";
import type { ConversationRound } from "@shared/conversation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { CardService } from "../orchestrator/cardService";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { CardStore } from "./cardStore";
import { readConversation } from "./conversationRead";

/**
 * Intent: INF-6337's approved plan, "a thread that has everything the user
 * directly interacted with - their own prompts, first mate's response,
 * cards they interacted". The rounds are written by their real owners -
 * the capture side for messages, the card service for presses and lines -
 * into one migrated database, and read back through the conversation's read.
 */
function fixture() {
  const db = freshDatabase();
  let clock = Date.UTC(2026, 10, 23, 18);
  const tick = () => {
    clock += 1_000;
    vi.setSystemTime(clock);
    return clock;
  };
  const tasks = new TaskService({ db, strict: true, now: () => clock });
  const cards = new CardService({
    now: () => clock,
    tasks,
    cardStore: new CardStore(db),
    syncCaptainGate: () => {},
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: () => {},
    broadcastThread: () => {},
  });
  seedTask(tasks, { id: "panel", title: "Chart the backlog", status: "running" });
  const message = (id: string, text: string, reply?: string) => {
    tasks.capture.openAsk({ id, text, at: tick() });
    if (reply) tasks.capture.setAskReply(id, { text: reply });
  };
  const crewCard = (id: string, title: string): Card => {
    tick();
    const emitted = cards.emitCrewmateCard(
      "panel",
      {
        id,
        title,
        body: "<p>A panel that charts the backlog.</p>",
        actions: [
          { id: "build", label: "Approve and build", default: true },
          { id: "defer", label: "Save and defer" },
        ],
      },
      "model",
    );
    cards.closeOut({ kind: "crewmate", taskId: "panel" }, "report");
    return cards.shown(emitted) as Card;
  };
  return { db, cards, tasks, message, crewCard, tick };
}

const summary = (round: ConversationRound) =>
  round.kind === "message"
    ? `message ${round.you} -> ${round.reply?.text ?? "none"}`
    : round.kind === "choice"
      ? `choice ${round.card.title}: ${round.label}`
      : `reply ${round.card.title}: ${round.you} -> ${round.answer?.text ?? "none"}`;

describe("the conversation's read", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges messages, the captain's own presses and lines under cards, newest first", () => {
    const { db, cards, message, crewCard, tick } = fixture();
    message("ask-1", "can a panel track my backlog?", "Yes. I started a plan for it.");
    const plan = crewCard("plan", "A panel that charts your backlog");
    tick();
    cards.resolve(plan, "build", "build");
    // A card's own script choosing is not the captain's act.
    const scripted = crewCard("scripted", "A choice the card made itself");
    tick();
    cards.resolve(scripted, "defer", "defer", undefined, "crewmate");
    const asked = crewCard("asked", "Which chart reads best?");
    tick();
    cards.addMessage(asked.id, "captain", "use bars, not lines");
    tick();
    cards.addMessage(asked.id, "crewmate", "Bars it is.");
    // Got it on a note is a press of the note's own button.
    tick();
    const noteId = cards.addFirstmateCard({
      title: "Reminder set",
      body: "<p>Friday.</p>",
      actions: [],
    });
    tick();
    expect(cards.pressNote(cards.shown(noteId) as Card)).toBe("got-it");

    const page = readConversation(db);
    expect(page.more).toBe(false);
    expect(page.rounds.map(summary)).toEqual([
      "choice Reminder set: Got it",
      "reply Which chart reads best?: use bars, not lines -> Bars it is.",
      "choice A panel that charts your backlog: Approve and build",
      "message can a panel track my backlog? -> Yes. I started a plan for it.",
    ]);
    expect(page.rounds[1]).toMatchObject({ card: { id: asked.id, taskKey: expect.any(String) } });
    expect(page.rounds[2]).toMatchObject({ card: { presentation: "decision" } });
    expect(page.rounds[0]).toMatchObject({ card: { presentation: "note" } });
  });

  it("draws a line typed under the first mate's own card once, with its card and answer", () => {
    const { db, cards, tasks, tick } = fixture();
    tick();
    const id = cards.addFirstmateCard({
      title: "Your reminders",
      body: "<p>One reminder on Friday.</p>",
      actions: [],
    });
    tick();
    const line = cards.addMessage(id, "captain", "move it to Monday");
    tasks.capture.openAsk({
      id: "under-card",
      text: "move it to Monday",
      at: line.at,
      typedUnder: { cardId: id, line: line.id },
    });
    tasks.capture.setAskReply("under-card", { text: "Moved to Monday." });
    tick();
    cards.addMessage(id, "firstmate", "Moved to Monday at 9:00 AM.");

    const { rounds } = readConversation(db);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      kind: "reply",
      card: { id, title: "Your reminders", presentation: "note" },
      you: "move it to Monday",
      answer: { who: "firstmate", text: "Moved to Monday at 9:00 AM." },
      reply: { text: "Moved to Monday." },
    });
  });

  it("gives two lines in a row under one card only the answer that followed each", () => {
    const { db, cards, crewCard, tick } = fixture();
    const asked = crewCard("asked", "Which chart reads best?");
    tick();
    cards.addMessage(asked.id, "captain", "use bars");
    tick();
    cards.addMessage(asked.id, "captain", "and a weekly scale");
    tick();
    cards.addMessage(asked.id, "crewmate", "Bars, weekly.");

    expect(readConversation(db).rounds.map(summary)).toEqual([
      "reply Which chart reads best?: and a weekly scale -> Bars, weekly.",
      "reply Which chart reads best?: use bars -> none",
    ]);
  });

  it("pages back from a cursor with no round twice and none skipped", () => {
    const { db, message } = fixture();
    for (let n = 1; n <= 35; n += 1) message(`ask-${String(n).padStart(2, "0")}`, `message ${n}`);

    const first = readConversation(db);
    expect(first.rounds).toHaveLength(30);
    expect(first.more).toBe(true);
    const last = first.rounds.at(-1) as ConversationRound;
    const second = readConversation(db, { before: { at: last.at, id: last.id } });
    expect(second.more).toBe(false);
    const said = [...first.rounds, ...second.rounds].map((round) =>
      round.kind === "message" ? round.you : "",
    );
    expect(said).toEqual(Array.from({ length: 35 }, (_, i) => `message ${35 - i}`));
  });

  // INF-6763's approved plan, part 2: the conversation shows a taken-back
  // message marked, and a replacement as edited with the earlier words.
  it("marks a taken-back message and gives a replacement the words it replaced", () => {
    const { db, tasks, message, tick } = fixture();
    message("withdrawn", "delete the old logs");
    tasks.capture.takeBack("withdrawn");
    message("first", "rename the release channel");
    tasks.capture.openAsk({
      id: "second",
      text: "rename the beta channel instead",
      correctionOf: "first",
      at: tick(),
    });
    const [second, first, withdrawn] = readConversation(db).rounds;
    expect(second).toMatchObject({ you: "rename the beta channel instead" });
    expect(second).toHaveProperty("replaces", "rename the release channel");
    expect(second).not.toHaveProperty("takenBack");
    expect(first).toMatchObject({ you: "rename the release channel", takenBack: true });
    expect(first).not.toHaveProperty("replaces");
    expect(withdrawn).toMatchObject({ you: "delete the old logs", takenBack: true });
  });
});
