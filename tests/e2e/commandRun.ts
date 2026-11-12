import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import electronPath from "electron";
import { RUN_WORDS } from "../../src/main/runCommand";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir } from "../helpers/scratchDirs";
import { builtAppDir, defaultClaudeStubDir, hermeticEnv } from "./launch";
import { writeMockClaudeClient } from "./mockClaudeClient";

/**
 * Infinitary started by a command, as a journey starts it (docs/run.md):
 * the built app as `<app> run`, the way a boot entry, a login or a terminal
 * starts it, in the hermetic environment `launchApp` uses. On Linux each
 * command has no display of the person's, so it draws on its own (Xvfb,
 * which every Linux package requires), as a computer nobody is logged in to
 * does.
 */

const children: ChildProcessWithoutNullStreams[] = [];

/** Ends every command a test left running; a spec calls it after each test. */
export function endCommands(): void {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
}

/** The environment with no display of the person's, as a start at boot has. */
function noScreen(env: Record<string, string>): Record<string, string> {
  const { DISPLAY: _x, WAYLAND_DISPLAY: _wayland, ...rest } = env;
  return rest;
}

/** The environment a command starts in: the hermetic one, with a throwaway HOME of its own. */
export async function runEnv(userDataDir: string, extra: Record<string, string> = {}) {
  const homeDir = scratchDir("infinitary-run-command-home-");
  return noScreen({
    ...hermeticEnv({ userDataDir, homeDir, loopbackPort: String(await claimedPort()) }),
    INFINITARY_CLAUDE_CLI: writeMockClaudeClient(defaultClaudeStubDir(userDataDir)),
    ...extra,
  });
}

/** `<app> run <args>` as its starter runs it: what it says, and its end. */
export function run(env: Record<string, string>, args: string[] = []) {
  const child = spawn(electronPath as unknown as string, [builtAppDir(), "run", ...args], {
    env,
    cwd: scratchDir("infinitary-run-command-cwd-"),
  });
  children.push(child);
  let out = "";
  let error = "";
  const waiters: (() => void)[] = [];
  child.stdout.on("data", (chunk) => {
    out += String(chunk);
    for (const wake of waiters.splice(0)) wake();
  });
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  /** The command's own lines, apart from the notes the app's parts leave on its output. */
  const lines = () => out.split("\n").filter((line) => line && !line.startsWith("["));
  return {
    child,
    lines,
    /** The notes the app's parts leave on its output, each starting with `[`. */
    notes: () => out.split("\n").filter((line) => line.startsWith("[")),
    error: () => error,
    exited,
    /** Resolves once the run says it runs; rejects when it ends first. */
    started: () =>
      new Promise<void>((resolve, reject) => {
        const look = () => {
          if (lines().includes(RUN_WORDS.started)) resolve();
          else waiters.push(look);
        };
        void exited.then((code) =>
          reject(new Error(`The run ended with ${code} before it started: ${error}`)),
        );
        look();
      }),
  };
}
