import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import type { FoundTools } from "@shared/connection";
import { primeClaudeExecutable } from "../claude/claudeCli";
import { bundledGit, captureLoginPath, hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";
import { isExecutable, onSearchPath } from "../userBin";

/**
 * What a computer that runs work has when it joins (docs/helper.md,
 * "Joining"): git, which clones its projects, and Claude Code, which its
 * Claude sign-in and conversations run on. It tells its home, whose feed
 * line names them ("It has git and Claude Code, and no sign-ins yet.").
 * It only looks: nothing is installed, and nothing asks the person.
 */
export async function findTools(): Promise<FoundTools> {
  // Where the person's own shell finds programs, as every child sees it.
  await captureLoginPath();
  const env = hostEnv();
  const [git, claude] = await Promise.all([gitFound(env), primeClaudeExecutable(env)]);
  return { git, claudeCode: claude !== undefined };
}

/**
 * git: the app's own when this copy carries it (`workspace/bundledGit.ts`),
 * which every git it starts runs, so a Mac with no developer tools has git;
 * else the git on the search path.
 */
export async function gitFound(
  env: NodeJS.ProcessEnv,
  platform: string = hostPlatform(),
): Promise<boolean> {
  if (bundledGit()) return true;
  return hasGit(env, platform);
}

/** The macOS stand-in that asks to install the developer tools when it runs without them. */
const SYSTEM_GIT = "/usr/bin/git";

/**
 * git on the search path: `git.exe` on Windows (`programFiles`), where the
 * Git for Windows the app chose is on it (`hostPath`). macOS keeps a
 * stand-in at /usr/bin/git that asks to install the developer tools when it
 * runs, so it counts only once they are installed, and is never run to find
 * out.
 */
async function hasGit(env: NodeJS.ProcessEnv, platform: string): Promise<boolean> {
  if (platform !== "darwin") return onSearchPath("git", env, platform);
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, "git");
    if (!isExecutable(candidate)) continue;
    if (candidate !== SYSTEM_GIT) return true;
    return developerTools(env);
  }
  return false;
}

function developerTools(env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/usr/bin/xcode-select", ["-p"], { env, timeout: 5_000 }, (error) => resolve(!error));
  });
}
