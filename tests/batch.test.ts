import { describe, expect, it } from "vitest";
import { batchBase, readMainPush, readQueueStatus, sortMainPush } from "../scripts/batch.mjs";
import { confirmFiles, confirmRound } from "../scripts/batch-confirm.ts";
import { legacyJobName } from "../scripts/ci-job-names.mjs";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows.ts";

// INF-2430 piece 3, the captain's approved plan for the swept batch, run by
// the queue Infinitary ships since INF-2952's piece 3 (docs/testing.md, "The
// swept batch"; the queue's own rules are tested beside their source in
// src/core/queue/shipped/). What this project adds is held here: its batch
// checks, the shipped compose step in every job, and main's sort of a push.
// The readings follow GitHub's answers: a commit status list, newest first,
// and pull request 917 as /commits/{sha}/pulls returned it for main's commit
// c44de17a0 (head, merge commit and tree from git).
const repo = { owner: "infinitary-labs", repo: "infinitary" };
const QUEUE = "infinitary/queue";
const passed = (run: number, tree: string) => `Passed batch run ${run}; tree ${tree}`;
const runUrl = (id: number) => `https://github.com/infinitary-labs/infinitary/actions/runs/${id}`;
const status = (state: string, description: string, created_at: string, context = QUEUE) => ({
  state,
  description,
  context,
  target_url: runUrl(41_600_000_000),
  created_at,
  updated_at: created_at,
  creator: { login: "kunchenguid" },
});
const pr917 = {
  number: 917,
  head: "aaed595636182b00423e6bcad8db17993c21a3fc",
  merge: "c44de17a00c806b83a81f75fe666c0dae2ea53d2",
  tree: "be6452e81a110b0c50d7354add8d59a231807cce",
};
const other = "a083c89250edd8db67364636d44e2f53dd84c23b";
const entry = (number: number, queue: ReturnType<typeof readQueueStatus>) => ({
  number,
  head: `${number}`.padEnd(40, "0"),
  queue,
});

describe("reading a change's queue state for main's sort", () => {
  it("reads only the queue's status, with the shipped queue's words", () => {
    const read = readQueueStatus([
      status("success", "ci passed", "2026-11-03T22:01:00Z", "ci"),
      status("success", passed(41_600_000_001, pr917.tree), "2026-11-03T22:00:00Z"),
      status("pending", "In batch run 41600000001", "2026-11-03T21:00:00Z"),
    ]);
    expect(read).toMatchObject({ kind: "passed", run: 41_600_000_001, tree: pr917.tree });
    expect(readQueueStatus([status("success", "ci passed", "2026-11-03T22:01:00Z", "ci")])).toBe(
      null,
    );
  });
});

describe("main's check sorting a push", () => {
  const green = readQueueStatus([
    status("success", passed(41_600_000_001, pr917.tree), "2026-11-03T22:00:00Z"),
  ]);

  it("reads files that are exactly a passed batch's as covered", () => {
    expect(
      sortMainPush({ tree: pr917.tree, queue: green, main: pr917.tree, open: [], between: [] }),
    ).toEqual({
      kind: "covered",
      run: 41_600_000_001,
    });
    // A merge outside the queue.
    expect(
      sortMainPush({ tree: pr917.tree, queue: null, main: pr917.tree, open: [], between: [] }),
    ).toEqual({
      kind: "full",
    });
  });

  // The captain's pick on INF-3052, "A: keep a fallback full check on main
  // for versions no batch built". The readings are main's runs that night:
  // each push's tree, its change's queue status and main's newest tree, from
  // git and the runs' statuses.
  const batch54 = 42_462_389_348;
  const batch43 = 42_459_311_762;
  const batch315 = 42_456_966_779;
  const passedIn = (run: number, tree: string) =>
    readQueueStatus([status("success", passed(run, tree), "2026-11-08T07:53:14Z")]);

  it("covers a push whose batch passed only on its confirm (main run 315)", () => {
    // f9d344e's change passed batch run 42456966779 on its confirm, on its very tree.
    const tree = "7b9afd34b68fe3837ccb676cd2cdfbdd606036ea";
    expect(
      sortMainPush({ tree, queue: passedIn(batch315, tree), main: tree, open: [], between: [] }),
    ).toEqual({ kind: "covered", run: batch315 });
  });

  it("cancels a push after which main already reached the batch's files (main run 323)", () => {
    // c911efd's batch's last change merged as faaba30 seconds before the sort
    // read the queue: no change of the batch was still open, but main's
    // newest tree was the batch's.
    const batchTree = "d1f52916660ea0a2e77841f9d067a0706fdd2175";
    expect(
      sortMainPush({
        tree: "3b9e185f44ef09e832383ff0c52a89636631b8d0",
        queue: passedIn(batch54, batchTree),
        main: batchTree,
        open: [],
        between: [],
      }),
    ).toEqual({ kind: "landing", run: batch54 });
  });

  it("runs the full check for files no batch built, though a change of the batch is still open (main run 320)", () => {
    // Batch run 42459311762 composed onto 4a1e4c29e, but #1235 of an earlier
    // batch merged as f9d344e first, so main never reached the batch's tree;
    // #1237 passed in that batch and stayed open.
    const batchTree = "109eba54ec8651b0393b2ba00f5237b87c59f850";
    const tree = "3b3594587724583f8847fe1185a47376b1f5a57c";
    const member = passedIn(batch43, batchTree);
    const input = {
      tree,
      queue: member,
      main: tree,
      open: [entry(1237, member)],
      between: [
        passedIn(batch315, "7b9afd34b68fe3837ccb676cd2cdfbdd606036ea"),
        member,
        member,
        member,
        member,
        member,
      ],
    };
    expect(sortMainPush(input)).toEqual({ kind: "full" });
    // Had main held only the batch's own changes since its base, it could
    // still reach the batch's tree, and the push would cancel.
    expect(sortMainPush({ ...input, between: input.between.slice(1) })).toEqual({
      kind: "landing",
      run: batch43,
    });
    // A push that does not sit on the batch's base cannot reach it either.
    expect(sortMainPush({ ...input, between: null })).toEqual({ kind: "full" });
    // A batch run from before the base was named: an open change of it
    // still means main can reach its files.
    expect(sortMainPush({ ...input, between: undefined })).toEqual({
      kind: "landing",
      run: batch43,
    });
    // Every change of the batch merged, yet main's files differ from it.
    expect(sortMainPush({ ...input, open: [] })).toEqual({ kind: "full" });
  });

  it("reads the base the batch checks' last job names, in the batch's run or its confirm", () => {
    const tree = "109eba54ec8651b0393b2ba00f5237b87c59f850";
    const base = "4a1e4c29e62d33e1cca435050f6173b989abb037";
    const job = (name: string, conclusion: string) => ({ name, conclusion });
    expect(
      batchBase([
        job("Batch checks / Merge batch · Batch passed (tree ${{ inputs.tree }})", "skipped"),
        job(`Batch confirm / Merge batch · Batch passed (tree ${tree}; base ${base})`, "success"),
      ]),
    ).toBe(base);
    // Batch run 42459311762's own reading, from before the base was named.
    expect(
      batchBase([job(`Batch checks / Merge batch · Batch passed (tree ${tree})`, "success")]),
    ).toBe(null);
  });

  it("reads the pushed commit's pull request, the queue, the batch's base and main from GitHub (main run 320)", async () => {
    const base = "4a1e4c29e62d33e1cca435050f6173b989abb037";
    const batchTree = "109eba54ec8651b0393b2ba00f5237b87c59f850";
    const tree = "3b3594587724583f8847fe1185a47376b1f5a57c";
    // Main's commits since the batch's base, oldest first, each with its change.
    const merged = [
      {
        sha: "f9d344e40a3b644fbe2d9e68a8eab8d148774810",
        number: 1235,
        run: batch315,
        tree: "7b9afd34b68fe3837ccb676cd2cdfbdd606036ea",
      },
      {
        sha: "a0d967295f80ddf7d834825aa76156863ed44642",
        number: 1247,
        run: batch43,
        tree: batchTree,
      },
      {
        sha: "b051e39a1cec56d074c718494ca394478fa73a76",
        number: 1240,
        run: batch43,
        tree: batchTree,
      },
      {
        sha: "2f701a754e42eaedd2bef9960dda9616335127f2",
        number: 1239,
        run: batch43,
        tree: batchTree,
      },
      {
        sha: "dab708638f6a8182893e44a2c92fdcd754ab1a8c",
        number: 1245,
        run: batch43,
        tree: batchTree,
      },
      {
        sha: "fac00244adb7dfa869ad34ccce92a51133c1f230",
        number: 1244,
        run: batch43,
        tree: batchTree,
      },
    ];
    const head = (number: number) => `${number}`.padEnd(40, "0");
    const statuses: Record<string, unknown[]> = Object.fromEntries([
      ...merged.map((commit) => [
        head(commit.number),
        [status("success", passed(commit.run, commit.tree), "2026-11-08T07:53:14Z")],
      ]),
      [head(1237), [status("success", passed(batch43, batchTree), "2026-11-08T07:53:14Z")]],
    ]);
    let since = merged;
    let mainTree = tree;
    let jobs = [
      {
        name: `Batch checks / Merge batch · Batch passed (tree ${batchTree}; base ${base})`,
        conclusion: "success",
      },
    ];
    const github = {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async ({ commit_sha }: { commit_sha: string }) => ({
            data: merged
              .filter((commit) => commit.sha === commit_sha)
              .map((commit) => ({
                number: commit.number,
                merge_commit_sha: commit.sha,
                head: { sha: head(commit.number) },
              })),
          }),
          getBranch: async ({ branch }: { branch: string }) => {
            expect(branch).toBe("main");
            return { data: { commit: { commit: { tree: { sha: mainTree } } } } };
          },
          compareCommits: async (parameters: { base: string; head: string }) => {
            expect(parameters).toMatchObject({ base, head: merged.at(-1)!.sha });
            return {
              data: {
                status: "ahead",
                total_commits: since.length,
                commits: since.map(({ sha }) => ({ sha })),
              },
            };
          },
          listCommitStatusesForRef: "statuses",
        },
        pulls: { list: "pulls" },
        actions: { listJobsForWorkflowRun: "jobs" },
      },
      paginate: async (method: string, parameters: { ref?: string; run_id?: number }) => {
        if (method === "statuses") return statuses[parameters.ref!] ?? [];
        if (method === "jobs") {
          expect(parameters.run_id).toBe(batch43);
          return jobs;
        }
        return [{ number: 1237, head: { sha: head(1237) }, base: { ref: "main" } }];
      },
    };
    const push = { sha: merged.at(-1)!.sha, tree };
    expect(await readMainPush(github, repo, push)).toEqual({ kind: "full" });
    since = merged.slice(1);
    expect(await readMainPush(github, repo, push)).toEqual({ kind: "landing", run: batch43 });
    since = merged;
    mainTree = batchTree;
    expect(await readMainPush(github, repo, push)).toEqual({ kind: "landing", run: batch43 });
    mainTree = tree;
    jobs = [
      {
        name: `Batch checks / Merge batch · Batch passed (tree ${batchTree})`,
        conclusion: "success",
      },
    ];
    expect(await readMainPush(github, repo, push)).toEqual({ kind: "landing", run: batch43 });
    expect(
      await readMainPush(github, repo, { sha: merged[0]!.sha, tree: merged[0]!.tree }),
    ).toEqual({
      kind: "covered",
      run: batch315,
    });
    expect(await readMainPush(github, repo, { sha: base, tree })).toEqual({ kind: "full" });
  });
});

type Job = {
  if?: string;
  name?: string;
  uses?: string;
  needs?: unknown;
  "runs-on"?: string;
  with?: Record<string, unknown>;
  steps?: {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
  }[];
};
const compose = (job: Job) => job.steps!.find((step) => step.name === "Compose the batch")!;
const workflow = (path: string) =>
  loadYamlFile(path) as {
    on: Record<string, { inputs?: Record<string, unknown> } | null>;
    jobs: Record<string, Job>;
  };

describe("infinitary-batch-checks.yml", () => {
  const batch = workflow(".github/workflows/infinitary-batch-checks.yml");
  const inputs = { batch: `917:${pr917.head}`, base: other, tree: pr917.tree };

  it("is what the shipped queue calls, with the batch, its base and its tree", () => {
    const queue = workflow(".github/workflows/infinitary-queue.yml");
    expect(queue.jobs.checks?.uses).toBe("./.github/workflows/infinitary-batch-checks.yml");
    // GitHub refuses an input the called file does not declare, so it
    // declares every input the queue's checks and its confirm pass.
    expect(Object.keys(queue.jobs.confirm?.with ?? {}).sort()).toEqual(
      Object.keys(batch.on.workflow_call?.inputs ?? {}).sort(),
    );
    for (const id of ["sweep", "critical-path"]) {
      const call = batch.jobs[id]!.with!;
      expect(workflowString(String(call.ref), { inputs }), id).toBe(other);
      expect(workflowString(String(call.batch), { inputs }), id).toBe(inputs.batch);
      expect(workflowString(String(call.batch_tree), { inputs }), id).toBe(pr917.tree);
    }
  });

  it("sweeps with the alpha's full check: hosted Linux, every journey, the Mac lanes on the release split line", () => {
    const sweep = batch.jobs.sweep!;
    expect(sweep.uses).toBe("./.github/workflows/verify.yml");
    expect(sweep.with).toMatchObject({ hosted: true, all_journeys: true, profile: "stable" });
    // The captain on INF-2508: "Keep every journey in the batch, and let an
    // alpha reuse them". The sweep calls the whole check, never a part, so
    // its journeys are there for the alpha to reuse.
    expect(sweep.with!.part).toBeUndefined();
    // INF-2779: the full check's three Mac jobs share one kind.
    const vars = {
      MAC_QUEUES: JSON.stringify({
        split: "mini-mac-split",
        release_split: "mini-mac-release-split",
      }),
    };
    expect(workflowString(String(sweep.with!.mac_runner), { vars })).toBe("mini-mac-release-split");
    expect(Object.values(batch.jobs).some((job) => job.uses?.endsWith("/phone.yml"))).toBe(false);
  });

  // INF-2507, and the captain on INF-2508: "the e2e journey + browser tests
  // should all run during the sweep batch". The critical path runs on the
  // composed batch in a job of its own, so it stays in the batch's check
  // whatever part of the full check the sweep runs; it is the same journey
  // every pull request that builds the app runs (ci.yml's critical-path step,
  // INF-2915), on the commit the sweep composes.
  it("runs the critical path on the composed batch, on hosted Linux, in a job of its own", () => {
    const job = batch.jobs["critical-path"];
    const sweep = batch.jobs.sweep;
    const pullRequest = workflow(".github/workflows/ci.yml").jobs[
      "typecheck-lint-build"
    ]?.steps?.find((step) => step.id === "critical-path");
    expect(job?.uses).toBe("./.github/workflows/source-journeys.yml");
    expect(job?.with).toMatchObject({
      ref: sweep?.with?.ref,
      batch: sweep?.with?.batch,
      batch_tree: sweep?.with?.batch_tree,
      hosted: true,
      suite: "affected",
      lane: "desktop",
      files: "tests/e2e/critical-path.spec.ts",
    });
    expect(pullRequest?.run).toContain(`--files ${job?.with?.files} `);
    expect(pullRequest?.run).toContain("-- --project=desktop");
    const journeys = workflow(".github/workflows/source-journeys.yml").jobs["source-desktop"] as {
      "runs-on": string;
    };
    const vars = { LINUX_RUNNER: "shell-pc-linux" };
    expect(workflowString(journeys["runs-on"], { inputs: job?.with, vars })).toBe("ubuntu-24.04");
  });

  // The captain's pick on INF-3052, "In the batch check, beside the
  // critical-path journey": the startup fixtures run on the composed batch,
  // so they run before a merge.
  it("runs the Linux startup fixtures on the composed batch, on hosted Ubuntu", () => {
    const job = batch.jobs.startup!;
    expect(job.uses).toBe("./.github/workflows/linux-startup.yml");
    expect(workflowValue(job.if!, { inputs: { failed_jobs: "" } })).toBe(true);
    for (const key of ["ref", "batch", "batch_tree"])
      expect(job.with![key], key).toBe(batch.jobs.sweep!.with![key]);
    const startup = workflow(".github/workflows/linux-startup.yml");
    const fixtures = startup.jobs["runtime-facts"]!;
    expect(fixtures["runs-on"]).toBe("ubuntu-24.04");
    const steps = fixtures.steps!.map((step) => step.name ?? step.uses);
    expect(steps.indexOf("Compose the batch")).toBeLessThan(
      steps.indexOf("./.github/actions/linux-startup"),
    );
    expect(compose(fixtures).env).toEqual({
      HEADS: "${{ inputs.batch }}",
      BASE: "${{ inputs.ref }}",
      TREE: "${{ inputs.batch_tree }}",
    });
    // Main's own full check calls it with no batch, so nothing composes.
    expect(workflowValue(compose(fixtures).if!, { inputs: {} })).toBe(false);
  });

  it("passes once the sweep, the critical path and the startup fixtures passed, or the confirm did, and names the tree and base", () => {
    const job = batch.jobs.passed!;
    expect(job.needs).toEqual(["sweep", "critical-path", "startup", "confirm"]);
    const result = (sweep: string, confirm: string, failed_jobs = "") =>
      workflowValue(
        job.if!,
        {
          inputs: { failed_jobs },
          needs: {
            sweep: { result: sweep },
            "critical-path": { result: sweep },
            startup: { result: sweep },
            confirm: { result: confirm },
          },
        },
        { success: true, failure: false, always: true, cancelled: false },
      );
    expect(result("success", "skipped")).toBe(true);
    expect(result("failure", "skipped")).toBe(false);
    expect(result("skipped", "success", "x")).toBe(true);
    expect(result("skipped", "failure", "x")).toBe(false);
    // Trigger first (docs/testing.md, "CI job names"); main's sort and the
    // alpha's proof read it under the queue's checks or confirm job
    // (scripts/batch.mjs, scripts/main-alpha-proof.mjs).
    const name = workflowString(job.name!, { inputs });
    expect(name).toBe(`Merge batch · Batch passed (tree ${pr917.tree}; base ${other})`);
    expect(legacyJobName(name)).toBe(`Batch passed (tree ${pr917.tree}; base ${other})`);
    expect(batchBase([{ name: `Batch confirm / ${name}`, conclusion: "success" }])).toBe(other);
  });
});

// The captain's pick on INF-3012, "A only: the confirm step": when the
// sweep fails, the queue calls this file once more on the same batch, and
// only the failed test files run, three rounds, on the platform whose job
// failed. The job names and files are ones this repository's sweeps failed.
describe("the batch's confirm", () => {
  const batch = workflow(".github/workflows/infinitary-batch-checks.yml");
  const macJob = "Merge batch · Desktop checks / Merge batch · Parallel journeys (Mac)";
  const linuxJob =
    "Merge batch · Desktop checks / Merge batch · Integration tests (Linux; group 2/2)";
  const confirm = (failed_jobs: string) => ({
    inputs: { failed_jobs, failed_files: "knowledge-references.spec.ts" },
  });

  it("runs only the confirm, and the sweep, the critical path and the startup fixtures skip", () => {
    for (const id of ["sweep", "critical-path", "startup"]) {
      expect(workflowValue(batch.jobs[id]!.if!, confirm(macJob)), id).toBe(false);
      expect(workflowValue(batch.jobs[id]!.if!, confirm("")), id).toBe(true);
    }
    expect(workflowValue(batch.jobs.confirm!.if!, confirm(macJob))).toBe(true);
    expect(workflowValue(batch.jobs.confirm!.if!, confirm(""))).toBe(false);
  });

  it("confirms on each platform whose job failed, on the machines the sweep took", () => {
    const platforms = (failed: string) =>
      workflowValue(
        String(
          (batch.jobs.confirm as { strategy: { matrix: { platform: string } } }).strategy.matrix
            .platform,
        ),
        confirm(failed),
      );
    expect(platforms(macJob)).toEqual(["mac"]);
    expect(platforms(linuxJob)).toEqual(["linux"]);
    expect(platforms(`${linuxJob}\n${macJob}`)).toEqual(["linux", "mac"]);
    const vars = {
      MAC_QUEUES: JSON.stringify({
        split: "mini-mac-split",
        release_split: "mini-mac-release-split",
      }),
    };
    const runsOn = String(batch.jobs.confirm!["runs-on"]);
    expect(workflowString(runsOn, { matrix: { platform: "mac" }, vars })).toBe(
      "mini-mac-release-split",
    );
    expect(workflowString(runsOn, { matrix: { platform: "linux" }, vars })).toBe("ubuntu-24.04");
  });

  it("finds each failed file as the logs name it, and runs Vitest files and journeys by their lanes", () => {
    const files = confirmFiles([
      "src/core/freeze/freezeRecorder.integration.test.ts",
      "knowledge-references.spec.ts",
    ]);
    expect(files).toEqual([
      "src/core/freeze/freezeRecorder.integration.test.ts",
      "tests/e2e/knowledge-references.spec.ts",
    ]);
    expect(() => confirmFiles(["tests/gone.test.ts"])).toThrow(/not in the composed batch/);
    const round = confirmRound(files, ["--workers=4"]);
    expect(round[0]).toEqual(["test", "src/core/freeze/freezeRecorder.integration.test.ts"]);
    expect(round[1]).toContain("--project=desktop");
    expect(round[2]).toEqual(
      expect.arrayContaining(["--project=application", "--workers=4", "--retries", "0"]),
    );
    expect(
      round
        .slice(1)
        .every((command) => command.at(-1) === "tests/e2e/knowledge-references.spec.ts"),
    ).toBe(true);
    expect(confirmRound(["src/core/freeze/freezeRecorder.integration.test.ts"])).toHaveLength(1);
  });
});

describe("every batch check composes the batch with the shipped step", () => {
  const verify = workflow(".github/workflows/verify.yml");
  const journeys = workflow(".github/workflows/source-journeys.yml");

  it("passes the batch to every Linux journey shard and composes it in each lane, group and shard", () => {
    expect(verify.jobs["linux-e2e"]!.with).toMatchObject({
      batch: "${{ inputs.batch || '' }}",
      batch_tree: "${{ inputs.batch_tree || '' }}",
    });
    for (const job of [
      verify.jobs.lane!,
      verify.jobs["linux-tests"]!,
      journeys.jobs["source-desktop"]!,
    ]) {
      const step = compose(job);
      expect(workflowValue(step.if!, { inputs: { batch: `917:${pr917.head}` } })).toBe(true);
      expect(workflowValue(step.if!, { inputs: {} })).toBe(false);
      expect(step.run).toBe(
        'bash .github/actions/infinitary-batch/compose.sh apply "$BASE" "$TREE" $HEADS',
      );
      expect(step.env).toEqual({
        HEADS: "${{ inputs.batch }}",
        BASE: "${{ inputs.ref }}",
        TREE: "${{ inputs.batch_tree }}",
      });
    }
  });
});

describe("main.yml's sort", () => {
  const main = workflow(".github/workflows/main.yml");
  const needs = (kind: string, result = "success") => ({
    needs: { sort: { result, outputs: { kind, batch: "41600000001" } } },
  });
  const runs = (kind: string, result?: string, cancelled = false) =>
    workflowValue(main.jobs.verify!.if!, needs(kind, result), {
      success: !cancelled,
      failure: false,
      always: true,
      cancelled,
    });

  it("runs the full check unless the push is covered or a batch is landing", () => {
    expect(runs("full")).toBe(true);
    expect(runs("covered")).toBe(false);
    // A landing push cancels its own run.
    expect(runs("landing", "success", true)).toBe(false);
    // A sort that failed leaves the full check to run.
    expect(runs("", "failure")).toBe(true);
  });

  it("names the covering batch run in a job of its own", () => {
    const covered = main.jobs.covered!;
    expect(workflowValue(covered.if!, needs("covered"))).toBe(true);
    expect(workflowValue(covered.if!, needs("full"))).toBe(false);
    const name = workflowString(covered.name!, {
      ...needs("covered"),
      github: { event_name: "push" },
    });
    expect(name).toBe("Main push · Covered by batch run 41600000001");
    expect(legacyJobName(name)).toBe("covered by batch 41600000001");
  });
});
