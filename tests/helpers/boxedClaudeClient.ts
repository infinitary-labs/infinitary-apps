import { execFileSync } from "node:child_process";

/**
 * The boxed Claude client (`tests/e2e/mockClaudeClient.ts` turn mode) this
 * test process started last, as `ps` lists it now: the box's launcher execs
 * the SDK's own client, so it is this process's child, as a person's client
 * is the app's.
 */
export function boxedClaudeClientPid(): number {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }]
        : [];
    });
  const client = rows
    .filter((row) => row.ppid === process.pid && row.command.includes("claude-agent-sdk-"))
    .at(-1);
  if (client === undefined) throw new Error("the boxed client is not running");
  return client.pid;
}

/** Whether a process is still there: signal 0 checks without sending anything. */
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
