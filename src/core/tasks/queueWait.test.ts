import { taskStatusOf } from "@shared/taskPresentation";
import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../storage/db";
import { TaskProtocol } from "./taskProtocol";
import { queryTasks } from "./taskQuery";
import { TaskService } from "./taskService";

/** Finding 4 of the nightly product audit: a task names its wait and when it began. */
function fixture() {
  const db = openInMemoryDatabase();
  let at = 1_800_000_000_000;
  const tasks = new TaskService({ db, repos: { get: () => undefined }, now: () => at });
  const protocol = new TaskProtocol({
    tasks,
    repos: { get: () => undefined },
    cards: { listOpen: () => [], snapshot: () => [] },
    broadcastEvent: () => {},
    emit: () => {},
  });
  const create = (id: string, startPolicy: "on-request" | "when-ready" = "on-request") =>
    tasks.create({ id, title: id, prompt: "", repoId: null, startPolicy });
  const view = (id: string) => protocol.detail(id);
  const line = (id: string) => {
    const shown = view(id);
    const read = queryTasks(tasks, { key: id }, () => undefined).rows[0];
    expect(read?.waiting).toBe(shown.queueWait?.line);
    if (shown.queueWait) expect(taskStatusOf(shown).reason).toBe(shown.queueWait.line);
    return shown.queueWait;
  };
  return {
    db,
    protocol,
    tasks,
    create,
    view,
    line,
    now: () => at,
    tick: () => {
      at += 60_000;
    },
  };
}

describe("queued task wait facts (nightly audit finding 4)", () => {
  it("shares the first mate’s go and original time across reads, edits and restart", () => {
    const f = fixture();
    try {
      f.create("plan");
      const original = f.line("plan");
      expect(original).toMatchObject({ since: f.now() });
      expect(original?.line).toContain("Waiting for the first mate’s go");
      f.tick();
      f.tasks.updateFields("plan", { title: "Refined project plan" }, "firstmate");
      expect(f.line("plan")).toEqual(original);
      const restarted = new TaskService({ db: f.db, repos: { get: () => undefined }, now: f.now });
      expect(queryTasks(restarted, { key: "plan" }, () => undefined).rows[0]?.waiting).toBe(
        original?.line,
      );
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  it("dates placement once per kind, not once per reading, and removes the line after starting", () => {
    const f = fixture();
    try {
      f.create("build", "when-ready");
      f.tick();
      const since = f.now();
      f.tasks.setPlacementWait("build", {
        kind: "room",
        words: "Waiting for a computer with room",
      });
      expect(f.line("build")).toMatchObject({ since });
      f.tick();
      f.tasks.setPlacementWait("build", { kind: "room", words: "Waiting for room on Studio" });
      expect(f.line("build")).toMatchObject({ since });
      expect(f.line("build")?.line).toContain("Studio");
      f.tasks.setPlacementWait("build", {
        kind: "model",
        words: "Waiting for a computer with a model",
      });
      expect(f.line("build")).toMatchObject({ since: f.now() });
      f.tasks.dispatch("build", {
        workspace: { repoDir: "", worktreeDir: "", branch: "" },
        accountId: null,
        assignee: "crewmate",
      });
      expect(f.view("build").queueWait).toBeUndefined();
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  it("names every prerequisite, dates the relationship, and does not call a dropped prerequisite ready", () => {
    const f = fixture();
    try {
      const plan = f.create("plan");
      const design = f.create("design");
      f.create("build", "when-ready");
      f.tick();
      const since = f.now();
      f.tasks.link("plan", "build", "blocks", "firstmate");
      f.tick();
      f.tasks.link("design", "build", "blocks", "firstmate");
      expect(f.line("build")).toMatchObject({ since });
      expect(f.line("build")?.line).toContain(plan.key);
      expect(f.line("build")?.line).toContain(design.key);
      f.tasks.close("plan", { status: "dropped", reason: "cancelled", actor: "host" });
      expect(f.line("build")?.line).toContain(`${plan.key} (dropped)`);
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  it("dates only holding parts and dates the next wait when the final part finishes", () => {
    const f = fixture();
    try {
      const parent = f.create("parent");
      f.tick();
      f.tasks.create({
        id: "old-part",
        title: "Earlier part",
        prompt: "",
        repoId: parent.repoId,
        parentId: parent.id,
      });
      f.tasks.close("old-part", { status: "done", reason: "finished", actor: "host" });
      f.tick();
      f.tasks.create({
        id: "next-part",
        title: "Remaining part",
        prompt: "",
        repoId: parent.repoId,
        parentId: parent.id,
      });
      expect(f.line("parent")).toMatchObject({ since: f.now() });
      expect(f.line("parent")?.line).toContain("Waiting for its parts");
      f.tick();
      f.tasks.close("next-part", { status: "done", reason: "finished", actor: "host" });
      expect(f.line("parent")).toMatchObject({ since: f.now() });
      expect(f.line("parent")?.line).toContain("Waiting for the first mate’s go");
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });

  it("dates a new gate and its removal without resetting on unrelated changes", () => {
    const f = fixture();
    try {
      f.create("build", "when-ready");
      f.tick();
      const since = f.now();
      f.tasks.setGate("build", { kind: "at-time", until: since + 60_000 });
      expect(f.line("build")).toMatchObject({ since });
      expect(f.line("build")?.line).toContain("Waiting for its start time");
      f.tick();
      f.tasks.updateFields("build", { priority: 0 }, "firstmate");
      expect(f.line("build")?.since).toBe(since);
      f.tasks.setGate("build", {
        kind: "at-time",
        until: since + 60_000,
        reason: "Updated explanation",
      });
      expect(f.line("build")?.since).toBe(since);
      f.tasks.setGate("build", null);
      expect(f.line("build")?.since).toBe(f.now());
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });
  it("dates a released prerequisite and a failed preparation rather than using the filing time", () => {
    const f = fixture();
    try {
      f.create("plan");
      f.create("build");
      f.tasks.link("plan", "build", "blocks", "firstmate");
      f.tick();
      f.tasks.unlink("plan", "build", "blocks", "firstmate");
      expect(f.line("build")?.since).toBe(f.now());
      f.tasks.beginStartAttempt("build");
      expect(f.view("build").queueWait).toBeUndefined();
      expect(
        queryTasks(f.tasks, { key: "build" }, () => undefined).rows[0]?.waiting,
      ).toBeUndefined();
      f.tick();
      f.tasks.failManualStart("build", "The project folder could not be prepared");
      expect(f.view("build").queueWait?.since).toBe(f.now());
    } finally {
      f.protocol.dispose();
      f.db.close();
    }
  });
});
