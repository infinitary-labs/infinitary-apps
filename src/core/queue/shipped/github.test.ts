import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { QUEUE_STATUS } from "@shared/repos";
import { describe, expect, it } from "vitest";
import type { ScriptArgs } from "./github.mjs";
import { answer, decide, failures, form, mark } from "./github.mjs";
import { abandonedBatch as abandoned, completedBatch } from "./githubReadings.fixture";
import type { Member } from "./rules.mjs";
import { FIX_LABEL, PAUSE_LABEL, QUEUE, queueKind, readPauseMarker, WAITING } from "./rules.mjs";

// INF-2952 piece 1, the captain's approved plan: a shipped fix-forward queue
// that runs in the project's own CI, which every teammate's Infinitary reads.
// "Red: every change reads Paused with a link to one new issue naming the
// failed check and the paused changes; nothing reruns, no change is blamed,
// and new approvals wait", and "a change its crewmate declares as the
// pause's fix ends the pause once approved; the next batch takes every
// paused change, every waiting change and the fix". The stand-in answers in
// the shapes GitHub's REST API answers github-script's client with. Since
// INF-3012 a red batch runs what failed once more before it pauses (the
// confirm), so the pause follows a red confirm.

const owner = "acme";
const name = "shop";
const server = "https://github.com";
const sha = (n: number) => n.toString(16).padStart(40, "a");
const TREE = "be6452e81a110b0c50d7354add8d59a231807cce";
/** The default branch's version the compose step fetched after the queue read. */
const BASE = "9f2c4e1d0b8a7c6e5f4d3c2b1a0918273645abcd";

type Status = {
  id: number;
  state: string;
  context: string;
  description: string;
  target_url: string;
  created_at: string;
};
type Pull = {
  number: number;
  state: string;
  head: { sha: string };
  base: { ref: string };
  labels: { name: string }[];
};

/** A project on GitHub as the queue's client reads and writes it. */
class Project {
  pulls = new Map<number, Pull>();
  statuses = new Map<string, Status[]>();
  issues: {
    number: number;
    title: string;
    body: string;
    state: string;
    labels: string[];
    html_url: string;
    comments: string[];
  }[] = [];
  runs = new Map<number, { id: number; status: string; conclusion: string | null }>();
  jobs: {
    id: number;
    name: string;
    status?: string;
    conclusion: string | null;
    html_url: string;
  }[] = [];
  logs = new Map<number, string>();
  files = new Map<number, string[]>();
  dispatches: unknown[] = [];
  cancelled: number[] = [];
  /** Each pull request's label events, oldest first, as GitHub lists its issue events. */
  events = new Map<number, { event: string; label: { name: string }; created_at: string }[]>();
  /** Issues turned off in the project's settings: GitHub refuses a new issue. */
  issuesOff = false;
  private clock = Date.parse("2026-11-06T17:00:00Z");
  private ids = 9_000;

  open(number: number, options: { base?: string; labels?: string[] } = {}): Pull {
    const pull = {
      number,
      state: "open",
      head: { sha: sha(number) },
      base: { ref: options.base ?? "main" },
      labels: [] as { name: string }[],
    };
    this.pulls.set(number, pull);
    for (const label of options.labels ?? []) this.label(number, label);
    return pull;
  }

  /** Someone putting a label on the pull request: GitHub records a labeled event when it was not on. */
  label(number: number, name: string): void {
    const pull = this.pulls.get(number);
    if (!pull || pull.labels.some((label) => label.name === name)) return;
    this.clock += 60_000;
    pull.labels.push({ name });
    this.events.set(number, [
      ...(this.events.get(number) ?? []),
      { event: "labeled", label: { name }, created_at: new Date(this.clock).toISOString() },
    ]);
  }

  /** Someone taking a label off the pull request. */
  unlabel(number: number, name: string): void {
    const pull = this.pulls.get(number);
    if (!pull?.labels.some((label) => label.name === name)) return;
    this.clock += 60_000;
    pull.labels = pull.labels.filter((label) => label.name !== name);
    this.events.set(number, [
      ...(this.events.get(number) ?? []),
      { event: "unlabeled", label: { name }, created_at: new Date(this.clock).toISOString() },
    ]);
  }

  /** An approver's Infinitary marking the version waiting, as its merge click does. */
  approve(number: number): void {
    this.write(this.headOf(number), "pending", WAITING, "");
  }

  /** The pull request's current version. */
  headOf(number: number): string {
    return this.pulls.get(number)?.head.sha ?? sha(number);
  }

  /** A new version of the pull request, such as its crewmate's fix after a pause. */
  push(number: number, head: string): void {
    const pull = this.pulls.get(number);
    if (pull) pull.head = { sha: head };
  }

  write(at: string, state: string, description: string, url: string, context = QUEUE): void {
    this.clock += 60_000;
    const list = this.statuses.get(at) ?? [];
    list.unshift({
      id: this.ids++,
      state,
      context,
      description,
      target_url: url,
      created_at: new Date(this.clock).toISOString(),
    });
    this.statuses.set(at, list);
  }

  queueOf(number: number) {
    const latest = this.statuses
      .get(this.headOf(number))
      ?.find((status) => status.context === QUEUE);
    return latest ? { ...queueKind(latest.state, latest.description), ...latest } : undefined;
  }

  github() {
    const data = <T>(value: T) => Promise.resolve({ data: value });
    return {
      paginate: async (
        method: (params: unknown) => Promise<{ data: unknown[] }>,
        params: unknown,
      ) => (await method(params)).data,
      rest: {
        repos: {
          listCommitStatusesForRef: ({ ref }: { ref: string }) =>
            data(this.statuses.get(ref) ?? []),
          createCommitStatus: (write: {
            sha: string;
            state: string;
            context: string;
            description: string;
            target_url: string;
          }) => {
            this.write(write.sha, write.state, write.description, write.target_url, write.context);
            return data({});
          },
        },
        pulls: {
          list: () => data([...this.pulls.values()].filter((pull) => pull.state === "open")),
          get: ({ pull_number }: { pull_number: number }) => data(this.pulls.get(pull_number)),
          listFiles: ({ pull_number }: { pull_number: number }) =>
            data((this.files.get(pull_number) ?? []).map((filename) => ({ filename }))),
        },
        actions: {
          cancelWorkflowRun: ({ run_id }: { run_id: number }) => {
            this.cancelled.push(run_id);
            this.runs.set(run_id, { id: run_id, status: "completed", conclusion: "cancelled" });
            return data(undefined);
          },
          getWorkflowRun: ({ run_id }: { run_id: number }) => data(this.runs.get(run_id)),
          listJobsForWorkflowRun: () => data(this.jobs),
          downloadJobLogsForWorkflowRun: ({ job_id }: { job_id: number }) => {
            const log = this.logs.get(job_id);
            return log === undefined ? Promise.reject(new Error("Not Found")) : data(log);
          },
          createWorkflowDispatch: (dispatch: unknown) => {
            this.dispatches.push(dispatch);
            return data(undefined);
          },
        },
        issues: {
          listEvents: ({ issue_number }: { issue_number: number }) =>
            data(this.events.get(issue_number) ?? []),
          listForRepo: ({ labels }: { labels: string }) =>
            this.issuesOff
              ? Promise.reject(new Error("Issues has been disabled in this repository"))
              : data(
                  this.issues.filter(
                    (issue) => issue.state === "open" && issue.labels.includes(labels),
                  ),
                ),
          create: ({ title, body, labels }: { title: string; body: string; labels: string[] }) => {
            if (this.issuesOff)
              return Promise.reject(new Error("Issues are disabled for this repo"));
            const number = 300 + this.issues.length;
            const issue = {
              number,
              title,
              body,
              labels,
              state: "open",
              comments: [],
              html_url: `${server}/${owner}/${name}/issues/${number}`,
            };
            this.issues.push(issue);
            return data(issue);
          },
          createComment: ({ issue_number, body }: { issue_number: number; body: string }) => {
            this.issues.find((issue) => issue.number === issue_number)?.comments.push(body);
            return data({});
          },
          update: ({ issue_number, state }: { issue_number: number; state: string }) => {
            const issue = this.issues.find((candidate) => candidate.number === issue_number);
            if (issue) issue.state = state;
            return data(issue);
          },
        },
      },
    };
  }
}

/** One run of the shipped workflow: what its jobs set as outputs and said. */
function runOf(project: Project, runId: number) {
  const outputs = new Map<string, string>();
  const notices: string[] = [];
  const summary: string[] = [];
  const args: ScriptArgs = {
    github: project.github(),
    context: {
      repo: { owner, repo: name },
      runId,
      serverUrl: server,
      payload: { repository: { default_branch: "main" } },
    },
    core: {
      notice: (text) => notices.push(text),
      setOutput: (key, value) => outputs.set(key, value),
      summary: {
        addHeading: (text) => ({
          addRaw: (raw) => ({
            write: async () => summary.push(`${text}: ${raw}`),
          }),
        }),
      },
    },
  };
  return { args, outputs, notices, summary };
}

/** The compose step's output for these members: the base, each merged, then the tree. */
const composed = (members: Member[], conflicts: Record<number, string> = {}) =>
  `base ${BASE}\n${members.map((member) => `${conflicts[member.number] ?? "merged"} ${member.number}`).join("\n")}\ntree ${TREE}\n`;

/** Form and mark one batch run, as the form job does; answers the members in it. */
async function formRun(project: Project, runId: number, conflicts: Record<number, string> = {}) {
  const run = runOf(project, runId);
  await form(run.args);
  const members = JSON.parse(run.outputs.get("members") ?? "[]") as Member[];
  if (members.length) {
    await mark({ ...run.args, output: composed(members, conflicts), members });
    project.runs.set(runId, { id: runId, status: "in_progress", conclusion: null });
  }
  return { run, members: JSON.parse(run.outputs.get("members") ?? "[]") as Member[] };
}

describe("the shipped queue on GitHub", () => {
  it("forms one batch from every teammate's approval in approval order, leaving a stacked change waiting", async () => {
    const project = new Project();
    project.open(41);
    project.open(42);
    project.open(43, { base: "feature" });
    project.open(44);
    project.approve(42);
    project.approve(41);
    project.approve(43);

    const { members } = await formRun(project, 501, {});

    expect(members.map((member) => member.number)).toEqual([42, 41]);
    expect(project.queueOf(42)).toMatchObject({ kind: "in-batch", run: 501 });
    expect(project.queueOf(43)).toMatchObject({ kind: "waiting" });
    expect(project.queueOf(44)).toBeUndefined();
  });

  it("sends a change that conflicts with the default branch back, and keeps one that conflicts only within the batch waiting", async () => {
    const project = new Project();
    for (const number of [51, 52, 53]) {
      project.open(number);
      project.approve(number);
    }
    const { run, members } = await formRun(project, 502, {
      51: "conflict-main",
      52: "conflict-batch",
    });

    expect(members.map((member) => member.number)).toEqual([53]);
    expect(project.queueOf(51)).toMatchObject({ state: "failure" });
    expect(project.queueOf(51)?.description).toMatch(/bring the branch up to date/);
    expect(project.queueOf(52)).toMatchObject({ kind: "waiting" });
    expect(run.outputs.get("tree")).toBe(TREE);
    // The checks compose onto the version the compose step fetched, never the checkout's.
    expect(run.outputs.get("base")).toBe(BASE);
  });

  it("passes every change of a green batch with the batch's tree, and starts nothing", async () => {
    const project = new Project();
    project.open(61);
    project.approve(61);
    const { members } = await formRun(project, 503);
    await decide({ ...runOf(project, 503).args, result: "success", members, tree: TREE });

    expect(project.queueOf(61)).toMatchObject({ kind: "passed", run: 503, tree: TREE });
    expect(project.dispatches).toEqual([]);
  });

  it("pauses a batch whose confirm failed again behind one issue that names the failed check and the paused changes", async () => {
    const project = new Project();
    project.open(71);
    project.open(72);
    project.files.set(72, ["tests/e2e/card-leave.spec.ts"]);
    project.approve(71);
    project.approve(72);
    const { members } = await formRun(project, 504);
    project.jobs = [
      { id: 1, name: "Form the batch", conclusion: "success", html_url: `${server}/j/1` },
      { id: 2, name: "Batch checks / e2e", conclusion: "failure", html_url: `${server}/j/2` },
    ];
    project.logs.set(
      2,
      "2026-11-06T17:20:01.0000000Z   1 failed\n2026-11-06T17:20:01.0000000Z     [desktop] › tests/e2e/card-leave.spec.ts:14:1 › leaves a card\n",
    );

    await decide({
      ...runOf(project, 504).args,
      result: "failure",
      confirm: "failure",
      members,
      tree: TREE,
    });

    expect(project.issues).toHaveLength(1);
    const [issue] = project.issues;
    expect(issue?.labels).toEqual([PAUSE_LABEL]);
    expect(issue?.body).toContain("[Batch checks / e2e]");
    expect(issue?.body).toContain("failed again when they ran once more on the same batch");
    expect(readPauseMarker(issue?.body)).toEqual({ run: 504, changes: [71, 72] });
    for (const number of [71, 72]) {
      expect(project.queueOf(number)).toMatchObject({
        kind: "paused",
        run: 504,
        target_url: issue?.html_url,
      });
      expect(project.queueOf(number)?.description).toContain(
        "tests/e2e/card-leave.spec.ts failed; touched by #72",
      );
    }
    expect(project.dispatches).toEqual([]);

    // A new approval waits behind the pause.
    project.runs.set(504, { id: 504, status: "completed", conclusion: "success" });
    project.open(73);
    project.approve(73);
    const later = await formRun(project, 505);
    expect(later.members).toEqual([]);
    expect(later.run.notices.join(" ")).toMatch(/paused until its fix is approved/);
    expect(project.queueOf(73)).toMatchObject({ kind: "waiting" });
  });

  // Approved recovery behavior: one missing verdict starts a fresh batch,
  // but a preceding missing verdict pauses instead. Real job readings own
  // the fixture; this entry-point test owns statuses, issues and dispatches.
  it("starts a fresh batch after one missing verdict, then pauses a second miss without restarting or duplicating its report", async () => {
    const project = new Project();
    const { run, tree, member, jobs } = abandoned;
    project.open(member.number);
    project.push(member.number, member.head);
    project.write(member.head, "pending", `In batch run ${run}`, "");
    project.jobs = jobs;
    const invocation = runOf(project, run);
    const input = {
      ...invocation.args,
      result: "abandoned",
      confirm: "skipped",
      members: [member],
      tree,
    };
    await decide(input);
    expect(project.queueOf(member.number)).toMatchObject({
      kind: "waiting",
      state: "pending",
      description: WAITING,
    });
    expect(project.issues).toEqual([]);
    expect(project.dispatches).toHaveLength(1);
    expect(project.statuses.get(member.head)?.some((status) => status.state === "success")).toBe(
      false,
    );

    // The next batch must run its own checks. A second incomplete result
    // is an adverse reading, never an invented success from the 29 leaves.
    const nextRun = completedBatch.run;
    project.runs.set(run, { id: run, status: "completed", conclusion: "failure" });
    // A newly approved member must not reset the prior member's bound.
    project.open(1328);
    project.approve(1328);
    const second = runOf(project, nextRun);
    await form(second.args);
    const members = JSON.parse(second.outputs.get("members") ?? "[]") as Member[];
    await mark({
      ...second.args,
      members,
      output: `base ${abandoned.base}\n${members.map((member) => `merged ${member.number}`).join("\n")}\ntree ${tree}\n`,
    });
    const repeated = { ...input, ...second.args, members };
    await decide(repeated);
    const issue = project.issues[0];
    expect(issue?.body).toContain("No failed job was reported");
    expect(issue?.body).toContain("batch checks `abandoned`; confirmation `skipped`");
    for (const job of jobs)
      expect(issue?.body).toContain(
        `[${job.name}](${job.html_url}): completed / ${job.conclusion}`,
      );
    expect(issue?.body).not.toContain("a failed job's log named no failed test file");
    expect(project.queueOf(member.number)).toMatchObject({
      kind: "paused",
      run: nextRun,
      state: "pending",
      target_url: issue?.html_url,
    });
    expect(project.queueOf(member.number)?.description).toContain(
      "batch verdict did not pass; no failed job reported",
    );

    expect(issue?.body).toContain(`a preceding batch also returned no verdict (${run})`);
    expect(project.queueOf(1328)).toMatchObject({ kind: "paused", run: nextRun });
    await decide(repeated);
    expect(project.issues).toHaveLength(1);
    expect(project.dispatches).toHaveLength(1);
    expect(second.summary.at(-1)).toContain("already paused");

    // An explicit workflow rerun keeps its id and marks the members again.
    // It must preserve the existing issue, including the repairer's words.
    if (issue) issue.body += "\nRepair investigation is in progress.";
    project.write(member.head, "pending", `In batch run ${nextRun}`, "");
    await decide(repeated);
    expect(project.issues).toHaveLength(1);
    expect(project.issues[0]?.body).toContain("Repair investigation is in progress.");
    expect(project.statuses.get(member.head)?.some((status) => status.state === "success")).toBe(
      false,
    );
    expect(project.dispatches).toHaveLength(1);
  });

  it("passes the recovered changes only when the fresh batch returns its own success", async () => {
    const project = new Project();
    const { run, tree, member, jobs } = abandoned;
    project.open(member.number);
    project.push(member.number, member.head);
    project.write(member.head, "pending", `In batch run ${run}`, "");
    project.jobs = jobs;
    await decide({
      ...runOf(project, run).args,
      result: "abandoned",
      confirm: "skipped",
      members: [member],
      tree,
    });
    expect(project.queueOf(member.number)).toMatchObject({ kind: "waiting", state: "pending" });
    const next = runOf(project, completedBatch.run);
    await form(next.args);
    expect(JSON.parse(next.outputs.get("members") ?? "[]")).toEqual([member]);
    await mark({
      ...next.args,
      members: [member],
      output: `base ${abandoned.base}\nmerged ${member.number}\ntree ${tree}\n`,
    });
    // Actual successful marker from the later run, not added to the old one.
    project.jobs = [completedBatch.marker];
    await decide({ ...next.args, result: "success", confirm: "skipped", members: [member], tree });
    expect(project.queueOf(member.number)).toMatchObject({
      kind: "passed",
      run: completedBatch.run,
      tree,
    });
    expect(project.issues).toEqual([]);
    expect(project.dispatches).toHaveLength(1);
  });

  it("ends the missing-verdict chain when an intervening batch has a known failed result", async () => {
    const project = new Project();
    const { run, tree, member } = abandoned;
    project.open(member.number);
    project.push(member.number, member.head);
    project.write(member.head, "pending", `In batch run ${run}`, "");
    await decide({ ...runOf(project, run).args, result: "abandoned", members: [member], tree });
    // Project the recorded missing result across an ordinary red batch and
    // a deliberate resume. A distant outage must not consume today's recovery.
    const red = completedBatch.run;
    project.write(member.head, "pending", `In batch run ${red}`, "");
    await decide({
      ...runOf(project, red).args,
      result: "failure",
      confirm: "skipped",
      members: [member],
      tree,
    });
    expect(project.queueOf(member.number)).toMatchObject({ kind: "paused" });
    await answer({
      ...runOf(project, red).args,
      action: "resume",
      reason: "The failed check has been repaired",
    });
    const startsBefore = project.dispatches.length;
    // A new attempt of that batch has a known failure immediately before it.
    project.write(member.head, "pending", `In batch run ${red}`, "");
    await decide({ ...runOf(project, red).args, result: "abandoned", members: [member], tree });
    expect(project.queueOf(member.number)).toMatchObject({
      kind: "waiting",
      state: "pending",
      description: WAITING,
    });
    expect(project.dispatches).toHaveLength(startsBefore + 1);
  });

  it("does not infer success from absent job readings or a confirm beside an abandoned aggregate", async () => {
    const project = new Project();
    const { run, tree, member } = abandoned;
    project.open(member.number);
    project.push(member.number, member.head);
    project.write(member.head, "pending", `In batch run ${run}`, "");
    // The same incomplete host result, with its job reading unavailable.
    await decide({
      ...runOf(project, run).args,
      result: "abandoned",
      confirm: "success",
      members: [member],
      tree,
    });
    expect(project.queueOf(member.number)).toMatchObject({ kind: "paused", state: "pending" });
    expect(project.issues[0]?.body).toContain("No job results were available");
    expect(project.issues[0]?.body).not.toContain("failed again");
    expect(project.dispatches).toEqual([]);
  });

  // The captain's pick on INF-3012, "A only: the confirm step": a red batch
  // first runs what failed once more on the same composed batch; a green
  // confirm passes the batch, and only a red one pauses it. The jobs are
  // named as this repository's batch run names them, and the files are two
  // that failed on their own in its sweeps.
  it("confirms a red batch with the failed jobs and files, and passes it when the confirm passes", async () => {
    const project = new Project();
    project.open(65);
    project.approve(65);
    const { members } = await formRun(project, 520);
    const mac =
      "Batch checks / Merge batch · Desktop checks / Merge batch · Parallel journeys (Mac)";
    const linux =
      "Batch checks / Merge batch · Desktop checks / Merge batch · Integration tests (Linux; group 2/2)";
    project.jobs = [
      { id: 1, name: "Form the batch", conclusion: "success", html_url: `${server}/j/1` },
      { id: 2, name: mac, conclusion: "failure", html_url: `${server}/j/2` },
      { id: 3, name: linux, conclusion: "failure", html_url: `${server}/j/3` },
    ];
    project.logs.set(
      2,
      "2026-11-07T19:20:01.0000000Z   1 failed\n2026-11-07T19:20:01.0000000Z     [application] › knowledge-references.spec.ts:41:3 › opens a saved reference\n",
    );
    project.logs.set(
      3,
      "2026-11-07T19:12:44.0000000Z  FAIL  |integration| src/core/freeze/freezeRecorder.integration.test.ts > writes the record\n",
    );

    const read = runOf(project, 520);
    await failures(read.args);
    expect(read.outputs.get("jobs")).toBe(
      [mac, linux].map((name) => name.slice("Batch checks / ".length)).join("\n"),
    );
    expect(read.outputs.get("files")).toBe(
      "knowledge-references.spec.ts src/core/freeze/freezeRecorder.integration.test.ts",
    );

    // The confirm's own jobs are not the batch's failures.
    project.jobs.push({
      id: 4,
      name: "Batch confirm / Merge batch · Confirm failed tests (Mac)",
      conclusion: "success",
      html_url: `${server}/j/4`,
    });
    const verdict = runOf(project, 520);
    await decide({ ...verdict.args, result: "failure", confirm: "success", members, tree: TREE });

    expect(project.queueOf(65)).toMatchObject({ kind: "passed", run: 520, tree: TREE });
    expect(project.issues).toEqual([]);
    expect(verdict.summary.join(" ")).toContain(
      "knowledge-references.spec.ts, src/core/freeze/freezeRecorder.integration.test.ts failed in its checks and passed",
    );
  });

  // A batch run in this repository failed with every test passed: Vitest
  // failed the job on an unhandled error it said came from one test file,
  // and printed no FAIL line, so the queue named no file and paused. These
  // are that job's own closing lines, colors and all.
  it("confirms a red batch whose only failure is an unhandled error Vitest says came from a test file", async () => {
    const project = new Project();
    project.open(67);
    project.approve(67);
    const { members } = await formRun(project, 522);
    const linux =
      "Batch checks / Merge batch · Desktop checks / Merge batch · Integration tests (Linux; group 2/2)";
    project.jobs = [{ id: 3, name: linux, conclusion: "failure", html_url: `${server}/j/3` }];
    project.logs.set(
      3,
      [
        "2026-11-08T08:05:33.8316852Z  \u001b[32m✓\u001b[39m \u001b[30m\u001b[45m integration \u001b[49m\u001b[39m tests/replay-gate-catches-lint.test.ts \u001b[2m(\u001b[22m\u001b[2m1 test\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 5615\u001b[2mms\u001b[22m\u001b[39m",
        "2026-11-08T08:05:48.8700969Z Vitest caught 1 unhandled error during the test run.",
        "2026-11-08T08:05:48.8723285Z \u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m81 passed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[33m6 skipped\u001b[39m\u001b[90m (87)\u001b[39m",
        '2026-11-08T08:05:48.8764393Z \u001b[31m\u001b[1mEnvironmentTeardownError\u001b[22m: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending\u001b[39m',
        '2026-11-08T08:05:48.8766094Z \u001b[31mThis error originated in "\u001b[1mtests/phone-scene-projection.test.ts\u001b[22m" test file. It doesn\'t mean the error was thrown inside the file itself, but while it was running.\u001b[39m',
        "2026-11-08T08:05:48.9690171Z ##[error]Process completed with exit code 1.",
        "",
      ].join("\n"),
    );

    const read = runOf(project, 522);
    await failures(read.args);
    expect(read.outputs.get("jobs")).toBe(linux.slice("Batch checks / ".length));
    expect(read.outputs.get("files")).toBe("tests/phone-scene-projection.test.ts");

    const verdict = runOf(project, 522);
    await decide({ ...verdict.args, result: "failure", confirm: "success", members, tree: TREE });
    expect(project.queueOf(67)).toMatchObject({ kind: "passed", run: 522, tree: TREE });
    expect(project.issues).toEqual([]);
    expect(verdict.summary.join(" ")).toContain(
      "tests/phone-scene-projection.test.ts failed in its checks and passed",
    );
  });

  // The files go to the batch checks as one list separated by spaces, so a
  // path with other characters is named nowhere rather than split or passed on.
  it("names no file for an unhandled error Vitest ties to no test file, or to a path with a space", async () => {
    const project = new Project();
    project.open(68);
    project.approve(68);
    await formRun(project, 523);
    project.jobs = [
      { id: 2, name: "Batch checks / unit", conclusion: "failure", html_url: `${server}/j/2` },
      {
        id: 3,
        name: "Batch checks / integration",
        conclusion: "failure",
        html_url: `${server}/j/3`,
      },
    ];
    project.logs.set(
      2,
      "2026-11-08T08:05:48.8700969Z Vitest caught 1 unhandled error during the test run.\n2026-11-08T08:05:48.8764393Z Error: setup failed\n",
    );
    project.logs.set(
      3,
      '2026-11-08T08:05:48.8766094Z This error originated in "tests/my file.test.ts" test file. It doesn\'t mean the error was thrown inside the file itself, but while it was running.\n',
    );

    const read = runOf(project, 523);
    await failures(read.args);
    expect(read.outputs.get("jobs")).toBe("");
    expect(read.outputs.get("files")).toBe("");
  });

  it("runs nothing again when a failed job's log names no test file, and pauses", async () => {
    const project = new Project();
    project.open(66);
    project.approve(66);
    const { members } = await formRun(project, 521);
    project.jobs = [
      { id: 2, name: "Batch checks / e2e", conclusion: "failure", html_url: `${server}/j/2` },
      { id: 3, name: "Batch checks / typecheck", conclusion: "failure", html_url: `${server}/j/3` },
    ];
    project.logs.set(
      2,
      "2026-11-06T17:20:01.0000000Z   1 failed\n2026-11-06T17:20:01.0000000Z     [desktop] › tests/e2e/card-leave.spec.ts:14:1 › leaves a card\n",
    );
    project.logs.set(3, "2026-11-06T17:20:01.0000000Z src/a.ts(3,1): error TS2304\n");

    const read = runOf(project, 521);
    await failures(read.args);
    expect(read.outputs.get("jobs")).toBe("");
    expect(read.outputs.get("files")).toBe("");

    await decide({
      ...runOf(project, 521).args,
      result: "failure",
      confirm: "skipped",
      members,
      tree: TREE,
    });
    expect(project.queueOf(66)).toMatchObject({ kind: "paused", run: 521 });
    expect(project.issues[0]?.body).toContain("nothing ran again");
  });

  it("still pauses a red batch when the project cannot open the pause's issue", async () => {
    const project = new Project();
    project.open(75);
    project.approve(75);
    const { members } = await formRun(project, 506);
    project.jobs = [
      { id: 2, name: "Batch checks / unit", conclusion: "failure", html_url: `${server}/j/2` },
    ];
    // A project with Issues turned off: GitHub refuses the new issue.
    project.issuesOff = true;

    await expect(
      decide({ ...runOf(project, 506).args, result: "failure", members, tree: TREE }),
    ).rejects.toThrow();

    expect(project.queueOf(75)).toMatchObject({ kind: "paused", run: 506 });
    project.runs.set(506, { id: 506, status: "completed", conclusion: "failure" });
    project.open(76);
    project.approve(76);
    const later = await formRun(project, 507);
    expect(later.members).toEqual([]);

    // A resume by hand still turns the paused change back to waiting and
    // starts the next batch, with no issue to close.
    await answer({ ...runOf(project, 508).args, action: "resume", reason: "a flake" });
    expect(project.queueOf(75)).toMatchObject({ kind: "waiting" });
    expect(project.dispatches).toHaveLength(1);
  });

  it("ends a pause once the declared fix is approved, and takes every paused change, every waiting change and the fix", async () => {
    const project = new Project();
    project.open(81);
    project.open(82);
    project.approve(81);
    project.approve(82);
    const first = await formRun(project, 506);
    await decide({
      ...runOf(project, 506).args,
      result: "failure",
      members: first.members,
      tree: TREE,
    });
    project.runs.set(506, { id: 506, status: "completed", conclusion: "success" });
    project.open(83);
    project.approve(83);
    project.open(84, { labels: [FIX_LABEL] });

    // The fix's own pull request, open but not yet approved, changes nothing.
    expect((await formRun(project, 507)).members).toEqual([]);

    project.approve(84);
    const fixed = await formRun(project, 508);

    expect(fixed.members.map((member) => member.number)).toEqual([81, 82, 83, 84]);
    for (const number of [81, 82, 83, 84])
      expect(project.queueOf(number)).toMatchObject({ kind: "in-batch", run: 508 });
    expect(project.issues[0]?.state).toBe("closed");
    expect(project.issues[0]?.comments.join(" ")).toMatch(/#84 was approved as the fix/);
  });

  // The follow-up the review of the merge line filed: "The shipped queue
  // ends a pause only for a fix change approved for that pause, so a
  // fix-labelled change that stays waiting cannot end a later, unrelated
  // pause or re-batch red changes with no repair." It replays this
  // project's own queue: a pull request kept its fix label from one pause,
  // waited outside the next batch and was approved again, and the next
  // pause ended with no repair, so the same red changes ran again.
  it("holds a pause that a fix label put on before it began does not answer, and ends it once the label is put on again", async () => {
    const project = new Project();
    project.open(81);
    project.open(82);
    // An earlier pause's fix, which keeps its label.
    project.open(85, { labels: [FIX_LABEL] });
    for (const number of [81, 82, 85]) project.approve(number);

    // With no pause, the label ends nothing, and the form says no pause ends.
    const first = await formRun(project, 520, { 85: "conflict-batch" });
    expect(first.members.map((member) => member.number)).toEqual([81, 82]);
    expect(first.run.notices[0]).toBe("3 approved changes are waiting.");
    expect(project.queueOf(85)).toMatchObject({ kind: "waiting" });
    await decide({
      ...runOf(project, 520).args,
      result: "failure",
      members: first.members,
      tree: TREE,
    });
    project.runs.set(520, { id: 520, status: "completed", conclusion: "failure" });

    // The labelled change still waiting beside the new pause ends nothing.
    const held = await formRun(project, 521);
    expect(held.members).toEqual([]);
    expect(held.run.notices.join(" ")).toMatch(
      /#85 carries a fix label not put on after this pause began, so the pause holds\./,
    );
    expect(project.queueOf(81)).toMatchObject({ kind: "paused", run: 520 });

    // Nor does its new version, approved while the pause holds.
    project.push(85, "8".repeat(40));
    project.approve(85);
    expect((await formRun(project, 522)).members).toEqual([]);
    expect(project.queueOf(82)).toMatchObject({ kind: "paused", run: 520 });
    expect(project.issues[0]?.state).toBe("open");

    // Its repair declares it this pause's fix by putting the label on again.
    project.unlabel(85, FIX_LABEL);
    project.label(85, FIX_LABEL);
    const fixed = await formRun(project, 523);
    expect(fixed.members.map((member) => member.number)).toEqual([81, 82, 85]);
    expect(project.issues[0]?.state).toBe("closed");
    expect(project.issues[0]?.comments).toEqual([
      expect.stringMatching(/^#85 was approved as the fix, so the pause ended/),
    ]);
  });

  it("resumes by hand with a reason, or sends one change back and resumes the rest", async () => {
    const project = new Project();
    for (const number of [91, 92, 93]) {
      project.open(number);
      project.approve(number);
    }
    const first = await formRun(project, 509);
    await decide({
      ...runOf(project, 509).args,
      result: "failure",
      members: first.members,
      tree: TREE,
    });

    await answer({
      ...runOf(project, 510).args,
      action: "send-back",
      number: "92",
      reason: "it breaks the checkout page",
    });

    expect(project.queueOf(92)).toMatchObject({
      state: "failure",
      description: "Sent back: it breaks the checkout page",
    });
    expect(project.queueOf(91)).toMatchObject({ kind: "waiting" });
    expect(project.queueOf(93)).toMatchObject({ kind: "waiting" });
    expect(project.issues[0]?.state).toBe("closed");
    expect(project.dispatches).toEqual([
      {
        owner,
        repo: name,
        workflow_id: "infinitary-queue.yml",
        ref: "main",
        inputs: { action: "form" },
      },
    ]);

    await expect(
      answer({ ...runOf(project, 511).args, action: "resume", reason: " " }),
    ).rejects.toThrow(/Say why/);
  });

  // INF-3183's approved plan, piece three: "A by-hand send-back writes its
  // failure only on the version that carried the paused status. When the
  // pull request has moved on, it writes nothing, says so in the pause
  // issue, and resumes the rest." The chain it replays: a batch pauses, the
  // change's crewmate pushes the fix, and a repair then sends the change
  // back by its number.
  it("sends back nothing when the pull request moved on from its paused version, says so on the issue, and the next batch takes the fix", async () => {
    const project = new Project();
    for (const number of [91, 92, 93]) {
      project.open(number);
      project.approve(number);
    }
    const first = await formRun(project, 509);
    await decide({
      ...runOf(project, 509).args,
      result: "failure",
      members: first.members,
      tree: TREE,
    });
    project.runs.set(509, { id: 509, status: "completed", conclusion: "failure" });
    const fixed = sha(9_200);
    project.push(92, fixed);

    const sent = runOf(project, 510);
    await answer({
      ...sent.args,
      action: "send-back",
      number: "92",
      reason: "it breaks the checkout page",
    });

    // Nothing is written on the fix, which no batch ran, nor on the paused
    // version the pull request left.
    expect(project.statuses.get(fixed)).toBeUndefined();
    expect(project.statuses.get(sha(92))?.[0]).toMatchObject({ state: "pending" });
    expect(queueKind("pending", project.statuses.get(sha(92))?.[0]?.description)).toMatchObject({
      kind: "paused",
      run: 509,
    });
    expect(project.queueOf(91)).toMatchObject({ kind: "waiting" });
    expect(project.queueOf(93)).toMatchObject({ kind: "waiting" });
    expect(project.issues[0]?.state).toBe("closed");
    expect(project.issues[0]?.comments).toEqual([
      "#92 was not sent back: its pull request moved on to a version no batch has run, so the queue wrote nothing on it and resumed the rest. The reason given: it breaks the checkout page",
    ]);
    expect(sent.notices).toEqual([
      "#92 was not sent back, since its pull request moved on to a version no batch has run; 2 paused changes wait again.",
    ]);
    expect(project.dispatches).toHaveLength(1);

    // Once the approver's Infinitary marks the fix waiting, it joins the
    // next batch with the rest, after them in approval order.
    project.approve(92);
    const next = await formRun(project, 511);
    expect(next.members).toEqual([
      { number: 91, head: sha(91) },
      { number: 93, head: sha(93) },
      { number: 92, head: fixed },
    ]);
  });

  it("sends back nothing on a version the approver marked waiting since the pause", async () => {
    const project = new Project();
    for (const number of [94, 95]) {
      project.open(number);
      project.approve(number);
    }
    const first = await formRun(project, 512);
    await decide({
      ...runOf(project, 512).args,
      result: "failure",
      members: first.members,
      tree: TREE,
    });
    const fixed = sha(9_500);
    project.push(95, fixed);
    project.approve(95);

    await answer({
      ...runOf(project, 513).args,
      action: "send-back",
      number: "95",
      reason: "the fix is pushed",
    });

    expect(project.queueOf(95)).toMatchObject({ kind: "waiting" });
    expect(project.statuses.get(fixed)).toHaveLength(1);
    expect(project.queueOf(94)).toMatchObject({ kind: "waiting" });
    expect(project.issues[0]?.comments).toEqual([
      '#95 was not sent back: its current version is not paused but reads "Waiting for the batch check", so the queue wrote nothing on it and resumed the rest. The reason given: the fix is pushed',
    ]);
  });

  it("sends back a change in a batch run that is still running, which the run's verdict takes as its answer", async () => {
    const project = new Project();
    for (const number of [96, 97]) {
      project.open(number);
      project.approve(number);
    }
    const { members } = await formRun(project, 514);

    await answer({
      ...runOf(project, 515).args,
      action: "send-back",
      number: "97",
      reason: "it breaks the cart",
    });
    expect(project.queueOf(97)).toMatchObject({
      kind: "failed",
      description: "Sent back: it breaks the cart",
    });

    const verdictRun = runOf(project, 514);
    await decide({ ...verdictRun.args, result: "failure", members, tree: TREE });
    expect(project.queueOf(96)).toMatchObject({ kind: "waiting" });
    expect(project.issues).toEqual([]);
  });

  // Captain's accepted settled-batch fix: a send-back ends an already-failed
  // run, not a run with no failed check. REST job rows are the signal; no
  // workflow timing or log wording decides whether the next batch can form.
  it.each(["failure", null] as const)(
    "handles a send-back while one batch check reads %s and another still runs",
    async (conclusion) => {
      const project = new Project();
      for (const number of [96, 97]) {
        project.open(number);
        project.approve(number);
      }
      await formRun(project, 514);
      project.open(98);
      project.approve(98);
      project.jobs = [
        { id: 610, name: "Batch checks / Unit tests", conclusion, html_url: `${server}/jobs/610` },
        {
          id: 611,
          name: "Batch checks / Journeys",
          conclusion: null,
          html_url: `${server}/jobs/611`,
        },
      ];
      await answer({
        ...runOf(project, 515).args,
        action: "send-back",
        number: "97",
        reason: "it breaks the cart",
      });
      expect(project.queueOf(97)).toMatchObject({ kind: "failed" });
      expect(project.cancelled).toEqual(conclusion ? [514] : []);
      expect(project.queueOf(96)).toMatchObject({ kind: conclusion ? "waiting" : "in-batch" });
      expect(project.queueOf(98)).toMatchObject({ kind: "waiting" });
      expect(project.dispatches).toHaveLength(1);
      const next = await formRun(project, 516);
      expect(next.members.map((member) => member.number)).toEqual(conclusion ? [96, 98] : []);
      expect(project.issues).toEqual([]);
    },
  );

  // The captain's answers on the review (checks-inherit-queue-writes, "Limit
  // the checks", and setup-grants): the batch's own code runs with a read of
  // the project and only the secrets the team names, so it cannot write
  // infinitary/queue. As shipped the call names none and never inherits
  // them; the team adds each named secret to this call by name, since GitHub
  // hands a called workflow only what its caller passes.
  it("calls the batch checks with a read of the project and hands down no secret", () => {
    const require = createRequire(import.meta.url);
    const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml") as {
      load: (text: string) => { jobs: Record<string, Record<string, unknown>> };
    };
    const workflow = yaml.load(readFileSync(new URL("./workflow.yml", import.meta.url), "utf8"));
    const checks = workflow.jobs.checks;
    expect(checks?.uses).toBe("./.github/workflows/infinitary-batch-checks.yml");
    expect(checks?.permissions).toEqual({ contents: "read" });
    expect(checks).not.toHaveProperty("secrets");
    // The confirm calls the same file with the same grants, told what failed.
    const confirm = workflow.jobs.confirm;
    expect(confirm?.uses).toBe(checks?.uses);
    expect(confirm?.permissions).toEqual(checks?.permissions);
    expect(confirm).not.toHaveProperty("secrets");
    expect(confirm?.with).toEqual({
      ...(checks?.with as object),
      failed_jobs: "${{ needs.failures.outputs.jobs }}",
      failed_files: "${{ needs.failures.outputs.files }}",
    });
  });

  // The window cannot import the queue's rules, so it keeps its own copy of
  // the status name; a teammate's app reads the status by that copy.
  it("names the same queue status the window and the app read", () => {
    expect(QUEUE_STATUS).toBe(QUEUE);
  });
});
