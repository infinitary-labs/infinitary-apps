import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { openDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { writeMoveRecord } from "./record";
import { rewriteDatabases } from "./rewrite";

/**
 * INF-416 piece C (finding R8): a folder move rewrites every task's project
 * folder and working copy, and keeps a placed task's conversation file.
 * A home that already moved, and so still names the older folder on that
 * row, is repaired the next time it opens.
 */

type TaskPath = {
  id: string;
  repo_dir: string;
  worktree_dir: string;
  session_file: string | null;
};

function readTasks(dir: string): TaskPath[] {
  const db = openDatabase(dir);
  try {
    return db
      .prepare("SELECT id, repo_dir, worktree_dir, session_file FROM tasks ORDER BY id")
      .all() as TaskPath[];
  } finally {
    db.close();
  }
}

function seedMovedHome(dir: string, from: string, to: string): void {
  const db = openDatabase(dir);
  try {
    const tasks = new TaskService({ db });
    // A task held here: the older move already rewrote all three paths.
    seedTask(tasks, {
      id: "here",
      title: "Here",
      repoDir: join(to, "fleet", "site"),
      worktreeDir: join(to, "worktrees", "here"),
      sessionFile: join(to, "crewmates", "here", "sessions", "pi.jsonl"),
      status: "idle",
    });
    // A task held on another computer. Its project folder and working copy
    // name this Mac, and were left in the older folder. Its conversation
    // file is stored as a path into that same folder: the value a prefix
    // rewrite would change, which must keep naming the other computer's file.
    seedTask(tasks, {
      id: "placed",
      title: "Placed",
      deviceId: "mini",
      repoDir: join(from, "fleet", "site"),
      worktreeDir: join(from, "worktrees", "placed"),
      sessionFile: join(from, "crewmates", "placed", "sessions", "pi.jsonl"),
      status: "idle",
    });
  } finally {
    db.close();
  }
}

describe("the folder move's rewrite of a task's folders", () => {
  it("rewrites a placed task's project folder and working copy, and keeps its conversation file", () => {
    const from = scratchDir("infinitary-rewrite-from-");
    const staged = scratchDir("infinitary-rewrite-staged-");
    const to = join(scratchDir("infinitary-rewrite-to-"), "home");
    seedMovedHome(staged, from, from);
    rewriteDatabases(staged, [from], to);

    expect(readTasks(staged)).toEqual([
      {
        id: "here",
        repo_dir: join(to, "fleet", "site"),
        worktree_dir: join(to, "worktrees", "here"),
        session_file: join(to, "crewmates", "here", "sessions", "pi.jsonl"),
      },
      {
        id: "placed",
        repo_dir: join(to, "fleet", "site"),
        worktree_dir: join(to, "worktrees", "placed"),
        session_file: join(from, "crewmates", "placed", "sessions", "pi.jsonl"),
      },
    ]);
  });

  it("repairs a home that already moved, and leaves a folder the person kept", () => {
    const from = scratchDir("infinitary-rewrite-older-");
    const kept = scratchDir("infinitary-rewrite-kept-");
    const home = scratchDir("infinitary-rewrite-home-");
    seedMovedHome(home, from, home);
    seedMovedHome(kept, from, kept);
    const at = "2026-08-01T00:00:00.000Z";
    writeMoveRecord(home, { schemaVersion: 1, state: "done", from, to: home, at });
    writeMoveRecord(kept, { schemaVersion: 1, state: "kept-own", from, to: kept, at });

    const repaired = [
      {
        id: "here",
        repo_dir: join(home, "fleet", "site"),
        worktree_dir: join(home, "worktrees", "here"),
        session_file: join(home, "crewmates", "here", "sessions", "pi.jsonl"),
      },
      {
        id: "placed",
        repo_dir: join(home, "fleet", "site"),
        worktree_dir: join(home, "worktrees", "placed"),
        session_file: join(from, "crewmates", "placed", "sessions", "pi.jsonl"),
      },
    ];
    expect(readTasks(home)).toEqual(repaired);
    // Opening again changes nothing: the rewrite matches no path twice.
    expect(readTasks(home)).toEqual(repaired);
    expect(readTasks(kept)).toEqual([
      {
        id: "here",
        repo_dir: join(kept, "fleet", "site"),
        worktree_dir: join(kept, "worktrees", "here"),
        session_file: join(kept, "crewmates", "here", "sessions", "pi.jsonl"),
      },
      {
        id: "placed",
        repo_dir: join(from, "fleet", "site"),
        worktree_dir: join(from, "worktrees", "placed"),
        session_file: join(from, "crewmates", "placed", "sessions", "pi.jsonl"),
      },
    ]);
  });
});
