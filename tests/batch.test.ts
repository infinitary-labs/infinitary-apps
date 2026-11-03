import { describe, expect, it } from "vitest";
import type { BatchRun } from "../scripts/batch.mjs";
import {
  formBatch,
  inBatch,
  passed,
  QUEUE,
  readMainPush,
  readQueueStatus,
  sortMainPush,
  verdict,
  WAITING,
} from "../scripts/batch.mjs";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows.ts";

// INF-2430 piece 3, the captain's approved plan for the swept batch, and the
// captain's answer on red batches: "can we just only rerun failed jobs? if it
// failed again, treat it as failed by the last PR in the batch and require it
// to fix the flake". The readings follow GitHub's answers: a commit status
// list, newest first, and pull request 917 as /commits/{sha}/pulls returned it
// for main's commit c44de17a0 (head, merge commit and tree from git).
const repo = { owner: "infinitary-labs", repo: "infinitary" };
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
const approved = (at: string) => status("pending", WAITING, at);
const pr917 = {
  number: 917,
  head: "aaed595636182b00423e6bcad8db17993c21a3fc",
  merge: "c44de17a00c806b83a81f75fe666c0dae2ea53d2",
  tree: "be6452e81a110b0c50d7354add8d59a231807cce",
};
const other = "a083c89250edd8db67364636d44e2f53dd84c23b";

describe("reading a change's queue state", () => {
  it("reads the app's approval mark as waiting, from when the approval began", () => {
    const queue = readQueueStatus([
      status("success", "typecheck-lint-build", "2026-11-03T20:40:00Z", "ci"),
      approved("2026-11-03T20:30:00Z"),
    ]);
    expect(queue).toMatchObject({ kind: "waiting", since: "2026-11-03T20:30:00Z" });
  });

  it("orders a change by its approval, not by the batch's later mark", () => {
    const queue = readQueueStatus([
      status("pending", inBatch(41_600_000_001), "2026-11-03T21:00:00Z"),
      approved("2026-11-03T20:30:00Z"),
      status("failure", "Conflicts with main: bring the branch up to date", "2026-11-03T19:00:00Z"),
    ]);
    expect(queue).toMatchObject({
      kind: "in-batch",
      run: 41_600_000_001,
      since: "2026-11-03T20:30:00Z",
    });
  });

  it("reads a pass with its batch run and tree, and any failure as sent back", () => {
    expect(
      readQueueStatus([
        status("success", passed(41_600_000_001, pr917.tree, true), "2026-11-03T22:00:00Z"),
      ]),
    ).toMatchObject({ kind: "passed", run: 41_600_000_001, tree: pr917.tree });
    expect(
      readQueueStatus([status("failure", "Too risky today", "2026-11-03T22:00:00Z")]),
    ).toMatchObject({
      kind: "failed",
    });
    expect(
      readQueueStatus([status("success", "Linux checks", "2026-11-03T22:00:00Z", "ci")]),
    ).toBeNull();
  });
});

const entry = (
  number: number,
  queue: ReturnType<typeof readQueueStatus>,
  head = `${number}`.padEnd(40, "0"),
) => ({
  number,
  head,
  queue,
});

describe("forming a batch", () => {
  it("takes every waiting change in approval order", () => {
    const plan = formBatch(
      [
        entry(931, readQueueStatus([approved("2026-11-03T20:31:00Z")])),
        entry(930, readQueueStatus([approved("2026-11-03T20:35:00Z")])),
        entry(932, null),
        entry(933, readQueueStatus([status("failure", "Sent back", "2026-11-03T20:00:00Z")])),
      ],
      new Map(),
    );
    expect(plan.action).toBe("sweep");
    expect(plan.members.map((member) => member.number)).toEqual([931, 930]);
  });

  it("waits while a green batch is still merging", () => {
    const plan = formBatch(
      [
        entry(
          930,
          readQueueStatus([
            status("success", passed(41_600_000_001, pr917.tree), "2026-11-03T21:00:00Z"),
          ]),
        ),
        entry(931, readQueueStatus([approved("2026-11-03T20:31:00Z")])),
      ],
      new Map(),
    );
    expect(plan).toMatchObject({ action: "wait", members: [] });
  });

  it("waits while a batch run sweeps or waits for its one rerun, and frees a run that ended", () => {
    const entries = [
      entry(
        930,
        readQueueStatus([status("pending", inBatch(41_600_000_001), "2026-11-03T21:00:00Z")]),
      ),
      entry(931, readQueueStatus([approved("2026-11-03T20:31:00Z")])),
    ];
    const run = (fields: Omit<BatchRun, "id">) =>
      new Map<number, BatchRun>([[41_600_000_001, { id: 41_600_000_001, ...fields }]]);
    expect(
      formBatch(entries, run({ status: "in_progress", run_attempt: 1, conclusion: null })).action,
    ).toBe("wait");
    expect(
      formBatch(entries, run({ status: "completed", run_attempt: 1, conclusion: "failure" }))
        .action,
    ).toBe("wait");
    // Its rerun ended without writing a verdict: its change waits again.
    const freed = formBatch(
      entries,
      run({ status: "completed", run_attempt: 2, conclusion: "failure" }),
    );
    expect(freed.action).toBe("sweep");
    expect(freed.members.map((member) => member.number)).toEqual([931, 930]);
  });

  it("does nothing when no change waits", () => {
    expect(formBatch([entry(932, null)], new Map()).action).toBe("none");
  });
});

describe("the sweep's verdict", () => {
  const runId = 41_600_000_001;
  const members = [
    { number: 930, head: "930".padEnd(40, "0") },
    { number: 931, head: "931".padEnd(40, "0") },
    { number: 932, head: "932".padEnd(40, "0") },
  ];
  const inThisRun = () =>
    new Map(
      members.map((member) => [
        member.number,
        {
          head: member.head,
          queue: readQueueStatus([status("pending", inBatch(runId), "2026-11-03T21:00:00Z")]),
        },
      ]),
    );
  const base = { runId, runUrl: runUrl(runId), tree: pr917.tree, members };

  it("marks every change green with the batch's tree", () => {
    const plan = verdict({ ...base, attempt: 1, swept: "success", current: inThisRun() });
    expect(plan.next).toBeNull();
    expect(plan.writes.map((write) => [write.number, write.state])).toEqual([
      [930, "success"],
      [931, "success"],
      [932, "success"],
    ]);
    expect(
      readQueueStatus([status("success", plan.writes[0]!.description, "2026-11-03T22:00:00Z")]),
    ).toMatchObject({
      kind: "passed",
      run: runId,
      tree: pr917.tree,
    });
  });

  it("reruns only the failed jobs once, marking nothing", () => {
    const plan = verdict({ ...base, attempt: 1, swept: "failure", current: inThisRun() });
    expect(plan).toMatchObject({ writes: [], next: "rerun" });
  });

  it("merges the batch when the rerun passes, and says the first failure still needs an owner", () => {
    const plan = verdict({ ...base, attempt: 2, swept: "success", current: inThisRun() });
    expect(plan.writes.every((write) => write.state === "success")).toBe(true);
    expect(plan.writes[0]!.description).toContain("after a rerun");
    expect(plan.summary).toContain("owner");
  });

  it("sends the batch's last change back after a second failure, and the rest sweep again", () => {
    const failedJob = {
      name: "sweep / linux-e2e / journeys (parallel 2/4)",
      html_url: `${runUrl(runId)}/job/120000000001`,
    };
    const plan = verdict({
      ...base,
      attempt: 2,
      swept: "failure",
      current: inThisRun(),
      failedJob,
    });
    expect(plan.next).toBe("sweep");
    expect(plan.writes[0]).toMatchObject({
      number: 932,
      state: "failure",
      url: failedJob.html_url,
    });
    expect(plan.writes[0]!.description).toContain("journeys (parallel 2/4) failed twice");
    expect(plan.writes[0]!.description.length).toBeLessThanOrEqual(140);
    expect(
      plan.writes.slice(1).map((write) => [write.number, write.state, write.description]),
    ).toEqual([
      [930, "pending", WAITING],
      [931, "pending", WAITING],
    ]);
  });

  it("leaves alone a change sent back by hand or pushed again during the sweep", () => {
    const current = inThisRun();
    current.set(932, {
      head: members[2]!.head,
      queue: readQueueStatus([status("failure", "Sent back", "2026-11-03T21:30:00Z")]),
    });
    current.set(931, {
      head: "931".padEnd(40, "1"),
      queue: readQueueStatus([approved("2026-11-03T21:30:00Z")]),
    });
    const plan = verdict({ ...base, attempt: 2, swept: "failure", current });
    expect(plan.writes.map((write) => [write.number, write.state])).toEqual([[930, "failure"]]);
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
    let open = [{ number: 935, head: { sha: other } }];
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
  with?: Record<string, unknown>;
  steps?: { uses?: string; with?: Record<string, unknown> }[];
};
const workflow = (path: string) =>
  loadYamlFile(path) as {
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
  };

describe("batch.yml", () => {
  const batch = workflow(".github/workflows/batch.yml");
  const contexts = (event_name: string, event: object = {}, inputs: object = {}) => ({
    github: { event_name, event, run_id: 41_600_000_009 },
    inputs,
    needs: { compose: { outputs: { sweep: "true", tree: pr917.tree } } },
  });
  const group = (context: Record<string, unknown>) =>
    workflowValue(batch.concurrency.group, context);

  it("runs one batch at a time, and keeps other statuses and by-hand helpers out of its line", () => {
    expect(group(contexts("status", { context: QUEUE, state: "pending" }))).toBe("batch");
    expect(group(contexts("push"))).toBe("batch");
    expect(
      group(contexts("workflow_dispatch", {}, { rehearsal: "", send_back: "", rerun: "" })),
    ).toBe("batch");
    expect(group(contexts("status", { context: "ci", state: "success" }))).toBe(
      "batch-other-41600000009",
    );
    expect(group(contexts("workflow_dispatch", {}, { rehearsal: "930 931" }))).toBe(
      "batch-rehearsal-41600000009",
    );
    expect(group(contexts("workflow_dispatch", {}, { rerun: "41600000001" }))).toBe(
      "batch-rerun-41600000001",
    );
    expect(batch.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("forms a batch on an approval mark, a merge or a by-hand start, never on another status", () => {
    const compose = batch.jobs.compose!.if!;
    expect(workflowValue(compose, contexts("status", { context: QUEUE, state: "pending" }))).toBe(
      true,
    );
    expect(workflowValue(compose, contexts("status", { context: QUEUE, state: "success" }))).toBe(
      false,
    );
    expect(workflowValue(compose, contexts("status", { context: "ci", state: "pending" }))).toBe(
      false,
    );
    expect(workflowValue(compose, contexts("push"))).toBe(true);
    expect(
      workflowValue(compose, contexts("workflow_dispatch", {}, { send_back: "930", rerun: "" })),
    ).toBe(false);
    expect(
      workflowValue(
        compose,
        contexts("workflow_dispatch", {}, { send_back: "", rerun: "41600000001" }),
      ),
    ).toBe(false);
  });

  it("sweeps with the alpha's full check: hosted Linux, every journey, the Mac on the release check line", () => {
    const sweep = batch.jobs.sweep!;
    expect(sweep.uses).toBe("./.github/workflows/verify.yml");
    expect(sweep.with).toMatchObject({ hosted: true, all_journeys: true, profile: "stable" });
    const vars = {
      MAC_QUEUES: JSON.stringify({ check: "mini-mac-check", release_check: "mini-mac-release" }),
    };
    expect(workflowString(String(sweep.with!.mac_runner), { vars })).toBe("mini-mac-release");
    expect(Object.values(batch.jobs).some((job) => job.uses?.endsWith("/phone.yml"))).toBe(false);
  });

  // Main's first batch run, 41723213055, failed its compose step on one dropped
  // connection while reading an open pull request's statuses: github-script's
  // client reports a request that got no answer as status 500 "fetch failed",
  // and with github-script's default of no retries the whole run failed.
  it("retries a dropped connection in every GitHub call, so one lost answer fails no run", () => {
    const scripted = Object.entries(batch.jobs).flatMap(([job, { steps = [] }]) =>
      steps
        .filter((step) => step.uses?.startsWith("actions/github-script@"))
        .map((step) => ({ job, step })),
    );
    expect(scripted.map(({ job }) => job)).toContain("compose");
    for (const { job, step } of scripted) {
      expect(Number(step.with?.retries), job).toBeGreaterThan(0);
      const exempt = String(step.with?.["retry-exempt-status-codes"] ?? "").split(",");
      expect(exempt.map(Number), job).not.toContain(500);
    }
  });

  it("names its verdict by the swept tree, and a rehearsal never as a verdict", () => {
    const name = batch.jobs.verdict!.name!;
    expect(workflowString(name, contexts("push"))).toBe(`verdict (tree ${pr917.tree})`);
    expect(workflowString(name, contexts("workflow_dispatch", {}, { rehearsal: "930" }))).toBe(
      `rehearsal (tree ${pr917.tree})`,
    );
  });
});

describe("the sweep composes the batch in every job", () => {
  const verify = workflow(".github/workflows/verify.yml");
  const journeys = workflow(".github/workflows/source-journeys.yml");
  const compose = (job: { steps?: { name?: string; if?: string; run?: string }[] }) =>
    job.steps!.find((step) => step.name === "Compose the swept batch")!;

  it("passes the batch to every Linux journey shard and composes it in each lane and shard", () => {
    expect(verify.jobs["linux-e2e"]!.with).toMatchObject({
      batch: "${{ inputs.batch || '' }}",
      batch_tree: "${{ inputs.batch_tree || '' }}",
    });
    for (const job of [verify.jobs.lane!, journeys.jobs["source-desktop"]!] as never[]) {
      const step = compose(job);
      expect(workflowValue(step.if!, { inputs: { batch: `930:${pr917.head}` } })).toBe(true);
      expect(workflowValue(step.if!, { inputs: {} })).toBe(false);
      expect(step.run).toContain("scripts/batch-compose.sh apply");
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
    expect(workflowString(covered.name!, needs("covered"))).toBe("covered by batch 41600000001");
  });
});
