import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { captureLoginPath, resetLoginPathForTests } from "../hostEnv";
import { writeLoginShellStub } from "../loginShellStub";
import { appPathsFor } from "../paths";
import { git } from "./git";
import { keptRefFor, WorkspaceService } from "./workspaceService";

// Integration budget (docs/test-cohorts.md): real git, the slowest test
// 2.392 s at its fastest of three eight-worker Mac runs (pass 4).
vi.setConfig({ testTimeout: 15_000 });

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

function emptyService() {
  const userData = scratchDir("infinitary-ws-");
  const paths = appPathsFor(userData);
  return { paths, workspace: new WorkspaceService(paths) };
}

// Only preparation is shared: no test ever opens this repository for writes.
// Initialisation itself remains exercised by the empty-service case below.
let defaultRepoTemplate: Promise<string> | undefined;
async function service() {
  defaultRepoTemplate ??= (async () => {
    const { workspace } = emptyService();
    const repo = await workspace.ensureDefaultRepo();
    await git(repo, ["config", "maintenance.auto", "false"]);
    return repo;
  })();
  const fixture = emptyService();
  mkdirSync(dirname(fixture.paths.defaultWorkspaceDir), { recursive: true });
  cpSync(await defaultRepoTemplate, fixture.paths.defaultWorkspaceDir, { recursive: true });
  return fixture;
}

/**
 * A pnpm stand-in that logs its arguments and answers each attempt the way
 * the test asks: the offline attempt (`--offline` present) and the online
 * one exit with their own codes.
 */
function stubPnpm(dir: string, offlineExit: number, onlineExit: number) {
  const log = join(dir, "pnpm-calls.log");
  const bin = join(dir, "pnpm-stub.sh");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$PWD|$*" >> "${log}"
case "$*" in
  *--offline*) [ ${offlineExit} -eq 0 ] || echo "ERR_PNPM_NO_OFFLINE_TARBALL missing from the store" >&2; exit ${offlineExit} ;;
esac
[ ${onlineExit} -eq 0 ] || echo "ERR_PNPM_FETCH_404 not found" >&2
exit ${onlineExit}
`,
  );
  chmodSync(bin, 0o755);
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("|"))
      : [];
  return { bin, calls };
}

describe("dependency install at commission (interaction P0, WI-7)", () => {
  async function worktreeWithLockfile(pnpm: string) {
    const userData = scratchDir("infinitary-ws-");
    const workspace = new WorkspaceService(appPathsFor(userData), { pnpm });
    const ws = await workspace.createTaskWorktree("abcd1234");
    writeFileSync(join(ws.cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    return { workspace, ws };
  }

  it("installs from the shared store offline with a frozen lockfile, in the worktree", async () => {
    const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 0, 0);
    const { workspace, ws } = await worktreeWithLockfile(stub.bin);
    const result = await workspace.installDependencies(ws.cwd);
    expect(result.outcome).toBe("offline");
    expect(stub.calls()).toEqual([[realpathSync(ws.cwd), "install --frozen-lockfile --offline"]]);
  });

  function directoryWithLockfile(pnpm: string) {
    const { paths } = emptyService();
    const workspace = new WorkspaceService(paths, { pnpm });
    const cwd = scratchDir("infinitary-install-policy-");
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    return { workspace, cwd };
  }

  it("falls back to an online frozen install when the store misses a package", async () => {
    const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 1, 0);
    const { workspace, cwd } = directoryWithLockfile(stub.bin);
    const result = await workspace.installDependencies(cwd);
    expect(result.outcome).toBe("online");
    expect(stub.calls().map(([, args]) => args)).toEqual([
      "install --frozen-lockfile --offline",
      "install --frozen-lockfile",
    ]);
  });

  it("reports a failed install with the reason instead of throwing", async () => {
    const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 1, 1);
    const { workspace, cwd } = directoryWithLockfile(stub.bin);
    const result = await workspace.installDependencies(cwd);
    expect(result).toMatchObject({ outcome: "failed", error: "ERR_PNPM_FETCH_404 not found" });
  });

  it("finds the pnpm the person's shell puts on the path, though the app's own path is the system folders", async () => {
    const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };
    const dir = scratchDir("infinitary-pnpm-path-");
    const nvm = join(dir, "nvm", "bin");
    const stub = stubPnpm(dir, 0, 0);
    // The planted program is named pnpm and lives only on the shell's path.
    mkdirSync(nvm, { recursive: true });
    writeFileSync(join(nvm, "pnpm"), `#!/bin/sh\nexec '${stub.bin}' "$@"\n`);
    chmodSync(join(nvm, "pnpm"), 0o755);
    try {
      process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
      process.env.SHELL = writeLoginShellStub(join(dir, "shell"), {
        interactive: `PATH='${nvm}':"$PATH"`,
      }).shell;
      resetLoginPathForTests();
      await captureLoginPath();
      const userData = scratchDir("infinitary-ws-");
      const workspace = new WorkspaceService(appPathsFor(userData));
      const cwd = scratchDir("infinitary-install-path-");
      writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      expect(await workspace.installDependencies(cwd)).toMatchObject({ outcome: "offline" });
      expect(stub.calls()).toEqual([[realpathSync(cwd), "install --frozen-lockfile --offline"]]);
    } finally {
      resetLoginPathForTests();
      process.env.PATH = saved.PATH;
      process.env.SHELL = saved.SHELL;
    }
  });

  it("skips a directory with no pnpm lockfile without running anything", async () => {
    const stub = stubPnpm(scratchDir("infinitary-pnpm-"), 0, 0);
    const userData = scratchDir("infinitary-ws-");
    const workspace = new WorkspaceService(appPathsFor(userData), { pnpm: stub.bin });
    const cwd = scratchDir("infinitary-no-lockfile-");
    expect(await workspace.installDependencies(cwd)).toEqual({ outcome: "skipped" });
    expect(stub.calls()).toEqual([]);
  });

  it("lists every fm/task-* branch with the task id it names, and nothing else", async () => {
    const { paths, workspace } = await service();
    await workspace.createTaskWorktree("aaaa1111");
    await workspace.createTaskWorktree("bbbb2222");
    await git(paths.defaultWorkspaceDir, ["branch", "feature/other"]);
    expect(await workspace.listTaskBranches(paths.defaultWorkspaceDir)).toEqual([
      { branch: "fm/task-aaaa1111", taskId: "aaaa1111" },
      { branch: "fm/task-bbbb2222", taskId: "bbbb2222" },
    ]);
    expect(await workspace.listTaskBranches(join(paths.userData, "not-a-repo"))).toEqual([]);
  });
});

describe("the copied repository fixture", () => {
  it("keeps files, config, refs and worktree registrations private, including future copies", async () => {
    const first = await service();
    const second = await service();
    const a = first.paths.defaultWorkspaceDir;
    const b = second.paths.defaultWorkspaceDir;
    expect(await git(a, ["rev-parse", "HEAD"])).toBe(await git(b, ["rev-parse", "HEAD"]));
    expect(await git(b, ["status", "--porcelain"])).toBe("");
    await git(a, ["config", "fixture.private", "first"]);
    writeFileSync(join(a, "private.txt"), "only first\n");
    await git(a, ["add", "private.txt"]);
    await git(a, ["commit", "-m", "test: private fixture write"]);
    const task = await first.workspace.createTaskWorktree("fixture1111");
    const third = await service();
    for (const { paths, workspace } of [second, third]) {
      const repo = paths.defaultWorkspaceDir;
      expect(existsSync(join(repo, "private.txt"))).toBe(false);
      expect(await git(repo, ["config", "--get", "fixture.private"]).catch(() => "")).toBe("");
      expect(await git(repo, ["branch", "--list", task.branch])).toBe("");
      expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain("fixture1111");
      const own = await workspace.createTaskWorktree("fixture1111");
      expect(realpathSync(own.repoDir)).toBe(realpathSync(repo));
      expect(await git(own.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toBe(
        join(realpathSync(repo), ".git"),
      );
    }
  });
});

describe("WorkspaceService", () => {
  it("initializes the default repo lazily with an initial commit", async () => {
    const { paths, workspace } = emptyService();
    expect(existsSync(paths.defaultWorkspaceDir)).toBe(false);
    const repo = await workspace.ensureDefaultRepo();
    expect(repo).toBe(paths.defaultWorkspaceDir);
    expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await git(repo, ["log", "--oneline"])).toContain("initialize default workspace");
    // Idempotent.
    await workspace.ensureDefaultRepo();
    expect((await git(repo, ["log", "--oneline"])).split("\n")).toHaveLength(1);
  });

  it("creates one worktree per task on its own branch", async () => {
    const { paths, workspace } = await service();
    const a = await workspace.createTaskWorktree("aaaa1111");
    const b = await workspace.createTaskWorktree("bbbb2222");
    expect(a.cwd).toBe(join(paths.worktreesDir, "aaaa1111"));
    expect(a.branch).toBe("fm/task-aaaa1111");
    expect(await git(a.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-aaaa1111");
    expect(await git(b.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-bbbb2222");
    // Both worktrees share the default repo.
    const list = await git(paths.defaultWorkspaceDir, ["worktree", "list"]);
    expect(list).toContain("aaaa1111");
    expect(list).toContain("bbbb2222");
  });

  it("answers a task branch's head, and null for a branch that is gone", async () => {
    // The reviewed tier reads the builder's branch BEFORE any PR exists
    // (captain ruling, 2026-09-19): this is the head the review brief
    // names and the per-head round counter keys on.
    const { workspace } = await service();
    const ws = await workspace.createTaskWorktree("cccc3333");
    const head = await workspace.branchHead(ws.repoDir, ws.branch);
    expect(head).toBe(await git(ws.cwd, ["rev-parse", "HEAD"]));
    expect(await workspace.branchHead(ws.repoDir, "fm/task-never-was")).toBeNull();
  });

  it("lists every committed changed path at the review head, including spaces and leading whitespace", async () => {
    const { workspace } = await service();
    const ws = await workspace.createTaskWorktree("cccc4444");
    writeFileSync(join(ws.cwd, " leading space.txt"), "one\n");
    writeFileSync(join(ws.cwd, "second file.txt"), "two\n");
    await git(ws.cwd, ["add", "-A"]);
    await git(ws.cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "Add files",
    ]);
    const head = await git(ws.cwd, ["rev-parse", "HEAD"]);
    expect(await workspace.reviewChangedFiles(ws.repoDir, "1".repeat(40))).toBeNull();
    expect(await workspace.reviewChangedFiles(ws.repoDir, head)).toEqual([
      " leading space.txt",
      "second file.txt",
    ]);
    writeFileSync(join(ws.cwd, "uncommitted.txt"), "not at this head\n");
    expect(await workspace.reviewChangedFiles(ws.repoDir, head)).toEqual([
      " leading space.txt",
      "second file.txt",
    ]);
  });

  it("keeps one change reading across a pure update, and not across an edited conflict or an indentation change", async () => {
    // INF-148, the captain's words: a passed review should not start over
    // only because main moved, when the change itself is the same.
    const { workspace } = await service();
    const repo = await workspace.ensureDefaultRepo();
    const commit = async (file: string, body: string, message: string) => {
      writeFileSync(join(repo, file), body);
      await git(repo, ["add", file]);
      await git(repo, ["commit", "-m", message]);
      return git(repo, ["rev-parse", "HEAD"]);
    };
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const base = `${lines.join("\n")}\n`;
    const changed = `${lines.map((line) => (line === "line 20" ? "line 20 changed" : line)).join("\n")}\n`;
    await commit("a.txt", base, "chore: base lines");
    await git(repo, ["checkout", "-b", "work"]);
    const reviewed = await commit("a.txt", changed, "feat: change line 20");
    const reviewedReading = await workspace.reviewChangeReading(repo, reviewed);
    expect(reviewedReading).toMatch(/^[0-9a-f]{64}$/);
    expect(await workspace.reviewChangeReading(repo, "1".repeat(40))).toBeNull();

    // Newer main edits a line away from the change. The change lines are the same.
    await git(repo, ["checkout", "main"]);
    await commit(
      "a.txt",
      `${base.replace("line 1\n", "line 1 main\n")}`,
      "chore: main edits a nearby line",
    );
    await git(repo, ["checkout", "work"]);
    await git(repo, ["rebase", "main"]);
    const updated = await git(repo, ["rev-parse", "HEAD"]);
    expect(updated).not.toBe(reviewed);
    expect(await workspace.reviewChangeReading(repo, updated)).toBe(reviewedReading);

    // An indentation change of the change itself does not keep the reading.
    const indented = await commit(
      "a.txt",
      `${base.replace("line 1\n", "line 1 main\n").replace("line 20\n", "  line 20 changed\n")}`,
      "style: indent the changed line",
    );
    expect(await workspace.reviewChangeReading(repo, indented)).not.toBe(reviewedReading);

    // A conflict resolved by editing the change does not keep the reading.
    await git(repo, ["checkout", "main"]);
    await commit(
      "a.txt",
      `${base.replace("line 1\n", "line 1 main\n").replace("line 20\n", "line 20 from main\n")}`,
      "chore: main edits the same line",
    );
    await git(repo, ["checkout", "-B", "conflict", reviewed]);
    await expect(git(repo, ["rebase", "main"])).rejects.toThrow();
    writeFileSync(
      join(repo, "a.txt"),
      `${base.replace("line 1\n", "line 1 main\n").replace("line 20\n", "line 20 changed and main\n")}`,
    );
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["-c", "core.editor=true", "rebase", "--continue"]);
    const edited = await git(repo, ["rev-parse", "HEAD"]);
    expect(await workspace.reviewChangeReading(repo, edited)).not.toBe(reviewedReading);
  });

  it("treats a moved guard as a different change once the file is already on main", async () => {
    // Review finding R1. Both functions are on main first, so the change is
    // only the inserted guard. With no context the two placements read the
    // same; one neighboring line makes a move an edit.
    const { workspace } = await service();
    const repo = await workspace.ensureDefaultRepo();
    const source = [
      "function a() {",
      "  return 1;",
      "}",
      "function b() {",
      "  return 2;",
      "}",
      "",
    ].join("\n");
    writeFileSync(join(repo, "guard.ts"), source);
    await git(repo, ["add", "guard.ts"]);
    await git(repo, ["commit", "-m", "chore: two functions"]);
    await git(repo, ["checkout", "-b", "moved"]);
    const place = async (fn: "a" | "b", message: string) => {
      const body = source.replace(
        `function ${fn}() {\n`,
        `function ${fn}() {\n  if (!ok) return;\n`,
      );
      writeFileSync(join(repo, "guard.ts"), body);
      await git(repo, ["add", "guard.ts"]);
      await git(repo, ["commit", "-m", message]);
      return git(repo, ["rev-parse", "HEAD"]);
    };
    const inserted = await place("a", "feat: guard function a");
    const moved = await place("b", "fix: move the guard to function b");
    expect(await workspace.reviewChangeReading(repo, moved)).not.toBe(
      await workspace.reviewChangeReading(repo, inserted),
    );
  });

  it("reuses an existing matching worktree on a second create", async () => {
    const { workspace } = await service();
    const first = await workspace.createTaskWorktree("dddd4444");
    writeFileSync(join(first.cwd, "keep.txt"), "stayed\n");
    const second = await workspace.createTaskWorktree("dddd4444");
    // The same tree, and nothing acquired this time: it was already there.
    const { acquired, ...tree } = first;
    expect(acquired?.source).toBe("new");
    expect(second).toEqual(tree);
    expect(existsSync(join(first.cwd, "keep.txt"))).toBe(true);
    expect(await git(first.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-dddd4444");
  });

  it("checks out an existing leftover branch without failing add -b", async () => {
    const { paths, workspace } = await service();
    const first = await workspace.createTaskWorktree("eeee5555");
    await git(first.repoDir, ["worktree", "remove", first.cwd]);
    expect(existsSync(first.cwd)).toBe(false);
    expect(
      await git(paths.defaultWorkspaceDir, ["branch", "--list", "fm/task-eeee5555"]),
    ).toContain("fm/task-eeee5555");
    const second = await workspace.createTaskWorktree("eeee5555");
    expect(second.branch).toBe("fm/task-eeee5555");
    expect(await git(second.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-eeee5555");
  });

  it("replaces a stale empty worktree path left by a failed add", async () => {
    const { paths, workspace } = await service();
    mkdirSync(join(paths.worktreesDir, "ffff6666"), { recursive: true });
    const created = await workspace.createTaskWorktree("ffff6666");
    expect(await git(created.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("fm/task-ffff6666");
  });
});

// The delete path: what every removal did before the warm pool, and what a
// removal still does when the pool is off or cannot take the tree.
describe("worktree deletion off the settle path (character-jank scout)", () => {
  /** A deleteTree the test releases, so the order of events is observable. */
  function heldDeletion() {
    const started: string[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deleteTree = async (dir: string) => {
      started.push(dir);
      await released;
      rmSync(dir, { recursive: true, force: true });
    };
    return { deleteTree, started, release };
  }

  it("returns before the tree is deleted, with the worktree and branch already gone", async () => {
    const userData = scratchDir("infinitary-ws-");
    const paths = appPathsFor(userData);
    const held = heldDeletion();
    const workspace = new WorkspaceService(paths, { deleteTree: held.deleteTree, pool: false });
    const ws = await workspace.createTaskWorktree("dddd4444");
    mkdirSync(join(ws.cwd, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(ws.cwd, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

    await workspace.removeTaskWorktree(ws);

    // The settle has its answer while the tree is still being deleted.
    expect(held.started).toHaveLength(1);
    const trashed = held.started[0] as string;
    expect(existsSync(join(trashed, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(existsSync(ws.cwd)).toBe(false);
    // git lists realpaths, so match the task id rather than the path.
    expect(await git(paths.defaultWorkspaceDir, ["worktree", "list"])).not.toContain("dddd4444");
    expect(await git(paths.defaultWorkspaceDir, ["branch", "--list", ws.branch])).toBe("");

    held.release();
    await workspace.deletionsSettled();
    expect(existsSync(trashed)).toBe(false);
  });

  it("deletes the tree for real in the background and leaves the trash empty", async () => {
    const paths = appPathsFor(scratchDir("infinitary-ws-"));
    const workspace = new WorkspaceService(paths, { pool: false });
    const ws = await workspace.createTaskWorktree("eeee5555");
    writeFileSync(join(ws.cwd, "big.txt"), "x".repeat(100_000));
    await workspace.removeTaskWorktree(ws);
    await workspace.deletionsSettled();
    expect(readdirSync(paths.worktreeTrashDir)).toEqual([]);
    // The repo can hand the same task a fresh worktree afterwards.
    const again = await workspace.createTaskWorktree("eeee5555");
    expect(existsSync(again.cwd)).toBe(true);
  });

  it("finishes at boot what a quit left half-deleted", async () => {
    const userData = scratchDir("infinitary-ws-");
    const paths = appPathsFor(userData);
    mkdirSync(join(paths.worktreeTrashDir, "ffff6666-left", "node_modules"), { recursive: true });
    writeFileSync(join(paths.worktreeTrashDir, "ffff6666-left", "node_modules", "a.js"), "1");
    const workspace = new WorkspaceService(paths, { pool: false });
    workspace.sweepTrash();
    await workspace.deletionsSettled();
    expect(readdirSync(paths.worktreeTrashDir)).toEqual([]);
    // No trash dir at all is nothing to do.
    new WorkspaceService(appPathsFor(scratchDir("infinitary-ws-"))).sweepTrash();
  });

  it("never moves aside a tree outside the app's worktrees area", async () => {
    const userData = scratchDir("infinitary-ws-");
    const paths = appPathsFor(userData);
    const held = heldDeletion();
    const workspace = new WorkspaceService(paths, { deleteTree: held.deleteTree, pool: false });
    await workspace.createTaskWorktree("cdcd8888");
    // A record pointing at the repo's own checkout: git refuses to remove a
    // main worktree, and nothing is moved into the trash.
    await workspace
      .removeTaskWorktree({
        taskId: "cdcd8888",
        cwd: paths.defaultWorkspaceDir,
        branch: "fm/task-cdcd8888",
        repoDir: paths.defaultWorkspaceDir,
      })
      .catch(() => {});
    expect(held.started).toEqual([]);
    expect(existsSync(paths.worktreeTrashDir)).toBe(false);
  });

  it("removes a tree it cannot move aside in place, as before", async () => {
    const userData = scratchDir("infinitary-ws-");
    const paths = appPathsFor(userData);
    const held = heldDeletion();
    const workspace = new WorkspaceService(paths, { deleteTree: held.deleteTree, pool: false });
    const ws = await workspace.createTaskWorktree("abab7777");
    // A file where the trash dir should be: the move aside cannot happen.
    writeFileSync(paths.worktreeTrashDir, "not a directory");
    await workspace.removeTaskWorktree(ws);
    expect(held.started).toEqual([]);
    expect(existsSync(ws.cwd)).toBe(false);
    expect(await git(paths.defaultWorkspaceDir, ["branch", "--list", ws.branch])).toBe("");
  });
});

describe("taskWorkStatus (P1: what a discard would destroy)", () => {
  async function serviceWithRemote() {
    const result = await service();
    await result.workspace.ensureDefaultRepo();
    const remote = scratchDir("infinitary-remote-");
    await git(remote, ["init", "--bare", "--initial-branch=main"]);
    await git(result.paths.defaultWorkspaceDir, ["remote", "add", "origin", remote]);
    await git(result.paths.defaultWorkspaceDir, ["push", "--set-upstream", "origin", "main"]);
    await git(result.paths.defaultWorkspaceDir, ["remote", "set-head", "origin", "main"]);
    return result;
  }

  it("counts unlanded commits and sees uncommitted edits", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("stat2222");
    writeFileSync(join(task.cwd, "a.txt"), "one\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: one"]);
    writeFileSync(join(task.cwd, "b.txt"), "wip\n");
    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: true, unlandedCommits: 1 });
  });

  it("treats landed commits as safe again", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("stat3333");
    writeFileSync(join(task.cwd, "a.txt"), "one\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: one"]);
    await workspace.landTaskWork(task);
    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: false, unlandedCommits: 0 });
  });

  it("treats task commits on the tracked remote integration branch as landed", async () => {
    const { paths, workspace } = await serviceWithRemote();
    const task = await workspace.createTaskWorktree("statremote1");
    writeFileSync(join(task.cwd, "remote.txt"), "merged\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: merged remotely"]);

    await git(task.cwd, ["push", "origin", `${task.branch}:main`]);
    await git(paths.defaultWorkspaceDir, ["fetch", "origin", "main"]);

    expect(await git(paths.defaultWorkspaceDir, ["rev-parse", "HEAD"])).not.toBe(
      await git(paths.defaultWorkspaceDir, ["rev-parse", "origin/main"]),
    );
    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: false, unlandedCommits: 0 });
  });

  it("keeps commits protected when they exist only on the task's remote branch", async () => {
    const { workspace } = await serviceWithRemote();
    const task = await workspace.createTaskWorktree("statremote2");
    writeFileSync(join(task.cwd, "remote.txt"), "pushed only\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: pushed but unmerged"]);

    await git(task.cwd, ["push", "--set-upstream", "origin", task.branch]);

    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: false, unlandedCommits: 1 });
  });

  it("uses a valid remote default when the checked-out upstream is stale", async () => {
    const { paths, workspace } = await serviceWithRemote();
    const task = await workspace.createTaskWorktree("statremote3");
    writeFileSync(join(task.cwd, "remote.txt"), "merged\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: merged on default"]);
    await git(task.cwd, ["push", "origin", `${task.branch}:main`]);
    await git(paths.defaultWorkspaceDir, ["fetch", "origin", "main"]);
    await git(paths.defaultWorkspaceDir, ["config", "branch.main.merge", "refs/heads/missing"]);

    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: false, unlandedCommits: 0 });
  });

  it("reports nothing to lose when the worktree is already gone", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("stat4444");
    await workspace.removeTaskWorktree(task);
    expect(await workspace.taskWorkStatus(task)).toEqual({ dirty: false, unlandedCommits: 0 });
  });
});

describe("retireTaskWorktree (always clean, work saved first)", () => {
  it("saves nothing for landed work and still removes the tree and branch", async () => {
    const { workspace, paths } = await service();
    const task = await workspace.createTaskWorktree("keep1111");
    writeFileSync(join(task.cwd, "a.txt"), "one\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: one"]);
    await workspace.landTaskWork(task);

    expect(await workspace.retireTaskWorktree(task)).toEqual({ outcome: "removed", kept: null });
    expect(existsSync(task.cwd)).toBe(false);
    expect(await git(paths.defaultWorkspaceDir, ["for-each-ref", "refs/infinitary"])).toBe("");
    expect(await workspace.branchHead(paths.defaultWorkspaceDir, task.branch)).toBeNull();
  });

  it("saves even landed work when asked to always keep, so a named ref exists", async () => {
    const { workspace, paths } = await service();
    const task = await workspace.createTaskWorktree("keep2222");
    const retired = await workspace.retireTaskWorktree(task, { keepAlways: true });
    expect(retired).toMatchObject({
      outcome: "removed",
      kept: { ref: keptRefFor("keep2222"), dirty: false, unlandedCommits: 0 },
    });
    expect(
      await git(paths.defaultWorkspaceDir, ["rev-parse", `${keptRefFor("keep2222")}^{commit}`]),
    ).toBe(retired.outcome === "removed" ? retired.kept?.sha : "");
  });

  it("keeps an earlier save as a parent when the same task is saved again", async () => {
    const { workspace, paths } = await service();
    const repo = paths.defaultWorkspaceDir;
    const first = await workspace.createTaskWorktree("keep3333");
    writeFileSync(join(first.cwd, "first.txt"), "first\n");
    await workspace.retireTaskWorktree(first);
    const again = await workspace.createTaskWorktree("keep3333");
    writeFileSync(join(again.cwd, "second.txt"), "second\n");
    await workspace.retireTaskWorktree(again);

    const ref = keptRefFor("keep3333");
    expect(await git(repo, ["show", `${ref}:second.txt`])).toBe("second");
    expect(await git(repo, ["show", `${ref}^2:first.txt`])).toBe("first");
  });

  it("never reads an enclosing repository as the tree's own: a plain directory is refused, not removed", async () => {
    const { paths } = emptyService();
    // The worktrees area itself sits inside a repository.
    await git(paths.userData, ["init", "--initial-branch=main"]);
    const workspace = new WorkspaceService(paths);
    const dir = join(paths.worktreesDir, "plain1111");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "not a checkout\n");

    expect(await workspace.workspaceAt("plain1111")).toBeNull();
    expect(await workspace.removeEmptyWorktreeDir("plain1111")).toBe(false);
    const retired = await workspace.retireTaskWorktree({
      taskId: "plain1111",
      cwd: dir,
      branch: "",
      repoDir: paths.userData,
    });
    expect(retired).toMatchObject({ outcome: "kept" });
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("not a checkout\n");
  });

  it("finds the repository and task branch of a tree whose record is gone", async () => {
    const { workspace, paths } = await service();
    const task = await workspace.createTaskWorktree("orph1111");
    expect(await workspace.workspaceAt("orph1111")).toEqual({
      taskId: "orph1111",
      cwd: task.cwd,
      branch: "fm/task-orph1111",
      repoDir: realpathSync(paths.defaultWorkspaceDir),
    });
    expect(workspace.listWorktreeDirs()).toEqual(["orph1111"]);
  });
});

describe("refreshManagedCheckout", () => {
  it("fast-forwards a clean default checkout from origin", async () => {
    const { workspace } = await service();
    const remoteDir = scratchDir("infinitary-refresh-remote-");
    const remote = join(remoteDir, "remote.git");
    await git(remoteDir, ["init", "--bare", remote]);
    const local = await workspace.ensureDefaultRepo();
    await git(local, ["remote", "add", "origin", remote]);
    await git(local, ["push", "-u", "origin", "main"]);
    await git(local, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(local, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "remote change",
    ]);
    await git(local, ["push", "origin", "main"]);
    await git(local, ["reset", "--hard", "HEAD~1"]);
    expect(await workspace.refreshManagedCheckout(local)).toEqual({ refreshed: true });
    expect(await git(local, ["rev-parse", "HEAD"])).toBe(
      await git(local, ["rev-parse", "refs/remotes/origin/main"]),
    );
  });

  it("leaves a dirty default checkout untouched", async () => {
    const { workspace } = await service();
    const local = await workspace.ensureDefaultRepo();
    await git(local, ["remote", "add", "origin", "unused"]);
    writeFileSync(join(local, "dirty.txt"), "keep\n");
    expect(await workspace.refreshManagedCheckout(local)).toMatchObject({ refreshed: false });
    expect(await git(local, ["status", "--porcelain"])).toContain("dirty.txt");
  });
});

describe("landTaskWork (Q5, forge-agnostic local landing)", () => {
  it("fast-forwards a clean branch and reports the mode", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("land1111");
    writeFileSync(join(task.cwd, "feature.txt"), "done\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: land me"]);

    const result = await workspace.landTaskWork(task);
    expect(result.mode).toBe("fast-forward");
    expect(await git(task.repoDir, ["log", "--oneline", "-1"])).toContain("feat: land me");

    await workspace.removeTaskWorktree(task);
    expect(existsSync(task.cwd)).toBe(false);
  });

  it.each([false, true])(
    "rechecks live permission before the %s fallback merge without moving main",
    async (fallback) => {
      const { workspace } = await service();
      const task = await workspace.createTaskWorktree(fallback ? "live2222" : "live1111");
      await git(task.cwd, ["commit", "--allow-empty", "-m", "feat: branch work"]);
      if (fallback)
        await git(task.repoDir, ["commit", "--allow-empty", "-m", "chore: main advanced"]);
      const before = await git(task.repoDir, ["rev-parse", "HEAD"]);
      let calls = 0;
      const guard = () => {
        calls++;
        return fallback && calls === 1 ? undefined : "The task now asks before merging";
      };
      await expect(workspace.landTaskWork(task, guard)).rejects.toThrow("asks before merging");
      expect(calls).toBe(fallback ? 2 : 1);
      expect(await git(task.repoDir, ["rev-parse", "HEAD"])).toBe(before);
      expect(await git(task.repoDir, ["status", "--porcelain"])).toBe("");
    },
  );

  it("refuses a plain incoming save point without moving the checked-out project", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("plain123");
    await git(task.cwd, ["commit", "--allow-empty", "-m", "Plain save point"]);
    const before = await git(task.repoDir, ["rev-parse", "HEAD"]);
    await expect(workspace.landTaskWork(task)).rejects.toThrow(/conventional name/);
    expect(await git(task.repoDir, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("falls back to a merge commit when main moved on", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("land2222");
    writeFileSync(join(task.cwd, "feature.txt"), "done\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: branch work"]);
    // Main advances independently on a different file.
    writeFileSync(join(task.repoDir, "elsewhere.txt"), "moved\n");
    await git(task.repoDir, ["add", "-A"]);
    await git(task.repoDir, ["commit", "-m", "chore: mainline moved"]);

    const result = await workspace.landTaskWork(task);
    expect(result.mode).toBe("merge");
    const log = await git(task.repoDir, ["log", "--oneline", "-3"]);
    expect(log).toContain("chore: integrate task work");
    expect(log).toContain("feat: branch work");
    expect(log).toContain("chore: mainline moved");
  });

  it("refuses a conflict and leaves the repo exactly as found", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("land3333");
    writeFileSync(join(task.cwd, "README.md"), "branch version\n");
    await git(task.cwd, ["add", "-A"]);
    await git(task.cwd, ["commit", "-m", "feat: branch readme"]);
    writeFileSync(join(task.repoDir, "README.md"), "main version\n");
    await git(task.repoDir, ["add", "-A"]);
    await git(task.repoDir, ["commit", "-m", "chore: main readme"]);
    const headBefore = await git(task.repoDir, ["rev-parse", "HEAD"]);

    await expect(workspace.landTaskWork(task)).rejects.toThrow(/conflict/);
    expect(await git(task.repoDir, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(task.repoDir, ["status", "--porcelain"])).toBe("");
  });

  it("refuses a dirty repository before touching anything", async () => {
    const { workspace } = await service();
    const task = await workspace.createTaskWorktree("land4444");
    writeFileSync(join(task.repoDir, "wip.txt"), "uncommitted\n");
    await expect(workspace.landTaskWork(task)).rejects.toThrow(/uncommitted changes/);
  });
});
