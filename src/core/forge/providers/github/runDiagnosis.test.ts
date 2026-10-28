import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../../../tests/helpers/taskDelivery";
import { GithubGatewayService } from "../../../orchestrator/githubGateway";
import { PrCiService } from "../../../orchestrator/prCi";
import { RunWatcher } from "../../../orchestrator/runWatch";
import { WorkflowEvidenceService } from "../../../orchestrator/workflowEvidence";
import { CHECK_CHANGE_TOOL, GITHUB_WRITE_TOOL, READ_WORKFLOW_TOOL } from "../../../pi/forgeTools";
import { bindTool } from "../../../session/tools";
import { openInMemoryDatabase } from "../../../storage/db";
import { standingDependencyWaits } from "../../../tasks/dependencyWaits";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { RepoRegistry } from "../../../workspace/repoRegistry";
import { GitHubForge } from "./githubForge";

/**
 * INF-688, filed from INF-621: a crewmate read verify run 39510653486's
 * failed linux-checks job with read_workflow, had comparison evidence and
 * the captain's word for the one flake rerun, and check_change refused the
 * diagnosis because no failing head/check was observed: the task had no
 * pull request yet. The run and its jobs are GitHub's own answers for that
 * run, read on Oct 20 (actors, repository, links and passing steps
 * dropped; a failed job keeps its failed step).
 */
const PROJECT = "/repos/infinitary-labs/infinitary";
const HEAD = "1be6e0b44b5c0d86955f426824d7f64473456680";
const RUN_ID = 39510653486;
const LINUX_CHECKS = 118930546406;

const run = (attempt: 1 | 2, ended: boolean) => ({
  id: RUN_ID,
  name: "verify",
  head_branch: "fm/task-438d43ea",
  head_sha: HEAD,
  path: ".github/workflows/verify.yml",
  run_number: 21,
  event: "workflow_dispatch",
  status: ended ? "completed" : "in_progress",
  conclusion: ended ? "failure" : null,
  html_url: `https://github.com/infinitary-labs/infinitary/actions/runs/${RUN_ID}`,
  created_at: "2026-10-20T22:47:43Z",
  run_attempt: attempt,
  run_started_at: attempt === 1 ? "2026-10-20T22:47:43Z" : "2026-10-20T23:44:12Z",
  updated_at: attempt === 1 ? "2026-10-20T23:42:32Z" : "2026-10-20T23:54:19Z",
});

const job = (
  id: number,
  name: string,
  attempt: 1 | 2,
  conclusion: "success" | "failure" | null,
  failedStep?: [number, string],
) => ({
  id,
  run_id: RUN_ID,
  head_sha: HEAD,
  run_attempt: attempt,
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  ...(failedStep
    ? {
        steps: [{ name: failedStep[1], number: failedStep[0], status: "completed", conclusion }],
      }
    : {}),
});

const SHARDS = ["desktop 1/4", "desktop 2/4", "desktop 3/4", "desktop 4/4"]
  .concat(["parallel 1/4", "parallel 2/4", "parallel 3/4", "parallel 4/4"])
  .map((shard) => `linux-e2e / journeys (${shard})`);
const FIRST_SHARD_IDS = [
  118930546682, 118930546212, 118930546594, 118930546669, 118930546670, 118930546609, 118930546885,
  118930546702,
];
const SECOND_SHARD_IDS = [
  118951255095, 118951255217, 118951254745, 118951254996, 118951253645, 118951300084, 118951254706,
  118951254819,
];

/** Attempt 1 as GitHub listed it once the run ended: the Mac and Linux checks jobs failed. */
const ATTEMPT_1 = [
  job(118930545965, "mac", 1, "failure", [16, "Run pnpm test:e2e"]),
  job(LINUX_CHECKS, "linux-checks", 1, "failure", [12, "Run pnpm test"]),
  ...SHARDS.map((name, i) => job(FIRST_SHARD_IDS[i] as number, name, 1, "success")),
];
/**
 * Attempt 2, the rerun of the Linux checks job, as GitHub listed it once it
 * ended (the job failed again). While the rerun ran, from 23:44:55 to
 * 23:54:18 UTC, GitHub listed the same jobs with that one still in progress.
 */
const attempt2 = (ended: boolean) => [
  job(118951252336, "linux-checks", 2, ended ? "failure" : null, [12, "Run pnpm test"]),
  job(118951297331, "mac", 2, "failure", [16, "Run pnpm test:e2e"]),
  ...SHARDS.map((name, i) => job(SECOND_SHARD_IDS[i] as number, name, 2, "success")),
];

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** GitHub as the run stood: `answer` moves the run and its latest jobs between reads. */
async function setup(delivery: "direct-pr" | "local-only" = "direct-pr") {
  let answer = { run: run(1, true), jobs: ATTEMPT_1 };
  const sent: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const url = new URL(req.url ?? "/", "http://stand-in");
    sent.push(`${req.method} ${url.pathname}`);
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "GET" && url.pathname === `${PROJECT}/actions/runs/${RUN_ID}`)
      json(answer.run);
    else if (req.method === "GET" && url.pathname === `${PROJECT}/actions/runs/${RUN_ID}/jobs`)
      json({ total_count: answer.jobs.length, jobs: answer.jobs });
    else if (req.method === "GET" && url.pathname === `${PROJECT}/actions/jobs/${LINUX_CHECKS}`)
      json(ATTEMPT_1[1]);
    // GitHub answers an accepted job or failed-jobs rerun with 201 and an empty object.
    else if (
      req.method === "POST" &&
      (url.pathname === `${PROJECT}/actions/jobs/${LINUX_CHECKS}/rerun` ||
        url.pathname === `${PROJECT}/actions/runs/39485590404/rerun-failed-jobs`)
    )
      json({}, 201);
    else json({ message: "Not Found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const dir = scratchDir("fm-run-diagnosis-");
  const forge = new GitHubForge(
    { kind: "github", host: "github.com", owner: "infinitary-labs", name: "infinitary", dir },
    {
      apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: async () => "gho_fixture_owned_by_app",
    },
  );
  const db = openInMemoryDatabase();
  cleanup.push(() => {
    db.close();
  });
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, origin, delivery) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("r1", dir, "infinitary", 1, "https://github.com/infinitary-labs/infinitary.git", delivery);
  // The rerun went out at 4:44 PM Pacific, just before GitHub started its second attempt.
  let now = Date.parse("2026-10-20T23:44:00Z");
  const clock = () => now;
  const tasks = new TaskService({ db, strict: true, now: clock });
  tasks.projects.ensureForRepo({ id: "r1", name: "infinitary" });
  seedTask(tasks, {
    id: "proof",
    title: "Prove every project's Mac jobs in a virtual Mac",
    repoId: "r1",
    status: "running",
    worktreeDir: dir,
    branch: "fm/task-438d43ea",
  });
  const repos = new RepoRegistry(db, join(dir, "fleet"));
  const evidence = new WorkflowEvidenceService({
    tasks,
    repos,
    forgeFor: () => forge,
    now: clock,
  });
  const prCi = new PrCiService({ tasks, repos, forgeFor: () => forge, now: clock });
  const gateway = new GithubGatewayService({
    tasks,
    repos,
    forgeFor: () => forge,
    readChecks: (taskId) => prCi.checkForCrew(taskId),
    watchRun: (taskId, runId) => evidence.watchStarted(taskId, runId),
    now: clock,
    sleep: async () => {},
  });
  const watcher = new RunWatcher({
    tasks,
    inbox: { woken: () => false },
    read: (taskId, runId) => evidence.readWatched(taskId, runId),
    steer: async () => undefined,
  });
  // The crewmate's own tools, as its session binds them.
  const readWorkflow = bindTool(READ_WORKFLOW_TOOL, {
    onReadWorkflow: (input) => evidence.read("proof", input),
  });
  const checkChange = bindTool(CHECK_CHANGE_TOOL, {
    onCheckChange: (input) => prCi.checkForCrew("proof", input),
  });
  const githubWrite = bindTool(GITHUB_WRITE_TOOL, {
    onGithubWrite: (input) => gateway.write("proof", input),
  });
  return {
    tasks,
    sent,
    readWorkflow: async (runId: number) => (await readWorkflow.run({ runId })).text,
    checkChange: async (input: Parameters<typeof checkChange.run>[0]) =>
      (await checkChange.run(input)).text,
    githubWrite: async (path: string) => (await githubWrite.run({ method: "POST", path })).text,
    /** The run watch's minute reading at `at`, after GitHub moved the run to `next`. */
    watchReads: async (at: string, next: typeof answer) => {
      answer = next;
      now = Date.parse(at);
      await watcher.poll(now);
    },
    /** GitHub moved the run on: the crewmate's next read sees `next`. */
    githubShows: (next: typeof answer) => {
      answer = next;
    },
    ledger: () => tasks.get("proof")?.delivery?.ciRepair,
  };
}

const FLAKE = {
  headSha: HEAD,
  check: "linux-checks",
  classification: "suspected-flake" as const,
  evidence:
    "Run pnpm test timed out in claudeSession.contract.integration.test.ts while 9,083 other tests passed; INF-653's untouched-main comparison passed the same case",
  changedTest: false,
};
const RESERVE = {
  headSha: HEAD,
  check: "linux-checks",
  evidence: "One rerun of the timed-out Linux checks job, as the captain asked",
};

describe("a workflow run read without a pull request (INF-688)", () => {
  it.each(["direct-pr", "local-only"] as const)(
    "takes the read job's flake diagnosis and one rerun on a %s project, dated by that job's rerun",
    async (delivery) => {
      const f = await setup(delivery);

      // The crewmate reads the ended run and sees its Linux checks job failed.
      const read = await f.readWorkflow(RUN_ID);
      expect(read).toContain(`version: ${HEAD}`);
      expect(read).toContain(`${LINUX_CHECKS} linux-checks — completed, failure`);

      // Its diagnosis and reservation need no pull request.
      expect(await f.checkChange({ diagnosis: FLAKE })).toContain(
        "Diagnosis recorded with evidence.",
      );
      const reserved = await f.checkChange({ rerun: RESERVE });
      expect(reserved).toContain("Crew check declaration recorded with evidence.");
      expect(f.ledger()?.rerun).toEqual({ ...RESERVE, runId: RUN_ID });

      // The job's own rerun dates the reservation through the job's run, and the app watches the run.
      const rerun = await f.githubWrite(`${PROJECT}/actions/jobs/${LINUX_CHECKS}/rerun`);
      expect(rerun).toContain('"status": 201');
      expect(rerun).toContain(`The app watches run ${RUN_ID}`);
      expect(f.sent).toContain(`GET ${PROJECT}/actions/jobs/${LINUX_CHECKS}`);
      expect(f.ledger()?.rerun?.startedAt).toBe(Date.parse("2026-10-20T23:44:00Z"));

      // While the rerun runs, the watch no longer lists the job; once it fails again, it does.
      await f.watchReads("2026-10-20T23:50:00Z", { run: run(2, false), jobs: attempt2(false) });
      expect(f.ledger()?.runs).toEqual([
        { runId: RUN_ID, headSha: HEAD, attempt: 2, failed: ["mac"] },
      ]);
      await f.watchReads("2026-10-20T23:55:00Z", { run: run(2, true), jobs: attempt2(true) });
      expect(f.ledger()?.runs).toEqual([
        { runId: RUN_ID, headSha: HEAD, attempt: 2, failed: ["linux-checks", "mac"] },
      ]);

      // A failed rerun is diagnosis, not another rerun.
      expect(await f.checkChange({ rerun: RESERVE })).toContain(
        "Crew check declaration recorded with evidence.",
      );
    },
  );

  it("records an evidenced diagnosis without deciding its attribution (INF-1177)", async () => {
    const f = await setup();
    await f.readWorkflow(RUN_ID);
    expect(
      await f.checkChange({ diagnosis: { ...FLAKE, check: "linux-e2e / journeys (desktop 1/4)" } }),
    ).toContain("Diagnosis recorded with evidence.");
  });

  it("records a new rerun judgment without imposing a host allowance (INF-1177)", async () => {
    const f = await setup();
    await f.readWorkflow(RUN_ID);
    await f.checkChange({ diagnosis: FLAKE });
    // Someone else already started the rerun; the crewmate's next read shows it running.
    f.githubShows({ run: run(2, false), jobs: attempt2(false) });
    expect(await f.readWorkflow(RUN_ID)).toContain("linux-checks — in_progress");
    expect(await f.checkChange({ rerun: RESERVE })).toContain(
      "Crew check declaration recorded with evidence.",
    );
    expect(f.ledger()?.rerun).toMatchObject(RESERVE);
  });

  it("leaves a run's reservation undated when another run is rerun", async () => {
    const f = await setup();
    await f.readWorkflow(RUN_ID);
    await f.checkChange({ diagnosis: FLAKE });
    await f.checkChange({ rerun: RESERVE });
    expect(await f.githubWrite(`${PROJECT}/actions/runs/39485590404/rerun-failed-jobs`)).toContain(
      '"status": 201',
    );
    expect(f.ledger()?.rerun).toEqual({ ...RESERVE, runId: RUN_ID });
  });

  /** A baseline wait on the Linux checks job, declared at the run's version; answers the waits. */
  async function waitOnBaseline(f: Awaited<ReturnType<typeof setup>>) {
    const owner = seedTask(f.tasks, {
      id: "linux-baseline",
      title: "Fix the Linux unit timeouts on main",
      repoId: "r1",
      status: "running",
      worktreeDir: "/unused",
      branch: "fm/task-linux-baseline",
    });
    await f.readWorkflow(RUN_ID);
    const answer = await f.checkChange({
      diagnosis: {
        ...FLAKE,
        classification: "baseline-blocked",
        evidence: "The same timeout fails on untouched main; the owner reproduced it",
        dependencyTask: owner.id,
      },
    });
    // The answer's promise to resume the crewmate holds: the wait stands.
    expect(answer).toContain("is underway: report the wait once and end your turn");
    const waits = () =>
      standingDependencyWaits(f.tasks, f.tasks.get("proof")?.delivery).map((w) => w.task.id);
    expect(waits()).toEqual([owner.id]);
    return waits;
  }

  it("keeps a run's baseline wait standing until a newer reading of the run drops the failure", async () => {
    const f = await setup();
    const waits = await waitOnBaseline(f);
    f.githubShows({ run: run(2, false), jobs: attempt2(false) });
    await f.readWorkflow(RUN_ID);
    expect(waits()).toEqual([]);
  });

  it("ends what the run showed once the change has a newer pull request version", async () => {
    // The crewmate brought the branch up to date with main and opened its pull request there.
    const moveOn = (f: Awaited<ReturnType<typeof setup>>) =>
      seedDelivery(f.tasks, "proof", {
        prNumber: 774,
        headSha: "9b74a0b056330f847f21a1af531132e6eb1a0441",
        ci: "pending",
      });
    const waiting = await setup();
    const waits = await waitOnBaseline(waiting);
    moveOn(waiting);
    expect(waits()).toEqual([]);

    const flaky = await setup();
    await flaky.readWorkflow(RUN_ID);
    await flaky.checkChange({ diagnosis: FLAKE });
    moveOn(flaky);
    expect(await flaky.checkChange({ rerun: RESERVE })).toContain(
      "Crew check declaration recorded with evidence.",
    );
  });
});
