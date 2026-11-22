import {
  applyTaskBoardDelta,
  type TaskBoard,
  type TaskBoardDelta,
  taskBoardDeltaSchema,
  taskBoardSchema,
  taskDetailSchema,
} from "@shared/tasks";
import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { taskProtocolFixture } from "../../../tests/helpers/taskProtocol";

/**
 * The task protocol (task-system P3, design section 9): the board pushes, the
 * change seam's one seq, and the wire events.
 */

describe("the task protocol (task-system P3)", () => {
  // INF-1348: separating the minute pass into turns must still publish one
  // final board, not let the board timer fire between registrations.
  it("holds an already queued board across sweep turns and sends the final saved state once", async () => {
    const f = taskProtocolFixture();
    f.tasks.create({
      id: "review",
      title: "Review release notes",
      prompt: "Compare the notes with the changes",
      repoId: "r1",
    });
    const release = f.protocol.holdPushes();
    const nested = f.protocol.holdPushes();
    for (const text of [
      "Checked the summaries.",
      "Compared the changes.",
      "The review is ready.",
    ]) {
      f.tasks.note("review", text, { news: false });
      await f.settle();
      expect(f.boards()).toHaveLength(0);
    }
    release();
    release();
    await f.settle();
    expect(f.boards()).toHaveLength(0);
    nested();
    await f.settle();
    expect(f.boards()).toEqual([f.protocol.board()]);
    const stopped = f.protocol.holdPushes();
    f.tasks.note("review", "No further changes.", { news: false });
    f.protocol.dispose();
    stopped();
    await f.settle();
    expect(f.boards()).toHaveLength(1);
    f.db.close();
  });

  it("pushes a snapshot after N mutations that equals a fresh board read, under one rising seq", async () => {
    const { tasks, protocol, boards, settle, tick, cards } = taskProtocolFixture();
    expect(tasks.boardSeq()).toBe(0);
    expect(protocol.board()).toMatchObject({ seq: 0, tasks: [], links: [] });

    // Eleven mutations of every shape the writer has.
    tasks.create({
      id: "a",
      title: "A",
      prompt: "p",
      repoId: "r1",
      intent: { goal: "g", userWords: "w" },
    });
    tick();
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: null, blockedBy: ["a"] });
    tick();
    tasks.create({
      id: "c",
      title: "C",
      prompt: "p",
      repoId: null,
      parentId: "b",
      startPolicy: "on-request",
    });
    tick();
    tasks.starts.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
      model: { provider: "openai", id: "gpt-5" },
    });
    tick();
    tasks.turns.recordReport("a", { text: "Done the thing. Details follow." });
    tick();
    tasks.noteProgress("a", "halfway");
    tick();
    tasks.graph.link("c", "a", "related", "firstmate");
    tick();
    seedDelivery(
      tasks,
      "a",
      { prUrl: "https://x/pr/1", prNumber: 1 },
      { kind: "pr_opened", text: "PR #1", feed: true },
    );
    tick();
    tasks.close("a", {
      status: "done",
      reason: "landed",
      actor: "captain",
      delivery: { landedMode: "fast-forward" },
    });
    tick();
    tasks.capture.fileDecision({ id: "d", title: "Which way?", cardId: "card-d" });
    cards.push({
      id: "card-d",
      author: "firstmate",
      priority: 1,
      title: "Which way?",
      meta: "",
      body: "",
      actions: [{ id: "this-way", label: "This way", default: true }],
      status: "ready",
      createdAt: 1,
    });
    tick();
    tasks.updateFields("b", { priority: 0 }, "firstmate");
    await settle();

    const pushed = boards();
    expect(pushed.length).toBeGreaterThan(0);
    const last = pushed.at(-1) as TaskBoard;
    expect(last).toEqual(protocol.board());
    expect(taskBoardSchema.parse(last)).toEqual(last);
    expect(last.seq).toBe(tasks.boardSeq());
    expect(last.seq).toBe(11);
    for (let index = 1; index < pushed.length; index += 1) {
      expect((pushed[index] as TaskBoard).seq).toBeGreaterThan(
        (pushed[index - 1] as TaskBoard).seq,
      );
    }
    tick();
    tasks.updateFields("b", { title: "B2" }, "firstmate");
    expect(protocol.board().seq).toBe(12);
    expect(protocol.board().tasks.find((task) => task.id === "b")?.title).toBe("B2");
  });

  it("coalesces a burst into one push and bumps nothing for a write that changes nothing", async () => {
    const { tasks, boards, settle } = taskProtocolFixture();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: null });
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: null });
    tasks.turns.setActivity("a", "idle");
    await settle();
    expect(boards()).toHaveLength(1);
    expect(boards()[0]?.seq).toBe(3);
    tasks.setParent("a", null, "firstmate");
    tasks.updateFields("a", { title: "A" }, "firstmate");
    await settle();
    expect(tasks.boardSeq()).toBe(3);
    expect(boards()).toHaveLength(1);
  });

  it("commits a nested write as one change with one seq, and drops the change of a refused write", () => {
    const { tasks, changes } = taskProtocolFixture();
    tasks.create({ id: "origin", title: "Origin", prompt: "p", repoId: "r1" });
    changes.length = 0;
    // fileFollowup runs create + two links + a note inside one transaction.
    tasks.fileFollowup({
      id: "f",
      originId: "origin",
      title: "Follow-up",
      goal: "g",
      why: "found it",
      prompt: "p",
      blocksOrigin: true,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.seq).toBe(2);
    expect([...(changes[0]?.taskIds ?? [])].sort()).toEqual(["f", "origin"]);
    expect(changes[0]?.events.map((event) => event.kind)).toEqual([
      "created",
      "linked",
      "note",
      "linked",
    ]);
    expect(() => tasks.graph.link("origin", "f", "blocks", "firstmate")).toThrow(/cycle/);
    expect(changes).toHaveLength(1);
    expect(tasks.boardSeq()).toBe(2);
  });

  it("emits task_event lines authored from the record and task_changed per touched row", async () => {
    const { tasks, events, tick, settle } = taskProtocolFixture();
    tasks.create({ id: "a", title: "Fix it", prompt: "p", repoId: "r1" });
    tasks.starts.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
    });
    tick();
    tasks.turns.recordReport("a", { text: "Steady as she goes. More later." });
    tick();
    tasks.noteProgress("a", "halfway");
    tick();
    tasks.turns.recordTurnFailure("a", "Connection error.");
    tick();
    tasks.close("a", {
      status: "done",
      reason: "landed",
      actor: "captain",
      delivery: { landedMode: "merge" },
    });
    await settle();
    const lines = events.flatMap((event) =>
      event.type === "task_event"
        ? [{ kind: event.kind, text: event.text, feed: event.feed, key: event.key }]
        : [],
    );
    expect(lines).toEqual([
      { kind: "created", text: 'created "Fix it"', feed: false, key: "NIA-1" },
      { kind: "dispatched", text: "Started", feed: true, key: "NIA-1" },
      {
        kind: "report",
        text: "Reported: Steady as she goes.",
        feed: true,
        key: "NIA-1",
      },
      { kind: "progress", text: "halfway", feed: false, key: "NIA-1" },
      {
        kind: "failed",
        text: "Problem: could not reach the provider - try again",
        feed: true,
        key: "NIA-1",
      },
      { kind: "landed", text: "Merged", feed: true, key: "NIA-1" },
    ]);
    const changed = events.flatMap((event) => (event.type === "task_changed" ? [event] : []));
    expect(changed[0]).toEqual({
      type: "task_changed",
      taskId: "a",
      key: "NIA-1",
      kind: "work",
      status: "open",
      from: null,
      activity: null,
      // A work row that never routed has no served slot yet.
      tier: null,
      reviewOf: null,
      executionDeviceId: null,
      closedReason: null,
      seq: 1,
    });
    expect(changed.at(-1)).toMatchObject({ status: "done", activity: null, seq: 6 });
    // Every change carries the seq the board will show, in order.
    expect(changed.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("authors the decommission lines from the close, and a failed close as a task failure", async () => {
    const { tasks, events, settle } = taskProtocolFixture();
    for (const id of ["a", "b", "c"]) {
      tasks.create({ id, title: `T-${id}`, prompt: "p", repoId: null });
      tasks.starts.dispatch(id, {
        workspace: { repoDir: "", worktreeDir: `/wt/${id}`, branch: "" },
        accountId: null,
        assignee: "crewmate 1",
      });
    }
    tasks.close("a", {
      status: "done",
      reason: "landed",
      actor: "host",
      delivery: { landedMode: "merge" },
    });
    tasks.close("b", { status: "dropped", reason: "cancelled", actor: "captain" });
    tasks.close("c", { status: "dropped", reason: "failed", actor: "host", error: "boom" });
    tasks.create({ id: "d", title: "T-d", prompt: "p", repoId: null });
    tasks.dropWithChildren("d", { reason: "not needed", actor: "firstmate" });
    await settle();
    const lines = events.flatMap((event) =>
      event.type === "task_event" && event.feed ? [event.text] : [],
    );
    expect(lines).toContain("Merged");
    expect(lines).toContain("Stopped");
    // The feed says what a failure means; the raw error stays on the record.
    expect(lines).toContain("Failed: something went wrong - try again");
    expect(tasks.timeline("c").find((event) => event.kind === "failed")?.text).toBe("failed: boom");
    // The first mate's drop reads as its own sentence (INF-547: "Dropped: …",
    // the same sentence as its note).
    expect(lines).toContain("Dropped: not needed");
  });

  it("pushes on a purge and on a discarded spawn, with nothing left to describe", async () => {
    const { tasks, protocol, events, boards, settle } = taskProtocolFixture();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: null });
    await settle();
    events.length = 0;
    tasks.archive.discardFailedSpawn("a");
    await settle();
    expect(events).toEqual([]);
    expect(boards().at(-1)?.tasks).toEqual([]);
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: null });
    expect(tasks.archive.purge()).toBe(1);
    await settle();
    expect(boards().at(-1)).toEqual(protocol.board());
    expect(protocol.board().tasks).toEqual([]);
    // The sequence keeps rising through a purge: a client must not mistake
    // the emptied board for an older one.
    expect(tasks.boardSeq()).toBe(4);
  });

  it("stops pushing once disposed", async () => {
    const { tasks, protocol, boards, settle } = taskProtocolFixture();
    protocol.dispose();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: null });
    await settle();
    expect(boards()).toEqual([]);
  });
});

/**
 * The delta carrier (task-system P5, design section 9.1). The acceptance
 * the build plan names: the delta and a full snapshot converge - applying
 * every pushed delta onto the last pushed snapshot yields the board a fresh
 * read returns, after mutations of every shape, under the same rising seq.
 */
describe("the delta carrier (task-system P5)", () => {
  /** Folds every push in order onto the client's board, as the executor does. */
  function followed(carried: { channel: string; payload: unknown }[]): {
    board: TaskBoard | null;
    gaps: number;
    snapshots: number;
    deltas: number;
  } {
    let board: TaskBoard | null = null;
    let gaps = 0;
    let snapshots = 0;
    let deltas = 0;
    for (const push of carried) {
      if (push.channel === "inf:tasks") {
        board = push.payload as TaskBoard;
        snapshots += 1;
        continue;
      }
      deltas += 1;
      const next: TaskBoard | null = board
        ? applyTaskBoardDelta(board, push.payload as TaskBoardDelta)
        : null;
      if (next === null) gaps += 1;
      else board = next;
    }
    return { board, gaps, snapshots, deltas };
  }

  it("pushes a snapshot first, then deltas above the trigger, and the two converge on the fresh read", async () => {
    const { tasks, protocol, carried, deltas, settle, tick, cards } = taskProtocolFixture({
      deltaTrigger: { rows: 1, bytes: Number.MAX_SAFE_INTEGER },
    });
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    await settle();
    expect(carried().map((push) => push.channel)).toEqual(["inf:tasks"]);

    // Every shape of mutation, each settling into its own push.
    const steps: (() => void)[] = [
      () => tasks.create({ id: "b", title: "B", prompt: "p", repoId: null, blockedBy: ["a"] }),
      () =>
        tasks.create({
          id: "c",
          title: "C",
          prompt: "p",
          repoId: null,
          parentId: "b",
          startPolicy: "on-request",
        }),
      () =>
        tasks.starts.dispatch("a", {
          workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
          accountId: null,
          assignee: "crewmate 1",
          model: { provider: "openai", id: "gpt-5" },
        }),
      () => tasks.turns.recordReport("a", { text: "Done the thing. Details follow." }),
      () => tasks.graph.link("c", "a", "related", "firstmate"),
      () => tasks.graph.unlink("c", "a", "related", "firstmate"),
      () =>
        seedDelivery(
          tasks,
          "a",
          { prUrl: "https://x/pr/1", prNumber: 1 },
          { kind: "pr_opened", text: "PR #1", feed: true },
        ),
      // Closing a releases b: b's derived flags change with no write of its own.
      () =>
        tasks.close("a", {
          status: "done",
          reason: "landed",
          actor: "captain",
          delivery: { landedMode: "fast-forward" },
        }),
      () => {
        tasks.capture.fileDecision({ id: "d", title: "Which way?", cardId: "card-d" });
        cards.push({
          id: "card-d",
          author: "firstmate",
          priority: 1,
          title: "Which way?",
          meta: "",
          body: "",
          actions: [{ id: "this-way", label: "This way", default: true }],
          status: "ready",
          createdAt: 1,
        });
      },
      () => tasks.updateFields("b", { priority: 0 }, "firstmate"),
      () => tasks.setParent("c", null, "firstmate"),
      () => tasks.archive.discardFailedSpawn("c"),
    ];
    for (const step of steps) {
      tick();
      step();
      await settle();
      const client = followed(carried());
      expect(client.gaps).toBe(0);
      expect(client.board).toEqual(protocol.board());
    }
    const client = followed(carried());
    expect(client.deltas).toBeGreaterThanOrEqual(steps.length - 2);
    // Rows vanished (the discard): that push was a snapshot again.
    expect(client.snapshots).toBe(2);
    expect(carried().at(-1)?.channel).toBe("inf:tasks");
    for (const delta of deltas()) {
      expect(taskBoardDeltaSchema.parse(delta)).toEqual(delta);
      expect(delta.seq).toBeGreaterThan(delta.baseSeq);
    }
    const seqs = carried().map((push) => (push.payload as { seq: number }).seq);
    for (let index = 1; index < seqs.length; index += 1) {
      const push = carried()[index] as { channel: string; payload: unknown };
      if (push.channel === "inf:tasks:delta") {
        expect((push.payload as TaskBoardDelta).baseSeq).toBe(seqs[index - 1]);
      }
    }
    expect(client.board?.seq).toBe(tasks.boardSeq());
  });

  it("stays on snapshots below the trigger, switches on rows or bytes, and rebases after a purge", async () => {
    const byRows = taskProtocolFixture({
      deltaTrigger: { rows: 2, bytes: Number.MAX_SAFE_INTEGER },
    });
    byRows.tasks.create({ id: "a", title: "A", prompt: "p", repoId: null });
    await byRows.settle();
    byRows.tasks.create({ id: "b", title: "B", prompt: "p", repoId: null });
    await byRows.settle();
    // Two rows: not over the trigger, still a snapshot.
    expect(byRows.carried().map((push) => push.channel)).toEqual(["inf:tasks", "inf:tasks"]);
    byRows.tasks.create({ id: "c", title: "C", prompt: "p", repoId: null });
    await byRows.settle();
    expect(byRows.carried().at(-1)?.channel).toBe("inf:tasks:delta");
    expect(byRows.protocol.pushModeFor(byRows.protocol.board())).toBe("delta");
    byRows.tasks.archive.purge();
    await byRows.settle();
    expect(byRows.carried().at(-1)).toMatchObject({
      channel: "inf:tasks",
      payload: { tasks: [], links: [] },
    });

    const byBytes = taskProtocolFixture({ deltaTrigger: { rows: 1_000, bytes: 64 } });
    byBytes.tasks.create({ id: "a", title: "A", prompt: "p", repoId: null });
    await byBytes.settle();
    byBytes.tasks.create({ id: "b", title: "B", prompt: "p", repoId: null });
    await byBytes.settle();
    expect(byBytes.carried().map((push) => push.channel)).toEqual(["inf:tasks", "inf:tasks:delta"]);
    expect(followed(byBytes.carried()).board).toEqual(byBytes.protocol.board());

    // The design's trigger by default: a small fleet never sees a delta.
    const plain = taskProtocolFixture();
    plain.tasks.create({ id: "a", title: "A", prompt: "p", repoId: null });
    await plain.settle();
    plain.tasks.create({ id: "b", title: "B", prompt: "p", repoId: null });
    await plain.settle();
    expect(plain.deltas()).toEqual([]);
    expect(plain.boards()).toHaveLength(2);
  });

  it("says what a record moved from on task_changed, once per transition", async () => {
    const { tasks, events, tick } = taskProtocolFixture();
    const changed = () =>
      events
        .filter((event) => event.type === "task_changed")
        .map((event) => (event.type === "task_changed" ? event : null))
        .filter((event) => event !== null);
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    expect(changed().at(-1)).toMatchObject({ kind: "work", status: "open", from: null });
    tick();
    tasks.starts.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
    });
    expect(changed().at(-1)).toMatchObject({ status: "active", from: "open", closedReason: null });
    tick();
    tasks.turns.setActivity("a", "idle");
    expect(changed().at(-1)).toMatchObject({ status: "active", from: "active" });
    tick();
    tasks.close("a", {
      status: "done",
      reason: "landed",
      actor: "captain",
      delivery: { landedMode: "merge" },
    });
    expect(changed().at(-1)).toMatchObject({
      status: "done",
      from: "active",
      closedReason: "landed",
    });
    tick();
    tasks.placement.markWorkspaceRemoved("a");
    expect(changed().at(-1)).toMatchObject({
      status: "done",
      from: "done",
      closedReason: "landed",
    });
    tick();
    tasks.create({ id: "f", title: "F", prompt: "p", repoId: null, status: "active" });
    tasks.close("f", { status: "dropped", reason: "failed", actor: "host", error: "boom" });
    expect(changed().at(-1)).toMatchObject({
      status: "dropped",
      from: "active",
      closedReason: "failed",
    });
  });
});

// INF-3453: the first board push read and viewed every row the board shows
// in one stretch of the main thread, and on a long record's week that one
// stretch was past the freeze line. It is built a part per turn instead.
describe("a board pushed from nothing", () => {
  /** A fixture whose board parts wait for the test to run each turn. */
  const turnByTurn = () => {
    const turns: (() => void)[] = [];
    const f = taskProtocolFixture({
      nextTurn: (run) => {
        turns.push(run);
        return () => {
          const at = turns.indexOf(run);
          if (at >= 0) turns.splice(at, 1);
        };
      },
    });
    const next = () => {
      const run = turns.shift();
      if (!run) throw new Error("No part of the board waits for a turn.");
      run();
    };
    return { ...f, turns, next };
  };

  it("takes a turn for each part, and pushes the rows written between them", async () => {
    const f = turnByTurn();
    f.tasks.create({ id: "notes", title: "Draft the notes", prompt: "Draft them", repoId: "r1" });
    await f.settle();
    expect(f.turns).toHaveLength(1);
    f.next();
    // Written after the parts read the rows the board shows.
    f.tasks.create({ id: "changes", title: "List the changes", prompt: "List them", repoId: "r1" });
    let parts = 1;
    while (f.turns.length > 0) {
      expect(f.boards()).toEqual([]);
      f.next();
      parts += 1;
    }
    expect(parts).toBeGreaterThan(2);
    await f.settle();
    expect(f.boards()).toEqual([f.fresh()]);
    expect(
      f
        .boards()[0]
        ?.tasks.map((task) => task.id)
        .sort(),
    ).toEqual(["changes", "notes"]);
    f.protocol.dispose();
    f.db.close();
  });

  it("answers a read between the parts with the whole board at once, and still pushes it", async () => {
    const f = turnByTurn();
    f.tasks.create({ id: "notes", title: "Draft the notes", prompt: "Draft them", repoId: "r1" });
    await f.settle();
    f.next();
    expect(f.protocol.board()).toEqual(f.fresh());
    expect(f.turns).toEqual([]);
    await f.settle();
    expect(f.boards()).toEqual([f.fresh()]);
    f.protocol.dispose();
    f.db.close();
  });

  it("starts again when the rows vanish wholesale between the parts", async () => {
    const f = turnByTurn();
    f.tasks.create({ id: "notes", title: "Draft the notes", prompt: "Draft them", repoId: "r1" });
    f.tasks.close("notes", { status: "dropped", reason: "cancelled", actor: "host" });
    await f.settle();
    f.next();
    f.tasks.archive.purge();
    expect(f.turns).toEqual([]);
    await f.settle();
    while (f.turns.length > 0) f.next();
    expect(f.boards()).toEqual([f.fresh()]);
    expect(f.boards()[0]?.tasks).toEqual([]);
    f.protocol.dispose();
    f.db.close();
  });
});

describe("provenance events on the wire (R2)", () => {
  it("keeps a decision record off the detail read and the task_event stream, but not steers", async () => {
    const { tasks, protocol, events, settle, tick, clock } = taskProtocolFixture();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    tick();
    tasks.turns.recordDecision({
      schema: 1,
      decision: "fm-1",
      startedAt: clock(),
      endedAt: clock(),
      producer: {
        actor: "firstmate",
        role: "firstmate",
        model: null,
        accountId: null,
        thinkingLevel: null,
      },
      contract: { version: "2.7", promptSha: null, toolsSha: null },
      trigger: "captain",
      served: null,
      disposition: {
        outcome: "clean",
        error: null,
        inbox: "none",
        asks: [],
        toolCalls: [],
        cards: [],
        tasks: ["a"],
        verdict: null,
        outcomeId: null,
        handoffInboxId: null,
      },
    });
    tick();
    tasks.turns.recordSteer("a", {
      text: "use the users endpoint",
      actor: "firstmate",
      outcome: "mid-turn",
      via: "tool",
      decision: "fm-1",
      cardId: null,
      inboxId: 7,
    });
    await settle();

    expect(tasks.timeline("a").map((event) => event.kind)).toEqual([
      "created",
      "decided",
      "steered",
    ]);
    const detail = taskDetailSchema.parse(protocol.detail("a"));
    expect(detail.events.map((event) => event.kind)).toEqual(["created", "steered"]);
    const streamed = events.flatMap((event) => (event.type === "task_event" ? [event.kind] : []));
    expect(streamed).not.toContain("decided");
    expect(streamed).toContain("steered");
  });

  it("publishes a computer going from out of reach to connecting as a presentation change, with no record write", async () => {
    let place: import("@shared/tasks").TaskPlace = {
      name: "Mac mini",
      where: "on Mac mini",
      reach: "out-of-reach",
    };
    const f = taskProtocolFixture({ place: () => place });
    f.tasks.create({ id: "t", title: "On the mini", prompt: "p", repoId: "r1" });
    await f.settle();
    f.protocol.refreshPresentation();
    expect(f.protocol.board().tasks[0]?.place).toMatchObject({ reach: "out-of-reach" });
    // The connection starts being made: the services call this at once on a connection change.
    place = { name: "Mac mini", where: "on Mac mini", reach: "connecting" };
    expect(f.protocol.refreshPresentation()).toBe(true);
    const row = f.protocol.board().tasks[0]?.place;
    // Protocol 9 publishes the core reach value without compatibility flags.
    expect(row).toMatchObject({ reach: "connecting" });
    f.protocol.dispose();
    f.db.close();
  });
});
