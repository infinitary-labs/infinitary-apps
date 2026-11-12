import { BOARD_RECENT_MS } from "@shared/tasks";
import type { WorkPosture } from "@shared/workPosture";
import { describe, expect, it, vi } from "vitest";
import { rowsRead } from "../../../tests/helpers/database";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { taskProtocolFixture } from "../../../tests/helpers/taskProtocol";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";

/**
 * The task protocol (task-system P3, design section 9): the rows it keeps
 * between changes, and what a board read reads.
 */

describe("the task protocol (task-system P3)", () => {
  // INF-2255: projects() rebuilt full task views for counts even after a
  // warm board had already derived exactly those counts.
  it("serves project counts through the current board without rebuilding unchanged views", () => {
    const posture = vi.fn((): WorkPosture => ({ state: "idle", reason: "captain" }));
    const f = taskProtocolFixture({ workPosture: posture });
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
    const f = taskProtocolFixture();
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
  // INF-2186 / INF-2192: every shown row walked all board links in waitsSince.
  it("reads each wait edge a bounded number of times when building the board", () => {
    const measure = (waiting: number) => {
      const f = taskProtocolFixture();
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
          f.tasks.graph.link("baseline", id, "blocks", "firstmate");
        }
        const links = f.tasks.graph.linksTouching(f.tasks.listLive().map((row) => row.id));
        let edgeReads = 0;
        const measured = links.map((link) => ({
          ...link,
          get type() {
            edgeReads += 1;
            return link.type;
          },
        }));
        vi.spyOn(f.tasks.graph, "linksTouching").mockReturnValue(measured);
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

  it("bounds the board to the live set plus recent closes, keeping a shown row's parent", () => {
    const { tasks, protocol, tick } = taskProtocolFixture();
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
    tasks.graph.link("old-done", "child", "related", "firstmate");
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
      const f = taskProtocolFixture();
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
  it("reads a record and searches older keys without reading the rest of the history (INF-939)", async () => {
    const read = async (history: number) => {
      const f = taskProtocolFixture();
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
      f.tasks.graph.link("blocker", "subject", "blocks", "firstmate");
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
      // With no record process the search reads in this process, within the call.
      let searched: ReturnType<typeof f.protocol.search> | undefined;
      const rows = {
        subject: rowsRead(f.db, () => f.protocol.detail("subject")),
        waiting: rowsRead(f.db, () => f.protocol.detail("waiting")),
        // SQLite still visits each closed row here, but only the matches reach JavaScript,
        // then only the rows it found; a record process takes even that off the main thread.
        search: rowsRead(f.db, () => {
          searched = f.protocol.search("gauge");
        }),
      };
      const subject = f.protocol.detail("subject");
      const waiting = f.protocol.detail("waiting");
      const found = (await searched) ?? [];
      return { rows, subject, waiting, found, f };
    };
    const short = await read(0);
    const long = await read(200);
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
    expect(long.rows.search).toBeGreaterThan(0);
    expect(long.rows).toEqual(short.rows);
  });

  // INF-2070: the board names what replaced each dropped row it shows, and
  // read each one's whole timeline to find a stronger-model move, so opening
  // it on a record the captain's size held the main thread about 300 ms.
  it("names what replaced each dropped row without reading its history, however long (INF-2070)", () => {
    const shown = (history: number) => {
      const f = taskProtocolFixture();
      for (const id of ["carrier", "stronger", "carried", "rejected", "dropped"])
        f.tasks.create({ id, title: `Task ${id}`, prompt: "p", repoId: "r1" });
      const keyOf = (id: string) => f.tasks.get(id)?.key ?? id;
      for (const id of ["carried", "rejected", "dropped"])
        for (let i = 0; i < history; i++) f.tasks.noteProgress(id, `Checked part ${i}.`);
      // Another task carries one on; a stronger model takes over another, as
      // TaskIntake.applyEscalation writes it; the third is just dropped.
      f.tasks.dropWithChildren("carried", {
        reason: "moved to its carrier",
        actor: "firstmate",
        replacedBy: "carrier",
      });
      f.tasks.turns.recordEscalation({
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
    const f = taskProtocolFixture({
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
      ["an edge added", () => tasks.graph.link("owner", "blocked", "blocks", "firstmate")],
      ["an edge removed", () => tasks.graph.unlink("owner", "blocked", "blocks", "firstmate")],
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
          tasks.placement.setGate("gated", { kind: "captain", ref: "card-gate" });
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
      ["a row discarded", () => tasks.archive.discardFailedSpawn("gated")],
      ["a row deleted with its edges", () => tasks.archive.discardFailedSpawn("carrier")],
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
    tasks.archive.purge();
    expect(same("after a purge").tasks).toEqual([]);
  });

  it("builds only the rows a change reached and reads the same rows however many the board holds (INF-2078)", () => {
    const seeded = (size: number) => {
      const built: string[] = [];
      const f = taskProtocolFixture({
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
        link: measure(() => f.tasks.graph.link("t-30", "t-40", "blocks", "firstmate")),
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
      const f = taskProtocolFixture();
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
});
