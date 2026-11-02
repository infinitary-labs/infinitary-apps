import type { Card } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import type { CorePushChannel, PushPayload } from "@shared/ipc";
import { nowGroupOf } from "@shared/nowPanel";
import {
  DROPPED_BEFORE_START_ACTIVITY,
  dropReviewKeys,
  NO_LONGER_WANTED,
} from "@shared/recordDrop";
import {
  applyTaskBoardDelta,
  BOARD_RECENT_MS,
  type TaskBoard,
  type TaskBoardDelta,
  taskBoardDeltaSchema,
  taskBoardSchema,
  taskDetailSchema,
} from "@shared/tasks";
import type { WorkPosture } from "@shared/workPosture";
import { describe, expect, it, vi } from "vitest";
import { rowsRead } from "../../../tests/helpers/database";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { modelReasonOf } from "../routing/modelReason";
import { servedSlots } from "../routing/router";
import { ActivityStore } from "../storage/activityStore";
import { openInMemoryDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { seedTask } from "./seedTask";
import { exportTaskRecords, parseTaskExport } from "./taskExport";
import { recentFeed, SETTLE_FOLD } from "./taskFeed";
import { TaskProtocol } from "./taskProtocol";
import { queryTasks } from "./taskQuery";
import { type TaskChange, TaskService, TIMELINE_CAP } from "./taskService";

/**
 * The task protocol (task-system P3, design section 9). The acceptance the
 * build plan names: a snapshot pushed after N mutations equals a fresh
 * board read, because both are rebuilt from SQLite after the commit. Plus
 * the seams around it: one seq per committed mutation (nested writes are
 * one), the wire events the change becomes, the board's bounds, the
 * derived flags, and the feed as a view over the timeline.
 */

const DAY = 24 * 60 * 60 * 1000;

function setup(
  options: {
    deltaTrigger?: { rows: number; bytes: number };
    workPosture?: ConstructorParameters<typeof TaskProtocol>[0]["workPosture"];
    place?: (
      record: import("../storage/taskStore").TaskRecord,
    ) => import("@shared/tasks").TaskPlace;
    modelLabel?: (model: string) => string | undefined;
    actions?: (
      record: import("../storage/taskStore").TaskRecord,
    ) => readonly import("@shared/tasks").TaskActionLine[];
  } = {},
) {
  const db = openInMemoryDatabase();
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', NULL, 'direct-pr', 1)",
  ).run("r1", "/fleet/nimbus-api", "nimbus-api", 1);
  let now = 10 * DAY;
  const tasks = new TaskService({
    db,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: () => now,
    strict: true,
  });
  tasks.projects.ensureForRepo({ id: "r1", name: "nimbus-api" });
  const activity = new ActivityStore(db, () => now);
  const cards: Card[] = [];
  const snapshot = vi.fn(() => cards);
  const events: FmEvent[] = [];
  const pushes: { channel: CorePushChannel; payload: unknown }[] = [];
  const changes: TaskChange[] = [];
  tasks.onChange((change) => changes.push(change));
  const protocolOptions = {
    tasks,
    workPosture: options.workPosture,
    ...(options.place ? { place: options.place } : {}),
    repos: {
      get: (id: string) =>
        id === "r1"
          ? { name: "nimbus-api", delivery: "direct-pr" as const, autonomy: true }
          : undefined,
    },
    cards: { listOpen: () => cards, snapshot },
    tiers: (taskIds: readonly string[]) => servedSlots(new DecisionStore(db), taskIds),
    modelReason: (record: import("../storage/taskStore").TaskRecord) =>
      modelReasonOf(record, {
        decisions: new DecisionStore(db),
        pins: () => [],
        keyOf: (ref) => tasks.resolve(ref)?.key || undefined,
      }),
    now: () => now,
    coalesceMs: 0,
    ...(options.deltaTrigger ? { deltaTrigger: options.deltaTrigger } : {}),
    ...(options.modelLabel ? { modelLabel: options.modelLabel } : {}),
    ...(options.actions ? { actions: options.actions } : {}),
  };
  const protocol = new TaskProtocol({
    ...protocolOptions,
    broadcastEvent: (event) => events.push(event),
    emit: <C extends CorePushChannel>(channel: C, payload: PushPayload<C>) => {
      pushes.push({ channel, payload });
    },
  });
  /** The board a protocol that kept nothing builds from the same record and cards (INF-2078). */
  const fresh = () => {
    const other = new TaskProtocol({
      ...protocolOptions,
      broadcastEvent: () => {},
      emit: () => {},
    });
    try {
      return other.board();
    } finally {
      other.dispose();
    }
  };
  const boards = () =>
    pushes.filter((push) => push.channel === "inf:tasks").map((push) => push.payload as TaskBoard);
  const deltas = () =>
    pushes
      .filter((push) => push.channel === "inf:tasks:delta")
      .map((push) => push.payload as TaskBoardDelta);
  /** Every board push in order, each tagged with its carrier. */
  const carried = () =>
    pushes
      .filter((push) => push.channel === "inf:tasks" || push.channel === "inf:tasks:delta")
      .map((push) => ({ channel: push.channel, payload: push.payload }));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    db,
    tasks,
    activity,
    protocol,
    cards,
    snapshot,
    events,
    changes,
    boards,
    deltas,
    carried,
    fresh,
    settle,
    tick: (ms = 1) => (now += ms),
    clock: () => now,
  };
}

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
      (record: import("../storage/taskStore").TaskRecord): WorkPosture =>
        record.gate ? { state: "idle", reason: "captain" } : { state: "idle", reason: "inactive" },
    );
    const f = setup({ place, workPosture: posture });
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
      f.tasks.setGate("work", { kind: "captain", ref: "review" });
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
    const f = setup({ place });
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

  // INF-2255: projects() rebuilt full task views for counts even after a
  // warm board had already derived exactly those counts.
  it("serves project counts through the current board without rebuilding unchanged views", () => {
    const posture = vi.fn((): WorkPosture => ({ state: "idle", reason: "captain" }));
    const f = setup({ workPosture: posture });
    try {
      f.tasks.create({
        id: "work",
        title: "Keep project counts current",
        prompt: "",
        repoId: "r1",
      });
      const first = f.protocol.board();
      posture.mockClear();
      expect(f.protocol.projects()).toEqual(first.projects);
      expect(posture).not.toHaveBeenCalled();
      f.tasks.close("work", { status: "done", reason: "settled", actor: "host" });
      expect(f.protocol.projects()).toEqual(f.fresh().projects);
      f.tick(BOARD_RECENT_MS + 1);
      expect(f.protocol.projects()).toEqual(f.fresh().projects);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  // INF-2186: unchanged board reads must not repeat blockerCleared work.
  it("does not recheck blocker statuses on unchanged board reads, but sees a blocker finish", () => {
    const f = setup();
    const cleared = vi.spyOn(TaskService, "blockerCleared");
    try {
      const blocker = f.tasks.create({
        id: "build",
        title: "Build the task read projection",
        prompt: "",
        repoId: "r1",
      });
      f.tasks.create({
        id: "verify",
        title: "Verify the task board refresh",
        prompt: "",
        repoId: "r1",
        blockedBy: [blocker.id],
      });
      cleared.mockClear();
      const first = f.protocol.board().tasks.find((task) => task.id === "verify");
      expect(first?.blockedBy).toEqual([blocker.key]);
      const coldChecks = cleared.mock.calls.length;
      expect(coldChecks).toBeGreaterThan(0);
      cleared.mockClear();
      for (let read = 0; read < 40; read += 1)
        expect(f.protocol.board().tasks.find((task) => task.id === "verify")).toBe(first);
      const warmChecks = cleared.mock.calls.length;
      expect(warmChecks).toBe(0);
      f.tasks.close(blocker.id, { status: "done", reason: "settled", actor: "host" });
      expect(f.protocol.board().tasks.find((task) => task.id === "verify")?.blockedBy).toEqual([]);
      const changedChecks = cleared.mock.calls.length;
      expect(changedChecks).toBeGreaterThan(0);
      console.info(
        JSON.stringify({
          intent: "INF-2186 blocker status checks",
          coldChecks,
          warmChecks,
          changedChecks,
        }),
      );
    } finally {
      cleared.mockRestore();
      f.protocol.dispose();
      f.db.close();
    }
  });

  // INF-2186: the row cache already owns current records; a presentation
  // pass must not rebuild them from SQLite merely to publish live facts.
  it("refreshes presentation from cached records including pending creates and closes", () => {
    const f = setup({ workPosture: () => ({ state: "idle", reason: "captain" }) });
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
      const links = vi.spyOn(f.tasks, "linksTouching");
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
    const f = setup({
      workPosture: (record) => (record.gate ? held : { state: "idle", reason: "inactive" }),
    });
    try {
      f.tasks.create({ id: "work", title: "Verify the shared read", prompt: "", repoId: "r1" });
      f.protocol.board();
      f.protocol.refreshPresentation((record) => {
        f.tasks.setGate(record.id, { kind: "captain", ref: "completion-choice" });
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
    const readPosture = vi.fn((record: import("../storage/taskStore").TaskRecord) => {
      if (!tasks) throw new Error("Missing task reader");
      expect(tasks.get(record.id)).toBe(record);
      return posture;
    });
    const f = setup({ workPosture: readPosture });
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
    const f = setup({ workPosture: posture });
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
    const f = setup();
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
  // INF-2186 / INF-2192: every shown row walked all board links in waitsSince.
  it("reads each wait edge a bounded number of times when building the board", () => {
    const measure = (waiting: number) => {
      const f = setup();
      try {
        const baseline = f.tasks.create({
          id: "baseline",
          title: "Repair the failing checks",
          prompt: "",
          repoId: "r1",
        });
        for (let i = 0; i < waiting; i += 1) {
          const id = `waiting-${i}`;
          f.tasks.create({ id, title: "Wait for the check repair", prompt: "", repoId: "r1" });
          f.tasks.link("baseline", id, "blocks", "firstmate");
        }
        const links = f.tasks.linksTouching(f.tasks.listLive().map((row) => row.id));
        let edgeReads = 0;
        const measured = links.map((link) => ({
          ...link,
          get type() {
            edgeReads += 1;
            return link.type;
          },
        }));
        vi.spyOn(f.tasks, "linksTouching").mockReturnValue(measured);
        const board = f.protocol.board();
        for (const row of board.tasks.filter((row) => row.id !== "baseline")) {
          expect(row.blockedBy).toEqual([baseline.key]);
          expect(row.blockedSince).toEqual({ [baseline.key]: f.clock() });
        }
        return { edges: links.length, edgeReads, rows: board.tasks.length };
      } finally {
        f.protocol.dispose();
        f.db.close();
        vi.restoreAllMocks();
      }
    };
    const small = measure(20);
    const large = measure(40);
    // Doubling the rows and their edges doubles the work, never quadruples it.
    // This allows the row cache's linear edge index, not an all-edge walk per row.
    console.info(JSON.stringify({ intent: "INF-2186 board wait edges", small, large }));
    expect(large.edgeReads).toBe(small.edgeReads * (large.edges / small.edges));
  });
  // INF-1348: separating the minute pass into turns must still publish one
  // final board, not let the board timer fire between registrations.
  it("holds an already queued board across sweep turns and sends the final saved state once", async () => {
    const f = setup();
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
  it("publishes presentation-only changes through events, detail and sequenced deltas without changing the idle clock", async () => {
    let posture: WorkPosture = { state: "idle", reason: "captain" };
    const f = setup({ workPosture: () => posture, deltaTrigger: { rows: 0, bytes: 0 } });
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
    const f = setup({
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

  it("folds what the crewmate did into the record's Activity at each read, writing nothing to the task", () => {
    const did: import("@shared/tasks").TaskActionLine[] = [];
    const f = setup({ actions: () => did });
    f.tasks.create({ id: "t", title: "Work", prompt: "p", repoId: "r1" });
    f.tick();
    f.tasks.noteProgress("t", "Reading the log.");
    const before = f.tasks.timeline("t").length;
    did.push(
      { at: f.clock(), text: "Read the failing journey's log" },
      { at: f.clock() + 5, text: "Run the journey alone" },
    );
    const detail = taskDetailSchema.parse(f.protocol.detail("t"));
    expect(
      detail.activityLog.map((row) => [row.text, row.actions?.map((line) => line.text)]),
    ).toEqual([
      [expect.any(String), undefined],
      ["Reading the log.", ["Read the failing journey's log", "Run the journey alone"]],
    ]);
    expect(f.tasks.timeline("t")).toHaveLength(before);
    f.protocol.dispose();
    f.db.close();
  });

  it("reads the newest plan a progress note carried, each item since it first read its state (FI3-734)", () => {
    const f = setup();
    f.tasks.create({ id: "t", title: "Work", prompt: "p", repoId: "r1" });
    expect(f.protocol.detail("t").plan).toBeNull();
    const item = (label: string, state: "done" | "current" | "next" | "skipped") => ({
      label,
      short: label.slice(0, 6),
      state,
    });
    f.tick();
    f.tasks.noteProgress("t", "Briefed", "crewmate", [
      item("Reproduce", "current"),
      item("Fix", "next"),
    ]);
    const first = f.tasks.timeline("t").at(-1)?.at ?? 0;
    f.tick();
    f.tasks.noteProgress("t", "Halfway");
    f.tick();
    f.tasks.noteProgress("t", "Reproduced", "crewmate", [
      item("Reproduce", "done"),
      item("Fix", "current"),
    ]);
    const second = f.tasks.timeline("t").at(-1)?.at ?? 0;
    f.tick();
    // Folded: one item stands for the two before it, since the note that folded them.
    f.tasks.noteProgress("t", "Folded", "crewmate", [
      item("Reproduce", "done"),
      item("Fix", "current"),
      item("Ship", "next"),
    ]);
    const third = f.tasks.timeline("t").at(-1)?.at ?? 0;
    const detail = f.protocol.detail("t");
    expect(detail.plan).toEqual({
      at: third,
      items: [
        { ...item("Reproduce", "done"), since: second },
        { ...item("Fix", "current"), since: second },
        { ...item("Ship", "next"), since: third },
      ],
    });
    expect(first).toBeLessThan(second);
    expect(taskDetailSchema.safeParse(detail).success).toBe(true);
    f.protocol.dispose();
    f.db.close();
  });

  it("keeps the newest plan when compaction folds the note that carried it (INF-866 K2)", () => {
    const f = setup();
    f.tasks.create({ id: "t", title: "Work", prompt: "p", repoId: "r1" });
    const plan = [
      { label: "Find", short: "Find", state: "done" as const },
      { label: "Check", short: "Check", state: "current" as const },
    ];
    f.tick();
    f.tasks.noteProgress("t", "Phase: check", "host", plan);
    const at = f.tasks.timeline("t").at(-1)?.at ?? 0;
    // A long run of plain lines follows, enough that the plan's own note folds.
    for (let index = 0; index < TIMELINE_CAP; index += 1) {
      f.tick();
      f.tasks.noteProgress("t", `checked file ${index}`);
    }
    const timeline = f.tasks.timeline("t");
    expect(timeline.some((event) => event.text === "Phase: check")).toBe(false);
    expect(f.protocol.detail("t").plan).toEqual({
      at,
      items: plan.map((item) => ({ ...item, since: at })),
    });
    f.protocol.dispose();
    f.db.close();
  });

  it("identifies a host-shaped review's builder on both the board and change stream", () => {
    const { tasks, protocol, events } = setup();
    tasks.create({ id: "builder", title: "Build", prompt: "p", repoId: "r1" });
    tasks.create({
      id: "ordinary",
      title: "Other child",
      prompt: "p",
      repoId: "r1",
      parentId: "builder",
    });
    tasks.create({
      id: "independent",
      title: "Unrelated review",
      prompt: "p",
      repoId: "r1",
      parentId: "builder",
      shape: { kind: "review" },
    });
    tasks.create({
      id: "reviewer",
      title: "Review",
      prompt: "p",
      repoId: "r1",
      parentId: "builder",
      shape: { kind: "review", kind_source: "host:review", basis: "builder" },
    });
    expect(
      Object.fromEntries(protocol.board().tasks.map((task) => [task.id, task.reviewOf])),
    ).toEqual({
      builder: null,
      ordinary: null,
      independent: null,
      reviewer: "builder",
    });
    // Every change names its task's builder; a part's filing also changes
    // its parent's record, which reads it (docs/task-record.md).
    const changed = events.flatMap((event) =>
      event.type === "task_changed" ? [[event.taskId, event.reviewOf]] : [],
    );
    expect(new Set(changed.map(([taskId]) => taskId))).toEqual(
      new Set(["builder", "ordinary", "independent", "reviewer"]),
    );
    for (const [taskId, reviewOf] of changed) {
      expect(reviewOf).toBe(taskId === "reviewer" ? "builder" : null);
    }
  });

  it("publishes actual placement together on the board and task-change stream", () => {
    const { tasks, protocol, events } = setup();
    tasks.create({ id: "placed", title: "Placed crew", prompt: "p", repoId: "r1" });
    expect(
      protocol.board().tasks.find((task) => task.id === "placed")?.executionDeviceId,
    ).toBeNull();
    tasks.setDevice("placed", "computer-a");
    expect(protocol.board().tasks.find((task) => task.id === "placed")?.executionDeviceId).toBe(
      "computer-a",
    );
    expect(events.findLast((event) => event.type === "task_changed")).toMatchObject({
      taskId: "placed",
      executionDeviceId: "computer-a",
    });
    tasks.setDevice("placed", null);
    expect(events.findLast((event) => event.type === "task_changed")).toMatchObject({
      taskId: "placed",
      executionDeviceId: null,
    });
  });

  it("pushes a snapshot after N mutations that equals a fresh board read, under one rising seq", async () => {
    const { tasks, protocol, boards, settle, tick, cards } = setup();
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
    tasks.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
      model: { provider: "openai", id: "gpt-5" },
    });
    tick();
    tasks.recordReport("a", { text: "Done the thing. Details follow." });
    tick();
    tasks.noteProgress("a", "halfway");
    tick();
    tasks.link("c", "a", "related", "firstmate");
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
    tasks.fileDecision({ id: "d", title: "Which way?", cardId: "card-d" });
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
    // The acceptance: the pushed snapshot IS the fresh read.
    expect(last).toEqual(protocol.board());
    expect(taskBoardSchema.parse(last)).toEqual(last);
    expect(last.seq).toBe(tasks.boardSeq());
    expect(last.seq).toBe(11);
    for (let index = 1; index < pushed.length; index += 1) {
      expect((pushed[index] as TaskBoard).seq).toBeGreaterThan(
        (pushed[index - 1] as TaskBoard).seq,
      );
    }
    // And after a further mutation the fresh read moves past the last push.
    tick();
    tasks.updateFields("b", { title: "B2" }, "firstmate");
    expect(protocol.board().seq).toBe(12);
    expect(protocol.board().tasks.find((task) => task.id === "b")?.title).toBe("B2");
  });

  it("coalesces a burst into one push and bumps nothing for a write that changes nothing", async () => {
    const { tasks, boards, settle } = setup();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: null });
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: null });
    tasks.setActivity("a", "idle");
    await settle();
    expect(boards()).toHaveLength(1);
    expect(boards()[0]?.seq).toBe(3);
    // No-op writes leave the sequence alone.
    tasks.setParent("a", null, "firstmate");
    tasks.updateFields("a", { title: "A" }, "firstmate");
    await settle();
    expect(tasks.boardSeq()).toBe(3);
    expect(boards()).toHaveLength(1);
  });

  it("shows a crew filing as found on its origin, new until the captain opens it", () => {
    const { tasks, protocol } = setup();
    tasks.create({ id: "origin", title: "Origin", prompt: "p", repoId: "r1" });
    const origin = tasks.get("origin");
    const { record } = tasks.fileFollowup({
      id: "fu",
      originId: "origin",
      title: "Follow-up",
      goal: "g",
      why: "the meter test failed",
      prompt: "p",
    });
    expect(protocol.board().tasks.find((task) => task.id === record.id)).toMatchObject({
      foundOn: origin?.key,
      filingNew: true,
    });
    expect(protocol.detail(record.id).filing).toEqual({
      why: "the meter test failed",
      originKey: origin?.key,
      verdict: null,
    });
    tasks.markOpened(record.id);
    expect(protocol.board().tasks.find((task) => task.id === record.id)?.filingNew).toBe(false);
    expect(taskDetailSchema.safeParse(protocol.detail(record.id)).success).toBe(true);
  });

  it("commits a nested write as one change with one seq, and drops the change of a refused write", () => {
    const { tasks, changes } = setup();
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
    // A refused edge (a cycle) commits nothing and notifies nothing.
    expect(() => tasks.link("origin", "f", "blocks", "firstmate")).toThrow(/cycle/);
    expect(changes).toHaveLength(1);
    expect(tasks.boardSeq()).toBe(2);
  });

  it("emits task_event lines authored from the record and task_changed per touched row", async () => {
    const { tasks, events, tick, settle } = setup();
    tasks.create({ id: "a", title: "Fix it", prompt: "p", repoId: "r1" });
    tasks.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
    });
    tick();
    tasks.recordReport("a", { text: "Steady as she goes. More later." });
    tick();
    tasks.noteProgress("a", "halfway");
    tick();
    tasks.recordTurnFailure("a", "Connection error.");
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

  it("carries why a crewmate runs on its model in the record's detail, never on the board", () => {
    const { db, tasks, protocol } = setup();
    const model = { provider: "openai-codex", id: "gpt-5.5" };
    const plan = seedTask(tasks, {
      id: "plan",
      title: "The plan",
      status: "completed",
      outcome: "Planned.",
    });
    seedTask(tasks, {
      id: "build",
      title: "Build it",
      status: "idle",
      model,
      shape: { kind: "implement", basis: "plan", basis_verified: true },
    });
    seedTask(tasks, { id: "unrouted", title: "Never routed", status: "idle", model });
    new DecisionStore(db).recordRouting({
      taskId: "build",
      ...model,
      model: model.id,
      bucket: "medium",
      rule: "R4",
      served: "medium",
      reasons: ["rule R4: implement on the verified basis plan -> medium"],
    });
    const detail = protocol.detail("build");
    expect(detail.modelReason).toEqual({
      rule: "R4",
      asked: "medium",
      served: "medium",
      basis: plan.key,
    });
    expect(taskDetailSchema.safeParse(detail).success).toBe(true);
    expect(protocol.detail("unrouted")).not.toHaveProperty("modelReason");
    expect(protocol.board().tasks.find((task) => task.id === "build")).not.toHaveProperty(
      "modelReason",
    );
  });

  it("carries the reasoning a crewmate's session opened at while it is still on that model", () => {
    const { tasks, protocol } = setup();
    const model = { provider: "anthropic-claude", id: "claude-opus-5-5" };
    seedTask(tasks, {
      id: "quick",
      title: "A Quick change",
      status: "idle",
      model,
      reasoning: { level: "high", lower: "quick" },
    });
    seedTask(tasks, {
      id: "unsaid",
      title: "Opened before it was recorded",
      status: "idle",
      model,
    });
    const detail = protocol.detail("quick");
    expect(detail.reasoning).toEqual({ level: "high", lower: "quick" });
    expect(taskDetailSchema.safeParse(detail).success).toBe(true);
    expect(protocol.detail("unsaid")).not.toHaveProperty("reasoning");
    expect(protocol.board().tasks.find((task) => task.id === "quick")).not.toHaveProperty(
      "reasoning",
    );
    // Dispatched again on another model that says nothing: the old reasoning
    // was about the old model, so the record no longer claims one.
    tasks.dispatch("quick", {
      workspace: { repoDir: "", worktreeDir: "", branch: "" },
      accountId: null,
      assignee: "crewmate",
      model: { provider: "openai-codex", id: "gpt-6-sol" },
    });
    expect(protocol.detail("quick")).not.toHaveProperty("reasoning");
    // A newer dispatch that says what it opened at is read instead.
    tasks.dispatch("quick", {
      workspace: { repoDir: "", worktreeDir: "", branch: "" },
      accountId: null,
      assignee: "crewmate",
      model: { provider: "openai-codex", id: "gpt-6-sol" },
      reasoning: { level: "medium", lower: "capped" },
    });
    expect(protocol.detail("quick").reasoning).toEqual({ level: "medium", lower: "capped" });
  });

  it("reads each work row's tier off its newest routing decision, the way the orbit paints it", async () => {
    let working = false;
    const { db, tasks, protocol, events, settle, tick } = setup({
      workPosture: () =>
        working ? { state: "active", reason: "turn" } : { state: "idle", reason: "inactive" },
    });
    for (const id of ["down", "legacy", "unserved", "never"]) {
      tasks.create({ id, title: id, prompt: "p", repoId: null });
    }
    tasks.create({ id: "q", title: "a question", prompt: "p", repoId: null, kind: "question" });
    const route = (
      taskId: string,
      at: number,
      provider: string | null,
      bucket: string,
      served: string | null,
    ) =>
      db
        .prepare(
          "INSERT INTO decisions (kind, task_id, provider, model, bucket, rule, served, reasons_json, at) VALUES ('routing', ?, ?, ?, ?, ?, ?, '[]', ?)",
        )
        .run(taskId, provider, provider ? "m" : null, bucket, "R8", served, at);
    // Routed high once, then re-routed and served a weaker slot than asked:
    // the newest decision's served slot wins.
    route("down", 1, "openai-codex", "high", "high");
    route("down", 2, "openai-codex", "high", "medium");
    // Recorded before `served` existed: the slot it asked for.
    route("legacy", 1, "openai-codex", "premium", null);
    // A decision that chose nothing never served anything.
    route("unserved", 1, null, "low", null);
    route("q", 1, "openai-codex", "high", "high");

    // INF-2255: the captain's routing/servedSlots board sample. A cold board
    // batches latest slots; unchanged boards read none and never load history.
    const latest = vi.spyOn(DecisionStore.prototype, "latestChosenSlots");
    const history = vi.spyOn(DecisionStore.prototype, "routing");
    try {
      const cold = protocol.board();
      const coldCalls = latest.mock.calls.map(([ids]) => [...ids]);
      latest.mockClear();
      for (let read = 0; read < 40; read++) expect(protocol.board()).toEqual(cold);
      const warmCalls = latest.mock.calls.length;
      latest.mockClear();
      protocol.refreshPresentation();
      protocol.board();
      const refreshCalls = latest.mock.calls.map(([ids]) => [...ids]);
      console.info(
        JSON.stringify({
          intent: "INF-2255 board tiers",
          coldCalls,
          warmCalls,
          refreshCalls,
          historicalCalls: history.mock.calls.length,
        }),
      );
      expect(coldCalls).toHaveLength(1);
      expect(new Set(coldCalls.flat())).toEqual(
        new Set(cold.tasks.filter((task) => task.kind === "work").map((task) => task.id)),
      );
      expect(warmCalls).toBe(0);
      expect(refreshCalls.length).toBeGreaterThan(0);
      for (const ids of refreshCalls) expect(new Set(ids)).toEqual(new Set(coldCalls[0]));
      expect(history).not.toHaveBeenCalled();
    } finally {
      latest.mockRestore();
      history.mockRestore();
    }
    const tierOf = (id: string) => protocol.board().tasks.find((task) => task.id === id)?.tier;
    expect(tierOf("down")).toBe("medium");
    expect(tierOf("legacy")).toBe("premium");
    expect(tierOf("unserved")).toBeNull();
    expect(tierOf("never")).toBeNull();
    // Only work has a crewmate; a question's routing never becomes a solid.
    expect(tierOf("q")).toBeNull();
    expect(protocol.detail("down").tier).toBe("medium");

    // The change event carries the same reading, so the orbit hears it live.
    events.length = 0;
    tick();
    tasks.setSessionFile("down", "session-1");
    tasks.setSessionFile("q", "session-2");
    await settle();
    const changed = events.flatMap((event) => (event.type === "task_changed" ? [event] : []));
    expect(changed.find((event) => event.taskId === "down")).toMatchObject({ tier: "medium" });
    expect(changed.find((event) => event.taskId === "q")).not.toHaveProperty("tier");
    // A routing commit is its own write, before the task's dispatch update.
    // A queued presentation must not hide that newer served slot.
    working = true;
    protocol.refreshPresentation();
    route("down", 3, "openai-codex", "high", "low");
    expect(tierOf("down")).toBe("low");
    tasks.setSessionFile("down", "session-3");
    expect(tierOf("down")).toBe("low");
  });

  it("authors the decommission lines from the close, and a failed close as a task failure", async () => {
    const { tasks, events, settle } = setup();
    for (const id of ["a", "b", "c"]) {
      tasks.create({ id, title: `T-${id}`, prompt: "p", repoId: null });
      tasks.dispatch(id, {
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

  it("finds closed work beyond the board's window, and dropped work, only for typed text", () => {
    const { tasks, protocol, tick } = setup();
    tasks.create({ id: "old-done", title: "Reconcile idle answers", prompt: "p", repoId: null });
    tasks.create({
      id: "old-goal",
      title: "Other",
      goal: "tidy the zebra",
      prompt: "p",
      repoId: null,
    });
    tasks.create({ id: "dropped", title: "Stalled zebra follow-up", prompt: "p", repoId: null });
    tasks.create({ id: "live", title: "Live zebra", prompt: "p", repoId: null });
    tasks.close("old-done", { status: "done", reason: "settled", actor: "host" });
    tasks.close("old-goal", { status: "done", reason: "settled", actor: "host" });
    tick(BOARD_RECENT_MS + 1);
    tasks.create({ id: "recent", title: "Recent zebra", prompt: "p", repoId: null });
    tasks.close("recent", { status: "done", reason: "settled", actor: "host" });
    tasks.close("dropped", { status: "dropped", reason: "superseded", actor: "host" });
    const ids = (text: string) => protocol.search(text).map((task) => task.id);
    // Nothing earlier until text is typed.
    expect(protocol.search("")).toEqual([]);
    expect(protocol.search("   ")).toEqual([]);
    // Eight-day-old work by title, and dropped work of any age, never live or
    // recently done work (the board lists those).
    expect(ids("idle")).toEqual(["old-done"]);
    expect(ids("ZEBRA").sort()).toEqual(["dropped", "old-goal"]);
    // Key and goal match too.
    const key = protocol.search("idle")[0]?.key ?? "";
    expect(ids(key.toLowerCase())).toEqual(["old-done"]);
    expect(ids("nothing like this")).toEqual([]);
    // The result is the board's own row shape, so the panel paints it as any row.
    expect(protocol.search("idle")[0]).toMatchObject({
      status: "done",
      title: "Reconcile idle answers",
    });
  });

  it("answers at most 50 earlier matches, newest first, the limit the panel contract names", () => {
    const { tasks, protocol, tick } = setup();
    for (let i = 0; i < 55; i += 1) {
      tasks.create({ id: `old-${i}`, title: `Older zebra ${i}`, prompt: "p", repoId: null });
      tasks.close(`old-${i}`, { status: "done", reason: "settled", actor: "host" });
      tick(1);
    }
    tick(BOARD_RECENT_MS + 1);
    const found = protocol.search("zebra");
    // `PanelTaskSearch` says an answer of 50 may have been cut; the task board asks for narrower words then.
    expect(found).toHaveLength(50);
    expect(found[0]?.id).toBe("old-54");
  });

  it("finds a title with a curly apostrophe or quote from the plain one typed (FI3-930)", () => {
    const { tasks, protocol } = setup();
    const titles = {
      note: "What’s new in 0.1.28",
      quoted: "Rename the “Later” group",
      plain: "Don't rename it",
    };
    for (const [id, title] of Object.entries(titles)) {
      tasks.create({ id, kind: "question", title, prompt: "p", repoId: null });
      tasks.close(id, { status: "done", reason: "answered", actor: "host" });
    }
    const ids = (text: string) => protocol.search(text).map((task) => task.id);
    expect(ids("what's new")).toEqual(["note"]);
    expect(ids("What’s new")).toEqual(["note"]);
    expect(ids('"later"')).toEqual(["quoted"]);
    expect(ids("don’t")).toEqual(["plain"]);
  });

  it("finds a question answered within the board's window, which the panel never lists", () => {
    const { tasks, protocol } = setup();
    tasks.create({ id: "q", kind: "question", title: "Gauge", prompt: "p", repoId: null });
    tasks.close("q", { status: "done", reason: "answered", actor: "host" });
    tasks.create({ id: "w", title: "Gauge work", prompt: "p", repoId: null });
    tasks.close("w", { status: "done", reason: "settled", actor: "host" });
    const key = protocol.board().tasks.find((task) => task.id === "q")?.key ?? "";
    expect(protocol.search(key).map((task) => task.id)).toEqual(["q"]);
    // Recently done work stays the board's: the panel lists it as landed.
    expect(protocol.search("gauge").map((task) => task.id)).toEqual(["q"]);
  });

  it("bounds the board to the live set plus recent closes, keeping a shown row's parent", () => {
    const { tasks, protocol, tick } = setup();
    tasks.create({ id: "old-parent", title: "Old parent", prompt: "p", repoId: null });
    tasks.create({ id: "old-done", title: "Old done", prompt: "p", repoId: null });
    tasks.create({
      id: "child",
      title: "Child",
      prompt: "p",
      repoId: null,
      parentId: "old-parent",
    });
    tasks.close("old-parent", { status: "done", reason: "settled", actor: "host" });
    tasks.close("old-done", { status: "done", reason: "settled", actor: "host" });
    tasks.create({ id: "recent-done", title: "Recent", prompt: "p", repoId: null });
    tick(BOARD_RECENT_MS + 1);
    tasks.close("recent-done", { status: "done", reason: "settled", actor: "host" });
    tasks.link("old-done", "child", "related", "firstmate");
    const board = protocol.board();
    expect(board.tasks.map((task) => task.id).sort()).toEqual([
      "child",
      "old-parent",
      "recent-done",
    ]);
    // Links reach only across shown rows.
    expect(board.links).toEqual([]);
    // History is still readable one task at a time.
    expect(protocol.detail("old-done").status).toBe("done");
    expect(() => protocol.detail("nope")).toThrow('Unknown task "nope"');
  });

  // INF-703: every crew event pushes the board, and reading the captain's
  // 3,000 closed tasks on each push delayed keys in the message box.
  it("reads no row closed before the board's window to push it, however long the record (INF-703)", () => {
    const pushed = (history: number) => {
      const f = setup();
      // The old work the live rows still name: a parent and a filing's origin.
      f.tasks.create({ id: "old-parent", title: "Old parent", prompt: "p", repoId: "r1" });
      f.tasks.create({ id: "origin", title: "Origin", prompt: "p", repoId: "r1" });
      const { record: filed } = f.tasks.fileFollowup({
        id: "filed",
        originId: "origin",
        title: "Follow-up still open",
        goal: "g",
        why: "the meter test failed",
        prompt: "p",
      });
      // The rest of the history: a chain of crew filings, each closed.
      let from = "origin";
      for (let i = 0; i < history; i++) {
        const { record } = f.tasks.fileFollowup({
          id: `old-${i}`,
          originId: from,
          title: `Earlier follow-up ${i}`,
          goal: "g",
          why: "found while working",
          prompt: "p",
        });
        from = record.id;
      }
      for (let i = 0; i < history; i++)
        f.tasks.close(`old-${i}`, { status: "done", reason: "settled", actor: "host" });
      f.tasks.create({ id: "recent", title: "Recent", prompt: "p", repoId: "r1" });
      f.tasks.create({
        id: "child",
        title: "Child",
        prompt: "p",
        repoId: "r1",
        parentId: "old-parent",
      });
      f.tasks.close("old-parent", { status: "done", reason: "settled", actor: "host" });
      f.tasks.close("origin", { status: "done", reason: "settled", actor: "host" });
      f.tick(BOARD_RECENT_MS + 1);
      f.tasks.close("recent", { status: "done", reason: "settled", actor: "host" });
      f.protocol.refreshPresentation();
      const rows = rowsRead(f.db, () => {
        f.protocol.refreshPresentation();
        f.protocol.board();
      });
      const board = f.protocol.board();
      return { rows, board, originKey: f.tasks.get("origin")?.key, filed: filed.id };
    };
    const short = pushed(0);
    const long = pushed(200);
    expect(long.board.tasks.map((task) => task.id).sort()).toEqual(
      ["child", "filed", "old-parent", "recent"].sort(),
    );
    expect(long.board.tasks.find((task) => task.id === long.filed)?.foundOn).toBe(long.originKey);
    expect(long.board.tasks.find((task) => task.id === "old-parent")?.children).toEqual({
      total: 1,
      closed: 0,
    });
    expect(long.board.projects).toEqual(short.board.projects);
    expect(long.rows).toBe(short.rows);
  });

  // INF-939: each open of a record's Info read the whole history several
  // times over, and so did the search for each older key a record names.
  it("reads a record and searches older keys without reading the rest of the history (INF-939)", () => {
    const read = (history: number) => {
      const f = setup();
      // The rows the record names: its parent, its filing's origin, a
      // blocker, the work its baseline wait names, and a part whose close
      // concerns it.
      f.tasks.create({ id: "parent", title: "Parent", prompt: "p", repoId: "r1" });
      f.tasks.create({ id: "origin", title: "Gauge origin", prompt: "p", repoId: "r1" });
      f.tasks.create({ id: "blocker", title: "Blocker", prompt: "p", repoId: "r1" });
      seedTask(f.tasks, {
        id: "owner",
        title: "Fix main",
        status: "running",
        worktreeDir: "/wt/o",
      });
      f.tasks.fileFollowup({
        id: "subject",
        originId: "origin",
        title: "Meter follow-up",
        goal: "g",
        why: "the meter test failed",
        prompt: "p",
      });
      f.tasks.setParent("subject", "parent", "firstmate");
      f.tasks.link("blocker", "subject", "blocks", "firstmate");
      f.tasks.create({ id: "part", title: "Part", prompt: "p", repoId: "r1", parentId: "subject" });
      f.tasks.close("part", { status: "done", reason: "settled", actor: "host" });
      f.tasks.close("origin", { status: "dropped", reason: "cancelled", actor: "host" });
      // The rest of the history: a chain of closed crew filings, none of them named.
      f.tasks.create({ id: "old-root", title: "Earlier work", prompt: "p", repoId: "r1" });
      let from = "old-root";
      for (let i = 0; i < history; i++) {
        const { record } = f.tasks.fileFollowup({
          id: `old-${i}`,
          originId: from,
          title: `Earlier follow-up ${i}`,
          goal: "g",
          why: "found while working",
          prompt: "p",
        });
        f.tasks.close(record.id, { status: "dropped", reason: "cancelled", actor: "host" });
        from = record.id;
      }
      seedTask(f.tasks, { id: "waiting", title: "Ship", status: "idle", worktreeDir: "/wt/w" });
      seedDelivery(f.tasks, "waiting", {
        headSha: "head-1",
        ci: "red",
        ciRepair: {
          failures: [{ headSha: "head-1", checks: ["linux-checks"] }],
          diagnoses: [
            {
              headSha: "head-1",
              check: "linux-checks",
              classification: "baseline-blocked",
              evidence: "fails on untouched main",
              dependencyTask: "owner",
              at: 1,
            },
          ],
          repairs: [],
        },
      });
      const scan = rowsRead(f.db, () => f.tasks.listClosedSearchFields());
      const rows = {
        subject: rowsRead(f.db, () => f.protocol.detail("subject")),
        waiting: rowsRead(f.db, () => f.protocol.detail("waiting")),
        // The search scans each closed row's searched fields once, and reads only what it found.
        search: rowsRead(f.db, () => f.protocol.search("gauge")) - scan,
      };
      const subject = f.protocol.detail("subject");
      const waiting = f.protocol.detail("waiting");
      const found = f.protocol.search("gauge");
      return { rows, subject, waiting, found, f };
    };
    const short = read(0);
    const long = read(200);
    const keyOf = (id: string) => long.f.tasks.get(id)?.key;
    expect(long.subject).toMatchObject({
      parentId: "parent",
      blockedBy: [keyOf("blocker")],
      children: { total: 1, closed: 1 },
      foundOn: keyOf("origin"),
      filing: { originKey: keyOf("origin"), why: "the meter test failed" },
    });
    expect(
      new Set(long.subject.activityLog.flatMap((row) => (row.from ? [row.from.key] : []))),
    ).toEqual(new Set([keyOf("part")]));
    expect(long.waiting.blockedBy).toEqual([keyOf("owner")]);
    expect(long.found.map((task) => task.id)).toEqual(["origin"]);
    // The same record reads the same, however long the history behind it.
    expect(long.subject).toEqual(short.subject);
    expect(long.found).toEqual(short.found);
    expect(long.rows).toEqual(short.rows);
  });

  // INF-2070: the board names what replaced each dropped row it shows, and
  // read each one's whole timeline to find a stronger-model move, so opening
  // it on a record the captain's size held the main thread about 300 ms.
  it("names what replaced each dropped row without reading its history, however long (INF-2070)", () => {
    const shown = (history: number) => {
      const f = setup();
      for (const id of ["carrier", "stronger", "carried", "rejected", "dropped"])
        f.tasks.create({ id, title: `Task ${id}`, prompt: "p", repoId: "r1" });
      const keyOf = (id: string) => f.tasks.get(id)?.key ?? id;
      for (const id of ["carried", "rejected", "dropped"])
        for (let i = 0; i < history; i++) f.tasks.noteProgress(id, `Checked part ${i}.`);
      // Another task carries one on; a stronger model takes over another, as
      // CrewSupervisor.applyEscalation writes it; the third is just dropped.
      f.tasks.dropWithChildren("carried", {
        reason: "moved to its carrier",
        actor: "firstmate",
        replacedBy: "carrier",
      });
      f.tasks.recordEscalation({
        from: { id: "rejected", key: keyOf("rejected") },
        to: { id: "stronger", key: keyOf("stronger") },
        attempt: 1,
        tier: "premium",
      });
      f.tasks.close("rejected", {
        status: "dropped",
        reason: "superseded",
        actor: "captain",
        feed: false,
        data: { escalated_to: keyOf("stronger") },
      });
      f.tasks.dropWithChildren("dropped", { reason: "not needed", actor: "captain" });
      const rows = rowsRead(f.db, () => f.protocol.board());
      const replacedBy = Object.fromEntries(
        f.protocol
          .board()
          .tasks.filter((task) => ["carried", "rejected", "dropped"].includes(task.id))
          .map((task) => [task.id, task.replacedBy ?? null]),
      );
      return {
        rows,
        replacedBy,
        expected: { carried: keyOf("carrier"), rejected: keyOf("stronger"), dropped: null },
      };
    };
    const short = shown(0);
    const long = shown(200);
    expect(short.replacedBy).toEqual(short.expected);
    expect(long.replacedBy).toEqual(long.expected);
    expect(long.rows).toBe(short.rows);
  });

  // INF-2078: every crew event pushes the board, and building every shown
  // row from SQLite on each push cost about 175 ms on the captain's record.
  // The board now keeps the rows a change did not reach. What it keeps must
  // be what a build from nothing shows, through every shape of write and
  // through the facts that move with no write of the row.
  it("keeps the rows a change did not reach and equals a board built from nothing, through every shape of write (INF-2078)", () => {
    let posture: WorkPosture = { state: "idle", reason: "captain" };
    const f = setup({
      workPosture: (record) =>
        record.status === "active" ? posture : { state: "idle", reason: "inactive" },
    });
    const { tasks, protocol, cards, fresh, tick } = f;
    const same = (what: string) => {
      const board = protocol.board();
      expect(board, what).toEqual(fresh());
      return board;
    };
    const create = (id: string, extra: Record<string, unknown> = {}) =>
      tasks.create({ id, title: `Task ${id}`, prompt: "p", repoId: "r1", ...extra });
    // A parent awaiting the go, with a part; a blocker and what it blocks; a
    // filing on its origin; an active row waiting on the owner of a baseline
    // failure; a dropped row its carrier replaced; and a row nothing reaches.
    create("parent", { startPolicy: "on-request" });
    create("part", { parentId: "parent", startPolicy: "on-request" });
    create("blocker");
    create("blocked", { blockedBy: ["blocker"] });
    create("origin");
    tasks.fileFollowup({
      id: "filed",
      originId: "origin",
      title: "Follow-up",
      goal: "g",
      why: "found while working",
      prompt: "p",
    });
    create("owner");
    create("waiting", { status: "active" });
    const baseline = (dependencyTask: string) =>
      seedDelivery(tasks, "waiting", {
        headSha: "head-1",
        ci: "red",
        ciRepair: {
          failures: [{ headSha: "head-1", checks: ["linux-checks"] }],
          diagnoses: [
            {
              headSha: "head-1",
              check: "linux-checks",
              classification: "baseline-blocked",
              evidence: "fails on untouched main",
              dependencyTask,
              at: 1,
            },
          ],
          repairs: [],
        },
      });
    baseline("owner");
    create("carrier");
    create("carried");
    tasks.dropWithChildren("carried", {
      reason: "moved to its carrier",
      actor: "firstmate",
      replacedBy: "carrier",
    });
    create("gated");
    create("untouched");
    const first = same("the first read");
    const row = (id: string) => protocol.board().tasks.find((task) => task.id === id);
    const keyOf = (id: string) => tasks.get(id)?.key ?? id;
    const scratch = tasks.projects.scratch().id;

    const steps: [string, () => void][] = [
      ["a title", () => tasks.updateFields("parent", { title: "Parent renamed" }, "firstmate")],
      [
        "a part closing: its parent's counts",
        () => tasks.close("part", { status: "done", reason: "settled", actor: "host" }),
      ],
      ["a part added", () => create("part-2", { parentId: "parent", startPolicy: "on-request" })],
      [
        "a blocker closing: what it blocked",
        () =>
          tasks.close("blocker", {
            status: "done",
            reason: "landed",
            actor: "captain",
            delivery: { landedMode: "fast-forward" },
          }),
      ],
      ["an edge added", () => tasks.link("owner", "blocked", "blocks", "firstmate")],
      ["an edge removed", () => tasks.unlink("owner", "blocked", "blocks", "firstmate")],
      [
        "an origin's key moving: the filing found on it",
        () => tasks.moveToProject("origin", scratch, "firstmate"),
      ],
      [
        "a carrier's key moving: the row it replaced",
        () => tasks.moveToProject("carrier", scratch, "firstmate"),
      ],
      [
        "a baseline owner closing: the active row waiting on it",
        () => tasks.close("owner", { status: "done", reason: "merged", actor: "captain" }),
      ],
      ["a baseline wait naming another row", () => baseline("blocked")],
      [
        "a decision card raised, with no write of its row",
        () =>
          cards.push({
            id: "card-blocked",
            taskId: "blocked",
            author: "firstmate",
            priority: 1,
            title: "Which way?",
            meta: "",
            body: "",
            actions: [{ id: "this-way", label: "This way", default: true }],
            status: "ready",
            createdAt: 1,
          }),
      ],
      [
        "a gate's card going up, with no write of its row",
        () => {
          tasks.setGate("gated", { kind: "captain", ref: "card-gate" });
          cards.push({
            id: "card-gate",
            author: "firstmate",
            priority: 1,
            title: "Merge it?",
            meta: "",
            body: "",
            actions: [{ id: "merge", label: "Merge", default: true }],
            status: "ready",
            createdAt: 1,
          });
        },
      ],
      ["the cards resolved, with no write of their rows", () => cards.splice(0, cards.length)],
      [
        "a posture moving with no write of the row",
        () => {
          posture = { state: "active", reason: "turn" };
          tasks.invalidatePresentation();
        },
      ],
      [
        "the second part closing: its parent's wait dates from it",
        () => tasks.close("part-2", { status: "done", reason: "settled", actor: "host" }),
      ],
      [
        "closed rows aging out of the window: a part's parent reads the parts left",
        () => {
          tasks.close("blocked", { status: "done", reason: "settled", actor: "host" });
          tick(BOARD_RECENT_MS + 1);
          tasks.noteProgress("waiting", "Still here.");
        },
      ],
      [
        "an old row shown while its card is minimized",
        () =>
          cards.push({
            id: "card-old",
            taskId: "blocked",
            author: "firstmate",
            priority: 1,
            title: "Done",
            meta: "",
            body: "",
            actions: [],
            status: "ready",
            createdAt: 1,
            minimized: true,
          }),
      ],
      ["the minimized card gone", () => cards.splice(0, cards.length)],
      ["a row discarded", () => tasks.discardFailedSpawn("gated")],
      ["a row deleted with its edges", () => tasks.discardFailedSpawn("carrier")],
    ];
    const seen = new Set<string>();
    for (const [what, step] of steps) {
      tick();
      step();
      const board = same(what);
      seen.add(JSON.stringify(board.tasks.map((task) => task.id).sort()));
    }
    // The reads that moved what a kept neighbor shows, as a reader sees them.
    expect(row("filed")?.foundOn).toBe(keyOf("origin"));
    expect(keyOf("origin").startsWith("SCR-")).toBe(true);
    expect(row("carried")).toBeUndefined();
    expect(row("waiting")).toMatchObject({ blockedBy: [], workPosture: posture });
    expect(row("blocked")).toBeUndefined();
    expect(row("gated")).toBeUndefined();
    // Its parts closed and aged out, the parent's wait dates from its own creation again.
    expect(row("parent")).toMatchObject({
      children: { total: 2, closed: 2 },
      queueWait: { since: tasks.get("parent")?.createdAt },
    });
    // Membership moved on the way: rows entered, aged out, were shown for a card and left.
    expect(seen.size).toBeGreaterThan(3);
    // The row nothing reached is the row the first read built, by identity.
    expect(protocol.board().tasks.find((task) => task.id === "untouched")).toBe(
      first.tasks.find((task) => task.id === "untouched"),
    );
    // A purge rebuilds from nothing.
    tasks.purge();
    expect(same("after a purge").tasks).toEqual([]);
  });

  it("builds only the rows a change reached and reads the same rows however many the board holds (INF-2078)", () => {
    const seeded = (size: number) => {
      const built: string[] = [];
      const f = setup({
        workPosture: (record) => {
          built.push(record.id);
          return { state: "idle", reason: "captain" };
        },
      });
      // The captain's board, scaled: a parent with parts every fifth row,
      // a blocks edge every tenth, and a filing every seventh.
      for (let i = 0; i < size; i += 1) {
        const id = `t-${i}`;
        f.tasks.create({
          id,
          title: id,
          prompt: "p",
          repoId: "r1",
          ...(i % 5 === 4 ? { parentId: `t-${i - 1}`, startPolicy: "on-request" as const } : {}),
          ...(i % 10 === 3 && i > 11 ? { blockedBy: [`t-${i - 11}`] } : {}),
        });
        if (i % 7 === 6)
          f.tasks.fileFollowup({
            id: `filed-${i}`,
            originId: id,
            title: `Follow-up ${i}`,
            goal: "g",
            why: "found while working",
            prompt: "p",
          });
      }
      f.protocol.board();
      // The board's own work after a change: the rows it reads and the views it builds.
      const measure = (change: () => void) => {
        change();
        built.length = 0;
        const rows = rowsRead(f.db, () => f.protocol.board());
        return { rows, built: [...built].sort() };
      };
      const measured = {
        progress: measure(() => f.tasks.noteProgress("t-25", "Checked a part.")),
        title: measure(() => f.tasks.updateFields("t-20", { title: "Renamed" }, "firstmate")),
        close: measure(() =>
          f.tasks.close("t-22", { status: "done", reason: "landed", actor: "captain" }),
        ),
        link: measure(() => f.tasks.link("t-30", "t-40", "blocks", "firstmate")),
      };
      expect(f.protocol.board()).toEqual(f.fresh());
      return measured;
    };
    const small = seeded(60);
    const large = seeded(240);
    // A progress note on a row with no edge rebuilds that row alone; a write
    // of an origin rebuilds it and the filing found on it; a close its row
    // and what it blocked; a new edge its two ends.
    expect(small.progress.built).toEqual(["t-25"]);
    expect(small.title.built).toEqual(["filed-20", "t-20"]);
    expect(small.close.built).toEqual(["t-22", "t-33"]);
    expect(small.link.built).toEqual(["t-30", "t-40"]);
    for (const shape of ["progress", "title", "close", "link"] as const) {
      expect(large[shape].built, shape).toEqual(small[shape].built);
      expect(large[shape].rows, shape).toBe(small[shape].rows);
    }
  });

  // The scale check (tests/scale-check.test.ts, INF-2061) adds closed work
  // from before the board's window after the first read and expects the
  // board update to run the same statements: a row its write left closed
  // outside the window, which no shown row holds, is ruled out with no read.
  it("reads none of the closed history written outside the board's window to bring the board up to date (INF-2061, INF-2078)", () => {
    const updated = (history: number) => {
      const f = setup();
      for (let i = 0; i < 3; i += 1)
        f.tasks.create({ id: `live-${i}`, title: `Live ${i}`, prompt: "p", repoId: "r1" });
      f.protocol.board();
      for (let i = 0; i < history; i += 1) {
        f.tasks.create({ id: `old-${i}`, title: `Old ${i}`, prompt: "p", repoId: "r1" });
        f.tasks.close(`old-${i}`, { status: "done", reason: "settled", actor: "host" });
      }
      f.tick(BOARD_RECENT_MS + 1);
      const rows = rowsRead(f.db, () => f.protocol.board());
      const board = f.protocol.board();
      expect(board).toEqual(f.fresh());
      return { rows, ids: board.tasks.map((task) => task.id).sort() };
    };
    const few = updated(20);
    const many = updated(200);
    expect(many.ids).toEqual(["live-0", "live-1", "live-2"]);
    expect(many.rows).toBe(few.rows);
  });

  // INF-999: INF-778's summary read Blocked by INF-886 from a recorded wait
  // after the captain's words had released it, while the crewmate's own
  // reader named nothing. The captain chose "Blocked by only for a hold".
  it("names the same waits on the board and in the tasks reader: only those that hold the task now", () => {
    let posture: WorkPosture = { state: "idle", reason: "dependency" };
    const { tasks, protocol } = setup({ workPosture: () => posture });
    for (const id of ["recorded", "marked"])
      tasks.create({ id, title: id, prompt: "p", repoId: null });
    tasks.create({ id: "waiter", title: "waiter", prompt: "p", repoId: null, status: "active" });
    tasks.link("recorded", "waiter", "blocks", "firstmate");
    tasks.link("marked", "waiter", "blocks", "crewmate", true);
    const board = () => [...protocol.detail("waiter").blockedBy].sort();
    const reader = () =>
      [
        ...(queryTasks(tasks, { key: "waiter" }, undefined, undefined, undefined, () => posture)
          .rows[0]?.blocked_by ?? []),
      ].sort();
    const keys = (...ids: string[]) => ids.map((id) => tasks.get(id)?.key).sort();
    // Idle on its waits: the recorded wait holds it, the marked one its merge.
    expect(board()).toEqual(keys("recorded", "marked"));
    expect(reader()).toEqual(board());
    // Working past them: only the merge hold stands.
    posture = { state: "active", reason: "turn" };
    expect(board()).toEqual(keys("marked"));
    expect(reader()).toEqual(board());
    // The captain's words pass the merge hold for the task: nothing holds it.
    seedDelivery(tasks, "waiter", {
      override: { words: "merge it, no need to wait", holds: ["waits"], until: "task", at: 1 },
    });
    expect(board()).toEqual([]);
    expect(reader()).toEqual([]);
  });

  it("shows only live blockers while retaining closed edges and the dropped-start gate", () => {
    // The crewmate stands idle on its waits, so its recorded waits hold it (INF-999).
    let posture: WorkPosture = { state: "idle", reason: "dependency" };
    const { tasks, protocol } = setup({ workPosture: () => posture });
    for (const id of ["merged", "dropped", "discarded", "planned", "working"]) {
      tasks.create({ id, title: id, prompt: "p", repoId: null });
    }
    tasks.dispatch("working", {
      workspace: { repoDir: "/repo", worktreeDir: "/wt/working", branch: "fm/working" },
      accountId: null,
      assignee: "crewmate",
    });
    tasks.close("merged", { status: "done", reason: "merged", actor: "captain" });
    tasks.close("dropped", { status: "dropped", reason: "cancelled", actor: "captain" });
    tasks.close("discarded", { status: "dropped", reason: "discarded", actor: "captain" });
    for (const id of ["active-dependent", "open-dependent"]) {
      tasks.create({
        id,
        title: id,
        prompt: "p",
        repoId: null,
        blockedBy: ["merged", "dropped", "discarded", "planned", "working"],
        ...(id === "active-dependent" ? { status: "active" as const } : {}),
      });
    }
    const shown = () => protocol.board().tasks.filter((task) => task.id.endsWith("-dependent"));
    expect(shown()).toHaveLength(2);
    for (const task of shown()) {
      expect(task.blockedBy).toEqual(["SCR-4", "SCR-5"]);
      expect(protocol.detail(task.id).blockedBy).toEqual(task.blockedBy);
    }
    // A recorded wait holds the start. On work already under way it draws
    // the same arrow and holds no close (INF-416 piece E).
    expect(protocol.detail("open-dependent").flags.blocked).toBe(true);
    expect(protocol.detail("active-dependent").flags.blocked).toBe(false);
    expect(tasks.blockerRefusal("active-dependent")).toBeUndefined();
    // INF-999: INF-778 read Blocked by INF-886 while its crewmate worked on.
    // A recorded wait holds no merge, so it holds a crewmate only while it
    // stands idle on it: working past it, it names nothing.
    posture = { state: "active", reason: "turn" };
    expect(protocol.detail("active-dependent").blockedBy).toEqual([]);
    expect(protocol.detail("open-dependent").blockedBy).toEqual(["SCR-4", "SCR-5"]);
    posture = { state: "idle", reason: "dependency" };
    tasks.close("planned", { status: "done", reason: "landed", actor: "captain" });
    tasks.close("working", { status: "dropped", reason: "discarded", actor: "captain" });
    for (const task of shown()) {
      expect(task.blockedBy).toEqual([]);
      expect(protocol.detail(task.id).blockedBy).toEqual([]);
    }
    // Closed graph edges remain history; they no longer appear as live blockers.
    expect(tasks.blockers("active-dependent")).toHaveLength(5);
    expect(protocol.detail("active-dependent").flags.blocked).toBe(false);
    expect(tasks.blockerRefusal("active-dependent")).toBeUndefined();
    // A dropped dependency still needs an explicit graph decision before starting.
    expect(protocol.detail("open-dependent").flags).toMatchObject({
      blocked: true,
      ready: false,
      needsYou: true,
    });
    expect(tasks.listReady()).toEqual([]);
  });

  it("names the live work an active task's standing baseline wait names among its blockers", () => {
    const { tasks, protocol } = setup();
    seedTask(tasks, { id: "owner", title: "Fix main", status: "running", worktreeDir: "/wt/o" });
    seedTask(tasks, { id: "waiting", title: "Ship", status: "idle", worktreeDir: "/wt/w" });
    seedDelivery(tasks, "waiting", {
      headSha: "head-1",
      ci: "red",
      ciRepair: {
        failures: [{ headSha: "head-1", checks: ["linux-checks"] }],
        diagnoses: [
          {
            headSha: "head-1",
            check: "linux-checks",
            classification: "baseline-blocked",
            evidence: "fails on untouched main",
            dependencyTask: "owner",
            at: 1,
          },
        ],
        repairs: [],
      },
    });
    const view = () => protocol.board().tasks.find((task) => task.id === "waiting");
    const owner = tasks.get("owner")?.key;
    // No edge holds its close (FI3-671), but it waits on that work (FI3-250).
    expect(view()).toMatchObject({ blockedBy: [owner], flags: { blocked: false } });
    expect(protocol.detail("waiting").blockedBy).toEqual([owner]);
    // A new head ends the wait by itself; closed work is never named.
    seedDelivery(tasks, "waiting", { headSha: "head-2", ci: "pending" });
    expect(view()?.blockedBy).toEqual([]);
    seedDelivery(tasks, "waiting", { headSha: "head-1", ci: "red" });
    tasks.close("owner", { status: "done", reason: "merged", actor: "captain" });
    expect(view()?.blockedBy).toEqual([]);
  });

  // INF-38 (INF-1137 friction 5): the captain could not tell how long a
  // crewmate had waited. Each wait says when it was recorded, only from the
  // edge's own time or a dated declaration, and no time when one source has none.
  it("says when each wait that holds a started task was recorded, and never guesses one", () => {
    const { tasks, protocol, tick, clock } = setup({
      workPosture: () => ({ state: "idle", reason: "dependency" }),
    });
    seedTask(tasks, { id: "owner", title: "Fix main", status: "running", worktreeDir: "/wt/o" });
    seedTask(tasks, { id: "other", title: "Fix docs", status: "running", worktreeDir: "/wt/d" });
    seedTask(tasks, { id: "waiting", title: "Ship", status: "idle", worktreeDir: "/wt/w" });
    tick(60_000);
    const linkedAt = clock();
    tasks.link("owner", "waiting", "blocks", "crewmate");
    tick(60_000);
    tasks.link("other", "waiting", "blocks", "crewmate");
    const view = () => protocol.board().tasks.find((task) => task.id === "waiting");
    const key = (id: string) => tasks.get(id)?.key ?? "";
    expect(view()?.blockedSince).toEqual({ [key("owner")]: linkedAt, [key("other")]: clock() });
    expect(protocol.detail("waiting").blockedSince).toEqual(view()?.blockedSince);
    // The same task named by an undated baseline wait loses its time; the
    // edge alone would have said one, so the earliest is not known.
    const baseline = (at?: number) =>
      seedDelivery(tasks, "waiting", {
        headSha: "head-1",
        ci: "red",
        ciRepair: {
          failures: [{ headSha: "head-1", checks: ["linux-checks"] }],
          diagnoses: [
            {
              headSha: "head-1",
              check: "linux-checks",
              classification: "baseline-blocked",
              evidence: "fails on untouched main",
              dependencyTask: "owner",
              ...(at === undefined ? {} : { at }),
            },
          ],
          repairs: [],
        },
      });
    baseline();
    expect(view()?.blockedSince).toEqual({ [key("other")]: clock() });
    // A dated declaration earlier than the edge is when that wait was recorded.
    baseline(linkedAt - 5_000);
    expect(view()?.blockedSince?.[key("owner")]).toBe(linkedAt - 5_000);
  });

  it("derives flags, blockers, children, the waiting card and repo facts on read", () => {
    const { tasks, protocol, cards } = setup();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: "r1", blockedBy: ["a"] });
    tasks.create({
      id: "held",
      title: "Held",
      prompt: "p",
      repoId: null,
      gate: { kind: "captain", ref: "reasoning-wait" },
    });
    tasks.create({ id: "dead-blocker", title: "Dead", prompt: "p", repoId: null });
    tasks.create({
      id: "dead-blocked",
      title: "Dead blocked",
      prompt: "p",
      repoId: null,
      blockedBy: ["dead-blocker"],
    });
    tasks.close("dead-blocker", { status: "dropped", reason: "cancelled", actor: "captain" });
    tasks.create({ id: "child", title: "Child", prompt: "p", repoId: null, parentId: "held" });
    tasks.close("child", { status: "done", reason: "settled", actor: "host" });
    tasks.create({ id: "child2", title: "Child 2", prompt: "p", repoId: null, parentId: "held" });
    tasks.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
    });
    cards.push({
      id: "card-a",
      taskId: "a",
      author: "firstmate",
      priority: 1,
      title: "Land?",
      meta: "",
      body: "",
      actions: [
        { id: "land", label: "Land", default: true, effect: { kind: "settle", mode: "merge" } },
      ],
      status: "ready",
      createdAt: 1,
    });
    const board = protocol.board();
    const view = (id: string) => board.tasks.find((task) => task.id === id);
    expect(view("a")).toMatchObject({
      key: "NIA-1",
      status: "active",
      activity: "starting",
      flags: { blocked: false, held: false, needsYou: true, ready: false },
      blocks: ["NIA-2"],
      waitingCardId: "card-a",
      repo: { name: "nimbus-api", branch: "fm/a" },
      assignee: "crewmate 1",
    });
    expect(view("b")).toMatchObject({
      flags: { blocked: true, held: false, needsYou: false, ready: false },
      blockedBy: ["NIA-1"],
      waitingCardId: null,
      repo: { name: "nimbus-api", branch: "" },
    });
    expect(view("held")).toMatchObject({
      flags: { blocked: false, held: true, needsYou: true, ready: false },
      children: { total: 2, closed: 1 },
      repo: null,
    });
    expect(view("dead-blocked")).toMatchObject({
      flags: { blocked: true, held: false, needsYou: true, ready: false },
      blockedBy: [],
    });
    expect(view("child2")).toMatchObject({ flags: { ready: true }, parentId: "held" });
    expect(board.links).toEqual([
      { fromId: "a", toId: "b", type: "blocks" },
      { fromId: "dead-blocker", toId: "dead-blocked", type: "blocks" },
    ]);
    expect(board.projects).toEqual([
      {
        id: "scratch",
        key: "SCR",
        name: "Scratch",
        repo: null,
        archived: false,
        counts: { needsYou: 2, waitingOnYou: 0, open: 3, active: 0, doneRecent: 1 },
      },
      {
        id: "proj-r1",
        key: "NIA",
        name: "nimbus-api",
        repo: { name: "nimbus-api", delivery: "direct-pr", autonomy: true },
        archived: false,
        counts: { needsYou: 1, waitingOnYou: 1, open: 1, active: 1, doneRecent: 0 },
      },
    ]);
    expect(protocol.projects()).toEqual(board.projects);
  });

  it("says on each live work row which of the six moves it allows and whether its waiting card merges (FI3-1014 piece 4)", () => {
    const { tasks, protocol, cards } = setup();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: "r1", blockedBy: ["a"] });
    tasks.dispatch("a", {
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
        { id: "merge", label: "Merge", default: true, effect: { kind: "settle", mode: "merge" } },
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
    expect(view("b")?.moves).toEqual({
      "show-card": { ok: false, text: "It has no card to show." },
      "start-task": { ok: false, text: "NIA-1 must finish first." },
      "start-again": {
        ok: false,
        text: "Only dropped work without a replacement or parts starts again.",
      },
      "stop-task": { ok: false, text: "It has not started. Drop task drops it." },
      "continue-task": { ok: false, text: "Only interrupted work continues." },
      "drop-task": { ok: true },
      // Created to start by itself once nothing holds it: queued already.
      "queue-task": { ok: false, text: "It is already queued." },
      "unqueue-task": { ok: true },
    });
    // A question has no moves, and neither does closed work.
    expect(view("q")?.moves).toBeUndefined();
  });

  it("reads the gate on an active row: held, and waiting on you only while its card is up", () => {
    const { tasks, protocol, cards } = setup();
    const workspace = { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/x", branch: "fm/x" };
    for (const id of ["capped", "carded", "timed", "free"]) {
      tasks.create({ id, title: id, prompt: "p", repoId: "r1" });
      tasks.dispatch(id, { workspace, accountId: null, assignee: "crewmate 1" });
    }
    // A round cap before the Firstmate's card: held, and the Firstmate's
    // turn - not the captain's, so not waiting on him.
    tasks.setGate("capped", { kind: "captain", ref: "abc1234", reason: "the CI cap" });
    // The card the gate names is up: the captain's turn.
    tasks.setGate("carded", { kind: "captain", ref: "card-fm-9", reason: "the CI cap" });
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
    tasks.setGate("timed", { kind: "at-time", until: 99 * DAY });
    // A host card with no task files its own row, gated on the card.
    tasks.fileHostCardTask({
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
    // The record's own flags agree with the board's.
    for (const id of ["capped", "carded", "timed", "free"]) {
      const record = tasks.get(id);
      expect(record && tasks.flagsOf(record).held, id).toBe(view(id)?.flags.held);
    }
  });

  it("retains a declared hold without listing a cardless task as waiting on the captain (FI3-702)", () => {
    const { tasks, protocol } = setup();
    const workspace = { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/w", branch: "fm/w" };
    tasks.create({ id: "w", title: "Release", prompt: "p", repoId: "r1" });
    tasks.dispatch("w", { workspace, accountId: null, assignee: "crewmate 1" });
    tasks.setActivity("w", "running");
    tasks.recordReport("w", {
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
    expect(tasks.clearDeclaration("w")).toBe(true);
    const moved = protocol.board().tasks.find((task) => task.id === "w");
    expect(moved?.captainWait).toBeUndefined();
    expect(moved && nowGroupOf(moved)).toBe("working");
    expect(tasks.clearDeclaration("w")).toBe(false);
  });

  it("serves a detail with intent, brief, outcome, timeline and asks that parses on the wire", () => {
    const { tasks, protocol } = setup();
    tasks.create({
      id: "a",
      title: "A",
      prompt: "the brief",
      repoId: "r1",
      intent: { goal: "Ship", userWords: "ship it", constraints: [{ kind: "minimal-diff" }] },
    });
    tasks.openAsk({ id: "turn-1", text: "ship it", images: [{ mimeType: "image/png" }] });
    tasks.attachAsk("turn-1", "a", "tool:spawn_crewmate");
    tasks.closeAsk("turn-1", "closed");
    tasks.recordReport("a", { text: "Shipped." });
    const detail = protocol.detail("a");
    expect(taskDetailSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({
      key: "NIA-1",
      intent: { goal: "Ship", userWords: "ship it" },
      brief: "the brief",
      outcome: "Shipped.",
      outcomeSummary: "Shipped.",
      asks: [
        {
          id: "turn-1",
          text: "ship it",
          images: 1,
          attachedVia: "tool:spawn_crewmate",
          turnState: "closed",
        },
      ],
    });
    expect(detail.events.map((event) => event.kind)).toEqual(["created", "ask", "report"]);
    expect(detail.dropEffects).toEqual({ parts: [], waiting: [], underway: [] });
  });

  it("keeps a captain drop of unstarted work as a dropped record, not done", () => {
    const { tasks, protocol } = setup();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1", startPolicy: "on-request" });
    const before = protocol.detail("a");
    expect(before.dropEffects).toEqual({ parts: [], waiting: [], underway: [] });
    expect(before.dropEffects && dropReviewKeys(before.dropEffects).parts).toEqual([]);
    tasks.dropUnstarted("a", {
      actor: "captain",
      review: dropReviewKeys(before.dropEffects ?? { parts: [], waiting: [], underway: [] }),
    });
    const detail = protocol.detail("a");
    expect(detail.dropEffects).toBeUndefined();
    expect(detail).toMatchObject({
      status: "dropped",
      closedReason: "cancelled",
      closing: { note: NO_LONGER_WANTED },
    });
    expect(detail.activityLog.map((row) => row.text)).toContain(DROPPED_BEFORE_START_ACTIVITY);
    expect(taskDetailSchema.parse(detail)).toEqual(detail);
  });

  it("reads the record the way the popup shows it: headline, model name, condensed activity, closing and problem", () => {
    const { db, tasks, protocol, tick } = setup({
      modelLabel: (model) => (model === "openai/gpt-6-sol" ? "GPT-6 Sol" : undefined),
    });
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    tick();
    tasks.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 21",
      model: { provider: "openai", id: "gpt-6-sol" },
    });
    tick();
    tasks.note("a", "a warm working copy was reused", { news: false });
    tick();
    tasks.noteProgress("a", "Opened the change; waiting on the checks.");
    tick();
    seedDelivery(
      tasks,
      "a",
      { changeLabel: "#422", prNumber: 422, prUrl: "https://github.com/o/r/pull/422" },
      { kind: "pr_opened", text: "PR #422 https://github.com/o/r/pull/422", feed: true },
    );
    for (const ci of ["pending", "pending", "green", "green"] as const) {
      tick();
      seedDelivery(
        tasks,
        "a",
        { ci, ciAt: 1, headSha: "abc123" },
        { kind: "ci", text: `CI ${ci}` },
      );
    }
    tick();
    tasks.noteProgress("a", "The checks passed.");
    tick();
    const report =
      "Intent: fix the popup.\nWhat changed: the popup reads plainly. It shows the model.";
    tasks.recordReport("a", { text: report });
    const detail = taskDetailSchema.parse(protocol.detail("a"));
    expect(detail.modelLabel).toBe("GPT-6 Sol");
    expect(detail.outcomeSummary).toBe("the popup reads plainly.");
    expect(detail.activityLog.map((row) => [row.kind, row.text])).toEqual([
      ["created", expect.any(String)],
      ["dispatched", "crewmate 21 started on GPT-6 Sol."],
      ["progress", "Opened the change; waiting on the checks."],
      ["pr_opened", "Opened pull request #422."],
      ["ci", "The checks are running on pull request #422."],
      ["ci", "The checks passed on pull request #422."],
      ["report", "the popup reads plainly."],
    ]);
    // What is minor folds under the row it led to, so nothing is left out.
    expect(detail.activityLog.map((row) => row.folded?.map((line) => line.text) ?? [])).toEqual([
      [],
      [],
      ["a warm working copy was reused"],
      [],
      [],
      ["The checks are running on pull request #422."],
      ["The checks passed on pull request #422.", "The checks passed."],
    ]);
    // The whole timeline is still there beneath it.
    expect(detail.events.length).toBeGreaterThan(detail.activityLog.length);
    expect(detail.closing).toBeNull();
    expect(detail.problem).toBeNull();

    // A row stored before reports skipped their Intent section reads again.
    db.prepare("UPDATE tasks SET outcome_summary = ? WHERE id = ?").run(
      "Intent: fix the popup.",
      "a",
    );
    expect(protocol.detail("a").outcomeSummary).toBe("the popup reads plainly.");
    // The report's own summary wins over any sentence of it.
    tick();
    tasks.recordReport("a", { text: report, summary: "The popup reads plainly now." });
    expect(protocol.detail("a").outcomeSummary).toBe("The popup reads plainly now.");
    expect(protocol.detail("a").activityLog.at(-1)?.text).toBe("The popup reads plainly now.");

    // A failed turn reads in plain words; the raw error stays on the timeline.
    tick();
    tasks.recordTurnFailure("a", "401 Unauthorized");
    expect(protocol.detail("a").problem).toBe(
      "The provider did not accept your sign-in - sign in again.",
    );

    // A drop carries the words it was dropped with.
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: "r1" });
    tick();
    tasks.dropWithChildren("b", { reason: "Duplicate of NIA-1.", actor: "firstmate" });
    const dropped = protocol.detail("b");
    expect(dropped.closing).toEqual({ at: dropped.closedAt, note: "Duplicate of NIA-1." });
    expect(dropped.activityLog.map((row) => row.kind)).toEqual(["created", "status"]);
    expect(dropped.modelLabel).toBeNull();
  });

  it("shows the basis the same on the detail, the published view and the export, its verdict derived at read", () => {
    const { db, tasks, protocol } = setup();
    tasks.create({ id: "plan", title: "Plan the panel", prompt: "p", repoId: "r1" });
    const planKey = tasks.get("plan")?.key ?? "";
    // Routed with a verdict on the shape, the way a spawn hands it over:
    // this one is stale (the plan has not answered), and it is not kept.
    tasks.create({
      id: "build",
      title: "Build the panel",
      prompt: "b",
      repoId: "r1",
      shape: {
        kind: "implement",
        kind_source: "classifier:test",
        basis: planKey,
        basis_verified: true,
      },
    });
    tasks.create({ id: "free", title: "Unrelated", prompt: "f", repoId: "r1" });
    const shown = (id: string) => ({
      detail: taskDetailSchema.parse(protocol.detail(id)).basis?.ref ?? null,
      view:
        (
          db.prepare("SELECT basis FROM v_tasks_v1 WHERE task_id = ?").get(id) as {
            basis: string | null;
          }
        ).basis ?? null,
      export:
        parseTaskExport(exportTaskRecords(tasks).join("\n")).tasks.find((task) => task.id === id)
          ?.shape?.basis ?? null,
    });
    expect(shown("build")).toEqual({ detail: planKey, view: planKey, export: planKey });
    expect(shown("free")).toEqual({ detail: null, view: null, export: null });
    expect(protocol.detail("build").basis).toEqual({ ref: planKey, verified: false });

    // The plan answers: the verdict follows with no write to the build row.
    const before = tasks.get("build")?.updatedAt;
    tasks.recordReport("plan", { text: "Group the rows into sections." });
    expect(protocol.detail("build").basis).toEqual({ ref: planKey, verified: true });
    expect(tasks.get("build")?.updatedAt).toBe(before);
    expect(protocol.detail("free").basis).toBeNull();
  });

  it("reads the feed as a view: timeline lines merged with task-less lines by time, keyed", () => {
    const { tasks, activity, tick } = setup();
    activity.record({ kind: "you", text: "Captain: build it" });
    tick();
    tasks.create({ id: "a", title: "Build it", prompt: "p", repoId: "r1" });
    tasks.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
    });
    tick();
    tasks.noteProgress("a", "halfway");
    tick();
    activity.record({ kind: "info", text: "First mate · remembered: squash merges" });
    tick();
    tasks.recordReport("a", { text: "Built. Tests green." });
    const feed = recentFeed(tasks, activity, 200);
    expect(feed.map((line) => [line.text, line.taskKey ?? null])).toEqual([
      ["Captain: build it", null],
      ["Started", "NIA-1"],
      ["First mate · remembered: squash merges", null],
      ["Reported: Built.", "NIA-1"],
    ]);
    expect(feed.map((line) => line.kind)).toEqual(["you", "info", "info", "info"]);
    // A task line names the timeline event it was authored from; a task-less
    // line names none.
    expect(feed.map((line) => line.event ?? null)).toEqual([null, "dispatched", null, "report"]);
    // The limit cuts the oldest, whichever table they came from.
    expect(recentFeed(tasks, activity, 2).map((line) => line.text)).toEqual([
      "First mate · remembered: squash merges",
      "Reported: Built.",
    ]);
  });

  // INF-1845, the captain's pick: one keyed line, "Merging #709", which becomes "Merged #709 on GitHub" or "Cannot merge: …".
  it("shows one line per settle: the click gives way to its outcome, and the record keeps both", () => {
    const { tasks, activity, tick } = setup();
    tasks.create({ id: "a", title: "Ship it", prompt: "p", repoId: "r1" });
    const settle = (text: string) => {
      tasks.note("a", text, {
        news: true,
        feed: true,
        data: { feedLine: true, feedOnce: SETTLE_FOLD },
      });
      tick();
    };
    const shown = () =>
      recentFeed(tasks, activity, 200)
        .filter((line) => line.taskKey === tasks.get("a")?.key)
        .map((line) => line.text);
    settle("Merging #709");
    expect(shown()).toEqual(["Merging #709"]);
    settle("Cannot merge: it conflicts with newer work in the project");
    expect(shown()).toEqual(["Cannot merge: it conflicts with newer work in the project"]);
    settle("Merging #709");
    tasks.close("a", {
      status: "done",
      reason: "merged",
      actor: "captain",
      text: "Merged #709 on GitHub. https://github.com/o/r/pull/709",
      data: { line: "Merged #709 on GitHub" },
    });
    expect(shown()).toEqual(["Merged #709 on GitHub"]);
    expect(tasks.timeline("a").filter((event) => event.kind === "note")).toHaveLength(3);
  });

  it("folds only programs into one feed row before the recent limit (INF-1137 friction 8)", () => {
    const { tasks, activity, tick } = setup();
    tasks.create({ id: "ordinary", title: "Website refresh", prompt: "p", repoId: "r1" });
    tasks.create({
      id: "ordinary-child",
      parentId: "ordinary",
      title: "Review the home page",
      prompt: "p",
      repoId: "r1",
    });
    tasks.recordReport("ordinary", { text: "Layout reviewed." });
    tick();
    tasks.recordReport("ordinary-child", { text: "Home page reviewed." });
    tick();
    tasks.create({
      id: "program",
      title: "Research release questions",
      prompt: "p",
      repoId: "r1",
      shape: { kind: "research", program: { script: "return null;", bound: 29 } },
    });
    for (let i = 0; i < 29; i++) {
      const id = `part-${i}`;
      tasks.create({
        id,
        parentId: "program",
        title: `Research question ${i + 1}`,
        prompt: "p",
        repoId: "r1",
      });
      tasks.recordReport(id, { text: "Research ready." });
      tick();
    }
    const program = tasks.get("program");
    const feed = () => recentFeed(tasks, activity, 3);
    expect(feed().map((line) => line.taskKey)).toEqual([
      tasks.get("ordinary")?.key,
      tasks.get("ordinary-child")?.key,
      program?.key,
    ]);
    expect(feed().at(-1)?.text).toBe("0/29 parts done · Research release questions");
    tasks.close("part-0", { status: "done", reason: "finished", actor: "host" });
    tick();
    tasks.close("part-1", { status: "dropped", reason: "cancelled", actor: "host" });
    expect(feed().at(-1)).toMatchObject({
      taskKey: program?.key,
      kind: "warn",
      text: "1/29 parts done · 1 stopped · Research release questions",
    });
    expect(tasks.get("part-0")?.status).toBe("done");
  });

  it("pushes on a purge and on a discarded spawn, with nothing left to describe", async () => {
    const { tasks, protocol, events, boards, settle } = setup();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: null });
    await settle();
    events.length = 0;
    tasks.discardFailedSpawn("a");
    await settle();
    expect(events).toEqual([]);
    expect(boards().at(-1)?.tasks).toEqual([]);
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: null });
    expect(tasks.purge()).toBe(1);
    await settle();
    expect(boards().at(-1)).toEqual(protocol.board());
    expect(protocol.board().tasks).toEqual([]);
    // The sequence keeps rising through a purge: a client must not mistake
    // the emptied board for an older one.
    expect(tasks.boardSeq()).toBe(4);
  });

  it("stops pushing once disposed", async () => {
    const { tasks, protocol, boards, settle } = setup();
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
    const { tasks, protocol, carried, deltas, settle, tick, cards } = setup({
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
        tasks.dispatch("a", {
          workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
          accountId: null,
          assignee: "crewmate 1",
          model: { provider: "openai", id: "gpt-5" },
        }),
      () => tasks.recordReport("a", { text: "Done the thing. Details follow." }),
      () => tasks.link("c", "a", "related", "firstmate"),
      () => tasks.unlink("c", "a", "related", "firstmate"),
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
        tasks.fileDecision({ id: "d", title: "Which way?", cardId: "card-d" });
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
      () => tasks.discardFailedSpawn("c"),
    ];
    for (const step of steps) {
      tick();
      step();
      await settle();
      // After every push the client's folded board IS the fresh read.
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
    // Contiguous: each delta's base is the seq the client held.
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
    const byRows = setup({ deltaTrigger: { rows: 2, bytes: Number.MAX_SAFE_INTEGER } });
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
    // The purge: the board resets, the next push is a snapshot with no rows.
    byRows.tasks.purge();
    await byRows.settle();
    expect(byRows.carried().at(-1)).toMatchObject({
      channel: "inf:tasks",
      payload: { tasks: [], links: [] },
    });

    const byBytes = setup({ deltaTrigger: { rows: 1_000, bytes: 64 } });
    byBytes.tasks.create({ id: "a", title: "A", prompt: "p", repoId: null });
    await byBytes.settle();
    byBytes.tasks.create({ id: "b", title: "B", prompt: "p", repoId: null });
    await byBytes.settle();
    expect(byBytes.carried().map((push) => push.channel)).toEqual(["inf:tasks", "inf:tasks:delta"]);
    expect(followed(byBytes.carried()).board).toEqual(byBytes.protocol.board());

    // The design's trigger by default: a small fleet never sees a delta.
    const plain = setup();
    plain.tasks.create({ id: "a", title: "A", prompt: "p", repoId: null });
    await plain.settle();
    plain.tasks.create({ id: "b", title: "B", prompt: "p", repoId: null });
    await plain.settle();
    expect(plain.deltas()).toEqual([]);
    expect(plain.boards()).toHaveLength(2);
  });

  it("says what a record moved from on task_changed, once per transition", async () => {
    const { tasks, events, tick } = setup();
    const changed = () =>
      events
        .filter((event) => event.type === "task_changed")
        .map((event) => (event.type === "task_changed" ? event : null))
        .filter((event) => event !== null);
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    expect(changed().at(-1)).toMatchObject({ kind: "work", status: "open", from: null });
    tick();
    tasks.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
    });
    expect(changed().at(-1)).toMatchObject({ status: "active", from: "open", closedReason: null });
    tick();
    tasks.setActivity("a", "idle");
    // A write that moves nothing says so: from equals status.
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
    tasks.markWorkspaceRemoved("a");
    // The later write on the closed row is not a transition.
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

describe("provenance events on the wire (R2)", () => {
  it("keeps a decision record off the detail read and the task_event stream, but not steers", async () => {
    const { tasks, protocol, events, settle, tick, clock } = setup();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    tick();
    tasks.recordDecision({
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
    tasks.recordSteer("a", {
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
    const f = setup({ place: () => place });
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
