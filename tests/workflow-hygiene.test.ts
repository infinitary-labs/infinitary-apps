import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// INF-2539 (the captain: audit the workflows for "messy archiecture,
// inefficiencies, inconsistencies, or code smell in general" and fix them):
// rules every workflow keeps, read from the files themselves.

const root = fileURLToPath(new URL("..", import.meta.url));
const workflows = readdirSync(join(root, ".github/workflows")).filter((file) =>
  file.endsWith(".yml"),
);
const actions = readdirSync(join(root, ".github/actions"));

type Step = { name?: string; id?: string; run?: string };
type Permissions = string | Record<string, string>;
type Job = { steps?: Step[]; uses?: string; permissions?: Permissions };
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
