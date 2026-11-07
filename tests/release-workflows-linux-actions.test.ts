import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadYamlFile, root, workflowString } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// release.yml's linux job calls linux-packages.yml with the release's source
// commit, which for a stable is its alpha's own commit (scripts/resolve-release.sh).
// Alpha 0.6.3-alpha.250's commit predates .github/actions/electron-download
// and .github/actions/linux-packages, which the workflow's jobs used from
// that checkout, so its promotion stopped at a missing action.yml before
// anything published. Each job now takes every local action from the
// workflow's own commit and runs it against the release's source.

type Step = {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = { steps: Step[] };

const { jobs } = loadYamlFile(".github/workflows/linux-packages.yml") as {
  jobs: Record<string, Job>;
};

/** The commit the workflow runs from, and the older commit a stable releases. */
const OWN = "1".repeat(40);
const SOURCE = "2".repeat(40);
const contexts = {
  inputs: { ref: SOURCE, version: "0.6.3", trigger: "Requested stable", hosted: true },
  github: { sha: OWN, ref: "refs/heads/main" },
};

/** The release's source: an Electron version to install, and none of the workflow's actions or scripts. */
const SOURCE_ELECTRON = "1.2.3";
const SOURCE_FILES = {
  "package.json": JSON.stringify({ devDependencies: { electron: SOURCE_ELECTRON } }),
};

/** The repository's files a non-cone sparse checkout leaves: a folder by its trailing slash, else one file. */
function sparse(patterns: string[]): string[] {
  return patterns.flatMap((pattern) => {
    expect(pattern, "a folder or one file, never a glob").toMatch(/^[\w.-]+(\/[\w.-]+)*\/?$/);
    if (!pattern.endsWith("/")) return existsSync(join(root, pattern)) ? [pattern] : [];
    return readdirSync(join(root, pattern), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)));
  });
}

/**
 * Walks a job's steps as the runner does for a stable: each checkout writes
 * its commit's tree where it says, emptying that folder first, and each local
 * action's action.yml must be in the workspace when its step starts. Answers
 * the workspace and the folder each local action ran from.
 */
function runJob(job: Job): { workspace: string; actions: Array<{ step: Step; folder: string }> } {
  const workspace = scratchDir("linux-packages-workspace-");
  const actions: Array<{ step: Step; folder: string }> = [];
  for (const step of job.steps) {
    if (step.uses?.startsWith("actions/checkout@")) {
      expect(step.if, "every checkout runs").toBeUndefined();
      const into = resolve(workspace, String(step.with?.path ?? "."));
      for (const entry of existsSync(into) ? readdirSync(into) : [])
        rmSync(join(into, entry), { recursive: true, force: true });
      mkdirSync(into, { recursive: true });
      const ref = workflowString(String(step.with?.ref ?? ""), contexts);
      if (ref === OWN) {
        expect(step.with?.["sparse-checkout-cone-mode"]).toBe(false);
        const patterns = String(step.with?.["sparse-checkout"] ?? "")
          .trim()
          .split("\n");
        for (const file of sparse(patterns)) {
          mkdirSync(dirname(join(into, file)), { recursive: true });
          cpSync(join(root, file), join(into, file));
        }
      } else {
        expect(ref).toBe(SOURCE);
        for (const [file, text] of Object.entries(SOURCE_FILES))
          writeFileSync(join(into, file), text);
      }
      continue;
    }
    if (!step.uses?.startsWith("./")) continue;
    const folder = resolve(workspace, step.uses);
    expect(existsSync(join(folder, "action.yml")), `${step.uses} when its step starts`).toBe(true);
    actions.push({ step, folder });
  }
  return { workspace, actions };
}

type ActionStep = { uses?: string; run?: string; "working-directory"?: string };
type Action = {
  inputs?: Record<string, { default?: string }>;
  runs: { steps?: ActionStep[] };
};

describe("linux-packages.yml's local actions in a stable built from an older alpha", () => {
  for (const [name, job] of Object.entries(jobs)) {
    it(`finds every local action of its ${name} job in the workflow's own commit`, () => {
      const { workspace, actions } = runJob(job);
      expect(actions.length).toBeGreaterThan(0);
      for (const { folder } of actions)
        expect(relative(workspace, folder)).toMatch(/^\.release-tooling\/\.github\/actions\//);
    });

    it(`runs nothing of the older source's own in the actions of its ${name} job`, () => {
      const { workspace, actions } = runJob(job);
      for (const { step, folder } of actions) {
        // The workspace's copy is the repository's own file at that path.
        const own = relative(join(workspace, ".release-tooling"), folder);
        const action = loadYamlFile(`${own}/action.yml`) as Action;
        for (const inner of action.runs.steps ?? []) {
          // A local action inside an action resolves against the workspace, the source.
          expect(inner.uses?.startsWith("./") ?? false, `${step.uses}: ${inner.uses}`).toBe(false);
          for (const [, beside, script] of (inner.run ?? "").matchAll(
            /(\$GITHUB_ACTION_PATH\/)?((?:\.\.\/)*scripts\/[\w./-]+)/g,
          )) {
            expect(beside, `${step.uses} runs ${script} from beside itself`).toBe(
              "$GITHUB_ACTION_PATH/",
            );
            const file = resolve(folder, script as string);
            expect(relative(workspace, file)).toMatch(/^\.release-tooling\//);
            expect(existsSync(file), `${step.uses}: ${script} is checked out`).toBe(true);
          }
        }
      }
    });
  }

  it("restores the Electron download of the source it installs, not the workflow's", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const { workspace, actions } = runJob(job);
      const electron = actions.find(({ folder }) => folder.endsWith("/electron-download"));
      expect(electron, name).toBeDefined();
      const action = loadYamlFile(".github/actions/electron-download/action.yml") as Action;
      // A composite action's shell step runs in the workspace, joined with its
      // working-directory; the job passes none, so the input's default.
      const given = electron?.step.with?.["working-directory"];
      const directory = String(given ?? action.inputs?.["working-directory"]?.default);
      const pkg = JSON.parse(readFileSync(join(workspace, directory, "package.json"), "utf8")) as {
        devDependencies: { electron: string };
      };
      expect([name, pkg.devDependencies.electron]).toEqual([name, SOURCE_ELECTRON]);
    }
  });
});
