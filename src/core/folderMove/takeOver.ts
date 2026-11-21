import { execFile } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { APP_IDENTITIES, SPELLINGS, type Spelling } from "@shared/codeNames";
import type { BuildFlavor } from "@shared/userDataFolders";
import { readInstalled, type Service } from "../helper/background";
import { folderHolder, holderAlive, processAlive, STOPPED_RUN_WAIT_MS } from "../helper/lock";
import { loginAgentFile, sessionAgentFile } from "../helper/runAgent";
import { hostEnv } from "../hostEnv";

/**
 * Taking over from the older copy that holds the saved work (INF-5468's
 * plan, piece 3; docs/saved-data-compatibility.md, "An older copy still
 * running"): before the one-time move, the older folder may still be held
 * by an earlier Infinitary, under either name, with no window - its background
 * work (`work/running.lock`) or a run a command started (Chromium's
 * `SingletonLock`). The step reads who holds it from those locks, confirms
 * the process is one of ours by its program, lets go of the agent the older
 * folder recorded so nothing starts its run again, asks the process for the
 * ordinary stop, which saves and exits, and waits for it to let go. It never
 * stops a window, which keeps the person's own Quit, a process that is not
 * ours, or anything at all without the person's click once the ordinary
 * stop did not work (`stopOlderCopyNow`).
 */

/** A process's program and the arguments after it. */
export type ProcessCommand = { program: string; args: string[] };

/** The kind of older copy a process is: one with its window, a run a command started, or background work. */
export type OlderCopy = "window" | "run" | "work";

export type TakeOverDeps = {
  platform: NodeJS.Platform;
  /** This computer's name, as Chromium writes it into its single-instance lock. */
  hostname: string;
  alive?: (pid: number) => boolean;
  /** Reads a process's program and arguments (`processCommand`); null when it cannot be read. */
  command?: (pid: number) => Promise<ProcessCommand | null>;
  /** The names our programs run under (`OUR_PROGRAMS`). */
  programs?: readonly string[];
  /** Sends a process a signal (`process.kill`). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Lets go of an agent so its service manager does not start its run again (`pauseInBackground`); absent where nothing is set up in the background. */
  unloadAgent?: (service: Service) => Promise<void>;
  /** Starts an agent let go again when the move does not go ahead (`resumeInBackground`). */
  resumeAgent?: (service: Service) => Promise<void>;
  /** The start entry a run of the older copy may have (`olderRunAgent`): let go before a forced end, which it would count as a failure and start the run again. */
  runAgent?: Service;
  /** Told once the holder is known to be one of ours with no window, before it is asked to stop. */
  stopping?: (copy: OlderCopy) => Promise<unknown> | undefined;
  /** Whether this process is the run of the agent under that label (`runsUnderAgent`). */
  runsUnder?: (label: string) => boolean;
  /** How long the older copy has to let the folder go. */
  waitMs?: number;
  /** Ends the wait early, as a run's Ctrl-C does: the older copy, asked already, reads as still running. */
  signal?: AbortSignal;
};

export type TakeOver =
  /** Nothing holds the older folder now. */
  | { kind: "free" }
  /** The older copy let the folder go; `unloaded` is the agent let go first. */
  | { kind: "stopped"; copy: OlderCopy; unloaded?: Service }
  /** Left as it is: an older copy with its window open, or a process that is not ours or cannot be read. */
  | { kind: "left"; why: "window" | "not-ours" }
  /** Asked to stop, it still holds the folder: only the person's click forces it. */
  | { kind: "still-running"; pid: number; copy: OlderCopy; unloaded?: Service };

/**
 * The names our programs run under: each spelling's Mac app for each flavor,
 * whose bundle's program carries the app's name, and the Linux packages'
 * programs, `/opt/infinitary/infinitary` and Firstmate 3000's
 * `/opt/firstmate-3000/firstmate-3000` (docs/linux-packages.md).
 */
export const OUR_PROGRAMS: readonly string[] = [
  ...SPELLINGS.flatMap((spelling) => Object.values(APP_IDENTITIES[spelling].app)),
  "infinitary",
  "firstmate-3000",
];

/**
 * The start entry a run of the older copy may have: the run agent the
 * window or `start-at-boot` sets up, under that identity's bundle id and
 * `.run` (`runLabelOf`, src/core/helper/runAgent.ts); none on other systems.
 */
export function olderRunAgent(options: {
  spelling: Spelling;
  flavor: BuildFlavor;
  platform: NodeJS.Platform;
  homeDir: string;
  unitsDir: string;
  /** The older data folder, where a Mac's run agent's file is kept while Start at login is off. */
  dataDir: string;
}): Service | undefined {
  const label = `${APP_IDENTITIES[options.spelling].bundleId}${options.flavor === "dev" ? ".dev" : ""}.run`;
  if (options.platform === "darwin") {
    // Either file of a Mac's agent, as `runAgentInPlace` reads it: the login one first.
    const login = loginAgentFile({ homeDir: options.homeDir, label });
    const session = sessionAgentFile({ dataDir: options.dataDir });
    return { label, file: !existsSync(login) && existsSync(session) ? session : login };
  }
  if (options.platform === "linux")
    return { label, file: join(options.unitsDir, `${label}.service`) };
  return undefined;
}

/** How often the step reads whether the older copy let go. */
const READ_EVERY_MS = 100;

/**
 * The process Chromium's single-instance lock in `dir` names, when it is a
 * live process on this computer written since it last started; null
 * otherwise (`holderAlive`).
 */
export function chromiumHolder(
  dir: string,
  hostname: string,
  alive: (pid: number) => boolean = processAlive,
): number | null {
  const lock = join(dir, "SingletonLock");
  let target: string;
  try {
    target = readlinkSync(lock);
  } catch {
    return null;
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match || match[1] !== hostname) return null;
  const pid = Number(match[2]);
  return holderAlive(lock, pid, alive) ? pid : null;
}

/** The process holding the older folder now: a window or a run by its Chromium lock, or its background work by `work/running.lock`. */
export function olderHolder(
  from: string,
  hostname: string,
  alive: (pid: number) => boolean = processAlive,
): number | null {
  return chromiumHolder(from, hostname, alive) ?? folderHolder(join(from, "work"), alive);
}

function run(program: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(program, [...args], { env: hostEnv(), timeout: 5000 }, (error, stdout) =>
      resolve(error ? null : String(stdout).trim()),
    );
  });
}

/**
 * A process's program and arguments, as the system keeps them: on Linux its
 * own `/proc/<pid>/cmdline`, and on a Mac `ps`'s executable path and the
 * words after it. Elsewhere, and for a process gone, null.
 */
export async function processCommand(
  pid: number,
  platform: NodeJS.Platform,
): Promise<ProcessCommand | null> {
  if (platform === "linux") {
    try {
      const [program, ...args] = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter((part) => part !== "");
      return program ? { program, args } : null;
    } catch {
      return null;
    }
  }
  if (platform !== "darwin") return null;
  const program = await run("/bin/ps", ["-o", "comm=", "-p", String(pid)]);
  const line = await run("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)]);
  if (!program || line === null) return null;
  // The program's own path may hold spaces: what follows it are the arguments.
  const rest = line.startsWith(program) ? line.slice(program.length) : "";
  return { program, args: rest.split(/\s+/).filter((part) => part !== "") };
}

/**
 * The kind of older copy a process is, or null when its program is not one
 * of ours. Background work runs `work run`, a command's run `run`, and a
 * window neither; Chromium's own switches may stand before them.
 */
export function olderCopyOf(
  command: ProcessCommand,
  programs: readonly string[] = OUR_PROGRAMS,
): OlderCopy | null {
  if (!programs.includes(basename(command.program))) return null;
  const words = command.args.filter((arg) => !arg.startsWith("-"));
  for (let at = 0; at < words.length - 1; at += 1)
    if (words[at] === "work" && words[at + 1] === "run") return "work";
  return words.includes("run") ? "run" : "window";
}

/**
 * Whether this process is the run of the agent under `label`: launchd names
 * the job in each process it starts (`XPC_SERVICE_NAME`), and systemd puts a
 * service's processes in its own control group. Letting that agent go would
 * end this process.
 */
export function runsUnderAgent(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  readGroup: () => string = () => readFileSync("/proc/self/cgroup", "utf8"),
): boolean {
  if (env.XPC_SERVICE_NAME === label) return true;
  // A systemd agent's label is its unit's name, `.service` included.
  const unit = label.endsWith(".service") ? label : `${label}.service`;
  try {
    return readGroup()
      .split("\n")
      .some((line) => line.endsWith(`/${unit}`) || line.includes(`/${unit}/`));
  } catch {
    return false;
  }
}

/** Waits until `pid` no longer holds the older folder, up to `waitMs`; whether it let go. */
async function letGo(from: string, pid: number, deps: TakeOverDeps, waitMs: number) {
  const alive = deps.alive ?? processAlive;
  const until = Date.now() + waitMs;
  for (;;) {
    if (olderHolder(from, deps.hostname, alive) !== pid) return true;
    if (Date.now() >= until || deps.signal?.aborted) return false;
    await new Promise((resolve) => setTimeout(resolve, READ_EVERY_MS));
  }
}

function signal(deps: TakeOverDeps, pid: number, name: NodeJS.Signals): void {
  try {
    (deps.kill ?? process.kill)(pid, name);
  } catch {
    // Gone already: the wait reads that it let go.
  }
}

/** The older copy holding `from` now and what it is, or why it is left alone. */
async function identify(
  from: string,
  deps: TakeOverDeps,
): Promise<
  | { kind: "free" }
  | { kind: "left"; why: "window" | "not-ours" }
  | { kind: "ours"; pid: number; copy: OlderCopy }
> {
  const pid = olderHolder(from, deps.hostname, deps.alive ?? processAlive);
  if (pid === null) return { kind: "free" };
  const command = await (deps.command ?? ((pid) => processCommand(pid, deps.platform)))(pid);
  const copy = command ? olderCopyOf(command, deps.programs) : null;
  if (!copy) return { kind: "left", why: "not-ours" };
  if (copy === "window") return { kind: "left", why: "window" };
  return { kind: "ours", pid, copy };
}

/**
 * Takes over from the older copy holding `from`: lets go of the agent the
 * older folder's work recorded when the holder is that work's run - never
 * the agent this process itself runs under - then sends the ordinary stop
 * and waits for the folder to be let go. A run's own start entry stays: it
 * starts the run again only after a failure, never after this clean stop
 * (docs/run.md); a forced end lets it go first (`stopOlderCopyNow`).
 */
export async function takeOverOlderCopy(from: string, deps: TakeOverDeps): Promise<TakeOver> {
  const found = await identify(from, deps);
  if (found.kind !== "ours") return found;
  const { pid, copy } = found;
  await deps.stopping?.(copy);
  const unloaded =
    copy === "work" ? await letAgentGo(readInstalled(join(from, "work")).service, deps) : undefined;
  signal(deps, pid, "SIGTERM");
  const agent = unloaded ? { unloaded } : {};
  if (!(await letGo(from, pid, deps, deps.waitMs ?? STOPPED_RUN_WAIT_MS)))
    return { kind: "still-running", pid, copy, ...agent };
  return { kind: "stopped", copy, ...agent };
}

/** Lets go of `service` when it is set up and is not the agent this process runs under; the agent let go. */
async function letAgentGo(service: Service | null | undefined, deps: TakeOverDeps) {
  if (!service || !deps.unloadAgent) return undefined;
  if ((deps.runsUnder ?? runsUnderAgent)(service.label)) return undefined;
  try {
    await deps.unloadAgent(service);
    return service;
  } catch {
    // The ordinary stop still asks the run itself.
    return undefined;
  }
}

/**
 * Ends the older copy that did not stop, on the person's click: only while
 * the same process still holds the folder and is still one of ours with no
 * window. A run's start entry is let go first, since it counts a forced end
 * as a failure and would start the run again at once. Whether the folder is
 * free now, and the start entry let go.
 */
export async function stopOlderCopyNow(
  from: string,
  pid: number,
  deps: TakeOverDeps,
): Promise<{ free: boolean; unloaded?: Service }> {
  const found = await identify(from, deps);
  if (found.kind === "free") return { free: true };
  if (found.kind !== "ours" || found.pid !== pid) return { free: false };
  // Only a start entry set up on this computer: none is the common case.
  const entry = found.copy === "run" && deps.runAgent && existsSync(deps.runAgent.file);
  const unloaded = entry ? await letAgentGo(deps.runAgent, deps) : undefined;
  signal(deps, pid, "SIGKILL");
  const free = await letGo(from, pid, deps, deps.waitMs ?? STOPPED_RUN_WAIT_MS);
  return { free, ...(unloaded ? { unloaded } : {}) };
}
