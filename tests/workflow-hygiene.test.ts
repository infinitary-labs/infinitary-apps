import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// INF-2539 (the captain: audit the workflows for "messy archiecture,
// inefficiencies, inconsistencies, or code smell in general" and fix them):
// two rules every workflow keeps, read from the files themselves.

const root = fileURLToPath(new URL("..", import.meta.url));
const workflows = readdirSync(join(root, ".github/workflows")).filter((file) =>
  file.endsWith(".yml"),
);
const actions = readdirSync(join(root, ".github/actions"));

type Step = { name?: string; id?: string; run?: string };
type Workflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, { steps?: Step[] }>;
};

describe("every workflow", () => {
  // A workflow says what its token may do at the top, so a job that writes
  // (a status, a cancellation) names it and the rest hold a read-only token.
  it("declares its token's permissions at the top", () => {
    for (const file of workflows) {
      const { permissions } = loadYamlFile(`.github/workflows/${file}`) as Workflow;
      expect(permissions, file).toMatchObject({ contents: expect.any(String) });
    }
  });

  // A value a shell step reads comes through its environment, never pasted
  // into the script: an expression in a run line is a quoting hazard and an
  // injection path for a value the run does not own.
  it("passes values to shell steps through the environment, never into the script", () => {
    const scripts: [string, Step][] = [];
    for (const file of workflows) {
      const { jobs } = loadYamlFile(`.github/workflows/${file}`) as Workflow;
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
