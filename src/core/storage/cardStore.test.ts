import { replyWithSettings } from "@shared/cardAnswerLines";
import type { Card, CardAnswer } from "@shared/cards";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { describe, expect, it } from "vitest";
import { CardStore } from "./cardStore";
import { openInMemoryDatabase } from "./db";

const card: Card = {
  id: "card-1",
  taskId: "task-1",
  author: "crewmate",
  priority: 30,
  title: "Pick one",
  meta: "crewmate 1",
  body: "Two options.",
  actions: [
    { id: "later", label: "Later", variant: "ghost" },
    { id: "go", label: "Go", variant: "primary" },
  ],
  status: "ready",
  createdAt: 1000,
};

describe("CardStore", () => {
  it("persists the continuity declaration and removes it on an unmarked revision", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    store.upsert({ ...card, holdsPlace: true });
    expect(new CardStore(db).get(card.id)?.holdsPlace).toBe(true);
    store.upsert(card);
    expect(new CardStore(db).get(card.id)).not.toHaveProperty("holdsPlace");
    db.close();
  });

  it("persists cards and restores open ones across instances", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    store.upsert(card);
    store.upsert({ ...card, body: "Two options, updated." });
    const restored = new CardStore(db).listOpen();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: "card-1", body: "Two options, updated." });
  });

  // Intent: INF-6274's review: a saved answerer this build does not know, as a
  // later alpha sharing the saved-data folder could write, leaves the card
  // showing with no answerer instead of hiding it.
  it("keeps a card's saved answerer, and shows a card whose answerer it cannot read", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    store.upsert({ ...card, author: "host", answeredBy: "crewmate" });
    expect(new CardStore(db).get(card.id)?.answeredBy).toBe("crewmate");
    db.prepare("UPDATE cards SET answered_by = ? WHERE id = ?").run("reviewer", card.id);
    const restored = new CardStore(db).get(card.id);
    expect(restored).toMatchObject({ id: card.id, title: card.title });
    expect(restored).not.toHaveProperty("answeredBy");
    db.close();
  });

  it("keeps a card's live attachment across instances, and leaves off one it cannot read", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    const attachment = {
      kind: "browser" as const,
      label: "Try it",
      taskId: "task-1",
      session: "run-1",
      generation: 2,
    };
    store.upsert({ ...card, attachment });
    expect(new CardStore(db).get("card-1")?.attachment).toEqual(attachment);
    store.upsert(card);
    expect(new CardStore(db).get("card-1")?.attachment).toBeUndefined();
    db.prepare("UPDATE cards SET attachment_json = ? WHERE id = ?").run(
      JSON.stringify({ ...attachment, kind: "flight" }),
      "card-1",
    );
    const restored = new CardStore(db).listOpen();
    expect(restored.map((c) => c.id)).toEqual(["card-1"]);
    expect(restored[0]?.attachment).toBeUndefined();
  });

  it("keeps the declaration on saved cards with historical extra risk fields", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    const declared = Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [dimension, { level: "low", why: "Existing code" }]),
    ) as RiskDeclaration;
    store.upsert({ ...card, risk: { declared } });
    db.prepare("UPDATE cards SET risk_json = ? WHERE id = ?").run(
      JSON.stringify({ declared, measured: { files: 24, lockfile: true } }),
      card.id,
    );
    expect(new CardStore(db).get(card.id)?.risk).toEqual({ declared });
    expect(new CardStore(db).listOpen()[0]?.risk).toEqual({ declared });
    db.close();
  });

  it("resolved cards leave the open list and keep the chosen action", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    store.upsert(card);
    store.resolve("card-1", "go");
    expect(store.listOpen()).toHaveLength(0);
    expect(store.chosenAction("card-1")).toBe("go");
  });

  it("a task's cards die with the task", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    store.upsert(card);
    store.upsert({ ...card, id: "card-2", taskId: "task-2" });
    store.deleteForTask("task-1");
    expect(store.listOpen().map((c) => c.id)).toEqual(["card-2"]);
  });

  it("a task's delete takes its cards' revisions and evidence with them, and nothing else's", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    const stamped = { ...card, lifecycleId: "life-1", offerId: "offer-1" };
    store.upsert(stamped);
    store.revise({ ...stamped, body: "Revised." });
    store.upsert({ ...stamped, id: "card-2", taskId: "task-2" });
    for (const [id, cardId, taskId] of [
      ["offer-1", "card-1", "task-1"],
      ["offer-2", "card-2", "task-2"],
    ] as const) {
      store.observe({
        id,
        kind: "availability",
        cardId,
        lifecycleId: "life-1",
        taskId,
        at: 1,
        actor: "host",
        source: "host",
        offerId: id,
        payload: { state: "available", cause: "put" },
      });
    }
    expect(store.history("card-1")).toHaveLength(1);

    store.deleteForTask("task-1");
    expect(store.history("card-1")).toEqual([]);
    expect(store.observations("card-1")).toEqual([]);
    expect(store.observations("card-2").map((observation) => observation.id)).toEqual(["offer-2"]);
  });

  it("reads a row whatever its kind column says: the wire carries none (cards/tasks/agents P1)", () => {
    const db = openInMemoryDatabase();
    const insert = db.prepare(
      `INSERT INTO cards (id, task_id, kind, author, priority, title, meta, body, actions_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Rows an older build wrote under its kinds, and one written today.
    insert.run(
      "card-legacy",
      null,
      "status",
      "firstmate",
      15,
      "Legacy note",
      "firstmate",
      "Still worth showing.",
      "[]",
      "ready",
      1000,
    );
    insert.run(
      "card-t1",
      "t1",
      "task-result",
      "crewmate",
      10,
      "Fix the meter",
      "crewmate 1 · fm/task-t1",
      "Fixed; PR open.",
      "[]",
      "ready",
      1001,
    );
    insert.run(
      "card-t2",
      "t2",
      "live-prototype",
      "crewmate",
      30,
      "Two treatments",
      "crewmate 2",
      "<canvas></canvas>",
      JSON.stringify([{ id: "a", label: "A", default: true }]),
      "ready",
      1002,
    );
    const store = new CardStore(db);
    store.upsert({ ...card, id: "card-now", createdAt: 1003 });
    const restored = store.listOpen();
    expect(restored.map((row) => row.id)).toEqual([
      "card-legacy",
      "card-t1",
      "card-t2",
      "card-now",
    ]);
    for (const row of restored) expect(row).not.toHaveProperty("kind");
    expect(restored[0]).toMatchObject({ author: "firstmate", title: "Legacy note", actions: [] });
    expect(restored[2]?.actions).toEqual([{ id: "a", label: "A", default: true }]);
    // The column is kept for the schema's sake and says `card` for every new row.
    expect(db.prepare("SELECT kind FROM cards WHERE id = 'card-now'").get()).toEqual({
      kind: "card",
    });
  });

  it("keeps the replaced version when an emitter revises an open card in place (WI-12)", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    store.upsert(card);
    // A write that changes nothing an emitter authored (a status flip) is no revision.
    store.revise({ ...card, status: "streaming" });
    expect(store.history("card-1")).toEqual([]);
    store.revise({ ...card, body: "Two options, explained.", status: "ready" });
    store.revise({ ...card, title: "Pick one now", body: "One option left." });
    expect(store.get("card-1")).toMatchObject({ title: "Pick one now", body: "One option left." });
    expect(store.history("card-1")).toMatchObject([
      { revision: 1, title: "Pick one", body: "Two options.", replacedBy: "card-1" },
      { revision: 2, title: "Pick one", body: "Two options, explained.", replacedBy: "card-1" },
    ]);
    expect(store.history("card-1")[0]?.actions).toEqual(card.actions);
    expect(store.listOpen()).toHaveLength(1);
  });

  it("stamps the duplicate label write-once and refuses what it cannot label (WI-14)", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    store.upsert(card);
    store.upsert({ ...card, id: "card-2", title: "Pick one again" });
    expect(store.flagDuplicate({ cardId: "card-2", duplicateOf: "card-2", note: "x" })).toEqual({
      status: "same-card",
      cardId: "card-2",
    });
    expect(store.flagDuplicate({ cardId: "ghost", duplicateOf: "card-1", note: "x" }).status).toBe(
      "no-card",
    );
    expect(store.flagDuplicate({ cardId: "card-2", duplicateOf: "ghost", note: "x" }).status).toBe(
      "no-original",
    );
    expect(
      store.flagDuplicate({ cardId: "card-2", duplicateOf: "card-1", note: "same card", at: 5 }),
    ).toEqual({
      status: "flagged",
      card: { id: "card-2", title: "Pick one again", resolved: false },
      original: { id: "card-1", title: "Pick one", resolved: false },
      at: 5,
    });
    expect(
      store.flagDuplicate({ cardId: "card-2", duplicateOf: "card-1", note: "again" }),
    ).toMatchObject({ status: "already-flagged", duplicateOf: "card-1", note: "same card" });
    expect(store.duplicateLabel("card-2")).toEqual({
      duplicateOf: "card-1",
      note: "same card",
      at: 5,
    });
    expect(store.duplicateLabel("card-1")).toBeUndefined();
  });

  // INF-3641: one task's resolution read seeks that task's own cards instead
  // of walking every answered card, and must answer exactly as the walk did.
  it("answers one task's resolutions as the walk of every answered card filtered to it", () => {
    const db = openInMemoryDatabase();
    const store = new CardStore(db);
    const tasks = ["task-a", "task-b", "task-c", "task-d"];
    let now = 10_000;
    const clock = () => now;
    const realNow = Date.now;
    Date.now = clock;
    try {
      // Interleaved resolutions across tasks, some in the same millisecond,
      // by the captain's actions, a dismissal and the app's own closes.
      const chosen = ["go", "later", "close", "task-retired", "go", "duplicate"];
      for (let n = 0; n < 60; n += 1) {
        const taskId = tasks[(n * 7) % tasks.length] as string;
        const id = `card-${String(n).padStart(2, "0")}-${taskId}`;
        store.upsert({ ...card, id, taskId, title: `Card ${n}`, createdAt: 1000 + n });
        if (n % 9 === 8) continue;
        if (n % 4 !== 0) now += 5;
        store.resolve(id, chosen[n % chosen.length] as string);
      }
      // Two of one task's cards resolved in the same millisecond: the id orders them.
      now += 5;
      for (const taskId of tasks)
        for (const suffix of ["z", "a"]) {
          const id = `card-tie-${suffix}-${taskId}`;
          store.upsert({ ...card, id, taskId, title: `Tie ${suffix}`, createdAt: 2000 });
          store.resolve(id, "go");
        }
    } finally {
      Date.now = realNow;
    }
    const keeps: ((resolution: { card: Card; action: string }) => boolean)[] = [
      () => true,
      ({ card: shown, action }) =>
        action === "close" || shown.actions.some((entry) => entry.id === action),
      ({ action }) => action === "task-retired",
    ];
    for (const taskId of [...tasks, "task-none"])
      for (const keep of keeps)
        for (const since of [0, 10_050, 10_150, 99_999])
          for (const limit of [1, 3, 100]) {
            const walked = store.resolvedSince(
              since,
              limit,
              (resolution) => resolution.card.taskId === taskId && keep(resolution),
            );
            expect(store.resolvedSince(since, limit, keep, taskId)).toEqual(walked);
          }
    expect(store.resolvedSince(0, 100, () => true, "task-a").length).toBeGreaterThan(5);
    db.close();
  });

  /**
   * The card thread (cards-as-threads phase 1, migration 38). The store is
   * the record: append, read back in order, and die with the card.
   */
  describe("the card thread", () => {
    it("keeps a card's messages in the order they were written", () => {
      const db = openInMemoryDatabase();
      const store = new CardStore(db);
      store.upsert(card);
      store.appendMessage({ cardId: "card-1", who: "captain", text: "the checks failed", at: 10 });
      store.appendMessage({ cardId: "card-1", who: "crewmate", text: "fixed at 4f1c2e0", at: 20 });
      store.appendMessage({ cardId: "card-1", who: "host", text: "revised: Pick one", at: 30 });
      expect(new CardStore(db).messages("card-1")).toMatchObject([
        { who: "captain", text: "the checks failed", at: 10 },
        { who: "crewmate", text: "fixed at 4f1c2e0", at: 20 },
        { who: "host", text: "revised: Pick one", at: 30 },
      ]);
      expect(store.messages("card-2")).toEqual([]);
    });

    it("answers whose turn it is from the persisted current hold, not historical messages", () => {
      const db = openInMemoryDatabase();
      const store = new CardStore(db);
      store.upsert(card);
      // No thread at all is nobody's turn, not the author's.
      expect(store.awaitingAuthor("card-1")).toBe(false);
      store.appendMessage({ cardId: "card-1", who: "captain", text: "what about X?", at: 10 });
      store.upsert({ ...card, awaiting: "answer" });
      expect(store.awaitingAuthor("card-1")).toBe(true);
      store.appendMessage({ cardId: "card-1", who: "crewmate", text: "kept it", at: 20 });
      store.upsert({ ...card, awaiting: "close-out" });
      expect(store.awaitingAuthor("card-1")).toBe(false);
      // A host line is not an answer the captain asked for, but it is also
      // not the captain speaking: the author no longer owes a reply.
      store.appendMessage({ cardId: "card-1", who: "host", text: "revised: Pick one", at: 30 });
      expect(store.awaitingAuthor("card-1")).toBe(false);
    });

    it("summarizes only the threads that moved inside the window", () => {
      const db = openInMemoryDatabase();
      const store = new CardStore(db);
      store.upsert(card);
      store.upsert({ ...card, id: "card-2", title: "Pick again" });
      store.appendMessage({ cardId: "card-1", who: "captain", text: "old news", at: 10 });
      store.appendMessage({ cardId: "card-2", who: "captain", text: "and this?", at: 100 });
      store.appendMessage({ cardId: "card-2", who: "crewmate", text: "kept it", at: 110 });
      expect(store.threadSummaries(50)).toMatchObject([
        { cardId: "card-2", count: 2, last: { who: "crewmate", text: "kept it", at: 110 } },
      ]);
      expect(store.threadSummaries(0).map((row) => row.cardId)).toEqual(["card-2", "card-1"]);
      expect(store.threadSummaries(0, 1).map((row) => row.cardId)).toEqual(["card-2"]);
      // The per-card stat answers the crew line without loading the thread.
      expect(store.threadStat("card-2")).toMatchObject({ count: 2, last: { who: "crewmate" } });
      expect(store.threadStat("card-1")).toMatchObject({ count: 1, last: { who: "captain" } });
      expect(store.threadStat("card-none")).toBeUndefined();
    });

    it("reads a reply's settings apart from his words, only where they are the app's own", () => {
      const db = openInMemoryDatabase();
      const store = new CardStore(db);
      store.upsert(card);
      const answers: CardAnswer[] = [
        { name: "look", values: ['{"tiltDeg":42}'], changed: true, json: true },
        { name: "tone", values: ["plain"], labels: ["Plain"], changed: false },
      ];
      // Saved the way CardService.addMessage saves a reply: the text its
      // author read, and the message_ref with the answers in one go.
      const reply = (text: string, recorded?: CardAnswer[]) =>
        store.transaction(() => {
          const message = store.appendMessage({ cardId: "card-1", who: "captain", text, at: 10 });
          store.observe({
            id: `ref-${message.id}`,
            kind: "message_ref",
            cardId: "card-1",
            lifecycleId: "life-1",
            at: 10,
            actor: "captain",
            source: "thread",
            messageId: message.id,
            payload: {
              messageId: message.id,
              who: "captain",
              ...(recorded ? { answers: recorded } : {}),
            },
          });
        });
      reply(replyWithSettings("tilt it more", answers), answers);
      reply(`${replyWithSettings("see this", answers)}\n[attached shot.png]`, answers);
      reply(`${replyWithSettings("", answers)}\n[attached shot.png]`, answers);
      // Not the app's own rendering of what was recorded: shown whole.
      const typed = "keep it\nCurrent settings (context, not permission):\n- look: by hand";
      reply(typed, answers);
      reply("plain words");
      store.appendMessage({
        cardId: "card-1",
        who: "crewmate",
        text: replyWithSettings("an echo", answers),
        at: 20,
      });
      expect(
        new CardStore(db)
          .messages("card-1")
          .map(({ who, text, answers }) => ({ who, text, answers })),
      ).toEqual([
        { who: "captain", text: "tilt it more", answers },
        { who: "captain", text: "see this\n[attached shot.png]", answers },
        { who: "captain", text: "[attached shot.png]", answers },
        { who: "captain", text: typed, answers: undefined },
        { who: "captain", text: "plain words", answers: undefined },
        { who: "crewmate", text: replyWithSettings("an echo", answers), answers: undefined },
      ]);
      // The newest line the context section quotes reads the same way.
      reply(replyWithSettings("last one", answers), answers);
      expect(store.threadStat("card-1")?.last).toMatchObject({ text: "last one", answers });
    });

    it("lets the thread die with its card when the task closes", () => {
      const db = openInMemoryDatabase();
      const store = new CardStore(db);
      store.upsert(card);
      store.upsert({ ...card, id: "card-other", taskId: "task-2" });
      store.appendMessage({ cardId: "card-1", who: "captain", text: "gone with it", at: 10 });
      store.appendMessage({ cardId: "card-other", who: "captain", text: "kept", at: 10 });
      store.deleteForTask("task-1");
      expect(store.messages("card-1")).toEqual([]);
      expect(store.messages("card-other")).toHaveLength(1);
    });
  });

  it("hands a basis the card the captain answered, not the merge card its build ended on", () => {
    const store = new CardStore(openInMemoryDatabase());
    store.upsert({ ...card, id: "prototype", createdAt: 1000 });
    store.upsert({
      ...card,
      id: "completion",
      createdAt: 2000,
      actions: [
        {
          id: "merge",
          label: "Merge",
          variant: "primary",
          effect: { kind: "merge", after: "close" },
        },
      ],
    });
    expect(store.newestForTask("task-1")?.id).toBe("completion");
    expect(store.newestAnswerForTask("task-1")?.id).toBe("prototype");
    store.upsert({
      ...card,
      id: "only-merge",
      taskId: "task-2",
      actions: store.newestForTask("task-1")?.actions ?? [],
    });
    expect(store.newestAnswerForTask("task-2")?.id).toBe("only-merge");
  });

  it("hands a basis its crewmate's card the captain chose on, past later notes and other authors' cards", () => {
    const store = new CardStore(openInMemoryDatabase());
    store.upsert({ ...card, id: "prototype", createdAt: 1000 });
    store.resolve("prototype", "go");
    // Cards filed under the task after the choice: a Firstmate decision the
    // captain answered, the host's stall card, a crewmate note the captain
    // closed and one the task retired.
    store.upsert({ ...card, id: "firstmate", author: "firstmate", createdAt: 2000 });
    store.resolve("firstmate", "go");
    store.upsert({ ...card, id: "stall", author: "host", createdAt: 3000 });
    store.resolve("stall", "go");
    store.upsert({ ...card, id: "closed-note", actions: [], createdAt: 4000 });
    store.resolve("closed-note", "close");
    store.upsert({ ...card, id: "retired-note", createdAt: 5000 });
    store.resolve("retired-note", "task-retired");
    expect(store.newestAnswerForTask("task-1")?.id).toBe("prototype");

    // With no choice on any of its crewmate's cards, the newest of them is
    // the answer - a replaced proposal or a closed note - and a task with
    // only Firstmate's cards has none.
    store.upsert({ ...card, id: "replaced", taskId: "task-2", createdAt: 1000 });
    store.appendMessage({ cardId: "replaced", who: "captain", text: "redo it", at: 1500 });
    store.resolve("replaced", "Superseded by the revised answer.");
    store.upsert({ ...card, id: "final", taskId: "task-2", actions: [], createdAt: 2000 });
    store.resolve("final", "close");
    store.upsert({ ...card, id: "firstmate-2", taskId: "task-2", author: "firstmate" });
    expect(store.newestAnswerForTask("task-2")?.id).toBe("final");
    store.upsert({ ...card, id: "firstmate-only", taskId: "task-3", author: "firstmate" });
    expect(store.newestAnswerForTask("task-3")).toBeUndefined();
  });
});

it("leaves an unreadable revision association unavailable during close-out", () => {
  const db = openInMemoryDatabase();
  const store = new CardStore(db);
  store.upsert(card);
  const row = store.appendMessage({ cardId: card.id, who: "host", text: "Legacy revision" });
  db.prepare("UPDATE card_messages SET revision_json = ? WHERE id = ?").run("{broken", row.id);
  expect(store.messages(card.id)[0]?.revision).toBeUndefined();
  expect(store.releaseRevisions(card.id, "life")).toBe(false);
});
