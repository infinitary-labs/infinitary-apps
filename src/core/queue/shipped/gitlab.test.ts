import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { GitLabQueueApi, GitLabQueueEnv } from "./gitlab.mjs";
import {
  answer,
  batchPipeline,
  CHECKS_JOB,
  decide,
  form,
  gitlabApi,
  HELD,
  noBatchPipeline,
  QUEUE_ENVIRONMENT,
  readHeads,
} from "./gitlab.mjs";
import type { Member } from "./rules.mjs";
import { FIX_LABEL, PAUSE_LABEL, QUEUE, queueKind, readPauseMarker, WAITING } from "./rules.mjs";

// INF-2952 piece 2, the captain's approved plan: the fix-forward queue's
// GitLab part, which runs the same rules as GitHub's in the project's own
// GitLab CI. "Red: every change reads Paused with a link to one new issue
// naming the failed check and the paused changes; nothing reruns, no change
// is blamed, and new approvals wait", and "a change its crewmate declares as
// the pause's fix ends the pause once approved". The stand-in answers in the
// shapes GitLab's REST API answers, and refuses what GitLab refuses: a
// commit status set to pending while one is already pending.

const PROJECT = "acme%2Fshop";
/** A Maintainer, whose Infinitary marks and whose queue key writes; and a Developer. */
const MAINTAINER_ID = 7;
const DEVELOPER_ID = 8;
const server = "https://gitlab.example.com";
const sha = (n: number) => n.toString(16).padStart(40, "a");
const TREE = "be6452e81a110b0c50d7354add8d59a231807cce";

type Status = {
  id: number;
  status: string;
  name: string;
  description: string;
  target_url: string;
  created_at: string;
  author: { id: number };
};
type Request = {
  iid: number;
  state: string;
  sha: string;
  target_branch: string;
  labels: string[];
};
type Issue = {
  iid: number;
  title: string;
  description: string;
  state: string;
  labels: string[];
  web_url: string;
  notes: string[];
};

/** A project on GitLab as the queue's API reads and writes it. */
class Project {
  requests = new Map<number, Request>();
  statuses = new Map<string, Status[]>();
  issues: Issue[] = [];
  pipelines = new Map<number, { id: number; status: string }>();
  /** Each queue pipeline's checks child: its state and failed jobs. */
  checks = new Map<number, { id: number; status: string; web_url: string }>();
  jobs = new Map<number, { id: number; name: string; status: string; web_url: string }[]>();
  traces = new Map<number, string>();
  diffs = new Map<number, string[]>();
  started: unknown[] = [];
  issuesOff = false;
  /** Each member's role by user id: 40 is Maintainer, 30 Developer. The queue's own key is a Maintainer. */
  members = new Map<number, number>([
    [MAINTAINER_ID, 40],
    [DEVELOPER_ID, 30],
  ]);
  /** Who approves each merge request now, by user id. */
  approvals = new Map<number, number[]>();
  /** Each merge request's versions, as GitLab lists its diff versions, and its notes. */
  versions = new Map<number, { head_commit_sha: string; created_at: string }[]>();
  notes = new Map<
    number,
    { system: boolean; body: string; author: { id: number }; created_at: string }[]
  >();
  private clock = Date.parse("2026-11-06T17:00:00Z");
  private ids = 9_000;

  open(iid: number, options: { base?: string; labels?: string[] } = {}): Request {
    const request = {
      iid,
      state: "opened",
      sha: sha(iid),
      target_branch: options.base ?? "main",
      labels: options.labels ?? [],
    };
    this.requests.set(iid, request);
    this.pushed(iid, request.sha);
    return request;
  }

  /** A new version of the merge request: GitLab adds a diff version, and keeps its approvals. */
  push(iid: number, head: string): void {
    const request = this.requests.get(iid);
    if (request) request.sha = head;
    this.pushed(iid, head);
  }

  private pushed(iid: number, head: string): void {
    this.clock += 60_000;
    this.versions.set(iid, [
      { head_commit_sha: head, created_at: new Date(this.clock).toISOString() },
      ...(this.versions.get(iid) ?? []),
    ]);
  }

  /** An approver's Infinitary marking the version waiting, as its merge click does on GitLab. */
  approve(iid: number, by = MAINTAINER_ID): void {
    this.write(this.requests.get(iid)?.sha ?? sha(iid), "skipped", WAITING, "", by);
  }

  /** Someone pressing Approve on the merge request: GitLab lists them and writes its system note. */
  approveRequest(iid: number, by: number): void {
    this.clock += 60_000;
    this.approvals.set(iid, [...(this.approvals.get(iid) ?? []), by]);
    this.notes.set(iid, [
      ...(this.notes.get(iid) ?? []),
      {
        system: true,
        body: "approved this merge request",
        author: { id: by },
        created_at: new Date(this.clock).toISOString(),
      },
    ]);
  }

  write(at: string, status: string, description: string, url: string, by = MAINTAINER_ID): void {
    const list = this.statuses.get(at) ?? [];
    // GitLab keeps one unfinished status per name and refuses to set it
    // waiting again: the queue writes only finished ones.
    if (
      ["pending", "running"].includes(status) &&
      list.some((old) => ["pending", "running"].includes(old.status))
    )
      throw Object.assign(new Error("Cannot transition status via :enqueue"), { status: 400 });
    this.clock += 60_000;
    list.unshift({
      id: this.ids++,
      status,
      name: QUEUE,
      description,
      target_url: url,
      created_at: new Date(this.clock).toISOString(),
      author: { id: by },
    });
    this.statuses.set(at, list);
  }

  queueOf(iid: number) {
    const latest = this.statuses.get(this.requests.get(iid)?.sha ?? sha(iid))?.[0];
    if (!latest) return undefined;
    const state =
      latest.status === "success" ? "success" : latest.status === "failed" ? "failure" : "pending";
    return { ...queueKind(state, latest.description), ...latest };
  }

  api(): GitLabQueueApi {
    const base = `/projects/${PROJECT}`;
    const route = (method: string, path: string, body?: Record<string, unknown>): unknown => {
      const url = new URL(path, server);
      if (!url.pathname.startsWith(base)) throw new Error(`Not this project: ${path}`);
      const at = url.pathname.slice(base.length);
      // The path's captured parts, once `hit` matched it.
      const found: string[] = [];
      const hit = (pattern: RegExp) => {
        const match = pattern.exec(at);
        found.splice(0, found.length, ...(match ?? []));
        return match !== null;
      };
      if (method === "GET" && at === "/merge_requests")
        return [...this.requests.values()].filter((request) => request.state === "opened");
      if (method === "GET" && hit(/^\/merge_requests\/(\d+)$/))
        return this.requests.get(Number(found[1]));
      if (method === "GET" && hit(/^\/merge_requests\/(\d+)\/approvals$/))
        return {
          approved_by: (this.approvals.get(Number(found[1])) ?? []).map((id) => ({ user: { id } })),
        };
      if (method === "GET" && hit(/^\/merge_requests\/(\d+)\/versions$/))
        return this.versions.get(Number(found[1])) ?? [];
      if (method === "GET" && hit(/^\/merge_requests\/(\d+)\/notes$/))
        return this.notes.get(Number(found[1])) ?? [];
      if (method === "GET" && hit(/^\/members\/all\/(\d+)$/)) {
        const level = this.members.get(Number(found[1]));
        if (level === undefined) throw Object.assign(new Error("Not found"), { status: 404 });
        return { id: Number(found[1]), access_level: level };
      }
      if (method === "GET" && hit(/^\/merge_requests\/(\d+)\/diffs$/))
        return (this.diffs.get(Number(found[1])) ?? []).map((file) => ({
          new_path: file,
          old_path: file,
        }));
      if (method === "GET" && hit(/^\/repository\/commits\/([0-9a-f]+)\/statuses$/))
        return (this.statuses.get(found[1] ?? "") ?? []).filter(
          (status) => status.name === url.searchParams.get("name"),
        );
      if (method === "POST" && hit(/^\/statuses\/([0-9a-f]+)$/)) {
        this.write(
          found[1] ?? "",
          String(body?.state),
          String(body?.description),
          String(body?.target_url ?? ""),
        );
        return {};
      }
      if (method === "GET" && hit(/^\/pipelines\/(\d+)$/))
        return this.pipelines.get(Number(found[1]));
      if (method === "GET" && hit(/^\/pipelines\/(\d+)\/bridges$/)) {
        const child = this.checks.get(Number(found[1]));
        return [{ name: CHECKS_JOB, downstream_pipeline: child ?? null }];
      }
      if (method === "GET" && hit(/^\/pipelines\/(\d+)\/jobs$/))
        return this.jobs.get(Number(found[1])) ?? [];
      if (method === "GET" && hit(/^\/jobs\/(\d+)\/trace$/)) {
        const trace = this.traces.get(Number(found[1]));
        if (trace === undefined) throw Object.assign(new Error("Not found"), { status: 404 });
        return trace;
      }
      if (method === "POST" && at === "/pipeline") {
        this.started.push(body);
        return { id: 9999 };
      }
      if (at === "/issues" || at.startsWith("/issues/")) {
        if (this.issuesOff) throw Object.assign(new Error("Issues are off"), { status: 403 });
        if (method === "GET")
          return this.issues.filter(
            (issue) =>
              issue.state === "opened" &&
              issue.labels.includes(url.searchParams.get("labels") ?? ""),
          );
        if (method === "POST" && at === "/issues") {
          const iid = 300 + this.issues.length;
          const issue = {
            iid,
            title: String(body?.title),
            description: String(body?.description),
            labels: String(body?.labels).split(","),
            state: "opened",
            notes: [],
            web_url: `${server}/acme/shop/-/issues/${iid}`,
          };
          this.issues.push(issue);
          return issue;
        }
        const issue = this.issues.find((candidate) => at.startsWith(`/issues/${candidate.iid}`));
        if (method === "POST" && at.endsWith("/notes")) {
          issue?.notes.push(String(body?.body));
          return {};
        }
        if (method === "PUT" && issue && body?.state_event === "close") issue.state = "closed";
        return issue;
      }
      throw new Error(`The stand-in does not answer ${method} ${path}`);
    };
    return {
      get: async (path) => route("GET", path),
      text: async (path) => String(route("GET", path)),
      send: async (method, path, body) => route(method, path, body as Record<string, unknown>),
      list: async (path) => route("GET", path) as unknown[],
    };
  }
}

const envOf = (pipelineId: number): GitLabQueueEnv => ({
  project: "acme/shop",
  defaultBranch: "main",
  pipelineId,
  pipelineUrl: `${server}/acme/shop/-/pipelines/${pipelineId}`,
});

/** The compose step's output for these members: each merged, then the tree. */
const composed = (members: Member[], conflicts: Record<number, string> = {}) =>
  `${members.map((member) => `${conflicts[member.number] ?? "merged"} ${member.number}`).join("\n")}\ntree ${TREE}\n`;

/** One queue pipeline's form job; answers what it put in the batch and what it said. */
async function formRun(
  project: Project,
  pipelineId: number,
  conflicts: Record<number, string> = {},
) {
  const said: string[] = [];
  const formed = await form({
    api: project.api(),
    env: envOf(pipelineId),
    log: (text) => said.push(text),
    compose: (members) => composed(members, conflicts),
  });
  if (formed.run) project.pipelines.set(pipelineId, { id: pipelineId, status: "running" });
  return { ...formed, said };
}

const decideRun = (project: Project, pipelineId: number, members: Member[]) =>
  decide({ api: project.api(), env: envOf(pipelineId), log: () => {}, members, tree: TREE });

describe("the shipped queue on GitLab", () => {
  // Review of the GitLab part, the captain's choice: "admit a change to the
  // batch only if a Maintainer marked or approved it". The batch runs on the
  // protected default branch with its protected variables, and anyone who
  // may push may write a commit status.
  it("takes a waiting change into a batch only once a Maintainer marked or approved it", async () => {
    const project = new Project();
    project.open(51);
    project.open(52);
    project.approve(51, DEVELOPER_ID);
    project.approve(52);

    const first = await formRun(project, 601);
    expect(first.members.map((member) => member.number)).toEqual([52]);
    expect(first.said.join("\n")).toContain(`!51: ${HELD}`);
    // Its own status says why it waits, written once however often the queue forms.
    expect(project.queueOf(51)).toMatchObject({ kind: "waiting", description: HELD });

    project.pipelines.set(601, { id: 601, status: "success" });
    project.write(sha(52), "success", `Passed batch run 601; tree ${TREE}`, "");
    project.requests.delete(52);
    expect((await formRun(project, 600)).members).toEqual([]);
    expect(
      project.statuses.get(sha(51))?.filter((status) => status.description === HELD),
    ).toHaveLength(1);
    project.approveRequest(51, DEVELOPER_ID);
    project.approveRequest(51, MAINTAINER_ID);
    const second = await formRun(project, 602);
    expect(second.members.map((member) => member.number)).toEqual([51]);
  });

  // The re-review's finding (forged-batch-status): a Developer may write any
  // queue status, so neither a forged in-batch status nor a resume's waiting
  // mark over a forged pause admits its code.
  it("takes no change whose queue stretch a Developer opened, whatever state it claims", async () => {
    const project = new Project();
    project.open(61);
    project.open(62);
    project.pipelines.set(590, { id: 590, status: "success" });
    project.write(sha(61), "skipped", "In batch run 590", "", DEVELOPER_ID);
    project.write(sha(62), "skipped", "Paused after batch run 590", "", DEVELOPER_ID);
    project.write(sha(62), "skipped", WAITING, "", MAINTAINER_ID);

    const run = await formRun(project, 610);
    expect(run.members).toEqual([]);
    expect(run.said.join("\n")).toContain(`!61: ${HELD}`);
    expect(run.said.join("\n")).toContain(`!62: ${HELD}`);
  });

  // The re-review's finding (approval-not-tied-to-head): GitLab may keep an
  // approval across a push, so it admits only the version it was given on.
  it("admits an approved change only at a version the approval came after", async () => {
    const project = new Project();
    project.open(71);
    project.approveRequest(71, MAINTAINER_ID);
    const later = "7".repeat(40);
    project.push(71, later);
    project.approve(71, DEVELOPER_ID);

    const first = await formRun(project, 620);
    expect(first.members).toEqual([]);
    expect(first.said.join("\n")).toContain(`!71: ${HELD}`);

    project.approveRequest(71, MAINTAINER_ID);
    const second = await formRun(project, 621);
    expect(second.members.map((member) => member.head)).toEqual([later]);
  });

  it("forms one batch from every teammate's approval in approval order, leaving a stacked change waiting", async () => {
    const project = new Project();
    project.open(41);
    project.open(42);
    project.open(43, { base: "feature" });
    project.open(44);
    project.approve(42);
    project.approve(41);
    project.approve(43);

    const { members, tree } = await formRun(project, 501);

    expect(members.map((member) => member.number)).toEqual([42, 41]);
    expect(tree).toBe(TREE);
    expect(project.queueOf(42)).toMatchObject({ kind: "in-batch", run: 501, status: "skipped" });
    expect(project.queueOf(43)).toMatchObject({ kind: "waiting" });
    expect(project.queueOf(44)).toBeUndefined();
  });

  it("sends a change that conflicts with the default branch back, and keeps one that conflicts only within the batch waiting", async () => {
    const project = new Project();
    for (const number of [51, 52, 53]) {
      project.open(number);
      project.approve(number);
    }
    const { members, said } = await formRun(project, 502, {
      51: "conflict-main",
      52: "conflict-batch",
    });

    expect(members.map((member) => member.number)).toEqual([53]);
    expect(project.queueOf(51)).toMatchObject({ status: "failed", kind: "failed" });
    expect(project.queueOf(51)?.description).toMatch(/bring the branch up to date/);
    expect(project.queueOf(52)).toMatchObject({ kind: "waiting" });
    expect(said.join(" ")).toContain("!52 conflicts only with an earlier change");
  });

  it("passes every change of a green batch with the batch's tree, and starts nothing", async () => {
    const project = new Project();
    project.open(61);
    project.approve(61);
    const { members } = await formRun(project, 503);
    project.checks.set(503, { id: 603, status: "success", web_url: `${server}/p/603` });

    await decideRun(project, 503, members);

    expect(project.queueOf(61)).toMatchObject({
      kind: "passed",
      run: 503,
      tree: TREE,
      status: "success",
    });
    expect(project.started).toEqual([]);
  });

  it("pauses a red batch behind one issue that names the failed job and the paused changes, rerunning nothing", async () => {
    const project = new Project();
    project.open(71);
    project.open(72);
    project.diffs.set(72, ["tests/e2e/card-leave.spec.ts"]);
    project.approve(71);
    project.approve(72);
    const { members } = await formRun(project, 504);
    project.checks.set(504, { id: 604, status: "failed", web_url: `${server}/p/604` });
    project.jobs.set(604, [
      { id: 2, name: "e2e", status: "failed", web_url: `${server}/acme/shop/-/jobs/2` },
    ]);
    project.traces.set(
      2,
      "  1 failed\n    [desktop] › tests/e2e/card-leave.spec.ts:14:1 › leaves a card\n",
    );

    await decideRun(project, 504, members);

    expect(project.issues).toHaveLength(1);
    const [issue] = project.issues;
    expect(issue?.labels).toEqual([PAUSE_LABEL]);
    expect(issue?.description).toContain("[e2e]");
    // This part runs no confirm, so the issue says nothing ran again, and
    // never claims no log named a test file when this one named one.
    expect(issue?.description).toContain("nothing runs again");
    expect(issue?.description).not.toContain("named no failed test file");
    // GitLab names a merge request !N, so the issue does too.
    expect(issue?.description).toContain("- !71\n- !72");
    expect(readPauseMarker(issue?.description)).toEqual({ run: 504, changes: [71, 72] });
    for (const number of [71, 72]) {
      expect(project.queueOf(number)).toMatchObject({
        kind: "paused",
        run: 504,
        target_url: issue?.web_url,
      });
      expect(project.queueOf(number)?.description).toContain(
        "tests/e2e/card-leave.spec.ts failed; touched by !72",
      );
    }
    expect(project.started).toEqual([]);

    // A new approval waits behind the pause.
    project.pipelines.set(504, { id: 504, status: "failed" });
    project.open(73);
    project.approve(73);
    const later = await formRun(project, 505);
    expect(later.members).toEqual([]);
    expect(later.said.join(" ")).toMatch(/paused until its fix is approved/);
    expect(project.queueOf(73)).toMatchObject({ kind: "waiting" });
  });

  // GitLab's part reads failed jobs' logs with the same rules: a job Vitest
  // failed on an unhandled error, with every test passed and no FAIL line,
  // still names the test file Vitest says the error came from.
  it("names the test file an unhandled error came from in the pause's issue and statuses", async () => {
    const project = new Project();
    project.open(74);
    project.diffs.set(74, ["tests/phone-scene-projection.test.ts"]);
    project.approve(74);
    const { members } = await formRun(project, 506);
    project.checks.set(506, { id: 606, status: "failed", web_url: `${server}/p/606` });
    project.jobs.set(606, [
      { id: 3, name: "unit", status: "failed", web_url: `${server}/acme/shop/-/jobs/3` },
    ]);
    project.traces.set(
      3,
      [
        "Vitest caught 1 unhandled error during the test run.",
        " Test Files  81 passed (81)",
        '\u001b[31mThis error originated in "\u001b[1mtests/phone-scene-projection.test.ts\u001b[22m" test file. It doesn\'t mean the error was thrown inside the file itself, but while it was running.\u001b[39m',
        "",
      ].join("\n"),
    );

    await decideRun(project, 506, members);

    const [issue] = project.issues;
    expect(issue?.description).toContain(
      "Failed test files:\n- `tests/phone-scene-projection.test.ts` (touched by !74)",
    );
    expect(project.queueOf(74)).toMatchObject({ kind: "paused", run: 506 });
    expect(project.queueOf(74)?.description).toContain(
      "tests/phone-scene-projection.test.ts failed; touched by !74",
    );
  });

  it("pauses a red batch whose checks never started, naming the checks job", async () => {
    const project = new Project();
    project.open(74);
    project.approve(74);
    const { members } = await formRun(project, 520);

    await decideRun(project, 520, members);

    expect(project.queueOf(74)).toMatchObject({ kind: "paused", run: 520 });
    expect(project.issues[0]?.description).toContain(`[${CHECKS_JOB}]`);
  });

  it("still pauses a red batch when the project cannot open the pause's issue", async () => {
    const project = new Project();
    project.open(75);
    project.approve(75);
    const { members } = await formRun(project, 506);
    project.checks.set(506, { id: 606, status: "failed", web_url: `${server}/p/606` });
    project.issuesOff = true;

    await expect(decideRun(project, 506, members)).rejects.toThrow();

    expect(project.queueOf(75)).toMatchObject({ kind: "paused", run: 506 });
    project.pipelines.set(506, { id: 506, status: "failed" });

    // A resume by hand still turns the paused change back to waiting and
    // starts the next batch, with no issue to close.
    await answer({
      api: project.api(),
      env: envOf(0),
      log: () => {},
      action: "resume",
      reason: "a flake",
    });
    expect(project.queueOf(75)).toMatchObject({ kind: "waiting" });
    expect(project.started).toEqual([{ ref: "main" }]);
  });

  it("ends a pause once the declared fix is approved, and takes every paused change, every waiting change and the fix", async () => {
    const project = new Project();
    project.open(81);
    project.open(82);
    project.approve(81);
    project.approve(82);
    const first = await formRun(project, 507);
    project.checks.set(507, { id: 607, status: "failed", web_url: `${server}/p/607` });
    await decideRun(project, 507, first.members);
    project.pipelines.set(507, { id: 507, status: "failed" });
    project.open(83);
    project.approve(83);
    project.open(84, { labels: [FIX_LABEL] });

    // The fix's own merge request, open but not yet approved, changes nothing.
    expect((await formRun(project, 508)).members).toEqual([]);

    project.approve(84);
    const fixed = await formRun(project, 509);

    expect(fixed.members.map((member) => member.number)).toEqual([81, 82, 83, 84]);
    for (const number of [81, 82, 83, 84])
      expect(project.queueOf(number)).toMatchObject({ kind: "in-batch", run: 509 });
    expect(project.issues[0]?.state).toBe("closed");
    expect(project.issues[0]?.notes.join(" ")).toMatch(/!84 was approved as the fix/);
  });

  it("resumes by hand with a reason, or sends one change back and resumes the rest", async () => {
    const project = new Project();
    for (const number of [91, 92, 93]) {
      project.open(number);
      project.approve(number);
    }
    const first = await formRun(project, 510);
    project.checks.set(510, { id: 610, status: "failed", web_url: `${server}/p/610` });
    await decideRun(project, 510, first.members);

    await answer({
      api: project.api(),
      env: envOf(0),
      log: () => {},
      action: "send-back",
      number: "92",
      reason: "it breaks the checkout page",
    });

    expect(project.queueOf(92)).toMatchObject({
      status: "failed",
      description: "Sent back: it breaks the checkout page",
    });
    expect(project.queueOf(91)).toMatchObject({ kind: "waiting" });
    expect(project.queueOf(93)).toMatchObject({ kind: "waiting" });
    expect(project.issues[0]?.state).toBe("closed");
    expect(project.issues[0]?.notes.join(" ")).toMatch(/!92 was sent back by hand/);
    expect(project.started).toEqual([{ ref: "main" }]);

    await expect(
      answer({ api: project.api(), env: envOf(0), log: () => {}, action: "resume", reason: " " }),
    ).rejects.toThrow(/Say why/);
  });

  it("reads every page GitLab's next-page header names, with the token in GitLab's header", async () => {
    const asked: { url: string; token: string | null }[] = [];
    const api = gitlabApi({
      url: `${server}/api/v4`,
      token: "glpat-stand-in",
      fetchImpl: (async (url: string, init: RequestInit) => {
        asked.push({ url, token: new Headers(init.headers).get("PRIVATE-TOKEN") });
        const page = Number(new URL(url).searchParams.get("page"));
        return new Response(JSON.stringify([{ page }]), {
          headers: { "x-next-page": page < 2 ? String(page + 1) : "" },
        });
      }) as typeof fetch,
    });

    expect(await api.list("/projects/1/merge_requests?state=opened")).toEqual([
      { page: 1 },
      { page: 2 },
    ]);
    expect(asked.map((call) => call.url)).toEqual([
      `${server}/api/v4/projects/1/merge_requests?state=opened&page=1`,
      `${server}/api/v4/projects/1/merge_requests?state=opened&page=2`,
    ]);
    expect(asked.every((call) => call.token === "glpat-stand-in")).toBe(true);
  });

  it("reads a batch's member list back, and refuses a word that is not one", () => {
    expect(readHeads(`12:${sha(12)} 7:${sha(7)}`)).toEqual([
      { number: 12, head: sha(12) },
      { number: 7, head: sha(7) },
    ]);
    expect(readHeads("")).toEqual([]);
    expect(() => readHeads("12:main")).toThrow(/Not a batch member/);
  });

  // The plan's checks-inherit-queue-writes answer: the batch's own code
  // cannot write infinitary/queue. On GitLab the queue's token reaches only
  // jobs that name the queue's environment, and the batch runs in a child
  // pipeline whose jobs name none; the queue's jobs run only in a pipeline
  // the API started on the default branch.
  it("hands the queue's token only to its own jobs, and runs them only in an API pipeline on the default branch", () => {
    const require = createRequire(import.meta.url);
    const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml") as {
      load: (text: string) => Record<string, Record<string, unknown>>;
    };
    const queue = yaml.load(readFileSync(new URL("./gitlab-queue.yml", import.meta.url), "utf8"));
    const jobs = Object.entries(queue).filter(([name]) => !name.startsWith("."));
    const named = jobs
      .filter(([, job]) => (job.environment as { name?: string } | undefined)?.name)
      .map(([name]) => name);
    expect(named).toEqual(["infinitary-queue-form", "infinitary-queue-verdict"]);
    expect(queue[CHECKS_JOB]?.environment).toBeUndefined();
    expect(queue["infinitary-queue-form"]?.environment).toEqual({
      name: QUEUE_ENVIRONMENT,
      action: "prepare",
    });
    const rule = '$CI_PIPELINE_SOURCE == "api" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH';
    expect(queue[".infinitary-queue"]?.rules).toEqual([{ if: rule }]);
    expect(queue["infinitary-queue-verdict"]?.rules).toEqual([{ if: rule, when: "always" }]);

    const child = yaml.load(batchPipeline({ heads: `1:${sha(1)}`, base: sha(9), tree: TREE }));
    expect(child.include).toEqual([
      { local: ".gitlab/infinitary-batch.yml" },
      { local: ".gitlab/infinitary-batch-checks.yml" },
    ]);
    expect(JSON.stringify(child)).not.toContain("environment");
  });

  // Review of the GitLab part: GitLab refuses to create a pipeline whose
  // trigger job carries a keyword a trigger job may not have, such as
  // `image` (docs.gitlab.com, "Trigger job" keywords), so every pipeline of
  // a project including the queue would fail before it started.
  it("gives the checks job, a trigger job, only the keywords GitLab allows one, through its template too", () => {
    const queue = loadYaml(readFileSync(new URL("./gitlab-queue.yml", import.meta.url), "utf8"));
    const trigger = queue[CHECKS_JOB] ?? {};
    const template = queue[String(trigger.extends)] ?? {};
    const allowed = new Set([
      "allow_failure",
      "extends",
      "needs",
      "only",
      "except",
      "parallel",
      "rules",
      "stage",
      "trigger",
      "variables",
      "when",
      "resource_group",
      "environment",
      "inherit",
      "interruptible",
    ]);
    expect(Object.keys({ ...template, ...trigger }).filter((key) => !allowed.has(key))).toEqual([]);
    expect(queue["infinitary-queue-form"]?.image).toBe("node:22");
    expect(queue["infinitary-queue-verdict"]?.image).toBe("node:22");
  });

  // Review of the GitLab part: the form job's reason after a multi-change
  // batch's merges reads "A green batch is still merging: #12", and a plain
  // YAML scalar with `: ` is a mapping GitLab refuses as a script line.
  it("writes a no-batch reason with a colon or a hash as one script line GitLab reads as words", () => {
    for (const reason of ["A green batch is still merging: #12", "Nothing waits #7: ok"]) {
      const child = loadYaml(noBatchPipeline(reason));
      expect(child["infinitary-no-batch"]?.script).toEqual([`echo ${JSON.stringify(reason)}`]);
    }
  });
});

/** GitLab's YAML as js-yaml reads it, from the copy electron-builder brings. */
function loadYaml(text: string): Record<string, Record<string, unknown>> {
  const require = createRequire(import.meta.url);
  const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml") as {
    load: (text: string) => Record<string, Record<string, unknown>>;
  };
  return yaml.load(text);
}
