/**
 * The DeepSWE task pool (benchmark step S0): the task repository pinned at
 * one commit, an index of its 113 tasks read from each `task.toml`, and the
 * task images on Apple container.
 *
 * Benchmark tooling, never product code: nothing here is imported by `src/`
 * and nothing ships in the app. The pool lives in `INFINITARY_BENCH_DIR`
 * (default `<repo>/.bench`, git-ignored).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { settingFrom } from "../../src/shared/envSettings.ts";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Datacurve's DeepSWE task repository, pinned so every run grades the same tasks. */
export const DEEPSWE_REPO = "https://github.com/datacurve-ai/deep-swe.git";
export const DEEPSWE_COMMIT = "0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea";
export const DEEPSWE_TASK_COUNT = 113;

export function benchDir(): string {
  return resolve(settingFrom(process.env, "BENCH_DIR") ?? join(REPO_ROOT, ".bench"));
}

export function taskRepoDir(): string {
  return join(benchDir(), "deep-swe");
}

export type BenchTask = {
  id: string;
  /** The task folder: `instruction.md`, `task.toml`, `tests/`, `environment/`. */
  dir: string;
  image: string;
  baseCommit: string;
  repositoryUrl: string;
  language: string;
  category: string;
  verifier: { timeoutSec: number; cpus: number; memoryMb: number };
};

/**
 * Reads every `tasks/<id>/task.toml` under `tasksDir` through Python's
 * tomllib (the real TOML reader; this repository carries none) and returns
 * the typed index, sorted by id.
 */
export function readTasks(tasksDir: string): BenchTask[] {
  const script = [
    "import json, os, sys, tomllib",
    "root = sys.argv[1]",
    "out = {}",
    "for name in sorted(os.listdir(root)):",
    "    path = os.path.join(root, name, 'task.toml')",
    "    if os.path.isfile(path):",
    "        with open(path, 'rb') as f: out[name] = tomllib.load(f)",
    "json.dump(out, sys.stdout)",
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, tasksDir], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`reading task.toml files failed: ${result.stderr || result.error?.message}`);
  }
  const raw = JSON.parse(result.stdout) as Record<string, TaskToml>;
  return Object.entries(raw).map(([name, toml]) => toTask(join(tasksDir, name), name, toml));
}

type TaskToml = {
  metadata?: {
    task_id?: string;
    base_commit_hash?: string;
    repository_url?: string;
    language?: string;
    category?: string;
  };
  environment?: { docker_image?: string };
  verifier?: { timeout_sec?: number; environment?: { cpus?: number; memory_mb?: number } };
};

function toTask(dir: string, name: string, toml: TaskToml): BenchTask {
  const need = <T>(value: T | undefined, key: string): T => {
    if (value === undefined) throw new Error(`${name}/task.toml has no ${key}`);
    return value;
  };
  const id = need(toml.metadata?.task_id, "metadata.task_id");
  if (id !== name) throw new Error(`${name}/task.toml names task ${id}`);
  return {
    id,
    dir,
    image: need(toml.environment?.docker_image, "environment.docker_image"),
    baseCommit: need(toml.metadata?.base_commit_hash, "metadata.base_commit_hash"),
    repositoryUrl: need(toml.metadata?.repository_url, "metadata.repository_url"),
    language: need(toml.metadata?.language, "metadata.language"),
    category: need(toml.metadata?.category, "metadata.category"),
    verifier: {
      timeoutSec: need(toml.verifier?.timeout_sec, "verifier.timeout_sec"),
      cpus: need(toml.verifier?.environment?.cpus, "verifier.environment.cpus"),
      memoryMb: need(toml.verifier?.environment?.memory_mb, "verifier.environment.memory_mb"),
    },
  };
}

/** Clones (or re-pins) the task repository at `DEEPSWE_COMMIT` and checks the pool is whole. */
export function syncPool(): BenchTask[] {
  const dir = taskRepoDir();
  mkdirSync(benchDir(), { recursive: true });
  if (!existsSync(join(dir, ".git"))) git(benchDir(), ["clone", "--quiet", DEEPSWE_REPO, dir]);
  const head = git(dir, ["rev-parse", "HEAD"]).trim();
  if (head !== DEEPSWE_COMMIT) {
    git(dir, ["fetch", "--quiet", "origin"]);
    git(dir, ["checkout", "--quiet", "--detach", DEEPSWE_COMMIT]);
  }
  const tasks = loadPool();
  const manifest = JSON.parse(readFileSync(join(dir, "tasks", "manifest.json"), "utf8")) as {
    tasks: { task_id: string }[];
  };
  const listed = new Set(manifest.tasks.map((task) => task.task_id));
  const missing = [...listed].filter((id) => !tasks.some((task) => task.id === id));
  if (tasks.length !== DEEPSWE_TASK_COUNT || missing.length > 0 || listed.size !== tasks.length) {
    throw new Error(
      `pool is not whole: ${tasks.length} task folders, ${listed.size} in the manifest, missing ${missing.join(", ") || "none"}`,
    );
  }
  return tasks;
}

let cached: BenchTask[] | undefined;

export function loadPool(): BenchTask[] {
  if (!cached) {
    const tasksDir = join(taskRepoDir(), "tasks");
    if (!existsSync(tasksDir)) throw new Error(`no pool at ${tasksDir}: run \`bench pool sync\``);
    cached = readTasks(tasksDir);
  }
  return cached;
}

export function taskById(id: string): BenchTask {
  const task = loadPool().find((candidate) => candidate.id === id);
  if (!task) throw new Error(`no DeepSWE task named ${id}`);
  return task;
}

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export function freeDiskGb(path = benchDir()): number {
  const stats = statfsSync(existsSync(path) ? path : REPO_ROOT);
  return (stats.bavail * stats.bsize) / 1024 ** 3;
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
