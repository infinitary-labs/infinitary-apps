import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "./seedTask";
import { TaskProtocol } from "./taskProtocol";
import { TaskService } from "./taskService";
import { taskWaitsOf } from "./taskWaits";

// INF-2197 item 3 / INF-2215: all standing waits, no inferred deadlines or historical declarations.
describe("approved desktop task wait projection", () => {
  it("keeps simultaneous current watches, a held dependency and an owned job with their own events", () => {
    const db = openInMemoryDatabase();
    try {
      const tasks = new TaskService({ db, strict: true, now: () => 1_000_000 });
      seedTask(tasks, {
        id: "owner",
        title: "Build the website",
        status: "queued",
        startPolicy: "on-request",
      });
      seedTask(tasks, { id: "work", title: "Publish the website", status: "completed" });
      tasks.recordReport("work", {
        text: "Waiting for the website build.",
        declared: { checkBack: { minutes: 5, waitingFor: "Website build" } },
      });
      seedDelivery(tasks, "work", {
        headSha: "website-head",
        ciWatch: { head: "website-head", since: 900000, nextAt: 1060000, tries: 1 },
        runWatches: [
          { runId: 42, attempt: 1, name: "Website checks", since: 950000, nextAt: 1120000 },
        ],
      });
      const owner = mustTask(tasks, "owner");
      const waits = taskWaitsOf({
        record: mustTask(tasks, "work"),
        holding: [owner],
        since: { [owner.key]: 960000 },
        decision: false,
        facts: {
          job: true,
          timerOwned: true,
          hold: { class: "no_headroom", provider: "Codex", resetsAt: 1600000 },
        },
      });
      expect(waits.map((wait) => [wait.kind, wait.next?.kind, wait.next?.at])).toEqual([
        ["dependency", undefined, undefined],
        ["checks", "next-read", 1060000],
        ["run", "next-read", 1120000],
        ["job", "check-back", 1300000],
        ["allowance", "reset", 1600000],
      ]);
      expect(waits[0]).toMatchObject({ taskKeys: [owner.key], since: 960000 });
      expect(waits.find((wait) => wait.kind === "job")?.label).toBe("Website build");
    } finally {
      db.close();
    }
  });

  it("does not turn an unowned timer, an old check-back or a stale head into a promise", () => {
    const db = openInMemoryDatabase();
    try {
      const tasks = new TaskService({ db, strict: true, now: () => 1_000_000 });
      seedTask(tasks, { id: "work", title: "Wait for the build", status: "completed" });
      tasks.recordReport("work", {
        text: "Look again later.",
        declared: { checkBack: { minutes: 5, waitingFor: "Build" } },
      });
      seedDelivery(tasks, "work", {
        headSha: "new-head",
        ciWatch: { head: "old-head", since: 900000, nextAt: 1060000, tries: 1 },
      });
      const project = () =>
        taskWaitsOf({
          record: mustTask(tasks, "work"),
          holding: [],
          since: {},
          decision: false,
          facts: { job: false, timerOwned: false },
        });
      expect(project()).toEqual([]);
      tasks.setGate("work", null);
      expect(project()).toEqual([]);
      const job = taskWaitsOf({
        record: mustTask(tasks, "work"),
        holding: [],
        since: {},
        decision: false,
        facts: { job: true, timerOwned: false },
      });
      expect(job).toEqual([{ id: "job", kind: "job", label: "Background work" }]);
      tasks.setGate("work", { kind: "captain" });
      seedDelivery(tasks, "work", { captainWait: { at: 1000000, reason: "Review the build" } });
      const active = taskWaitsOf({
        record: mustTask(tasks, "work"),
        holding: [],
        since: {},
        decision: false,
        posture: { state: "active", reason: "checks" },
      });
      expect(active.some((wait) => wait.kind === "decision")).toBe(false);
      const paused = taskWaitsOf({
        record: mustTask(tasks, "work"),
        holding: [],
        since: {},
        decision: false,
        posture: { state: "idle", reason: "captain" },
      });
      expect(paused.map((wait) => wait.kind)).toEqual(["decision"]);
      tasks.close("work", { status: "done", reason: "finished", actor: "host" });
      expect(project()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("records a gate time without inferring an allowance reset, and keeps Backlog waiting for Start", () => {
    const db = openInMemoryDatabase();
    try {
      let now = 1_000_000;
      const tasks = new TaskService({ db, strict: true, now: () => now });
      seedTask(tasks, {
        id: "work",
        title: "Publish after review",
        status: "queued",
        startPolicy: "on-request",
        gate: { kind: "at-time", until: 1300000 },
      });
      const project = () =>
        taskWaitsOf({ record: mustTask(tasks, "work"), holding: [], since: {}, decision: false });
      expect(project().map((wait) => [wait.kind, wait.next])).toEqual([
        ["start", { kind: "start", at: 1300000 }],
        ["backlog", undefined],
      ]);
      // INF-2215 retains each source's recorded-since time, never a creation-time guess.
      expect(project().find((wait) => wait.kind === "backlog")?.since).toBeUndefined();
      now = 1_010_000;
      expect(tasks.setQueued("work", "queue-task", { actor: "captain" })).toEqual({
        ok: true,
        changed: true,
      });
      const policyAt = 1_020_000;
      now = policyAt;
      expect(tasks.setQueued("work", "unqueue-task", { actor: "captain" })).toEqual({
        ok: true,
        changed: true,
      });
      expect(project().find((wait) => wait.kind === "backlog")?.since).toBe(policyAt);
      tasks.setGate("work", { kind: "quota-reset", ref: "openai-codex" });
      expect(project().find((wait) => wait.kind === "allowance")?.next).toBeUndefined();
      seedTask(tasks, { id: "parked", title: "Keep the website work", status: "completed" });
      tasks.recordReport("parked", {
        text: "The build continues.",
        declared: { checkBack: { minutes: 5, waitingFor: "Website build" } },
      });
      tasks.setQueued("parked", "unqueue-task", { actor: "captain" });
      const parked = taskWaitsOf({
        record: mustTask(tasks, "parked"),
        holding: [],
        since: {},
        decision: false,
        facts: { job: true, timerOwned: true },
      });
      expect(parked.find((wait) => wait.kind === "backlog")?.label).toBe("Waiting for Start");
      expect(parked.every((wait) => wait.next === undefined)).toBe(true);
    } finally {
      db.close();
    }
  });
});

// INF-2186 is the approved shared-read seam: adding waits must not introduce per-row reads.
it("publishes fresh dependency waits from the cached graph and retains untouched row identities", () => {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true, now: () => 1_000_000 });
  let reads = 0;
  const protocol = new TaskProtocol({
    tasks,
    repos: { get: () => undefined },
    cards: { listOpen: () => [], snapshot: () => [] },
    broadcastEvent: () => {},
    emit: () => {},
    waitFacts: () => {
      reads++;
      return { job: false, timerOwned: false };
    },
    workPosture: () => ({ state: "active", reason: "turn" }),
  });
  try {
    seedTask(tasks, {
      id: "owner",
      title: "Build website",
      status: "queued",
      startPolicy: "on-request",
    });
    seedTask(tasks, { id: "work", title: "Publish website", status: "completed" });
    seedTask(tasks, { id: "other", title: "Read release notes", status: "completed" });
    tasks.link("owner", "work", "blocks", "crewmate", true);
    const first = protocol.board();
    const kept = first.tasks.find((row) => row.id === "other");
    expect(first.tasks.find((row) => row.id === "work")?.waits?.[0]?.kind).toBe("dependency");
    reads = 0;
    for (let i = 0; i < 40; i++) expect(protocol.board().tasks).toBe(first.tasks);
    expect(reads).toBe(0);
    tasks.close("owner", { status: "done", reason: "finished", actor: "host" });
    const next = protocol.board();
    expect(next.tasks.find((row) => row.id === "work")?.waits).toEqual([]);
    expect(next.tasks.find((row) => row.id === "other")).toBe(kept);
  } finally {
    protocol.dispose();
    db.close();
  }
});

function mustTask(tasks: TaskService, id: string) {
  const record = tasks.get(id);
  if (!record) throw new Error(`Missing task ${id}`);
  return record;
}
