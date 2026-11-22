import { nowGroupOf } from "@shared/nowPanel";
import { taskMovesOf } from "@shared/taskMoves";
import {
  applyTaskBoardDelta,
  BOARD_RECENT_MS,
  type TaskBoard,
  taskBoardSchema,
} from "@shared/tasks";
import type { WorkPosture } from "@shared/workPosture";
import { describe, expect, it, vi } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { DAY, taskProtocolFixture } from "../../../tests/helpers/taskProtocol";
import { DecisionStore } from "../storage/decisionStore";
import type { TaskService } from "./taskService";

/**
 * The task protocol (task-system P3, design section 9): the card and posture
 * words its rows carry, and the presentation refresh.
 */

describe("the task protocol (task-system P3)", () => {
  // INF-2255: the retained 41-row measurement found two complete place,
  // posture and move readings across a presentation refresh and its board.
  it("shares refreshed facts with its board, but drops them on a new invalidation or task write", () => {
    let reachable = true;
    const place = vi.fn(() => ({
      name: "Studio Mac",
      where: "on Studio Mac",
      reach: reachable ? ("in-reach" as const) : ("out-of-reach" as const),
    }));
    const posture = vi.fn(
      (record: import("../storage/taskRecords").TaskRecord): WorkPosture =>
        record.gate ? { state: "idle", reason: "captain" } : { state: "idle", reason: "inactive" },
    );
    const f = taskProtocolFixture({ place, workPosture: posture });
    try {
      f.tasks.create({
        id: "work",
        title: "Verify the refreshed task facts",
        prompt: "",
        repoId: "r1",
      });
      f.protocol.board();
      place.mockClear();
      posture.mockClear();
      f.protocol.refreshPresentation();
      const first = f.protocol.board();
      console.info(
        JSON.stringify({
          intent: "INF-2255 refresh publication",
          placeReads: place.mock.calls.length,
          postureReads: posture.mock.calls.length,
        }),
      );
      expect(place).toHaveBeenCalledTimes(1);
      expect(posture).toHaveBeenCalledTimes(1);
      expect(first).toEqual(f.fresh());

      f.protocol.refreshPresentation();
      reachable = false;
      f.tasks.invalidatePresentation();
      expect(f.protocol.board()).toEqual(f.fresh());
      expect(f.protocol.board().tasks[0]?.place).toEqual(place());

      reachable = true;
      f.protocol.refreshPresentation();
      f.tasks.placement.setGate("work", { kind: "captain", ref: "review" });
      expect(f.protocol.board()).toEqual(f.fresh());
      expect(f.protocol.board().tasks[0]?.workPosture).toEqual({
        state: "idle",
        reason: "captain",
      });
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  // INF-2255: a nested owner's publication must not inherit the older live facts.
  it("keeps a nested presentation invalidation fresh during refresh publication", () => {
    let reachable = true;
    const place = () => ({
      name: "Studio Mac",
      where: "on Studio Mac",
      reach: reachable ? ("in-reach" as const) : ("out-of-reach" as const),
    });
    const f = taskProtocolFixture({ place });
    const decisions = new DecisionStore(f.db);
    const route = (served: "medium" | "low") =>
      decisions.recordRouting({
        taskId: "work",
        provider: "openai-codex",
        model: "gpt-6.1-sol",
        bucket: "high",
        served,
        rule: "R8",
        reasons: ["Serve at the available slot."],
      });
    let observed: TaskBoard | undefined;
    let nested = false;
    try {
      f.tasks.create({ id: "work", title: "Keep nested reach current", prompt: "", repoId: "r1" });
      route("medium");
      f.protocol.board();
      const off = f.tasks.onChange((change) => {
        if (!change.republish || nested) return;
        nested = true;
        reachable = false;
        route("low");
        f.tasks.refreshPresentation(["work"]);
        observed = f.protocol.board();
      });
      try {
        f.protocol.refreshPresentation();
        expect(observed?.tasks[0]?.place?.reach).toBe("out-of-reach");
        expect(observed?.tasks[0]?.tier).toBe("low");
        expect(observed).toEqual(f.fresh());
      } finally {
        off();
      }
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  // INF-2186: the row cache already owns current records; a presentation
  // pass must not rebuild them from SQLite merely to publish live facts.
  it("refreshes presentation from cached records including pending creates and closes", () => {
    const f = taskProtocolFixture({ workPosture: () => ({ state: "idle", reason: "captain" }) });
    try {
      f.tasks.create({ id: "old", title: "Keep Tasks responsive", prompt: "", repoId: "r1" });
      seedDelivery(f.tasks, "old", {
        ci: "red",
        headSha: "93355db9d04e964513879db74d068a7789cb4c16",
      });
      f.protocol.board();
      const parse = vi.spyOn(JSON, "parse");
      let parsed: number;
      try {
        expect(f.protocol.refreshPresentation()).toBe(true);
        parsed = parse.mock.calls.length;
      } finally {
        parse.mockRestore();
      }
      console.info(JSON.stringify({ intent: "INF-2186 cached presentation records", parsed }));
      expect(parsed).toBe(0);
      // Consume the first posture publication before measuring an unchanged pass.
      const first = f.protocol.board();
      expect(first.tasks[0]?.moves).toBeDefined();
      const links = vi.spyOn(f.tasks.graph, "linksTouching");
      try {
        f.protocol.refreshPresentation();
        const next = f.protocol.board();
        const requested = links.mock.calls.flatMap(([ids]) => ids);
        console.info(
          JSON.stringify({
            intent: "INF-2186 warm board links and moves",
            linkIdsRequested: requested.length,
          }),
        );
        expect(requested).toEqual([]);
        expect(next.tasks[0]?.moves).toBe(first.tasks[0]?.moves);
      } finally {
        links.mockRestore();
      }
      f.tasks.create({ id: "new", title: "Verify the change", prompt: "", repoId: "r1" });
      f.tasks.close("old", { status: "done", reason: "settled", actor: "host" });
      const seen: string[] = [];
      f.protocol.refreshPresentation((record) => seen.push(record.id));
      expect(seen).toEqual(["new"]);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  // INF-2186: borrowing the cached records must preserve intervening writes.
  it("does not publish the borrowed presentation snapshot after its callback writes a task", () => {
    const held: WorkPosture = { state: "idle", reason: "captain" };
    const f = taskProtocolFixture({
      workPosture: (record) => (record.gate ? held : { state: "idle", reason: "inactive" }),
    });
    try {
      f.tasks.create({ id: "work", title: "Verify the shared read", prompt: "", repoId: "r1" });
      f.protocol.board();
      f.protocol.refreshPresentation((record) => {
        f.tasks.placement.setGate(record.id, { kind: "captain", ref: "completion-choice" });
      });
      expect(f.events.filter((event) => event.type === "task_changed").at(-1)?.workPosture).toEqual(
        held,
      );
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  // INF-2186: a presentation change rechecks cached rows' live facts, but
  // witnesses must read the current cached record, not decode it afresh.
  it("reuses cached task records and derives their posture once during a board recheck", () => {
    let tasks: TaskService | undefined;
    let posture: WorkPosture = { state: "idle", reason: "captain" };
    const readPosture = vi.fn((record: import("../storage/taskRecords").TaskRecord) => {
      if (!tasks) throw new Error("Missing task reader");
      expect(tasks.get(record.id)).toBe(record);
      return posture;
    });
    const f = taskProtocolFixture({ workPosture: readPosture });
    tasks = f.tasks;
    try {
      f.tasks.create({ id: "board", title: "Keep Tasks responsive", prompt: "", repoId: "r1" });
      seedDelivery(f.tasks, "board", {
        ci: "red",
        headSha: "93355db9d04e964513879db74d068a7789cb4c16",
      });
      f.protocol.board();
      posture = { state: "active", reason: "job" };
      f.tasks.invalidatePresentation();
      readPosture.mockClear();
      const fullRows = vi.spyOn(f.tasks, "listLiveOrClosedSince");
      const parse = vi.spyOn(JSON, "parse");
      let parsed: number;
      let fullReads: number;
      let board: TaskBoard;
      try {
        board = f.protocol.board();
        f.tick(60_000);
        expect(f.protocol.board().tasks[0]).toBe(board.tasks[0]);
        parsed = parse.mock.calls.length;
        fullReads = fullRows.mock.calls.length;
      } finally {
        parse.mockRestore();
        fullRows.mockRestore();
      }
      expect(fullReads).toBe(0);
      expect(board.tasks[0]?.workPosture).toEqual(posture);
      expect(readPosture).toHaveBeenCalledTimes(1);
      expect(parsed).toBe(0);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  // INF-2186: a presentation refresh's synchronous task-change listener
  // must reuse the posture it just derived, rather than gathering witnesses again.
  it("derives each row's posture once while publishing a presentation refresh", () => {
    const posture = vi.fn(() => ({ state: "idle" as const, reason: "captain" as const }));
    const f = taskProtocolFixture({ workPosture: posture });
    try {
      for (const id of ["one", "two"])
        f.tasks.create({ id, title: "Keep Tasks responsive", prompt: "", repoId: "r1" });
      posture.mockClear();
      expect(f.protocol.refreshPresentation()).toBe(true);
      expect(posture).toHaveBeenCalledTimes(f.tasks.listLive().length);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  // INF-2186: minimized tasks and ready decisions share one staged-card read.
  it("reads the staged card facts once for a board", () => {
    const f = taskProtocolFixture();
    try {
      f.tasks.create({ id: "board", title: "Keep Tasks responsive", prompt: "", repoId: "r1" });
      f.snapshot.mockClear();
      expect(f.protocol.board().tasks.map((task) => task.id)).toEqual(["board"]);
      expect(f.snapshot).toHaveBeenCalledTimes(1);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });
  it("publishes presentation-only changes through events, detail and sequenced deltas without changing the idle clock", async () => {
    let posture: WorkPosture = { state: "idle", reason: "captain" };
    const f = taskProtocolFixture({
      workPosture: () => posture,
      deltaTrigger: { rows: 0, bytes: 0 },
    });
    f.tasks.create({ id: "t", title: "Work", prompt: "p", repoId: "r1" });
    f.protocol.refreshPresentation();
    await f.settle();
    const before = f.tasks.get("t");
    const board = f.protocol.board();
    posture = { state: "active", reason: "job" };
    expect(f.protocol.refreshPresentation()).toBe(true);
    expect(f.protocol.refreshPresentation()).toBe(false);
    await f.settle();
    expect(f.tasks.get("t")).toEqual(before);
    expect(f.protocol.detail("t").workPosture).toEqual(posture);
    expect(f.events.findLast((event) => event.type === "task_changed")).toMatchObject({
      workPosture: posture,
    });
    const delta = f.deltas().at(-1);
    if (!delta) throw new Error("missing presentation delta");
    expect(applyTaskBoardDelta(board, delta)).toEqual(f.protocol.board());
    f.protocol.dispose();
    f.db.close();
  });

  it("reads the posture of live rows alone, however much closed work the record holds", async () => {
    const asked: string[] = [];
    const f = taskProtocolFixture({
      workPosture: (record) => {
        asked.push(record.id);
        return { state: "idle", reason: record.status === "open" ? "captain" : "inactive" };
      },
    });
    f.tasks.create({ id: "parent", title: "Old parent", prompt: "p", repoId: "r1" });
    for (const id of ["old-1", "old-2", "old-3"]) {
      f.tasks.create({ id, title: id, prompt: "p", repoId: "r1", parentId: "parent" });
      f.tasks.close(id, { status: "done", reason: "settled", actor: "host" });
    }
    f.tasks.close("parent", { status: "done", reason: "settled", actor: "host" });
    f.tick(BOARD_RECENT_MS + 1);
    f.tasks.create({ id: "live", title: "Live", prompt: "p", repoId: "r1" });
    await f.settle();
    asked.length = 0;
    // The walk derives only the live row, once; publication reuses that fact.
    expect(f.protocol.refreshPresentation()).toBe(true);
    expect(asked).toEqual(["live"]);
    asked.length = 0;
    const board = f.protocol.board();
    expect(board.tasks.map((task) => task.id)).toEqual(["live"]);
    const counts = board.projects.find((project) => project.repo?.name === "nimbus-api")?.counts;
    expect(counts).toMatchObject({ open: 1, active: 0, doneRecent: 0, needsYou: 0 });
    expect(f.protocol.projects()).toEqual(board.projects);
    // INF-2255: neither the board nor project counts repeats that same reading.
    expect(asked).toEqual([]);
    // Its close published the row; the next walk answers the move, writing nothing.
    f.tasks.close("live", { status: "done", reason: "settled", actor: "host" });
    await f.settle();
    const seq = f.tasks.boardSeq();
    expect(f.protocol.refreshPresentation()).toBe(true);
    expect(f.protocol.refreshPresentation()).toBe(false);
    expect(f.tasks.boardSeq()).toBe(seq);
    f.protocol.dispose();
    f.db.close();
  });

  it("says on each live work row which lifecycle moves it allows and whether its waiting card merges (FI3-1014 piece 4)", () => {
    const { tasks, protocol, cards } = taskProtocolFixture();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: "r1", blockedBy: ["a"] });
    tasks.starts.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
    });
    tasks.create({ id: "q", title: "Q", prompt: "p", repoId: null, kind: "question" });
    cards.push({
      id: "card-a",
      taskId: "a",
      author: "crewmate",
      priority: 1,
      title: "Merge?",
      meta: "",
      body: "",
      actions: [
        { id: "merge", label: "Merge", default: true, effect: { kind: "merge", after: "close" } },
      ],
      status: "ready",
      createdAt: 1,
    });
    const board = protocol.board();
    const view = (id: string) => board.tasks.find((task) => task.id === id);
    expect(view("a")).toMatchObject({
      waitingCardId: "card-a",
      waitingCardMerges: true,
      moves: { "stop-task": { ok: true }, "queue-task": { ok: false } },
    });
    expect(view("b")?.waitingCardMerges).toBeUndefined();
    const blocked = view("b");
    if (!blocked) throw new Error("The blocked work row is missing.");
    // INF-1879 adds two explicit endings; their refusal words come from the move-policy owner.
    const policy = taskMovesOf(blocked);
    expect(blocked.moves).toEqual({
      "answer-done": policy?.["answer-done"],
      "dismiss-question": policy?.["dismiss-question"],
      "show-card": { ok: false, text: "It has no card to show." },
      "start-task": { ok: false, text: "NIA-1 must finish first." },
      "start-again": {
        ok: false,
        text: "Only dropped work without a replacement or parts starts again.",
      },
      "stop-task": { ok: false, text: "It has not started. Drop task drops it." },
      "continue-task": { ok: false, text: "Only interrupted work continues." },
      "drop-task": { ok: true },
      "queue-task": { ok: false, text: "It is already queued." },
      "unqueue-task": { ok: true },
    });
    expect(blocked.moves?.["answer-done"]?.ok).toBe(false);
    expect(blocked.moves?.["dismiss-question"]?.ok).toBe(false);
    // A question has no moves, and neither does closed work.
    expect(view("q")?.moves).toBeUndefined();
  });

  it("reads the gate on an active row: held, and waiting on you only while its card is up", () => {
    const { tasks, protocol, cards } = taskProtocolFixture();
    const workspace = { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/x", branch: "fm/x" };
    for (const id of ["capped", "carded", "timed", "free"]) {
      tasks.create({ id, title: id, prompt: "p", repoId: "r1" });
      tasks.starts.dispatch(id, { workspace, accountId: null, assignee: "crewmate 1" });
    }
    // A round cap before the Firstmate's card: held, and the Firstmate's
    // turn - not the captain's, so not waiting on him.
    tasks.placement.setGate("capped", { kind: "captain", ref: "abc1234", reason: "the CI cap" });
    // The card the gate names is up: the captain's turn.
    tasks.placement.setGate("carded", { kind: "captain", ref: "card-fm-9", reason: "the CI cap" });
    cards.push({
      id: "card-fm-9",
      author: "firstmate",
      priority: 1,
      title: "Retry?",
      meta: "",
      body: "",
      actions: [{ id: "retry", label: "Retry", default: true }],
      status: "ready",
      createdAt: 1,
    });
    tasks.placement.setGate("timed", { kind: "at-time", until: 99 * DAY });
    // A host card with no task files its own row, gated on the card.
    tasks.capture.fileHostCardTask({
      id: "host-row",
      title: "Your first mate hit a problem",
      cardId: "card-fm-9",
    });
    const board = protocol.board();
    const view = (id: string) => board.tasks.find((task) => task.id === id);
    expect(view("capped")?.flags).toMatchObject({ held: true, needsYou: false });
    expect(view("carded")).toMatchObject({
      flags: { held: true, needsYou: true },
      waitingCardId: "card-fm-9",
    });
    expect(view("timed")?.flags).toMatchObject({ held: true, needsYou: false });
    expect(view("free")?.flags).toMatchObject({ held: false, needsYou: false });
    expect(view("host-row")).toMatchObject({
      kind: "operation",
      status: "open",
      flags: { held: true, needsYou: true, ready: false },
      waitingCardId: "card-fm-9",
    });
    for (const id of ["capped", "carded", "timed", "free"]) {
      const record = tasks.get(id);
      expect(record && tasks.graph.flagsOf(record).held, id).toBe(view(id)?.flags.held);
    }
  });

  it("retains a declared hold without listing a cardless task as waiting on the captain (FI3-702)", () => {
    const { tasks, protocol } = taskProtocolFixture();
    const workspace = { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/w", branch: "fm/w" };
    tasks.create({ id: "w", title: "Release", prompt: "p", repoId: "r1" });
    tasks.starts.dispatch("w", { workspace, accountId: null, assignee: "crewmate 1" });
    tasks.turns.setActivity("w", "running");
    tasks.turns.recordReport("w", {
      text: "The release is out; the captain may still want the old build.",
      declared: { wait: { reason: "decide whether to keep the old build" } },
    });
    const waiting = protocol.board();
    const row = waiting.tasks.find((task) => task.id === "w");
    expect(row).toMatchObject({ captainWait: true, waitingCardId: null });
    expect(row?.flags.needsYou).toBe(true);
    expect(row && nowGroupOf(row)).toBe("working");
    expect(waiting.projects.find((project) => project.key === "NIA")?.counts.waitingOnYou).toBe(0);
    // It survives the wire the window reads the board through.
    expect(taskBoardSchema.parse(waiting).tasks.find((task) => task.id === "w")?.captainWait).toBe(
      true,
    );

    // The next turn releases it.
    expect(tasks.turns.clearDeclaration("w")).toBe(true);
    const moved = protocol.board().tasks.find((task) => task.id === "w");
    expect(moved?.captainWait).toBeUndefined();
    expect(moved && nowGroupOf(moved)).toBe("working");
    expect(tasks.turns.clearDeclaration("w")).toBe(false);
  });
});
