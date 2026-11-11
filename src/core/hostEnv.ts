import { delimiter } from "node:path";
import { hostPlatform } from "./platform";
import { installerDirs, type LoginShellMiss, readLoginShellPath } from "./userBin";

/**
 * The environment every child the core starts runs with.
 *
 * An app macOS opened from the Dock or Finder inherits launchd's search
 * path - on a stock Mac only /usr/bin:/bin:/usr/sbin:/sbin - so a crewmate's
 * shell, a dependency install, git, and Claude's client (and every shell
 * that client runs) could not see node, pnpm, gh, or anything
 * else the person installed. The person's own shell knows where those live,
 * so the core asks it ONCE per process (`captureLoginPath`) and every spawn
 * site builds its environment from `hostEnv`. Never re-run per spawn.
 *
 * The question goes to `$SHELL -ilc` first, because nvm and most version
 * managers are set up in the interactive startup file (.zshrc), which a
 * plain login shell never reads. When that times out, fails or prints
 * nothing readable, `-lc` (asked alongside, so the fallback costs no extra
 * wait) answers; when both miss, the process path stands alone. The
 * outcome is recorded once (`loginPathCapture`, plus one log line).
 *
 * A run started with a settings file (`<app> run --settings`, docs/run.md)
 * names its folders instead (`configureSettingsPath`): then no shell is
 * asked at all, since nobody may be logged in to answer.
 */

export type LoginPathSource = "interactive" | "login" | "process" | "settings";

export type LoginPathCapture = {
  /**
   * Which ask produced the entries; `process` means neither did, and
   * `settings` that a settings file named them and no shell was asked.
   */
  source: LoginPathSource;
  entries: readonly string[];
  /** Why the interactive ask did not answer, when it did not. */
  interactiveMiss?: LoginShellMiss;
  /** Why the login-only ask did not answer, when it was needed and did not. */
  loginMiss?: LoginShellMiss;
};

let captured: LoginPathCapture | undefined;
let capturing: Promise<LoginPathCapture> | undefined;

/**
 * Ask the person's shell for its search path, once per process: a second
 * call returns the first call's answer. Never throws; a miss is recorded
 * and leaves the process path in charge.
 */
export function captureLoginPath(env: NodeJS.ProcessEnv = process.env): Promise<LoginPathCapture> {
  if (captured) return Promise.resolve(captured);
  capturing ??= runCapture(env).then((result) => {
    captured = result;
    capturing = undefined;
    console.info(`[host-env] ${describeCapture(result)}`);
    return result;
  });
  return capturing;
}

/**
 * The folders a settings file names, in its order (`<app> run --settings`,
 * docs/run.md), in place of the shell's answer, set before anything asks:
 * every later `captureLoginPath` returns them and no shell is ever asked.
 * Children then search these folders first and the process path after them,
 * with no installer guesses (`hostPath`); Claude's locator asks no shell
 * either (`claudeCli.ts`).
 */
export function configureSettingsPath(entries: readonly string[]): void {
  captured = { source: "settings", entries: [...entries] };
  capturing = undefined;
  console.info(`[host-env] ${describeCapture(captured)}`);
}

/**
 * Ask again, for a caller that knows the answer changed (an install the app
 * ran on the person's behalf). Nothing calls it yet. A settings file's
 * folders stay: there is no shell to ask.
 */
export function refreshLoginPath(env: NodeJS.ProcessEnv = process.env): Promise<LoginPathCapture> {
  if (captured?.source === "settings") return Promise.resolve(captured);
  captured = undefined;
  capturing = undefined;
  return captureLoginPath(env);
}

/** What the one capture found, or nothing while it has not finished. */
export function loginPathCapture(): LoginPathCapture | undefined {
  return captured;
}

/** Forget the capture. For tests, which plant their own shell. */
export function resetLoginPathForTests(): void {
  captured = undefined;
  capturing = undefined;
}

async function runCapture(env: NodeJS.ProcessEnv): Promise<LoginPathCapture> {
  if (hostPlatform() === "win32") return { source: "process", entries: [] };
  const interactive = readLoginShellPath(env, "interactive");
  const login = readLoginShellPath(env, "login");
  const first = await interactive;
  if ("entries" in first) {
    // The fallback's shell is still running; its answer is not needed.
    void login;
    return { source: "interactive", entries: first.entries };
  }
  const second = await login;
  if ("entries" in second) {
    return { source: "login", entries: second.entries, interactiveMiss: first.miss };
  }
  return { source: "process", entries: [], interactiveMiss: first.miss, loginMiss: second.miss };
}

/** The one log line a capture leaves, after `[host-env] `. */
export function describeCapture(result: LoginPathCapture): string {
  const misses = [
    result.interactiveMiss ? `interactive shell: ${result.interactiveMiss}` : "",
    result.loginMiss ? `login shell: ${result.loginMiss}` : "",
  ].filter(Boolean);
  const why = misses.length > 0 ? ` (${misses.join("; ")})` : "";
  return `children search the ${result.source} path, ${result.entries.length} entries${why}`;
}

/**
 * The search path a child gets. First whatever the process path carries
 * that the person's shell does not - an addition whoever launched the app
 * made on purpose (a terminal's own tweak, a test's stand-in) keeps its
 * precedence - then the shell's path in its own order, then the installer
 * directories it lacks, then anything left. A Dock launch's process path
 * is only system folders the shell's path already holds, so there the
 * child sees exactly what the person's terminal would.
 */
export function mergeSearchPath(
  loginEntries: readonly string[],
  processPath: string | undefined,
  installers: readonly string[],
): string {
  const processEntries = (processPath ?? "").split(delimiter).filter((entry) => entry.length > 0);
  const login = new Set(loginEntries);
  const merged: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string) => {
    if (seen.has(entry)) return;
    seen.add(entry);
    merged.push(entry);
  };
  for (const entry of processEntries) if (!login.has(entry)) add(entry);
  for (const entry of loginEntries) add(entry);
  for (const entry of installers) add(entry);
  for (const entry of processEntries) add(entry);
  return merged.join(delimiter);
}

/**
 * The search path a child gets when a settings file named the folders: the
 * file's folders in its order, then whatever the process path holds that the
 * file does not, so the system folders a starter sets stay reachable behind
 * them. Nothing is guessed: the installer directories count only when the
 * file or the process path names them.
 */
function settingsSearchPath(
  settingsEntries: readonly string[],
  processPath: string | undefined,
): string {
  const processEntries = (processPath ?? "").split(delimiter).filter((entry) => entry.length > 0);
  return [...new Set([...settingsEntries, ...processEntries])].join(delimiter);
}

/**
 * Git that never prompts, and never answers for GitHub with anything but the
 * app's own sign-in (git integration PR 1.2, `docs/forge.md`). Every child
 * the core starts - host git, a crewmate's shell, Claude's client and
 * whatever it runs - carries:
 *
 * - `GIT_TERMINAL_PROMPT=0`: no child ever waits on a terminal nobody sees.
 * - `GIT_ASKPASS`: the app's own helper (`resources/git-askpass`), which
 *   answers a host's "who is this" from `INFINITARY_GIT_SIGNIN_DIR/<host>/`
 *   when the person signed in to that host here, and says nothing
 *   otherwise. The sign-in is read from its 0600 file by the helper; it is
 *   never in the environment or an argument.
 * - `GIT_CONFIG_PARAMETERS`: the credential helpers are emptied for the
 *   hosts that offer the app's sign-in (github.com) and for each host on
 *   the person's own server the app holds a sign-in for (a GitHub
 *   Enterprise host), so neither the Mac's keychain helper nor another
 *   program's sign-in ever answers for them under the app (the owner's
 *   "ignore the existing gh sign-in"). Every other host keeps the person's
 *   own helpers; an SSH origin is the person's own agent, untouched. The
 *   hosts are read at each spawn, so a sign-in made since counts.
 *
 * Unset until the composition root names the helper (a unit test's child
 * gets none of it).
 */
export type GitSignInEnv = {
  askpass: string;
  signInDir: string;
  hosts: readonly string[] | (() => readonly string[]);
};

let gitSignIn: GitSignInEnv | undefined;

export function configureGitSignIn(config: GitSignInEnv | undefined): void {
  gitSignIn = config;
}

/** The `GIT_CONFIG_PARAMETERS` entries that empty the credential helpers for the app's hosts. */
export function gitHelperResetParameters(): string[] {
  const hosts =
    typeof gitSignIn?.hosts === "function" ? gitSignIn.hosts() : (gitSignIn?.hosts ?? []);
  return hosts.map((host) => `'credential.https://${host}.helper='`);
}

/** The git half of every child's environment (see `configureGitSignIn`). */
export function gitSignInEnv(): NodeJS.ProcessEnv {
  if (!gitSignIn) return {};
  const inherited = process.env.GIT_CONFIG_PARAMETERS?.trim();
  const parameters = [...(inherited ? [inherited] : []), ...gitHelperResetParameters()];
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: gitSignIn.askpass,
    INFINITARY_GIT_SIGNIN_DIR: gitSignIn.signInDir,
    ...(parameters.length > 0 ? { GIT_CONFIG_PARAMETERS: parameters.join(" ") } : {}),
  };
}

/**
 * The app's own git (git integration phase 2, `workspace/bundledGit.ts`):
 * the binary every host git runs, the environment that git is told where
 * its parts are with, and the directory whose one file is the `git` a
 * crewmate's shell finds first. Unset until the composition root resolves
 * it, and unset for good when this build carries none - then every git is
 * the one the search path finds.
 */
export type BundledGit = {
  /** The git tree for this architecture. */
  dir: string;
  binary: string;
  env: Readonly<Record<string, string>>;
  shimDir: string;
};

let bundled: BundledGit | undefined;

export function configureBundledGit(config: BundledGit | undefined): void {
  bundled = config;
}

export function bundledGit(): BundledGit | undefined {
  return bundled;
}

/**
 * The search path every child runs with (see `mergeSearchPath`, or
 * `settingsSearchPath` when a settings file named the folders), with the
 * app's git directory ahead of everything when there is one: `git` in a
 * crewmate's shell is the app's, and every other program the Mac has stays
 * visible behind it.
 */
export function hostPath(): string {
  const merged =
    captured?.source === "settings"
      ? settingsSearchPath(captured.entries, process.env.PATH)
      : mergeSearchPath(captured?.entries ?? [], process.env.PATH, installerDirs(process.env));
  if (!bundled) return merged;
  const rest = merged.split(delimiter).filter((entry) => entry !== bundled?.shimDir);
  return [bundled.shimDir, ...rest].join(delimiter);
}

/**
 * What a shell that answers within a limit tells the commands it runs: the
 * milliseconds before a command still running becomes a background job (the
 * app's own shell for a Pi session, `jobs/jobManager.ts`). A task command
 * answers within it (docs/axi-commands.md). Absent or 0: no limit.
 */
export const SHELL_CAP_ENV = "INFINITARY_SHELL_CAP_MS";

/**
 * When that shell started, epoch milliseconds from `Date.now()`, the clock
 * the channel compares against (`jobs/jobManager.ts`). Pi counts its limit
 * from this moment, so a task command does too (docs/axi-commands.md).
 * Absent: the channel counts from when the request arrives.
 */
export const SHELL_STARTED_ENV = "INFINITARY_SHELL_STARTED_MS";

/**
 * That shell's own id, which a task command passes on, so the channel can
 * tell the shell that its command reached the app and its answer is on the
 * way back (`JobManager.answering`, docs/axi-commands.md). Absent: no shell
 * is told.
 */
export const SHELL_ID_ENV = "INFINITARY_SHELL_ID";

/**
 * An environment with a session's shell laid over it (`SessionSpec.shell`):
 * its variables, and its folders first on the search path.
 */
export function withTaskShell(
  env: NodeJS.ProcessEnv,
  shell: { env: Readonly<Record<string, string>>; path: readonly string[] } | undefined,
): NodeJS.ProcessEnv {
  if (!shell) return env;
  const rest = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry && !shell.path.includes(entry));
  return { ...env, ...shell.env, PATH: [...shell.path, ...rest].join(delimiter) };
}

/**
 * The variables that tell git which repository, index, object store or
 * settings file to use instead of the one it finds from its folder: the
 * names `git rev-parse --local-env-vars` lists, which git itself clears
 * when it moves into another repository (a submodule), and the one an older
 * git listed beside them (`GIT_INTERNAL_SUPER_PREFIX`). Like git, the app
 * keeps the two that carry `-c` settings, `GIT_CONFIG_PARAMETERS` and
 * `GIT_CONFIG_COUNT`.
 *
 * A `git bisect run` step, a hook or a `rebase --exec` in a linked working
 * copy runs with `GIT_DIR` set. An app started there must not hand it on:
 * its own git would then commit into that repository and write its identity
 * into the settings every working copy of it reads, and a crewmate's git
 * would answer for that repository instead of its own working copy.
 */
export const REPOSITORY_GIT_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

/**
 * The process environment with the git environment and `extra` laid over
 * it, and the host search path. Every spawn site in the core builds its
 * child's environment here. `INFINITARY_GIT_DIR` tells the app's `git` on the
 * search path (`git-bin/git`, `scripts/git-launcher.c`) which tree to run.
 * Nothing that chooses a repository is inherited
 * (`REPOSITORY_GIT_VARIABLES`); a caller that wants one, such as a scratch
 * index, names it in `extra`.
 */
export function hostEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  // An app started from a Pi shell inherits that shell's limit and id. A
  // child that is not itself that shell — the Claude client among them —
  // must not keep them: JobManager sets them again through `extra` for the
  // shells it starts.
  const inherited = { ...process.env };
  delete inherited[SHELL_CAP_ENV];
  delete inherited[SHELL_STARTED_ENV];
  delete inherited[SHELL_ID_ENV];
  delete inherited.FM3000_SHELL_CAP_MS; // the older name still reads as this limit
  for (const name of REPOSITORY_GIT_VARIABLES) delete inherited[name];
  return {
    ...inherited,
    ...gitSignInEnv(),
    ...(bundled ? { INFINITARY_GIT_DIR: bundled.dir } : {}),
    ...extra,
    PATH: hostPath(),
  };
}
