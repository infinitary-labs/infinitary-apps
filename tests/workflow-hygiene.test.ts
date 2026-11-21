import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadYamlFile, workflowValue } from "./helpers/releaseWorkflows";

// INF-2539 (the captain: audit the workflows for "messy archiecture,
// inefficiencies, inconsistencies, or code smell in general" and fix them):
// rules every workflow keeps, read from the files themselves.

const root = fileURLToPath(new URL("..", import.meta.url));
const workflows = readdirSync(join(root, ".github/workflows")).filter((file) =>
  file.endsWith(".yml"),
);
const actions = readdirSync(join(root, ".github/actions"));

type Step = {
  name?: string;
  id?: string;
  if?: string;
  "continue-on-error"?: boolean | string;
  "working-directory"?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type Permissions = string | Record<string, string>;
type Job = {
  steps?: Step[];
  uses?: string;
  permissions?: Permissions;
  defaults?: { run?: { "working-directory"?: string } };
};
type Workflow = { permissions?: Permissions; jobs: Record<string, Job> };

const LEVELS = ["none", "read", "write"];
// GitHub's token scopes, which `read-all` and `write-all` set together.
const SCOPES = [
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
];

/** A `permissions` value as GitHub reads it: a scope a map leaves out is `none`. */
function level(permissions: Permissions | undefined, scope: string): number {
  if (permissions === "read-all") return 1;
  if (permissions === "write-all") return 2;
  if (typeof permissions !== "object") return 0;
  return Math.max(0, LEVELS.indexOf(permissions[scope] ?? "none"));
}

/**
 * Each scope a called workflow's job asks its token for beyond the caller's
 * grant. GitHub refuses the whole run at startup for any of them (INF-2548:
 * ios-release.yml's run 41761851122 started no job), whatever the job's `if:`.
 * A called job with no `permissions` of its own reads its workflow's top-level
 * block, and with neither it takes the caller's token and asks for nothing.
 */
function permissionGaps(grant: Permissions | undefined, callee: Workflow): string[] {
  const gaps: string[] = [];
  for (const [id, job] of Object.entries(callee.jobs)) {
    const asked = job.permissions ?? callee.permissions;
    if (asked === undefined) continue;
    const scopes = new Set([...SCOPES, ...(typeof asked === "object" ? Object.keys(asked) : [])]);
    for (const scope of scopes) {
      const wants = level(asked, scope);
      const has = level(grant, scope);
      if (wants > has) gaps.push(`${id} asks ${scope}: ${LEVELS[wants]}, granted ${LEVELS[has]}`);
    }
  }
  return gaps;
}

const load = (file: string) => loadYamlFile(`.github/workflows/${file}`) as Workflow;
/**
 * Whether a shell script runs electron-builder to make more than an unpacked
 * folder - the targets whose tools it downloads (an AppImage, a package, a
 * disk image) - itself or through a script of this project it runs.
 */
function packagesBeyondFolder(script: string, seen = new Set<string>()): boolean {
  const lines = script
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""));
  for (const line of lines) {
    const call = /(?:^|[\s;&|(])electron-builder(?=\s|$)(.*)$/.exec(line);
    if (call && !/(^|\s)(--dir\b|--(mac|linux|win)\s+dir\b)/.test(call[1] ?? "")) return true;
    for (const [, path] of line.matchAll(/(?:^|[\s;&|(])(?:\.\/)?(scripts\/[\w.-]+\.sh)\b/g)) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (packagesBeyondFolder(readFileSync(join(root, path), "utf8"), seen)) return true;
    }
  }
  return false;
}

const LOCAL = "./.github/workflows/";
/** Every job that calls one of this project's workflows, with the token it grants. */
const calls = workflows.flatMap((file) => {
  const workflow = load(file);
  return Object.entries(workflow.jobs).flatMap(([id, job]) =>
    job.uses?.startsWith(LOCAL)
      ? [
          {
            caller: `${file}:${id}`,
            callee: job.uses.slice(LOCAL.length),
            grant: job.permissions ?? workflow.permissions,
          },
        ]
      : [],
  );
});

describe("every workflow", () => {
  it("pins remote actions and reusable workflows to full commit IDs", () => {
    function check(uses: string | undefined, where: string) {
      if (!uses || uses.startsWith("./") || uses.startsWith("docker://")) return;
      expect(uses, where).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }
    for (const file of workflows) {
      for (const [id, job] of Object.entries(load(file).jobs)) {
        const where = `${file}:${id}`;
        check(job.uses, where);
        for (const step of job.steps ?? []) check(step.uses, where);
      }
    }
    for (const action of actions) {
      const { runs } = loadYamlFile(`.github/actions/${action}/action.yml`) as {
        runs: { steps?: Step[] };
      };
      for (const step of runs.steps ?? []) check(step.uses, `actions/${action}`);
    }
  });

  // A workflow says what its token may do at the top, so a job that writes
  // (a status, a cancellation) names it and the rest hold a read-only token.
  it("declares its token's permissions at the top", () => {
    for (const file of workflows) {
      const { permissions } = load(file);
      expect(permissions, file).toMatchObject({ contents: expect.any(String) });
    }
  });

  // A caller's token bounds every job of the workflow it calls, at each level
  // of a nested call, so a caller grants at least what each called job asks.
  it("grants every workflow it calls what that workflow's jobs ask for", () => {
    expect(calls.map(({ caller, callee }) => `${caller} -> ${callee}`)).toContain(
      "ios-release.yml:phone -> phone.yml",
    );
    for (const { caller, callee, grant } of calls)
      expect(permissionGaps(grant, load(callee)), `${caller} -> ${callee}`).toEqual([]);
  });

  it("refuses a caller that grants a called job less than it asks for", () => {
    const phone = load("phone.yml");
    // ios-release.yml's call as run 41761851122 read it.
    expect(permissionGaps({ contents: "read" }, phone)).toEqual([
      "scene-evidence asks actions: read, granted none",
    ]);
    expect(permissionGaps({ contents: "read", actions: "read" }, phone)).toEqual([]);
    // Write is more than read; read-all grants no write.
    // Its wait job asks for no token, so only the two that cancel the run do.
    const alphaWait = load("alpha-wait.yml");
    const writes = [
      "find asks actions: write, granted read",
      "ended asks actions: write, granted read",
    ];
    expect(permissionGaps({ contents: "read", actions: "read" }, alphaWait)).toEqual(writes);
    expect(permissionGaps("read-all", alphaWait)).toEqual(writes);
    expect(permissionGaps("write-all", alphaWait)).toEqual([]);
    // A job's own block replaces its workflow's, and no block at all asks for nothing.
    const callee: Workflow = {
      permissions: { contents: "read" },
      jobs: { own: { permissions: { statuses: "write" } }, top: {} },
    };
    expect(permissionGaps({ contents: "read" }, callee)).toEqual([
      "own asks statuses: write, granted none",
    ]);
    expect(permissionGaps({}, { jobs: { inherits: {} } })).toEqual([]);
  });

  // Main's check run 42287797114 failed at its install, which the captain's
  // watch on main check failures sent to be fixed at its cause: Electron's
  // own installer took a 504 from GitHub's release server, the one download
  // an install still made after setup-node restored its packages. A phone
  // check's install later took the same 504 on Electron's zip and on the app's
  // own git, on a fresh virtual Mac whose setup-node keeps no package cache.
  // So every install restores what it downloads from that server first
  // (.github/actions/electron-download; docs/testing.md, "Downloads from
  // GitHub's release server").
  it("restores Electron's and git's downloads before every install", () => {
    const covered: string[] = [];
    for (const file of workflows) {
      for (const [id, job] of Object.entries(load(file).jobs)) {
        const steps = job.steps ?? [];
        const install = steps.findIndex((step) => /\bpnpm install\b/.test(step.run ?? ""));
        if (install < 0) continue;
        const where = `${file}:${id}`;
        // An install allowed to fail fails no check by a download.
        if (steps[install]?.["continue-on-error"] === true) continue;
        // The signing job runs on the project's own Mac, whose home keeps both
        // downloads between jobs, and restores nothing from the Actions cache
        // into the app it signs.
        if (where === "release.yml:release") continue;
        covered.push(where);
        const download = steps.findIndex((step) =>
          step.uses?.endsWith("/.github/actions/electron-download"),
        );
        expect(download, `${where} restores the downloads first`).toBeGreaterThanOrEqual(0);
        expect(download, `${where} restores the downloads first`).toBeLessThan(install);
      }
    }
    // The jobs whose installs failed on that server: main's check, and the phone check.
    expect(covered).toEqual(expect.arrayContaining(["verify.yml:lane", "phone.yml:native-phone"]));
  });

  // Journeys run 43298827793 and the pull request check in ci run 43360925106
  // failed at pnpm/action-setup before any project step ran: it installed
  // pnpm from npm's registry on every job, and all three of its tries timed
  // out on a self-hosted Linux machine. So every job outside the release path
  // takes pnpm from the Actions cache (.github/actions/pnpm), before its first
  // pnpm command and before setup-node, whose pnpm cache asks pnpm for its
  // store (docs/testing.md, "pnpm's own download").
  it("takes pnpm from the Actions cache before any step runs it", () => {
    // Jobs a change here is proven by only when a release runs them, and the
    // Windows trial, whose shell commands the action does not write. The list
    // only shrinks: each still sets up pnpm the old way.
    const releasePath: Record<string, string> = {
      "release.yml": "signs and publishes a release",
      "ios-release.yml": "publishes the phone app",
      "mac-update.yml": "the release's update check",
      "republish-casks.yml": "rewrites the published casks",
      "windows-feasibility.yml": "the Windows trial",
    };
    const covered: string[] = [];
    for (const file of workflows) {
      for (const [id, job] of Object.entries(load(file).jobs)) {
        const steps = job.steps ?? [];
        const where = `${file}:${id}`;
        const first = (match: (step: Step) => boolean) => steps.findIndex(match);
        const actionSetup = first((step) => !!step.uses?.startsWith("pnpm/action-setup"));
        if (file in releasePath) continue;
        expect(actionSetup, `${where} sets up pnpm from npm's registry`).toBe(-1);
        const runs = first((step) => /(^|[\s;&|(])pnpm\s/.test(step.run ?? ""));
        if (runs < 0) continue;
        covered.push(where);
        const cached = first((step) => !!step.uses?.endsWith("/.github/actions/pnpm"));
        expect(cached, `${where} takes pnpm from the Actions cache first`).toBeGreaterThanOrEqual(
          0,
        );
        expect(cached, `${where} takes pnpm from the Actions cache first`).toBeLessThan(runs);
        const nodeCache = first(
          (step) =>
            !!step.uses?.startsWith("actions/setup-node") &&
            String(step.with?.cache ?? "").includes("pnpm"),
        );
        if (nodeCache >= 0)
          expect(cached, `${where} puts pnpm on the PATH before setup-node`).toBeLessThan(
            nodeCache,
          );
      }
    }
    for (const [file, why] of Object.entries(releasePath))
      expect(
        Object.values(load(file).jobs).some((job) =>
          (job.steps ?? []).some((step) => step.uses?.startsWith("pnpm/action-setup")),
        ),
        `${file} (${why}) still sets up pnpm the old way, or leaves the list`,
      ).toBe(true);
    // The two jobs that failed (the branch check, now its three jobs), and a
    // virtual Mac's journeys.
    expect(covered).toEqual(
      expect.arrayContaining([
        "ci.yml:code-checks",
        "ci.yml:reached-tests",
        "ci.yml:build",
        "journeys.yml:choose-journeys",
        "source-journeys.yml:source-desktop",
        "journeys.yml:affected-journeys",
      ]),
    );
  });

  // Linux package run 42470282200 failed at its package step on a 504 from
  // GitHub's release server, where electron-builder downloads its packaging
  // tools: the AppImage tools, 7-Zip and fpm, and dmgbuild for a disk image.
  // So every step that packages beyond an unpacked folder restores those
  // tools before it and keeps them after it, even when it failed partway
  // (.github/actions/electron-builder-tools).
  it("restores electron-builder's tools around every step that packages beyond a folder", () => {
    const packaging: string[] = [];
    for (const file of workflows) {
      for (const [id, job] of Object.entries(load(file).jobs)) {
        const steps = job.steps ?? [];
        const where = `${file}:${id}`;
        steps.forEach((step, index) => {
          if (!packagesBeyondFolder(step.run ?? "")) return;
          // A job that packages in more than one step, such as the Windows
          // build's installer and its update check's test versions, is one job.
          if (!packaging.includes(where)) packaging.push(where);
          // The signing job's own Mac keeps electron-builder's cache in its home.
          if (where === "release.yml:release") return;
          const tools = (from: number, to: number) =>
            steps
              .slice(from, to)
              .filter((other) => other.uses?.endsWith("/.github/actions/electron-builder-tools"));
          const before = tools(0, index);
          expect(before.length, `${where} restores the tools before "${step.name}"`).toBe(1);
          expect(before[0]?.with?.save, `${where} restores, never saves, before`).toBeUndefined();
          const after = tools(index + 1, steps.length);
          expect(after.length, `${where} keeps the tools after "${step.name}"`).toBe(1);
          expect(after[0]?.with?.save).toBe("true");
          expect(after[0]?.if, `${where} keeps them whatever the step did`).toContain(
            "!cancelled()",
          );
        });
      }
    }
    expect(packaging.sort()).toEqual([
      "linux-packages.yml:build",
      "mac-installer.yml:build",
      "release.yml:release",
      "windows.yml:build",
    ]);
  });

  it("reads a step as packaging beyond a folder only when electron-builder makes more than one", () => {
    expect(
      packagesBeyondFolder(
        "pnpm exec electron-builder --linux --config electron-builder.linux.yml",
      ),
    ).toBe(true);
    expect(packagesBeyondFolder("pnpm exec electron-builder \\\n  --mac dmg --universal")).toBe(
      true,
    );
    expect(packagesBeyondFolder("pnpm exec electron-builder --mac dir --universal")).toBe(false);
    expect(packagesBeyondFolder("pnpm exec electron-builder \\\n  --mac dir --universal")).toBe(
      false,
    );
    expect(packagesBeyondFolder("pnpm exec electron-builder --dir")).toBe(false);
    expect(packagesBeyondFolder("# electron-builder --linux, in a comment\nnode -p 1")).toBe(false);
    expect(packagesBeyondFolder("cp electron-builder.yml out/")).toBe(false);
    // A script it runs, and a script that script runs.
    expect(packagesBeyondFolder("scripts/build-mac-dmg.sh app 1.0.0 out")).toBe(true);
    expect(packagesBeyondFolder("scripts/build-installer-fixtures.sh")).toBe(true);
    expect(packagesBeyondFolder("scripts/check-user-data-dir.sh app infinitary-dev")).toBe(false);
  });

  // Queue run 42464252348's merge batch failed its demo journeys in every
  // Linux journey group and on the Mac, which the captain's watch on main and
  // release-path check failures sent to be fixed at its cause: each fetched
  // the pinned encoder from GitHub's release server mid-journey and took a
  // 504 there. So every job that prepares Playwright's window recorder for a
  // recording journey restores the demo encoder's download too
  // (.github/actions/demo-encoder).
  // Every pull request's check prepares the Linux desktop in its build job for
  // its one fixed journey, the critical path, which records no demo, so it
  // restores none.
  it("restores the demo encoder wherever a job prepares the window recorder", () => {
    const noDemo = ["ci.yml:build"];
    const recorders: string[] = [];
    for (const file of workflows) {
      for (const [id, job] of Object.entries(load(file).jobs)) {
        if (noDemo.includes(`${file}:${id}`)) continue;
        const steps = job.steps ?? [];
        const recorder = steps.findIndex(
          (step) =>
            /\bplaywright install ffmpeg\b/.test(step.run ?? "") ||
            step.uses?.endsWith("/.github/actions/linux-desktop"),
        );
        if (recorder < 0) continue;
        recorders.push(`${file}:${id}`);
        const encoder = steps.findIndex((step) =>
          step.uses?.endsWith("/.github/actions/demo-encoder"),
        );
        expect(encoder, `${file}:${id} restores the demo encoder`).toBeGreaterThan(recorder);
      }
    }
    // The workflow whose journey groups failed in that run.
    expect(recorders).toContain("source-journeys.yml:source-desktop");
  });

  // Alpha run 42477283672, sent by the same watch, missed that cache in every
  // Linux journey group, and its demo journeys took the 504 or hung until
  // their test timed out: actions/cache saved the encoder only after a job
  // passed every step, and only a run on main writes the key every branch
  // reads, so no job whose demo journey failed ever filled it. So the action
  // fetches a missed build itself and saves it in a step of its own, whatever
  // the job's journeys do after.
  it("saves a fetched demo encoder in its own step, not after the job passes", () => {
    const { runs } = loadYamlFile(".github/actions/demo-encoder/action.yml") as {
      runs: { steps: Step[] };
    };
    const uses = runs.steps.map((step) => step.uses?.split("@")[0]);
    // actions/cache's own save is a step that runs only once the job passed.
    expect(uses).not.toContain("actions/cache");
    const restore = uses.indexOf("actions/cache/restore");
    const fetch = runs.steps.findIndex((step) => /\bdemoEncoder\(\)/.test(step.run ?? ""));
    const save = uses.indexOf("actions/cache/save");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(fetch).toBeGreaterThan(restore);
    expect(save).toBeGreaterThan(fetch);
    expect(runs.steps[save]?.if).toBe(`steps.${runs.steps[fetch]?.id}.outcome == 'success'`);
  });

  // Release run 43797927228 lost seven of its eight Linux package checks at
  // actions/checkout: GitHub answered "Repository not found." to every job's
  // token for about three minutes, past the action's own three tries in about
  // 40 seconds, and a failed main check is never run again. So every checkout
  // in a workflow that main's check or a release reaches may fail, the next
  // step waits until GitHub takes the token again, and the same checkout runs
  // once more (docs/testing.md, "GitHub refusing a job's token";
  // tests/checkout-patience.test.ts runs the wait against a stand-in).
  it("waits out GitHub refusing the job's token at every checkout of main's check and a release", () => {
    const reached = new Set<string>();
    const visit = (file: string) => {
      if (reached.has(file)) return;
      reached.add(file);
      for (const job of Object.values(load(file).jobs))
        if (job.uses?.startsWith(LOCAL)) visit(job.uses.slice(LOCAL.length));
    };
    visit("main.yml");
    visit("release.yml");
    const wait = load("main.yml").jobs.sort?.steps?.find(
      (step) => step.name === "Wait until GitHub takes the job's token",
    )?.run;
    expect(wait).toContain("info/refs?service=git-upload-pack");
    const patient: string[] = [];
    for (const file of reached) {
      for (const [id, job] of Object.entries(load(file).jobs)) {
        const steps = job.steps ?? [];
        for (let at = 0; at < steps.length; at++) {
          const step = steps[at];
          if (!step?.uses?.startsWith("actions/checkout@")) continue;
          const where = `${file}:${id} step ${at + 1}`;
          expect(step.id, `${where} names its checkout`).toMatch(/^[a-z-]+$/);
          expect(step["continue-on-error"], `${where} may fail`).toBe(true);
          const failed = `\${{ !cancelled() && steps.${step.id}.outcome == 'failure' }}`;
          const [waits, again] = [steps[at + 1], steps[at + 2]];
          expect(waits, `${where} waits for the token next`).toMatchObject({
            if: failed,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
            env: { TOKEN: "${{ github.token }}" },
            run: wait,
          });
          // A job's own folder may not exist until its checkout passed.
          if (job.defaults?.run?.["working-directory"])
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
            expect(waits?.["working-directory"], where).toBe("${{ runner.temp }}");
          expect(again, `${where} checks out once more after the wait`).toMatchObject({
            if: failed,
            uses: step.uses,
          });
          expect(again?.with, `${where} checks out the same again`).toEqual(step.with);
          expect(again?.["continue-on-error"], `${where} fails the job the second time`).toBe(
            undefined,
          );
          patient.push(`${file}:${id}`);
          at += 2;
        }
      }
    }
    // The jobs refused in that run, main's check, and the signing job.
    expect(patient).toEqual(
      expect.arrayContaining([
        "linux-packages.yml:check",
        "main.yml:sort",
        "verify.yml:lane",
        "linux-startup.yml:runtime-facts",
        "release.yml:release",
        "release.yml:publish",
      ]),
    );
    // The wait and the second checkout run only once the first failed, also
    // after an earlier step failed, and never in a cancelled run.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
    const failed = "${{ !cancelled() && steps.checkout.outcome == 'failure' }}";
    const runs = (outcome: string, status: { failure: boolean; cancelled: boolean }) =>
      workflowValue(
        failed,
        { steps: { checkout: { outcome } } },
        { success: !status.failure && !status.cancelled, always: true, ...status },
      );
    expect([
      runs("failure", { failure: false, cancelled: false }),
      runs("failure", { failure: true, cancelled: false }),
      runs("success", { failure: false, cancelled: false }),
      runs("skipped", { failure: false, cancelled: false }),
      runs("failure", { failure: false, cancelled: true }),
    ]).toEqual([true, true, false, false, false]);
  });

  // A value a shell step reads comes through its environment, never pasted
  // into the script: an expression in a run line is a quoting hazard and an
  // injection path for a value the run does not own.
  it("passes values to shell steps through the environment, never into the script", () => {
    const scripts: [string, Step][] = [];
    for (const file of workflows) {
      const { jobs } = load(file);
      for (const [id, job] of Object.entries(jobs))
        for (const step of job.steps ?? []) scripts.push([`${file}:${id}`, step]);
    }
    for (const action of actions) {
      const { runs } = loadYamlFile(`.github/actions/${action}/action.yml`) as {
        runs: { steps?: Step[] };
      };
      for (const step of runs.steps ?? []) scripts.push([`actions/${action}`, step]);
    }
    const shell = scripts.filter(([, step]) => typeof step.run === "string");
    expect(shell.length).toBeGreaterThan(100);
    for (const [where, step] of shell)
      expect(step.run, `${where} ${step.id ?? step.name ?? ""}`).not.toContain("${{");
  });
});
