import { realpath } from "node:fs/promises";
import { bundledGit, gitHelperResetParameters, hostEnv } from "../hostEnv";
import { atUtilityQos } from "../utilityQos";
import { runGitProcess } from "./gitProcess";

/**
 * The identity the app commits under when a repo has none of its own (a
 * fresh fleet init, the personal workspace's managed files): never a
 * user's, never a global config write.
 */
export const APP_GIT_IDENTITY = [
  "-c",
  "user.name=Infinitary",
  "-c",
  "user.email=infinitary@localhost",
];

/**
 * Thin git runner for the work substrate. Always explicit about the repo via
 * -C; never touches the user's global config beyond what git reads itself.
 */
export async function git(
  repoDir: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    timeoutMs?: number;
    trim?: boolean;
    /**
     * Ends git when it aborts, as the timeout does: git and every program
     * it started, its remote helpers included (`gitProcess.ts`).
     */
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  if (args[0] !== "worktree") return runGit(repoDir, args, options);
  // Git publishes a worktree's administrative files one at a time. Another
  // worktree command can read its still-empty commondir (or prune it) before
  // add finishes. Pool moves/prunes and new starts share this same queue.
  // Resolve the common directory, not the checkout: linked trees and aliases
  // all mutate the same bookkeeping. Other repositories remain independent.
  const common = await realpath(
    await runGit(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      ...options,
      trim: true,
    }),
  );
  const previous = worktreeCommands.get(common) ?? Promise.resolve();
  const command = previous.catch(() => {}).then(() => runGit(repoDir, args, options));
  worktreeCommands.set(common, command);
  try {
    return await command;
  } finally {
    if (worktreeCommands.get(common) === command) worktreeCommands.delete(common);
  }
}

const worktreeCommands = new Map<string, Promise<string>>();

async function runGit(
  repoDir: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    timeoutMs?: number;
    trim?: boolean;
    signal?: AbortSignal;
  },
): Promise<string> {
  // The app's own git when this build carries it (bundledGit.ts), else the
  // one the search path finds.
  const app = bundledGit();
  // Checkouts and removals can touch tens of thousands of files: below the UI.
  const command = atUtilityQos(app?.binary ?? "git", ["-C", repoDir, ...args]);
  const stdout = await runGitProcess(command.file, command.args, {
    maxBuffer: 16 * 1024 * 1024,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    env: {
      ...hostEnv(),
      ...options.env,
      // Where that git's own parts are: never the caller's to change.
      ...app?.env,
      // Worktree/commit plumbing must not stall on user hooks or signing,
      // and GitHub answers only to the app's own sign-in (`hostEnv.ts`).
      GIT_CONFIG_PARAMETERS: [
        "'commit.gpgsign=false'",
        "'core.hooksPath=/dev/null'",
        ...gitHelperResetParameters(),
      ].join(" "),
    },
  });
  return options.trim === false ? stdout : stdout.trim();
}

/** A git failure's first meaningful line, for a timeline-sized reason. */
export function gitFailure(caught: unknown): string {
  const failure = caught as { stderr?: string; message?: string };
  const lines = `${failure.stderr ?? ""}\n${failure.message ?? String(caught)}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? "unknown error";
  return reason.length > 200 ? `${reason.slice(0, 200)}...` : reason;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}
