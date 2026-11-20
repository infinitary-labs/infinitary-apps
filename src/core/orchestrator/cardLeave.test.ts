import { withAppDecline } from "@shared/cardDecline";
import { cardCornerOf, NOTE_GOT_IT_LABEL, noteDoneOf } from "@shared/cardLeave";
import { CARD_PRESENTATIONS, type Card, cardPresentation } from "@shared/cards";
import { expect, it, vi } from "vitest";
import { freshDatabase as openInMemoryDatabase } from "../../../tests/helpers/database";
import { CardStore } from "../storage/cardStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { CardService } from "./cardService";

// Intent: INF-1879's one minus, narrowed by INF-2794's approved plan: the minus
// only ever puts a card aside. The saved card is the real fixture.
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
        expect(shown.corner).toEqual(cardCornerOf(kind));
        expect(shown.corner?.operation).toBe("aside");
        // INF-2794: every live note carries its one button; nothing else does.
        expect(shown.noteDone).toEqual(kind === "note" ? noteDoneOf(task.key, false) : undefined);
        service.dismiss(shown);
        expect(tasks.get(task.id)).toEqual(task);
        expect(closed).not.toHaveBeenCalled();
        // Putting a card aside reads nothing and reaches nobody.
        expect(responded).not.toHaveBeenCalled();
        // Its choices stay as shown, the app's Decline on a decision included (INF-3108).
        expect(service.shown(card.id)).toMatchObject({
          minimized: true,
          actions: withAppDecline(card).actions,
        });
        expect(store.listOpen().map((card) => card.id)).toContain(card.id);
      } finally {
        service.dispose();
        db.close();
      }
    });
  }
}

it("an answer put aside remains eligible for Done after restarting its owner", () => {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, {
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
    // INF-2794: the answer note's button says Done, because its click closes the task.
    expect(first.shown("card-launch-answer")?.noteDone).toEqual(noteDoneOf(task.key, true));
    first.dismiss(first.shown("card-launch-answer")!);
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
    expect(restarted.shown("card-launch-answer")).toMatchObject({ minimized: true });
    expect(restarted.answerNoteForTask("launch")?.id).toBe("card-launch-answer");
    expect(tasks.get("launch")?.status).toBe("active");
  } finally {
    restarted.dispose();
    db.close();
  }
});

// Intent: INF-2794 point 4: Got it closes the note, its record keeps it, and its
// past card names the button the captain pressed.
it("a note's Got it reads it and its past card says the captain pressed Got it", () => {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true });
  const task = seedTask(tasks, { id: "launch", title: "Review the launch window", status: "idle" });
  const store = new CardStore(db);
  store.upsert({
    id: "card-launch-note",
    taskId: task.id,
    author: "crewmate",
    title: "The launch window is measured",
    body: "<p>The window opens at dawn.</p>",
    // A written card carries its lifecycle and offer, which its evidence names.
    lifecycleId: "lifecycle-launch-note",
    offerId: "offer-launch-note",
    meta: "crew",
    status: "ready",
    priority: 10,
    createdAt: Date.now(),
    actions: [],
  });
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
    const shown = service.shown("card-launch-note")!;
    expect(shown.noteDone?.label).toBe(NOTE_GOT_IT_LABEL);
    expect(service.pressNote(shown)).toBe("got-it");
    expect(responded).toHaveBeenCalledWith(shown, "close");
    expect(closed).not.toHaveBeenCalled();
    expect(tasks.get(task.id)).toEqual(task);
    expect(service.shown("card-launch-note")).toBeUndefined();
    expect(store.past("card-launch-note")?.ending).toMatchObject({
      how: "chose",
      label: NOTE_GOT_IT_LABEL,
      by: "captain",
    });
  } finally {
    service.dispose();
    db.close();
  }
});
