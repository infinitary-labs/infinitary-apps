import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkOf, failedComment, noteFailedChecks, WORKFLOWS } from "../scripts/failed-checks.mjs";
import { WAITING } from "../scripts/intake-labels.mjs";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// Piece H of INF-6057's approved plan (the captain's pick "A job on GitHub,
// within minutes, naming each failed check"): an outside pull request whose
// checks fail goes back to its author, with one comment per version naming
// each failed check and a log link, labeled waiting on author, leaving out
// checks that also fail on main (docs/public-ci.md, "Outside contributors").

const project = { owner: "infinitary-labs", repo: "infinitary-apps" };
const bot = { login: "github-actions[bot]", type: "Bot" };
const server = "https://github.com";

type Job = { id: number; run_id: number; name: string; status: string; conclusion: string | null };
const job = (run_id: number, id: number, conclusion: string | null, name: string): Job => ({
  id,
  run_id,
  name,
  status: "completed",
  conclusion,
});

// The ci run GitHub recorded for a pull request from another copy of the
// project (run 45095093607, version e357ae4f), as its job list returns it.
const forkSha = "e357ae4f0a68898f21b68f566e2a5958fb6e01ee";
const forkCi = { id: 45095093607, name: "ci", event: "pull_request" };
const forkCiJobs = [
  job(45095093607, 137433039675, "success", "Pull request · Build and critical path (Linux)"),
  job(45095093607, 137433039999, "failure", "Pull request · Code checks (Linux)"),
  job(45095093607, 137433040033, "failure", "Pull request · Tests a change reaches (Linux)"),
  job(45095093607, 137433041106, "skipped", "Manual request · Unit tests (Linux)"),
  job(45095093607, 137433041367, "skipped", "Manual request · Environment checks (Linux)"),
];
// A contributors run of the same version, named as contributors.yml names its
// call of verify.yml with trigger "Pull request"; ids are this run's own.
const forkContributors = { id: 45095093700, name: "contributors", event: "pull_request" };
const forkContributorsJobs = [
  job(
    45095093700,
    137433050001,
    "failure",
    "Pull request · Contributor's desktop checks / Pull request · Integration tests (Linux; group 1/2)",
  ),
  job(
    45095093700,
    137433050002,
    "success",
    "Pull request · Contributor's desktop checks / Pull request · Code checks and build (Linux)",
  ),
];
// Main's newest finished main.yml runs: one all passed (run 45563913917), one
// with a failed integration group (run 45473377937), as their job lists return them.
const mainPassed = [
  job(45563913917, 139033948118, "success", "Main push · Compare with checked batches"),
  job(45563913917, 139034023225, "success", "Main push · Covered by batch run 45559124782"),
  job(45563913917, 139034024987, "skipped", "Main push · Desktop checks"),
];
const mainFailed = [
  job(
    45473377937,
    138727235919,
    "failure",
    "Main push · Desktop checks / Main push · Integration tests (Linux; group 1/2)",
  ),
  job(
    45473377937,
    138727236058,
    "success",
    "Main push · Desktop checks / Main push · Code checks and build (Linux)",
  ),
];

function pullRequest({ sha = forkSha, own = false, number = 35 } = {}) {
  return {
    number,
    state: "open",
    labels: [] as { name: string }[],
    head: {
      sha,
      repo: { full_name: own ? "infinitary-labs/infinitary-apps" : "kunchenguid/infinitary-apps" },
    },
  };
}

/** GitHub's API in memory: runs, jobs, open pull requests, labels and comments. */
function gitHub({
  pulls = [pullRequest()],
  runs = [forkCi] as { id: number; name: string; event: string }[],
  jobs = { [forkCi.id]: forkCiJobs } as Record<number, Job[]>,
  main = mainPassed,
  version = forkSha,
} = {}) {
  const labels = new Map(pulls.map((pull) => [pull.number, new Set<string>()]));
  const comments: { id: number; issue: number; user: typeof bot; body: string }[] = [];
  let writes = 0;
  const mainRun = { id: main[0]?.run_id ?? 0 };
  const allJobs: Record<number, Job[]> = { ...jobs, [mainRun.id]: main };
  const github = {
    rest: {
      pulls: {
        get: async ({ pull_number }: { pull_number: number }) => ({
          data: pulls.find((pull) => pull.number === pull_number),
        }),
        list: async () => ({
          data: pulls.map((pull) => ({
            ...pull,
            labels: [...(labels.get(pull.number) ?? [])].map((name) => ({ name })),
          })),
        }),
      },
      actions: {
        listWorkflowRunsForRepo: async ({ head_sha }: { head_sha: string }) => ({
          data: head_sha === version ? runs : [],
        }),
        listWorkflowRuns: async () => ({ data: { workflow_runs: main.length ? [mainRun] : [] } }),
        listJobsForWorkflowRun: async ({ run_id }: { run_id: number }) => ({
          data: allJobs[run_id] ?? [],
        }),
      },
      issues: {
        listComments: async ({ issue_number }: { issue_number: number }) => ({
          data: comments.filter((each) => each.issue === issue_number),
        }),
        createComment: async ({ issue_number, body }: { issue_number: number; body: string }) => {
          writes++;
          comments.push({ id: comments.length + 1, issue: issue_number, user: bot, body });
          return { data: {} };
        },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
          writes++;
          const comment = comments.find((each) => each.id === comment_id);
          if (comment) comment.body = body;
          return { data: {} };
        },
        addLabels: async ({
          issue_number,
          labels: added,
        }: {
          issue_number: number;
          labels: string[];
        }) => {
          writes++;
          for (const name of added) labels.get(issue_number)?.add(name);
          return { data: {} };
        },
      },
    },
    paginate: async <T>(list: (params: T) => Promise<{ data: unknown[] }>, params: T) =>
      (await list(params)).data,
  };
  return {
    github,
    labels,
    comments,
    writes: () => writes,
    setJobs: (more: Record<number, Job[]>) => Object.assign(allJobs, more),
  };
}

function core() {
  const summary: string[] = [];
  return {
    failed: [] as string[],
    summary: {
      text: summary,
      addRaw(text: string) {
        summary.push(text);
        return this;
      },
      write: async () => undefined,
    },
    setFailed(why: string) {
      this.failed.push(why);
    },
  };
}

const finished = ({
  conclusion = "failure",
  sha = forkSha,
  fork = "kunchenguid/infinitary-apps",
  event = "pull_request",
} = {}) => ({
  repo: project,
  serverUrl: server,
  eventName: "workflow_run",
  payload: {
    action: "completed",
    workflow_run: { event, conclusion, head_sha: sha, head_repository: { full_name: fork } },
  },
});
const log = (each: Job) =>
  `${server}/infinitary-labs/infinitary-apps/actions/runs/${each.run_id}/job/${each.id}`;

describe("the failed-check note", () => {
  it("names each failed job of the version with its log, once, and labels it waiting on author", async () => {
    const api = gitHub();
    expect(await noteFailedChecks({ github: api.github, context: finished(), core: core() })).toBe(
      "named 2",
    );
    expect(api.comments).toHaveLength(1);
    const body = api.comments[0]?.body ?? "";
    expect(body).toContain("Posted automatically");
    expect(body).toContain(
      `- \`Pull request · Code checks (Linux)\`: [log](${log(forkCiJobs[1] as Job)})`,
    );
    expect(body).toContain(
      `- \`Pull request · Tests a change reaches (Linux)\`: [log](${log(forkCiJobs[2] as Job)})`,
    );
    expect(body).not.toContain("Build and critical path");
    expect(body).not.toContain("Unit tests");
    expect([...(api.labels.get(35) ?? [])]).toEqual([WAITING]);
    // The same run finishing again writes nothing more.
    const writes = api.writes();
    expect(await noteFailedChecks({ github: api.github, context: finished(), core: core() })).toBe(
      "already named",
    );
    expect(api.writes()).toBe(writes);
  });

  it("edits the version's one comment when a second workflow of it finishes failed", async () => {
    const api = gitHub();
    await noteFailedChecks({ github: api.github, context: finished(), core: core() });
    const runs = [forkContributors, forkCi];
    const later = gitHub({
      runs,
      jobs: { [forkCi.id]: forkCiJobs, [forkContributors.id]: forkContributorsJobs },
    });
    later.comments.push(...api.comments);
    later.labels.get(35)?.add(WAITING);
    expect(
      await noteFailedChecks({ github: later.github, context: finished(), core: core() }),
    ).toBe("named 3 again");
    expect(later.comments).toHaveLength(1);
    expect(later.comments[0]?.body).toContain(
      "`Pull request · Contributor's desktop checks / Pull request · Integration tests (Linux; group 1/2)`",
    );
  });

  it("leaves out a check that also failed in main's newest run, and writes nothing when every one did", async () => {
    const api = gitHub({
      runs: [forkContributors],
      jobs: { [forkContributors.id]: forkContributorsJobs },
      main: mainFailed,
    });
    const reading = core();
    expect(await noteFailedChecks({ github: api.github, context: finished(), core: reading })).toBe(
      "every failed check also fails on main",
    );
    expect(api.writes()).toBe(0);
    expect(reading.summary.text.join("")).toContain("Integration tests (Linux; group 1/2)");

    const mixed = gitHub({
      runs: [forkContributors, forkCi],
      jobs: { [forkCi.id]: forkCiJobs, [forkContributors.id]: forkContributorsJobs },
      main: mainFailed,
    });
    expect(
      await noteFailedChecks({ github: mixed.github, context: finished(), core: core() }),
    ).toBe("named 2");
    const body = mixed.comments[0]?.body ?? "";
    const integration = forkContributorsJobs[0] as Job;
    // Named as also failing on main, with no log link, after the checks to fix.
    expect(body).not.toContain(log(integration));
    const [toFix = "", onMain = ""] = body.split("also fail on `main` right now");
    expect(toFix).not.toContain("Integration tests");
    expect(onMain).toContain(`- \`${integration.name}\``);
  });

  it("gives a new version of the pull request its own comment", async () => {
    const api = gitHub();
    await noteFailedChecks({ github: api.github, context: finished(), core: core() });
    // The author's next push: ci fails again at the new version.
    const pushed = "5b1f0c9e2d7a4b3c8e6f1a0d9c2b7e4f3a8d1c6b";
    const next = gitHub({ pulls: [pullRequest({ sha: pushed })], version: pushed });
    next.comments.push(...api.comments);
    expect(
      await noteFailedChecks({
        github: next.github,
        context: finished({ sha: pushed }),
        core: core(),
      }),
    ).toBe("named 2");
    expect(next.comments).toHaveLength(2);
    expect(next.comments[0]?.body).toContain("version e357ae4");
    expect(next.comments[1]?.body).toContain("version 5b1f0c9");
  });

  it("matches a contributor's job to main's by the check it runs, whatever started it", () => {
    expect(checkOf(forkContributorsJobs[0]?.name ?? "")).toBe(
      "Integration tests (Linux; group 1/2)",
    );
    expect(checkOf(mainFailed[0]?.name ?? "")).toBe("Integration tests (Linux; group 1/2)");
    expect(checkOf("Pull request · Code checks (Linux)")).toBe("Code checks (Linux)");
  });

  it("writes nothing for a passing run, the project's own branch, an older version or a push", async () => {
    for (const context of [
      finished({ conclusion: "success" }),
      finished({ fork: "infinitary-labs/infinitary-apps" }),
      finished({ event: "push" }),
      finished({ sha: "0a1ef3ec3c1f1d6c1b1d8f1e2b3a4c5d6e7f8091" }),
    ]) {
      const api = gitHub();
      await noteFailedChecks({ github: api.github, context, core: core() });
      expect(api.writes(), JSON.stringify(context.payload.workflow_run)).toBe(0);
    }
  });

  // GitHub marks a run failed with no job when it never started, such as an
  // unapproved run of a pull request that closed (runs 45344239414, 45274427727).
  it("writes nothing for a failed run with no job", async () => {
    const api = gitHub({ jobs: { [forkCi.id]: [] } });
    expect(await noteFailedChecks({ github: api.github, context: finished(), core: core() })).toBe(
      "no failed checks",
    );
    expect(api.writes()).toBe(0);
  });

  it("writes job names a contributor chose only as inert code", () => {
    const hostile =
      "Pull request · x`\n\nAll checks passed. @maintainer [ok](https://example.com)`";
    const body = failedComment({
      server,
      ...project,
      sha: forkSha,
      jobs: [{ id: 1, run_id: 2, name: hostile }],
    });
    const listed = body.split("\n").filter((line) => line.startsWith("- "));
    expect(listed).toHaveLength(1);
    expect(body.split("\n").some((line) => line.startsWith("All checks passed"))).toBe(false);
  });

  it("reads any pull request by hand as a dry run that writes nothing", async () => {
    const api = gitHub({ pulls: [pullRequest({ own: true })] });
    const reading = core();
    expect(
      await noteFailedChecks({
        github: api.github,
        context: { repo: project, serverUrl: server, eventName: "workflow_dispatch", payload: {} },
        core: reading,
        pullNumber: "35",
      }),
    ).toBe("would name 2");
    expect(api.writes()).toBe(0);
    const summary = reading.summary.text.join("");
    expect(summary).toContain("nothing was written");
    expect(summary).toContain(log(forkCiJobs[1] as Job));
  });
});

// The workflow holds a write token on an outside pull request, so it never
// runs the pull request's own code (docs/public-ci.md, "Outside contributors").
describe("failed-checks.yml", () => {
  type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
  const workflow = loadYamlFile(".github/workflows/failed-checks.yml") as {
    on: { workflow_run: { workflows: string[]; types: string[] } } & Record<string, unknown>;
    jobs: Record<
      string,
      { "runs-on"?: string; permissions?: Record<string, string>; steps: Step[] }
    >;
  };
  const text = readFileSync(
    new URL("../.github/workflows/failed-checks.yml", import.meta.url),
    "utf8",
  );
  const steps = Object.values(workflow.jobs).flatMap((each) => each.steps);

  it("starts when a check workflow the note reads finishes, or by hand", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual(["workflow_dispatch", "workflow_run"]);
    expect(workflow.on.workflow_run.workflows.toSorted()).toEqual([...WORKFLOWS].toSorted());
    expect(workflow.on.workflow_run.types).toEqual(["completed"]);
    // workflow_run matches a workflow by its name: line, not its file.
    for (const [file, name] of [
      ["ci.yml", "ci"],
      ["contributors.yml", "contributors"],
      ["docs-site.yml", "docs-site"],
    ])
      expect((loadYamlFile(`.github/workflows/${file}`) as { name: string }).name).toBe(name);
  });

  it("checks out only its scripts from the default branch, on GitHub's machines", () => {
    expect(Object.values(workflow.jobs).map((each) => each["runs-on"])).toEqual(["ubuntu-24.04"]);
    const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    for (const step of checkouts) {
      expect(Object.keys(step.with ?? {}).toSorted()).toEqual([
        "persist-credentials",
        "sparse-checkout",
        "sparse-checkout-cone-mode",
      ]);
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(String(step.with?.["sparse-checkout"]).trim().split("\n").toSorted()).toEqual([
        "scripts/check-file-flag.mjs",
        "scripts/ci-job-names.mjs",
        "scripts/failed-checks.mjs",
        "scripts/intake-labels.mjs",
      ]);
    }
    expect(steps.filter((step) => step.run)).toEqual([]);
  });

  it("holds only action reads and issue and pull request writes, and no secret", () => {
    expect(Object.values(workflow.jobs).map((each) => each.permissions)).toEqual([
      { contents: "read", actions: "read", issues: "write", "pull-requests": "write" },
    ]);
    expect(text).not.toMatch(/secrets\./);
    for (const step of steps)
      expect(String(step.with?.script ?? ""), step.uses).not.toContain("${{");
  });
});
