import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "@core/storage/db";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MainDeps, main, parseArgs } from "../scripts/export-tasks.ts";
import * as records from "../scripts/task-records.ts";
import { scratchDir } from "./helpers/scratchDirs";

const direct: MainDeps = { loadRecords: async () => ({ records }) };

/**
 * The export command over real userData directories built with the app's
 * own migrations and writer: export from one, reload into an empty one,
 * and the second exports to the same lines. The command refuses to merge
 * over rows that exist, and says what to do when given nothing to do.
 */

let roots: string[] = [];

function userData(): string {
  const dir = scratchDir("infinitary-export-tasks-");
  roots.push(dir);
  return dir;
}

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function seeded(): string {
  const dir = userData();
  const db = openDatabase(dir);
  const tasks = new TaskService({ db, now: () => 1_000, strict: true });
  seedTask(tasks, {
    id: "aa11",
    title: "Stabilize flaky tests",
    status: "completed",
    outcome: "Green.",
  });
  seedTask(tasks, { id: "bb22", title: "Write the notes", status: "idle" });
  tasks.graph.link("aa11", "bb22", "related", "firstmate");
  db.close();
  return dir;
}

/** The export minus its timestamped header. */
function rows(path: string): string[] {
  return readFileSync(path, "utf8").trim().split("\n").slice(1);
}

describe("export-tasks (task-system P5)", () => {
  it("exports and reloads through main, refuses a second reload, and refuses a run that says nothing to do", async () => {
    const source = seeded();
    const out = join(userData(), "tasks.jsonl");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--out", out, "--user-data", source], direct)).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/^wrote \d+ lines to /);

    const target = userData();
    expect(await main(["--import", out, "--user-data", target], direct)).toBe(0);
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/^imported 2 tasks/);
    expect(await main(["--import", out, "--user-data", target], direct)).toBe(1);
    expect(error.mock.calls.at(-1)?.[0]).toMatch(/Import refused/);

    expect(await main([], direct)).toBe(2);
    expect(error.mock.calls.at(-2)?.[0]).toMatch(/say what to do/);
    expect(await main(["--out", out, "--import", out], direct)).toBe(2);
    expect(await main(["--help"], direct)).toBe(0);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
  });

  it("runs as the plain-Node command pnpm export:tasks invokes, out and back in", () => {
    const source = seeded();
    const out = join(userData(), "cli.jsonl");
    const script = fileURLToPath(new URL("../scripts/export-tasks.ts", import.meta.url));
    const node = (args: string[]) =>
      execFileSync(process.execPath, [script, ...args], { encoding: "utf8", stdio: "pipe" });
    expect(node(["--out", out, "--user-data", source])).toMatch(/^wrote \d+ lines to /);
    const target = userData();
    expect(node(["--import", out, "--user-data", target])).toMatch(/^imported 2 tasks/);
    const again = join(userData(), "cli-again.jsonl");
    node(["--out", again, "--user-data", target]);
    expect(rows(again)).toEqual(rows(out));
  }, 60_000);
});
