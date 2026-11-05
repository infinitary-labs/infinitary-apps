import { type Card, isReadyDecision } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import { nowGroupOf, nowGroupsOf, taskStatusWord } from "@shared/nowPanel";
import { recordBarOf } from "@shared/recordBar";
import {
  applyTaskBoardDelta,
  type ProjectView,
  type TaskBoard,
  type TaskBoardDelta,
  type TaskDetail,
} from "@shared/tasks";
import { presentBoard, presentProjects, presentTask } from "@shared/taskWaiting";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase as openInMemoryDatabase } from "../../../tests/helpers/database";
import { type ReadApi, ReadExecutor } from "../../renderer/src/plugins/reads/executor";
import { CardService } from "../orchestrator/cardService";
import { CardStore } from "../storage/cardStore";
import { TaskProtocol } from "./taskProtocol";
import { TaskService } from "./taskService";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("The journey prerequisite is missing.");
  return value;
}

const decision = {
  id: "choice",
  title: "Choose a route",
  body: "<p>Choose the route.</p>",
  actions: [
    { id: "go", label: "Go" },
    { id: "wait", label: "Wait" },
  ],
};

/** Real producers and catalog consumers, with only the transport in memory. */
function setup(delta = false) {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true, now: () => 1000 });
  const cardStore = new CardStore(db);
  const events: FmEvent[] = [];
  const eventListeners = new Set<(event: FmEvent) => void>();
  const pushes = new Map<string, Set<(value: unknown) => void>>();
  const localListeners = new Set<() => void>();
  const delivery: { channel: string; value: unknown }[] = [];
  let paused = false;
  let localCards: Card[] = [];
  let rawBoard: TaskBoard;
  const emit = (channel: string, value: unknown) => {
    delivery.push({ channel, value });
    if (paused) return;
    for (const listener of pushes.get(channel) ?? []) listener(value);
  };
  const makeCards = () =>
    new CardService({
      now: () => 1000,
      tasks,
      cardStore,
      syncCaptainGate: () => {},
      noteCapAnswered: () => {},
      closeAnsweredTask: () => false,
      settleFacts: () => undefined,
      followupNotice: () => undefined,
      broadcastCrewCounts: () => {},
      broadcastEvent: () => {},
      presentationChanged: () => tasks.invalidatePresentation(),
      broadcastCards: (snapshot) => {
        if (!paused) localCards = snapshot;
        emit("inf:cards", snapshot);
        if (!paused) for (const listener of localListeners) listener();
      },
    });
  let cards = makeCards();
  const protocol = new TaskProtocol({
    tasks,
    repos: { get: () => undefined },
    cards: {
      listOpen: () => cardStore.listOpen(),
      snapshot: () => cards.snapshot(),
      answerNoteForTask: (id) => cards.answerNoteForTask(id),
    },
    beforePush: () => cards.flushBroadcast(),
    now: () => 1000,
    ...(delta ? { deltaTrigger: { rows: 0, bytes: 0 } } : {}),
    broadcastEvent: (event) => {
      events.push(event);
      for (const listener of eventListeners) listener(event);
    },
    emit,
  });
  const api: ReadApi = {
    read: async (name, args) => {
      if (name === "tasks.board") return protocol.board();
      if (name === "tasks.detail") return protocol.detail((args as { id: string }).id);
      rawBoard = protocol.board();
      return protocol.projects();
    },
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onPush: (channel, listener) => {
      const set = pushes.get(channel) ?? new Set();
      pushes.set(channel, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    onPresentation: (listener) => {
      localListeners.add(listener);
      return () => localListeners.delete(listener);
    },
    present: (name, value) => {
      if (name === "tasks.board") {
        rawBoard = value as TaskBoard;
        return presentBoard(rawBoard, localCards);
      }
      if (name === "tasks.detail") return presentTask(value as TaskDetail, localCards);
      return presentProjects(value as ProjectView[], presentBoard(rawBoard, localCards).tasks);
    },
  };
  const executor = new ReadExecutor(api);
  const errors: unknown[] = [];
  const boards: TaskBoard[] = [],
    details: TaskDetail[] = [],
    projects: ProjectView[][] = [];
  const stops: (() => void)[] = [];
  const subscribe = (id: string) => {
    stops.push(
      executor.subscribe(
        "tasks.board",
        {},
        { onValue: (v) => boards.push(v as TaskBoard), onError: (e) => errors.push(e) },
      ),
    );
    stops.push(
      executor.subscribe(
        "tasks.detail",
        { id },
        { onValue: (v) => details.push(v as TaskDetail), onError: (e) => errors.push(e) },
      ),
    );
    stops.push(
      executor.subscribe(
        "projects.list",
        {},
        { onValue: (v) => projects.push(v as ProjectView[]), onError: (e) => errors.push(e) },
      ),
    );
  };
  const flush = async () => {
    await vi.advanceTimersByTimeAsync(200);
    expect(errors).toEqual([]);
  };
  const assertWaiting = (id: string, expected: string | null) => {
    const detail = protocol.detail(id);
    expect(detail.waitingCardId).toBe(expected);
    expect(boards.at(-1)?.tasks.find((task) => task.id === id)?.waitingCardId).toBe(expected);
    expect(details.at(-1)?.waitingCardId).toBe(expected);
    expect(projects.at(-1)?.[0]?.counts.waitingOnYou).toBe(expected ? 1 : 0);
    // The Tasks panel's collapsed "N waiting" counts each task by its own group.
    expect(
      required(boards.at(-1)).tasks.filter((task) => nowGroupOf(task) === "waiting").length,
    ).toBe(expected ? 1 : 0);
    expect(nowGroupOf(detail) === "waiting").toBe(Boolean(expected));
    expect(taskStatusWord(detail) === "Waiting on you").toBe(Boolean(expected));
    expect(recordBarOf(detail)?.next === "show-card").toBe(Boolean(expected));
  };
  return {
    tasks,
    protocol,
    cardStore,
    get cards() {
      return cards;
    },
    events,
    delivery,
    boards,
    details,
    subscribe,
    flush,
    assertWaiting,
    pauseTransport: (value: boolean) => {
      paused = value;
    },
    transport: emit,
    local: (snapshot: Card[]) => {
      localCards = snapshot;
      for (const listener of localListeners) listener();
    },
    restart: () => {
      cards.flushBroadcast();
      cards = makeCards();
    },
    dispose: () => {
      cards.flushBroadcast();
      for (const stop of stops) stop();
      protocol.dispose();
      db.close();
    },
  };
}

describe("ready decisions and saved answers are the waiting facts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("INF-1879: a saved answer stays in waiting rows and project counts after reading and restart", async () => {
    const h = setup(true);
    try {
      h.tasks.create({
        id: "answer",
        title: "Explain the launch window",
        prompt: "Explain the launch window without changing it.",
        repoId: null,
        shape: { kind: "research", deliverable: "answer" },
      });
      h.tasks.dispatch("answer", {
        workspace: { repoDir: "r", worktreeDir: "w", branch: "b" },
        accountId: null,
        assignee: "crew",
      });
      h.tasks.setActivity("answer", "idle");
      h.subscribe("answer");
      const id = h.cards.emitCrewmateCard(
        "answer",
        {
          title: "The launch window is ready",
          body: "<p>The review stays beside the launch checklist.</p>",
          actions: [],
          answering: true,
        },
        "route",
      );
      h.cards.closeOut({ kind: "crewmate", taskId: "answer" }, "report");
      await h.flush();
      h.cards.dismiss(required(h.cards.shown(id)));
      await h.flush();
      h.restart();
      await h.flush();
      const detail = h.protocol.detail("answer");
      expect(detail).toMatchObject({
        status: "active",
        answerNoteId: id,
        flags: { needsYou: true },
      });
      expect(detail.waitingCardId).toBeNull();
      expect(nowGroupOf(detail)).toBe("waiting");
      expect(recordBarOf(detail)?.next).toBe("answer-done");
      expect(h.protocol.projects()[0]?.counts.waitingOnYou).toBe(1);
      expect(h.boards.at(-1)?.projects[0]?.counts.waitingOnYou).toBe(1);
      expect(h.details.at(-1)?.answerNoteId).toBe(id);
      expect(h.cards.snapshot()).toEqual([]);
    } finally {
      h.dispose();
    }
  });

  it("a declaration alone never counts as waiting, including after a ready card closes", async () => {
    const h = setup(true);
    try {
      h.tasks.create({ id: "t", title: "Open the pull request", prompt: "p", repoId: null });
      h.tasks.dispatch("t", {
        workspace: { repoDir: "r", worktreeDir: "w", branch: "b" },
        accountId: null,
        assignee: "crew",
      });
      h.tasks.setActivity("t", "idle");
      h.tasks.recordReport("t", {
        text: "The session cannot open a pull request.",
        declared: { wait: { reason: "A required tool is missing." } },
      });
      h.subscribe("t");
      await h.flush();
      h.assertWaiting("t", null);
      const id = h.cards.emitCrewmateCard("t", decision, "route");
      await h.flush();
      h.assertWaiting("t", null);
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "report");
      await h.flush();
      h.assertWaiting("t", id);
      // Local reply masking cannot let the declaration resurrect waiting.
      h.local(h.cards.snapshot().map((card) => ({ ...card, awaiting: "answer" })));
      expect(h.boards.at(-1)?.projects[0]?.counts.waitingOnYou).toBe(0);
      expect(nowGroupOf(required(h.details.at(-1)))).toBe("working");
      h.local(h.cards.snapshot());
      // INF-1879: a real choice, not the minimize corner, closes the ready decision.
      h.cards.resolve(required(h.cards.shown(id)), "go", "go", undefined, "captain");
      await h.flush();
      h.assertWaiting("t", null);
      expect(h.protocol.detail("t").outcomeSummary).toBe("The session cannot open a pull request.");
      expect(h.tasks.get("t")?.delivery?.captainWait?.reason).toBe("A required tool is missing.");
      h.restart();
      await h.flush();
      h.assertWaiting("t", null);
    } finally {
      h.dispose();
    }
  });

  it("recovers missed presentation deltas and ignores stale ready snapshots through the real read executor", async () => {
    const h = setup(true);
    try {
      h.tasks.create({ id: "t", title: "Route", prompt: "p", repoId: null });
      h.subscribe("t");
      const id = h.cards.emitCrewmateCard("t", decision, "route");
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "report");
      await h.flush();
      h.assertWaiting("t", id);
      const ready = h.protocol.board();
      h.pauseTransport(true);
      const first = h.cards.addMessage(id, "captain", "Why this choice?");
      await h.flush();
      h.cards.replyFromCrewmate("t", {
        cardId: id,
        text: "This is the safer choice.",
        answersMessage: first.id,
      });
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "idle");
      await h.flush();
      h.pauseTransport(false);
      const second = h.cards.addMessage(id, "captain", "Why this choice?");
      await h.flush();
      h.assertWaiting("t", null);
      expect(h.boards.at(-1)?.seq).toBe(h.protocol.board().seq);
      const delta = h.delivery.findLast((entry) => entry.channel === "inf:tasks:delta")
        ?.value as TaskBoardDelta;
      expect(delta.baseSeq).toBeGreaterThan(ready.seq);
      h.transport("inf:tasks", ready);
      expect(h.boards.at(-1)?.seq).toBe(h.protocol.board().seq);
      h.assertWaiting("t", null);
      h.cards.replyFromCrewmate("t", {
        cardId: id,
        text: "This is the safer choice.",
        answersMessage: second.id,
      });
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "idle");
      await h.flush();
      h.assertWaiting("t", id);
    } finally {
      h.dispose();
    }
  });

  for (const delta of [false, true])
    it(`joins hidden/report/reply transitions to all readers (${delta ? "delta" : "snapshot"})`, async () => {
      const h = setup(delta);
      try {
        h.tasks.create({
          id: "t",
          title: "Choose a route",
          prompt: "p",
          repoId: null,
          gate: { kind: "captain", ref: "operational-hold" },
        });
        h.subscribe("t");
        const id = h.cards.emitCrewmateCard("t", decision, "route");
        await h.flush();
        h.assertWaiting("t", null);
        expect(h.protocol.detail("t").flags).toMatchObject({
          held: true,
          needsYou: true,
          ready: false,
        });
        const before = h.tasks.get("t");
        const timeline = h.tasks.timeline("t");
        h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "report");
        await h.flush();
        h.assertWaiting("t", id);
        // Immediate local reply hide: stale board/delta data cannot resurrect it.
        h.local(h.cards.snapshot().map((c) => ({ ...c, awaiting: "answer" })));
        expect(h.boards.at(-1)?.tasks[0]?.waitingCardId).toBeNull();
        expect(h.details.at(-1)?.waitingCardId).toBeNull();
        // A refused reply restores the same projection without writing a task.
        h.local(h.cards.snapshot());
        expect(h.boards.at(-1)?.tasks[0]?.waitingCardId).toBe(id);
        const why = h.cards.addMessage(id, "captain", "Why?");
        h.cards.replyFromCrewmate("t", { cardId: id, text: "Checking." });
        await h.flush();
        h.assertWaiting("t", null);
        // INF-1623: a revision made while answering carries its own answer,
        // which names the captain's message.
        h.cards.emitCrewmateCard(
          "t",
          {
            ...decision,
            id,
            title: "Answered",
            reply: "I retitled the card Answered.",
            answersMessage: why.id,
          },
          "route",
        );
        await h.flush();
        h.assertWaiting("t", null);
        // INF-926: a report mid-turn does not bring back a card the captain
        // already had, on any reader; the crewmate's turn end does.
        h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "report");
        await h.flush();
        h.assertWaiting("t", null);
        h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "idle");
        await h.flush();
        h.assertWaiting("t", id);
        const seq = h.tasks.boardSeq();
        const records = h.tasks.list();
        const events = h.events.length;
        const afterReportTimeline = h.tasks.timeline("t");
        const again = h.cards.addMessage(id, "captain", "Why this choice?");
        await h.flush();
        h.assertWaiting("t", null);
        expect(h.tasks.boardSeq()).toBeGreaterThan(seq);
        expect(h.tasks.list()).toEqual(records);
        expect(h.tasks.timeline("t")).toEqual(afterReportTimeline);
        expect(h.events).toHaveLength(events);
        h.cards.replyFromCrewmate("t", {
          cardId: id,
          text: "This is the safer choice.",
          answersMessage: again.id,
        });
        h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "idle");
        await h.flush();
        h.assertWaiting("t", id);
        expect(h.tasks.get("t")?.gate).toEqual(before?.gate);
        expect(h.tasks.listReady()).toEqual([]);
        expect(h.tasks.timeline("t").filter((e) => e.kind === "progress")).toEqual(
          timeline.filter((e) => e.kind === "progress"),
        );
        // Every task carrier follows its matching focusable card delivery.
        let latest: Card[] = [];
        let base: TaskBoard | null = null;
        for (const pushed of h.delivery) {
          if (pushed.channel === "inf:cards") latest = pushed.value as Card[];
          if (pushed.channel === "inf:tasks") base = pushed.value as TaskBoard;
          else if (pushed.channel === "inf:tasks:delta")
            base = applyTaskBoardDelta(required(base), pushed.value as TaskBoardDelta);
          else continue;
          expect(base).not.toBeNull();
          for (const task of required(base).tasks)
            if (task.waitingCardId)
              expect(latest.some((c) => c.id === task.waitingCardId && isReadyDecision(c))).toBe(
                true,
              );
        }
        expect(base).toEqual(h.protocol.board());
        h.cards.resolve(required(h.cards.shown(id)), "go", "go");
        await h.flush();
        h.assertWaiting("t", null);
      } finally {
        h.dispose();
      }
    });

  it("tracks both action-changing revisions by the shown version, not the durable head", async () => {
    const h = setup();
    try {
      h.tasks.create({ id: "t", title: "Route", prompt: "p", repoId: null });
      h.subscribe("t");
      const id = h.cards.emitCrewmateCard("t", decision, "route");
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "idle");
      await h.flush();
      h.assertWaiting("t", id);
      h.cards.emitCrewmateCard("t", { ...decision, id, actions: [] }, "route");
      await h.flush();
      h.assertWaiting("t", id);
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "idle");
      await h.flush();
      h.assertWaiting("t", null);
      h.cards.emitCrewmateCard("t", { ...decision, id }, "route");
      await h.flush();
      h.assertWaiting("t", null);
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "idle");
      await h.flush();
      h.assertWaiting("t", id);
    } finally {
      h.dispose();
    }
  });

  it("selects eligible siblings in stage order once per task; waiting children split from the working group", async () => {
    const h = setup();
    try {
      h.tasks.create({ id: "parent", title: "Parent", prompt: "p", repoId: null });
      h.tasks.create({
        id: "t",
        title: "Waiting child",
        prompt: "p",
        repoId: null,
        parentId: "parent",
      });
      h.tasks.create({
        id: "s",
        title: "Working sibling",
        prompt: "p",
        repoId: null,
        parentId: "parent",
      });
      h.tasks.dispatch("s", {
        workspace: { repoDir: "r", worktreeDir: "w", branch: "b" },
        accountId: null,
        assignee: "crew",
      });
      h.tasks.setActivity("s", "running");
      const id = h.cards.addFirstmateCard({ ...decision, taskId: "t" });
      const hidden = h.cards.emitCrewmateCard("t", { ...decision, id: "hidden" }, "route");
      h.subscribe("t");
      await h.flush();
      h.assertWaiting("t", id);
      expect(h.protocol.projects()[0]?.counts.waitingOnYou).toBe(1);
      const groups = nowGroupsOf(h.protocol.board());
      expect([...groups.entries()].sort()).toEqual([
        ["parent", "working"],
        ["s", "working"],
        ["t", "waiting"],
      ]);
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "report");
      await h.flush();
      // Same priority/time: stage order is stable, not insertion guesses in a store.
      expect(h.protocol.detail("t").waitingCardId).toBe(
        h.cards.snapshot().find(isReadyDecision)?.id,
      );
      h.cards.addMessage(id, "captain", "Why this choice?");
      await h.flush();
      h.assertWaiting("t", hidden);
      h.cards.close(hidden, { kind: "crewmate", taskId: "t" });
      await h.flush();
      h.assertWaiting("t", null);
    } finally {
      h.dispose();
    }
  });

  it("gate-backed Firstmate and host decisions obey readiness; notes/holds/dead edges/closed rows do not wait", async () => {
    const h = setup();
    try {
      const id = h.cards.addFirstmateCard(decision);
      h.tasks.create({
        id: "t",
        kind: "decision",
        title: "Route",
        prompt: "p",
        repoId: null,
        gate: { kind: "captain", ref: id },
      });
      h.subscribe("t");
      await h.flush();
      h.assertWaiting("t", id);
      const explain = h.cards.addMessage(id, "captain", "Explain");
      await h.flush();
      h.assertWaiting("t", null);
      // Closing words name no message: the captain's question still waits
      // (the captain's "Only a line that says it answers it").
      h.cards.recordFirstmateThreadAnswer(id, "Looking into it.");
      h.cards.closeOut({ kind: "firstmate" }, "turn-end");
      await h.flush();
      h.assertWaiting("t", null);
      h.cards.addFirstmateCard({ ...decision, id, reply: "Answer", answersMessage: explain.id });
      await h.flush();
      h.assertWaiting("t", null);
      h.cards.closeOut({ kind: "firstmate" }, "turn-end");
      await h.flush();
      h.assertWaiting("t", id);
      h.cards.addFirstmateCard({ ...decision, id, actions: [] });
      await h.flush();
      h.assertWaiting("t", null);
      h.cards.raiseHostCard({
        id: "host",
        title: "Host choice",
        meta: "host",
        body: "body",
        actions: [{ id: "open", label: "Open", effect: { kind: "open", target: "settings" } }],
      });
      await h.flush();
      expect(h.protocol.projects()[0]?.counts.waitingOnYou).toBe(1);
      h.cards.withdrawHostCard("host", "obsolete");
      await h.flush();
      h.assertWaiting("t", null);
      h.tasks.create({ id: "dead", title: "Dead", prompt: "p", repoId: null });
      h.tasks.link("dead", "t", "blocks", "host");
      h.tasks.close("dead", { status: "dropped", reason: "cancelled", actor: "captain" });
      await h.flush();
      h.assertWaiting("t", null);
      expect(h.protocol.detail("t").flags.needsYou).toBe(true);
      h.cards.addFirstmateCard({ ...decision, id });
      await h.flush();
      h.assertWaiting("t", id);
      h.tasks.close("t", { status: "done", reason: "answered", actor: "captain" });
      await h.flush();
      h.assertWaiting("t", null);
    } finally {
      h.dispose();
    }
  });

  it("INF-1293 keeps a put-aside reply with its author across board, detail and project counts until the choice is ready again", async () => {
    const h = setup(true);
    try {
      h.tasks.create({
        id: "t",
        title: "Choose a route",
        prompt: "Choose the safer route",
        repoId: null,
      });
      h.tasks.dispatch("t", {
        workspace: { repoDir: "r", worktreeDir: "w", branch: "b" },
        accountId: null,
        assignee: "crew",
      });
      h.tasks.setActivity("t", "idle");
      h.subscribe("t");
      const id = h.cards.emitCrewmateCard("t", decision, "route");
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "idle");
      h.cards.setMinimized(id, true);
      await h.flush();
      h.assertWaiting("t", id);
      const asked = h.cards.addMessage(id, "captain", "Why is this route safer?");
      await h.flush();
      h.assertWaiting("t", null);
      expect(h.cards.shown(id)).toMatchObject({ minimized: true, awaiting: "answer" });
      // The turn is now running; answering alone cannot make the decision
      // ready before its author's turn ends.
      h.tasks.setActivity("t", "running");
      h.cards.replyFromCrewmate("t", {
        cardId: id,
        text: "This route avoids the closed road.",
        answersMessage: asked.id,
      });
      await h.flush();
      h.assertWaiting("t", null);
      h.tasks.setActivity("t", "idle");
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "idle");
      await h.flush();
      h.assertWaiting("t", id);
      // CardService releases the put-aside lifecycle when the answer is ready.
      expect(h.cards.shown(id)?.minimized).toBeUndefined();
    } finally {
      h.dispose();
    }
  });

  it("restart releases close-out but not unanswered replies; stable-id reopening begins hidden", async () => {
    const h = setup();
    try {
      h.tasks.create({ id: "t", title: "Route", prompt: "p", repoId: null });
      h.subscribe("t");
      const id = h.cards.emitCrewmateCard("t", decision, "route");
      await h.flush();
      h.assertWaiting("t", null);
      h.restart();
      await h.flush();
      h.assertWaiting("t", id);
      const why = h.cards.addMessage(id, "captain", "Why?");
      h.restart();
      await h.flush();
      h.assertWaiting("t", null);
      h.cards.replyFromCrewmate("t", { cardId: id, text: "Answer", answersMessage: why.id });
      h.restart();
      await h.flush();
      h.assertWaiting("t", id);
      const lifecycle = h.cards.shown(id)?.lifecycleId;
      // INF-1879: use the author's withdrawal to exercise a genuinely closed lifecycle.
      h.cards.close(id, { kind: "crewmate", taskId: "t" }, "The earlier route is obsolete.");
      await h.flush();
      h.assertWaiting("t", null);
      h.cards.emitCrewmateCard("t", { ...decision, id }, "route");
      await h.flush();
      h.assertWaiting("t", null);
      expect(h.cards.shown(id)?.lifecycleId).not.toBe(lifecycle);
      h.cards.closeOut({ kind: "crewmate", taskId: "t" }, "idle");
      await h.flush();
      h.assertWaiting("t", id);
      h.cards.retireTaskCards("t", "settled");
      await h.flush();
      h.assertWaiting("t", null);
    } finally {
      h.dispose();
    }
  });
});
