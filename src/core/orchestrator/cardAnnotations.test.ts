import { replyWithSettings } from "@shared/cardAnswerLines";
import { type CardNote, noteLabel, noteText, pointedAtLines } from "@shared/cardNotes";
import { cardNavigationParts } from "@shared/cardParts";
import { type CardAnswer, cardMessageText } from "@shared/cards";
import { taskFactsOf } from "@shared/taskFacts";
import { describe, expect, it, vi } from "vitest";
import {
  ANNOTATION_BODY,
  ANNOTATION_COMMENT,
  ANNOTATION_RANGE,
  ANNOTATION_RANGE_END,
  ANNOTATION_TITLE,
  ANNOTATION_WORDS,
} from "../../../tests/fixtures/cardAnnotations";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import {
  decodeContext,
  setup as setupFirstmate,
  tick as tickFirstmate,
} from "../../../tests/helpers/firstmateHarness";
import { taskProtocolFixture } from "../../../tests/helpers/taskProtocol";
import { CardStore } from "../storage/cardStore";
import { TaskTimeline } from "../tasks/taskTimeline";
import { noticeCard } from "./answerDelivery";
import { AskCapture, askTitle } from "./askCapture";
import { readOpenWork } from "./openWork";
import { sourceFacts } from "./workShape";

fakeCrewTimersEachTest();
const note = (): CardNote => {
  const part = cardNavigationParts(ANNOTATION_BODY)[0];
  if (!part) throw new Error("missing example paragraph");
  return {
    start: part.start,
    key: part.key,
    kind: "paragraph",
    excerpt: "A change the queue sent back showed as a plain failed check.",
    comment: ANNOTATION_COMMENT,
    line: 1,
  };
};

/** Intent: the captain's approved annotation plan sends several notes as one reply to either author. */
describe("annotation reply delivery", () => {
  it("persists a note-only reply and delivers its Pointed at lines to a crewmate once", async () => {
    const crew = fakeCrewmate();
    const h = setup(crew);
    const { taskId } = await h.supervisor.intake.commission({
      title: ANNOTATION_TITLE,
      intent: intentOf("name the queue batch on its check"),
    });
    await tick();
    await h.specs[0]?.onCard?.({
      id: "annotation-card",
      title: ANNOTATION_TITLE,
      body: ANNOTATION_BODY,
      actions: [],
    });
    const card = h.supervisor.cards.snapshot().find((c) => c.taskId === taskId);
    if (!card) throw new Error("no example card");
    const notes = [note(), { ...note(), comment: "" }];
    const reply = h.supervisor.cardActions.replyToCard(
      card.id,
      "",
      undefined,
      undefined,
      undefined,
      undefined,
      notes,
    );
    await tick();
    expect(reply.messages).toHaveLength(1);
    expect(reply.messages[0]).toMatchObject({ text: "", notes });
    expect(new CardStore(h.db).messages(card.id)[0]?.notes).toEqual(notes);
    // Review f1: normal author reads and handoffs must retain a note-only captain reply.
    const lines = pointedAtLines(notes).join("\n");
    const read = h.supervisor.cards.cardRead(card.id);
    expect(read?.thread[0]?.text).toContain(lines);
    expect(read?.waitingOn?.text).toContain(lines);
    const open = readOpenWork(
      {
        tasks: h.tasks,
        ending: h.supervisor.askEnding,
        openCards: () => h.supervisor.cards.snapshot(),
        storedCard: (id) => h.cardStore.get(id),
        pastCard: (id) => h.supervisor.cards.past(id),
        owed: (id) => h.supervisor.cards.owed(id),
        thread: (id) => h.supervisor.cards.thread(id),
        served: h.supervisor.cards.threads,
      },
      { card: card.id },
    );
    expect(JSON.parse(open.text.slice(open.text.indexOf("\n") + 1)).messages[0].text).toContain(
      lines,
    );
    const task = h.tasks.get(taskId);
    if (!task) throw new Error("missing example task");
    const basis = sourceFacts(
      { tasks: h.tasks, cardStore: h.cardStore, paths: h.paths },
      h.supervisor.cards,
      task,
    );
    expect(basis.thread?.[0]?.text).toContain(lines);
    const activity = new TaskTimeline({ tasks: h.tasks, cards: h.cardStore }).entries(taskId);
    const summary = activity.find((entry) => entry.content.ref.source === "card-message")?.summary;
    expect(summary).toContain(noteLabel(note()));
    expect(summary).toContain(ANNOTATION_COMMENT);
    const deliveries = [...crew.promptCalls, ...crew.steer.mock.calls.map(([text]) => text)].filter(
      (text) => typeof text === "string" && text.includes("Pointed at:"),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain(pointedAtLines(notes).join("\n"));
  });
  it("retains a note-only reply in the first mate's normal thread context (review f1 coverage)", async () => {
    const h = setupFirstmate();
    try {
      // Let the normal boot recovery's queued work finish before closing its database.
      await Promise.resolve();
      const id = h.supervisor.cards.addFirstmateCard({
        id: "annotation-context",
        title: ANNOTATION_TITLE,
        body: ANNOTATION_BODY,
        actions: [],
      });
      h.supervisor.cards.addMessage(id, "captain", "", undefined, undefined, undefined, false, {
        notes: [note()],
      });
      const activity = decodeContext(h.agent.buildContextBlock()).thread_activity ?? [];
      const line = activity.find((line) => line.startsWith(`- card ${id} `));
      expect(line).toContain(pointedAtLines([note()])[0]);
      expect(line).toContain(note().excerpt);
    } finally {
      h.agent.dispose();
      await h.supervisor.disposeAll();
      h.db.close();
    }
  });
  it("keeps words before notes in the first mate's turn and leaves the thread open", () => {
    const h = setup(fakeCrewmate());
    const converse = vi.fn();
    h.supervisor.setFirstmateHooks({
      notifyOp: vi.fn(),
      retryConverse: vi.fn(),
      converseAboutCard: converse,
    });
    const id = h.supervisor.cards.addFirstmateCard({
      id: "annotation-firstmate",
      title: ANNOTATION_TITLE,
      body: ANNOTATION_BODY,
      actions: [],
    });
    const notes = [note()];
    const answers: CardAnswer[] = [{ name: "checks", values: ["failed"], changed: true }];
    const reply = h.supervisor.cardActions.replyToCard(
      id,
      ANNOTATION_WORDS,
      undefined,
      undefined,
      answers,
      undefined,
      notes,
    );
    expect(converse).toHaveBeenCalledWith(
      id,
      replyWithSettings(`${ANNOTATION_WORDS}\n${pointedAtLines(notes).join("\n")}`, answers),
      undefined,
      undefined,
      [ANNOTATION_WORDS, ...notes.map(noteText)].join("\n"),
      expect.any(Number),
    );
    expect(reply.messages[0]).toMatchObject({ text: ANNOTATION_WORDS, notes });
    expect(h.supervisor.cards.snapshot().some((c) => c.id === id)).toBe(true);
  });
  /** Bug: a card reply leaked model-only targets into the captain's live and saved receipts. */
  it("uses readable notes for accepted and busy receipts while the model keeps the detailed targets", async () => {
    const h = setupFirstmate();
    try {
      const id = h.supervisor.cards.addFirstmateCard({
        title: ANNOTATION_TITLE,
        body: ANNOTATION_BODY,
        actions: [],
      });
      const parts = cardNavigationParts(ANNOTATION_BODY);
      const end = parts[1];
      if (!end) throw new Error("missing actual range endpoint");
      const notes: CardNote[] = [
        {
          ...note(),
          kind: "text",
          excerpt: `${ANNOTATION_RANGE}.\n${ANNOTATION_RANGE_END}`,
          span: {
            start: note().excerpt.indexOf(ANNOTATION_RANGE),
            end: ANNOTATION_RANGE_END.length,
            endPart: end.start,
          },
          endKey: end.key,
        },
      ];
      h.supervisor.cardActions.replyToCard(
        id,
        "",
        undefined,
        undefined,
        undefined,
        undefined,
        notes,
      );
      expect(h.events.filter((e) => e.type === "user_turn")).toEqual([
        expect.objectContaining({ type: "user_turn", text: notes.map(noteText).join("\n") }),
      ]);
      await tickFirstmate();
      expect(h.session.prompts[0]).toContain(pointedAtLines(notes).join("\n"));
      h.supervisor.cardActions.replyToCard(
        id,
        ANNOTATION_WORDS,
        undefined,
        undefined,
        undefined,
        undefined,
        notes,
      );
      expect(h.events.filter((e) => e.type === "user_turn").at(-1)).toMatchObject({
        type: "user_turn",
        text: [ANNOTATION_WORDS, ...notes.map(noteText)].join("\n"),
      });
      await tickFirstmate();
      expect(h.session.steers.at(-1)).toContain(pointedAtLines(notes).join("\n"));
      expect(h.tasks.capture.lastTurn()).toMatchObject({
        you: [ANNOTATION_WORDS, ...notes.map(noteText)].join("\n"),
        previous: { you: notes.map(noteText).join("\n") },
      });
    } finally {
      // The hook starts an async turn; settle it even when an assertion fails.
      await tickFirstmate();
      h.session.emitTurnEnd("I read both notes.");
      h.session.resolveNextPrompt();
      await tickFirstmate();
      h.agent.dispose();
      await h.supervisor.disposeAll();
      h.db.close();
    }
  });
  /** Intent: the same receipt bug must not return through the saved Ask again control. */
  it("keeps the saved readable receipt when Ask again resends the detailed model text", async () => {
    const h = setupFirstmate({
      seedTasks: [
        { id: "annotation-question", title: ANNOTATION_TITLE, kind: "question", status: "idle" },
      ],
    });
    try {
      h.tasks.close("annotation-question", { status: "done", reason: "failed", actor: "host" });
      const notes = [note()];
      const text = cardMessageText({ text: ANNOTATION_WORDS, notes });
      const receipt = [ANNOTATION_WORDS, ...notes.map(noteText)].join("\n");
      const original = h.tasks.capture.openAsk({ id: "unanswered-annotation", text, receipt });
      h.tasks.capture.attachAsk(original.id, "annotation-question", "host:fallback");
      h.tasks.capture.closeAsk(original.id, "failed");
      h.tasks.capture.setAskDelivery(original.id, "unresolved");
      const saved = h.tasks.capture.getAsk(original.id);
      expect(saved?.deliveryFacts.receipt).toBe(receipt);
      const notice = noticeCard(original.id, receipt, original.deliveryFacts.entries, {
        at: original.at,
      });
      h.supervisor.cards.put({
        ...notice,
        author: "host",
        priority: 30,
        status: "ready",
        createdAt: Date.now(),
      });
      h.supervisor.cardActions.act(notice.id, "ask-again");
      await tickFirstmate();
      expect(h.events.filter((e) => e.type === "user_turn")).toEqual([
        expect.objectContaining({ type: "user_turn", text: receipt }),
      ]);
      expect(h.session.prompts[0]).toContain(text);
      expect(h.tasks.capture.lastTurn()?.you).toBe(receipt);
      expect(h.tasks.capture.listAsks().at(-1)?.deliveryFacts).toMatchObject({
        retryOf: original.id,
        receipt,
      });
    } finally {
      await tickFirstmate();
      h.session.emitTurnEnd("I read the note.");
      h.session.resolveNextPrompt();
      await tickFirstmate();
      h.agent.dispose();
      await h.supervisor.disposeAll();
      h.db.close();
    }
  });
  /** Bug: task origin, record words and fallback titles exposed model-only annotation details. */
  it("uses the readable receipt on filed, said and fallback task views without changing saved model text", () => {
    const { db, tasks, protocol } = taskProtocolFixture();
    try {
      const capture = new AskCapture(tasks);
      const start = note().excerpt.indexOf(ANNOTATION_RANGE);
      const notes: CardNote[] = [
        {
          ...note(),
          kind: "text",
          excerpt: ANNOTATION_RANGE,
          span: { start, end: start + ANNOTATION_RANGE.length },
        },
      ];
      const text = cardMessageText({ text: "", notes });
      const receipt = notes.map(noteText).join("\n");
      const filed = capture.open({ text, receipt });
      capture.beginTurn();
      tasks.create({
        id: "filed-note",
        title: ANNOTATION_TITLE,
        prompt: "Name the failed queue check",
        repoId: null,
      });
      capture.attach("filed-note", "create_task", true);
      expect
        .soft(tasks.capture.originAbout("filed-note"))
        .toMatchObject({ kind: "asked", text: receipt });
      expect.soft(protocol.detail("filed-note").asks[0]?.text).toBe(receipt);
      expect(tasks.capture.getAsk(filed.id)?.text).toBe(text);
      capture.endTurn({ asks: [filed.id], failed: false });

      tasks.create({
        id: "existing-note",
        title: ANNOTATION_TITLE,
        prompt: "Review the queue check",
        repoId: null,
      });
      const said = capture.open({ text, receipt });
      capture.beginTurn();
      capture.attach("existing-note", "steer_crewmate", false);
      expect
        .soft(tasks.capture.originAbout("existing-note"))
        .toMatchObject({ kind: "said", text: receipt });
      expect.soft(protocol.detail("existing-note").asks[0]?.text).toBe(receipt);
      capture.endTurn({ asks: [said.id], failed: false });

      const unanswered = capture.open({ text, receipt });
      capture.beginTurn();
      const fallback = capture.endTurn({
        asks: [unanswered.id],
        failed: true,
        error: "No answer yet",
      })[0];
      if (!fallback) throw new Error("missing real fallback question");
      expect.soft(tasks.get(fallback.taskId)?.title).toBe(askTitle(receipt));
      expect
        .soft(tasks.capture.originAbout(fallback.taskId))
        .toMatchObject({ kind: "asked", text: receipt });
      expect.soft(protocol.detail(fallback.taskId).asks[0]?.text).toBe(receipt);
      expect(tasks.capture.getAsk(unanswered.id)?.text).toBe(text);
    } finally {
      protocol.dispose();
      db.close();
    }
  });
  /** Bug: ask-event views leaked model targets, and projected asks lost the verbatim-word duplicate comparison. */
  it("projects ask events for Activity, Now and readable timeline without changing exact records or repeating verbatim words", () => {
    const { db, tasks, protocol, events } = taskProtocolFixture();
    try {
      const capture = new AskCapture(tasks);
      const target = note();
      const notes = [target];
      const text = cardMessageText({ text: "", notes });
      const receipt = notes.map(noteText).join("\n");
      const ask = capture.open({ text, receipt });
      capture.beginTurn();
      tasks.create({
        id: "activity-note",
        title: ANNOTATION_TITLE,
        prompt: "Name the failed check",
        repoId: null,
      });
      capture.attach("activity-note", "create_task", true);
      const event = tasks.timeline("activity-note").find((e) => e.kind === "ask");
      if (!event) throw new Error("missing canonical ask event");
      const detail = protocol.detail("activity-note");
      expect.soft(detail.events.find((e) => e.id === event.id)?.text).toBe(receipt);
      expect.soft(detail.activityLog.find((e) => e.id === event.id)?.text).toBe(receipt);
      expect.soft(taskFactsOf(detail, (m) => m).now?.text).toBe(receipt);
      expect
        .soft(
          events.find(
            (e) => e.type === "task_event" && e.taskId === "activity-note" && e.kind === "ask",
          ),
        )
        .toMatchObject({ text: receipt });
      const timeline = new TaskTimeline({ tasks });
      const entry = timeline
        .entries("activity-note")
        .find((e) => e.content.ref.source === "task-event" && e.content.ref.eventId === event.id);
      if (!entry) throw new Error("missing ask timeline entry");
      expect.soft(entry.summary).toBe(noteLabel(target));
      expect
        .soft(timeline.history("activity-note").find((r) => r.entry.id === entry.id)?.text)
        .toBe(receipt);
      const source = timeline.sources("activity-note").find((r) => r.entry.id === entry.id)?.record;
      expect(source).toMatchObject({ source: "task-event", event: { text } });
      expect(timeline.expand("activity-note", entry.id)).toMatchObject({
        status: "available",
        record: { event: { text } },
      });
      expect(tasks.event(event.id)?.text).toBe(text);
      expect(event.feed).toBe(false);

      tasks.create({
        id: "shared-note",
        title: ANNOTATION_TITLE,
        prompt: "Read the same reply on related work",
        repoId: null,
      });
      tasks.capture.attachAsk(ask.id, "shared-note", "tool:create_task", true);
      expect(tasks.capture.asksFor("shared-note")).toHaveLength(0);
      expect
        .soft(protocol.detail("shared-note").activityLog.find((e) => e.kind === "ask")?.text)
        .toBe(receipt);
      expect
        .soft(
          new TaskTimeline({ tasks })
            .history("shared-note")
            .find((r) => r.entry.content.kind === "ask")?.text,
        )
        .toBe(receipt);

      tasks.create({
        id: "verbatim-note",
        title: ANNOTATION_TITLE,
        prompt: "Keep the task's original words",
        repoId: null,
        intent: { goal: ANNOTATION_TITLE, userWords: text },
      });
      const repeated = capture.open({ text, receipt });
      tasks.capture.attachAsk(repeated.id, "verbatim-note", "tool:create_task", true);
      expect(tasks.capture.asksFor("verbatim-note")).toHaveLength(1);
      const duplicate = protocol.detail("verbatim-note");
      expect.soft(duplicate.asks).toEqual([]);
      expect(duplicate.intent?.userWords).toBe(text);

      tasks.create({
        id: "picture-ask",
        title: ANNOTATION_TITLE,
        prompt: "Review the attached picture",
        repoId: null,
      });
      const picture = capture.open({ text: "", images: [{ mimeType: "image/png" }] });
      capture.beginTurn();
      capture.attach("picture-ask", "steer_crewmate", false);
      const imageEvent = tasks.timeline("picture-ask").find((e) => e.kind === "ask");
      if (!imageEvent) throw new Error("missing image-only ask event");
      expect(
        protocol.detail("picture-ask").activityLog.find((e) => e.id === imageEvent.id)?.text,
      ).toBe(imageEvent.text);
      expect(
        new TaskTimeline({ tasks })
          .history("picture-ask")
          .find(
            (r) =>
              r.entry.content.ref.source === "task-event" &&
              r.entry.content.ref.eventId === imageEvent.id,
          )?.text,
      ).toBe(imageEvent.text);
      capture.endTurn({ asks: [ask.id, repeated.id, picture.id], failed: false });
    } finally {
      protocol.dispose();
      db.close();
    }
  });
});
