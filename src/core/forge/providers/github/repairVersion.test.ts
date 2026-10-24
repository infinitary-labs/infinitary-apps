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
 * INF-1184, filed from INF-1066: with pull request #436 open, a crewmate
 * repaired the scene-evidence job of its evidence branch and declared the
 * repair at its pushed version with four extra characters. check_change
 * recorded that id; correcting it under the same id was refused, and so was
 * a new id, because the mistyped attempt had no result. The runs, jobs,
 * check runs and commits are GitHub's own answers for those versions, read
 * on Oct 24 (actors, repository, app, output and links dropped). GitHub
 * reads the checks of the mistyped id as the commit its first 40 characters
 * name, answers 422 for the checks of a 40-character id it holds no commit
 * for, and its Git database answers 404 for both.
 */
const PROJECT = "/repos/infinitary-labs/infinitary";
const BRANCH = "fm/task-a9dd55e4";
const EVIDENCE = "fm/task-a9dd55e4-evidence";
/** Pull request #436's head, its evidence branch's failed version, and that version's repair. */
const PR_HEAD = "21e5511e4c597e6475da40dcda2d8e0c6bec9e67";
const SOURCE = "0b59b6d4863943cc06b1e6e16308572380eb3873";
const FIXED = "a75f9eb4d0f888d5a7fee139a342cbb35a86af3b";
/** The repair's version as it was declared, and a 40-character id GitHub holds no commit for. */
const MISTYPED = `${FIXED}0761`;
const UNHELD = "a75f9eb4d0f888d5a7fee139a342cbb35a86af3c";
const SOURCE_RUN = 40136674087;

type Ended = "success" | "failure" | "skipped" | null;
type Version = { parents: string[]; runs: unknown[]; checks: unknown[] };

const workflowRun = (
  id: number,
  runNumber: number,
  name: string,
  path: string,
  event: "workflow_dispatch" | "pull_request",
  branch: string,
  head: string,
  suite: number,
  conclusion: Ended,
  createdAt: string,
  updatedAt: string,
) => ({
  id,
  name,
  head_branch: branch,
  head_sha: head,
  path,
  run_number: runNumber,
  event,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  check_suite_id: suite,
  html_url: `https://github.com/infinitary-labs/infinitary/actions/runs/${id}`,
  created_at: createdAt,
  run_attempt: 1,
  run_started_at: createdAt,
  updated_at: updatedAt,
});

/** A job as GitHub lists it among its run's jobs and as a check run on its version. */
const job = (
  id: number,
  run: { id: number; head_sha: string; check_suite_id: number },
  name: string,
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
});

const PHONE = ".github/workflows/phone.yml";
const NATIVE = "inputs.evidence_run != '' && 'native-phone-not-requested' || 'native-phone'";

/** Pull request #436's head: its own ci, phone and journeys runs, and two phone runs by hand. */
const prRuns = [
  workflowRun(
    40134244919,
    826,
    "phone",
    PHONE,
    "workflow_dispatch",
    BRANCH,
    PR_HEAD,
    108783170891,
    "success",
    "2026-10-24T21:26:48Z",
    "2026-10-24T21:44:58Z",
  ),
  workflowRun(
    40131257933,
    818,
    "phone",
    PHONE,
    "workflow_dispatch",
    BRANCH,
    PR_HEAD,
    108775233814,
    "failure",
    "2026-10-24T20:46:02Z",
    "2026-10-24T21:22:24Z",
  ),
  workflowRun(
    40130200362,
    1227,
    "ci",
    ".github/workflows/ci.yml",
    "pull_request",
    BRANCH,
    PR_HEAD,
    108772460600,
    "success",
    "2026-10-24T20:31:57Z",
    "2026-10-24T20:35:23Z",
  ),
  workflowRun(
    40130200313,
    814,
    "phone",
    PHONE,
    "pull_request",
    BRANCH,
    PR_HEAD,
    108772460451,
    "failure",
    "2026-10-24T20:31:57Z",
    "2026-10-24T21:15:10Z",
  ),
  workflowRun(
    40130200297,
    962,
    "journeys",
    ".github/workflows/journeys.yml",
    "pull_request",
    BRANCH,
    PR_HEAD,
    108772460415,
    "success",
    "2026-10-24T20:31:57Z",
    "2026-10-24T21:27:35Z",
  ),
] as const;
const [byHand, byHandFailed, ci, prPhone, journeys] = prRuns;
const PR_CHECKS = [
  job(
    120992264199,
    byHand,
    "choose-phone",
    "skipped",
    "2026-10-24T21:26:49Z",
    "2026-10-24T21:26:49Z",
  ),
  job(120992264141, byHand, NATIVE, "skipped", "2026-10-24T21:26:49Z", "2026-10-24T21:26:49Z"),
  job(
    120992263245,
    byHand,
    "scene-evidence",
    "success",
    "2026-10-24T21:42:55Z",
    "2026-10-24T21:44:57Z",
  ),
  job(
    120992263171,
    byHand,
    "cancel-replaced",
    "success",
    "2026-10-24T21:26:51Z",
    "2026-10-24T21:26:57Z",
  ),
  job(
    120983299537,
    byHandFailed,
    "native-phone",
    "failure",
    "2026-10-24T21:02:33Z",
    "2026-10-24T21:22:23Z",
  ),
  job(
    120983260075,
    byHandFailed,
    "scene-evidence",
    "skipped",
    "2026-10-24T20:46:04Z",
    "2026-10-24T20:46:03Z",
  ),
  job(
    120983258769,
    byHandFailed,
    "cancel-replaced",
    "success",
    "2026-10-24T20:46:05Z",
    "2026-10-24T20:46:15Z",
  ),
  job(
    120983258576,
    byHandFailed,
    "choose-phone",
    "success",
    "2026-10-24T20:46:05Z",
    "2026-10-24T20:46:14Z",
  ),
  job(
    120980346735,
    journeys,
    "linux-overflow",
    "skipped",
    "2026-10-24T20:33:05Z",
    "2026-10-24T20:33:04Z",
  ),
  job(
    120980345833,
    journeys,
    "affected-journeys",
    "success",
    "2026-10-24T21:23:07Z",
    "2026-10-24T21:27:35Z",
  ),
  job(
    120980160809,
    prPhone,
    "native-phone",
    "failure",
    "2026-10-24T20:42:01Z",
    "2026-10-24T21:15:09Z",
  ),
  job(
    120980094501,
    journeys,
    "linux-source / source-desktop (desktop)",
    "success",
    "2026-10-24T20:32:01Z",
    "2026-10-24T20:37:57Z",
  ),
  job(
    120980094452,
    journeys,
    "linux-source / source-desktop (parallel)",
    "success",
    "2026-10-24T20:32:00Z",
    "2026-10-24T20:37:44Z",
  ),
  job(
    120980094306,
    prPhone,
    "scene-evidence",
    "skipped",
    "2026-10-24T20:31:58Z",
    "2026-10-24T20:31:58Z",
  ),
  job(
    120980094273,
    journeys,
    "choose-journeys",
    "success",
    "2026-10-24T20:32:00Z",
    "2026-10-24T20:33:04Z",
  ),
  job(
    120980093571,
    ci,
    "integration-tests (1/2)",
    "success",
    "2026-10-24T20:33:08Z",
    "2026-10-24T20:35:21Z",
  ),
  job(
    120980093529,
    ci,
    "typecheck-lint-build",
    "success",
    "2026-10-24T20:32:56Z",
    "2026-10-24T20:34:33Z",
  ),
  job(120980093512, ci, "probe-tests", "success", "2026-10-24T20:32:46Z", "2026-10-24T20:35:23Z"),
  job(120980093486, ci, "unit-tests", "success", "2026-10-24T20:32:21Z", "2026-10-24T20:34:58Z"),
  job(
    120980093311,
    ci,
    "integration-tests (2/2)",
    "success",
    "2026-10-24T20:32:14Z",
    "2026-10-24T20:34:26Z",
  ),
  job(
    120980093293,
    prPhone,
    "choose-phone",
    "success",
    "2026-10-24T20:32:00Z",
    "2026-10-24T20:32:16Z",
  ),
  job(
    120980093165,
    prPhone,
    "cancel-replaced",
    "success",
    "2026-10-24T20:32:00Z",
    "2026-10-24T20:32:12Z",
  ),
];

/** The evidence branch's export run at the failed version: scene-evidence failed at an upload. */
const sourceRun = workflowRun(
  SOURCE_RUN,
  832,
  "phone",
  PHONE,
  "workflow_dispatch",
  EVIDENCE,
  SOURCE,
  108789488850,
  "failure",
  "2026-10-24T22:00:23Z",
  "2026-10-24T22:02:30Z",
);
const SOURCE_JOBS = [
  job(
    120999543991,
    sourceRun,
    "cancel-replaced",
    "success",
    "2026-10-24T22:00:26Z",
    "2026-10-24T22:00:34Z",
  ),
  {
    ...job(
      120999544115,
      sourceRun,
      "scene-evidence",
      "failure",
      "2026-10-24T22:01:04Z",
      "2026-10-24T22:02:29Z",
    ),
    steps: [
      {
        name: "Run actions/upload-artifact@v4",
        number: 7,
        status: "completed",
        conclusion: "failure",
      },
    ],
  },
  job(
    120999545156,
    sourceRun,
    "choose-phone",
    "skipped",
    "2026-10-24T22:00:24Z",
    "2026-10-24T22:00:24Z",
  ),
  job(120999545294, sourceRun, NATIVE, "skipped", "2026-10-24T22:00:24Z", "2026-10-24T22:00:24Z"),
];

/** The repair's two export runs: running when the repair was declared, then both passed. */
const fixedVersion = (ended: boolean): Version => {
  const first = workflowRun(
    40137185822,
    833,
    "phone",
    PHONE,
    "workflow_dispatch",
    EVIDENCE,
    FIXED,
    108790850754,
    ended ? "success" : null,
    "2026-10-24T22:07:19Z",
    ended ? "2026-10-24T22:10:42Z" : "2026-10-24T22:08:00Z",
  );
  const second = workflowRun(
    40137185969,
    834,
    "phone",
    PHONE,
    "workflow_dispatch",
    EVIDENCE,
    FIXED,
    108790851057,
    ended ? "success" : null,
    "2026-10-24T22:07:19Z",
    ended ? "2026-10-24T22:10:00Z" : "2026-10-24T22:08:00Z",
  );
  return {
    parents: [SOURCE],
    runs: [second, first],
    checks: [
      job(121001087567, second, NATIVE, "skipped", "2026-10-24T22:07:21Z", "2026-10-24T22:07:21Z"),
      job(
        121001087559,
        second,
        "choose-phone",
        "skipped",
        "2026-10-24T22:07:21Z",
        "2026-10-24T22:07:20Z",
      ),
      job(121001086666, first, NATIVE, "skipped", "2026-10-24T22:07:21Z", "2026-10-24T22:07:20Z"),
      job(
        121001086453,
        first,
        "choose-phone",
        "skipped",
        "2026-10-24T22:07:21Z",
        "2026-10-24T22:07:20Z",
      ),
      job(
        121001086323,
        second,
        "cancel-replaced",
        "success",
        "2026-10-24T22:07:22Z",
        "2026-10-24T22:07:30Z",
      ),
      job(
        121001086182,
        second,
        "scene-evidence",
        ended ? "success" : null,
        "2026-10-24T22:08:00Z",
        ended ? "2026-10-24T22:09:59Z" : null,
      ),
      job(
        121001085563,
        first,
        "cancel-replaced",
        "success",
        "2026-10-24T22:07:23Z",
        "2026-10-24T22:07:32Z",
      ),
      job(
        121001085379,
        first,
        "scene-evidence",
        ended ? "success" : null,
        "2026-10-24T22:08:00Z",
        ended ? "2026-10-24T22:10:42Z" : null,
      ),
    ],
  };
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** GitHub as the project stood, with the repair's export runs still running. */
async function setup() {
  const versions = new Map<string, Version>([
    [PR_HEAD, { parents: [], runs: [...prRuns], checks: PR_CHECKS }],
    [SOURCE, { parents: [], runs: [sourceRun], checks: SOURCE_JOBS }],
    [FIXED, fixedVersion(false)],
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
    const reads = /\/commits\/([0-9a-f]+)\/(check-runs|status)$/.exec(path);
    const commit = /\/git\/commits\/([^/]+)$/.exec(path);
    if (req.method !== "GET") json({ message: "Not Found" }, 404);
    else if (path === PROJECT) {
      json({
        name: "infinitary",
        full_name: "infinitary-labs/infinitary",
        private: true,
        default_branch: "main",
      });
    } else if (path === `${PROJECT}/pulls`) {
      json(
        url.searchParams.get("head") === `infinitary-labs:${BRANCH}`
          ? [
              {
                number: 436,
                html_url: "https://github.com/infinitary-labs/infinitary/pull/436",
                title: "feat(ios): add a display-paced native crew scene",
                body: "",
                draft: false,
                head: {
                  sha: PR_HEAD,
                  ref: BRANCH,
                  repo: { full_name: "infinitary-labs/infinitary" },
                },
              },
            ]
          : [],
      );
    } else if (run) {
      if (Number(run[1]) !== SOURCE_RUN) json({ message: "Not Found" }, 404);
      else json(run[2] ? { total_count: SOURCE_JOBS.length, jobs: SOURCE_JOBS } : sourceRun);
    } else if (reads) {
      // The commit reads resolve a longer id to the commit its first 40 characters name.
      const ref = reads[1] as string;
      const sha = [...versions.keys()].find((held) => ref.startsWith(held));
      const version = sha ? versions.get(sha) : undefined;
      if (!sha || !version) json({ message: `No commit found for SHA: ${ref}` }, 422);
      else if (reads[2] === "status") json({ state: "pending", statuses: [], sha, total_count: 0 });
      else json({ total_count: version.checks.length, check_runs: version.checks });
    } else if (commit) {
      // The Git database answers only an exact full id it holds.
      const sha = commit[1] as string;
      const version = versions.get(sha);
      if (!version) json({ message: "Not Found" }, 404);
      else json({ sha, parents: version.parents.map((parent) => ({ sha: parent })) });
    } else if (path === `${PROJECT}/actions/runs`) {
      const listed = versions.get(url.searchParams.get("head_sha") ?? "")?.runs ?? [];
      json({ total_count: listed.length, workflow_runs: listed });
    } else json({ message: "Not Found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const dir = scratchDir("fm-repair-version-");
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
  const clock = () => Date.parse("2026-10-24T22:08:30Z");
  const tasks = new TaskService({ db, strict: true, now: clock });
  tasks.projects.ensureForRepo({ id: "r1", name: "infinitary" });
  seedTask(tasks, {
    id: "scene",
    title: "Build the smooth iOS center animation",
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
    onReadWorkflow: (input) => evidence.read("scene", input),
  });
  const checkChange = bindTool(CHECK_CHANGE_TOOL, {
    onCheckChange: (input) => prCi.checkForCrew("scene", input),
  });
  const f = {
    readWorkflow: async (runId: number) => (await readWorkflow.run({ runId })).text,
    checkChange: async (input: Parameters<typeof checkChange.run>[0]) =>
      (await checkChange.run(input)).text,
    /** GitHub finished the repair's export runs. */
    exportsEnded: () => versions.set(FIXED, fixedVersion(true)),
    /**
     * The attempt the host recorded before INF-1184 at a version GitHub holds
     * no commit for, after one unsuccessful repair earlier in the task.
     */
    savedAttempt: (headSha: string) => {
      const ledger = tasks.get("scene")?.delivery?.ciRepair;
      if (!ledger) throw new Error("no repair ledger to save the attempt on");
      tasks.recordDelivery("scene", {
        ciRepair: { ...ledger, repairs: [...ledger.repairs, { ...REPAIR, headSha }] },
        ciRounds: 1,
      });
    },
    delivery: () => tasks.get("scene")?.delivery,
    repairs: () => tasks.get("scene")?.delivery?.ciRepair?.repairs,
  };
  // The export run at the failed version, read and diagnosed as the crewmate's own.
  expect(await f.readWorkflow(SOURCE_RUN)).toContain("scene-evidence — completed, failure");
  expect(
    await f.checkChange({
      diagnosis: {
        headSha: SOURCE,
        check: "scene-evidence",
        classification: "own-regression",
        evidence: "The exporter wrote attachment names the artifact upload rejects",
      },
    }),
  ).toContain("Diagnosis recorded: own-regression");
  return f;
}

const REPAIR = {
  id: "native-evidence-diagnostic-filenames",
  sourceHead: SOURCE,
  headSha: FIXED,
  check: "scene-evidence",
  evidence: "Retained diagnostic attachment ids in the exported filenames; 222 real names replayed",
};
const settled = (id: string) =>
  `Repair ${id} at ${FIXED} (the change is now at ${PR_HEAD}): scene-evidence completed / success there (all 2 checks of that name passed), so it passed and spent no attempt.`;

describe("a repair declared at a version GitHub holds no commit for (INF-1184)", () => {
  it("refuses the declaration and records nothing, then records it at the pushed version", async () => {
    const f = await setup();

    for (const headSha of [MISTYPED, UNHELD]) {
      expect(await f.checkChange({ repair: { ...REPAIR, headSha } })).toBe(
        `Repair refused: no commit ${headSha} exists on GitHub, so no check can run there. Push the repaired version and declare its full commit id; nothing was recorded and no attempt was spent.`,
      );
    }
    expect(f.repairs()).toEqual([]);

    expect(await f.checkChange({ repair: REPAIR })).toContain(
      `Repair ${REPAIR.id} at ${FIXED} (the change is now at ${PR_HEAD}): that version's checks are still running, so it has no result yet.`,
    );
    expect(f.repairs()).toEqual([REPAIR]);
  });

  it("voids a saved attempt at the mistyped version, so its own id names the pushed one", async () => {
    const f = await setup();
    f.savedAttempt(MISTYPED);

    // GitHub reads the mistyped id's checks as the pushed version's, but its
    // attempt closes before they are read, and the correction takes its id.
    const corrected = await f.checkChange({ repair: REPAIR });
    expect(corrected).toContain(
      `Repair ${REPAIR.id} at ${MISTYPED} (the change is now at ${PR_HEAD}): no commit ${MISTYPED} exists on GitHub, so no check can run there; it is void and spent no attempt, and its id may name the repair at its pushed version.`,
    );
    expect(corrected).toContain(
      `Repair ${REPAIR.id} at ${FIXED} (the change is now at ${PR_HEAD}): that version's checks are still running, so it has no result yet.`,
    );
    expect(f.repairs()).toEqual([REPAIR]);
    expect(f.delivery()?.ciRounds).toBe(1);

    f.exportsEnded();
    expect(await f.checkChange({})).toContain(settled(REPAIR.id));
    expect(f.repairs()).toEqual([{ ...REPAIR, outcome: "passed" }]);
    expect(f.delivery()?.ciRounds).toBe(1);
  });

  it("voids a saved attempt GitHub can never read on a plain reading, so a new id may follow", async () => {
    const f = await setup();
    f.savedAttempt(UNHELD);

    expect(await f.checkChange({})).toContain(
      `Repair ${REPAIR.id} at ${UNHELD} (the change is now at ${PR_HEAD}): no commit ${UNHELD} exists on GitHub, so no check can run there; it is void and spent no attempt, and its id may name the repair at its pushed version.`,
    );
    expect(f.repairs()).toEqual([{ ...REPAIR, headSha: UNHELD, outcome: "void" }]);

    const next = { ...REPAIR, id: `${REPAIR.id}-2` };
    expect(await f.checkChange({ repair: next })).toContain(
      `Repair ${next.id} at ${FIXED} (the change is now at ${PR_HEAD}): that version's checks are still running, so it has no result yet.`,
    );
    f.exportsEnded();
    expect(await f.checkChange({})).toContain(settled(next.id));
    expect(f.repairs()).toEqual([
      { ...REPAIR, headSha: UNHELD, outcome: "void" },
      { ...next, outcome: "passed" },
    ]);
    expect(f.delivery()?.ciRounds).toBe(1);
  });
});
