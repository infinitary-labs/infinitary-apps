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
import { expect } from "vitest";
import { firstTry, loadYamlFile, root, workflowString } from "./releaseWorkflows";
import { scratchDir } from "./scratchDirs";

// A release workflow's job checks out the release's source commit, which for
// a stable is its alpha's own, older commit (scripts/resolve-release.sh), and
// takes every local action from the workflow's own commit instead
// (tests/release-workflows-linux-actions.test.ts,
// tests/release-workflows-windows-actions.test.ts).

export type Step = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
export type Job = { steps: Step[] };

/** The commit the workflow runs from, and the older commit a stable releases. */
export const OWN = "1".repeat(40);
export const SOURCE = "2".repeat(40);
export const contexts = {
  inputs: { ref: SOURCE, version: "0.6.3", trigger: "Requested stable", hosted: true },
  github: { sha: OWN, ref: "refs/heads/main" },
};

/** The release's source: the Electron and pnpm it pins, and none of the workflow's actions or scripts. */
export const SOURCE_ELECTRON = "1.2.3";
export const SOURCE_PNPM = "pnpm@4.5.6";
const SOURCE_FILES = {
  "package.json": JSON.stringify({
    packageManager: SOURCE_PNPM,
    devDependencies: { electron: SOURCE_ELECTRON },
  }),
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
 * the workspace and the folder each local action ran from. Each checkout
 * passes the first time: a refused one's second try writes the same tree
 * (tests/workflow-hygiene.test.ts).
 */
export function runJob(job: Job): {
  workspace: string;
  actions: Array<{ step: Step; folder: string }>;
} {
  const workspace = scratchDir("release-workspace-");
  const actions: Array<{ step: Step; folder: string }> = [];
  for (const step of firstTry(job.steps)) {
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

/** Checks that no action a job ran reaches the older source's own actions or scripts. */
export function expectNothingOfTheSource(
  workspace: string,
  actions: Array<{ step: Step; folder: string }>,
): void {
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
}

/** The package.json a local action's shell step reads: the job's working-directory, or its default. */
export function packageJsonRead(
  workspace: string,
  actions: Array<{ step: Step; folder: string }>,
  name: string,
): { packageManager?: string; devDependencies: { electron: string } } {
  const used = actions.find(({ folder }) => folder.endsWith(`/${name}`));
  expect(used, name).toBeDefined();
  const action = loadYamlFile(`.github/actions/${name}/action.yml`) as Action;
  // A composite action's shell step runs in the workspace, joined with its
  // working-directory; the job passes none, so the input's default.
  const given = used?.step.with?.["working-directory"];
  const directory = String(given ?? action.inputs?.["working-directory"]?.default);
  return JSON.parse(readFileSync(join(workspace, directory, "package.json"), "utf8"));
}
