import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "@core/storage/db";
import { describe, expect, it } from "vitest";
import { extractDispatchCorpus } from "../scripts/extract-dispatch-corpus.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The corpus and replay tools run as plain Node commands, which only strip
 * types: an import of a type without `type`, or syntax Node cannot strip,
 * fails there, while Vitest's transform drops it and the lint skips these
 * scripts. INF-2625's plan asks for this guardrail before the dispatch
 * extractor is split into parts, since every command below loads it.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPLAY_FIXTURES = join(ROOT, "tests/fixtures/replay");

/** The package scripts that load the dispatch extractor, by their names in package.json. */
const COMMANDS = [
  "extract:dispatch",
  "extract:supervision",
  "export:corpus",
  "derive:misses",
  "derive:duplicates",
  "replay:captain",
  "export:tasks",
  "eval:accounts",
  "check:account-models",
  "measure:sessions",
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse("2026-09-01T00:00:00.000Z");

/**
 * A tables dump of `tasks` tasks, each with two same-titled cards a minute
 * apart: one weak duplicate candidate per task.
 */
function repeatedCards(dir: string, tasks: number): string {
  const path = join(dir, "tables.json");
  const ids = Array.from({ length: tasks }, (_, i) => i);
  writeFileSync(
    path,
    JSON.stringify({
      tasks: ids.map((i) => ({ id: `t-${i}`, title: `Task ${i}` })),
      cards: ids.flatMap((i) =>
        [0, MINUTE].map((offset, n) => ({
          id: `card-${i}-${n}`,
          task_id: `t-${i}`,
          kind: "note",
          title: `Delivered keeps its worktree ${i}`,
          body: `<p>Delivered keeps its worktree ${i}</p>`,
          actions_json: "[]",
          created_at: T0 + i * HOUR + offset,
          resolved_at: null,
          chosen_action: null,
        })),
      ),
    }),
  );
  return path;
}

/**
 * A database built with the app's own migrations holding, for each of
 * `tasks` tasks, a routine verdict and a captain verdict an hour later: one
 * weak miss candidate per task.
 */
function laterEscalations(dir: string, tasks: number): string {
  const db = openDatabase(dir);
  const insert = db.prepare(
    "INSERT INTO decisions (kind, task_id, wake, verdict, summary, at) VALUES ('sort', ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < tasks; i += 1) {
    const task = `t-${i}`;
    insert.run(
      task,
      `[fm-op] crewmate 1 reported on task ${task} "Task ${i}": CI is red.`,
      "routine",
      "CI is still running.",
      T0 + i,
    );
    insert.run(
      task,
      `[fm-op] crewmate 1 reported on task ${task} "Task ${i}": merge conflict.`,
      "captain",
      "The PR is stuck on a merge conflict.",
      T0 + HOUR + i,
    );
  }
  db.close();
  return join(dir, "firstmate.db");
}

/** The commands that write JSONL to stdout without --out, and what each reads. */
const PIPED: Array<[name: string, inputs: (dir: string) => string[]]> = [
  [
    "extract:dispatch",
    (dir) => [
      "--user-data",
      dir,
      "--sessions",
      join(REPLAY_FIXTURES, "sep04-real/firstmate/sessions"),
      "--claude-sessions",
      join(REPLAY_FIXTURES, "sep26-claude/firstmate/claude"),
    ],
  ],
  [
    "extract:supervision",
    (dir) => [
      "--user-data",
      dir,
      "--supervision-sessions",
      join(REPLAY_FIXTURES, "sep14-real/supervision/sessions"),
    ],
  ],
  ["derive:duplicates", (dir) => ["--db", repeatedCards(dir, 400)]],
  ["derive:misses", (dir) => ["--db", laterEscalations(dir, 400)]],
];

/** The file a package script runs with plain Node, read from package.json. */
function scriptFile(name: string): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const command = pkg.scripts[name] ?? "";
  const file = /^node (scripts\/\S+\.ts)$/.exec(command)?.[1];
  if (!file) throw new Error(`package.json's ${name} is not a plain Node script: ${command}`);
  return join(ROOT, file);
}

function node(file: string, args: string[]) {
  return spawnSync(process.execPath, [file, ...args], { cwd: ROOT, encoding: "utf8" });
}

describe("the corpus and replay commands under plain Node", () => {
  it.each(COMMANDS)("%s loads and prints its usage", (name) => {
    const run = node(scriptFile(name), ["--help"]);
    expect(run.stderr).not.toMatch(/SyntaxError|ERR_|Cannot find/);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).not.toBe("");
  });

  it("extracts recorded sessions of both seats exactly as the extractor does in process", () => {
    const userData = scratchDir("infinitary-corpus-node-");
    const out = join(userData, "corpus.jsonl");
    const sessionsDir = join(REPLAY_FIXTURES, "sep04-real/firstmate/sessions");
    const claudeSessionsDir = join(REPLAY_FIXTURES, "sep26-claude/firstmate/claude");
    execFileSync(
      process.execPath,
      [
        scriptFile("extract:dispatch"),
        "--user-data",
        userData,
        "--sessions",
        sessionsDir,
        "--claude-sessions",
        claudeSessionsDir,
        "--out",
        out,
      ],
      { cwd: ROOT, stdio: "pipe" },
    );
    const inProcess = extractDispatchCorpus({
      sessionFiles: [],
      sessionsDir,
      claudeSessionsDir,
      dbPath: join(userData, "firstmate.db"),
      includeOps: true,
    });
    expect(inProcess.sources).toHaveLength(2);
    expect(inProcess.records.length).toBeGreaterThan(0);
    expect(readFileSync(out, "utf8")).toBe(
      `${inProcess.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
  });

  it.each(PIPED)(
    "%s writes every record to a pipe, the same bytes as its --out file",
    (name, inputsOf) => {
      const dir = scratchDir("infinitary-corpus-pipe-");
      const out = join(dir, "out.jsonl");
      const inputs = inputsOf(dir);
      const run = (extra: string[]) =>
        spawnSync(process.execPath, [scriptFile(name), ...inputs, ...extra], { cwd: ROOT });
      expect(run(["--out", out]).status).toBe(0);
      const piped = run([]);
      expect(piped.status).toBe(0);
      const file = readFileSync(out);
      // More than a pipe takes at once, so a command that exits before its
      // reader has taken the rest loses the tail.
      expect(file.length).toBeGreaterThan(128 * 1024);
      expect(piped.stdout.length).toBe(file.length);
      expect(piped.stdout.equals(file)).toBe(true);
    },
  );

  it("refuses an argument it does not know, naming it", () => {
    const run = node(scriptFile("extract:dispatch"), ["--nope"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Unknown argument: --nope");
  });
});
