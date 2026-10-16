import { DROP_REVIEW_STALE, dropReviewKeys, NO_LONGER_WANTED } from "@shared/recordDrop";
import {
  QUEUED_ACTIVITY,
  queueClosedRefusal,
  queueMissingRefusal,
  queuePartsRefusal,
  queueStartedRefusal,
  UNQUEUED_ACTIVITY,
} from "@shared/taskQueue";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { RepoRegistry } from "../workspace/repoRegistry";
import { seedTask } from "./seedTask";
import { TaskGraphRefusal, TaskService } from "./taskService";

/**
 * The task graph (task-system P2, design sections 7 to 9): hierarchy with
 * the ancestor walk, blocks edges with cycle refusal, the ready query, the
 * parent close rule, project moves, and the crewmate's follow-up. Every
 * assertion reads the record back through the service.
 */

function setup() {
  const db = openInMemoryDatabase();
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', NULL, 'direct-pr', 0)",
  ).run("r1", "/fleet/nimbus-api", "nimbus-api", 1);
  let now = 1_000;
  const tasks = new TaskService({
    db,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: () => now,
    strict: true,
  });
  tasks.projects.ensureForRepo({ id: "r1", name: "nimbus-api" });
  const work = (id: string, extra: Partial<Parameters<TaskService["create"]>[0]> = {}) =>
    tasks.create({ id, title: id.toUpperCase(), prompt: "p", repoId: null, ...extra });
  return { db, tasks, work, tick: (ms = 1) => (now += ms) };
}

describe("the task graph (task-system P2)", () => {
  describe("ready and blocked", () => {
    it("lists open when-ready work with every blocker closed, priority first", () => {
      const { tasks, work } = setup();
      work("a", { priority: 3 });
      work("b", { priority: 1 });
      work("c", { blockedBy: ["a"] });
      work("held", { gate: { kind: "at-time", until: 9 } });
      work("later", { startPolicy: "on-request" });
      tasks.create({ id: "q", kind: "question", title: "Q", prompt: "", repoId: null });
      expect(tasks.listReady().map((r) => r.id)).toEqual(["b", "a"]);
      expect(tasks.flagsOf(tasks.get("c") as never)).toEqual({
        blocked: true,
        held: false,
        ready: false,
        deadBlocker: false,
      });
      expect(tasks.flagsOf(tasks.get("held") as never)).toMatchObject({ held: true, ready: false });
      // On-request work is unblocked and unheld - ready in the derived sense,
      // but the ready query never dispatches it.
      expect(tasks.flagsOf(tasks.get("later") as never)).toMatchObject({ ready: true });
      expect(tasks.waitingOn("c").map((r) => r.id)).toEqual(["a"]);

      tasks.close("a", { status: "done", reason: "landed", actor: "host" });
      expect(tasks.listReady().map((r) => r.id)).toEqual(["b", "c"]);
      expect(tasks.flagsOf(tasks.get("c") as never).blocked).toBe(false);
    });

    it("a dropped blocker is a dead wait, never a cleared one", () => {
      const { tasks, work } = setup();
      work("doomed");
      work("dependent", { blockedBy: ["doomed"] });
      tasks.close("doomed", { status: "dropped", reason: "failed", actor: "host" });
      expect(tasks.listReady()).toEqual([]);
      expect(tasks.listDeadBlocked().map((r) => r.id)).toEqual(["dependent"]);
      expect(tasks.flagsOf(tasks.get("dependent") as never)).toMatchObject({
        blocked: true,
        deadBlocker: true,
      });
      // Unlinking the dead edge frees it; a held row is never listed dead.
      tasks.unlink("doomed", "dependent", "blocks", "firstmate");
      expect(tasks.listDeadBlocked()).toEqual([]);
      expect(tasks.listReady().map((r) => r.id)).toEqual(["dependent"]);
    });
  });

  describe("cycle refusal", () => {
    it("refuses a blocks edge that would close a cycle, directly or through others", () => {
      const { tasks, work } = setup();
      work("a");
      work("b", { blockedBy: ["a"] });
      work("c", { blockedBy: ["b"] });
      expect(() => tasks.link("c", "a", "blocks", "firstmate")).toThrow(TaskGraphRefusal);
      expect(() => tasks.link("c", "a", "blocks", "firstmate")).toThrow(
        /SCR-1 already blocks SCR-3.*would close a cycle/,
      );
      expect(() => tasks.link("b", "a", "blocks", "firstmate")).toThrow(/close a cycle/);
      expect(() => tasks.link("a", "a", "blocks", "firstmate")).toThrow(/linked to itself/);
      // Nothing was written by the refusals.
      expect(tasks.blockers("a")).toEqual([]);
      expect(tasks.timeline("a").map((e) => e.kind)).toEqual(["created"]);
      // Informational edges never cycle-check: related both ways is fine.
      expect(tasks.link("c", "a", "related", "firstmate")).toBe(true);
      expect(tasks.link("a", "c", "related", "firstmate")).toBe(true);
      // The refusal at create rolls the whole create back.
      expect(() => work("d", { blockedBy: ["nope"] })).toThrow(/Unknown task/);
      expect(tasks.get("d")).toBeUndefined();
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
      expect(tasks.ancestors("grandchild").map((r) => r.id)).toEqual(["child", "parent"]);
      expect(tasks.children("parent").map((r) => r.id)).toEqual(["child"]);
      expect(tasks.descendants("parent").map((r) => r.id)).toEqual(["child", "grandchild"]);
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
      const repo = db.prepare(
        "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
      );
      repo.run(
        "r2",
        "/fleet/infinitary",
        "infinitary",
        2,
        "https://github.com/infinitary-labs/infinitary",
      );
      repo.run("r3", "/fleet/website", "website", 3, "https://github.com/infinitary-labs/website");
      tasks.projects.ensureForRepo({ id: "r2", name: "infinitary" }, "INF");
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
      const subtree = [tasks.get("step"), ...tasks.descendants("step")];
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
      const repo = db.prepare(
        "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', ?, 'direct-pr', 0)",
      );
      repo.run("r2", "/fleet/notes", "notes", 2, "https://github.com/infinitary-labs/notes");
      repo.run("r3", "/fleet/website", "website", 3, "https://github.com/infinitary-labs/website");
      tasks.projects.ensureForRepo({ id: "r2", name: "notes" }, "NOTE");
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
      const repo = db.prepare(
        "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
      );
      repo.run(
        "r1",
        "/fleet/infinitary",
        "infinitary",
        1,
        "clone",
        "https://github.com/infinitary-labs/infinitary.git",
        "direct-pr",
      );
      repo.run("r2", "/fleet/notes", "notes", 2, "init", null, "local-only");
      const tasks = new TaskService({ db, repos: new RepoRegistry(db, "/fleet"), strict: true });
      tasks.projects.ensureForRepo({ id: "r1", name: "infinitary" }, "INF");
      tasks.projects.ensureForRepo({ id: "r2", name: "notes" }, "NOTE");
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
      const refusal = tasks.closeRefusal("parent");
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
        ["update_task", { task: "SCR-3", start_policy: "when-ready" }],
        ["update_task", { task: "SCR-3", drop: true, reason: "superseded", confirm: true }],
      ]);
      expect(tasks.closeRefusal("c1")).toBeUndefined();
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
      expect(tasks.closeRefusal("parent")).toBeUndefined();
    });

    it("drops never-started work for the captain and refuses open parts without writing", () => {
      const { tasks, work } = setup();
      const leaf = work("leaf");
      const waiter = work("waiter");
      tasks.link(leaf.id, waiter.id, "blocks", "captain");
      tasks.link(leaf.id, waiter.id, "related", "captain");
      const review = dropReviewKeys(tasks.dropEffects(leaf.id));
      expect(review.waiting).toEqual([waiter.key]);
      expect(
        tasks.dropUnstarted(leaf.id, { actor: "captain", review: { ...review, waiting: [] } }),
      ).toEqual({
        ok: false,
        text: DROP_REVIEW_STALE,
      });
      expect(tasks.get(leaf.id)?.status).toBe("open");

      expect(tasks.dropUnstarted(leaf.id, { actor: "captain", review })).toEqual({ ok: true });
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
      expect(tasks.blockers(waiter.id).map((row) => row.id)).toEqual([leaf.id]);
      expect(tasks.linksTo(waiter.id).some((link) => link.type === "related")).toBe(true);
      expect(tasks.dropUnstarted(leaf.id, { actor: "captain", review })).toMatchObject({
        ok: false,
      });

      const parent = work("parent");
      const openPart = work("part", { parentId: parent.id });
      const closedPart = work("done-part", { parentId: parent.id });
      tasks.close(closedPart.id, { status: "done", reason: "landed", actor: "host" });
      const refused = tasks.dropUnstarted(parent.id, {
        actor: "captain",
        review: dropReviewKeys(tasks.dropEffects(parent.id)),
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.text).toContain(openPart.key);
      expect(tasks.get(parent.id)?.status).toBe("open");
      expect(tasks.get(openPart.id)?.status).toBe("open");
      expect(tasks.get(closedPart.id)).toMatchObject({ status: "done", closedReason: "landed" });

      tasks.close(openPart.id, { status: "dropped", reason: "cancelled", actor: "captain" });
      expect(
        tasks.dropUnstarted(parent.id, {
          actor: "captain",
          review: dropReviewKeys(tasks.dropEffects(parent.id)),
        }),
      ).toEqual({ ok: true });
      expect(tasks.get(closedPart.id)?.status).toBe("done");
    });

    it("queues and unqueues never-started work on the captain's word, and refuses started work and parents without writing", () => {
      const { tasks, work, tick } = setup();
      const blocker = work("blocker");
      const leaf = work("leaf", { startPolicy: "on-request", priority: 2 });
      tasks.link(blocker.id, leaf.id, "blocks", "captain");
      tasks.setGate(leaf.id, { kind: "at-time", until: 9_999_999 }, "held for later");
      const before = tasks.get(leaf.id);
      tick();

      // Queue: the start policy alone changes; its blocker, hold, priority,
      // project and parent stay, and the history says so in the captain's words.
      expect(
        tasks.setQueued(leaf.id, "queue-task", { actor: "captain", via: "task-card" }),
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
      expect(tasks.blockers(leaf.id).map((row) => row.id)).toEqual([blocker.id]);
      expect(tasks.timeline(leaf.id).at(-1)).toMatchObject({
        actor: "captain",
        kind: "note",
        text: QUEUED_ACTIVITY,
        data: { startPolicy: "when-ready", via: "task-card" },
      });
      // The same move again writes nothing.
      const entries = tasks.timeline(leaf.id).length;
      expect(tasks.setQueued(leaf.id, "queue-task", { actor: "captain" })).toEqual({
        ok: true,
        changed: false,
      });
      expect(tasks.timeline(leaf.id)).toHaveLength(entries);

      // Unqueue: back to the backlog, waiting for the captain's word.
      expect(
        tasks.setQueued(leaf.id, "unqueue-task", { actor: "captain", via: "task-card" }),
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
      expect(tasks.setQueued(parent.id, "queue-task", { actor: "captain" })).toEqual({
        ok: false,
        text: queuePartsRefusal(parent.key),
      });
      expect(tasks.get(parent.id)?.startPolicy).toBe("on-request");
      const started = work("started", { startPolicy: "on-request" });
      expect(tasks.claimForDispatch(started.id)).toBe(true);
      tasks.requeue(started.id, { kind: "at-time", until: 9_999_999 }, "no account was free");
      expect(tasks.get(started.id)).toMatchObject({ status: "open" });
      expect(tasks.setQueued(started.id, "queue-task", { actor: "captain" })).toEqual({
        ok: false,
        text: queueStartedRefusal(started.key),
      });
      tasks.close(blocker.id, { status: "done", reason: "landed", actor: "host" });
      expect(tasks.setQueued(blocker.id, "unqueue-task", { actor: "captain" })).toEqual({
        ok: false,
        text: queueClosedRefusal(blocker.key),
      });
      expect(tasks.setQueued("nowhere", "queue-task", { actor: "captain" })).toEqual({
        ok: false,
        text: queueMissingRefusal("nowhere"),
      });
    });
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
      expect(tasks.discoveredFrom("origin").map((r) => r.id)).toEqual(["fu"]);
      expect(tasks.discoveredOrigins("fu").map((r) => r.id)).toEqual(["origin"]);
      expect(tasks.openChildren("origin")).toEqual([]);
      expect(tasks.blockers("origin")).toEqual([]);
      expect(tasks.listReady()).toEqual([]);
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
      expect(tasks.closeRefusal("origin")).toBeUndefined();
      expect(tasks.blockerRefusal("origin")).toBeUndefined();
      expect(tasks.flagsOf(tasks.get("origin") as never).blocked).toBe(false);

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
      expect(tasks.blockers("origin").map((r) => r.id)).toEqual([blocking.id]);
      expect(tasks.closeRefusal("origin")).toBeUndefined();
      const waitsOn = tasks.blockerRefusal("origin");
      expect(waitsOn).toMatchObject({
        refused: "waits-on",
        task: { key: "NIA-1" },
        tasks: [{ key: "NIA-3", title: "Unblock" }],
      });
      expect(waitsOn?.text).toBe(
        'Cannot close NIA-1 while it waits on: NIA-3 "Unblock". Merge it first, drop it if the work is not wanted, or remove the wait with link_tasks remove.',
      );
      // No proceed override on a blocks_me promise: the ways only remove it.
      expect(waitsOn?.ways.map((way) => ("tool" in way ? way.tool : way))).toEqual(["link_tasks"]);
      // An active origin must SHOW that it is held, not look free until the
      // merge refuses.
      expect(tasks.flagsOf(tasks.get("origin") as never)).toMatchObject({
        blocked: true,
        ready: false,
      });

      // A blocker that is not happening cannot hold a merge hostage: for
      // closing (and only there) a dropped blocker clears.
      tasks.close("fu2", { status: "dropped", reason: "cancelled", actor: "firstmate" });
      expect(tasks.blockerRefusal("origin")).toBeUndefined();
      expect(tasks.flagsOf(tasks.get("origin") as never).blocked).toBe(false);
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
