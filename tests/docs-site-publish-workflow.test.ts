import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { releaseSource } from "../src/core/update/releaseSource";
import { loadYamlFile, workflowValue } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The docs site's publish run (docs/docs-site.md, "Publishing"; piece 2 of
 * the docs site's approved plan): it publishes docs.getinfinitary.com only
 * from main, only for the authorized operator, one run at a time and never
 * cancelled midway, and only main's newest version. The guard is evaluated
 * as GitHub Actions evaluates it, and the newest-version step runs as a
 * runner runs it, against a real git repository standing in for origin.
 */

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
};
type Workflow = {
  on: Record<
    string,
    { branches?: string[]; paths?: string[]; workflows?: string[]; types?: string[] } | null
  >;
  concurrency: { group: string; "cancel-in-progress": boolean; queue?: string };
  jobs: Record<string, Job>;
};
type Job = { if: string; name: string; environment: string; "runs-on": string; steps: Step[] };
const publish = loadYamlFile(".github/workflows/docs-site-publish.yml") as unknown as Workflow;
const check = loadYamlFile(".github/workflows/docs-site.yml") as unknown as Workflow;
const job = publish.jobs.publish as Job;

const OPERATOR = "kunchenguid";
// The project that publishes is the one the releases come from (packaging/release-source.json).
const mainPush = {
  repository: releaseSource.repository,
  ref: "refs/heads/main",
  actor: OPERATOR,
  event_name: "push",
};
const releaseEnded = (conclusion: string, head_branch = "main") => ({
  ...mainPush,
  event_name: "workflow_run",
  event: { workflow_run: { conclusion, head_branch } },
});

describe("who and what starts a publish", () => {
  it("starts only on a push to main, a release run's end or a manual run, never a pull request", () => {
    expect(Object.keys(publish.on).toSorted()).toEqual([
      "push",
      "workflow_dispatch",
      "workflow_run",
    ]);
    expect(publish.on.push?.branches).toEqual(["main"]);
  });

  // INF-4723: the What's new page is built from the release tags, so the
  // publish checks out every commit and tag, and runs again after a release.
  it("builds from the whole history and follows the release run", () => {
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    const release = loadYamlFile(".github/workflows/release.yml") as { name: string };
    expect(publish.on.workflow_run).toEqual({ workflows: [release.name], types: ["completed"] });
  });

  // The publish follows the files the site's own check reads, so a change the
  // check passed is the change that publishes.
  it("publishes on the files the docs site's check covers", () => {
    const own = (paths: string[] = [], file: string) =>
      paths.filter((path) => path !== `.github/workflows/${file}`);
    expect(own(publish.on.push?.paths, "docs-site-publish.yml")).toEqual(
      own(check.on.push?.paths, "docs-site.yml"),
    );
    expect(publish.on.push?.paths).toContain(".github/workflows/docs-site-publish.yml");
  });

  it.each([
    ["a merge to main by the operator", mainPush, true],
    [
      "a manual run on main by the operator",
      { ...mainPush, event_name: "workflow_dispatch" },
      true,
    ],
    [
      "a manual run on a task branch",
      { ...mainPush, ref: "refs/heads/inf/publish-docs-site" },
      false,
    ],
    [
      "a pull request",
      { ...mainPush, event_name: "pull_request", ref: "refs/pull/12/merge" },
      false,
    ],
    ["anyone else", { ...mainPush, actor: "someone-else" }, false],
    [
      "the archived earlier project",
      { ...mainPush, repository: "infinitary-labs/infinitary" },
      false,
    ],
    ["a copy of the repository", { ...mainPush, repository: "someone-else/infinitary" }, false],
    ["a release run on main that succeeded", releaseEnded("success"), true],
    ["a release run that failed", releaseEnded("failure"), false],
    ["a release run from another branch", releaseEnded("success", "inf/other"), false],
    [
      "someone else's release run",
      { ...releaseEnded("success"), actor: "github-actions[bot]" },
      false,
    ],
  ])("lets %s publish: %s", (_, github, runs) => {
    expect(workflowValue(job.if, { github })).toBe(runs);
  });

  it("runs one publish at a time, keeping every waiting run and never cancelling one", () => {
    expect(publish.concurrency).toEqual({
      group: "docs-getinfinitary-live",
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  // The environment's own rule (docs/docs-site.md, "The key") lets only main's
  // runs read its secrets, so a workflow on another branch cannot reach the key.
  it("hands the key to a machine GitHub deletes after the job, and only to the steps that publish", () => {
    expect(job.environment).toBe("docs-site");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    const keyed = job.steps
      .filter((step) => Object.values(step.env ?? {}).some((value) => value.includes("secrets.")))
      .map((step) => step.name);
    expect(keyed).toEqual([
      "Preflight - confirm the account and zone, and that the address is ours or free",
      "Record the version serving now",
      "Publish",
    ]);
  });
});

// Which release runs count as stable, read from their jobs' names, which lead
// with what started them (scripts/ci-job-names.mjs). The names are the jobs of
// a stable release and an automatic alpha as GitHub listed them.
describe("a release run publishes only when it was a stable release", () => {
  const release = job.steps.find((step) => step.id === "release");
  const STABLE_JOBS = [
    "Requested stable · Build, sign and notarize (Mac)",
    "Requested stable · Select source and version",
    "Requested stable · Desktop checks",
  ];
  const ALPHA_JOBS = [
    "Automatic alpha · Select source and version",
    "Automatic alpha · Desktop checks",
  ];
  const REHEARSAL_JOBS = ["Requested stable rehearsal · Select source and version"];

  /** The step as a runner runs it, with a stand-in `gh` answering the run's job names. */
  function stable(names: string[]) {
    const folder = scratchDir("infinitary-docs-release-");
    try {
      const bin = join(folder, "bin");
      mkdirSync(bin);
      writeFileSync(join(folder, "names"), `${names.join("\n")}\n`);
      writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat "${join(folder, "names")}"\n`, {
        mode: 0o755,
      });
      const output = join(folder, "output");
      const env = hostEnv();
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", release?.run ?? ""], {
        env: {
          ...env,
          PATH: `${bin}:${env.PATH}`,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "o/r",
          RUN: "1",
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(output, "utf8");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  it("runs only for a release run's end", () => {
    expect(release?.if).toBe("github.event_name == 'workflow_run'");
  });

  it.each([
    ["a stable release", STABLE_JOBS, "stable=true\n"],
    ["an automatic alpha", ALPHA_JOBS, "stable=false\n"],
    ["a stable rehearsal", REHEARSAL_JOBS, "stable=false\n"],
  ])("reads %s", (_, names, output) => {
    expect(stable(names)).toBe(output);
  });
});

describe("only main's newest version publishes", () => {
  const newest = job.steps.find((step) => step.id === "newest");
  let folder: string;
  let origin: string;
  let work: string;

  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env: hostEnv(), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };

  /** A commit on main changing `file` (none when omitted), pushed to origin; answers its id. */
  const commit = (message: string, file?: string) => {
    if (file) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), `${message}\n`);
      git(work, "add", file);
    }
    git(work, "commit", "--allow-empty", "-q", "-m", message);
    git(work, "push", "-q", "origin", "HEAD:refs/heads/main");
    return git(work, "rev-parse", "HEAD");
  };

  beforeEach(() => {
    folder = scratchDir("infinitary-docs-publish-");
    origin = join(folder, "origin.git");
    work = join(folder, "work");
    git(folder, "init", "-q", "--bare", "-b", "main", origin);
    git(folder, "clone", "-q", origin, work);
    git(work, "config", "user.email", "test@example.com");
    git(work, "config", "user.name", "Test");
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /** The step as a runner runs it: `bash -e` in a checkout of the commit it was started for, with its own environment. */
  function run(env: Record<string, string>) {
    git(work, "checkout", "-q", "--detach", env.COMMIT ?? "HEAD");
    try {
      return runChecked(env);
    } finally {
      git(work, "checkout", "-q", "main");
    }
  }

  function runChecked(env: Record<string, string>) {
    const output = join(folder, "output");
    const summary = join(folder, "summary");
    rmSync(output, { force: true });
    rmSync(summary, { force: true });
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", newest?.run ?? ""], {
      cwd: work,
      env: {
        ...hostEnv(),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        SITE_PATHS: newest?.env?.SITE_PATHS ?? "",
        ...env,
      },
      encoding: "utf8",
    });
    const read = (path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    return {
      status: result.status,
      stdout: result.stdout,
      output: read(output),
      summary: read(summary),
    };
  }

  it("publishes main's newest version", () => {
    const tip = commit("docs: a page");
    expect(run({ COMMIT: tip, EVENT: "push" })).toMatchObject({
      status: 0,
      output: "publish=true\n",
    });
    expect(run({ COMMIT: tip, EVENT: "workflow_dispatch" })).toMatchObject({
      status: 0,
      output: "publish=true\n",
    });
  });

  it("leaves a merge that main has moved past to the newer merge's run, and refuses a manual run of it", () => {
    const older = commit("docs: a page", "docs-site/src/content/docs/install.md");
    const tip = commit("docs: another page", "docs-site/src/content/docs/index.mdx");
    const merge = run({ COMMIT: older, EVENT: "push" });
    expect(merge).toMatchObject({ status: 0, output: "publish=false\n" });
    expect(merge.summary).toContain(`main moved on to \`${tip}\`, which changes the site`);
    const manual = run({ COMMIT: older, EVENT: "workflow_dispatch" });
    expect(manual.status).toBe(1);
    expect(manual.stdout).toContain(`is not main's newest version (${tip})`);
    expect(manual.output).toBe("");
  });

  // The push trigger's paths filter starts no run for a merge outside the
  // site, so a merge run main moved past that way is the one that publishes.
  it("publishes a merge that main moved past only with files outside the site", () => {
    const older = commit("docs: a page", "docs-site/src/content/docs/install.md");
    commit("fix: an app change", "src/main/index.ts");
    commit(
      "feat: a design system change the site does not read",
      ".claude/skills/infinitary-design/tokens/motion.css",
    );
    expect(run({ COMMIT: older, EVENT: "push" })).toMatchObject({
      status: 0,
      output: "publish=true\n",
    });
  });

  // The runner's checkout is the older commit, so each path's glob must match
  // the newer commits' files, not the files that commit already holds.
  it.each([
    [
      "adds a font beside the fonts the site already reads",
      ".claude/skills/infinitary-design/assets/fonts/new.woff2",
    ],
    ["changes the archive pins", "release-notes/archive.json"],
    ["changes an archived manifest", "release-notes/releases/0.8.2.json"],
    ["adds a file directly under the site's folder", "docs-site/tsconfig.json"],
    ["edits a file directly under the site's folder", "docs-site/.gitignore"],
  ])("leaves a merge to the newer merge's run when that merge %s", (_, file) => {
    commit("feat: a font", ".claude/skills/infinitary-design/assets/fonts/first.woff2");
    commit("docs: ignore the build", "docs-site/.gitignore");
    const older = commit("docs: a page", "docs-site/src/content/docs/install.md");
    commit("docs: a later change", file);
    expect(run({ COMMIT: older, EVENT: "push" })).toMatchObject({
      status: 0,
      output: "publish=false\n",
    });
  });

  it("decides what changes the site by the paths that start a merge run", () => {
    expect(newest?.env?.SITE_PATHS?.split(" ")).toEqual(publish.on.push?.paths);
  });

  it("publishes after a stable release, and nothing after any other release run", () => {
    const tip = commit("chore: release");
    expect(run({ COMMIT: tip, EVENT: "workflow_run", STABLE: "true" })).toMatchObject({
      status: 0,
      output: "publish=true\n",
    });
    const alpha = run({ COMMIT: tip, EVENT: "workflow_run", STABLE: "false" });
    expect(alpha).toMatchObject({ status: 0, output: "publish=false\n" });
    expect(alpha.summary).toContain("Not a stable release");
  });

  it("fails a release's publish that main has moved past, so it is run again", () => {
    const older = commit("chore: release");
    commit("docs: another page");
    const late = run({ COMMIT: older, EVENT: "workflow_run", STABLE: "true" });
    expect(late.status).toBe(1);
    expect(late.output).toBe("");
  });

  it("publishes nothing when it cannot read main", () => {
    const tip = commit("docs: a page");
    git(work, "remote", "set-url", "origin", join(folder, "missing.git"));
    const result = run({ COMMIT: tip, EVENT: "push" });
    expect(result.status).toBe(1);
    expect(result.output).toBe("");
  });

  it("guards every step after it, so a superseded run publishes nothing", () => {
    const after = job.steps.slice(job.steps.indexOf(newest as Step) + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const step of after)
      expect(step).toMatchObject({ if: "steps.newest.outputs.publish == 'true'" });
  });
});

// The publish summary is readable by everyone with access to the repository,
// so it records the version serving before a publish without the address of
// whoever published it.
describe("the summary of the version serving before a publish", () => {
  const record = job.steps.find((step) => step.name === "Record the version serving now");
  // wrangler deployments list --json, in the shape Cloudflare's deployments API
  // answers (GET /accounts/{account}/workers/scripts/{name}/deployments).
  const deployments = [
    {
      id: "a1b2c3d4-0000-4000-8000-000000000001",
      source: "wrangler",
      strategy: "percentage",
      author_email: "owner@example.com",
      annotations: { "workers/triggered_by": "deployment", "workers/message": "docs-site 4cfc410" },
      created_on: "2026-11-18T02:10:00.000000Z",
      versions: [{ version_id: "5e6f7a8b-0000-4000-8000-000000000002", percentage: 100 }],
    },
  ];

  /** The step as a runner runs it, with a stand-in `pnpm` answering for wrangler. */
  function summarize(answer: string | null) {
    const folder = scratchDir("infinitary-docs-record-");
    try {
      const bin = join(folder, "bin");
      mkdirSync(bin);
      writeFileSync(join(folder, "answer.json"), answer ?? "");
      writeFileSync(
        join(bin, "pnpm"),
        answer === null
          ? "#!/bin/sh\necho 'This Worker does not exist on your account.' >&2\nexit 1\n"
          : `#!/bin/sh\ncat "${join(folder, "answer.json")}"\n`,
        { mode: 0o755 },
      );
      const summary = join(folder, "summary");
      const output = join(folder, "output");
      const env = hostEnv();
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", record?.run ?? ""], {
        env: {
          ...env,
          PATH: `${bin}:${env.PATH}`,
          RUNNER_TEMP: folder,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return { summary: readFileSync(summary, "utf8"), output: readFileSync(output, "utf8") };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  it("names each version and when it went live, never who published it", () => {
    const { summary, output } = summarize(JSON.stringify(deployments, null, 2));
    expect(summary).toContain(
      "2026-11-18T02:10:00.000000Z 5e6f7a8b-0000-4000-8000-000000000002 (100%)",
    );
    expect(summary).not.toContain("owner@example.com");
    expect(output).toBe("earlier=true\n");
  });

  it("says when there is no earlier version", () => {
    const { summary, output } = summarize(null);
    expect(summary).toContain("No earlier version (first publish).");
    expect(output).toBe("earlier=false\n");
  });
});

// The site's first publish (INF-4827): the live check asked the runner's
// resolver about docs.getinfinitary.com 0.1 s after the upload, before its DNS
// record existed, and every try then failed on the resolver's kept "no such
// name"; its failure then pointed at restoring an earlier version that a first
// publish does not have.
describe("the live check after a publish", () => {
  const live = job.steps.find((step) => step.name === "Check the live site");

  it("reads whether an earlier version exists from the step that records it", () => {
    const record = job.steps.find((step) => step.name === "Record the version serving now");
    expect(live?.env?.EARLIER).toBe(`\${{ steps.${record?.id}.outputs.earlier }}`);
  });

  /**
   * The step as a runner runs it, with stand-ins for `node`, answering for the
   * wait and the live check with the given exit statuses and noting each
   * script it runs, and for `sleep`.
   */
  function check(env: { EARLIER: string; WAIT: number; LIVE: number }) {
    const folder = scratchDir("infinitary-docs-live-");
    try {
      const bin = join(folder, "bin");
      mkdirSync(bin);
      const ran = join(folder, "ran");
      writeFileSync(
        join(bin, "node"),
        [
          "#!/bin/sh",
          `echo "$1" >> "${ran}"`,
          'case "$1" in',
          `  *wait-for-address.mjs) exit ${env.WAIT} ;;`,
          `  *check-live.mjs) echo "FAIL  home page: answers 200"; exit ${env.LIVE} ;;`,
          "esac",
          "exit 9",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const base = hostEnv();
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", live?.run ?? ""], {
        env: {
          ...base,
          PATH: `${bin}:${base.PATH}`,
          RUNNER_TEMP: folder,
          GITHUB_STEP_SUMMARY: join(folder, "summary"),
          EARLIER: env.EARLIER,
        },
        encoding: "utf8",
      });
      const scripts = readFileSync(ran, "utf8").trim().split("\n");
      return { status: result.status, stdout: result.stdout, scripts };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  it("waits for the address at the zone's name servers before the live check's first lookup", () => {
    const passing = check({ EARLIER: "true", WAIT: 0, LIVE: 0 });
    expect(passing.status).toBe(0);
    expect(passing.scripts).toEqual([
      "docs-site/scripts/wait-for-address.mjs",
      "docs-site/scripts/check-live.mjs",
    ]);

    const missing = check({ EARLIER: "false", WAIT: 1, LIVE: 0 });
    expect(missing.status).toBe(1);
    expect(missing.scripts).toEqual(["docs-site/scripts/wait-for-address.mjs"]);
    expect(missing.stdout).toContain(
      "::error::The wait for docs.getinfinitary.com at its zone's name servers stopped",
    );
  });

  it("points a failed first publish at withdrawing the site, and a later one at restoring", () => {
    const first = check({ EARLIER: "false", WAIT: 0, LIVE: 1 });
    expect(first.status).toBe(1);
    expect(first.scripts.filter((script) => script.endsWith("check-live.mjs"))).toHaveLength(10);
    expect(first.stdout).toContain('"Withdraw the site"');
    expect(first.stdout).not.toContain("Restore an earlier version");

    const later = check({ EARLIER: "true", WAIT: 0, LIVE: 1 });
    expect(later.status).toBe(1);
    expect(later.stdout).toContain('"Restore an earlier version"');
  });
});
