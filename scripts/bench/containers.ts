/**
 * Task containers on Apple container (`container` 1.4.1): every DeepSWE
 * image is linux/amd64 and runs under Rosetta, offline (`--network none`,
 * the tasks' `no-network` mode), with the task's own CPU and memory.
 *
 * Each task container takes 2 CPUs and 8 GB, so at most three run at once,
 * counted across every process that uses this tooling: a start takes a short
 * mutex, counts the running containers carrying the bench label, and waits
 * for a free slot before starting its own.
 */

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { withLock } from "./lock.ts";
import { type BenchTask, benchDir, freeDiskGb } from "./pool.ts";

export const BENCH_LABEL = "infinitary-bench";
export const MAX_TASK_CONTAINERS = 3;
const PLATFORM = "linux/amd64";

export type Mount = { host: string; container: string };

export type ContainerResult = { code: number; stdout: string; stderr: string };

export function containerCli(args: string[], input?: string | Buffer): ContainerResult {
  const result = spawnSync("container", args, {
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function must(args: string[], input?: string | Buffer): string {
  const result = containerCli(args, input);
  if (result.code !== 0) {
    throw new Error(`container ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

type ContainerRow = {
  id: string;
  status: { state: string };
  configuration: { labels?: Record<string, string> };
};

export function benchContainers(): { id: string; state: string; role: string }[] {
  const rows = JSON.parse(must(["ls", "--all", "--format", "json"])) as ContainerRow[];
  return rows
    .filter((row) => row.configuration.labels?.[BENCH_LABEL] !== undefined)
    .map((row) => ({
      id: row.id,
      state: row.status.state,
      role: row.configuration.labels?.[BENCH_LABEL] ?? "",
    }));
}

export function containerState(id: string): string | null {
  return benchContainers().find((row) => row.id === id)?.state ?? null;
}

/**
 * Starts `image` detached as container `name` (idle on `sleep infinity`,
 * work arrives through `exec`), once fewer than `MAX_TASK_CONTAINERS` bench
 * containers are running. `role` labels what the container is for.
 */
export async function startTaskContainer(opts: {
  name: string;
  task: BenchTask;
  role: "verifier" | "bridge" | "export";
  mounts?: Mount[];
  onWait?: () => void;
}): Promise<void> {
  const { task } = opts;
  let told = false;
  for (;;) {
    const started = await withLock(join(benchDir(), "locks", "start"), () => {
      const running = benchContainers().filter((row) => row.state === "running");
      if (running.length >= MAX_TASK_CONTAINERS) return false;
      const args = [
        "run",
        "--detach",
        "--name",
        opts.name,
        "--label",
        `${BENCH_LABEL}=${opts.role}`,
        "--label",
        `infinitary-bench-task=${task.id}`,
        "--platform",
        PLATFORM,
        "--network",
        "none",
        "--cpus",
        String(task.verifier.cpus),
        "--memory",
        `${task.verifier.memoryMb}M`,
      ];
      for (const mount of opts.mounts ?? [])
        args.push("--volume", `${mount.host}:${mount.container}`);
      args.push(task.image, "sleep", "infinity");
      must(args);
      return true;
    });
    if (started) return;
    if (!told) opts.onWait?.();
    told = true;
    await sleep(5_000);
  }
}

export function removeContainer(name: string): void {
  containerCli(["delete", "--force", name]);
}

export type ExecResult = { code: number; timedOut: boolean; wallSeconds: number };

/**
 * Runs `argv` inside a running container, feeding `input` on stdin and
 * streaming output to the given sinks. A `timeoutSec` stops the container's
 * process by removing the container (Apple container has no exec kill).
 */
export function execIn(opts: {
  name: string;
  argv: string[];
  workdir?: string;
  input?: Buffer;
  timeoutSec?: number;
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
}): Promise<ExecResult> {
  const args = ["exec"];
  if (opts.input) args.push("--interactive");
  if (opts.workdir) args.push("--workdir", opts.workdir);
  args.push(opts.name, ...opts.argv);
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn("container", args, { stdio: ["pipe", "pipe", "pipe"] });
    let timedOut = false;
    const timer =
      opts.timeoutSec === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            removeContainer(opts.name);
            child.kill("SIGTERM");
          }, opts.timeoutSec * 1000);
    child.stdout.on("data", (chunk: Buffer) => opts.stdout?.(chunk));
    child.stderr.on("data", (chunk: Buffer) => opts.stderr?.(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        code: code ?? 1,
        timedOut,
        wallSeconds: (Date.now() - started) / 1000,
      });
    });
    child.stdin.end(opts.input ?? undefined);
  });
}

export function localImages(): Set<string> {
  const rows = JSON.parse(must(["image", "ls", "--format", "json"])) as {
    configuration: { name: string };
  }[];
  return new Set(rows.map((row) => row.configuration.name));
}

/** Free disk the pool never pulls below; an image unpacks to about 4.5 GB. */
export const DISK_FLOOR_GB = 100;

/** A pull refused at the free-disk floor: the sweep stops rather than record a failure. */
export class DiskFloorError extends Error {}

/** A registry answer that clears on its own: the public ECR rate limit, a 5xx. */
export function isTransientPullError(message: string): boolean {
  return /\b429\b|Too Many Requests|TOOMANYREQUESTS|\b50[234]\b|timed out|connection reset/i.test(
    message,
  );
}

const PULL_TRIES = 5;

/**
 * Pulls the task's image, waiting out the registry's rate limit (30 s, 60 s,
 * ... between tries). Asynchronous on purpose: a pull takes seconds to
 * minutes, and a blocked event loop would stall the output pipes (and so the
 * timing) of the verifiers running beside it.
 */
export async function pullImage(
  task: BenchTask,
  floorGb = DISK_FLOOR_GB,
): Promise<{ seconds: number }> {
  const free = freeDiskGb();
  if (free < floorGb + 5) {
    throw new DiskFloorError(
      `refusing to pull ${task.id}: ${free.toFixed(0)} GB free, floor ${floorGb} GB`,
    );
  }
  const started = Date.now();
  const args = ["image", "pull", "--progress", "none", "--platform", PLATFORM, task.image];
  for (let attempt = 1; ; attempt++) {
    const { code, stderr } = await runAsync(args);
    if (code === 0) return { seconds: (Date.now() - started) / 1000 };
    const message = `container ${args.join(" ")} failed: ${stderr.trim()}`;
    if (attempt >= PULL_TRIES || !isTransientPullError(stderr)) throw new Error(message);
    await sleep(30_000 * attempt);
  }
}

function runAsync(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("container", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stderr }));
  });
}

export function deleteImage(task: BenchTask): void {
  must(["image", "delete", "--force", task.image]);
}
