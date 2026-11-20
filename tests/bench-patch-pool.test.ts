import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bridgeContainerName } from "../scripts/bench/bridge.ts";
import { refPatch, worktreePatch } from "../scripts/bench/patch.ts";
import { readTasks } from "../scripts/bench/pool.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The benchmark tooling's two halves that touch real programs
 * (scripts/bench): the patch a crewmate's worktree holds against the task's
 * base commit, replayed with `git apply` on a copy of the base the way the
 * task image's `/app` and the verifier replay it; and the task index read
 * from DeepSWE's `task.toml` files through Python's tomllib.
 */

function sh(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bench",
      GIT_AUTHOR_EMAIL: "bench@example.com",
      GIT_COMMITTER_NAME: "bench",
      GIT_COMMITTER_EMAIL: "bench@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

const git = (cwd: string, ...args: string[]) => sh(cwd, "git", args);

/** A repository at a base commit, and a clone of it standing in for the image's `/app`. */
function baseAndApp(root: string): { repo: string; app: string; base: string } {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "keep.txt"), "keep\n");
  writeFileSync(join(repo, "edit.txt"), "one\n");
  writeFileSync(join(repo, "gone.txt"), "gone\n");
  writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 3]));
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD").trim();
  const app = join(root, "app");
  git(root, "clone", "--quiet", repo, app);
  return { repo, app, base };
}

function applyTo(app: string, base: string, patch: Buffer): void {
  git(app, "reset", "--quiet", "--hard", base);
  git(app, "clean", "--force", "-d", "--quiet");
  if (patch.length === 0) return;
  const file = join(app, "..", "model.patch");
  writeFileSync(file, patch);
  git(app, "apply", "--whitespace=nowarn", file);
  rmSync(file);
}

/** Every tracked-or-untracked, non-ignored file and its contents. */
function tree(dir: string): Record<string, string> {
  const files = git(dir, "ls-files", "--cached", "--others", "--exclude-standard")
    .split("\n")
    .filter(Boolean);
  const present = files.filter((file) => {
    try {
      readFileSync(join(dir, file));
      return true;
    } catch {
      return false;
    }
  });
  return Object.fromEntries(
    present.sort().map((file) => [file, readFileSync(join(dir, file)).toString("hex")]),
  );
}

describe("the worktree patch", () => {
  it("carries commits, staged, unstaged, deleted, binary and untracked files, and nothing ignored", () => {
    const { repo, app, base } = baseAndApp(scratchDir("infinitary-bench-patch-"));
    writeFileSync(join(repo, "edit.txt"), "one\ntwo\n");
    git(repo, "commit", "--quiet", "-am", "committed edit");
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, "add", "staged.txt");
    writeFileSync(join(repo, "keep.txt"), "keep, edited but not staged\n");
    rmSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "logo.bin"), Buffer.from([9, 8, 7, 6, 0]));
    mkdirSync(join(repo, "src", "new"), { recursive: true });
    writeFileSync(join(repo, "src", "new", "untracked.ts"), "export {};\n");
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "dep.js"), "ignored\n");
    const indexBefore = readFileSync(join(repo, ".git", "index"));

    const patch = worktreePatch(repo, base);
    applyTo(app, base, patch);

    const expected = tree(repo);
    delete expected["node_modules/dep.js"];
    expect(tree(app)).toEqual(expected);
    expect(tree(app)).not.toHaveProperty("gone.txt");
    expect(patch.toString()).not.toContain("node_modules");
    // The worktree's own index is never touched: staged stays staged, untracked stays untracked.
    expect(readFileSync(join(repo, ".git", "index"))).toEqual(indexBefore);
    expect(git(repo, "status", "--porcelain")).toContain("?? src/");
  });

  it("is empty for a pristine worktree, so the verifier grades the base", () => {
    const { repo, base } = baseAndApp(scratchDir("infinitary-bench-patch-"));
    expect(worktreePatch(repo, base).length).toBe(0);
  });

  it("works from a linked worktree, whose index lives outside it", () => {
    const root = scratchDir("infinitary-bench-patch-");
    const { repo, app, base } = baseAndApp(root);
    const linked = join(root, "linked");
    git(repo, "worktree", "add", "--quiet", "-b", "crew", linked);
    writeFileSync(join(linked, "edit.txt"), "from the linked worktree\n");
    applyTo(app, base, worktreePatch(linked, base));
    expect(readFileSync(join(app, "edit.txt"), "utf8")).toBe("from the linked worktree\n");
  });

  it("from a committed ref matches what the ref holds", () => {
    const { repo, app, base } = baseAndApp(scratchDir("infinitary-bench-patch-"));
    git(repo, "checkout", "--quiet", "-b", "kept");
    writeFileSync(join(repo, "edit.txt"), "kept\n");
    git(repo, "commit", "--quiet", "-am", "kept work");
    git(repo, "checkout", "--quiet", "main");
    applyTo(app, base, refPatch(repo, base, "kept"));
    expect(readFileSync(join(app, "edit.txt"), "utf8")).toBe("kept\n");
  });
});

const TOML = (id: string, extra = "") => `
[metadata]
task_id = "${id}"
base_commit_hash = "abc123"
repository_url = "https://github.com/example/${id}"
language = "python"
category = "feature_request"
${extra}
[environment]
docker_image = "registry.example/${id}:v1"

[verifier]
timeout_sec = 1800.0

[verifier.environment]
cpus = 2
memory_mb = 8192
`;

describe("the task index", () => {
  it("reads every task.toml into typed tasks, sorted by id, skipping folders without one", () => {
    const tasks = scratchDir("infinitary-bench-pool-");
    for (const id of ["zeta-task", "alpha-task"]) {
      mkdirSync(join(tasks, id));
      writeFileSync(join(tasks, id, "task.toml"), TOML(id));
    }
    mkdirSync(join(tasks, "not-a-task"));
    writeFileSync(join(tasks, "manifest.json"), "{}");
    const read = readTasks(tasks);
    expect(read.map((task) => task.id)).toEqual(["alpha-task", "zeta-task"]);
    expect(read[0]).toEqual({
      id: "alpha-task",
      dir: join(tasks, "alpha-task"),
      image: "registry.example/alpha-task:v1",
      baseCommit: "abc123",
      repositoryUrl: "https://github.com/example/alpha-task",
      language: "python",
      category: "feature_request",
      verifier: { timeoutSec: 1800, cpus: 2, memoryMb: 8192 },
    });
  });

  it("refuses a task.toml that names another task or lacks a field", () => {
    const misnamed = scratchDir("infinitary-bench-pool-");
    mkdirSync(join(misnamed, "folder"));
    writeFileSync(join(misnamed, "folder", "task.toml"), TOML("other"));
    expect(() => readTasks(misnamed)).toThrow("folder/task.toml names task other");

    const partial = scratchDir("infinitary-bench-pool-");
    mkdirSync(join(partial, "t"));
    writeFileSync(join(partial, "t", "task.toml"), TOML("t").replace(/docker_image = .*\n/, ""));
    expect(() => readTasks(partial)).toThrow("t/task.toml has no environment.docker_image");
  });
});

describe("the bridge's container name", () => {
  it("is one per task and worktree, whatever path spells the worktree", () => {
    const root = scratchDir("infinitary-bench-bridge-");
    mkdirSync(join(root, "wt"));
    symlinkSync(join(root, "wt"), join(root, "alias"));
    const task = { id: "t" } as Parameters<typeof bridgeContainerName>[0];
    const other = { id: "u" } as Parameters<typeof bridgeContainerName>[0];
    const name = bridgeContainerName(task, join(root, "wt"));
    expect(name).toMatch(/^fmb-b-[0-9a-f]{12}$/);
    expect(bridgeContainerName(task, join(root, "alias"))).toBe(name);
    expect(bridgeContainerName(other, join(root, "wt"))).not.toBe(name);
  });
});
