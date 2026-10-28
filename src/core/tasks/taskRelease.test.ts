import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { seedTask } from "./seedTask";
import { queryTasks } from "./taskQuery";
import { TaskService } from "./taskService";

// INF-1607: answer where merged work first shipped, without guessing from merge time.
const release = {
  version: "0.6.0-alpha.1",
  url: "https://github.com/infinitary-labs/infinitary/releases/tag/v0.6.0-alpha.1",
  evidence: "Published source contains these merges, absent from every earlier published source.",
};
function setup() {
  const db = freshDatabase();
  const tasks = new TaskService({ db });
  tasks.projects.ensureForRepo({ id: "project", name: "Infinitary" });
  tasks.projects.ensureForRepo({ id: "other", name: "Other project" });
  for (const id of ["reporter", "fix", "internal", "open", "answered", "other-project"]) {
    seedTask(tasks, {
      id,
      title: id,
      repoId: id === "other-project" ? "other" : "project",
      status: "idle",
    });
    if (id === "reporter" || id === "open") continue;
    tasks.close(id, {
      status: "done",
      reason: id === "answered" ? "answered" : "merged",
      actor: "captain",
      delivery: { mergedSha: "a".repeat(40) },
    });
  }
  return { db, tasks };
}
function read(tasks: TaskService, key: string) {
  return queryTasks(tasks, { key }).rows[0];
}

describe("first-release reports (INF-1607)", () => {
  it("lets a release verifier collect every merged task beyond one query page before recording", () => {
    const { db, tasks } = setup();
    try {
      for (let index = 0; index < 105; index += 1) {
        const id = `fix-${index}`;
        seedTask(tasks, { id, title: id, repoId: "project", status: "idle" });
        tasks.close(id, { status: "done", reason: "merged", actor: "captain" });
      }
      const first = queryTasks(tasks, { status: "done", limit: 100 });
      const next = queryTasks(tasks, { status: "done", limit: 100, skip: first.rows.length });
      const ids = [...first.rows, ...next.rows].map((row) => row.task_id);
      expect(ids).toHaveLength(first.total);
      expect(new Set(ids).size).toBe(first.total);
      expect(ids).toContain("fix-104");
    } finally {
      db.close();
    }
  });

  it("records a batch, persists it, and keeps the earliest attribution through later release reports", () => {
    const { db, tasks } = setup();
    try {
      expect(read(tasks, "fix")?.first_release).toBeNull();
      expect(read(tasks, "fix")?.merge_commit).toBe("a".repeat(40));
      expect(
        tasks.recordFirstRelease("reporter", { ...release, tasks: ["fix", "internal", "fix"] }),
      ).toBe(2);
      const reopened = new TaskService({ db });
      expect(read(reopened, "fix")?.first_release).toEqual(release);
      expect(read(reopened, "internal")?.first_release).toEqual(release);
      const count = reopened.timeline("fix").length;
      expect(reopened.recordFirstRelease("reporter", { ...release, tasks: ["fix"] })).toBe(0);
      expect(
        reopened.recordFirstRelease("reporter", { ...release, version: "0.6.0", tasks: ["fix"] }),
      ).toBe(0);
      expect(reopened.timeline("fix")).toHaveLength(count);
      expect(read(reopened, "fix")?.first_release).toEqual(release);
      const correction = {
        ...release,
        version: "0.5.0",
        evidence: "Recovered earlier published source proves the merge was already included.",
      };
      expect(
        reopened.recordFirstRelease("reporter", {
          ...correction,
          tasks: ["fix"],
          corrects: release.version,
        }),
      ).toBe(1);
      expect(read(reopened, "fix")?.first_release).toEqual(correction);
      expect(reopened.timeline("fix").at(-1)?.data).toMatchObject({
        firstRelease: correction,
        previousFirstRelease: release,
        reportedBy: "reporter",
      });
      expect(reopened.get("fix")?.status).toBe("done");
    } finally {
      db.close();
    }
  });

  it("refuses the entire batch for unknown, unmerged, cross-project, malformed or stale correction facts", () => {
    const { db, tasks } = setup();
    try {
      for (const id of ["missing", "open", "answered", "other-project"]) {
        expect(() =>
          tasks.recordFirstRelease("reporter", { ...release, tasks: ["fix", id] }),
        ).toThrow();
        expect(read(tasks, "fix")?.first_release).toBeNull();
      }
      for (const invalid of [
        { ...release, evidence: " " },
        { ...release, url: "unknown" },
      ])
        expect(() =>
          tasks.recordFirstRelease("reporter", { ...invalid, tasks: ["fix"] }),
        ).toThrow();
      tasks.recordFirstRelease("reporter", { ...release, tasks: ["fix"] });
      expect(() =>
        tasks.recordFirstRelease("reporter", {
          ...release,
          tasks: ["internal", "fix"],
          corrects: "0.4.0",
        }),
      ).toThrow("no longer records");
      expect(read(tasks, "internal")?.first_release).toBeNull();
      expect(read(tasks, "fix")?.first_release).toEqual(release);
    } finally {
      db.close();
    }
  });
});
