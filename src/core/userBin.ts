import { execFile, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { hostPlatformProfile } from "./platform";

/**
 * Finding a tool the person installed, from an app macOS opened from the
 * Dock or Finder. That launch inherits the login search path, which on a
 * stock Mac is only /usr/bin:/bin:/usr/sbin:/sbin, so Homebrew and the
 * other installers are invisible to a bare `execFile` of a program name.
 *
 * Claude's locator (`claudeCli.ts`) is the same rule for one client, with
 * its own homes and a version floor. This is the generic rung, so a later
 * tool can use it without knowing that client's name.
 */

/** A login shell can stall on a prompt; a lookup gets this and no more. */
export const SHELL_LOOKUP_TIMEOUT_MS = 3_000;

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The first executable `name` on PATH, or nothing. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * `command -v name` through the login shell, which is where a Dock-launched
 * app can still see a path the person's shell profile added. The last line
 * is the answer: a profile that prints a greeting must not win. A relative
 * name, an alias, or a path that is not executable is a miss.
 */
export function lookupThroughLoginShell(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const shell = env.SHELL?.trim() || hostPlatformProfile().loginShell;
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-lc", 'command -v "$1"', "infinitary-lookup", name],
      { timeout: SHELL_LOOKUP_TIMEOUT_MS, env: { ...env }, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const line = String(stdout).trim().split("\n").pop()?.trim();
        resolve(line?.startsWith("/") && isExecutable(line) ? line : undefined);
      },
    );
  });
}

/** `dir` first on PATH when it is not already there, so a tool can see its siblings. */
export function pathWithDir(dir: string, env: NodeJS.ProcessEnv): string {
  const current = env.PATH ?? "";
  const entries = current.split(delimiter).filter((entry) => entry.length > 0);
  if (entries.includes(dir)) return current;
  return current ? `${dir}${delimiter}${current}` : dir;
}

/**
 * Where the installers put command-line programs on a Mac, worth a look
 * after PATH misses: Homebrew on Apple silicon, Homebrew and the official
 * installers on Intel, a hand install under the home directory, then
 * MacPorts. Generic on purpose - any locator and the host environment
 * (`hostEnv.ts`) read the same list.
 */
export function installerDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || homedir();
  return ["/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), "/opt/local/bin"];
}

/** How a login shell is asked: `-ilc` also reads the interactive startup files. */
export type LoginShellMode = "interactive" | "login";

/** Why a login shell gave no search path. */
export type LoginShellMiss = "timeout" | "exit" | "unparsable";

const PATH_MARK = "__INFINITARY_LOGIN_PATH__";

/**
 * Variables that quiet the usual interactive startup chatter - an update
 * check that asks a question, a terminal multiplexer that takes over, an
 * instant prompt - and touch nothing else. Never PATH.
 */
const QUIET_STARTUP_ENV = {
  DISABLE_AUTO_UPDATE: "true",
  DISABLE_UPDATE_PROMPT: "true",
  ZSH_TMUX_AUTOSTART: "false",
  POWERLEVEL9K_INSTANT_PROMPT: "off",
};

/**
 * The search path between the last pair of marks in a login shell's
 * output, or nothing. The marks are what make it safe to run the startup
 * files: a greeting, a banner or a terminal title sequence lands outside
 * them.
 */
export function parseMarkedPath(output: string): string[] | undefined {
  const parts = output.split(PATH_MARK);
  if (parts.length < 3) return undefined;
  const entries = (parts[parts.length - 2] ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("/"));
  return entries.length > 0 ? entries : undefined;
}

/**
 * The search path the person's own shell builds, asked once of `$SHELL`
 * with `-ilc` (interactive: where nvm and most version managers live) or
 * `-lc` (login only). Bounded like `lookupThroughLoginShell`, with stdin
 * closed so a startup file that asks a question reads end-of-file, and run
 * in its own process group so a timeout kills whatever the startup files
 * started too. Never throws.
 */
export function readLoginShellPath(
  env: NodeJS.ProcessEnv,
  mode: LoginShellMode,
  timeoutMs: number = SHELL_LOOKUP_TIMEOUT_MS,
): Promise<{ entries: string[] } | { miss: LoginShellMiss }> {
  const shell = env.SHELL?.trim() || hostPlatformProfile().loginShell;
  const flags = mode === "interactive" ? "-ilc" : "-lc";
  const command = `printf '%s%s%s' '${PATH_MARK}' "$PATH" '${PATH_MARK}'`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: { entries: string[] } | { miss: LoginShellMiss }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, [flags, command], {
        env: { ...env, ...QUIET_STARTUP_ENV },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        windowsHide: true,
      });
    } catch {
      resolve({ miss: "exit" });
      return;
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      finish({ miss: "timeout" });
    }, timeoutMs);
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => finish({ miss: "exit" }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ miss: "exit" });
        return;
      }
      const entries = parseMarkedPath(output);
      finish(entries ? { entries } : { miss: "unparsable" });
    });
  });
}
