import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { hostPlatform } from "../platform";

/**
 * The Antigravity program the person installed (`agy`), found the way the
 * Claude client is found (`claudeCli.ts`): the folders its installers use,
 * then the search path the host's environment carries. The app ships and
 * downloads none, and never runs a path inside its own archive.
 */

const PROGRAM = hostPlatform() === "win32" ? "agy.exe" : "agy";

/** The folders an install puts `agy` in, before the search path is read. */
function knownHomes(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? env.USERPROFILE;
  return [...(home ? [join(home, ".local", "bin")] : []), "/opt/homebrew/bin", "/usr/local/bin"];
}

export function resolveAgyExecutable(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of knownHomes(env)) {
    const candidate = join(dir, PROGRAM);
    if (isExecutable(candidate)) return candidate;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, PROGRAM);
    if (isExecutable(candidate) && !candidate.includes(".asar")) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
