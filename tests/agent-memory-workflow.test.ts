import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEMORY_FILE } from "../scripts/agent-memory.ts";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// INF-5611's approved plan, the captain's words: "warn at 1200 words, but the
// hard error is raised at something higher like 1500". The check that reads
// the warning line runs after a change reaches main, beside what merges and
// releases, never in front of it.

const root = fileURLToPath(new URL("..", import.meta.url));
const FILE = "agent-memory.yml";

type Workflow = {
  on: Record<string, { branches?: string[]; paths?: string[] } | null>;
  jobs: Record<string, { steps?: { run?: string }[] }>;
};

describe("the AGENTS.md warning line check", () => {
  const workflow = loadYamlFile(`.github/workflows/${FILE}`) as Workflow;

  it("runs only on pushes to main and by hand", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
  });

  it("runs the warning line on every change to the file or the check", () => {
    const paths = workflow.on.push?.paths ?? [];
    for (const path of [MEMORY_FILE, "scripts/agent-memory.ts", `.github/workflows/${FILE}`])
      expect(paths).toContain(path);
    const runs = Object.values(workflow.jobs).flatMap((job) =>
      (job.steps ?? []).map((step) => step.run),
    );
    expect(runs).toContain("node scripts/agent-memory.ts --warn");
  });

  it("is read by no other workflow, so a red run holds no merge or release", () => {
    const readers = readdirSync(`${root}.github/workflows`)
      .filter((file) => file.endsWith(".yml") && file !== FILE)
      .filter((file) =>
        /agent-memory|agent-memory\.ts --warn/.test(
          readFileSync(`${root}.github/workflows/${file}`, "utf8"),
        ),
      );
    expect(readers).toEqual([]);
  });
});
