import { checksSpanWords } from "@shared/checksSpan";
import { taskFactsOf } from "@shared/taskFacts";
import { describe, expect, it } from "vitest";
import { seedDelivery } from "../../../../../tests/helpers/taskDelivery";
import { RunWatcher } from "../../../orchestrator/runWatch";
import { WorkflowEvidenceService } from "../../../orchestrator/workflowEvidence";
import { openInMemoryDatabase } from "../../../storage/db";
import { seedTask } from "../../../tasks/seedTask";
import { TaskProtocol } from "../../../tasks/taskProtocol";
import { TaskService } from "../../../tasks/taskService";
import { GitHubWorkflows } from "./workflows";

/**
 * INF-594 (the captain: "we should try to display checks timing for adhoc
 * started workflow too"): a task that waits on a run it started by hand,
 * with no pull request, shows how long the run has gone in its Checks cell.
 * The run is GitHub's own answer for INF-508's release run 39361345555,
 * read at 11:25 PM Pacific on Oct 19 (actor and repository dropped).
 */
const RUN = {
  id: 39361345555,
  name: "release",
  head_branch: "main",
  head_sha: "217488a9d85f8ab067f7f1305b3472de66a1411b",
  path: ".github/workflows/release.yml",
  display_title: "release",
  run_number: 9,
  event: "workflow_dispatch",
  status: "queued",
  conclusion: null as string | null,
  html_url: "https://github.com/infinitary-labs/infinitary/actions/runs/39361345555",
  pull_requests: [],
  created_at: "2026-10-20T02:53:24Z",
  updated_at: "2026-10-20T05:13:29Z",
  run_attempt: 1,
  run_started_at: "2026-10-20T02:53:24Z",
};
/** Two of that run's 22 jobs as GitHub listed them: the Mac lane done, publishing queued. */
const JOBS = {
  total_count: 2,
  jobs: [
    {
      id: 118428222631,
      run_id: RUN.id,
      head_sha: RUN.head_sha,
      run_attempt: 1,
      name: "verify / mac",
      status: "completed",
      conclusion: "success",
      created_at: "2026-10-20T02:54:08Z",
      started_at: "2026-10-20T03:58:57Z",
      completed_at: "2026-10-20T05:13:29Z",
    },
    {
      id: 118467108608,
      run_id: RUN.id,
      head_sha: RUN.head_sha,
      run_attempt: 1,
      name: "Build, sign, notarize, and publish (a dry run publishes nothing)",
      status: "queued",
      conclusion: null,
      created_at: "2026-10-20T05:13:29Z",
      started_at: "2026-10-20T05:13:29Z",
      completed_at: null,
    },
  ],
};

function setup(run: () => typeof RUN) {
  const db = openInMemoryDatabase();
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', NULL, 'direct-pr', 0)",
  ).run("r1", "/fleet/infinitary", "infinitary", 1);
  let now = Date.parse("2026-10-20T06:00:00Z");
  const clock = () => now;
  const tasks = new TaskService({
    db,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: clock,
    strict: true,
  });
  tasks.projects.ensureForRepo({ id: "r1", name: "infinitary" });
  const protocol = new TaskProtocol({
    tasks,
    repos: {
      get: (id: string) =>
        id === "r1"
          ? { name: "infinitary", delivery: "direct-pr" as const, autonomy: false }
          : undefined,
    },
    cards: { listOpen: () => [], snapshot: () => [] },
    broadcastEvent: () => {},
    emit: () => {},
    now: clock,
    coalesceMs: 0,
  } as never);
  // The real run reader, answered as GitHub answers.
  const workflows = new GitHubWorkflows(
    () => "/repos/infinitary-labs/infinitary",
    async (path) => {
      if (path.endsWith(`/actions/runs/${RUN.id}`)) return run();
      if (path.includes(`/actions/runs/${RUN.id}/jobs`)) return JOBS;
      throw new Error(`unexpected ${path}`);
    },
    async () => new Uint8Array(),
  );
  const evidence = new WorkflowEvidenceService({
    tasks,
    repos: { get: () => ({ id: "r1", path: "/fleet/infinitary", name: "infinitary" }) } as never,
    forgeFor: () => ({ workflows }) as never,
    now: clock,
  });
  const watcher = new RunWatcher({
    tasks,
    inbox: { woken: () => false },
    read: (taskId, runId) => evidence.readWatched(taskId, runId),
    steer: async () => undefined,
  });
  seedTask(tasks, {
    id: "alpha",
    title: "Cut the next Infinitary alpha",
    repoId: "r1",
    status: "running",
    worktreeDir: "/fleet/wt/alpha",
    branch: "fm/task-alpha",
  });
  // No pull request yet: the last checks reading found none.
  seedDelivery(tasks, "alpha", { mode: "direct-pr", ci: "no-pr", ciAt: now });
  const checksWords = () => {
    const view = protocol.board().tasks.find((row) => row.id === "alpha");
    const checks = taskFactsOf(view as never, (m: string) => m).delivery?.checks;
    return checks?.span ? checksSpanWords(checks.words, checks.span, now) : (checks?.words ?? null);
  };
  return { tasks, evidence, watcher, checksWords, advance: (ms: number) => (now += ms), clock };
}

describe("checks timing for a hand-started run (INF-594)", () => {
  it("counts a watched run from the host's start, while it runs and after it passes", async () => {
    let run = { ...RUN };
    const { tasks, evidence, watcher, checksWords, advance, clock } = setup(() => run);
    await evidence.read("alpha", { runId: RUN.id });
    // GitHub started the run at 7:53:24 PM Pacific; at 11:00 PM that is 3h 06m.
    expect(checksWords()).toBe("running for 3h 06m");

    // The publish job ends the run; the watcher reads its end and stops watching.
    run = {
      ...RUN,
      status: "completed",
      conclusion: "success",
      updated_at: "2026-10-20T06:20:00Z",
    };
    advance(30 * 60_000);
    await watcher.poll(clock());
    expect(tasks.get("alpha")?.delivery?.runWatches ?? []).toEqual([]);
    expect(checksWords()).toBe("passed in 3h 26m");
  });

  it("says a failed run failed after its time, and a pull request's checks still win", async () => {
    const run = {
      ...RUN,
      status: "completed",
      conclusion: "failure",
      updated_at: "2026-10-20T03:10:24Z",
    };
    const { tasks, evidence, checksWords } = setup(() => run);
    // Arm the watch as a dispatch does, then the crewmate reads the outcome.
    evidence.watchStarted("alpha", RUN.id);
    await evidence.read("alpha", { runId: RUN.id });
    expect(checksWords()).toBe("failed after 17m");

    seedDelivery(tasks, "alpha", {
      prNumber: 999,
      changeLabel: "#999",
      prUrl: "https://github.com/infinitary-labs/infinitary/pull/999",
      ci: "pending",
      ciStartedAt: Date.parse("2026-10-20T05:50:00Z"),
    });
    expect(checksWords()).toBe("running for 10m");
  });
});
