import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type AppPaths, appPathsFor } from "../paths";
import { git } from "./git";
import {
  keptRefFor,
  type TaskWorkspace,
  WorkspaceService,
  type WorkspaceServiceOptions,
} from "./workspaceService";
import { isPristineSlot } from "./worktreePool";

// Integration budget (docs/test-cohorts.md): real git, the slowest test
// 2.177 s at its fastest of three eight-worker Mac runs (pass 4).
vi.setConfig({ testTimeout: 15_000 });

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The warm worktree pool (captain's board answer 2026-09-23: "Hybrid -
 * Infinitary code, treehouse design / fetch the default branch at dispatch /
 * after the always-clean work"), exercised end to end through the public
 * WorkspaceService surface the supervisor uses - dispatch
 * (`createTaskWorktree`), close (`retireTaskWorktree`, #270's save first),
 * boot (`sweepPool`) - over real git repositories.
 */

const ROOT_PACKAGE_MANAGER = (
  JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "package.json"), "utf8")) as {
    packageManager: string;
  }
).packageManager;

function tmp(prefix: string): string {
  return scratchDir(prefix);
}

function service(options: WorkspaceServiceOptions = {}): {
  paths: AppPaths;
  workspace: WorkspaceService;
} {
  const paths = appPathsFor(tmp("infinitary-pool-"));
  return { paths, workspace: new WorkspaceService(paths, options) };
}

/**
 * The fixture repositories are built by git once per file and every test
 * gets its own copy of the files. Each test drives dozens of real git
 * processes through the service, one after another, and that is the thing
 * under test; building its fixture the same way again for every test was a
 * second chain of processes in front of it that tested nothing.
 */
function once<T>(build: () => Promise<T>): () => Promise<T> {
  let built: Promise<T> | undefined;
  return () => {
    built ??= build();
    return built;
  };
}

const projectTemplate = once(async () => {
  const dir = tmp("infinitary-pool-template-");
  await git(dir, ["init", "--quiet", "--initial-branch=main"]);
  await git(dir, ["config", "user.name", "Pool Test"]);
  await git(dir, ["config", "user.email", "pool@test"]);
  // The template is copied file by file, so no git may still be writing in it
  // when `commit` returns: git 2.55's auto maintenance runs detached, holding
  // `.git/objects/maintenance.lock` past the commit, and a copy that listed
  // the lock failed with ENOENT once it was gone.
  await git(dir, ["config", "maintenance.auto", "false"]);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\nout/\n.env\n");
  writeFileSync(join(dir, "README.md"), "# project\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--quiet", "-m", "init"]);
  return dir;
});

/** A repository with an ignore file like a real project's, one commit on main. */
async function project(): Promise<string> {
  const dir = tmp("infinitary-pool-repo-");
  cpSync(await projectTemplate(), dir, { recursive: true });
  return dir;
}

async function commitFile(dir: string, file: string, text: string): Promise<string> {
  writeFileSync(join(dir, file), text);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "--quiet", "-m", `change ${file}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** What a crewmate leaves behind: every kind of dirt, plus a dependency tree. */
function dirty(cwd: string): void {
  writeFileSync(join(cwd, "README.md"), "# edited by the task\n");
  writeFileSync(join(cwd, "notes.txt"), "untracked\n");
  mkdirSync(join(cwd, "out"), { recursive: true });
  writeFileSync(join(cwd, "out", "bundle.js"), "built\n");
  writeFileSync(join(cwd, ".env"), "SECRET=1\n");
  mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(cwd, "node_modules", "dep", "index.js"), "module.exports = 42;\n");
}

/** A dispatch then a close the way the supervisor runs them, with the return settled. */
async function closeTask(workspace: WorkspaceService, ws: TaskWorkspace) {
  const retired = await workspace.retireTaskWorktree(ws);
  await workspace.poolSettled();
  return retired;
}

describe("warm worktree pool: a closed task's tree is reused, never dirty", () => {
  it("hands the next task the returned tree, clean on its own branch, dependencies intact, the last task's work saved", async () => {
    const repo = await project();
    const { paths, workspace } = service();
    const first = await workspace.createTaskWorktree("aaaa1111", repo);
    expect(first.acquired?.source).toBe("new");
    dirty(first.cwd);

    const retired = await closeTask(workspace, first);
    expect(retired.outcome).toBe("removed");
    expect(existsSync(first.cwd)).toBe(false);
    expect(await git(repo, ["branch", "--list", first.branch])).toBe("");
    expect(workspace.pooledTrees()).toHaveLength(1);

    const second = await workspace.createTaskWorktree("bbbb2222", repo);
    expect(second.acquired?.source).toBe("pool");
    expect(second.cwd).toBe(join(paths.worktreesDir, "bbbb2222"));
    expect(workspace.pooledTrees()).toHaveLength(0);
    expect(await git(second.cwd, ["symbolic-ref", "--short", "HEAD"])).toBe("fm/task-bbbb2222");
    expect(await git(second.cwd, ["rev-parse", "HEAD"])).toBe(
      await git(repo, ["rev-parse", "HEAD"]),
    );
    // Nothing of the last task survives but the dependency tree.
    expect(await git(second.cwd, ["status", "--porcelain", "--ignored"])).toBe("!! node_modules/");
    expect(existsSync(join(second.cwd, "node_modules", "dep", "index.js"))).toBe(true);
    // ...and everything it did is on its kept ref (#270), not lost.
    const kept = keptRefFor("aaaa1111");
    expect(await git(repo, ["show", `${kept}:README.md`])).toBe("# edited by the task");
    expect(await git(repo, ["show", `${kept}:notes.txt`])).toBe("untracked");
    // git knows the tree at its new path, and the old one is gone.
    const listed = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(listed).toContain("bbbb2222");
    expect(listed).not.toContain("aaaa1111");
  });

  it("gives each repository its own trees: another project's warm tree is never handed out", async () => {
    const one = await project();
    const two = await project();
    const { workspace } = service();
    await closeTask(workspace, await workspace.createTaskWorktree("cccc1111", one));
    const other = await workspace.createTaskWorktree("cccc2222", two);
    expect(other.acquired?.source).toBe("new");
    expect(workspace.pooledTrees()).toHaveLength(1);
  });

  it("fails closed: a parked tree that is no longer pristine is retired and a new one is made", async () => {
    const repo = await project();
    const { paths, workspace } = service();
    await closeTask(workspace, await workspace.createTaskWorktree("dddd1111", repo));
    const [slot] = workspace.pooledTrees();
    // Something wrote into the idle tree after it was proven clean.
    writeFileSync(join(slot as string, "stray.txt"), "who wrote this\n");

    const next = await workspace.createTaskWorktree("dddd2222", repo);
    expect(next.acquired?.source).toBe("new");
    expect(existsSync(join(next.cwd, "stray.txt"))).toBe(false);
    expect(existsSync(slot as string)).toBe(false);
    await workspace.deletionsSettled();
    expect(readdirSync(paths.worktreeTrashDir)).toEqual([]);
    expect(await git(repo, ["worktree", "list"])).not.toContain(slot as string);
  });

  it("keeps the newest trees within the budget and retires the rest", async () => {
    const repo = await project();
    const { workspace } = service({ pool: { idlePerRepo: 1 } });
    const a = await workspace.createTaskWorktree("eeee1111", repo);
    const b = await workspace.createTaskWorktree("eeee2222", repo);
    await closeTask(workspace, a);
    await closeTask(workspace, b);
    expect(workspace.pooledTrees()).toHaveLength(1);
    await workspace.deletionsSettled();
    // git forgot the retired one: only the main checkout and the kept tree.
    const trees = (await git(repo, ["worktree", "list"])).split("\n");
    expect(trees).toHaveLength(2);
  });

  it("retires a tree idle past the age limit instead of handing it out", async () => {
    const repo = await project();
    const { workspace } = service({ pool: { maxIdleAgeMs: 1 } });
    await closeTask(workspace, await workspace.createTaskWorktree("ffff1111", repo));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const next = await workspace.createTaskWorktree("ffff2222", repo);
    expect(next.acquired?.source).toBe("new");
    expect(workspace.pooledTrees()).toHaveLength(0);
  });

  it("boot finishes a return a quit interrupted: the half-returned tree is reset and parked", async () => {
    const repo = await project();
    const { paths, workspace } = service();
    await closeTask(workspace, await workspace.createTaskWorktree("abab1111", repo));
    const [slot] = workspace.pooledTrees() as [string];
    // The state a quit leaves between the park's move and the reset: a
    // staging tree still holding the last task's files.
    const staging = join(dirname(slot), "returning-0badc0de");
    await git(repo, ["worktree", "move", slot, staging]);
    dirty(staging);

    const rebooted = new WorkspaceService(paths);
    rebooted.sweepPool();
    await rebooted.poolSettled();
    const [parked] = rebooted.pooledTrees();
    expect(parked).toBeDefined();
    expect(existsSync(staging)).toBe(false);
    expect(await git(parked as string, ["status", "--porcelain", "--ignored"])).toBe(
      "!! node_modules/",
    );
  });

  it("boot retires anything in the pool that is not a tree of its own", async () => {
    const { paths, workspace } = service();
    const junk = join(paths.worktreePoolDir, "0123456789abcdef", "not-a-slot");
    mkdirSync(junk, { recursive: true });
    workspace.sweepPool();
    await workspace.poolSettled();
    await workspace.deletionsSettled();
    expect(existsSync(junk)).toBe(false);
  });
});

describe("a slot is handed out only when it is pristine", () => {
  const commonOf = async (dir: string) =>
    realpathSync(await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));

  it("is the detached root of its own checkout of the repository, holding only dependency trees", async () => {
    const repo = await project();
    const common = await commonOf(repo);
    await git(repo, ["checkout", "--quiet", "--detach"]);
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    expect(await isPristineSlot(repo, common)).toBe(true);

    // A task branch riding along is not pristine.
    await git(repo, ["checkout", "--quiet", "main"]);
    expect(await isPristineSlot(repo, common)).toBe(false);
    await git(repo, ["checkout", "--quiet", "--detach"]);

    // Nor is any other leftover, ignored or not.
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    expect(await isPristineSlot(repo, common)).toBe(false);
  });

  it("refuses a directory inside a checkout, and a checkout of another repository", async () => {
    const repo = await project();
    await git(repo, ["checkout", "--quiet", "--detach"]);
    const inside = join(repo, "sub");
    mkdirSync(inside);
    expect(await isPristineSlot(inside, await commonOf(repo))).toBe(false);

    const other = await project();
    await git(other, ["checkout", "--quiet", "--detach"]);
    expect(await isPristineSlot(other, await commonOf(repo))).toBe(false);
    expect(await isPristineSlot(other, await commonOf(other))).toBe(true);
  });
});

describe("dispatch base: fetch the default branch at dispatch (captain's board answer)", () => {
  /** The three repositories under one root, so a copy of the root is a copy of all three. */
  const originTemplate = once(async () => {
    const root = tmp("infinitary-pool-origin-template-");
    const seed = join(root, "seed");
    cpSync(await projectTemplate(), seed, { recursive: true });
    const origin = join(root, "origin.git");
    mkdirSync(origin);
    await git(origin, ["init", "--quiet", "--bare", "--initial-branch=main"]);
    await git(seed, ["remote", "add", "origin", origin]);
    await git(seed, ["push", "--quiet", "origin", "main"]);
    const clone = join(root, "clone");
    await git(root, ["clone", "--quiet", origin, clone]);
    await git(clone, ["config", "user.name", "Pool Test"]);
    await git(clone, ["config", "user.email", "pool@test"]);
    return root;
  });

  /** A bare origin with main, a registered clone of it, and a second clone that pushes. */
  async function withOrigin() {
    const template = await originTemplate();
    const root = tmp("infinitary-pool-origin-");
    cpSync(template, root, { recursive: true });
    const seed = join(root, "seed");
    const origin = join(root, "origin.git");
    const clone = join(root, "clone");
    // The copies' remotes still name the template's origin; point them home.
    for (const repo of [seed, clone]) {
      const config = join(repo, ".git", "config");
      writeFileSync(config, readFileSync(config, "utf8").replaceAll(template, root));
    }
    return { seed, origin, clone };
  }

  it("starts a task from origin's newest main, fetched at dispatch, on a warm tree", async () => {
    const { seed, clone } = await withOrigin();
    const { workspace } = service();
    await closeTask(workspace, await workspace.createTaskWorktree("baba1111", clone));
    // Someone else lands work on origin after this machine last fetched.
    const landed = await commitFile(seed, "landed.txt", "from elsewhere\n");
    await git(seed, ["push", "--quiet", "origin", "main"]);

    const next = await workspace.createTaskWorktree("baba2222", clone);
    expect(next.acquired?.source).toBe("pool");
    expect(next.acquired?.base).toEqual({ sha: landed, ref: "origin/main", fetch: "fetched" });
    expect(await git(next.cwd, ["rev-parse", "HEAD"])).toBe(landed);
    expect(existsSync(join(next.cwd, "landed.txt"))).toBe(true);
    expect(await git(next.cwd, ["status", "--porcelain"])).toBe("");
  });

  it("starts from the local main when it is strictly ahead of origin's", async () => {
    const { clone } = await withOrigin();
    const ahead = await commitFile(clone, "local.txt", "not pushed yet\n");
    const { workspace } = service();
    const ws = await workspace.createTaskWorktree("cdcd1111", clone);
    expect(ws.acquired?.base).toMatchObject({ sha: ahead, ref: "main", fetch: "fetched" });
  });

  it("still dispatches when the fetch fails, from what this machine last saw, and says so", async () => {
    const { clone } = await withOrigin();
    const lastSeen = await git(clone, ["rev-parse", "origin/main"]);
    await git(clone, [
      "remote",
      "set-url",
      "origin",
      join(tmp("infinitary-pool-gone-"), "missing.git"),
    ]);
    const { workspace } = service();
    const ws = await workspace.createTaskWorktree("dede1111", clone);
    expect(ws.acquired?.base).toMatchObject({ sha: lastSeen, ref: "origin/main", fetch: "failed" });
    expect(ws.acquired?.base.fetchError).toBeTruthy();
    expect(await git(ws.cwd, ["rev-parse", "HEAD"])).toBe(lastSeen);
  });

  it("uses the repository's own commit when it has no origin, as before", async () => {
    const repo = await project();
    const { workspace } = service();
    const ws = await workspace.createTaskWorktree("efef1111", repo);
    expect(ws.acquired?.base).toEqual({
      sha: await git(repo, ["rev-parse", "HEAD"]),
      ref: "HEAD",
      fetch: "none",
    });
  });
});

/**
 * Cold dispatch (new tree + install) against warm acquire (pooled tree +
 * incremental install), with the real pnpm and a project whose dependency
 * resolves locally, so no network is involved. The numbers are printed,
 * never asserted: CI hosts vary too much for a timing gate. Point
 * INFINITARY_POOL_MEASURE_REPO at a real checkout (this repository, say) to
 * measure what a real project saves; the scout's numbers for firstmate-3000
 * were 4.7 s cold vs 0.7 s warm.
 */
// Real pnpm installs: 4.992 s at its fastest of three eight-worker Mac runs.
describe("cold dispatch vs warm acquire, with the real pnpm", { timeout: 25_000 }, () => {
  function hasPnpm(): boolean {
    try {
      execFileSync("pnpm", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  async function localDependencyProject(): Promise<string> {
    const repo = await project();
    const dep = join(repo, "vendor", "greeting");
    mkdirSync(dep, { recursive: true });
    writeFileSync(
      join(dep, "package.json"),
      JSON.stringify({ name: "greeting", version: "1.0.0", main: "index.js" }),
    );
    writeFileSync(join(dep, "index.js"), "module.exports = () => 'ahoy';\n");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "pool-fixture",
        private: true,
        // The pnpm this checkout pins, so Corepack never downloads another.
        packageManager: ROOT_PACKAGE_MANAGER,
        dependencies: { greeting: "file:./vendor/greeting" },
      }),
    );
    execFileSync("pnpm", ["install", "--lockfile-only", "--silent"], {
      cwd: repo,
      env: { ...process.env, CI: "true" },
    });
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "--quiet", "-m", "add a dependency"]);
    return repo;
  }

  async function dispatch(workspace: WorkspaceService, taskId: string, repo: string) {
    const started = performance.now();
    const ws = await workspace.createTaskWorktree(taskId, repo);
    const install = await workspace.installDependencies(ws.cwd);
    return { ws, install, ms: performance.now() - started };
  }

  it.skipIf(!hasPnpm())(
    "a warm acquire leaves dependencies usable on a clean tree at the fresh default-branch head",
    async () => {
      const measured = process.env.INFINITARY_POOL_MEASURE_REPO;
      const repo = measured ?? (await localDependencyProject());
      const { workspace } = service();
      const rounds = measured ? Number(process.env.INFINITARY_POOL_MEASURE_ROUNDS ?? 3) : 1;
      const cold: number[] = [];
      const warm: number[] = [];
      // Unique per run: a measured repository outlives the test.
      const run = Date.now().toString(36);
      let seq = 0;
      const id = () => `meas-${run}-${seq++}`;

      for (let round = 0; round < rounds; round++) {
        const coldService = new WorkspaceService(appPathsFor(tmp("infinitary-cold-")), {
          pool: false,
        });
        const fresh = await dispatch(coldService, id(), repo);
        expect(fresh.ws.acquired?.source).toBe("new");
        expect(fresh.install.outcome).not.toBe("failed");
        cold.push(fresh.ms);
        await coldService.removeTaskWorktree(fresh.ws);
        await coldService.deletionsSettled();
      }

      const first = await dispatch(workspace, id(), repo);
      expect(first.install.outcome).not.toBe("failed");
      await closeTask(workspace, first.ws);
      for (let round = 0; round < rounds; round++) {
        const next = await dispatch(workspace, id(), repo);
        expect(next.ws.acquired?.source).toBe("pool");
        expect(next.install.outcome).not.toBe("failed");
        warm.push(next.ms);
        // The tree is the default branch's head, clean but for dependencies.
        expect(await git(next.ws.cwd, ["rev-parse", "HEAD"])).toBe(next.ws.acquired?.base.sha);
        const status = await git(next.ws.cwd, ["status", "--porcelain"]);
        expect(status).toBe("");
        if (!measured) {
          const greeting = execFileSync(
            "node",
            ["-e", "process.stdout.write(require('greeting')())"],
            {
              cwd: next.ws.cwd,
              encoding: "utf8",
            },
          );
          expect(greeting).toBe("ahoy");
        }
        await closeTask(workspace, next.ws);
      }
      const median = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
      const out = process.env.INFINITARY_POOL_MEASURE_OUT;
      if (out)
        writeFileSync(out, `${JSON.stringify({ repo: measured ?? "fixture", cold, warm })}\n`);
      console.info(
        `[worktree-pool] ${measured ?? "fixture"}: cold dispatch median ${median(cold).toFixed(0)} ms (${cold.map((v) => v.toFixed(0)).join(", ")}), warm acquire median ${median(warm).toFixed(0)} ms (${warm.map((v) => v.toFixed(0)).join(", ")})`,
      );
    },
    600_000,
  );
});
