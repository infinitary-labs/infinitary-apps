import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUDGET_TESTS } from "../scripts/prompt-budget.ts";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// INF-2930's plan, which the captain approved ("fail only if we exceed budget
// by a lot (say 50%), and anything lower than that result in a follow up trim
// task not blocking release"): the check that holds the budget itself runs
// beside what merges and releases, never in front of it.

const root = fileURLToPath(new URL("..", import.meta.url));
const FILE = "prompt-budget.yml";

type Workflow = {
  on: Record<string, { branches?: string[]; paths?: string[] } | null>;
  jobs: Record<string, { steps?: { run?: string }[] }>;
};

describe("the prompt-budget check (INF-2930)", () => {
  const workflow = loadYamlFile(`.github/workflows/${FILE}`) as Workflow;

  it("runs only on pushes to main and by hand", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
  });

  it("runs the script on every change to what it measures", () => {
    const paths = workflow.on.push?.paths ?? [];
    for (const path of ["src/**", "resources/runbooks/**", ...BUDGET_TESTS]) {
      expect(paths).toContain(path);
    }
    const runs = Object.values(workflow.jobs).flatMap((job) =>
      (job.steps ?? []).map((step) => step.run),
    );
    expect(runs).toContain("node scripts/prompt-budget.ts");
  });

  it("is read by no other workflow, so a red run holds no merge or release", () => {
    const readers = readdirSync(`${root}.github/workflows`)
      .filter((file) => file.endsWith(".yml") && file !== FILE)
      .filter((file) =>
        /prompt-budget/.test(readFileSync(`${root}.github/workflows/${file}`, "utf8")),
      );
    expect(readers).toEqual([]);
  });
});
