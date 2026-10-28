import { spawn } from "node:child_process";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { processRoots } from "../placed/processRoots";

/** Use the SDK's supplied executable, arguments and late abort signal unchanged. */
export function attributedClaudeProcess(
  owner: string,
  stderr?: (data: string) => void,
): NonNullable<Options["spawnClaudeCodeProcess"]> {
  return (options) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      // The SDK received the session’s already-filtered hostEnv; do not re-add ambient switches or credentials.
      env: options.env,
      signal: options.signal,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid) {
      const release = processRoots.add(child.pid, owner);
      child.once("exit", release);
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => stderr?.(data));
    return child;
  };
}
