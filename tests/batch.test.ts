import { describe, expect, it } from "vitest";
import type { BatchRun } from "../scripts/batch.mjs";
import {
  failedTestFiles,
  formBatch,
  inBatch,
  passed,
  QUEUE,
  readCurrent,
  readFailedFiles,
  readMainPush,
  readOpenQueue,
  readQueueStatus,
  readRuns,
  resume,
  sortMainPush,
  verdict,
  WAITING,
} from "../scripts/batch.mjs";
import { legacyJobName } from "../scripts/ci-job-names.mjs";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows.ts";

// INF-2430 piece 3, the captain's approved plan for the swept batch, and the
// captain's fix-forward rule for red batches (INF-2948, direction 2):
// "whenever we meet a failure, we pause the sweeps until a fix arrives, then
// we rerun the sweep with everything queued + the fix, if there's another
// error, repeat". The readings follow GitHub's answers: a commit status
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
        // A pass written before the fix-forward queue, after its rerun.
        status(
          "success",
          `Passed batch run 41600000001 after a rerun; tree ${pr917.tree}`,
          "2026-11-03T22:00:00Z",
        ),
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
  base = "main",
) => ({
  number,
  head,
  base,
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

  // With no rerun, a batch run holds its changes only while it runs: one that
  // ended without writing its verdict, such as one whose compose step failed
  // after marking them, frees them for the next batch.
  it("waits while a batch run sweeps, and frees a run that ended", () => {
    const entries = [
      entry(
        930,
        readQueueStatus([status("pending", inBatch(41_600_000_001), "2026-11-03T21:00:00Z")]),
      ),
      entry(931, readQueueStatus([approved("2026-11-03T20:31:00Z")])),
    ];
    const run = (fields: Omit<BatchRun, "id">) =>
      new Map<number, BatchRun>([[41_600_000_001, { id: 41_600_000_001, ...fields }]]);
    expect(formBatch(entries, run({ status: "in_progress", conclusion: null })).action).toBe(
      "wait",
    );
    for (const conclusion of ["failure", "cancelled", "success"]) {
      const freed = formBatch(entries, run({ status: "completed", conclusion }));
      expect(freed.action, conclusion).toBe("sweep");
      expect(freed.members.map((member) => member.number)).toEqual([931, 930]);
    }
  });

  // INF-2948, direction 2: a red batch pauses the queue, and a change
  // approved meanwhile, such as the fix, waits with the paused ones.
  it("waits while a failed batch has paused the queue, whatever else waits", () => {
    const pausedAt = "2026-11-06T22:47:30Z";
    const plan = formBatch(
      [
        entry(
          1154,
          readQueueStatus([
            status(
              "pending",
              "Paused after batch run 42305850996; tests/e2e/card-leave.spec.ts failed; touched by #1154",
              pausedAt,
            ),
            approved("2026-11-06T22:10:00Z"),
          ]),
        ),
        entry(1190, readQueueStatus([approved("2026-11-06T23:05:00Z")])),
      ],
      new Map(),
    );
    expect(plan).toMatchObject({ action: "wait", members: [] });
    expect(plan.reason).toContain("Batch run 42305850996 failed");
  });

  // INF-2948: a change stacked on another change's branch would sweep its
  // base's commits too, so it waits until its base merges and GitHub points
  // it at main.
  it("leaves out a change that targets another branch until it targets main", () => {
    const stacked = (base: string) => [
      entry(1176, readQueueStatus([approved("2026-11-06T23:00:00Z")])),
      entry(1177, readQueueStatus([approved("2026-11-06T22:50:00Z")]), undefined, base),
    ];
    expect(formBatch(stacked("fm/task-6f0e1c2a"), new Map()).members).toEqual([
      { number: 1176, head: entry(1176, null).head },
    ]);
    expect(formBatch(stacked("main"), new Map()).members.map((member) => member.number)).toEqual([
      1177, 1176,
    ]);
  });

  it("does nothing when no change waits", () => {
    expect(formBatch([entry(932, null)], new Map()).action).toBe("none");
  });
});

describe("reading the queue and the batch runs it names", () => {
  // GitHub's /pulls list as readOpenQueue reads it, and each version's statuses.
  const pulls = [
    {
      number: 1176,
      head: { sha: "571679da4d9eef0a6061c7f20b4612df44715d79" },
      base: { ref: "main" },
    },
    {
      number: 1177,
      head: { sha: "204cba081ac081a141776190f926a2e722018f06" },
      base: { ref: "fm/task-6f0e1c2a" },
    },
  ];
  const statuses: Record<string, ReturnType<typeof status>[]> = {
    [pulls[0]!.head.sha]: [status("pending", inBatch(42_325_592_413), "2026-11-07T01:43:56Z")],
    [pulls[1]!.head.sha]: [approved("2026-11-07T01:28:40Z")],
  };
  const runReads: number[] = [];
  const github = {
    rest: {
      pulls: { list: "pulls" },
      repos: { listCommitStatusesForRef: "statuses" },
      actions: {
        getWorkflowRun: async ({ run_id }: { run_id: number }) => {
          runReads.push(run_id);
          return { data: { id: run_id, status: "in_progress", conclusion: null } };
        },
      },
    },
    paginate: async (method: string, parameters: { ref?: string }) =>
      method === "pulls" ? pulls : (statuses[parameters.ref!] ?? []),
  };

  it("reads each change's target branch, and only the runs that changes are in", async () => {
    const entries = await readOpenQueue(github, repo);
    expect(entries.map(({ number, base, queue }) => [number, base, queue?.kind])).toEqual([
      [1176, "main", "in-batch"],
      [1177, "fm/task-6f0e1c2a", "waiting"],
    ]);
    const runs = await readRuns(github, repo, entries);
    expect(runReads).toEqual([42_325_592_413]);
    expect(formBatch(entries, runs)).toMatchObject({ action: "wait" });
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
    const plan = verdict({ ...base, swept: "success", current: inThisRun() });
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

  // INF-2948, direction 2: a red sweep reruns nothing and blames no change.
  it("pauses every change in a red sweep with the failed job's link, and starts nothing", () => {
    const failedJob = {
      name: "Merge batch · Desktop checks / Merge batch · App journeys (Linux; parallel group 2/4)",
      html_url: `${runUrl(runId)}/job/120000000001`,
    };
    const plan = verdict({ ...base, swept: "failure", current: inThisRun(), failedJob });
    expect(plan.next).toBeNull();
    expect(plan.writes.map((write) => [write.number, write.state, write.url])).toEqual(
      members.map((member) => [member.number, "pending", failedJob.html_url]),
    );
    const paused = readQueueStatus([
      status("pending", plan.writes[0]!.description, "2026-11-03T22:00:00Z"),
      status("pending", inBatch(runId), "2026-11-03T21:00:00Z"),
      approved("2026-11-03T20:30:00Z"),
    ]);
    expect(paused).toMatchObject({ kind: "paused", run: runId, since: "2026-11-03T20:30:00Z" });
    expect(plan.writes[0]!.description).toContain(
      "App journeys (Linux; parallel group 2/4) failed",
    );
    expect(plan.writes[0]!.description.length).toBeLessThanOrEqual(140);
    // A failed critical path pauses the same way.
    expect(
      verdict({ ...base, swept: "failure", current: inThisRun() }).writes[0]!.description,
    ).toBe(`Paused after batch run ${runId}; the sweep failed`);
  });

  // The fix-forward loop end to end: a red sweep pauses, the fix's approval
  // waits behind the pause, a resume by hand turns every paused change back
  // to waiting in approval order, and the next batch sweeps them with the fix.
  it("sweeps every paused change and the fix together once a resume ends the pause", () => {
    const plan = verdict({ ...base, swept: "failure", current: inThisRun() });
    const approvals = ["2026-11-03T20:00:00Z", "2026-11-03T20:10:00Z", "2026-11-03T20:20:00Z"];
    const pausedQueue = members.map((member, index) =>
      entry(
        member.number,
        readQueueStatus([
          status("pending", plan.writes[index]!.description, "2026-11-03T22:00:00Z"),
          status("pending", inBatch(runId), "2026-11-03T21:00:00Z"),
          approved(approvals[index]!),
        ]),
        member.head,
      ),
    );
    const fix = entry(940, readQueueStatus([approved("2026-11-03T22:30:00Z")]));
    expect(formBatch([...pausedQueue, fix], new Map())).toMatchObject({ action: "wait" });

    const resumeUrl = runUrl(41_600_000_050);
    const writes = resume([...pausedQueue, fix], { url: resumeUrl });
    expect(
      writes.map((write) => [write.number, write.state, write.description, write.url]),
    ).toEqual(members.map((member) => [member.number, "pending", WAITING, resumeUrl]));
    const resumed = pausedQueue.map((paused, index) => ({
      ...paused,
      queue: readQueueStatus([
        status("pending", WAITING, "2026-11-03T22:40:00Z"),
        status("pending", plan.writes[index]!.description, "2026-11-03T22:00:00Z"),
        status("pending", inBatch(runId), "2026-11-03T21:00:00Z"),
        approved(approvals[index]!),
      ]),
    }));
    expect(formBatch([...resumed, fix], new Map())).toMatchObject({
      action: "sweep",
      members: [...members, { number: 940, head: fix.head }],
    });

    // A send-back by hand of #932 leaves it out and resumes the rest.
    expect(
      resume([...pausedQueue, fix], { url: resumeUrl, except: 932 }).map((write) => write.number),
    ).toEqual([930, 931]);
  });

  it("leaves alone a change sent back by hand or pushed again during the sweep", () => {
    const current = inThisRun();
    current.set(931, {
      head: "931".padEnd(40, "1"),
      queue: readQueueStatus([approved("2026-11-03T21:30:00Z")]),
    });
    const pushedAgain = verdict({ ...base, swept: "failure", current });
    expect(pushedAgain.writes.map((write) => write.number)).toEqual([930, 932]);
    expect(pushedAgain.next).toBeNull();
    current.set(932, {
      head: members[2]!.head,
      queue: readQueueStatus([status("failure", "Sent back", "2026-11-03T21:30:00Z")]),
    });
    const plan = verdict({ ...base, swept: "failure", current });
    expect(plan.next).toBe("sweep");
    expect(plan.writes.map((write) => [write.number, write.state, write.description])).toEqual([
      [930, "pending", WAITING],
    ]);
  });

  // INF-2921: batch run 42309370568 swept #1166 first and four more changes;
  // its triage crewmate sent #1166 back by hand while the sweep ran, and the
  // verdict would have rerun the same files and then failed #1171, the last.
  it("takes a change sent back by hand as a red sweep's answer: the rest sweep again, with no pause", () => {
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
    {
      const failedJob = {
        name: "Unit tests (Linux; group 3/3)",
        html_url: `${runUrl(runId)}/job/1`,
      };
      const plan = verdict({ ...base, swept: "failure", current, failedJob });
      expect(plan.next).toBe("sweep");
      expect(plan.writes.map((write) => [write.number, write.state, write.description])).toEqual([
        [931, "pending", WAITING],
        [932, "pending", WAITING],
      ]);
      expect(plan.summary).toContain("#930 went back by hand");
    }

    // The next batch, which the verdict starts, sweeps the rest in approval order without #930.
    const plan = verdict({ ...base, swept: "failure", current });
    const entries = queue.map((entry) => {
      const write = plan.writes.find((candidate) => candidate.number === entry.number);
      const statuses = write
        ? [status(write.state, write.description, "2026-11-03T22:00:00Z"), ...entry.statuses]
        : entry.statuses;
      return {
        number: entry.number,
        head: entry.head,
        base: "main",
        queue: readQueueStatus(statuses),
      };
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
    const green = verdict({ ...base, swept: "success", current });
    expect(green.writes.map((write) => [write.number, write.state])).toEqual([
      [931, "success"],
      [932, "success"],
    ]);
  });
});

// INF-2940: batch run 42325592413 swept six changes, in this order and at
// these versions. Its triage crewmate sent #1172 back by hand at 8bda683;
// #1172's author pushed the fix f307f3e, which the kept approval marked
// waiting, before the first attempt's verdict ran. That verdict read only
// f307f3e, so it asked for the rerun, and the second failure sent back
// #1177, the last change, which the failure never touched. The statuses are
// GitHub's, newest first.
describe("a change sent back by hand, then pushed again before the verdict", () => {
  const runId = 42_325_592_413;
  const at = (time: string) => `2026-11-07T${time}Z`;
  const changes = [
    { number: 1183, head: "4b73f41a6650ba279def68c89c8fed47f9c18f58", approval: "01:13:20" },
    { number: 1176, head: "571679da4d9eef0a6061c7f20b4612df44715d79", approval: "01:17:36" },
    { number: 1184, head: "013a8ec93f8bc9dd908ed0cf5baffecf578cd5a3", approval: "01:18:34" },
    { number: 1172, head: "8bda6832d8485b9ce75f012eca8a061d111e7f15", approval: "01:19:49" },
    { number: 1185, head: "fd23461ddd603af713866a9efbd967d0f0133155", approval: "01:26:53" },
    { number: 1177, head: "204cba081ac081a141776190f926a2e722018f06", approval: "01:28:40" },
  ];
  const members = changes.map(({ number, head }) => ({ number, head }));
  const fixed = "f307f3e8436e6d92405f461d2952595c0c05fc55";
  const sentBack = status(
    "failure",
    "Batch run 42325592413: new tests/release-workflows-linux-actions.test.ts ran as unit; add it to biome.json's integration list",
    at("02:01:54"),
  );
  const swept = () =>
    Object.fromEntries(
      changes.map((change) => [
        change.head,
        [status("pending", inBatch(runId), at("01:43:56")), approved(at(change.approval))],
      ]),
    ) as Record<string, ReturnType<typeof status>[]>;
  /** GitHub as readCurrent reads it: each pull request, and each version's statuses. */
  const githubOf = (
    pulls: Record<number, { sha: string; state: string }>,
    statuses: Record<string, ReturnType<typeof status>[]>,
  ) => {
    const reads: string[] = [];
    const github = {
      rest: {
        pulls: {
          get: async ({ pull_number }: { pull_number: number }) => ({
            data: {
              number: pull_number,
              state: pulls[pull_number]!.state,
              head: { sha: pulls[pull_number]!.sha },
            },
          }),
        },
        repos: { listCommitStatusesForRef: "statuses" },
      },
      paginate: async (method: string, parameters: { ref: string }) => {
        expect(method).toBe("statuses");
        reads.push(parameters.ref);
        return statuses[parameters.ref] ?? [];
      },
    };
    return { github, reads };
  };
  const open = (heads: Record<number, string> = {}) =>
    Object.fromEntries(
      changes.map((change) => [
        change.number,
        { sha: heads[change.number] ?? change.head, state: "open" },
      ]),
    );
  const failedJob = {
    name: "Merge batch · Desktop checks / Merge batch · Integration tests (Linux; group 2/2)",
    html_url: `${runUrl(runId)}/job/128268045100`,
  };
  const failedFiles = [{ file: "tests/release-workflows-verification.test.ts", touchedBy: [] }];
  const plan = (current: Awaited<ReturnType<typeof readCurrent>>) =>
    verdict({
      runId,
      runUrl: runUrl(runId),
      swept: "failure",
      tree: "9bc8bb61e86794de03c66d701f70a1978eee5c22",
      members,
      current,
      failedJob,
      failedFiles,
    });

  it("takes the send-back on the swept version as the sweep's answer: no pause, and the rest sweep again", async () => {
    const statuses = swept();
    statuses[members[3]!.head]!.unshift(sentBack);
    statuses[fixed] = [approved(at("02:09:49"))];
    const { github, reads } = githubOf(open({ 1172: fixed }), statuses);
    const current = await readCurrent(github, repo, members);
    expect(current.get(1172)).toMatchObject({
      head: fixed,
      queue: { kind: "waiting", since: at("02:09:49") },
      swept: { kind: "failed", description: sentBack.description },
    });
    // Only the change pushed again reads its swept version as well.
    expect(reads).toEqual([
      ...members.slice(0, 3).map((m) => m.head),
      fixed,
      members[3]!.head,
      ...members.slice(4).map((m) => m.head),
    ]);

    {
      const answer = plan(current);
      expect(answer.next).toBe("sweep");
      expect(
        answer.writes.map((write) => [write.number, write.head, write.state, write.description]),
      ).toEqual(
        [1183, 1176, 1184, 1185, 1177].map((number) => [
          number,
          members.find((member) => member.number === number)!.head,
          "pending",
          WAITING,
        ]),
      );
      expect(answer.summary).toContain("#1172 went back by hand");
    }

    // The next batch, which the verdict starts, takes the rest in approval
    // order, and #1172's fixed version after them, from its new approval.
    const written = plan(current).writes;
    const entries = changes.map((change) => {
      const write = written.find((candidate) => candidate.number === change.number);
      const now = current.get(change.number)!;
      const queue = write
        ? readQueueStatus([
            status(write.state, write.description, at("02:12:49")),
            ...statuses[change.head]!,
          ])
        : now.queue;
      return { number: change.number, head: now.head, base: "main", queue };
    });
    expect(formBatch(entries, new Map())).toMatchObject({
      action: "sweep",
      members: [
        ...members.filter((member) => member.number !== 1172),
        { number: 1172, head: fixed },
      ],
    });
  });

  // Under fix forward, the same failure with no send-back pauses the rest,
  // blaming none, and #1172's new version waits behind the pause with them.
  it("pauses the rest for a change pushed again without a send-back, and its new version waits too", async () => {
    const statuses = swept();
    statuses[fixed] = [approved(at("02:09:49"))];
    const { github } = githubOf(open({ 1172: fixed }), statuses);
    const current = await readCurrent(github, repo, members);
    expect(current.get(1172)).toMatchObject({
      head: fixed,
      swept: { kind: "in-batch", run: runId },
    });
    const answer = plan(current);
    expect(answer.next).toBeNull();
    expect(answer.writes.map((write) => [write.number, write.state, write.url])).toEqual(
      [1183, 1176, 1184, 1185, 1177].map((number) => [number, "pending", failedJob.html_url]),
    );
    expect(answer.writes[0]!.description).toBe(
      "Paused after batch run 42325592413; tests/release-workflows-verification.test.ts failed; no change here touches it",
    );
    const entries = changes.map((change) => {
      const write = answer.writes.find((candidate) => candidate.number === change.number);
      const now = current.get(change.number)!;
      const queue = write
        ? readQueueStatus([
            status(write.state, write.description, at("02:12:49")),
            ...statuses[change.head]!,
          ])
        : now.queue;
      return { number: change.number, head: now.head, base: "main", queue };
    });
    expect(formBatch(entries, new Map())).toMatchObject({ action: "wait", members: [] });
  });
});

// INF-2925's audit, the captain's chosen fix: "Make the verdict write the
// failing test file and the members whose diffs touch it into the status
// reason, so triage reads a fact instead of guessing." The logs are lines of
// two failed sweep jobs as GitHub served them: batch run 42315366976's unit
// group 1/3, and batch run 42305850996's Linux serial journey group 1/4.
const UNIT_LOG = [
  "2026-11-07T00:09:09.3881222Z  \u001b[32m✓\u001b[39m \u001b[30m\u001b[43m unit-isolated \u001b[49m\u001b[39m src/renderer/src/app/stack.test.ts \u001b[2m(\u001b[22m\u001b[2m1 test\u001b[22m\u001b[2m)\u001b[22m\u001b[32m 12\u001b[2mms\u001b[22m\u001b[39m",
  "2026-11-07T00:09:25.6305587Z \u001b[31m⎯⎯⎯⎯⎯⎯⎯\u001b[39m\u001b[1m\u001b[41m Failed Tests 2 \u001b[49m\u001b[22m\u001b[31m⎯⎯⎯⎯⎯⎯⎯\u001b[39m",
  "2026-11-07T00:09:25.6328778Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m \u001b[30m\u001b[42m unit \u001b[49m\u001b[39m tests/crewmate-fixed-context.test.ts\u001b[2m > \u001b[22mthe crewmate's fixed context (INF-416 piece J)\u001b[2m > \u001b[22mstays inside its budget for each runtime and kind of work",
  "2026-11-07T00:09:25.6362939Z \u001b[31m\u001b[1mAssertionError\u001b[22m: expected [ { …(3) } ] to deeply equal []\u001b[39m",
  "2026-11-07T00:09:25.6430122Z \u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m288 passed\u001b[39m\u001b[22m\u001b[90m (289)\u001b[39m",
  "2026-11-07T00:09:25.6473836Z \u001b[36m \u001b[2m❯\u001b[22m tests/crewmate-fixed-context.test.ts:\u001b[2m171:71\u001b[22m\u001b[39m",
  "2026-11-07T00:09:25.6542025Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m \u001b[30m\u001b[42m unit \u001b[49m\u001b[39m tests/crewmate-fixed-context.test.ts\u001b[2m > \u001b[22mthe crewmate's fixed context (INF-416 piece J)\u001b[2m > \u001b[22mleaves the smallest local window room for the conversation it promises",
  "2026-11-07T00:09:25.8766430Z [ELIFECYCLE] Test failed. See above for more details.",
].join("\n");
const JOURNEY_LOG = [
  "2026-11-06T22:47:04.2937735Z     test-results/runs/20261106T223722Z-3000/card-leave-each-registered-e8953-ly-Done-receipts-the-answer-desktop/trace.zip",
  "2026-11-06T22:47:04.2942679Z     ────────────────────────────────────────────────────────────────────────────────────────────────",
  "2026-11-06T22:47:04.2943352Z ",
  "2026-11-06T22:47:04.2943632Z   1 failed",
  "2026-11-06T22:47:04.2944978Z     [desktop] › tests/e2e/card-leave.spec.ts:34:1 › each registered corner puts away without ending work; only Done receipts the answer ",
  "2026-11-06T22:47:04.2946175Z   42 passed (9.7m)",
  "2026-11-06T22:47:04.3659619Z ##[error]Process completed with exit code 1.",
].join("\n");

describe("the failed test files a red sweep names", () => {
  it("reads vitest's FAIL lines and Playwright's failed list, and no passing file", () => {
    expect(failedTestFiles(UNIT_LOG)).toEqual(["tests/crewmate-fixed-context.test.ts"]);
    expect(failedTestFiles(JOURNEY_LOG)).toEqual(["tests/e2e/card-leave.spec.ts"]);
  });

  // Files from git: #1154 edits the card-leave journey; #1166 and #1175,
  // whose served text overran the budget together, touch neither file.
  const diffs: Record<number, { filename: string; previous_filename?: string }[]> = {
    1154: [
      "src/core/pi/cardTool.ts",
      "tests/e2e/card-leave.spec.ts",
      "tests/firstmate-fixed-context.test.ts",
    ].map((filename) => ({ filename })),
    1166: ["resources/runbooks/delivery/crew.md", "src/core/runbooks/fallback.generated.ts"].map(
      (filename) => ({
        filename,
      }),
    ),
    1175: ["src/core/prompts/cardContract.ts", "src/core/session/tools.ts"].map((filename) => ({
      filename,
    })),
  };
  const logs: Record<number, string> = { 128226737826: UNIT_LOG, 128195053165: JOURNEY_LOG };
  const github = {
    rest: {
      actions: {
        downloadJobLogsForWorkflowRun: async ({ job_id }: { job_id: number }) => {
          if (!logs[job_id]) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: logs[job_id] };
        },
      },
      pulls: { listFiles: "files" },
    },
    paginate: async (method: string, { pull_number }: { pull_number: number }) => {
      expect(method).toBe("files");
      return diffs[pull_number] ?? [];
    },
  };
  const members = [1154, 1166, 1175].map((number) => ({
    number,
    head: String(number).padEnd(40, "0"),
  }));
  const runId = 42_315_366_976;

  it("writes the first failed file and the changes that touch it into the pause, blaming none", async () => {
    // The Mac runner that lost its connection has no log to read.
    const failedJobs = [{ id: 128195053165 }, { id: 128226737826 }, { id: 128226737999 }];
    const failedFiles = await readFailedFiles(github, repo, failedJobs, members);
    expect(failedFiles).toEqual([
      { file: "tests/e2e/card-leave.spec.ts", touchedBy: [1154] },
      { file: "tests/crewmate-fixed-context.test.ts", touchedBy: [] },
    ]);
    const current = new Map(
      members.map((member) => [
        member.number,
        {
          head: member.head,
          queue: readQueueStatus([status("pending", inBatch(runId), "2026-11-06T23:59:30Z")]),
        },
      ]),
    );
    const plan = verdict({
      runId,
      runUrl: runUrl(runId),
      swept: "failure",
      tree: pr917.tree,
      members,
      current,
      failedJob: {
        name: "Merge batch · Desktop checks / Merge batch · Unit tests (Linux; group 1/3)",
        html_url: "",
      },
      failedFiles,
    });
    expect(plan.writes.map((write) => [write.number, write.state])).toEqual(
      members.map((member) => [member.number, "pending"]),
    );
    const reason = plan.writes[0]!.description;
    expect(reason).toBe(
      "Paused after batch run 42315366976; tests/e2e/card-leave.spec.ts (+1 more) failed; touched by #1154",
    );
    expect(reason.length).toBeLessThanOrEqual(140);
    expect(plan.summary).toContain(
      "tests/crewmate-fixed-context.test.ts (no change here touches it)",
    );

    // With only the budget test failing, the reason says no change touches it.
    const budget = verdict({
      runId,
      runUrl: runUrl(runId),
      swept: "failure",
      tree: pr917.tree,
      members,
      current,
      failedFiles: failedFiles.slice(1),
    });
    expect(budget.writes[0]!.description).toBe(
      "Paused after batch run 42315366976; tests/crewmate-fixed-context.test.ts failed; no change here touches it",
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
  with?: Record<string, unknown>;
  steps?: {
    id?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
  }[];
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
      group(contexts("workflow_dispatch", {}, { rehearsal: "", send_back: "", resume: "" })),
    ).toBe("batch");
    expect(group(contexts("status", { context: "ci", state: "success" }))).toBe(
      "batch-other-41600000009",
    );
    expect(group(contexts("workflow_dispatch", {}, { rehearsal: "930 931" }))).toBe(
      "batch-rehearsal-41600000009",
    );
    expect(group(contexts("workflow_dispatch", {}, { send_back: "930", reason: "r" }))).toBe(
      "batch-send-back-41600000009",
    );
    expect(group(contexts("workflow_dispatch", {}, { resume: "Fix #940 approved" }))).toBe(
      "batch-resume-41600000009",
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
      workflowValue(compose, contexts("workflow_dispatch", {}, { send_back: "", resume: "" })),
    ).toBe(true);
    // A send-back or a resume starts the next batch by dispatch once it has written its statuses.
    expect(
      workflowValue(compose, contexts("workflow_dispatch", {}, { send_back: "930", resume: "" })),
    ).toBe(false);
    expect(
      workflowValue(compose, contexts("workflow_dispatch", {}, { send_back: "", resume: "Fix" })),
    ).toBe(false);
    const resumeJob = batch.jobs.resume!.if!;
    expect(workflowValue(resumeJob, contexts("workflow_dispatch", {}, { resume: "Fix" }))).toBe(
      true,
    );
    expect(workflowValue(resumeJob, contexts("workflow_dispatch", {}, { resume: "" }))).toBe(false);
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
  // every pull request that builds the app runs (ci.yml's critical-path step,
  // INF-2915), on the commit the sweep composes.
  it("runs the critical path on the composed batch, on hosted Linux, in a job of its own", () => {
    const job = batch.jobs["critical-path"];
    const sweep = batch.jobs.sweep;
    const pullRequest = workflow(".github/workflows/ci.yml").jobs[
      "typecheck-lint-build"
    ]?.steps?.find((step) => step.id === "critical-path");
    expect(job?.uses).toBe("./.github/workflows/source-journeys.yml");
    expect(job?.needs).toBe("compose");
    expect(job?.if).toBe(sweep?.if);
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
