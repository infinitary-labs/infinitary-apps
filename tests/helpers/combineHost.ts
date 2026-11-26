import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BatchChange } from "../../src/shared/batches";
import { scratchDir } from "./scratchDirs";

/**
 * The project the combine's tests run real git on (src/core/batches/combine.test.ts
 * and combine.held.test.ts): where it lives, its folder at home and a
 * crewmate's working copy, and the approved changes pushed to it.
 */

export const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
    .toString()
    .trim();

export type Host = {
  /** The project where it lives: a bare repository. */
  bare: string;
  /** The project's folder at home, where the combine runs. */
  home: string;
  /** A crewmate's working copy, where branches are written and pushed. */
  work: string;
};

/** A small project where it lives, its folder at home and a working copy, with one commit on main. */
export function host(): Host {
  const root = scratchDir("infinitary-batch-combine-");
  const bare = join(root, "meter.git");
  const home = join(root, "home");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", bare], { stdio: "pipe" });
  execFileSync("git", ["clone", bare, work], { stdio: "pipe" });
  run(work, "config", "user.name", "Ada Crew");
  run(work, "config", "user.email", "ada@example.com");
  write(work, "src/parser.ts", "export const parse = (text: string) => new Date(text);\n");
  write(work, "src/report.ts", "export const rows = ['date', 'total'];\n");
  run(work, "add", "-A");
  run(work, "commit", "-m", "chore: start the meter");
  run(work, "push", "origin", "HEAD:refs/heads/main");
  execFileSync("git", ["clone", bare, home], { stdio: "pipe" });
  return { bare, home, work };
}

export function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** Push a branch with one commit that writes `files`, started from `from`, and answer it as an approved change. */
export function change(
  at: Host,
  input: {
    taskId: string;
    title: string;
    body?: string;
    files: Record<string, string>;
    from?: string;
    approvedAt: number;
    author?: string;
  },
): BatchChange {
  const branch = `fm/${input.taskId}`;
  run(at.work, "fetch", "--quiet", "origin");
  run(at.work, "checkout", "--quiet", "-B", branch, input.from ?? "origin/main");
  for (const [path, text] of Object.entries(input.files)) write(at.work, path, text);
  run(at.work, "add", "-A");
  run(
    at.work,
    "-c",
    `user.name=${input.author ?? "Ada Crew"}`,
    "commit",
    "-m",
    `wip: ${input.taskId}`,
  );
  run(at.work, "push", "--force", "origin", `HEAD:refs/heads/${branch}`);
  return {
    taskId: input.taskId,
    branch,
    head: run(at.work, "rev-parse", "HEAD"),
    title: input.title,
    body: input.body ?? "",
    at: input.approvedAt,
  };
}

export const PARSER = {
  taskId: "task-parser",
  title: "fix(parser): read dates with a time zone",
  body: "- Dates with a time zone are read as written.\n\nBREAKING CHANGE: a date without a zone is read as UTC.",
  files: {
    "src/parser.ts": "export const parse = (text: string) => new Date(text.concat('Z'));\n",
  },
  approvedAt: 1_000,
};

export const AT = Date.UTC(2026, 10, 11, 18, 30);
