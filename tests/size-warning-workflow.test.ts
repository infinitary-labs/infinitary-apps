import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CODE_EXTENSIONS } from "../scripts/file-sizes.ts";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// INF-4496's fix 3, the captain's words: "Give the size check a warning line,
// as the prompt budget has. Main's check warns, never blocks, when a code file
// passes it". The check that reads the warning line runs after a change
// reaches main, beside what merges and releases, never in front of it.

const root = fileURLToPath(new URL("..", import.meta.url));
const FILE = "size-warning.yml";

type Workflow = {
  on: Record<string, { branches?: string[]; paths?: string[] } | null>;
  jobs: Record<string, { steps?: { run?: string }[] }>;
};

describe("the size warning check (INF-4496)", () => {
  const workflow = loadYamlFile(`.github/workflows/${FILE}`) as Workflow;

  it("runs only on pushes to main and by hand", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
  });

  it("runs the warning line on every change to a code file", () => {
    const paths = workflow.on.push?.paths ?? [];
    for (const extension of CODE_EXTENSIONS) expect(paths).toContain(`**${extension}`);
    const runs = Object.values(workflow.jobs).flatMap((job) =>
      (job.steps ?? []).map((step) => step.run),
    );
    expect(runs).toContain("node scripts/file-sizes.ts --warn");
  });

  it("is read by no other workflow, so a red run holds no merge or release", () => {
    const readers = readdirSync(`${root}.github/workflows`)
      .filter((file) => file.endsWith(".yml") && file !== FILE)
      .filter((file) =>
        /size-warning|file-sizes\.ts --warn/.test(
          readFileSync(`${root}.github/workflows/${file}`, "utf8"),
        ),
      );
    expect(readers).toEqual([]);
  });
});
