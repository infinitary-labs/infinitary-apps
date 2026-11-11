import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { WorkShape } from "@shared/routingPolicy";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type AppPaths, appPathsFor } from "../paths";
import { openInMemoryDatabase } from "../storage/db";
import { WorkspaceService } from "../workspace/workspaceService";
import { APP_KEPT_PARTS, CLOSED_TASK_FILES_KEPT_MS, ClosedTaskFiles } from "./closedTaskFiles";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

/**
 * A closed task's leftover files (docs/task-retention.md): a week after the
 * close its evidence folder and everything else its crewmate left go, the
 * app's own parts stay, live work holds what it builds on, and a delete a
 * quit cut short finishes at the next start. Every case runs over a scratch
 * userData through the real task writer and the real trash.
 */

const DAY = 24 * 60 * 60 * 1000;
const KEPT = [...APP_KEPT_PARTS].sort();

function setup() {
  const paths = appPathsFor(scratchDir("infinitary-closed-files-"));
  let now = 100 * DAY;
  const tasks = new TaskService({ db: openInMemoryDatabase(), now: () => now, strict: true });
  const workspace = new WorkspaceService(paths, {
    pool: false,
    deleteTree: (dir) => rm(dir, { recursive: true, force: true }),
  });
  const files = new ClosedTaskFiles({
    paths,
    tasks,
    deleteInBackground: (dir) => workspace.deleteInBackground(dir),
    now: () => now,
  });
  return {
    paths,
    tasks,
    workspace,
    files,
    /** Moves the clock on by `ms`. */
    pass: (ms: number) => {
      now += ms;
    },
    /** A task closed now, with its folder holding every kept part and three leftovers. */
    closed: (id: string, basis?: string) => {
      seedTask(tasks, {
        id,
        title: id,
        status: "cancelled",
        shape: basis ? { kind: "implement", basis } : undefined,
      });
      plantFolder(paths, id);
      return tasks.get(id) as NonNullable<ReturnType<TaskService["get"]>>;
    },
  };
}

function plantFolder(paths: AppPaths, id: string): void {
  const folder = join(paths.crewmatesDir, id);
  for (const part of KEPT) {
    mkdirSync(join(folder, part), { recursive: true });
    writeFileSync(join(folder, part, "kept.txt"), part);
  }
  mkdirSync(join(folder, "evidence"), { recursive: true });
  writeFileSync(join(folder, "evidence", "after.png"), "x".repeat(3000));
  mkdirSync(join(folder, "lab"), { recursive: true });
  writeFileSync(join(folder, "lab", "probe.ts"), "y".repeat(1000));
  writeFileSync(join(folder, "build.log"), "z".repeat(1000));
}

const entries = (paths: AppPaths, id: string) => readdirSync(join(paths.crewmatesDir, id)).sort();

const removalNotes = (tasks: TaskService, id: string) =>
  tasks.timeline(id).filter((event) => event.data?.removedFiles !== undefined);

/**
 * The held set as the pass read it before INF-3641: outward from the live
 * set, one composed record and its links at a time. The one-statement read
 * must answer exactly as this walk does.
 */
function walkedHeld(tasks: TaskService): Set<string> {
  const held = new Set<string>();
  const named = (ref: string) => (ref ? (tasks.get(ref) ?? tasks.byKey(ref)) : undefined);
  const pending = tasks.listLive();
  for (let record = pending.pop(); record; record = pending.pop()) {
    if (held.has(record.id)) continue;
    held.add(record.id);
    const refs = [
      ...tasks.graph
        .linksFrom(record.id)
        .filter((link) => link.type === "discovered-from")
        .map((link) => link.toId),
      ...tasks.graph
        .linksTo(record.id)
        .filter((link) => link.type === "blocks" || link.type === "replaced-by")
        .map((link) => link.fromId),
      ...tasks.graph.escalatedFrom(record.id),
    ];
    if (record.shape?.basis) refs.push(record.shape.basis);
    if (record.shape?.escalate_from) refs.push(record.shape.escalate_from);
    for (const ref of refs) {
      const ancestor = named(ref.trim());
      if (ancestor && !held.has(ancestor.id)) pending.push(ancestor);
    }
  }
  return held;
}

describe("the tasks live work builds on", () => {
  // INF-3641: the pass read each held task's whole record, tens of
  // milliseconds on the main thread on the captain's record; one statement
  // of ids must find the same tasks through every way a task holds another.
  it("reads in one statement exactly the tasks the record-by-record walk finds", () => {
    const { tasks, closed } = setup();
    let seed = 7;
    const pick = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const earlier: { id: string; key: string }[] = [];
    // Work mostly builds on recent work, so ancestries run deep.
    const recent = () =>
      earlier[earlier.length - 1 - pick(Math.min(earlier.length, 15))] as {
        id: string;
        key: string;
      };
    // How a reference names an earlier task: its id, its key, its key as a
    // person typed it, or a task that no longer exists.
    const nameOf = (task: { id: string; key: string }) =>
      [task.id, task.key, ` ${task.key.toLowerCase()}\n`, "INF-999999"][pick(4)] as string;
    for (let index = 0; index < 240; index += 1) {
      const id = `closed-${index}`;
      const basis = index > 3 && pick(2) === 0 ? recent() : undefined;
      const retried = index > 3 && pick(6) === 0 ? recent() : undefined;
      seedTask(tasks, {
        id,
        title: id,
        status: "cancelled",
        ...(basis || retried
          ? {
              shape: {
                kind: "fix",
                ...(basis ? { basis: nameOf(basis) } : {}),
                ...(retried ? { escalate_from: nameOf(retried) } : {}),
              },
            }
          : {}),
      });
      const record = tasks.get(id) as NonNullable<ReturnType<TaskService["get"]>>;
      if (index > 3) {
        const other = recent();
        const type = (["discovered-from", "blocks", "replaced-by", undefined] as const)[pick(4)];
        if (type === "discovered-from") tasks.graph.link(id, other.id, type, "host");
        else if (type) tasks.graph.link(other.id, id, type, "host");
        if (pick(10) === 0)
          tasks.turns.recordEscalation({
            from: other,
            to: { id, key: record.key },
            attempt: 2,
            tier: "premium",
          });
      }
      earlier.push({ id, key: record.key });
    }
    // A closed plan nobody live builds on stays out of the set.
    const unheld = closed("unheld-plan");
    for (let index = 0; index < 30; index += 1) {
      const id = `live-${index}`;
      const basis = pick(3) > 0 ? earlier[pick(earlier.length)] : undefined;
      tasks.create({
        id,
        title: id,
        prompt: "Build on earlier work",
        repoId: null,
        startPolicy: "on-request",
        ...(basis ? { shape: { kind: "implement", basis: nameOf(basis) } } : {}),
        ...(pick(5) === 0
          ? { blockedBy: [(earlier[pick(earlier.length)] as { id: string }).id] }
          : {}),
      });
      if (pick(4) === 0)
        tasks.graph.link(
          id,
          (earlier[pick(earlier.length)] as { id: string }).id,
          "discovered-from",
          "host",
        );
    }
    // Each way one task holds another, as the only way a live task reaches
    // its own closed target, through a closed intermediate.
    const live = (id: string, shape: WorkShape) =>
      tasks.create({
        id,
        title: id,
        prompt: "Build on earlier work",
        repoId: null,
        startPolicy: "on-request",
        shape,
      });
    const middle = (name: string, shape?: WorkShape) => {
      seedTask(tasks, { id: `via-${name}`, title: name, status: "cancelled", shape });
      live(`live-${name}`, { kind: "implement", basis: `via-${name}` });
      return tasks.get(`via-${name}`) as { id: string; key: string };
    };
    const typed = closed("only-typed-key");
    middle("typed-key", { kind: "fix", basis: `\t${typed.key.toLowerCase()} \n` });
    const retried = closed("only-retried");
    live("live-retried", { kind: "fix", escalate_from: ` ${retried.key.toLowerCase()}` });
    const escalated = closed("only-escalated");
    const retry = middle("escalated");
    tasks.turns.recordEscalation({ from: escalated, to: retry, attempt: 2, tier: "premium" });
    const filed = closed("only-filed");
    tasks.graph.link(middle("filed").id, filed.id, "discovered-from", "host");
    const blocking = closed("only-blocking");
    tasks.graph.link(blocking.id, middle("blocking").id, "blocks", "host");
    const carried = closed("only-carried");
    tasks.graph.link(carried.id, middle("carried").id, "replaced-by", "host");
    const targets = [typed, retried, escalated, filed, blocking, carried].map((task) => task.id);
    const walked = walkedHeld(tasks);
    const read = tasks.heldByLiveWork();
    for (const target of targets) expect(walked.has(target), target).toBe(true);
    console.info(
      JSON.stringify({ intent: "INF-3641 held set", held: read.size, walked: walked.size }),
    );
    expect([...read].sort()).toEqual([...walked].sort());
    expect(read.size).toBeGreaterThan(150);
    expect(read.has(unheld.id)).toBe(false);
  });
});

describe("a closed task's leftover files", () => {
  // INF-2255 / INF-2213: every live basis separately resolved and composed
  // the same earlier task during the periodic retention pass.
  it("derives shared retention holds from one task snapshot without resolving every reference", async () => {
    const { paths, tasks, workspace, files, pass, closed } = setup();
    const plan = closed("shared-plan");
    const unrelated = closed("unrelated-plan");
    const builders = Array.from({ length: 40 }, (_, index) =>
      tasks.create({
        id: `builder-${index}`,
        title: `Build accepted piece ${index}`,
        prompt: "Use the plan's evidence",
        repoId: null,
        startPolicy: "on-request",
        shape: { kind: "implement", basis: ` ${plan.key.toLowerCase()} ` },
      }),
    );
    pass(CLOSED_TASK_FILES_KEPT_MS + 1);
    const resolve = vi.spyOn(tasks, "resolve");
    const list = vi.spyOn(tasks, "list");
    try {
      await files.sweep();
      await workspace.deletionsSettled();
      expect(entries(paths, plan.id)).toContain("evidence");
      expect(entries(paths, unrelated.id)).toEqual(KEPT);
      console.info(
        JSON.stringify({
          intent: "INF-2255 retention references",
          builders: builders.length,
          resolveCalls: resolve.mock.calls.length,
          fullLists: list.mock.calls.length,
        }),
      );
      // Neither the whole list (INF-3032) nor a resolve per builder (INF-2255).
      expect(list).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      for (const builder of builders)
        tasks.close(builder.id, { status: "dropped", reason: "cancelled", actor: "captain" });
      await files.sweep();
      await workspace.deletionsSettled();
      expect(entries(paths, plan.id)).toEqual(KEPT);
    } finally {
      resolve.mockRestore();
      list.mockRestore();
      await workspace.deletionsSettled();
    }
  });

  it("go a week after the close, keeping the app's own parts and saying what went", async () => {
    const { paths, tasks, workspace, files, pass, closed } = setup();
    closed("done-a");
    pass(CLOSED_TASK_FILES_KEPT_MS - 1);
    await files.sweep();
    expect(entries(paths, "done-a")).toContain("evidence");
    expect(removalNotes(tasks, "done-a")).toEqual([]);

    pass(1);
    await files.sweep();
    expect(entries(paths, "done-a")).toEqual(KEPT);
    for (const part of KEPT) {
      expect(existsSync(join(paths.crewmatesDir, "done-a", part, "kept.txt"))).toBe(true);
    }
    const [note, ...more] = removalNotes(tasks, "done-a");
    expect(more).toEqual([]);
    expect(note?.text).toBe(
      "leftover files removed: the evidence folder and 2 other things its crewmate left, 5 KB",
    );
    expect(note?.data).toEqual({
      removedFiles: ["build.log", "evidence", "lab"],
      bytes: 5000,
      news: false,
    });
    expect(note?.feed).toBe(false);
    await workspace.deletionsSettled();
    expect(readdirSync(paths.worktreeTrashDir)).toEqual([]);

    // A later pass finds nothing more and writes nothing more.
    pass(DAY);
    await files.sweep();
    expect(removalNotes(tasks, "done-a")).toHaveLength(1);
  });

  it("never touches open or active work, however old", async () => {
    const { paths, tasks, files, pass } = setup();
    seedTask(tasks, { id: "planned", title: "planned", status: "queued" });
    seedTask(tasks, { id: "working", title: "working", status: "idle" });
    plantFolder(paths, "planned");
    plantFolder(paths, "working");
    pass(30 * DAY);
    await files.sweep();
    expect(entries(paths, "planned")).toContain("evidence");
    expect(entries(paths, "working")).toContain("evidence");
  });

  it("stays while live work builds on it, was filed from it or waits on it, then goes at that close", async () => {
    const { paths, tasks, files, pass, closed } = setup();
    const plan = closed("plan");
    const origin = closed("origin");
    const blocker = closed("blocker");
    tasks.create({
      id: "build",
      title: "build",
      prompt: "p",
      repoId: null,
      startPolicy: "on-request",
      shape: { kind: "implement", basis: plan.key },
    });
    tasks.fileFollowup({
      id: "follow",
      originId: origin.id,
      title: "f",
      goal: "g",
      why: "w",
      prompt: "p",
    });
    tasks.create({
      id: "waits",
      title: "waits",
      prompt: "p",
      repoId: null,
      blockedBy: [blocker.id],
    });
    const unwatch = files.watch();
    pass(10 * DAY);
    await files.sweep();
    for (const id of ["plan", "origin", "blocker"])
      expect(entries(paths, id)).toContain("evidence");

    // The builder closes: the plan's week counted from its own close, so it goes now.
    tasks.close("build", { status: "dropped", reason: "cancelled", actor: "captain" });
    await files.sweep();
    expect(entries(paths, "plan")).toEqual(KEPT);
    expect(entries(paths, "origin")).toContain("evidence");
    expect(entries(paths, "blocker")).toContain("evidence");

    tasks.close("follow", { status: "dropped", reason: "cancelled", actor: "captain" });
    tasks.close("waits", { status: "dropped", reason: "cancelled", actor: "captain" });
    await files.sweep();
    expect(entries(paths, "origin")).toEqual(KEPT);
    expect(entries(paths, "blocker")).toEqual(KEPT);
    unwatch();
  });

  // INF-1010: a later task reads every earlier task's evidence in place, not a copied history.
  it("keeps the entire evidence chain for an unstarted descendant, then releases it at the last close", async () => {
    const { paths, tasks, workspace, files, pass, closed } = setup();
    const first = closed("first");
    const second = closed("second", first.key);
    const third = closed("third", second.key);
    const later = tasks.create({
      id: "later",
      title: "later",
      prompt: "Read earlier evidence where it is",
      repoId: null,
      startPolicy: "on-request",
      shape: { kind: "implement", basis: third.key },
    });
    const unrelated = closed("unrelated");
    pass(40 * DAY);
    await files.sweep();
    for (const id of [first.id, second.id, third.id]) {
      expect(entries(paths, id)).toContain("evidence");
      expect(removalNotes(tasks, id)).toEqual([]);
    }
    expect(entries(paths, unrelated.id)).toEqual(KEPT);
    // No copied history is needed in the successor's folder.
    expect(existsSync(join(paths.crewmatesDir, later.id, "evidence"))).toBe(false);

    tasks.close(later.id, { status: "dropped", reason: "cancelled", actor: "captain" });
    await files.sweep();
    await workspace.deletionsSettled();
    for (const id of [first.id, second.id, third.id]) {
      expect(entries(paths, id)).toEqual(KEPT);
      expect(removalNotes(tasks, id)).toHaveLength(1);
    }
  });

  it("follows origin and blocker links through closed intermediates", async () => {
    const { paths, tasks, workspace, files, pass, closed } = setup();
    const origin = closed("chain-origin");
    const follow = closed("chain-follow");
    const blocker = closed("chain-blocker", follow.key);
    tasks.graph.link(follow.id, origin.id, "discovered-from", "host");
    const later = tasks.create({
      id: "chain-later",
      title: "later",
      prompt: "Read the chain's evidence",
      repoId: null,
      startPolicy: "on-request",
      blockedBy: [blocker.id],
    });
    pass(8 * DAY);
    await files.sweep();
    for (const id of [origin.id, follow.id, blocker.id])
      expect(entries(paths, id)).toContain("evidence");
    tasks.close(later.id, { status: "dropped", reason: "cancelled", actor: "captain" });
    await files.sweep();
    await workspace.deletionsSettled();
    for (const id of [origin.id, follow.id, blocker.id]) expect(entries(paths, id)).toEqual(KEPT);
  });

  // INF-3169 piece 1: a task carrying another's work on, or retrying it on a
  // stronger model, reads that task's evidence in place, so the week waits for it.
  it("stays while live work carries it on or retries it on a stronger model, through closed intermediates", async () => {
    const { paths, tasks, workspace, files, pass, closed } = setup();
    const earliest = closed("carry-earliest");
    const carried = closed("carried");
    tasks.graph.link(earliest.id, carried.id, "replaced-by", "firstmate");
    const carrier = tasks.create({
      id: "carrier",
      title: "Carry the work on",
      prompt: "Pick up where the carried task stopped",
      repoId: null,
      startPolicy: "on-request",
    });
    tasks.graph.link(carried.id, carrier.id, "replaced-by", "firstmate");
    const rejected = closed("rejected");
    const retry = tasks.create({
      id: "retry",
      title: "Retry on a stronger model",
      prompt: "Retry the rejected attempt",
      repoId: null,
      startPolicy: "on-request",
      shape: { kind: "fix", escalate_from: rejected.key },
    });
    // An older stronger-model move recorded only its two escalated rows.
    const older = closed("older-attempt");
    const olderRetry = tasks.create({
      id: "older-retry",
      title: "Older retry",
      prompt: "Retry the older attempt",
      repoId: null,
      startPolicy: "on-request",
    });
    tasks.turns.recordEscalation({
      from: { id: older.id, key: older.key },
      to: { id: olderRetry.id, key: olderRetry.key },
      attempt: 2,
      tier: "premium",
    });
    const unrelated = closed("carry-unrelated");
    pass(8 * DAY);
    await files.sweep();
    await workspace.deletionsSettled();
    for (const id of [earliest.id, carried.id, rejected.id, older.id])
      expect(entries(paths, id)).toContain("evidence");
    expect(entries(paths, unrelated.id)).toEqual(KEPT);

    for (const live of [carrier.id, retry.id, olderRetry.id])
      tasks.close(live, { status: "dropped", reason: "cancelled", actor: "captain" });
    await files.sweep();
    await workspace.deletionsSettled();
    for (const id of [earliest.id, carried.id, rejected.id, older.id])
      expect(entries(paths, id)).toEqual(KEPT);
  });

  it("starts a pass when a task closes, and not on a later write to an older closed task", async () => {
    const { paths, tasks, closed } = setup();
    closed("old");
    seedTask(tasks, { id: "now", title: "now", status: "idle" });
    let passes = 0;
    const files = new ClosedTaskFiles({
      paths,
      tasks,
      deleteInBackground: () => {},
      now: () => {
        passes += 1;
        return 108 * DAY;
      },
    });
    const unwatch = files.watch();
    tasks.close("now", { status: "dropped", reason: "cancelled", actor: "captain" });
    await files.settled();
    expect(passes).toBe(1);
    expect(entries(paths, "old")).toEqual(KEPT);
    // The pass's own note on "old", and any later line there, start none.
    expect(removalNotes(tasks, "old")).toHaveLength(1);
    tasks.note("old", "a later line", { news: true });
    await files.settled();
    expect(passes).toBe(1);
    unwatch();
  });

  it("removes a link as a link, never what it points at, and leaves a task folder that is a link", async () => {
    const { paths, tasks, workspace, files, pass, closed } = setup();
    const outside = scratchDir("infinitary-closed-files-outside-");
    writeFileSync(join(outside, "precious.txt"), "keep me");
    closed("linked");
    symlinkSync(outside, join(paths.crewmatesDir, "linked", "evidence", "out"));
    symlinkSync(join(outside, "precious.txt"), join(paths.crewmatesDir, "linked", "copy.txt"));
    // A task whose whole folder is a link to somewhere else.
    seedTask(tasks, { id: "aliased", title: "aliased", status: "cancelled" });
    mkdirSync(join(outside, "evidence"));
    symlinkSync(outside, join(paths.crewmatesDir, "aliased"));
    pass(8 * DAY);
    await files.sweep();
    await workspace.deletionsSettled();
    expect(entries(paths, "linked")).toEqual(KEPT);
    expect(readdirSync(outside).sort()).toEqual(["evidence", "precious.txt"]);
    expect(removalNotes(tasks, "aliased")).toEqual([]);
  });

  // A pass reads only the closes since the last one (INF-3032), so what it could
  // not remove must come back at the next pass with no close to start it.
  it("tries a computer's removal again at the next pass, with no new close", async () => {
    const { paths, tasks, pass } = setup();
    seedTask(tasks, { id: "away", title: "away", status: "cancelled", deviceId: "mini" });
    pass(8 * DAY);
    const asked: (string | null | undefined)[] = [];
    let inReach = false;
    const files = new ClosedTaskFiles({
      paths,
      tasks,
      deleteInBackground: () => {},
      now: () => 108 * DAY,
      removePlaced: async (record) => {
        asked.push(record.deviceId);
        if (!inReach) throw new Error("This task's computer is out of reach.");
        return { removedFiles: ["evidence"], bytes: 10 };
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await files.sweep();
      expect(removalNotes(tasks, "away")).toEqual([]);
      inReach = true;
      await files.sweep();
    } finally {
      warn.mockRestore();
    }
    expect(asked).toEqual(["mini", "mini"]);
    expect(removalNotes(tasks, "away").map((event) => event.data?.deviceId)).toEqual(["mini"]);
  });

  it("finishes at the next start what a quit cut short", async () => {
    const { paths, tasks, closed, pass } = setup();
    closed("cut");
    pass(8 * DAY);
    // The first run moves the files aside and quits before deleting them.
    const quit = new ClosedTaskFiles({
      paths,
      tasks,
      deleteInBackground: () => {},
      now: () => 108 * DAY,
    });
    await quit.sweep();
    expect(entries(paths, "cut")).toEqual(KEPT);
    expect(readdirSync(paths.worktreeTrashDir)).toHaveLength(1);
    // A file the crewmate's quit left behind after that pass.
    writeFileSync(join(paths.crewmatesDir, "cut", "late.log"), "late");

    // The next start: the trash sweep deletes what was moved, and the pass the rest.
    const next = new WorkspaceService(paths, {
      pool: false,
      deleteTree: (dir) => rm(dir, { recursive: true, force: true }),
    });
    next.sweepTrash();
    const again = new ClosedTaskFiles({
      paths,
      tasks,
      deleteInBackground: (dir) => next.deleteInBackground(dir),
      now: () => 108 * DAY,
    });
    await again.sweep();
    await next.deletionsSettled();
    expect(readdirSync(paths.worktreeTrashDir)).toEqual([]);
    expect(entries(paths, "cut")).toEqual(KEPT);
    expect(removalNotes(tasks, "cut").map((event) => event.data?.removedFiles)).toEqual([
      ["build.log", "evidence", "lab"],
      ["late.log"],
    ]);
  });
});
