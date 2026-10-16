/**
 * Infinitary benchmark tooling, step S0: the DeepSWE task pool on Apple
 * container, the verifier runner, the bridge and the mirror script. See
 * scripts/bench/README.md for the interface the driver (S1) consumes.
 *
 * Run it (Node 24 strips the types):
 *   node scripts/bench/bench.ts pool sync
 *   node scripts/bench/bench.ts verify <task> --worktree <dir>
 *   node scripts/bench/bench.ts bridge <task> --worktree <dir> -- <command>
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInBridge, stopBridge } from "./bridge.ts";
import { benchContainers, localImages, MAX_TASK_CONTAINERS, pullImage } from "./containers.ts";
import { refPatch, worktreePatch } from "./patch.ts";
import { benchDir, loadPool, REPO_ROOT, syncPool, taskById, writeJson } from "./pool.ts";
import { checkoutTask, openMirror } from "./repos.ts";
import { summarize, sweepEmptyPatches } from "./sweep.ts";
import { runVerifier } from "./verifierRunner.ts";

const USAGE = `usage: node scripts/bench/bench.ts <command>

  pool sync                          clone DeepSWE at the pinned commit; check all 113 tasks
  pool list [--json]                 the task index (id, language, image, base commit)
  pool pull <task>...                cache task images (refuses below the free-disk floor)
  pool checkout <task> <dest>        the task's repository at its base commit, from the image
  verify <task> (--empty | --patch <file|-> | --worktree <dir> | --repo <dir> --ref <ref>) [--out <dir>]
                                     grade with the task's own verifier; prints the result JSON
                                     (exit 0 graded, 3 the verifier failed, 1 error, 2 usage)
  sweep [--concurrency N] [--keep-images] [--tasks a,b]
                                     time every verifier on the empty patch (resumable)
  bridge <task> [--worktree <dir>] [--timeout <s>] -- <command>
                                     apply the worktree's patch (default: the current directory's)
                                     in the task container's /app and run the command there
  bridge stop <task> [--worktree <dir>]
                                     remove that worktree's task container
  mirror <task> [--owner <login>]    open the task's private GitHub mirror (Careful arm)
  containers                         the task containers this tooling runs
`;

/** `verify` exit code when the verifier itself failed (timeout, no reward): an infrastructure failure, not a grade. */
const VERIFIER_FAILED = 3;

function log(line: string): void {
  process.stderr.write(`[bench] ${line}\n`);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  args.splice(index, 2);
  return value;
}

function boolFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "pool":
      return pool(rest);
    case "verify":
      return verify(rest);
    case "sweep":
      return sweep(rest);
    case "bridge":
      return bridge(rest);
    case "mirror": {
      const owner = flag(rest, "--owner");
      const [id] = rest;
      if (!id) throw new Error("mirror needs a task");
      process.stdout.write(`${JSON.stringify(await openMirror(taskById(id), owner), null, 2)}\n`);
      return 0;
    }
    case "containers":
      process.stdout.write(`${JSON.stringify(benchContainers(), null, 2)}\n`);
      return 0;
    default:
      process.stderr.write(USAGE);
      return command === "--help" || command === "-h" ? 0 : 2;
  }
}

async function pool(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "sync") {
    const tasks = syncPool();
    log(`${tasks.length} tasks at ${join(benchDir(), "deep-swe")}`);
    return 0;
  }
  if (sub === "list") {
    const tasks = loadPool();
    if (boolFlag(rest, "--json")) {
      process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
    } else {
      const cached = localImages();
      const lines = tasks.map(
        (task) =>
          `${task.id}\t${task.language}\t${task.category}\t${cached.has(task.image) ? "cached" : "-"}\n`,
      );
      process.stdout.write(lines.join(""));
    }
    return 0;
  }
  if (sub === "pull") {
    for (const id of rest) {
      const task = taskById(id);
      const { seconds } = await pullImage(task);
      log(`${id}: pulled in ${seconds.toFixed(0)} s`);
    }
    return 0;
  }
  if (sub === "checkout") {
    const [id, dest] = rest;
    if (!id || !dest) throw new Error("pool checkout needs <task> <dest>");
    process.stdout.write(`${await checkoutTask(taskById(id), dest)}\n`);
    return 0;
  }
  process.stderr.write(USAGE);
  return 2;
}

async function verify(args: string[]): Promise<number> {
  const patchFile = flag(args, "--patch");
  const worktree = flag(args, "--worktree");
  const repo = flag(args, "--repo");
  const ref = flag(args, "--ref");
  const out = flag(args, "--out");
  const empty = boolFlag(args, "--empty");
  const [id] = args;
  if (!id) throw new Error("verify needs a task");
  const task = taskById(id);
  const sources = [patchFile, worktree, repo, empty ? "empty" : undefined].filter(Boolean);
  if (sources.length !== 1 || Boolean(repo) !== Boolean(ref)) {
    throw new Error("verify takes exactly one of --empty, --patch, --worktree, --repo with --ref");
  }
  const patch = empty
    ? Buffer.alloc(0)
    : patchFile
      ? readFileSync(patchFile === "-" ? 0 : patchFile)
      : worktree
        ? worktreePatch(worktree, task.baseCommit)
        : refPatch(repo as string, task.baseCommit, ref as string);
  const result = await runVerifier(task, patch, {
    logsDir: out,
    onWait: () => log(`waiting for a container slot (${MAX_TASK_CONTAINERS} running)`),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.reward < 0 ? VERIFIER_FAILED : 0;
}

async function sweep(args: string[]): Promise<number> {
  const concurrency = Number(flag(args, "--concurrency") ?? "2");
  const only = flag(args, "--tasks")?.split(",");
  const keepImages = boolFlag(args, "--keep-images");
  const rowsPath = join(benchDir(), "empty-patch-sweep.jsonl");
  const tasks = only ? only.map(taskById) : loadPool();
  const rows = await sweepEmptyPatches({ tasks, rowsPath, concurrency, keepImages, log });
  const summaryPath = join(REPO_ROOT, "scripts", "bench", "data", "empty-patch-sweep.json");
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeJson(summaryPath, summarize(rows, hostDescription()));
  log(`${rows.length} rows; summary at ${summaryPath}`);
  return rows.some((row) => row.failure !== null) ? VERIFIER_FAILED : 0;
}

/** The machine and runtime a sweep ran on, for the committed table. */
function hostDescription(): string {
  const read = (command: string, args: string[]) =>
    spawnSync(command, args, { encoding: "utf8" }).stdout?.trim() ?? "";
  const chip = read("sysctl", ["-n", "machdep.cpu.brand_string"]);
  const model = read("sysctl", ["-n", "hw.model"]);
  const cores = read("sysctl", ["-n", "hw.ncpu"]);
  const memoryGb = Math.round(Number(read("sysctl", ["-n", "hw.memsize"])) / 1024 ** 3);
  const runtime = `Apple container ${read("container", ["--version"]).match(/version (\S+)/)?.[1] ?? "?"}`;
  return `${model} (${chip}, ${cores} cores, ${memoryGb} GB), macOS ${read("sw_vers", ["-productVersion"])}, ${runtime}`;
}

async function bridge(args: string[]): Promise<number> {
  const split = args.indexOf("--");
  const head = split === -1 ? args : args.slice(0, split);
  const commandWords = split === -1 ? [] : args.slice(split + 1);
  // A crewmate calls the bridge from its own working copy, so that is the default.
  const worktree = flag(head, "--worktree") ?? process.cwd();
  const timeout = flag(head, "--timeout");
  if (head[0] === "stop") {
    const [, id] = head;
    if (!id) throw new Error("bridge stop needs a task");
    log(stopBridge(taskById(id), worktree) ? "stopped" : "no container");
    return 0;
  }
  const [id] = head;
  if (!id || commandWords.length === 0) throw new Error("bridge needs <task> ... -- <command>");
  const result = await runInBridge({
    task: taskById(id),
    worktree,
    command: commandWords.join(" "),
    timeoutSec: timeout === undefined ? undefined : Number(timeout),
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    onWait: () => log(`waiting for a container slot (${MAX_TASK_CONTAINERS} running)`),
  });
  if (result.timedOut) log(`timed out after ${timeout} s; the container was removed`);
  return result.code;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`[bench] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
