import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { REPOSITORY_GIT_VARIABLES } from "../../src/core/hostEnv";
import { appPathsFor } from "../../src/core/paths";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { reportLine, taskKey } from "./rails";
import { GIT_STATUS_PROMPT_MARKER, gitStatus, MOCK_GIT_REPORT_PREFIX } from "./scenarios/gitStatus";

/**
 * An app started from a `git bisect run` step in a linked working copy
 * (INF-3587). Git hands that step `GIT_DIR`, and an app that passed it on
 * made its default-workspace and personal-workspace commits in that
 * repository, deleting its tracked files from the new commit, and wrote its
 * own identity into the settings every working copy of the project reads.
 *
 * This runs a real `git bisect run` in a scratch project's linked working
 * copy, launches the app with the repository variables its step was given,
 * and asks for a task in no project: the app makes its personal workspace
 * and its default workspace, and the crewmate runs `git status` in its own
 * working copy. Every commit lands in the app's own folders, the crewmate's
 * git answers for its own branch, and the scratch project's commits, files
 * and settings are as they were.
 */

const SPEC_FILES: ReadonlyArray<readonly [string, string]> = [
  ["README.md", "# ledger\n\nA small ledger.\n"],
  ["src/ledger.ts", "export const entries: string[] = [];\n"],
  ["package.json", '{ "name": "ledger", "private": true }\n'],
];

/**
 * The test's own git, which never follows a repository whoever ran the
 * tests chose (a runner inside its own `git bisect run`, as INF-3587's was).
 */
function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const name of REPOSITORY_GIT_VARIABLES) delete env[name];
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, stdio: "pipe" }).trim();
}

/** The repository variables a `git bisect run` step in `linked` is given. */
function bisectStepVariables(linked: string): Record<string, string> {
  const dump = join(scratchDir("infinitary-bisect-step-"), "env");
  git(linked, "bisect", "start", "HEAD", "HEAD~2");
  try {
    git(linked, "bisect", "run", "sh", "-c", 'env > "$0"', dump);
  } finally {
    git(linked, "bisect", "reset");
  }
  const repositoryNames: readonly string[] = REPOSITORY_GIT_VARIABLES;
  const variables: Record<string, string> = {};
  for (const line of readFileSync(dump, "utf8").split("\n")) {
    const at = line.indexOf("=");
    const name = line.slice(0, at);
    if (at > 0 && repositoryNames.includes(name)) variables[name] = line.slice(at + 1);
  }
  return variables;
}

/** What the scratch project holds: every ref, the linked copy's state and the shared settings. */
function projectState(project: string, linked: string) {
  return {
    refs: git(project, "for-each-ref", "--format=%(refname) %(objectname)"),
    linkedHead: git(linked, "rev-parse", "HEAD"),
    linkedTree: git(linked, "ls-tree", "-r", "--name-only", "HEAD"),
    linkedStatus: git(linked, "status", "--porcelain"),
    settings: readFileSync(join(project, ".git", "config"), "utf8"),
  };
}

test("an app started inside a git bisect run step commits only in its own folders", async () => {
  test.setTimeout(120_000);
  const project = scratchDir("infinitary-starter-project-");
  git(project, "init", "--initial-branch=main");
  git(project, "config", "user.name", "Ledger Author");
  git(project, "config", "user.email", "author@localhost");
  for (const [file, text] of SPEC_FILES) {
    mkdirSync(dirname(join(project, file)), { recursive: true });
    writeFileSync(join(project, file), text);
    git(project, "add", file);
    git(project, "commit", "-m", `add ${file}`);
  }
  const linked = join(scratchDir("infinitary-starter-linked-"), "ledger-bisect");
  git(project, "worktree", "add", "-b", "bisect-scratch", linked);

  const step = bisectStepVariables(linked);
  expect(step.GIT_DIR, "git hands a bisect step in a linked working copy its GIT_DIR").toBeTruthy();
  expect(realpathSync(step.GIT_DIR ?? "")).toBe(
    realpathSync(git(linked, "rev-parse", "--absolute-git-dir")),
  );
  const before = projectState(project, linked);

  const app = await launchApp({ scenarios: [gitStatus], withMockProvider: true, env: step });
  const paths = appPathsFor(app.userDataDir);
  try {
    const input = promptInput(app.page);
    await expect(input).toBeEnabled({ timeout: 30_000 });
    // No project's name in the title: the task runs in the default workspace.
    await input.fill(`${SPAWN_PROMPT_MARKER} ${GIT_STATUS_PROMPT_MARKER}`);
    await input.press("Enter");
    const key = await taskKey(app.page, GIT_STATUS_PROMPT_MARKER);
    await expect(
      reportLine(app.page, key).filter({
        hasText: new RegExp(`${MOCK_GIT_REPORT_PREFIX} git version \\S+ on ## fm/`),
      }),
    ).toBeVisible({ timeout: 60_000 });
  } finally {
    await app.close();
  }

  for (const workspace of [paths.personalWorkspaceDir, paths.defaultWorkspaceDir]) {
    expect(git(workspace, "rev-parse", "--absolute-git-dir")).toBe(
      realpathSync(join(workspace, ".git")),
    );
    expect(git(workspace, "log", "--format=%s"), workspace).not.toBe("");
  }
  expect(projectState(project, linked)).toEqual(before);
});
