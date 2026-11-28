import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { openInMemoryDatabase } from "../storage/db";
import { seedProject } from "../workspace/seedProject";
import { queryTasks } from "./taskQuery";
import { TaskService } from "./taskService";

function setup() {
  const db = openInMemoryDatabase();
  seedProject(db, {
    id: "r1",
    name: "nimbus-api",
    path: "/fleet/nimbus-api",
    delivery: "direct-pr",
    addedAt: 1,
  });
  const tasks = new TaskService({
    db,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: () => 1_000,
    strict: true,
  });
  const work = (id: string, extra: Partial<Parameters<TaskService["create"]>[0]> = {}) =>
    tasks.create({ id, title: id.toUpperCase(), prompt: "p", repoId: null, ...extra });
  return { tasks, work };
}

// The captain's merge click, spent by the merge it allowed.
const approveConsumed = (tasks: TaskService, id: string) =>
  seedDelivery(tasks, id, {
    mergeAuthorization: {
      version: 1,
      id: `approval-${id}`,
      generation: 1,
      issuer: "captain",
      at: 1,
      card: { id: "merge-card", offerId: "offer-1", actionId: "merge" },
      target: {
        repoId: "r1",
        host: "github.com",
        owner: "example",
        name: "nimbus-api",
        branch: "inf/first-part-a1b2",
        delivery: "direct-pr",
        method: "squash",
      },
      approvedHead: "0f3c9a1e4b7d2c6a8e5f1b3d9c7a2e4f6b8d0c1a",
      proceedWithOpen: false,
      status: "consumed",
      lineage: [],
    },
  });

describe("a side-effect task whose moment is the release", () => {
  // INF-7198 part 1, the captain's "Approve and build": a release-moment side-effect task
  // starts only once each merged wait has a recorded first release, never at the merge,
  // and says on its queue line which work it waits for to ship.
  it("starts a release-moment side-effect task only once each merged wait has a first release", () => {
    const { tasks, work } = setup();
    const inProject = { repoId: "r1", startPolicy: "on-request" } as const;
    const fix = work("fix", inProject);
    const answer = work("answer", {
      ...inProject,
      shape: { kind: "research", deliverable: "answer" },
    });
    const waits = { repoId: "r1", blockedBy: ["fix", "answer"] };
    work("reply", {
      ...waits,
      shape: { kind: "implement", side_effect: true, side_effect_moment: "release" },
    });
    work("at-merge", {
      ...waits,
      shape: { kind: "implement", side_effect: true, side_effect_moment: "merge" },
    });
    work("unset", { ...waits, shape: { kind: "implement", side_effect: true } });
    tasks.close(fix.id, { status: "done", reason: "merged", actor: "host" });
    tasks.close(answer.id, { status: "done", reason: "answered", actor: "captain" });

    const ready = () =>
      tasks.graph
        .listReady()
        .map((r) => r.id)
        .sort();
    expect(ready()).toEqual(["at-merge", "unset"]);
    expect(tasks.graph.waitingOn("reply").map((r) => r.id)).toEqual(["fix"]);
    expect(tasks.graph.flagsOf(tasks.get("reply")!)).toMatchObject({
      blocked: true,
      ready: false,
      deadBlocker: false,
    });
    const reply = tasks.get("reply")!;
    expect(queryTasks(tasks, { key: reply.key }).rows[0]?.waiting).toMatch(
      new RegExp(`^Waiting for ${fix.key} to ship in a release · since `),
    );

    const check = work("release-check", { repoId: "r1", startPolicy: "on-request" });
    tasks.delivery.recordFirstRelease(check.id, {
      version: "1.4.0",
      url: "https://example.com/releases/1.4.0",
      evidence: "The 1.4.0 tag holds the fix's merge commit.",
      tasks: [fix.key],
    });
    expect(ready()).toEqual(["at-merge", "reply", "unset"]);
    expect(tasks.graph.waitingOn("reply")).toEqual([]);
  });

  // INF-7216 review: the recorder takes every merge the release hold waits on,
  // so no merged wait can hold a release-moment task for good.
  it("records a first release for a wait merged by the captain's approval, whatever its close", () => {
    const { tasks, work } = setup();
    const fix = work("fix", { repoId: "r1", startPolicy: "on-request" });
    work("reply", {
      repoId: "r1",
      blockedBy: ["fix"],
      shape: { kind: "implement", side_effect: true, side_effect_moment: "release" },
    });
    approveConsumed(tasks, fix.id);
    tasks.close(fix.id, { status: "done", reason: "finished", actor: "firstmate" });
    expect(tasks.graph.waitingOn("reply").map((r) => r.id)).toEqual(["fix"]);

    const check = work("release-check", { repoId: "r1", startPolicy: "on-request" });
    tasks.delivery.recordFirstRelease(check.id, {
      version: "1.4.0",
      url: "https://example.com/releases/1.4.0",
      evidence: "The 1.4.0 tag holds the fix's merge commit.",
      tasks: [fix.key],
    });
    expect(tasks.graph.waitingOn("reply")).toEqual([]);
    expect(tasks.graph.listReady().map((r) => r.id)).toContain("reply");
  });

  // INF-7238 review, from the approved plan's INF-6932 row: a parent the host closes finished
  // when its last part merges holds its release-moment waiter on that part's release.
  it("holds a release-moment task on a finished parent's merged part, naming the part", () => {
    const { tasks, work } = setup();
    const parent = work("parent", { repoId: "r1", startPolicy: "on-request" });
    const part = work("part", { repoId: "r1", startPolicy: "on-request", parentId: parent.id });
    work("reply", {
      repoId: "r1",
      blockedBy: ["parent"],
      shape: { kind: "implement", side_effect: true, side_effect_moment: "release" },
    });
    tasks.close(part.id, { status: "done", reason: "merged", actor: "host" });
    tasks.close(parent.id, { status: "done", reason: "finished", actor: "host" });

    expect(tasks.graph.listReady().map((r) => r.id)).not.toContain("reply");
    expect(tasks.graph.waitingOn("reply").map((r) => r.id)).toEqual(["part"]);
    const reply = tasks.get("reply")!;
    expect(queryTasks(tasks, { key: reply.key }).rows[0]?.waiting).toMatch(
      new RegExp(`^Waiting for ${part.key} to ship in a release · since `),
    );

    const check = work("release-check", { repoId: "r1", startPolicy: "on-request" });
    tasks.delivery.recordFirstRelease(check.id, {
      version: "1.4.0",
      url: "https://example.com/releases/1.4.0",
      evidence: "The 1.4.0 tag holds the part's merge commit.",
      tasks: [part.key],
    });
    expect(tasks.graph.waitingOn("reply")).toEqual([]);
    expect(tasks.graph.listReady().map((r) => r.id)).toContain("reply");
  });
});
