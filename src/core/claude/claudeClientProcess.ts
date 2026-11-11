import { type ChildProcess, spawn } from "node:child_process";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { processRoots } from "../placed/processRoots";

/**
 * The Claude client a session's query runs, spawned by the app through the
 * SDK's supported `spawnClaudeCodeProcess` hook, so its session knows when
 * it has exited (docs/claude-client.md, "The client's process"). The SDK's
 * close ends the client's input and sends SIGTERM only 2 s on, but ends its
 * message stream after at most 2 s, whether the client has gone or not; a
 * session that let go of its store there could leave a client still running
 * on it (INF-3500).
 */

/** Where a session learns when the clients its query spawned have exited. */
export class ClaudeClientExit {
  private pending: Promise<void> | undefined;

  /** Watches a client the hook spawned until it exits. */
  watch(child: ChildProcess): void {
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      // A client that never started has nothing to wait for.
      child.once("error", () => {
        if (child.pid === undefined) resolve();
      });
    });
    const before = this.pending;
    const all = before ? Promise.all([before, exited]).then(() => undefined) : exited;
    this.pending = all;
    void all.then(() => {
      if (this.pending === all) this.pending = undefined;
    });
  }

  /** Resolves once every client watched has exited; undefined when none still runs. */
  running(): Promise<void> | undefined {
    return this.pending;
  }
}

/**
 * The hook: the executable, arguments, already-filtered environment and late
 * abort signal the SDK names, unchanged, on piped streams without a terminal.
 * The client's stderr goes to the host log. With an owner, the client's PID
 * is that task's process root until it exits (docs/helper.md, "Running
 * tasks' resource use").
 */
export function claudeClientSpawn(input: {
  stderr?: (data: string) => void;
  owner?: string;
  exit?: ClaudeClientExit;
}): NonNullable<Options["spawnClaudeCodeProcess"]> {
  return (options) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      // The SDK received the session’s already-filtered hostEnv; do not re-add ambient switches or credentials.
      env: options.env,
      signal: options.signal,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    input.exit?.watch(child);
    if (input.owner !== undefined && child.pid) {
      const release = processRoots.add(child.pid, input.owner);
      child.once("exit", release);
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => input.stderr?.(data));
    return child;
  };
}
