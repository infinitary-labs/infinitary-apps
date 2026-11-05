import { CARD_LEAVE, cardCornerOf } from "@shared/cardLeave";
import { CARD_PRESENTATIONS, type Card, cardPresentation } from "@shared/cards";
import { expect, it, vi } from "vitest";
import { freshDatabase as openInMemoryDatabase } from "../../../tests/helpers/database";
import { CardStore } from "../storage/cardStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { CardService } from "./cardService";

// Intent: INF-1879, the captain's approved one-minus rule. The saved card is the real fixture.
for (const kind of CARD_PRESENTATIONS) {
  for (const awaiting of [undefined, "answer"] as const) {
    it(`${kind}${awaiting ? " awaiting its author" : ""}: putting away preserves work and sends the table's corner`, () => {
      const db = openInMemoryDatabase();
      const tasks = new TaskService({ db, strict: true });
      const task = seedTask(tasks, {
        id: "launch",
        title: "Review the launch window",
        status: "idle",
      });
      const store = new CardStore(db);
      const card: Card = {
        id: "card-launch-review",
        taskId: task.id,
        author: kind === "attention" ? "host" : "crewmate",
        title: "Review the launch window",
        body: "<p>The review stays beside the checklist.</p>",
        meta: "crew",
        status: "ready",
        priority: 10,
        createdAt: Date.now(),
        ...(awaiting ? { awaiting } : {}),
        actions: kind === "note" ? [] : [{ id: "wait", label: "Not now", default: true }],
      };
      store.upsert(card);
      const responded = vi.fn();
      const closed = vi.fn(() => false);
      const service = new CardService({
        now: Date.now,
        tasks,
        cardStore: store,
        syncCaptainGate: () => {},
        closeAnsweredTask: closed,
        captainResponded: responded,
        settleFacts: () => undefined,
        followupNotice: () => undefined,
        broadcastCrewCounts: () => {},
        broadcastEvent: () => {},
        broadcastCards: () => {},
        broadcastThread: () => {},
      });
      try {
        const shown = service.shown(card.id)!;
        expect(cardPresentation(shown)).toBe(kind);
        expect(shown.corner).toEqual(cardCornerOf(kind, task.key, Boolean(awaiting)));
        const operation = awaiting ? "aside" : CARD_LEAVE[kind].operation;
        expect(shown.corner?.operation).toBe(operation);
        expect(service.dismiss(shown)).toBe(operation === "read");
        expect(tasks.get(task.id)).toEqual(task);
        expect(closed).not.toHaveBeenCalled();
        // A read acknowledges an ordinary note's message, not its task.
        if (operation === "read") expect(responded).toHaveBeenCalledWith(shown, "close");
        else expect(responded).not.toHaveBeenCalled();
        if (operation === "aside") {
          expect(service.shown(card.id)).toMatchObject({ minimized: true, actions: card.actions });
          expect(store.listOpen().map((card) => card.id)).toContain(card.id);
        } else {
          expect(service.shown(card.id)).toBeUndefined();
          expect(store.past(card.id)?.title).toBe(card.title);
        }
      } finally {
        service.dispose();
        db.close();
      }
    });
  }
}

it("a read answer remains eligible for Done after restarting its owner", () => {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "launch",
    title: "Explain the launch window",
    status: "idle",
    shape: { kind: "research", deliverable: "answer" },
  });
  const store = new CardStore(db);
  store.upsert({
    id: "card-launch-answer",
    taskId: "launch",
    author: "crewmate",
    title: "The launch window is ready",
    body: "<p>The review is ready.</p>",
    meta: "crew",
    status: "ready",
    priority: 10,
    createdAt: Date.now(),
    actions: [],
    answering: true,
  });
  const responded = vi.fn();
  const make = () =>
    new CardService({
      now: Date.now,
      tasks,
      cardStore: store,
      syncCaptainGate: () => {},
      closeAnsweredTask: () => false,
      captainResponded: responded,
      settleFacts: () => undefined,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      broadcastCards: () => {},
      broadcastThread: () => {},
    });
  const first = make();
  try {
    expect(first.shown("card-launch-answer")?.answerDone?.taskId).toBe("launch");
    expect(first.dismiss(first.shown("card-launch-answer")!)).toBe(false);
    expect(responded).not.toHaveBeenCalled();
    expect(tasks.get("launch")?.status).toBe("active");
  } finally {
    first.dispose();
  }
  store.upsert({
    id: "card-fm-launch-followup",
    taskId: "launch",
    author: "firstmate",
    title: "The answer stays on its record",
    body: "<p>The answer remains available.</p>",
    meta: "firstmate",
    status: "ready",
    priority: 10,
    createdAt: Date.now() + 1,
    actions: [],
  });
  const restarted = make();
  try {
    expect(restarted.snapshot().map((card) => card.id)).toEqual(["card-fm-launch-followup"]);
    expect(restarted.answerNoteForTask("launch")?.id).toBe("card-launch-answer");
    expect(tasks.get("launch")?.status).toBe("active");
  } finally {
    restarted.dispose();
    db.close();
  }
});
