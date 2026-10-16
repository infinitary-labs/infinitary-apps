import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { encodeClaudeProjectDir } from "../claude/claudeTranscript";
import { openDatabase } from "../storage/db";
import { acquireMoveLock, moveLockHeld, moveLockPathFor } from "../storage/moveLock";
import { isProfileRetired } from "../storage/retiredProfile";
import { recordStartAtLogin } from "../storage/startAtLoginRecord";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { copyTree } from "./copy";
import { dueMove, type FolderMove, stagedFolderFor, stagedFolders } from "./due";
import { type MoveDeps, runMove, stageMove } from "./move";
import { readMoveRecord, writeMoveRecord } from "./record";

// Integration budget (docs/test-cohorts.md): real git, the system's copier
// and SQLite on scratch folders; the slowest case's fastest of three Mac
// runs is 0.430 s.
vi.setConfig({ testTimeout: 10_000 });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

type World = {
  base: string;
  appData: string;
  from: string;
  to: string;
  outside: string;
  claude: string;
  move: FolderMove;
  deps: MoveDeps;
};

/**
 * An older app's folder as Firstmate 3000 leaves it: a database whose newest
 * rows are still in its write-ahead log, a project cloned into the folder
 * with a working copy, a working copy of a project kept outside, a link the
 * app makes to a working copy's skills, private sign-in files, the
 * background work's record, a Claude session started in a working copy,
 * and start at login on.
 */
function olderFolder(): World {
  const base = realpathSync(scratchDir("fm-folder-move-"));
  const appData = join(base, "Application Support");
  const from = join(appData, "firstmate-3000");
  const to = join(appData, "infinitary");
  const outside = repo(join(base, "code", "outside"));
  const claude = join(base, ".claude");
  mkdirSync(from, { recursive: true });

  const inFleet = repo(join(from, "fleet", "inside"));
  git(inFleet, "worktree", "add", "-q", "-b", "fm/task-one", join(from, "worktrees", "one"));
  git(outside, "worktree", "add", "-q", "-b", "fm/task-two", join(from, "worktrees", "two"));
  symlinkSync(outside, join(from, "fleet", "outside"));
  mkdirSync(join(from, "worktrees", "one", ".claude", "skills", "tidy"), { recursive: true });
  mkdirSync(join(from, "crewmates", "one", "sessions", "project-skills", "skills"), {
    recursive: true,
  });
  symlinkSync(
    join(from, "worktrees", "one", ".claude", "skills", "tidy"),
    join(from, "crewmates", "one", "sessions", "project-skills", "skills", "tidy"),
  );
  writeFileSync(join(from, "crewmates", "one", "sessions", "pi.jsonl"), '{"type":"session"}\n');
  mkdirSync(join(from, "accounts", "codex", "a1"), { recursive: true, mode: 0o700 });
  chmodSync(join(from, "accounts"), 0o700);
  writeFileSync(join(from, "accounts", "codex", "a1", "auth.json"), "{}\n", { mode: 0o600 });
  mkdirSync(join(from, "work", "app", "Firstmate 3000.app"), { recursive: true });
  writeFileSync(
    join(from, "work", "installed.json"),
    JSON.stringify({
      version: 1,
      app: join(from, "work", "app", "Firstmate 3000.app"),
      service: { label: "x", file: "/elsewhere/x.plist" },
    }),
  );
  writeFileSync(join(from, "update-channel.json"), '{"schemaVersion":1,"channel":"stable"}\n');
  recordStartAtLogin(from, true);

  // The database, its newest rows only in the log: built beside, copied in
  // while still open, as a quit that never folded its log leaves it.
  const build = join(base, "build");
  const db = openDatabase(build);
  db.pragma("wal_autocheckpoint = 0");
  db.prepare("INSERT INTO repos (id, path, name, added_at) VALUES (?, ?, ?, ?)").run(
    "r-inside",
    inFleet,
    "inside",
    1,
  );
  const tasks = new TaskService({ db });
  seedTask(tasks, {
    id: "one",
    title: "One",
    repoId: "r-inside",
    repoDir: inFleet,
    worktreeDir: join(from, "worktrees", "one"),
    sessionFile: join(from, "crewmates", "one", "sessions", "pi.jsonl"),
    status: "idle",
  });
  seedTask(tasks, {
    id: "two",
    title: "Two",
    repoDir: outside,
    worktreeDir: join(from, "worktrees", "two"),
    status: "idle",
  });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    "firstmate-session-file",
    JSON.stringify(join(from, "firstmate", "sessions", "rolling.jsonl")),
  );
  for (const name of readdirSync(build)) copyFileSync(join(build, name), join(from, name));
  db.close();

  const session = join(claude, "projects", encodeClaudeProjectDir(join(from, "worktrees", "one")));
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, "s-1.jsonl"), '{"cwd":"x"}\n');

  return {
    base,
    appData,
    from,
    to,
    outside,
    claude,
    move: { from, to },
    deps: { platform: process.platform, claudeConfigDir: claude, hostname: hostname() },
  };
}

function rows(dir: string, sql: string): unknown[] {
  const db = new Database(join(dir, "firstmate.db"), { readonly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

describe("the one-time move of a data folder", () => {
  it("never wakes for Firstmate 3000's own folders", () => {
    const world = olderFolder();
    expect(dueMove({ appData: world.appData, spelling: "fm", flavor: "release" })).toBeNull();
    expect(dueMove({ appData: world.appData, spelling: "inf", flavor: "dev" })).toBeNull();
    expect(dueMove({ appData: world.appData, spelling: "inf", flavor: "release" })).toEqual(
      world.move,
    );
  });

  it("brings the older folder's work over whole, and keeps the older folder as the recovery copy", async () => {
    const world = olderFolder();
    const { from, to } = world;
    // The work is only in the log the older app left: the main file alone has none of it.
    const mainOnly = join(scratchDir("fm-folder-move-main-"), "firstmate.db");
    copyFileSync(join(from, "firstmate.db"), mainOnly);
    const bare = new Database(mainOnly, { readonly: true });
    expect(
      bare.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'tasks'").get(),
    ).toEqual({
      n: 0,
    });
    bare.close();
    // An installer already wrote the new app's channel marker, and nothing else.
    mkdirSync(to);
    writeFileSync(join(to, "update-channel.json"), '{"schemaVersion":1,"channel":"alpha"}\n');

    const phases: string[] = [];
    const outcome = await runMove(world.move, {
      ...world.deps,
      progress: (progress) => {
        if (phases.at(-1) !== progress.phase) phases.push(progress.phase);
      },
    });

    expect(outcome).toEqual({ kind: "moved", startAtLogin: true });
    expect(phases).toEqual(["checking", "copying", "verifying", "finishing"]);
    // The work, and the paths into it.
    expect(
      rows(to, "SELECT id, repo_dir, worktree_dir, session_file FROM tasks ORDER BY id"),
    ).toEqual([
      {
        id: "one",
        repo_dir: join(to, "fleet", "inside"),
        worktree_dir: join(to, "worktrees", "one"),
        session_file: join(to, "crewmates", "one", "sessions", "pi.jsonl"),
      },
      {
        id: "two",
        repo_dir: world.outside,
        worktree_dir: join(to, "worktrees", "two"),
        session_file: null,
      },
    ]);
    expect(rows(to, "SELECT path FROM repos")).toEqual([{ path: join(to, "fleet", "inside") }]);
    expect(rows(to, "SELECT value FROM settings WHERE key = 'firstmate-session-file'")).toEqual([
      { value: JSON.stringify(join(to, "firstmate", "sessions", "rolling.jsonl")) },
    ]);
    // Git works in both working copies, from both repositories.
    expect(git(join(to, "worktrees", "one"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "fm/task-one",
    );
    expect(git(join(to, "fleet", "inside"), "worktree", "list")).toContain(
      join(to, "worktrees", "one"),
    );
    expect(git(world.outside, "worktree", "list")).toContain(join(to, "worktrees", "two"));
    expect(git(join(to, "worktrees", "two"), "status", "--porcelain")).toBe("");
    // Links: the app's own retargeted, a project kept outside left where it is.
    expect(
      readlinkSync(join(to, "crewmates", "one", "sessions", "project-skills", "skills", "tidy")),
    ).toBe(join(to, "worktrees", "one", ".claude", "skills", "tidy"));
    expect(readlinkSync(join(to, "fleet", "outside"))).toBe(world.outside);
    expect(JSON.parse(readFileSync(join(to, "work", "installed.json"), "utf8")).app).toBe(
      join(to, "work", "app", "Firstmate 3000.app"),
    );
    // Private files stay private.
    expect(statSync(join(to, "accounts")).mode & 0o777).toBe(0o700);
    expect(statSync(join(to, "accounts", "codex", "a1", "auth.json")).mode & 0o777).toBe(0o600);
    // The newer install's channel marker is the one kept.
    expect(readFileSync(join(to, "update-channel.json"), "utf8")).toContain('"alpha"');
    // Claude's session, under the new working copy's name, beside the old.
    const projects = join(world.claude, "projects");
    expect(
      existsSync(join(projects, encodeClaudeProjectDir(join(to, "worktrees", "one")), "s-1.jsonl")),
    ).toBe(true);
    expect(
      existsSync(
        join(projects, encodeClaudeProjectDir(join(from, "worktrees", "one")), "s-1.jsonl"),
      ),
    ).toBe(true);
    // The older folder: retired, and otherwise as it was.
    expect(isProfileRetired(from)).toBe(true);
    expect(rows(from, "SELECT worktree_dir FROM tasks WHERE id = 'one'")).toEqual([
      { worktree_dir: join(from, "worktrees", "one") },
    ]);
    expect(stagedFolders(to)).toEqual([]);
    expect(moveLockHeld(moveLockPathFor(from))).toBe(false);
    expect(readMoveRecord(to)).toMatchObject({ state: "done", from, to });
    // A repeated launch finds nothing to move.
    expect(dueMove({ appData: world.appData, spelling: "inf", flavor: "release" })).toBeNull();
    expect(await runMove(world.move, world.deps)).toEqual({ kind: "nothing" });
  });

  it("rewrites paths stored by either name of the folder, where a link lies on the way", async () => {
    const world = olderFolder();
    // The app reaches its folder through a link; everything stored names the resolved path.
    const alias = join(realpathSync(scratchDir("fm-folder-move-alias-")), "home");
    symlinkSync(world.base, alias);
    const from = join(alias, "Application Support", "firstmate-3000");
    const to = join(alias, "Application Support", "infinitary");
    expect(await runMove({ from, to }, world.deps)).toMatchObject({ kind: "moved" });
    expect(rows(to, "SELECT worktree_dir FROM tasks ORDER BY id")).toEqual([
      { worktree_dir: join(to, "worktrees", "one") },
      { worktree_dir: join(to, "worktrees", "two") },
    ]);
    expect(readFileSync(join(to, "worktrees", "one", ".git"), "utf8")).toBe(
      `gitdir: ${join(to, "fleet", "inside", ".git", "worktrees", "one")}\n`,
    );
    expect(realpathSync(git(join(to, "worktrees", "one"), "rev-parse", "--git-common-dir"))).toBe(
      realpathSync(join(to, "fleet", "inside", ".git")),
    );
    expect(git(world.outside, "worktree", "list")).toContain(join(to, "worktrees", "two"));
    // Claude names a session's folder by the path its client started in: either name.
    const projects = join(world.claude, "projects");
    for (const name of [to, realpathSync(to)])
      expect(
        existsSync(
          join(projects, encodeClaudeProjectDir(join(name, "worktrees", "one")), "s-1.jsonl"),
        ),
      ).toBe(true);
  });

  it("asks when both folders hold work, and keeps or brings as the person chose", async () => {
    const kept = olderFolder();
    mkdirSync(join(kept.to, "crewmates"), { recursive: true });
    writeFileSync(join(kept.to, "firstmate.db"), "");
    expect(await runMove(kept.move, kept.deps)).toMatchObject({
      kind: "ask",
      from: { path: kept.from },
      to: { path: kept.to },
    });
    expect(await runMove(kept.move, kept.deps, "keep")).toEqual({ kind: "kept" });
    expect(isProfileRetired(kept.from)).toBe(false);
    expect(dueMove({ appData: kept.appData, spelling: "inf", flavor: "release" })).toBeNull();

    const brought = olderFolder();
    mkdirSync(join(brought.to, "crewmates", "mine"), { recursive: true });
    expect(await runMove(brought.move, brought.deps, "bring")).toMatchObject({ kind: "moved" });
    const record = readMoveRecord(brought.to);
    expect(record?.setAside).toBeDefined();
    expect(existsSync(join(record?.setAside ?? "", "crewmates", "mine"))).toBe(true);
    expect(existsSync(join(brought.to, "crewmates", "mine"))).toBe(false);
  });

  it("takes an interrupted copy away and leaves both folders as they were", async () => {
    const world = olderFolder();
    const interrupted = await runMove(world.move, {
      ...world.deps,
      copy: async (root, staged, options) => {
        await copyTree(root, staged, {
          ...options,
          done: () => {
            throw new Error("The computer went to sleep.");
          },
        });
      },
    });
    expect(interrupted).toEqual({
      kind: "refused",
      refusal: { reason: "failed", detail: "The computer went to sleep.", committed: false },
    });
    expect(stagedFolders(world.to)).toEqual([]);
    expect(existsSync(world.to)).toBe(false);
    expect(isProfileRetired(world.from)).toBe(false);
    expect(moveLockHeld(moveLockPathFor(world.from))).toBe(false);
    // The next launch moves it.
    expect(await runMove(world.move, world.deps)).toMatchObject({ kind: "moved" });
  });

  it("builds in a folder of its own while an earlier attempt's copier still writes", async () => {
    const world = olderFolder();
    // A launch stopped hard left its staged folder, and its copier may still be writing there.
    const earlier = stagedFolderFor(world.to, process.ppid);
    mkdirSync(join(earlier, "fleet"), { recursive: true });
    writeFileSync(join(earlier, "fleet", "half.bin"), "half");
    expect(await runMove(world.move, world.deps)).toMatchObject({ kind: "moved" });
    expect(existsSync(join(world.to, "fleet", "half.bin"))).toBe(false);
    expect(stagedFolders(world.to)).toEqual([]);
  });

  it("refuses a copy that does not match, before anything changes", async () => {
    const world = olderFolder();
    const outcome = await runMove(world.move, {
      ...world.deps,
      copy: async (root, staged, options) => {
        await copyTree(root, staged, options);
        writeFileSync(join(staged, "fleet", "inside", "README.md"), "jello\n");
      },
    });
    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { reason: "failed", committed: false },
    });
    expect(isProfileRetired(world.from)).toBe(false);
    expect(existsSync(world.to)).toBe(false);
  });

  it("resumes a move stopped after its copy was checked, without copying again", async () => {
    const world = olderFolder();
    // Made by a launch that then stopped: its own staged folder, named for it.
    expect(await stageMove(world.move, { ...world.deps, pid: process.ppid })).toBeNull();
    expect(readMoveRecord(stagedFolderFor(world.to, process.ppid))?.state).toBe("verified");
    // The launch after: the staged copy goes into place as it is.
    expect(dueMove({ appData: world.appData, spelling: "inf", flavor: "release" })).toEqual(
      world.move,
    );
    const copy = vi.fn();
    expect(await runMove(world.move, { ...world.deps, copy })).toMatchObject({ kind: "moved" });
    expect(copy).not.toHaveBeenCalled();
    expect(stagedFolders(world.to)).toEqual([]);
    expect(git(world.outside, "worktree", "list")).toContain(join(world.to, "worktrees", "two"));
  });

  it("finishes a move stopped after its commit", async () => {
    const world = olderFolder();
    await runMove(world.move, world.deps);
    const record = readMoveRecord(world.to);
    if (!record) throw new Error("no record");
    // As a crash right after the rename leaves it: outside links not yet changed.
    for (const change of record.outside ?? []) writeFileSync(change.path, change.before);
    writeMoveRecord(world.to, { ...record, state: "committed" });
    expect(dueMove({ appData: world.appData, spelling: "inf", flavor: "release" })).toEqual(
      world.move,
    );
    expect(await runMove(world.move, world.deps)).toMatchObject({ kind: "moved" });
    expect(git(world.outside, "worktree", "list")).toContain(join(world.to, "worktrees", "two"));
    expect(readMoveRecord(world.to)?.state).toBe("done");
  });

  it("refuses when the disk has too little room, and changes nothing", async () => {
    const world = olderFolder();
    const outcome = await runMove(world.move, {
      ...world.deps,
      free: () => 1000,
      clones: () => false,
    });
    expect(outcome).toMatchObject({ kind: "refused", refusal: { reason: "no-space", free: 1000 } });
    expect(stagedFolders(world.to)).toEqual([]);
    expect(isProfileRetired(world.from)).toBe(false);

    const full = await runMove(world.move, {
      ...world.deps,
      copy: async () => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      },
    });
    expect(full).toMatchObject({ kind: "refused", refusal: { reason: "no-space" } });
    expect(stagedFolders(world.to)).toEqual([]);
  });

  it("waits while the older app is open, another launch is moving, or the saved work is newer", async () => {
    const open = olderFolder();
    symlinkSync(`${hostname()}-${process.pid}`, join(open.from, "SingletonLock"));
    expect(await runMove(open.move, open.deps)).toEqual({
      kind: "refused",
      refusal: { reason: "old-app-open" },
    });

    const busy = olderFolder();
    expect(acquireMoveLock(moveLockPathFor(busy.from), process.ppid)).toBe(true);
    expect(await runMove(busy.move, busy.deps)).toEqual({
      kind: "refused",
      refusal: { reason: "busy" },
    });

    const newer = olderFolder();
    const db = new Database(join(newer.from, "firstmate.db"));
    db.prepare("INSERT INTO schema_migrations (version) VALUES (100000)").run();
    db.close();
    expect(await runMove(newer.move, newer.deps)).toEqual({
      kind: "refused",
      refusal: { reason: "unsupported" },
    });
    expect(lstatSync(newer.from).isDirectory()).toBe(true);
    expect(isProfileRetired(newer.from)).toBe(false);
  });
});
