/**
 * The task record as JSONL, out and back in (task-system P5, design
 * section 12: "JSONL export"; acceptance: export then reload reproduces
 * the data).
 *
 * The record is the five tables the task system owns - projects, tasks,
 * timeline events, links, captain asks - and the export is those rows
 * verbatim (`src/core/tasks/taskExport.ts`). Session JSONL is not part of
 * it: sessions stay where they are under `crewmates/<id>/sessions`,
 * durable by captain decision D2, and `pnpm measure:sessions` sizes them.
 *
 * Export reads through the same `TaskService` the app uses and writes one
 * file. Import runs the writer's `importRecords`: one transaction, refused
 * before anything is written when a row already exists - so it reloads an
 * export into a fresh userData, or back into one whose tasks were purged,
 * and never merges over live rows. Run an import with the app closed.
 *
 * Run it (Node 24 strips the types; the core loads through Vite, because
 * its imports are aliased and extensionless - `scripts/moduleRunner.ts`):
 *   pnpm export:tasks --out tasks.jsonl
 *   pnpm export:tasks --user-data /path/to/userData --out tasks.jsonl
 *   pnpm export:tasks --import tasks.jsonl --user-data /path/to/fresh/userData
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultUserDataDir } from "./extract-dispatch-corpus.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import type * as TaskRecords from "./task-records.ts";

export type TaskRecordsModule = typeof TaskRecords;

export type CliArgs = {
  userDataDir: string;
  out: string | null;
  importPath: string | null;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    userDataDir: defaultUserDataDir(),
    out: null,
    importPath: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--user-data") args.userDataDir = next();
    else if (arg === "--out") args.out = next();
    else if (arg === "--import") args.importPath = next();
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && !args.out && !args.importPath) {
    throw new Error("say what to do: --out <file> to export, --import <file> to reload");
  }
  if (args.out && args.importPath) throw new Error("--out and --import are two runs, not one");
  return args;
}

const USAGE = `export-tasks: the task record as JSONL, out and back in

  --out <file>          export the record (projects, tasks, events, links, asks) to this file
  --import <file>       reload an export into the userData (app closed; refuses to overwrite rows)
  --user-data <dir>     the app's userData (default: this machine's)
`;

export type MainDeps = {
  /** The record operations, and what releases them afterwards. */
  loadRecords: () => Promise<{ records: TaskRecordsModule; close?: () => Promise<void> }>;
};

/** The CLI's own loader: the core through a Vite module runner. */
export async function loadRecordsThroughVite(): ReturnType<MainDeps["loadRecords"]> {
  const runner = await openModuleRunner();
  try {
    const records = await runner.import<TaskRecordsModule>(
      join(REPO_ROOT, "scripts", "task-records.ts"),
    );
    return { records, close: runner.close };
  } catch (caught) {
    await runner.close();
    throw caught;
  }
}

export async function main(
  argv: string[],
  deps: MainDeps = { loadRecords: loadRecordsThroughVite },
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const { records, close } = await deps.loadRecords();
  try {
    if (args.out) {
      const out = resolve(args.out);
      const lines = records.exportToFile(args.userDataDir, out);
      console.log(`wrote ${lines} lines to ${out}`);
      return 0;
    }
    const written = records.importFromFile(args.userDataDir, resolve(args.importPath as string));
    console.log(
      `imported ${written.tasks} tasks, ${written.events} events, ${written.links} links, ${written.asks} asks, ${written.projects} new projects into ${resolve(args.userDataDir)}`,
    );
    return 0;
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    return 1;
  } finally {
    await close?.();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (caught: unknown) => {
      console.error(caught instanceof Error ? (caught.stack ?? caught.message) : String(caught));
      process.exitCode = 1;
    },
  );
}
