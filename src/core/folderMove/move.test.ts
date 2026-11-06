import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, uptime } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { bundleForElectron } from "../../../tests/helpers/electronBundle";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { encodeClaudeProjectDir } from "../claude/claudeTranscript";
import { processAlive } from "../helper/lock";
import { openDatabase } from "../storage/db";
import { acquireMoveLock, moveLockHeld, moveLockPathFor } from "../storage/moveLock";
import { isProfileRetired } from "../storage/retiredProfile";
import { recordStartAtLogin } from "../storage/startAtLoginRecord";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { seedProject } from "../workspace/seedProject";
import { copyTree } from "./copy";
import { dueMove, type FolderMove, stagedFolderFor, stagedFolders } from "./due";
import { type MoveDeps, type MoveItem, runMove, stageMove } from "./move";
import { readMoveRecord, writeMoveRecord } from "./record";

// Integration budget (docs/test-cohorts.md): real git, the system's copier,
// SQLite, a vite build and the Electron binary on scratch folders; the slowest
// case's fastest of three Mac runs is 0.588 s.
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

/** A working copy a computer that runs work keeps for its home's task: `work/worktrees/<task>`. */
const WORK_COPY = join("work", "worktrees", "three");

/** The Claude sessions the older folder holds, by the working copy each was started in. */
const CLAUDE_SESSIONS = [
  { copy: join("worktrees", "one"), file: "s-1.jsonl" },
  { copy: WORK_COPY, file: "s-3.jsonl" },
] as const;

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
 * background work's record, a working copy the work keeps for its home
 * (docs/helper.md, "Its working copies"), a Claude session started in each
 * working copy, and start at login on.
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
  // The work's bare clone of a project and a task's working copy of it, three levels down.
  const workClone = join(from, "work", "repos", "0123456789abcdef");
  git(from, "clone", "-q", "--bare", outside, workClone);
  git(workClone, "worktree", "add", "-q", "-b", "fm/task-three", join(from, WORK_COPY));
  writeFileSync(join(from, "update-channel.json"), '{"schemaVersion":1,"channel":"stable"}\n');
  recordStartAtLogin(from, true);

  // The database, its newest rows only in the log: built beside, copied in
  // while still open, as a quit that never folded its log leaves it.
  const build = join(base, "build");
  const db = openDatabase(build);
  db.pragma("wal_autocheckpoint = 0");
  seedProject(db, { id: "r-inside", name: "inside", path: inFleet, setupKind: "init", addedAt: 1 });
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

  for (const { copy, file } of CLAUDE_SESSIONS) {
    const session = join(claude, "projects", encodeClaudeProjectDir(join(from, copy)));
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, file), '{"cwd":"x"}\n');
  }

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
      rows(
        to,
        `SELECT t.id, t.repo_dir, t.worktree_dir, x.session_file
         FROM tasks t LEFT JOIN task_execution x ON x.task_id = t.id ORDER BY t.id`,
      ),
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
    // Claude's sessions, under the new working copies' names, beside the old:
    // the home's own and the work's (INF-283).
    const projects = join(world.claude, "projects");
    for (const { copy, file } of CLAUDE_SESSIONS)
      for (const folder of [to, from])
        expect(
          existsSync(join(projects, encodeClaudeProjectDir(join(folder, copy)), file)),
          join(folder, copy),
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

  // INF-967's accepted plan: a clone is checked by its size and time, so a
  // file the older app changed after its clone must still stop the move.
  it.runIf(process.platform === "darwin")(
    "refuses a cloned file that changed during the copy, before anything changes",
    async () => {
      const world = olderFolder();
      const units: [string, boolean][] = [];
      const outcome = await runMove(world.move, {
        ...world.deps,
        copy: async (root, staged, options) => {
          await copyTree(root, staged, {
            ...options,
            done: (unit, cloned) => {
              units.push([unit, cloned]);
              options.done?.(unit, cloned);
            },
          });
          // The same size, written after the clone was made.
          writeFileSync(join(root, "fleet", "inside", "README.md"), "jello\n");
        },
      });
      expect(units.length).toBeGreaterThan(0);
      expect(units.filter(([, cloned]) => !cloned)).toEqual([]);
      expect(outcome).toMatchObject({
        kind: "refused",
        refusal: { reason: "failed", committed: false },
      });
      expect(outcome.kind === "refused" && outcome.refusal).toMatchObject({
        detail: expect.stringContaining("a different time"),
      });
      expect(isProfileRetired(world.from)).toBe(false);
      expect(existsSync(world.to)).toBe(false);
    },
  );

  // INF-967's accepted plan: a file written byte by byte is the one copy that
  // can silently differ, so its bytes are checked even when its size and time agree.
  it("refuses a written file whose bytes differ though its size and time agree", async () => {
    const world = olderFolder();
    const outcome = await runMove(world.move, {
      ...world.deps,
      // Node's copy writes every file's bytes, as it does on every system but a Mac.
      platform: "linux",
      copy: async (root, staged, options) => {
        await copyTree(root, staged, options);
        const file = join(staged, "fleet", "inside", "README.md");
        writeFileSync(file, "jello\n");
        const source = statSync(join(root, "fleet", "inside", "README.md"));
        utimesSync(file, source.atime, source.mtime);
      },
    });
    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { reason: "failed", committed: false },
    });
    expect(outcome.kind === "refused" && outcome.refusal).toMatchObject({
      detail: expect.stringContaining("different contents"),
    });
    expect(existsSync(world.to)).toBe(false);
  });

  // INF-967's accepted plan: the warm pool's spare working copies land one at
  // a time, so the bar moves as each one is copied.
  it("copies each spare working copy of the warm pool as a unit of its own", async () => {
    const world = olderFolder();
    const project = join(world.from, "worktree-pool", "0123abcd");
    for (const slot of ["1700000000000-a", "1700000000001-b"]) {
      mkdirSync(join(project, slot, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(join(project, slot, "node_modules", "left-pad", "index.js"), slot);
    }
    chmodSync(project, 0o750);
    const copying: { done: number; total: number }[] = [];
    const units: string[] = [];
    const afterPool: number[] = [];
    const items: MoveItem[] = [];
    const outcome = await runMove(world.move, {
      ...world.deps,
      progress: (progress) => {
        if (progress.phase === "copying") copying.push(progress);
        if (progress.item && progress.item !== items.at(-1)) items.push(progress.item);
      },
      copy: (root, staged, options) =>
        copyTree(root, staged, {
          ...options,
          done: (unit, cloned) => {
            units.push(unit);
            options.done?.(unit, cloned);
            if (unit.startsWith("worktree-pool")) afterPool.push(copying.at(-1)?.done ?? 0);
          },
        }),
    });
    expect(outcome).toMatchObject({ kind: "moved" });
    expect(units.filter((unit) => unit.startsWith("worktree-pool")).sort()).toEqual([
      join("worktree-pool", "0123abcd", "1700000000000-a"),
      join("worktree-pool", "0123abcd", "1700000000001-b"),
    ]);
    // Each spare working copy moved the bar by its own share, and the copy ended full.
    expect(new Set(afterPool).size).toBe(2);
    expect(copying.at(-1)?.done).toBe(copying.at(-1)?.total);
    // The window names each by its kind and its place among them, and a task's working copy by its short name.
    expect(items.filter((item) => item.kind === "spare-working-copy")).toEqual([
      { kind: "spare-working-copy", index: 1, of: 2, files: 1 },
      { kind: "spare-working-copy", index: 2, of: 2, files: 1 },
    ]);
    expect(items).toContainEqual(expect.objectContaining({ kind: "working-copy", name: "one" }));
    expect(
      readFileSync(
        join(
          world.to,
          "worktree-pool",
          "0123abcd",
          "1700000000001-b",
          "node_modules",
          "left-pad",
          "index.js",
        ),
        "utf8",
      ),
    ).toBe("1700000000001-b");
    expect(statSync(join(world.to, "worktree-pool", "0123abcd")).mode & 0o7777).toBe(0o750);
  });

  // INF-967's accepted plan: "Quit, continue later" while the move counts, copies or checks
  // leaves nothing changed, and the next launch starts the move again.
  it("stops when asked before its copy is checked, puts the app's own work back, and moves on the next launch", async () => {
    const world = olderFolder();
    mkdirSync(join(world.to, "crewmates", "mine"), { recursive: true });
    for (const phase of ["checking", "copying", "verifying"] as const) {
      const stop = new AbortController();
      const outcome = await runMove(
        world.move,
        {
          ...world.deps,
          signal: stop.signal,
          progress: (progress) => {
            if (progress.phase === phase && progress.done > 0)
              stop.abort(new Error("The move was stopped to continue later."));
          },
        },
        "bring",
      );
      expect(outcome).toEqual({
        kind: "refused",
        refusal: {
          reason: "failed",
          detail: "The move was stopped to continue later.",
          committed: false,
        },
      });
      expect(stagedFolders(world.to)).toEqual([]);
      expect(readdirSync(dirname(world.to)).sort()).toEqual(["firstmate-3000", "infinitary"]);
      expect(existsSync(join(world.to, "crewmates", "mine"))).toBe(true);
      expect(isProfileRetired(world.from)).toBe(false);
      expect(moveLockHeld(moveLockPathFor(world.from))).toBe(false);
    }
    expect(await runMove(world.move, world.deps)).toMatchObject({ kind: "ask" });
    expect(await runMove(world.move, world.deps, "bring")).toMatchObject({ kind: "moved" });
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

  /**
   * INF-295 (found in INF-276): a restart that stops Firstmate 3000's window
   * without a quit leaves its SingletonLock naming the window's process, and
   * after the restart that number may belong to any process, another user's
   * included. Every process a lock written before this computer last started
   * could name ended with that start, so the window is gone and the move goes on.
   */
  it("moves when Firstmate 3000's window lock was left before this computer last started", async () => {
    const world = olderFolder();
    const lock = join(world.from, "SingletonLock");
    const beforeStart = new Date(Date.now() - uptime() * 1000 - 15 * 60 * 1000);
    // The system's first process: running now, and never Firstmate 3000's window.
    expect(processAlive(1)).toBe(true);
    symlinkSync(`${hostname()}-1`, lock);
    lutimesSync(lock, beforeStart, beforeStart);
    expect(await runMove(world.move, world.deps)).toMatchObject({ kind: "moved" });
    expect(isProfileRetired(world.from)).toBe(true);
  });
});

// An installed app keeps its code in app.asar, which Electron's own file reads
// show as a folder; the move's check read it that way and stopped every later
// start of a Mac that runs work (INF-49), and its Node copier fails on it the
// same way. Run inside Electron, both hold the file as a file.
// An archive of one file and one link to it, as electron's asar packs them.
function asarWithLink(): Buffer {
  const json = Buffer.from(
    JSON.stringify({
      files: { "a.txt": { size: 2, offset: "0" }, "b.txt": { link: "a.txt" } },
    }),
  );
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  return Buffer.concat([header, Buffer.from("hi")]);
}

describe("the copy and its check inside Electron", () => {
  it("copy a folder holding an installed app's app.asar, and the check passes on the copy", async () => {
    const inElectron = await bundleForElectron("tests/helpers/folderMoveProcess.ts");
    const folder = scratchDir("infinitary-asar-from-");
    const staged = scratchDir("infinitary-asar-to-");
    const app = join(folder, "work/app/Infinitary.app/Contents/Resources");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, "app.asar"), asarWithLink());
    const copied = inElectron("copy", folder, staged);
    expect(copied.status, copied.stderr).toBe(0);
    expect(
      readFileSync(join(staged, "work/app/Infinitary.app/Contents/Resources/app.asar")),
    ).toEqual(asarWithLink());
    const checked = inElectron("compare", folder, staged);
    expect(checked.status, checked.stderr).toBe(0);
  });
});
