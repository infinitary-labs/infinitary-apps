import { describe, expect, it } from "vitest";
import { readMainPush, readQueueStatus, sortMainPush } from "../scripts/batch.mjs";
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

  it("reads files that are exactly a green batch's as covered", () => {
    expect(sortMainPush({ tree: pr917.tree, queue: green, open: [] })).toEqual({
      kind: "covered",
      run: 41_600_000_001,
    });
  });

  it("reads a batch partly merged as landing, and anything else as the full check", () => {
    const open = [entry(931, green)];
    expect(sortMainPush({ tree: other, queue: green, open })).toEqual({
      kind: "landing",
      run: 41_600_000_001,
    });
    // Every change merged, yet main's files differ from the sweep's.
    expect(sortMainPush({ tree: other, queue: green, open: [] })).toEqual({ kind: "full" });
    // A merge outside the queue.
    expect(sortMainPush({ tree: pr917.tree, queue: null, open })).toEqual({ kind: "full" });
  });

  it("reads the pushed commit's pull request and its queue state from GitHub", async () => {
    const statuses: Record<string, unknown[]> = {
      [pr917.head]: [status("success", passed(41_600_000_001, pr917.tree), "2026-11-03T20:49:00Z")],
      [other]: [status("success", passed(41_600_000_001, pr917.tree), "2026-11-03T20:49:00Z")],
    };
    const github = {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async ({ commit_sha }: { commit_sha: string }) => ({
            data: [
              { number: 917, merge_commit_sha: pr917.merge, head: { sha: pr917.head } },
            ].filter(() => commit_sha === pr917.merge),
          }),
          listCommitStatusesForRef: "statuses",
        },
        pulls: { list: "pulls" },
      },
      paginate: async (method: string, parameters: { ref?: string }) =>
        method === "statuses" ? (statuses[parameters.ref!] ?? []) : open,
    };
    let open = [{ number: 935, head: { sha: other }, base: { ref: "main" } }];
    expect(await readMainPush(github, repo, { sha: pr917.merge, tree: other })).toEqual({
      kind: "landing",
      run: 41_600_000_001,
    });
    open = [];
    expect(await readMainPush(github, repo, { sha: pr917.merge, tree: pr917.tree })).toEqual({
      kind: "covered",
      run: 41_600_000_001,
    });
    expect(await readMainPush(github, repo, { sha: other, tree: pr917.tree })).toEqual({
      kind: "full",
    });
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
    expect(Object.keys(queue.jobs.checks?.with ?? {}).sort()).toEqual(
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

  it("passes only once the sweep and the critical path both passed, and names the tree they built", () => {
    const job = batch.jobs.passed!;
    expect(job.needs).toEqual(["sweep", "critical-path"]);
    expect(job.if).toBeUndefined();
    // Trigger first (docs/testing.md, "CI job names"); the alpha's proof
    // reads it under the queue's checks job (scripts/main-alpha-proof.mjs).
    const name = workflowString(job.name!, { inputs });
    expect(name).toBe(`Merge batch · Batch passed (tree ${pr917.tree})`);
    expect(legacyJobName(name)).toBe(`Batch passed (tree ${pr917.tree})`);
  });
});

describe("every batch check composes the batch with the shipped step", () => {
  const verify = workflow(".github/workflows/verify.yml");
  const journeys = workflow(".github/workflows/source-journeys.yml");
  const compose = (job: Job) => job.steps!.find((step) => step.name === "Compose the batch")!;

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
