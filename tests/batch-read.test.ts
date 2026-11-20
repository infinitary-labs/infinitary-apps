import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadYamlFile, workflowString } from "./helpers/releaseWorkflows.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * INF-4683: a held merge batch's one failure was its Read the batch job,
 * which asked GitHub's compare answer for the merge base; that answer builds
 * the batch's whole diff first and refused it under heavy load, so every
 * other batch job skipped. The job now reads the batch's tree and the main
 * version it left with git, from the commits alone. This runs its step as
 * GitHub Actions does, against a project served from a folder, with no
 * GitHub answer to ask.
 */

type Step = { run: string; env: Record<string, string> };
const readStep = () => {
  const { steps } = (
    loadYamlFile(".github/workflows/batch-checks.yml") as { jobs: { batch: { steps: Step[] } } }
  ).jobs.batch;
  expect(steps).toHaveLength(1);
  return steps[0] as Step;
};

it("reads the batch's tree and the main version it left with git alone, after main moved on", () => {
  const dir = scratchDir("infinitary-batch-read-");
  const gitEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=batch", "-c", "user.email=batch@localhost", ...args], {
      cwd,
      env: gitEnv,
      encoding: "utf8",
    }).trim();

  // Where the project lives: main, a batch branch built on main with one
  // commit for each approved change, and main moving on while the batch is
  // checked. A served folder allows the partial fetch GitHub allows.
  const repository = "infinitary-labs/infinitary";
  const project = join(dir, "served", repository);
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  git(project, "config", "uploadpack.allowFilter", "true");
  const commit = (subject: string, file: string) => {
    writeFileSync(join(project, file), `${subject}\n`);
    git(project, "add", "-A");
    git(project, "commit", "-q", "-m", subject);
    return git(project, "rev-parse", "HEAD");
  };
  commit("feat(cards): draw the card", "card.ts");
  const left = commit("fix(crew): keep the crewmate's turn", "crew.ts");
  git(project, "checkout", "-q", "-b", "infinitary-batch/one");
  commit("feat(browser): open the task browser", "browser.ts");
  const head = commit("fix(keyboard): hold the key reminder", "keyboard.ts");
  git(project, "checkout", "-q", "main");
  const moved = commit("chore(ci): main moves on", "ci.yml");

  const step = readStep();
  const contexts = {
    inputs: { trigger: "Merge batch", head },
    github: {
      event: { repository: { default_branch: "main" } },
      server_url: `file://${join(dir, "served")}`,
      repository,
      token: "a-token",
    },
  };
  const env = Object.fromEntries(
    Object.entries(step.env).map(([name, value]) => [name, workflowString(value, contexts)]),
  );
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const output = join(dir, "output");
  writeFileSync(output, "");
  // The shell GitHub Actions gives a run step that names none.
  const ran = spawnSync("bash", ["-e", "-c", step.run], {
    cwd: workspace,
    env: { ...gitEnv, ...env, GITHUB_OUTPUT: output },
    encoding: "utf8",
  });
  expect(ran.status, ran.stderr).toBe(0);
  // The main version the batch left, never main's newer tip.
  expect(git(project, "rev-parse", "main")).toBe(moved);
  expect(readFileSync(output, "utf8")).toBe(
    `tree=${git(project, "rev-parse", `${head}^{tree}`)}\nbase=${left}\n`,
  );
});
