import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { QUEUE_STATUS } from "@shared/repos";
import { describe, expect, it } from "vitest";
import type { ScriptArgs } from "./github.mjs";
import { answer, decide, form, mark } from "./github.mjs";
import type { Member } from "./rules.mjs";
import { FIX_LABEL, PAUSE_LABEL, QUEUE, queueKind, readPauseMarker, WAITING } from "./rules.mjs";

// INF-2952 piece 1, the captain's approved plan: a shipped fix-forward queue
// that runs in the project's own CI, which every teammate's Infinitary reads.
// "Red: every change reads Paused with a link to one new issue naming the
// failed check and the paused changes; nothing reruns, no change is blamed,
// and new approvals wait", and "a change its crewmate declares as the
// pause's fix ends the pause once approved; the next batch takes every
// paused change, every waiting change and the fix". The stand-in answers in
// the shapes GitHub's REST API answers github-script's client with.

const owner = "acme";
const name = "shop";
const server = "https://github.com";
const sha = (n: number) => n.toString(16).padStart(40, "a");
const TREE = "be6452e81a110b0c50d7354add8d59a231807cce";

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
  jobs: { id: number; name: string; conclusion: string | null; html_url: string }[] = [];
  logs = new Map<number, string>();
  files = new Map<number, string[]>();
  dispatches: unknown[] = [];
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
      labels: (options.labels ?? []).map((label) => ({ name: label })),
    };
    this.pulls.set(number, pull);
    return pull;
  }

  /** An approver's Infinitary marking the version waiting, as its merge click does. */
  approve(number: number): void {
    this.write(sha(number), "pending", WAITING, "");
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
    const latest = this.statuses.get(sha(number))?.find((status) => status.context === QUEUE);
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

/** The compose step's output for these members: each merged, then the tree. */
const composed = (members: Member[], conflicts: Record<number, string> = {}) =>
  `${members.map((member) => `${conflicts[member.number] ?? "merged"} ${member.number}`).join("\n")}\ntree ${TREE}\n`;

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

  it("pauses a red batch behind one issue that names the failed check and the paused changes, rerunning nothing", async () => {
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

    await decide({ ...runOf(project, 504).args, result: "failure", members, tree: TREE });

    expect(project.issues).toHaveLength(1);
    const [issue] = project.issues;
    expect(issue?.labels).toEqual([PAUSE_LABEL]);
    expect(issue?.body).toContain("[Batch checks / e2e]");
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
  });

  // The window cannot import the queue's rules, so it keeps its own copy of
  // the status name; a teammate's app reads the status by that copy.
  it("names the same queue status the window and the app read", () => {
    expect(QUEUE_STATUS).toBe(QUEUE);
  });
});
