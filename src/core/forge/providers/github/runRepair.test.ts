import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../../../tests/helpers/scratchDirs";
import { PrCiService } from "../../../orchestrator/prCi";
import { WorkflowEvidenceService } from "../../../orchestrator/workflowEvidence";
import { CHECK_CHANGE_TOOL, READ_WORKFLOW_TOOL } from "../../../pi/forgeTools";
import { bindTool } from "../../../session/tools";
import { openInMemoryDatabase } from "../../../storage/db";
import { seedTask } from "../../../tasks/seedTask";
import { TaskService } from "../../../tasks/taskService";
import { RepoRegistry } from "../../../workspace/repoRegistry";
import { GitHubForge } from "./githubForge";

/**
 * INF-970, filed from INF-886: a crewmate repaired its phone gate on a branch
 * with no pull request yet. It read each failed phone run with read_workflow
 * and declared each repair with check_change, which answered no-pr: no
 * reading settled a repair, so the next one was refused because the last had
 * no result. The runs, jobs and check runs are GitHub's own answers for that
 * branch's versions, read on Oct 22 (actors, repository, app, output and
 * links dropped; a failed job keeps its failed step). GitHub still listed the
 * second phone run at the repair's version as running when they were read;
 * its end is that same check run completed the way the first one did.
 */
const PROJECT = "/repos/infinitary-labs/infinitary";
const BRANCH = "fm/task-dc9bdbe5";
/** The unchanged control, the graded-wait change, and its launcher import repair. */
const CONTROL = "add5d4b767b78f0bc4d4dd508db827549934587a";
const GRADED = "cab1793a37cd7a4886ec768211e31144fd938438";
const FIXED = "90b16579ca6e9e08226320284708ea2628caf3ff";
const CONTROL_RUN = 39849060046;
const GRADED_RUN = 39855723955;

type Ended = "success" | "failure" | null;

const phoneRun = (
  id: number,
  runNumber: number,
  head: string,
  suite: number,
  conclusion: Ended,
  createdAt: string,
  updatedAt: string,
) => ({
  id,
  name: "phone",
  head_branch: BRANCH,
  head_sha: head,
  path: ".github/workflows/phone.yml",
  run_number: runNumber,
  event: "workflow_dispatch",
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  workflow_id: 387177728,
  check_suite_id: suite,
  html_url: `https://github.com/infinitary-labs/infinitary/actions/runs/${id}`,
  created_at: createdAt,
  run_attempt: 1,
  run_started_at: createdAt,
  updated_at: updatedAt,
});

/** A phone job as GitHub lists it among its run's jobs and as a check run on its version. */
const phoneJob = (
  id: number,
  run: { id: number; head_sha: string; check_suite_id: number },
  name: "cancel-replaced" | "choose-phone" | "native-phone",
  conclusion: Ended,
  startedAt: string,
  completedAt: string | null,
) => ({
  id,
  run_id: run.id,
  head_sha: run.head_sha,
  run_attempt: 1,
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  started_at: startedAt,
  completed_at: completedAt,
  check_suite: { id: run.check_suite_id },
  ...(conclusion === "failure"
    ? {
        steps: [
          {
            name: "Read and recover on iPhone and iPad at once",
            number: 11,
            status: "completed",
            conclusion,
          },
        ],
      }
    : {}),
});

/** The unchanged control's phone run: native-phone failed when its control connection reset. */
const control = phoneRun(
  CONTROL_RUN,
  490,
  CONTROL,
  108006657922,
  "failure",
  "2026-10-22T20:27:49Z",
  "2026-10-23T00:41:37Z",
);
const CONTROL_JOBS = [
  phoneJob(
    120070045910,
    control,
    "cancel-replaced",
    "success",
    "2026-10-22T20:27:52Z",
    "2026-10-22T20:27:59Z",
  ),
  phoneJob(
    120070046291,
    control,
    "choose-phone",
    "success",
    "2026-10-22T20:27:53Z",
    "2026-10-22T20:28:05Z",
  ),
  phoneJob(
    120070164309,
    control,
    "native-phone",
    "failure",
    "2026-10-23T00:14:06Z",
    "2026-10-23T00:41:36Z",
  ),
];

/** Both phone runs of the graded-wait change stopped before compiling, at the launcher's import. */
const graded = phoneRun(
  GRADED_RUN,
  500,
  GRADED,
  108025412281,
  "failure",
  "2026-10-22T21:15:13Z",
  "2026-10-23T00:51:00Z",
);
const gradedLoaded = phoneRun(
  39855723566,
  499,
  GRADED,
  108025411111,
  "failure",
  "2026-10-22T21:15:12Z",
  "2026-10-23T00:49:53Z",
);
const gradedChoose = phoneJob(
  120093303092,
  graded,
  "choose-phone",
  "success",
  "2026-10-22T21:15:16Z",
  "2026-10-22T21:15:27Z",
);
const gradedCancel = phoneJob(
  120093303667,
  graded,
  "cancel-replaced",
  "success",
  "2026-10-22T21:15:16Z",
  "2026-10-22T21:15:22Z",
);
const gradedNative = phoneJob(
  120093413639,
  graded,
  "native-phone",
  "failure",
  "2026-10-23T00:50:18Z",
  "2026-10-23T00:51:00Z",
);
const GRADED_JOBS = [gradedChoose, gradedCancel, gradedNative];
/** The version's check runs, newest first as GitHub lists them. */
const GRADED_CHECKS = [
  gradedNative,
  phoneJob(
    120093404490,
    gradedLoaded,
    "native-phone",
    "failure",
    "2026-10-23T00:49:12Z",
    "2026-10-23T00:49:52Z",
  ),
  phoneJob(
    120093305109,
    gradedLoaded,
    "choose-phone",
    "success",
    "2026-10-22T21:15:16Z",
    "2026-10-22T21:15:26Z",
  ),
  phoneJob(
    120093304687,
    gradedLoaded,
    "cancel-replaced",
    "success",
    "2026-10-22T21:15:16Z",
    "2026-10-22T21:15:23Z",
  ),
  gradedCancel,
  gradedChoose,
];

/** The import repair's two phone runs: the first passed; the second's native-phone still ran. */
const fixed = phoneRun(
  39880899790,
  535,
  FIXED,
  108093277714,
  "success",
  "2026-10-23T00:54:31Z",
  "2026-10-23T02:25:06Z",
);
const fixedSecond = (ended: boolean) =>
  phoneRun(
    39880928350,
    536,
    FIXED,
    108093350090,
    ended ? "success" : null,
    "2026-10-23T00:54:48Z",
    ended ? "2026-10-23T02:40:05Z" : "2026-10-23T02:25:38Z",
  );
const fixedChecks = (ended: boolean) => [
  phoneJob(
    120177929774,
    fixedSecond(ended),
    "native-phone",
    ended ? "success" : null,
    "2026-10-23T02:25:37Z",
    ended ? "2026-10-23T02:40:05Z" : null,
  ),
  phoneJob(
    120177846524,
    fixedSecond(ended),
    "choose-phone",
    "success",
    "2026-10-23T00:54:52Z",
    "2026-10-23T00:55:05Z",
  ),
  phoneJob(
    120177846516,
    fixedSecond(ended),
    "cancel-replaced",
    "success",
    "2026-10-23T00:54:52Z",
    "2026-10-23T00:55:01Z",
  ),
  phoneJob(
    120177831085,
    fixed,
    "native-phone",
    "success",
    "2026-10-23T02:10:45Z",
    "2026-10-23T02:25:05Z",
  ),
  phoneJob(
    120177750652,
    fixed,
    "choose-phone",
    "success",
    "2026-10-23T00:54:34Z",
    "2026-10-23T00:54:46Z",
  ),
  phoneJob(
    120177750439,
    fixed,
    "cancel-replaced",
    "success",
    "2026-10-23T00:54:34Z",
    "2026-10-23T00:54:41Z",
  ),
];

type Version = { runs: ReturnType<typeof phoneRun>[]; checks: ReturnType<typeof phoneJob>[] };

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** GitHub as the branch stood: `ran` names each version's runs and check runs once they exist. */
async function setup() {
  const ran = new Map<string, Version>([[CONTROL, { runs: [control], checks: CONTROL_JOBS }]]);
  const runs = new Map([
    [CONTROL_RUN, { run: control, jobs: CONTROL_JOBS }],
    [GRADED_RUN, { run: graded, jobs: GRADED_JOBS }],
  ]);
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const url = new URL(req.url ?? "/", "http://stand-in");
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const path = url.pathname;
    const run = /\/actions\/runs\/(\d+)(\/jobs)?$/.exec(path);
    const commit = /\/commits\/([0-9a-f]{40})\/(check-runs|status)$/.exec(path);
    if (req.method !== "GET") json({ message: "Not Found" }, 404);
    // The branch has no pull request.
    else if (path === `${PROJECT}/pulls`) json([]);
    else if (run) {
      const read = runs.get(Number(run[1]));
      if (!read) json({ message: "Not Found" }, 404);
      else json(run[2] ? { total_count: read.jobs.length, jobs: read.jobs } : read.run);
    } else if (commit) {
      const version = ran.get(commit[1] as string) ?? { runs: [], checks: [] };
      json(
        commit[2] === "status"
          ? { state: "pending", statuses: [], sha: commit[1], total_count: 0 }
          : { total_count: version.checks.length, check_runs: version.checks },
      );
    } else if (path === `${PROJECT}/actions/runs`) {
      const head = url.searchParams.get("head_sha");
      // The project's pull requests run workflows: 1,742 such runs when read.
      if (!head) json({ total_count: 1742, workflow_runs: [] });
      else {
        const listed = ran.get(head)?.runs ?? [];
        json({ total_count: listed.length, workflow_runs: listed });
      }
    } else json({ message: "Not Found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const dir = scratchDir("fm-run-repair-");
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
  ).run(
    "r1",
    dir,
    "infinitary",
    1,
    "https://github.com/infinitary-labs/infinitary.git",
    "direct-pr",
  );
  const clock = () => Date.parse("2026-10-23T02:30:00Z");
  const tasks = new TaskService({ db, strict: true, now: clock });
  tasks.projects.ensureForRepo({ id: "r1", name: "infinitary" });
  seedTask(tasks, {
    id: "phone",
    title: "Continue: journeys and phone check waits pass under load",
    repoId: "r1",
    status: "running",
    worktreeDir: dir,
    branch: BRANCH,
  });
  const repos = new RepoRegistry(db, join(dir, "fleet"));
  const evidence = new WorkflowEvidenceService({ tasks, repos, forgeFor: () => forge, now: clock });
  const prCi = new PrCiService({ tasks, repos, forgeFor: () => forge, now: clock });
  // The crewmate's own tools, as its session binds them.
  const readWorkflow = bindTool(READ_WORKFLOW_TOOL, {
    onReadWorkflow: (input) => evidence.read("phone", input),
  });
  const checkChange = bindTool(CHECK_CHANGE_TOOL, {
    onCheckChange: (input) => prCi.checkForCrew("phone", input),
  });
  return {
    readWorkflow: async (runId: number) => (await readWorkflow.run({ runId })).text,
    checkChange: async (input: Parameters<typeof checkChange.run>[0]) =>
      (await checkChange.run(input)).text,
    /** GitHub ran the version's workflows: its runs and check runs now read as `version`. */
    githubRan: (head: string, version: Version) => ran.set(head, version),
    delivery: () => tasks.get("phone")?.delivery,
    repairs: () => tasks.get("phone")?.delivery?.ciRepair?.repairs,
    outcome: (id: string) =>
      tasks.get("phone")?.delivery?.ciRepair?.repairs.find((r) => r.id === id)?.outcome,
  };
}

const ownRegression = (headSha: string, evidence: string) => ({
  diagnosis: {
    headSha,
    check: "native-phone",
    classification: "own-regression" as const,
    evidence,
  },
});
const IDLE_BUDGET = {
  id: "phone-idle-budget",
  sourceHead: CONTROL,
  headSha: GRADED,
  check: "native-phone",
  evidence:
    "Gated the disposable control server's idle deadline; a frozen-server regression reproduces the reset",
};
const IMPORT = {
  id: "phone-import-and-idle-budget",
  sourceHead: GRADED,
  headSha: FIXED,
  check: "native-phone",
  evidence:
    "Restored the native launcher's missing import extension; the import failure reproduced locally",
};

describe("a repair with no pull request (INF-970)", () => {
  it("settles each phone repair at its own version, before the next repair and on a plain reading", async () => {
    const f = await setup();

    // The unchanged control's phone run failed; the crewmate repairs it before any pull request.
    expect(await f.readWorkflow(CONTROL_RUN)).toContain("native-phone — completed, failure");
    expect(
      await f.checkChange(
        ownRegression(
          CONTROL,
          "iPhone and iPad talk journeys failed when the control connection reset",
        ),
      ),
    ).toContain("Diagnosis recorded: own-regression");
    // A recorded repair answers with the reading that follows it.
    const first = await f.checkChange({ repair: IDLE_BUDGET });
    expect(f.repairs()).toEqual([IDLE_BUDGET]);
    expect(first).toContain(
      `Repair ${IDLE_BUDGET.id} at ${GRADED} (with no open pull request): that version's checks are still running, so it has no result yet.`,
    );

    // Both of that version's phone runs failed at the import. Declaring the next repair reads the
    // first repair's own version, settles it as unsuccessful, and records the next.
    f.githubRan(GRADED, { runs: [graded, gradedLoaded], checks: GRADED_CHECKS });
    expect(await f.readWorkflow(GRADED_RUN)).toContain("native-phone — completed, failure");
    await f.checkChange(
      ownRegression(
        GRADED,
        "The native launcher stopped before compiling at a missing import extension",
      ),
    );
    const next = await f.checkChange({ repair: IMPORT });
    expect(next).toContain(
      `Repair ${IDLE_BUDGET.id} at ${GRADED} (with no open pull request): native-phone completed / failure there (2 of 2 checks of that name did not pass), so it is an unsuccessful own repair (1/3).`,
    );
    expect(f.repairs()).toEqual([{ ...IDLE_BUDGET, outcome: "failed" }, IMPORT]);
    expect(f.delivery()?.ciRounds).toBe(1);

    // At the import repair's version one phone run passed while the other still runs: no result.
    f.githubRan(FIXED, { runs: [fixedSecond(false), fixed], checks: fixedChecks(false) });
    const running = await f.checkChange({});
    expect(running).toContain("overall: no-pr");
    expect(running).toContain(
      `Repair ${IMPORT.id} at ${FIXED} (with no open pull request): that version's checks are still running, so it has no result yet.`,
    );
    expect(f.outcome(IMPORT.id)).toBeUndefined();

    // Once the second run ends, a plain reading settles it: passed, and no attempt spent.
    f.githubRan(FIXED, { runs: [fixedSecond(true), fixed], checks: fixedChecks(true) });
    expect(await f.checkChange({})).toContain(
      `Repair ${IMPORT.id} at ${FIXED} (with no open pull request): native-phone completed / success there (all 2 checks of that name passed), so it passed and spent no attempt.`,
    );
    expect(f.outcome(IMPORT.id)).toBe("passed");
    expect(f.delivery()?.ciRounds).toBe(1);
    // The task's own reading stays the branch's: no pull request, and no version of one.
    expect(f.delivery()?.ci).toBe("no-pr");
    expect(f.delivery()?.headSha).toBeUndefined();
  });
});
