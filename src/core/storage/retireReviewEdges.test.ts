import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { openDatabase, REVIEW_EDGES_VERSION } from "./db";

// INF-1876: the host holds nothing on a builder for its review, so the
// `blocks` edge an earlier release recorded from each host review onto its
// builder goes at the upgrade, and every other wait keeps its row and mark.

function service(db: ReturnType<typeof openDatabase>) {
  let now = 10_000;
  return new TaskService({ db, strict: true, now: () => (now += 1_000) });
}

describe("migration 107 (the review's edge, INF-1876)", () => {
  it("removes the host's review edges and keeps every other wait with its mark", () => {
    const dir = scratchDir("review-edges-");
    const before = openDatabase(dir, REVIEW_EDGES_VERSION - 1);
    const older = service(before);
    seedTask(older, { id: "builder", title: "Ship the meter", status: "idle" });
    seedTask(older, {
      id: "review",
      title: "Review: Ship the meter",
      status: "idle",
      parentId: "builder",
      shape: { kind: "review", kind_source: "host:review", basis: "builder" },
    });
    seedTask(older, {
      id: "earlier",
      title: "Review: Ship the meter",
      status: "completed",
      parentId: "builder",
      shape: { kind: "review", kind_source: "host:review", basis: "builder" },
    });
    seedTask(older, { id: "continue", title: "Continue: wire the gauge", status: "queued" });
    seedTask(older, { id: "prerequisite", title: "Rotate the key", status: "idle" });
    seedTask(older, { id: "finder", title: "Find the leak", status: "idle" });
    // The release before this one held the builder's close on its review.
    older.link("review", "builder", "blocks", "host", true);
    older.link("earlier", "builder", "blocks", "host", true);
    // A must-merge-first filing, a required action's prerequisite and a
    // wait the first mate recorded.
    older.link("continue", "builder", "blocks", "crewmate", true);
    older.link("prerequisite", "builder", "blocks", "host", true);
    older.link("finder", "builder", "blocks", "firstmate");
    older.close("earlier", { status: "done", reason: "finished", actor: "firstmate" });
    expect(older.blockersHoldingClose("builder").map((row) => row.id)).toEqual([
      "review",
      "continue",
      "prerequisite",
    ]);
    before.close();

    const upgraded = openDatabase(dir);
    const tasks = service(upgraded);
    expect(
      tasks
        .linksTo("builder")
        .filter((link) => link.type === "blocks")
        .map((link) => ({ from: link.fromId, actor: link.actor, holdsMerge: link.holdsMerge })),
    ).toEqual([
      { from: "continue", actor: "crewmate", holdsMerge: true },
      { from: "prerequisite", actor: "host", holdsMerge: true },
      { from: "finder", actor: "firstmate", holdsMerge: false },
    ]);
    expect(tasks.blockersHoldingClose("builder").map((row) => row.id)).toEqual([
      "continue",
      "prerequisite",
    ]);
    // The parent edge stays the one review-to-builder join: the live review
    // is still open, the closed one still done.
    expect(tasks.get("review")).toMatchObject({ parentId: "builder", status: "open" });
    expect(tasks.get("earlier")).toMatchObject({ parentId: "builder", status: "done" });
    upgraded.close();
  });
});
