import { DROP_REVIEW_STALE, dropReviewKeys, NO_LONGER_WANTED } from "@shared/recordDrop";
import {
  backlogActivity,
  leftBacklogActivity,
  QUEUED_ACTIVITY,
  queueClosedRefusal,
  queueMissingRefusal,
  queuePartsRefusal,
  queueStartedBacklogRefusal,
  queueStartedRefusal,
  UNQUEUED_ACTIVITY,
} from "@shared/taskQueue";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { RepoRegistry } from "../workspace/repoRegistry";
import { seedProject } from "../workspace/seedProject";
import { seedTask } from "./seedTask";
import { TaskGraphRefusal } from "./taskGraph";
import { queryTasks } from "./taskQuery";
import { TaskService } from "./taskService";

/**
 * The task graph (task-system P2, design sections 7 to 9): hierarchy with
 * the ancestor walk, blocks edges with cycle refusal, the ready query, the
 * parent close rule, project moves, and the crewmate's follow-up. Every
 * assertion reads the record back through the service.
 */

function setup() {
  const db = openInMemoryDatabase();
  seedProject(db, {
    id: "r1",
    name: "nimbus-api",
    path: "/fleet/nimbus-api",
    delivery: "direct-pr",
    addedAt: 1,
  });
  let now = 1_000;
  const tasks = new TaskService({
    db,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: () => now,
    strict: true,
  });
  const work = (id: string, extra: Partial<Parameters<TaskService["create"]>[0]> = {}) =>
    tasks.create({ id, title: id.toUpperCase(), prompt: "p", repoId: null, ...extra });
  return { db, tasks, work, tick: (ms = 1) => (now += ms) };
}

describe("the task graph (task-system P2)", () => {
  // INF-87 P1: the captain chose the existing lanes, not a separate permission mark.
  it.each(["backlog", "on-request edit"] as const)(
    "%s keeps an approved piece waiting even after late classification",
    (change) => {
      const { tasks, work } = setup();
      const parent = work("parent");
      const answer = work("answer", {
        parentId: parent.id,
        shape: { kind: "research", deliverable: "answer" },
      });
      tasks.close(answer.id, { status: "done", reason: "answered", actor: "captain" });
      const piece = work("piece", {
        parentId: parent.id,
        shape: { kind: "implement", basis: answer.key },
        startPolicy: "when-ready",
      });
      expect(tasks.graph.listReady().map((row) => row.id)).toContain(piece.id);
      if (change === "backlog")
        expect(tasks.starts.setQueued(piece.id, "unqueue-task", { actor: "captain" })).toEqual({
          ok: true,
          changed: true,
        });
      else tasks.updateFields(piece.id, { startPolicy: "on-request" }, "firstmate");
      tasks.placement.recordShape(piece.id, piece.shape!, null);
      expect(queryTasks(tasks, { key: piece.key }).rows[0]).toMatchObject({
        status: "open",
        start_policy: "on-request",
      });
      expect(tasks.graph.listReady().map((row) => row.id)).not.toContain(piece.id);
    },
  );

  describe("ready and blocked", () => {
    it("lists open when-ready work with every blocker closed, priority first", () => {
      const { tasks, work } = setup();
      work("a", { priority: 3 });
      work("b", { priority: 1 });
      work("c", { blockedBy: ["a"] });
      work("held", { gate: { kind: "at-time", until: 9 } });
      work("later", { startPolicy: "on-request" });
      tasks.create({ id: "q", kind: "question", title: "Q", prompt: "", repoId: null });
      expect(tasks.graph.listReady().map((r) => r.id)).toEqual(["b", "a"]);
      expect(tasks.graph.flagsOf(tasks.get("c") as never)).toEqual({
        blocked: true,
        held: false,
        ready: false,
        deadBlocker: false,
      });
      expect(tasks.graph.flagsOf(tasks.get("held") as never)).toMatchObject({
        held: true,
        ready: false,
      });
      // On-request work is unblocked and unheld - ready in the derived sense,
      // but the ready query never dispatches it.
      expect(tasks.graph.flagsOf(tasks.get("later") as never)).toMatchObject({ ready: true });
      expect(tasks.graph.waitingOn("c").map((r) => r.id)).toEqual(["a"]);

      tasks.close("a", { status: "done", reason: "landed", actor: "host" });
      expect(tasks.graph.listReady().map((r) => r.id)).toEqual(["b", "c"]);
      expect(tasks.graph.flagsOf(tasks.get("c") as never).blocked).toBe(false);
    });

    it("a dropped blocker is a dead wait, never a cleared one", () => {
      const { tasks, work } = setup();
      work("doomed");
      work("dependent", { blockedBy: ["doomed"] });
      tasks.close("doomed", { status: "dropped", reason: "failed", actor: "host" });
      expect(tasks.graph.listReady()).toEqual([]);
      expect(tasks.graph.listDeadBlocked().map((r) => r.id)).toEqual(["dependent"]);
      expect(tasks.graph.flagsOf(tasks.get("dependent") as never)).toMatchObject({
        blocked: true,
        deadBlocker: true,
      });
      // Unlinking the dead edge frees it; a held row is never listed dead.
      tasks.graph.unlink("doomed", "dependent", "blocks", "firstmate");
      expect(tasks.graph.listDeadBlocked()).toEqual([]);
      expect(tasks.graph.listReady().map((r) => r.id)).toEqual(["dependent"]);
    });
  });

  describe("cycle refusal", () => {
    it("refuses a blocks edge that would close a cycle, directly or through others", () => {
      const { tasks, work } = setup();
      work("a");
      work("b", { blockedBy: ["a"] });
      work("c", { blockedBy: ["b"] });
      expect(() => tasks.graph.link("c", "a", "blocks", "firstmate")).toThrow(TaskGraphRefusal);
      expect(() => tasks.graph.link("c", "a", "blocks", "firstmate")).toThrow(
        /SCR-1 already blocks SCR-3.*would close a cycle/,
      );
      expect(() => tasks.graph.link("b", "a", "blocks", "firstmate")).toThrow(/close a cycle/);
      expect(() => tasks.graph.link("a", "a", "blocks", "firstmate")).toThrow(/linked to itself/);
      // Nothing was written by the refusals.
      expect(tasks.graph.blockers("a")).toEqual([]);
      expect(tasks.timeline("a").map((e) => e.kind)).toEqual(["created"]);
      // Informational edges never cycle-check: related both ways is fine.
      expect(tasks.graph.link("c", "a", "related", "firstmate")).toBe(true);
      expect(tasks.graph.link("a", "c", "related", "firstmate")).toBe(true);
      // The refusal at create rolls the whole create back.
      expect(() => work("d", { blockedBy: ["nope"] })).toThrow(/Unknown task/);
      expect(tasks.get("d")).toBeUndefined();
    });

    // INF-3167, from the loop INF-3140 found: a parent waits on its own
    // parts until they close, so the loop check counts each live task's
    // open parts among its prerequisites, at a link and at a re-parent.
    it("refuses a parent waiting on itself through its own part, and keeps a parent waiting on its part", () => {
      const { tasks, work } = setup();
      const parent = work("parent", { repoId: "r1" });
      const child = work("child", { parentId: "parent" });
      // The parent blocking its own part: the part would wait on the parent,
      // which waits on the part until it closes.
      expect(() => tasks.graph.link("parent", "child", "blocks", "firstmate")).toThrow(
        TaskGraphRefusal,
      );
      expect(() => tasks.graph.link("parent", "child", "blocks", "firstmate")).toThrow(
        new RegExp(
          `^Refused: Circular wait: ${child.key} → ${parent.key} → ${child.key}\\. A task waits on its own open parts until they close.*split that part into its own task, or fold the waiter into the task it waits on; remove a wait only when it names the wrong task`,
        ),
      );
      expect(tasks.graph.blockers("child")).toEqual([]);
      // Through other tasks too: work the part waits on cannot wait on the parent.
      const loose = work("loose", { repoId: "r1" });
      tasks.graph.link("loose", "child", "blocks", "firstmate");
      expect(() => tasks.graph.link("parent", "loose", "blocks", "firstmate")).toThrow(
        new RegExp(
          `^Refused: Circular wait: ${loose.key} → ${parent.key} → ${child.key} → ${loose.key}\\.`,
        ),
      );
      // A closed part holds its parent no more, so it closes no loop.
      tasks.close("child", { status: "dropped", reason: "cancelled", actor: "firstmate" });
      expect(tasks.graph.link("parent", "loose", "blocks", "firstmate")).toBe(true);
      // The parent waiting on its part is the containment it already has.
      work("part", { parentId: "parent" });
      expect(tasks.graph.link("part", "parent", "blocks", "firstmate")).toBe(true);
      expect(tasks.graph.blockers("parent").map((row) => row.id)).toEqual(["part"]);
    });

    it("refuses a re-parent that would put a task under the task it waits on", () => {
      const { tasks, work } = setup();
      const parent = work("parent", { repoId: "r1" });
      const loose = work("loose", { repoId: "r1" });
      // loose waits on parent; under parent it would hold the close it waits for.
      tasks.graph.link("parent", "loose", "blocks", "firstmate");
      expect(() => tasks.setParent("loose", "parent", "firstmate")).toThrow(TaskGraphRefusal);
      expect(() => tasks.setParent("loose", "parent", "firstmate")).toThrow(
        new RegExp(
          `^Refused: ${parent.key} would wait on its part ${loose.key}, which already waits on it\\. Circular wait: ${parent.key} → ${loose.key} → ${parent.key}\\.`,
        ),
      );
      expect(tasks.get("loose")?.parentId).toBeNull();
      // The other way round, a part its parent waits on, is accepted.
      work("other", { repoId: "r1" });
      tasks.graph.link("other", "parent", "blocks", "firstmate");
      tasks.setParent("other", "parent", "firstmate");
      expect(tasks.get("other")?.parentId).toBe("parent");
    });

    it("never counts the host's delivery child as a part its parent waits on", () => {
      const { tasks, work } = setup();
      work("builder", { repoId: "r1", status: "active" });
      work("review", {
        parentId: "builder",
        shape: { kind: "review", kind_source: "host:review" },
      });
      // A review reading the builder's branch waits on nothing the builder
      // waits on: the builder may block it without closing a loop.
      expect(tasks.graph.link("builder", "review", "blocks", "firstmate")).toBe(true);
      expect(tasks.graph.blockers("review").map((row) => row.id)).toEqual(["builder"]);
    });
  });

  describe("hierarchy", () => {
    it("a child inherits its parent's project and repo, and the ancestor walk refuses cycles", () => {
      const { tasks, work } = setup();
      const parent = work("parent", { repoId: "r1" });
      const child = work("child", { parentId: "parent" });
      expect(child).toMatchObject({ key: "NIA-2", projectId: "proj-r1", repoId: "r1" });
      expect(parent.key).toBe("NIA-1");
      const grandchild = work("grandchild", { parentId: "child" });
      expect(tasks.graph.ancestors("grandchild").map((r) => r.id)).toEqual(["child", "parent"]);
      expect(tasks.graph.children("parent").map((r) => r.id)).toEqual(["child"]);
      expect(tasks.graph.descendants("parent").map((r) => r.id)).toEqual(["child", "grandchild"]);
      expect(() => tasks.setParent("parent", "grandchild", "firstmate")).toThrow(TaskGraphRefusal);
      expect(() => tasks.setParent("parent", "grandchild", "firstmate")).toThrow(
        /already under NIA-1; making it the parent would close a cycle/,
      );
      expect(() => tasks.setParent("parent", "parent", "firstmate")).toThrow(/own parent/);
      expect(tasks.get("parent")?.parentId).toBeNull();
      expect(grandchild.parentId).toBe("child");
      // Re-parenting within the project records a moved event; clearing too.
      tasks.setParent("grandchild", "parent", "firstmate");
      expect(tasks.get("grandchild")?.parentId).toBe("parent");
      expect(tasks.timeline("grandchild").at(-1)).toMatchObject({
        kind: "moved",
        text: 'now under "PARENT" (NIA-1)',
      });
      tasks.setParent("grandchild", null, "firstmate");
      expect(tasks.get("grandchild")?.parentId).toBeNull();
    });

    it("re-parenting across projects moves an open, workspace-less subtree and re-keys it", () => {
      const { tasks, work } = setup();
      work("repo-parent", { repoId: "r1" });
      work("loose");
      work("loose-child", { parentId: "loose" });
      tasks.setParent("loose", "repo-parent", "firstmate");
      expect(tasks.get("loose")).toMatchObject({
        parentId: "repo-parent",
        projectId: "proj-r1",
        key: "NIA-2",
      });
      expect(tasks.get("loose-child")).toMatchObject({ projectId: "proj-r1", key: "NIA-3" });
      expect(tasks.timeline("loose").map((e) => e.kind)).toEqual(["created", "moved", "moved"]);
      expect(tasks.timeline("loose").at(-2)?.text).toBe("moved to nimbus-api as NIA-2 (was SCR-1)");
      // A key is retired, never reused.
      expect(tasks.byKey("SCR-1")).toBeUndefined();
      expect(work("next").key).toBe("SCR-3");
    });

    // INF-8: INF-3 moved from firstmate-3000's project into Infinitary's
    // kept firstmate-3000, so its pull request would have opened there. A
    // part bound to a repository of its own keeps it (the captain's answer
    // to INF-61's F1).
    it("a moved task and the parts that followed its project take the new repository; a part bound to its own keeps it", () => {
      const { db, tasks, work } = setup();
      seedProject(db, {
        id: "r2",
        name: "infinitary",
        path: "/fleet/infinitary",
        origin: "https://github.com/infinitary-labs/infinitary",
        delivery: "direct-pr",
        addedAt: 2,
        key: "INF",
      });
      seedProject(db, {
        id: "r3",
        name: "website",
        path: "/fleet/website",
        origin: "https://github.com/infinitary-labs/website",
        delivery: "direct-pr",
        addedAt: 3,
      });
      work("step", { repoId: "r1" });
      work("part", { parentId: "step" });
      work("own", { parentId: "step", repoId: "r3" });
      const where = (...ids: string[]) =>
        ids.map((id) => [tasks.get(id)?.key, tasks.get(id)?.repoId]);

      // update_task's project, as the Firstmate sends it.
      expect(tasks.updateFields("step", { project: "INF" }, "firstmate")).toEqual([
        "moved to infinitary as INF-1",
      ]);
      expect(where("step", "part", "own")).toEqual([
        ["INF-1", "r2"],
        ["INF-2", "r2"],
        ["INF-3", "r3"],
      ]);
      expect(tasks.timeline("step").find((event) => event.kind === "moved")?.data).toMatchObject({
        fromRepoId: "r1",
        toRepoId: "r2",
      });

      // A re-parent takes the new parent's repository, as a new child does,
      // whatever repository the task had.
      work("loose");
      work("bound", { repoId: "r3" });
      tasks.updateFields("loose", { parent: "INF-3" }, "firstmate");
      tasks.updateFields("bound", { parent: "INF-1" }, "firstmate");
      expect(where("loose", "bound")).toEqual([
        ["INF-4", "r3"],
        ["INF-5", "r2"],
      ]);

      // Scratch has no repository: each task keeps the one it works in.
      tasks.updateFields("step", { project: "SCR" }, "firstmate");
      const subtree = [tasks.get("step"), ...tasks.graph.descendants("step")];
      expect(
        Object.fromEntries(subtree.map((row) => [row?.id, [row?.projectId, row?.repoId]])),
      ).toEqual({
        step: ["scratch", "r2"],
        part: ["scratch", "r2"],
        own: ["scratch", "r3"],
        loose: ["scratch", "r3"],
        bound: ["scratch", "r2"],
      });

      // A removed project takes no task, and the refusal writes nothing.
      tasks.projects.archiveForRepo("r2");
      const before = tasks.get("step");
      expect(() => tasks.updateFields("step", { project: "INF" }, "firstmate")).toThrow(
        `Refused: infinitary was removed, so ${before?.key} cannot move there.`,
      );
      expect(tasks.get("step")).toEqual(before);
    });

    // INF-61's R1: INF-5, moved to Scratch and then to notes, still opened
    // its pull request in infinitary.
    it("a task moved through Scratch into another project takes that project's repository, and the parts that followed it", () => {
      const { db, tasks, work } = setup();
      seedProject(db, {
        id: "r2",
        name: "notes",
        path: "/fleet/notes",
        origin: "https://github.com/infinitary-labs/notes",
        delivery: "direct-pr",
        addedAt: 2,
        key: "NOTE",
      });
      seedProject(db, {
        id: "r3",
        name: "website",
        path: "/fleet/website",
        origin: "https://github.com/infinitary-labs/website",
        delivery: "direct-pr",
        addedAt: 3,
      });
      work("step", { repoId: "r1" });
      work("part", { parentId: "step" });
      work("own", { parentId: "step", repoId: "r3" });
      const where = (...ids: string[]) =>
        ids.map((id) => [tasks.get(id)?.key, tasks.get(id)?.repoId]);

      tasks.updateFields("step", { project: "SCR" }, "firstmate");
      expect(where("step", "part", "own")).toEqual([
        ["SCR-1", "r1"],
        ["SCR-2", "r1"],
        ["SCR-3", "r3"],
      ]);
      expect(tasks.updateFields("step", { project: "NOTE" }, "firstmate")).toEqual([
        "moved to notes as NOTE-1",
      ]);
      expect(where("step", "part", "own")).toEqual([
        ["NOTE-1", "r2"],
        ["NOTE-2", "r2"],
        ["NOTE-3", "r3"],
      ]);
    });

    // INF-61's F3: the captain's answer was to refuse, as a plan is refused.
    it("refuses to move a task asked to ship as a pull request into a project whose repository has no remote", () => {
      const db = openInMemoryDatabase();
      seedProject(db, {
        id: "r1",
        name: "infinitary",
        path: "/fleet/infinitary",
        origin: "https://github.com/infinitary-labs/infinitary.git",
        delivery: "direct-pr",
        addedAt: 1,
        key: "INF",
      });
      seedProject(db, {
        id: "r2",
        name: "notes",
        path: "/fleet/notes",
        setupKind: "init",
        addedAt: 2,
        key: "NOTE",
      });
      const tasks = new TaskService({ db, repos: new RepoRegistry(db, "/fleet"), strict: true });
      tasks.create({ id: "site", title: "Site", prompt: "p", repoId: "r1" });
      tasks.create({
        id: "ship",
        title: "Ship the checklist",
        prompt: "p",
        repoId: "r1",
        parentId: "site",
        shape: { kind: "implement", delivery_ask: "direct-pr" },
      });

      const before = [tasks.get("site"), tasks.get("ship")];
      expect(() => tasks.updateFields("site", { project: "NOTE" }, "firstmate")).toThrow(
        "Refused: INF-2 asks to ship as a pull request (direct-pr), and notes has no remote to open one on, so INF-2 cannot move there. Configure a remote for notes, or set INF-2's delivery to local-only first.",
      );
      expect([tasks.get("site"), tasks.get("ship")]).toEqual(before);
      expect(tasks.timeline("ship").map((event) => event.kind)).toEqual(["created"]);

      // Once its delivery is local-only, the subtree moves.
      tasks.updateFields("ship", { policies: { delivery: "local-only" } }, "firstmate");
      expect(tasks.updateFields("site", { project: "NOTE" }, "firstmate")).toEqual([
        "moved to notes as NOTE-1",
      ]);
      expect(tasks.get("ship")).toMatchObject({ key: "NOTE-2", repoId: "r2" });
    });

    it("refuses to move started work or a subtree with started work", () => {
      const { tasks, work } = setup();
      seedTask(tasks, { id: "running", title: "running", status: "running", worktreeDir: "/wt" });
      work("repo-parent", { repoId: "r1" });
      expect(() => tasks.moveToProject("running", "proj-r1", "firstmate")).toThrow(
        /is active and cannot move/,
      );
      work("container");
      work("started-child", { parentId: "container", status: "active" });
      expect(() => tasks.setParent("container", "repo-parent", "firstmate")).toThrow(
        /its child .* is active/,
      );
      expect(tasks.get("container")).toMatchObject({ parentId: null, projectId: "scratch" });
    });

    it("the parent close rule names the open children; a confirmed drop cascades as superseded", () => {
      const { tasks, work } = setup();
      work("parent");
      work("c1", { parentId: "parent" });
      work("c2", { parentId: "parent" });
      work("c2a", { parentId: "c2" });
      tasks.close("c1", { status: "done", reason: "landed", actor: "host" });
      const refusal = tasks.graph.closeRefusal("parent");
      expect(refusal).toMatchObject({
        refused: "children-open",
        task: { key: "SCR-1" },
        tasks: [{ key: "SCR-3", title: "C2" }],
      });
      expect(refusal?.text).toBe(
        'Cannot close SCR-1 while its child is still open: SCR-3 "C2". Start it so it can close, drop it as superseded, or settle SCR-1 keeping it planned.',
      );
      // Every way is a runnable pointing gesture, never a host mutation.
      expect(refusal?.ways.map((way) => ("tool" in way ? [way.tool, way.args] : way))).toEqual([
        ["update_task", { task: "SCR-3", start_policy: "when-ready", blocked_by: [] }],
        ["update_task", { task: "SCR-3", drop: true, reason: "superseded", confirm: true }],
      ]);
      expect(tasks.graph.closeRefusal("c1")).toBeUndefined();
      const dropped = tasks.dropWithChildren("parent", {
        reason: "the captain changed course",
        actor: "firstmate",
      });
      expect(dropped.map((r) => r.id)).toEqual(["c2a", "c2"]);
      expect(tasks.get("c2a")).toMatchObject({ status: "dropped", closedReason: "superseded" });
      expect(tasks.get("c2")).toMatchObject({ status: "dropped", closedReason: "superseded" });
      expect(tasks.get("c1")).toMatchObject({ status: "done", closedReason: "landed" });
      expect(tasks.get("parent")).toMatchObject({ status: "dropped", closedReason: "cancelled" });
      expect(tasks.timeline("parent").at(-1)?.text).toBe("dropped - the captain changed course");
      expect(tasks.timeline("c2").at(-1)?.text).toBe('superseded - "PARENT" (SCR-1) was dropped');
      expect(tasks.graph.closeRefusal("parent")).toBeUndefined();
    });

    it("drops never-started work for the captain, keeping its open parts planned", () => {
      const { tasks, work } = setup();
      const leaf = work("leaf");
      const waiter = work("waiter");
      tasks.graph.link(leaf.id, waiter.id, "blocks", "captain");
      tasks.graph.link(leaf.id, waiter.id, "related", "captain");
      const review = dropReviewKeys(tasks.dropEffects(leaf.id));
      expect(review.waiting).toEqual([waiter.key]);
      expect(
        tasks.starts.dropUnstarted(leaf.id, {
          actor: "captain",
          review: { ...review, waiting: [] },
        }),
      ).toEqual({
        ok: false,
        text: DROP_REVIEW_STALE,
      });
      expect(tasks.get(leaf.id)?.status).toBe("open");

      expect(tasks.starts.dropUnstarted(leaf.id, { actor: "captain", review })).toEqual({
        ok: true,
      });
      expect(tasks.get(leaf.id)).toMatchObject({
        status: "dropped",
        closedReason: "cancelled",
      });
      expect(tasks.timeline(leaf.id).at(-1)).toMatchObject({
        actor: "captain",
        text: `dropped - ${NO_LONGER_WANTED}`,
        data: { beforeStart: true, status: "dropped", reason: "cancelled" },
      });
      expect(tasks.get(waiter.id)?.status).toBe("open");
      expect(tasks.graph.blockers(waiter.id).map((row) => row.id)).toEqual([leaf.id]);
      expect(tasks.graph.linksTo(waiter.id).some((link) => link.type === "related")).toBe(true);
      expect(tasks.starts.dropUnstarted(leaf.id, { actor: "captain", review })).toMatchObject({
        ok: false,
      });

      // The one drop (INF-3169's piece 4, the captain's pick "Also fold the
      // three into one drop") keeps open parts planned and never cascades.
      const parent = work("parent");
      const openPart = work("part", { parentId: parent.id });
      const closedPart = work("done-part", { parentId: parent.id });
      tasks.close(closedPart.id, { status: "done", reason: "landed", actor: "host" });
      const parentReview = dropReviewKeys(tasks.dropEffects(parent.id));
      expect(parentReview.parts).toEqual([openPart.key]);
      expect(
        tasks.starts.dropUnstarted(parent.id, {
          actor: "captain",
          review: { ...parentReview, parts: [] },
        }),
      ).toEqual({ ok: false, text: DROP_REVIEW_STALE });
      expect(
        tasks.starts.dropUnstarted(parent.id, { actor: "captain", review: parentReview }),
      ).toEqual({
        ok: true,
      });
      expect(tasks.get(parent.id)).toMatchObject({ status: "dropped", closedReason: "cancelled" });
      expect(tasks.get(openPart.id)?.status).toBe("open");
      expect(tasks.get(closedPart.id)?.status).toBe("done");
    });

    it("queues and unqueues never-started work on the captain's word, and refuses started work and parents without writing", () => {
      const { db, tasks, work, tick } = setup();
      const blocker = work("blocker");
      const leaf = work("leaf", { startPolicy: "on-request", priority: 2 });
      tasks.graph.link(blocker.id, leaf.id, "blocks", "captain");
      tasks.placement.setGate(leaf.id, { kind: "at-time", until: 9_999_999 }, "held for later");
      const before = tasks.get(leaf.id);
      tick();

      // Queue: the start policy alone changes; its blocker, hold, priority,
      // project and parent stay, and the history says so in the captain's words.
      expect(
        tasks.starts.setQueued(leaf.id, "queue-task", { actor: "captain", via: "task-card" }),
      ).toEqual({ ok: true, changed: true });
      const queued = tasks.get(leaf.id);
      expect(queued).toMatchObject({
        status: "open",
        startPolicy: "when-ready",
        priority: before?.priority,
        projectId: before?.projectId,
        parentId: before?.parentId,
        gate: before?.gate,
      });
      expect(tasks.graph.blockers(leaf.id).map((row) => row.id)).toEqual([blocker.id]);
      expect(tasks.timeline(leaf.id).at(-1)).toMatchObject({
        actor: "captain",
        kind: "note",
        text: QUEUED_ACTIVITY,
        data: { startPolicy: "when-ready", via: "task-card" },
      });
      // The same move again writes nothing.
      const entries = tasks.timeline(leaf.id).length;
      expect(tasks.starts.setQueued(leaf.id, "queue-task", { actor: "captain" })).toEqual({
        ok: true,
        changed: false,
      });
      expect(tasks.timeline(leaf.id)).toHaveLength(entries);

      // Unqueue: back to the backlog, waiting for the captain's word.
      expect(
        tasks.starts.setQueued(leaf.id, "unqueue-task", { actor: "captain", via: "task-card" }),
      ).toEqual({ ok: true, changed: true });
      expect(tasks.get(leaf.id)?.startPolicy).toBe("on-request");
      expect(tasks.timeline(leaf.id).at(-1)?.text).toBe(UNQUEUED_ACTIVITY);
      // Both read back as the captain's task card clicks.
      expect(tasks.taskCardClicksSince(0).map(({ op }) => op)).toEqual([
        "unqueue-task",
        "queue-task",
      ]);

      // A parent whose parts do the work is refused, and so is started or closed work.
      const parent = work("parent", { startPolicy: "on-request" });
      work("part", { parentId: parent.id, startPolicy: "on-request" });
      expect(tasks.starts.setQueued(parent.id, "queue-task", { actor: "captain" })).toEqual({
        ok: false,
        text: queuePartsRefusal(parent.key),
      });
      expect(tasks.get(parent.id)?.startPolicy).toBe("on-request");
      // An older version's failed start left the row open and still marked started.
      const started = work("started", { startPolicy: "on-request" });
      expect(tasks.starts.claimForDispatch(started.id)).toBe(true);
      db.prepare("UPDATE tasks SET status = 'open', activity = NULL WHERE id = 'started'").run();
      expect(tasks.get(started.id)).toMatchObject({
        status: "open",
        startedAt: expect.any(Number),
      });
      expect(tasks.starts.setQueued(started.id, "queue-task", { actor: "captain" })).toEqual({
        ok: false,
        text: queueStartedRefusal(started.key),
      });
      // INF-3307 row 4: a start that began no crewmate leaves the task never started, so it queues.
      const returned = work("returned", { startPolicy: "on-request" });
      expect(tasks.starts.claimForDispatch(returned.id)).toBe(true);
      tasks.starts.returnStart(returned.id, {
        kind: "held",
        gate: { kind: "at-time", until: 9_999_999, reason: "no account was free" },
      });
      expect(tasks.get(returned.id)).toMatchObject({ status: "open", startedAt: null });
      expect(tasks.starts.setQueued(returned.id, "queue-task", { actor: "captain" })).toEqual({
        ok: true,
        changed: true,
      });
      tasks.close(blocker.id, { status: "done", reason: "landed", actor: "host" });
      expect(tasks.starts.setQueued(blocker.id, "unqueue-task", { actor: "captain" })).toEqual({
        ok: false,
        text: queueClosedRefusal(blocker.key),
      });
      expect(tasks.starts.setQueued("nowhere", "queue-task", { actor: "captain" })).toEqual({
        ok: false,
        text: queueMissingRefusal("nowhere"),
      });
    });
  });

  // INF-2062: a started task goes back to the backlog with its work kept, and Start takes it out.
  it("moves started work to the backlog and back out, keeping its run and noting who and why", () => {
    const { tasks, work, tick } = setup();
    const started = work("started", { startPolicy: "on-request" });
    expect(tasks.starts.claimForDispatch(started.id)).toBe(true);
    tasks.turns.recordRecovery(started.id, { rung: 2, count: 3, at: 900 });
    const before = tasks.get(started.id);
    expect(before?.status).toBe("active");
    tick(10);
    expect(
      tasks.starts.setQueued(started.id, "unqueue-task", {
        actor: "captain",
        via: "task-card",
        reason: "Pause it until the design settles.",
      }),
    ).toEqual({ ok: true, changed: true });
    const parked = tasks.get(started.id);
    expect(parked).toMatchObject({
      status: "active",
      backlogSince: 1_010,
      recoveryRung: 0,
      recoveryCount: 0,
      recoveryAt: null,
      startedAt: before?.startedAt,
      assignee: before?.assignee,
    });
    expect(tasks.timeline(started.id).at(-1)).toMatchObject({
      actor: "captain",
      kind: "note",
      text: backlogActivity("captain", "Pause it until the design settles."),
      data: { backlog: "entered", reason: "Pause it until the design settles.", via: "task-card" },
    });
    // Again writes nothing, and Queue it is refused: only Start picks it up.
    const entries = tasks.timeline(started.id).length;
    expect(tasks.starts.setQueued(started.id, "unqueue-task", { actor: "firstmate" })).toEqual({
      ok: true,
      changed: false,
    });
    expect(tasks.starts.setQueued(started.id, "queue-task", { actor: "captain" })).toEqual({
      ok: false,
      text: queueStartedBacklogRefusal(started.key),
    });
    expect(tasks.timeline(started.id)).toHaveLength(entries);

    tick(50);
    expect(tasks.starts.leaveBacklog(started.id, { actor: "firstmate" })).toBe(true);
    expect(tasks.get(started.id)).toMatchObject({
      status: "active",
      backlogSince: null,
      idleSince: 1_060,
    });
    expect(tasks.timeline(started.id).at(-1)).toMatchObject({
      actor: "firstmate",
      text: leftBacklogActivity("firstmate"),
      data: { backlog: "left", waited: 50 },
    });
    expect(tasks.starts.leaveBacklog(started.id, { actor: "firstmate" })).toBe(false);
  });

  describe("fields, follow-ups and progress", () => {
    it("edits fields with one note event and resolves ids or keys", () => {
      const { tasks, work } = setup();
      work("t");
      expect(tasks.updateFields("t", { title: "Renamed", priority: 0 }, "firstmate")).toEqual([
        'title "Renamed"',
        "priority 0",
      ]);
      expect(tasks.updateFields("t", { priority: 0 }, "firstmate")).toEqual([]);
      expect(tasks.get("t")).toMatchObject({ title: "Renamed", priority: 0 });
      expect(tasks.timeline("t").map((e) => [e.kind, e.text])).toEqual([
        ["created", 'created "T"'],
        ["note", 'updated: title "Renamed", priority 0'],
      ]);
      expect(tasks.resolve("scr-1")?.id).toBe("t");
      expect(tasks.resolve("t")?.id).toBe("t");
      expect(tasks.resolve(" ")).toBeUndefined();
    });

    it("files a follow-up as its own on-request task, discovered from the origin but never under it", () => {
      const { tasks, work } = setup();
      work("origin", { repoId: "r1", status: "active" });
      const { record: followup } = tasks.fileFollowup({
        id: "fu",
        originId: "origin",
        title: "Fix the flaky meter test",
        goal: "The meter test passes ten times in a row",
        why: "it failed twice while I was running the suite",
        prompt: "brief",
      });
      // Discovery is provenance, not containment: no parent edge, and the
      // project and repo still come from the origin.
      expect(followup).toMatchObject({
        key: "NIA-2",
        parentId: null,
        projectId: "proj-r1",
        repoId: "r1",
        status: "open",
        startPolicy: "on-request",
        goal: "The meter test passes ten times in a row",
      });
      expect(tasks.graph.discoveredFrom("origin").map((r) => r.id)).toEqual(["fu"]);
      expect(tasks.graph.discoveredOrigins("fu").map((r) => r.id)).toEqual(["origin"]);
      expect(tasks.graph.openChildren("origin")).toEqual([]);
      expect(tasks.graph.blockers("origin")).toEqual([]);
      expect(tasks.graph.listReady()).toEqual([]);
      expect(tasks.timeline("fu").map((e) => [e.kind, e.actor])).toEqual([
        ["created", "crewmate"],
        ["note", "crewmate"],
      ]);
      expect(tasks.timeline("origin").at(-1)).toMatchObject({
        kind: "linked",
        text: 'follow-up filed: "Fix the flaky meter test" (NIA-2)',
      });
      // The regression this rule exists for: a filed follow-up must not
      // stop the work the captain asked for from closing.
      expect(tasks.graph.closeRefusal("origin")).toBeUndefined();
      expect(tasks.graph.blockerRefusal("origin")).toBeUndefined();
      expect(tasks.graph.flagsOf(tasks.get("origin") as never).blocked).toBe(false);

      const { record: blocking } = tasks.fileFollowup({
        id: "fu2",
        originId: "origin",
        title: "Unblock",
        goal: "g",
        why: "w",
        prompt: "brief",
        blocksOrigin: true,
      });
      // blocks_me is now the only thing that holds the origin, and it says
      // which task rather than counting anonymous children.
      expect(tasks.graph.blockers("origin").map((r) => r.id)).toEqual([blocking.id]);
      expect(tasks.graph.closeRefusal("origin")).toBeUndefined();
      const waitsOn = tasks.graph.blockerRefusal("origin");
      expect(waitsOn).toMatchObject({
        refused: "waits-on",
        task: { key: "NIA-1" },
        tasks: [{ key: "NIA-3", title: "Unblock" }],
      });
      expect(waitsOn?.text).toBe(
        'Cannot close NIA-1 while it waits on: NIA-3 "Unblock". The wait ends when that task closes: merge it, close it with settle_task done, why answered, when it is a step whose report was all NIA-1 needed, or drop it if the work is not wanted; remove the wait with link_tasks remove only when it names the wrong task.',
      );
      // No proceed override on a wait: the ways close an answered step or
      // remove a wait that names the wrong task (INF-3167).
      expect(waitsOn?.ways).toEqual([
        {
          label: "Close NIA-3 as answered",
          tool: "settle_task",
          args: { task_id: blocking.id, mode: "done", why: "answered" },
        },
        {
          label: "Remove the wait on NIA-3",
          tool: "link_tasks",
          args: { from: "NIA-3", to: "NIA-1", type: "blocks", remove: true },
        },
      ]);
      // An active origin must SHOW that it is held, not look free until the
      // merge refuses.
      expect(tasks.graph.flagsOf(tasks.get("origin") as never)).toMatchObject({
        blocked: true,
        ready: false,
      });

      // A blocker that is not happening cannot hold a merge hostage: for
      // closing (and only there) a dropped blocker clears.
      tasks.close("fu2", { status: "dropped", reason: "cancelled", actor: "firstmate" });
      expect(tasks.graph.blockerRefusal("origin")).toBeUndefined();
      expect(tasks.graph.flagsOf(tasks.get("origin") as never).blocked).toBe(false);
    });

    it("a recorded wait on running work draws the arrow and holds its merge until the work closes", () => {
      // INF-3167, the captain's choice A ("every wait holds the start and the
      // merge until the other task closes"): link_tasks blocks on work under
      // way holds its close like a blocks_me filing, whatever the edge's mark
      // says (INF-416 piece E had the mark alone hold a close).
      const { tasks, work } = setup();
      work("origin", { repoId: "r1", status: "active" });
      const waiter = work("waiter");
      const queued = work("queued");
      tasks.graph.link("waiter", "origin", "blocks", "firstmate");
      tasks.graph.link("waiter", queued.id, "blocks", "firstmate");
      expect(tasks.graph.blockers("origin").map((row) => row.id)).toEqual(["waiter"]);
      expect(tasks.graph.linksTo("origin").find((link) => link.fromId === "waiter")).toMatchObject({
        type: "blocks",
        holdsMerge: false,
      });
      expect(tasks.graph.blockersHoldingClose("origin").map((row) => row.id)).toEqual(["waiter"]);
      expect(tasks.graph.blockerRefusal("origin")?.tasks.map((row) => row.key)).toEqual([
        waiter.key,
      ]);
      expect(tasks.graph.flagsOf(tasks.get("origin") as never).blocked).toBe(true);
      // The same edge holds the start of work that has not begun.
      expect(tasks.graph.listReady().map((row) => row.id)).not.toContain(queued.id);
      // Started work waiting on the waiter reads its reports (row 0b).
      expect(tasks.graph.activeWaiters("waiter").map((row) => row.id)).toEqual(["origin"]);

      const { record: blocking } = tasks.fileFollowup({
        id: "fu",
        originId: "origin",
        title: "Must land first",
        goal: "g",
        why: "w",
        prompt: "brief",
        blocksOrigin: true,
      });
      expect(
        tasks.graph.linksTo("origin").find((link) => link.fromId === blocking.id)?.holdsMerge,
      ).toBe(true);
      expect(tasks.graph.blockerRefusal("origin")?.tasks.map((row) => row.key)).toEqual([
        waiter.key,
        blocking.key,
      ]);
      // The waited-on work's close, done or dropped, ends its hold.
      tasks.close("waiter", { status: "done", reason: "landed", actor: "captain" });
      tasks.close(blocking.id, { status: "dropped", reason: "cancelled", actor: "firstmate" });
      expect(tasks.graph.blockerRefusal("origin")).toBeUndefined();
      expect(tasks.graph.flagsOf(tasks.get("origin") as never).blocked).toBe(false);
    });

    // INF-1826 (the captain's Approve and build, q1 A and q2 yes): a replaced-by
    // link moves the live waits on both ends of the old task to the one that
    // carries its work, in the same write. The tasks are INF-1641's case.
    it("moves the live waits on a replaced task, and its own, to the task carrying its work", () => {
      const { tasks, work, tick } = setup();
      const old = work("inf-1550", { title: "Runbooks piece 0", status: "active" });
      const carrier = work("inf-1641", { title: "Publish Runbooks piece 0", status: "active" });
      const waiter = work("inf-1688", { title: "Finish self-resolving stalls", status: "active" });
      const held = work("inf-1481", { title: "Pause the stall alert", status: "open" });
      const finished = work("inf-1480", { title: "Count the stalls", status: "active" });
      const prerequisite = work("inf-1479", { title: "Runbook loader", status: "active" });
      const done = work("done-fix", { title: "Old fixture fix", status: "active" });
      const review = work("review", {
        parentId: old.id,
        status: "active",
        shape: { kind: "review", kind_source: "host:review" },
      });
      tasks.graph.link(old.id, waiter.id, "blocks", "crewmate");
      tasks.graph.link(old.id, held.id, "blocks", "firstmate", true);
      tasks.graph.link(old.id, finished.id, "blocks", "crewmate");
      tasks.graph.link(prerequisite.id, old.id, "blocks", "firstmate");
      tasks.graph.link(done.id, old.id, "blocks", "firstmate");
      tasks.graph.link(review.id, old.id, "blocks", "host");
      tasks.graph.link(old.id, carrier.id, "related", "firstmate");
      const began = tasks.graph.linksTo(waiter.id)[0]?.createdAt;
      tasks.close(finished.id, { status: "done", reason: "merged", actor: "captain" });
      tasks.close(done.id, { status: "done", reason: "merged", actor: "captain" });
      tick(60_000);

      tasks.dropWithChildren(old.id, {
        reason: "its branch moved to a fresh task",
        actor: "firstmate",
        replacedBy: carrier.id,
      });

      const waitsOf = (id: string) =>
        tasks.graph
          .linksTo(id)
          .filter((link) => link.type === "blocks")
          .map((link) => ({ from: link.fromId, holdsMerge: link.holdsMerge }));
      expect(waitsOf(waiter.id)).toEqual([{ from: carrier.id, holdsMerge: false }]);
      expect(tasks.graph.linksTo(waiter.id)[0]?.createdAt).toBe(began);
      expect(waitsOf(held.id)).toEqual([{ from: carrier.id, holdsMerge: true }]);
      expect(tasks.graph.blockerRefusal(held.id)?.tasks.map((row) => row.id)).toEqual([carrier.id]);
      // A closed waiter keeps its history; done work holds nothing to move.
      expect(waitsOf(finished.id)).toEqual([{ from: old.id, holdsMerge: false }]);
      expect(waitsOf(carrier.id)).toEqual([{ from: prerequisite.id, holdsMerge: false }]);
      expect(
        waitsOf(old.id)
          .map((wait) => wait.from)
          .sort(),
      ).toEqual([done.id, review.id].sort());
      expect(
        tasks.graph
          .linksFrom(old.id)
          .map((link) => link.type)
          .sort(),
      ).toEqual(["blocks", "related", "replaced-by"].sort());
      expect(tasks.timeline(waiter.id).filter((event) => event.kind === "unlinked")).toMatchObject([
        { data: { fromId: old.id, type: "blocks", movedTo: carrier.id } },
      ]);
      // Nothing waits on the dropped task any more, so no dead gate is left behind.
      expect(tasks.graph.listDeadBlocked().map((row) => row.id)).not.toContain(held.id);
      expect(tasks.graph.carrierOf(old.id)?.id).toBe(carrier.id);
    });

    it("leaves a wait on the replaced task when moving it would close a cycle", () => {
      const { tasks, work } = setup();
      const old = work("old", { status: "active" });
      const carrier = work("carrier", { status: "active" });
      const waiter = work("waiter", { status: "active" });
      tasks.graph.link(old.id, waiter.id, "blocks", "crewmate");
      tasks.graph.link(waiter.id, carrier.id, "blocks", "firstmate");
      tasks.graph.link(old.id, carrier.id, "replaced-by", "firstmate");
      expect(tasks.graph.linksTo(waiter.id).map((link) => link.fromId)).toEqual([old.id]);
      expect(tasks.graph.replacementOf(old.id)).toBe(carrier.key);
    });

    it("copies a merge mark when dropped work starts again, and a required action's prerequisite holds", () => {
      const { tasks, work } = setup();
      const old = work("old", { status: "active" });
      const waiting = work("waiting", { status: "active" });
      tasks.graph.link(old.id, waiting.id, "blocks", "host", true);
      tasks.close(old.id, { status: "dropped", reason: "discarded", actor: "captain" });
      const fresh = tasks.starts.startAgain(old.id, {
        id: "fresh",
        shape: { kind: "unclear" },
        actor: "captain",
      });
      expect(
        tasks.graph.linksTo(waiting.id).find((link) => link.fromId === fresh.id)?.holdsMerge,
      ).toBe(true);
      expect(tasks.graph.blockerRefusal(waiting.id)?.tasks.map((row) => row.id)).toEqual([
        fresh.id,
      ]);

      const source = work("source");
      const prerequisite = work("prerequisite");
      tasks.delivery.declareRequiredActions(
        source.id,
        {
          cardId: "card-source",
          offerId: "offer-1",
          actions: [
            {
              id: "install",
              target: "this Mac",
              title: "Install the update",
              consequence: "Until then the old copy stays.",
              instructions: ["Choose Update now."],
              criterion: "The new version is running.",
              prerequisites: [prerequisite.id],
              completion: { kind: "manual", label: "I installed it" },
            },
          ],
        },
        true,
      );
      const action = tasks.listOpen().find((row) => row.delivery?.captainAction);
      expect(action).toBeDefined();
      expect(
        tasks.graph.linksTo(action?.id ?? "").find((link) => link.fromId === prerequisite.id)
          ?.holdsMerge,
      ).toBe(true);
      expect(tasks.graph.blockerRefusal(action?.id ?? "")).toBeDefined();
    });

    it("dedupes an open filing that names the same test, and refuses a test failure with no path", () => {
      const { tasks, work } = setup();
      work("origin", { repoId: "r1", status: "active" });
      const first = tasks.fileFollowup({
        id: "fu",
        originId: "origin",
        title: "Fix the flaky meter test",
        goal: "The meter test passes",
        why: "it failed under a spaced path",
        prompt: "brief",
        testFailure: true,
        testPath: "./tests/meter.test.ts",
      });
      expect(first.duplicate).toBe(false);
      expect(first.record.testPath).toBe("tests/meter.test.ts");
      expect(() =>
        tasks.fileFollowup({
          id: "missing",
          originId: "origin",
          title: "Again",
          goal: "g",
          why: "w",
          prompt: "brief",
          testFailure: true,
        }),
      ).toThrow(/test_path is required/);
      const again = tasks.fileFollowup({
        id: "fu2",
        originId: "origin",
        title: "Same failure",
        goal: "g",
        why: "w",
        prompt: "brief",
        testPath: "tests/meter.test.ts",
      });
      expect(again).toMatchObject({ duplicate: true, record: { id: "fu" } });
      expect(tasks.get("fu2")).toBeUndefined();
      tasks.markOpened(first.record.id);
      expect(tasks.get("fu")?.captainOpenedAt).toEqual(expect.any(Number));
      expect(tasks.markOpened(first.record.id)).toBe(false);
      expect(tasks.updateFields("fu", { verdict: "still real on main" }, "firstmate")).toEqual([
        'verdict "still real on main"',
      ]);
      expect(tasks.get("fu")?.verdict).toBe("still real on main");
    });
  });
});
