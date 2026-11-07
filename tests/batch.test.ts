import { describe, expect, it } from "vitest";
import type { BatchJob, BatchRun, DispatchedRun } from "../scripts/batch.mjs";
import {
  formBatch,
  inBatch,
  passed,
  QUEUE,
  readMainPush,
  readQueueStatus,
  readRuns,
  rerunOf,
  sortMainPush,
  verdict,
  WAITING,
} from "../scripts/batch.mjs";
import { legacyJobName } from "../scripts/ci-job-names.mjs";
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
    // Its first attempt failed and its verdict asked for the rerun.
    expect(
      formBatch(
        entries,
        run({
          status: "completed",
          run_attempt: 1,
          conclusion: "failure",
          verdict: { name: verdictName(), status: "completed", conclusion: "success" },
        }),
      ).action,
    ).toBe("wait");
    // Its rerun ended without writing a verdict: its change waits again.
    const freed = formBatch(
      entries,
      run({ status: "completed", run_attempt: 2, conclusion: "failure" }),
    );
    expect(freed.action).toBe("sweep");
    expect(freed.members.map((member) => member.number)).toEqual([931, 930]);
  });

  // A first attempt can fail before its verdict asks for the rerun: the
  // verdict job itself fails, or compose's mark step fails after writing "In
  // batch run N", so no later job runs. Nothing then starts the rerun, and a
  // run that kept its changes would hold every batch back for good.
  it("frees a first attempt that failed without its verdict asking for the rerun", () => {
    const entries = [
      entry(
        930,
        readQueueStatus([status("pending", inBatch(41_600_000_001), "2026-11-03T21:00:00Z")]),
      ),
      entry(931, readQueueStatus([approved("2026-11-03T20:31:00Z")])),
    ];
    const failedFirst = (verdict: BatchJob | null) =>
      new Map<number, BatchRun>([
        [
          41_600_000_001,
          {
            id: 41_600_000_001,
            status: "completed",
            run_attempt: 1,
            conclusion: "failure",
            verdict,
          },
        ],
      ]);
    for (const verdictJob of [
      { name: verdictName(), status: "completed", conclusion: "failure" },
      { name: SKIPPED_VERDICT, status: "completed", conclusion: "skipped" },
      null,
    ]) {
      const plan = formBatch(entries, failedFirst(verdictJob));
      expect(plan.action, verdictJob?.conclusion ?? "no verdict job").toBe("sweep");
      expect(plan.members.map((member) => member.number)).toEqual([931, 930]);
    }
  });

  // The verdict's rerun request is a run of its own, and it can fail before
  // the rerun starts: GitHub unreachable past its retries, or its time limit.
  // Nothing then starts the rerun, so a run that kept its changes would hold
  // every batch back until someone started the rerun by hand.
  it("frees a run whose rerun request ended without starting the rerun", () => {
    const entries = [
      entry(
        930,
        readQueueStatus([status("pending", inBatch(41_600_000_001), "2026-11-03T21:00:00Z")]),
      ),
      entry(931, readQueueStatus([approved("2026-11-03T20:31:00Z")])),
    ];
    const asked = (rerun: DispatchedRun | null) =>
      new Map<number, BatchRun>([
        [
          41_600_000_001,
          {
            id: 41_600_000_001,
            status: "completed",
            run_attempt: 1,
            conclusion: "failure",
            verdict: { name: verdictName(), status: "completed", conclusion: "success" },
            rerun,
          },
        ],
      ]);
    const request = (status: string, conclusion: string | null): DispatchedRun => ({
      id: 41_600_000_101,
      run_number: 12,
      display_title: rerunOf(41_600_000_001),
      status,
      conclusion,
    });
    // Not listed yet, waiting for the attempt to end, or the rerun started.
    for (const rerun of [
      null,
      request("queued", null),
      request("in_progress", null),
      request("completed", "success"),
    ])
      expect(formBatch(entries, asked(rerun)).action, rerun?.status ?? "not listed").toBe("wait");
    for (const conclusion of ["failure", "timed_out", "cancelled"]) {
      const plan = formBatch(entries, asked(request("completed", conclusion)));
      expect(plan.action, conclusion).toBe("sweep");
      expect(plan.members.map((member) => member.number)).toEqual([931, 930]);
    }
  });

  it("does nothing when no change waits", () => {
    expect(formBatch([entry(932, null)], new Map()).action).toBe("none");
  });
});

// The jobs of a first attempt, as GitHub lists them: main's batch run
// 42256632762 listed a verdict job that never ran under its unevaluated name.
const SKIPPED_VERDICT =
  "inputs.rehearsal != '' && format('Requested batch rehearsal · Batch report (tree {0})', needs.compose.outputs.tree) || format('Merge batch · Batch verdict (tree {0})', needs.compose.outputs.tree)";
/** The name batch.yml gives a merge batch's verdict job that ran. */
const verdictName = () =>
  workflowString(String(workflow(".github/workflows/batch.yml").jobs.verdict?.name), {
    github: { event_name: "push" },
    inputs: {},
    needs: { compose: { outputs: { tree: pr917.tree } } },
  });
const job = (name: string, conclusion: string) => ({
  name,
  status: "completed",
  conclusion,
  run_attempt: 1,
});

describe("reading the batch runs the queue names", () => {
  const runId = (n: number) => 41_600_000_000 + n;
  const began = "2026-11-03T21:00:00Z";
  /**
   * GitHub as readRuns reads it: each run's readings in turn (the last one
   * repeats), each first attempt's jobs, and batch.yml's runs started by
   * dispatch, newest first.
   */
  const githubOf = (
    runs: Record<number, Omit<BatchRun, "id"> | Omit<BatchRun, "id">[]>,
    attemptJobs: Record<number, ReturnType<typeof job>[]>,
    dispatched: DispatchedRun[] = [],
  ) => {
    const jobReads: { run_id: number; attempt_number: number }[] = [];
    const runReads: number[] = [];
    const listReads: Record<string, unknown>[] = [];
    const github = {
      rest: {
        actions: {
          getWorkflowRun: async ({ run_id }: { run_id: number }) => {
            const readings = [runs[run_id]].flat();
            const read = runReads.filter((id) => id === run_id).length;
            runReads.push(run_id);
            return {
              data: {
                id: run_id,
                path: ".github/workflows/batch.yml",
                created_at: began,
                ...readings[Math.min(read, readings.length - 1)],
              },
            };
          },
          listJobsForWorkflowRunAttempt: "attempt jobs",
          listWorkflowRuns: "workflow runs",
        },
      },
      paginate: async (
        method: string,
        parameters: { run_id: number; attempt_number: number } & Record<string, unknown>,
      ) => {
        if (method === "workflow runs") {
          listReads.push(parameters);
          return dispatched;
        }
        expect(method).toBe("attempt jobs");
        jobReads.push({ run_id: parameters.run_id, attempt_number: parameters.attempt_number });
        return attemptJobs[parameters.run_id] ?? [];
      },
    };
    return { github, jobReads, runReads, listReads };
  };
  const inRun = (number: number, run: number) =>
    entry(number, readQueueStatus([status("pending", inBatch(run), "2026-11-03T21:00:00Z")]));
  const waiting = entry(940, readQueueStatus([approved("2026-11-03T20:31:00Z")]));

  it("holds a failed first attempt's changes only while its verdict asked for the rerun", async () => {
    const failed = { status: "completed", run_attempt: 1, conclusion: "failure" };
    const sweptRed = [
      job("Merge batch · Compose the batch", "success"),
      job("Merge batch · Desktop checks / Merge batch · Code checks and build (Linux)", "success"),
      job("Merge batch · Desktop checks / Merge batch · Parallel journeys (Mac)", "failure"),
      job(
        "Merge batch · Critical-path journey / Merge batch · Selected app journeys (Linux; serial)",
        "success",
      ),
    ];
    const { github, jobReads } = githubOf(
      { [runId(1)]: failed, [runId(2)]: failed, [runId(3)]: failed },
      {
        [runId(1)]: [...sweptRed, job(verdictName(), "success")],
        [runId(2)]: [...sweptRed, job(verdictName(), "failure")],
        // Compose's mark step wrote "In batch run N", then failed.
        [runId(3)]: [
          job("Merge batch · Compose the batch", "failure"),
          job("Merge batch · Desktop checks", "skipped"),
          job("Merge batch · Critical-path journey", "skipped"),
          job(SKIPPED_VERDICT, "skipped"),
        ],
      },
    );
    const read = async (run: number) => {
      const entries = [inRun(930, run), waiting];
      return formBatch(entries, await readRuns(github, repo, entries));
    };
    expect(await read(runId(1))).toMatchObject({ action: "wait" });
    expect((await read(runId(2))).members.map((member) => member.number)).toEqual([940, 930]);
    expect((await read(runId(3))).members.map((member) => member.number)).toEqual([940, 930]);
    // Attempt 1's own jobs, so a rerun that starts meanwhile hides nothing.
    expect(jobReads).toEqual([
      { run_id: runId(1), attempt_number: 1 },
      { run_id: runId(2), attempt_number: 1 },
      { run_id: runId(3), attempt_number: 1 },
    ]);
  });

  it("reads no jobs of a run that sweeps or whose rerun ended", async () => {
    const { github, jobReads } = githubOf(
      {
        [runId(4)]: { status: "in_progress", run_attempt: 1, conclusion: null },
        [runId(5)]: { status: "completed", run_attempt: 2, conclusion: "failure" },
      },
      {},
    );
    const entries = [inRun(930, runId(4)), inRun(931, runId(5)), waiting];
    const runs = await readRuns(github, repo, entries);
    expect(formBatch(entries, runs)).toMatchObject({ action: "wait" });
    expect(formBatch([inRun(931, runId(5)), waiting], runs).action).toBe("sweep");
    expect(jobReads).toEqual([]);
  });

  // batch.yml names each rerun request after its batch run, so the newest
  // run so named tells whether the rerun its verdict asked for can still start.
  it("frees a run once the newest request for its rerun ended without starting it", async () => {
    const failed = { status: "completed", run_attempt: 1, conclusion: "failure" };
    const asked = [
      job("Merge batch · Compose the batch", "success"),
      job(verdictName(), "success"),
    ];
    const dispatched = (
      run: number,
      run_number: number,
      status: string,
      conclusion: string | null,
    ) => ({
      id: 41_700_000_000 + run_number,
      run_number,
      display_title: rerunOf(run),
      status,
      conclusion,
    });
    const { github, runReads, listReads } = githubOf(
      {
        [runId(7)]: failed,
        [runId(8)]: failed,
        // The request failed after GitHub had started the rerun.
        [runId(9)]: [failed, { status: "in_progress", run_attempt: 2, conclusion: null }],
      },
      { [runId(7)]: asked, [runId(8)]: asked, [runId(9)]: asked },
      [
        { ...dispatched(runId(8), 34, "completed", "success"), display_title: "batch" },
        // A request for run 8 started again by hand after the first one failed.
        dispatched(runId(8), 33, "in_progress", null),
        dispatched(runId(9), 32, "completed", "failure"),
        dispatched(runId(8), 31, "completed", "failure"),
        dispatched(runId(7), 30, "completed", "failure"),
      ],
    );
    const read = async (run: number) => {
      const entries = [inRun(930, run), waiting];
      return formBatch(entries, await readRuns(github, repo, entries));
    };
    expect((await read(runId(7))).members.map((member) => member.number)).toEqual([940, 930]);
    expect(await read(runId(8))).toMatchObject({ action: "wait" });
    expect(await read(runId(9))).toMatchObject({ action: "wait" });
    // Only the runs batch.yml started by dispatch since the batch run began.
    for (const parameters of listReads)
      expect(parameters).toEqual({
        ...repo,
        workflow_id: "batch.yml",
        event: "workflow_dispatch",
        created: `>=${began}`,
        per_page: 100,
      });
    expect(listReads).toHaveLength(3);
    // A failed request's run is read again; one still running needs no second read.
    expect(runReads).toEqual([runId(7), runId(7), runId(8), runId(9), runId(9)]);
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
    current.set(931, {
      head: "931".padEnd(40, "1"),
      queue: readQueueStatus([approved("2026-11-03T21:30:00Z")]),
    });
    const pushedAgain = verdict({ ...base, attempt: 2, swept: "failure", current });
    expect(pushedAgain.writes.map((write) => [write.number, write.state])).toEqual([
      [932, "failure"],
      [930, "pending"],
    ]);
    current.set(932, {
      head: members[2]!.head,
      queue: readQueueStatus([status("failure", "Sent back", "2026-11-03T21:30:00Z")]),
    });
    const plan = verdict({ ...base, attempt: 2, swept: "failure", current });
    expect(plan.next).toBe("sweep");
    expect(plan.writes.map((write) => [write.number, write.state, write.description])).toEqual([
      [930, "pending", WAITING],
    ]);
  });

  // INF-2921: batch run 42309370568 swept #1166 first and four more changes;
  // its triage crewmate sent #1166 back by hand while the sweep ran, and the
  // verdict would have rerun the same files and then failed #1171, the last.
  it("takes a change sent back by hand as a red sweep's answer: the rest sweep again, with no rerun", () => {
    const at = { approval: "2026-11-03T20:00:00Z", batch: "2026-11-03T21:00:00Z" };
    const marked = (number: number, approval: string) => ({
      number,
      head: members.find((member) => member.number === number)!.head,
      statuses: [status("pending", inBatch(runId), at.batch), approved(approval)],
    });
    const queue = [
      marked(930, "2026-11-03T20:00:00Z"),
      marked(931, "2026-11-03T20:10:00Z"),
      marked(932, "2026-11-03T20:20:00Z"),
    ];
    queue[0]!.statuses.unshift(
      status("failure", "Fails tests/crewmate-fixed-context.test.ts", "2026-11-03T21:30:00Z"),
    );
    const current = new Map(
      queue.map((entry) => [
        entry.number,
        { head: entry.head, queue: readQueueStatus(entry.statuses) },
      ]),
    );
    for (const attempt of [1, 2]) {
      const failedJob = {
        name: "Unit tests (Linux; group 3/3)",
        html_url: `${runUrl(runId)}/job/1`,
      };
      const plan = verdict({ ...base, attempt, swept: "failure", current, failedJob });
      expect(plan.next).toBe("sweep");
      expect(plan.writes.map((write) => [write.number, write.state, write.description])).toEqual([
        [931, "pending", WAITING],
        [932, "pending", WAITING],
      ]);
      expect(plan.summary).toContain("#930 went back by hand");
    }

    // The next batch, which the verdict starts, sweeps the rest in approval order without #930.
    const plan = verdict({ ...base, attempt: 1, swept: "failure", current });
    const entries = queue.map((entry) => {
      const write = plan.writes.find((candidate) => candidate.number === entry.number);
      const statuses = write
        ? [status(write.state, write.description, "2026-11-03T22:00:00Z"), ...entry.statuses]
        : entry.statuses;
      return { number: entry.number, head: entry.head, queue: readQueueStatus(statuses) };
    });
    expect(entries[1]!.queue).toMatchObject({ kind: "waiting", since: "2026-11-03T20:10:00Z" });
    expect(formBatch(entries, new Map())).toMatchObject({
      action: "sweep",
      members: [
        { number: 931, head: members[1]!.head },
        { number: 932, head: members[2]!.head },
      ],
    });

    // A green sweep still passes the changes left in it.
    const green = verdict({ ...base, attempt: 1, swept: "success", current });
    expect(green.writes.map((write) => [write.number, write.state])).toEqual([
      [931, "success"],
      [932, "success"],
    ]);
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
  steps?: { uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }[];
};
const workflow = (path: string) =>
  loadYamlFile(path) as {
    "run-name"?: string;
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

  // The verdict asks for the rerun by starting batch.yml with `rerun` set to
  // its own run; the next batch finds that request by the name it carries.
  it("names a rerun's run after the batch run it reruns, and leaves every other run GitHub's name", () => {
    const runName = (context: Record<string, unknown>) =>
      workflowString(String(batch["run-name"]), context);
    expect(
      runName(
        contexts("workflow_dispatch", {}, { rehearsal: "", send_back: "", rerun: "41600000001" }),
      ),
    ).toBe(rerunOf(41_600_000_001));
    // An empty name is GitHub's cue to name the run itself.
    for (const context of [
      contexts("status", { context: QUEUE, state: "pending" }),
      contexts("push"),
      contexts("workflow_dispatch", {}, { rehearsal: "", send_back: "", rerun: "" }),
      contexts("workflow_dispatch", {}, { rehearsal: "930 931", send_back: "", rerun: "" }),
    ])
      expect(runName(context)).toBe("");
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

  // INF-2507, and the captain on INF-2508: "the e2e journey + browser tests
  // should all run during the sweep batch". The critical path runs on the
  // composed batch in a job of its own, so it stays in the batch's check
  // whatever part of the full check the sweep runs; it is the same journey
  // every pull request runs (ci.yml's call), on the commit the sweep composes.
  it("runs the critical path on the composed batch, on hosted Linux, in a job of its own", () => {
    const job = batch.jobs["critical-path"];
    const sweep = batch.jobs.sweep;
    const pullRequest = workflow(".github/workflows/ci.yml").jobs["critical-path"];
    expect(job?.uses).toBe("./.github/workflows/source-journeys.yml");
    expect(job?.needs).toBe("compose");
    expect(job?.if).toBe(sweep?.if);
    expect(job?.with).toMatchObject({
      ref: sweep?.with?.ref,
      batch: sweep?.with?.batch,
      batch_tree: sweep?.with?.batch_tree,
      hosted: true,
      suite: pullRequest?.with?.suite,
      lane: pullRequest?.with?.lane,
      files: pullRequest?.with?.files,
    });
    const journeys = workflow(".github/workflows/source-journeys.yml").jobs["source-desktop"] as {
      "runs-on": string;
    };
    const vars = { LINUX_RUNNER: "shell-pc-linux" };
    expect(workflowString(journeys["runs-on"], { inputs: job?.with, vars })).toBe("ubuntu-24.04");
  });

  it("passes a batch only when its sweep and its critical path both passed", () => {
    const job = batch.jobs.verdict;
    expect(job?.needs).toEqual(expect.arrayContaining(["sweep", "critical-path"]));
    const script = job?.steps?.find((step) => step.uses?.startsWith("actions/github-script@"));
    const swept = (sweep: string, criticalPath: string) =>
      workflowValue(script?.env?.SWEPT ?? "", {
        needs: { sweep: { result: sweep }, "critical-path": { result: criticalPath } },
      });
    expect(swept("success", "success")).toBe("success");
    expect(swept("success", "failure")).toBe("failure");
    expect(swept("failure", "success")).toBe("failure");
    expect(swept("failure", "failure")).toBe("failure");
  });

  it("names its verdict by the swept tree, and a rehearsal never as a verdict", () => {
    // Trigger first (docs/testing.md, "CI job names"); the alpha's proof reads
    // the verdict by the name it had before (scripts/ci-job-names.mjs).
    const name = batch.jobs.verdict!.name!;
    const verdict = workflowString(name, contexts("push"));
    expect(verdict).toBe(`Merge batch · Batch verdict (tree ${pr917.tree})`);
    expect(legacyJobName(verdict)).toBe(`verdict (tree ${pr917.tree})`);
    const rehearsal = workflowString(name, contexts("workflow_dispatch", {}, { rehearsal: "930" }));
    expect(rehearsal).toBe(`Requested batch rehearsal · Batch report (tree ${pr917.tree})`);
    expect(legacyJobName(rehearsal)).not.toMatch(/^verdict/);
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
    const name = workflowString(covered.name!, {
      ...needs("covered"),
      github: { event_name: "push" },
    });
    expect(name).toBe("Main push · Covered by batch run 41600000001");
    expect(legacyJobName(name)).toBe("covered by batch 41600000001");
  });
});
