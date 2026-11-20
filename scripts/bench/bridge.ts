/**
 * The bridge: runs a command against a crewmate's worktree inside the
 * task's own container, so what the crewmate builds and tests is what the
 * verifier grades.
 *
 * One long-lived container per (task, worktree), started on first use from
 * the task image (offline, the task's CPU and memory). Every call takes the
 * worktree's patch against the base commit (`worktreePatch`, the same patch
 * the verifier runner grades), resets `/app` to the base commit, applies the
 * patch and runs the command in `/app`. Ignored files (installed
 * dependencies, build caches) survive between calls; tracked and untracked
 * files always match the worktree. Calls on one container run one at a time.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { containerState, execIn, removeContainer, startTaskContainer } from "./containers.ts";
import { withLock } from "./lock.ts";
import { worktreePatch } from "./patch.ts";
import { type BenchTask, benchDir } from "./pool.ts";

/** Exit code when the worktree's patch does not apply to the task image. */
export const PATCH_REFUSED = 125;

export function bridgeContainerName(task: BenchTask, worktree: string): string {
  const key = `${task.id}\n${realpathSync(worktree)}`;
  return `fmb-b-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

// Reset, clean (keeping ignored files) and apply, all inside the container.
const APPLY = [
  "set -e",
  "cat > /tmp/infinitary-bench.patch",
  "cd /app",
  'g() { git -c safe.directory=/app "$@"; }',
  'g reset --quiet --hard "$1"',
  "g clean --force -d --quiet",
  "if [ -s /tmp/infinitary-bench.patch ]; then",
  `  g apply --whitespace=nowarn /tmp/infinitary-bench.patch || { echo "[bench bridge] the worktree's patch does not apply to the task image" >&2; exit ${PATCH_REFUSED}; }`,
  "fi",
].join("\n");

export async function runInBridge(opts: {
  task: BenchTask;
  worktree: string;
  command: string;
  timeoutSec?: number;
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
  onWait?: () => void;
}): Promise<{ code: number; timedOut: boolean }> {
  const { task } = opts;
  const name = bridgeContainerName(task, opts.worktree);
  const patch = worktreePatch(opts.worktree, task.baseCommit);
  return withLock(join(benchDir(), "locks", name), async () => {
    const state = containerState(name);
    if (state !== "running") {
      if (state !== null) removeContainer(name);
      await startTaskContainer({ name, task, role: "bridge", onWait: opts.onWait });
    }
    const apply = await execIn({
      name,
      argv: ["bash", "-c", APPLY, "apply", task.baseCommit],
      input: patch,
      stdout: opts.stderr,
      stderr: opts.stderr,
    });
    if (apply.code !== 0) return { code: apply.code, timedOut: false };
    const run = await execIn({
      name,
      argv: ["bash", "-lc", opts.command],
      workdir: "/app",
      timeoutSec: opts.timeoutSec,
      stdout: opts.stdout,
      stderr: opts.stderr,
    });
    return { code: run.timedOut ? 124 : run.code, timedOut: run.timedOut };
  });
}

/** Removes the (task, worktree) container; the driver calls this when an attempt ends. */
export function stopBridge(task: BenchTask, worktree: string): boolean {
  const name = bridgeContainerName(task, worktree);
  if (containerState(name) === null) return false;
  removeContainer(name);
  return true;
}
