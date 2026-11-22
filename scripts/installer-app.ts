import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

// INF-2949. The published-alpha update check stops the copy of the app ShipIt restarts
// after the update and launches it again with its inspector. In one release the check
// stopped that copy 1.7 s into its start; the next launch's core ran, but no page reached
// the inspector in 30 s, and nothing the check kept could say why. It had waited only for
// the app's main process to end, and the app's own records went with the scratch home.
// So the check lets the restarted copy start its page first, waits until every process
// the app started has ended before launching again, and keeps what the app was doing
// whenever a launch shows no page.

/** One process running a program from inside an installed app, as `ps` shows it. */
export type AppProcess = {
  pid: number;
  ppid: number;
  /** Time since it started, as `ps` prints it: [[dd-]hh:]mm:ss. */
  elapsed: string;
  /** `ps`'s state letters: S sleeping, R running, U waiting uninterruptibly, T stopped, Z ended and not yet reaped. */
  state: string;
  /** Its program's name, such as Infinitary or Infinitary Helper (GPU). */
  program: string;
  /**
   * `main` for the app's own process; `child` for the app's program started by another of
   * its processes; Chromium's `--type` for a helper, with a utility's `--utility-sub-type`;
   * otherwise the program's name, such as ShipIt or the app's own git.
   */
  kind: string;
};

/**
 * Chromium's own warnings and errors, such as a helper that could not start, written to
 * the launch's output with the app's lines. A packaged app writes none of them without it.
 */
export const CHROMIUM_LOG_SWITCHES = ["--enable-logging", "--log-level=1"];

/** The app's own records in its data folder the evidence keeps; its database never leaves. */
export const APP_RECORDS = ["freezes.jsonl", "memory.jsonl"];

/** The bundle as given and as the file system resolves it, since `ps` can show either. */
export function bundlePaths(bundle: string): string[] {
  let real = bundle;
  try {
    real = realpathSync(bundle);
  } catch {
    // A bundle that is gone keeps its given path.
  }
  return [...new Set([bundle, real])];
}

const PROGRAM_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/;
const COMMAND_ROW = /^\s*(\d+)\s+(.*)$/;

/**
 * Every process whose program is inside one of `bundles`, from two `ps` listings:
 * `pid=,ppid=,etime=,stat=,comm=`, whose last column is the program's path, and
 * `pid=,command=` for its arguments.
 */
export function parseAppProcesses(
  programs: string,
  commands: string,
  bundles: readonly string[],
): AppProcess[] {
  const commandOf = new Map<number, string>();
  for (const line of commands.split("\n")) {
    const match = COMMAND_ROW.exec(line);
    if (match) commandOf.set(Number(match[1]), match[2] ?? "");
  }
  const rows: (Omit<AppProcess, "kind"> & { inBundle: string; command: string })[] = [];
  for (const line of programs.split("\n")) {
    const match = PROGRAM_ROW.exec(line);
    if (!match) continue;
    const [, pid = "", ppid = "", elapsed = "", state = "", path = ""] = match;
    const bundle = bundles.find((candidate) => path.startsWith(`${candidate}/Contents/`));
    if (!bundle) continue;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      elapsed,
      state,
      program: basename(path),
      inBundle: path.slice(bundle.length),
      command: commandOf.get(Number(pid)) ?? "",
    });
  }
  const pids = new Set(rows.map(({ pid }) => pid));
  return rows.map(({ inBundle, command, ...row }) => ({
    ...row,
    kind: kindOf(inBundle, command, pids.has(row.ppid)),
  }));
}

function kindOf(inBundle: string, command: string, startedByApp: boolean): string {
  if (/^\/Contents\/MacOS\/[^/]+$/.test(inBundle)) return startedByApp ? "child" : "main";
  const type = /(?:^|\s)--type=(\S+)/.exec(command)?.[1];
  if (!type) return basename(inBundle);
  const subType = /(?:^|\s)--utility-sub-type=(\S+)/.exec(command)?.[1];
  return subType ? `${type} ${subType}` : type;
}

function listProcesses(columns: string): string {
  const listing = spawnSync("/bin/ps", ["-axww", "-o", columns], { encoding: "utf8", timeout: 10_000 });
  if (listing.status !== 0)
    throw new Error(`ps -o ${columns} failed: ${listing.error?.message || listing.stderr || listing.status}`);
  return listing.stdout;
}

export function readAppProcesses(bundle: string): AppProcess[] {
  return parseAppProcesses(
    listProcesses("pid=,ppid=,etime=,stat=,comm="),
    listProcesses("pid=,command="),
    bundlePaths(bundle),
  );
}

/** Whether an app's main process has started a renderer, the process that draws a page. */
export function startedPage(processes: readonly AppProcess[]): boolean {
  const mains = new Set(processes.filter(({ kind }) => kind === "main").map(({ pid }) => pid));
  return processes.some(({ kind, ppid }) => kind === "renderer" && mains.has(ppid));
}

/**
 * What must end before the app is launched again: every process from its bundle but
 * ShipIt, which installs an update on its own schedule and then quits.
 */
export function lingering(processes: readonly AppProcess[]): AppProcess[] {
  return processes.filter(({ program }) => program !== "ShipIt");
}

export function describeProcesses(processes: readonly AppProcess[]): string {
  if (processes.length === 0) return "none";
  return processes
    .map(({ program, kind, pid, ppid, elapsed, state }) => `${program} (${kind}) ${pid} of ${ppid}, up ${elapsed}, ${state}`)
    .join("; ");
}

/**
 * The deepest frame the main thread was in for every one of a `sample` report's samples,
 * such as `mach_msg2_trap (in libsystem_kernel.dylib)` for a thread waiting on its event
 * loop; undefined when the report has no main thread.
 */
export function mainThreadFrame(report: string): string | undefined {
  const lines = report.split("\n");
  const start = lines.findIndex((line) => /^\s*\d+\s+Thread_\S+.*com\.apple\.main-thread/.test(line));
  if (start < 0) return undefined;
  const total = /^\s*(\d+)/.exec(lines[start] ?? "")?.[1];
  let frame: string | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\d+\s+Thread_/.test(line) || line.trim() === "") break;
    const match = /^[\s+!:|]*?(\d+)\s+(.+?)\s{2}\(in ([^)]+)\)/.exec(line);
    if (match && match[1] === total) frame = `${match[2]} (in ${match[3]})`;
  }
  return frame;
}

export function keepAppRecords(data: string, evidence: string, label: string): string[] {
  mkdirSync(evidence, { recursive: true });
  const kept: string[] = [];
  for (const name of APP_RECORDS) {
    if (!existsSync(join(data, name))) continue;
    copyFileSync(join(data, name), join(evidence, `${label}-${name}`));
    kept.push(`${label}-${name}`);
  }
  return kept;
}

/**
 * Remove a check's scratch home once the app has stopped; returns what is still there.
 *
 * The app's saved data (`saved`) must go: only the app writes there, and every process
 * from its bundle has ended. The rest of the home is shared with programs outside the
 * bundle that ran with the scratch home, such as macOS's own agents, and they write on
 * their own schedule. One alpha's update check passed every proof and still failed
 * because such a program wrote into the home while it was removed, which macOS answers
 * with ENOTEMPTY. That write leaves the home for the disposable Mac, and the answer names
 * each file or empty folder still there, relative to the home. Any other failure, or
 * saved data that came back, still throws.
 */
export function removeScratchHome(
  home: string,
  saved: readonly string[],
  remove: typeof rmSync = rmSync,
): string[] {
  for (const folder of saved) remove(folder, { recursive: true, force: true });
  try {
    remove(home, { recursive: true, force: true });
    return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  }
  const back = saved.filter((folder) => existsSync(folder));
  if (back.length)
    throw new Error(`The app's saved data came back while the scratch home was removed: ${back.join(", ")}`);
  if (!existsSync(home)) return [];
  let paths: string[];
  try {
    paths = readdirSync(home, { recursive: true, withFileTypes: true }).map((entry) =>
      relative(home, join(entry.parentPath, entry.name)),
    );
  } catch (error) {
    return [`what is left could not be listed: ${(error as Error).message}`];
  }
  const folders = new Set(paths.map((path) => dirname(path)));
  return paths.filter((path) => !folders.has(path)).sort();
}

/** Sample every thread of one process for three seconds, as root when the signed app refuses its own user. */
function sampleProcess(pid: number, file: string): string {
  const args = [String(pid), "3", "-file", file];
  let sampled = spawnSync("/usr/bin/sample", args, { encoding: "utf8", timeout: 60_000 });
  if (sampled.status !== 0)
    sampled = spawnSync("/usr/bin/sudo", ["-n", "/usr/bin/sample", ...args], { encoding: "utf8", timeout: 60_000 });
  if (sampled.status !== 0 || !existsSync(file))
    return `${pid} not sampled: ${(sampled.error?.message ?? sampled.stderr ?? "").trim() || `exit ${sampled.status}`}`;
  return `${pid}'s main thread throughout: ${mainThreadFrame(readFileSync(file, "utf8")) ?? "no main thread in the report"}`;
}

/**
 * Keep what the app was doing when a launch showed no page, as files in `evidence` named
 * for `label`, and return the facts read as one line for the failure:
 * - `-targets.json`: every target the app's inspector lists, of every kind, when it has one;
 * - `-processes.txt`: every process from the bundle, with its parent, age and state;
 * - `-sample-<pid>.txt`: every thread of each main process and renderer, sampled for three seconds;
 * - the app's own records of main-thread stalls and memory (`APP_RECORDS`);
 * - `-system.log`: five minutes of the system log for the processes named for the bundle.
 */
export async function keepNoPageEvidence({
  bundle,
  data,
  evidence,
  label,
  port,
}: {
  bundle: string;
  data: string;
  evidence: string;
  label: string;
  port?: string;
}): Promise<string> {
  mkdirSync(evidence, { recursive: true });
  const facts: string[] = [];
  if (port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) });
      const targets = (await response.json()) as { type?: string; url?: string }[];
      writeFileSync(join(evidence, `${label}-targets.json`), JSON.stringify(targets, null, 2));
      facts.push(`inspector targets: ${targets.map(({ type, url }) => `${type} ${url}`).join(", ") || "none"}`);
    } catch (error) {
      facts.push(`inspector targets unread: ${(error as Error).message}`);
    }
  }
  let processes: AppProcess[] = [];
  try {
    processes = readAppProcesses(bundle);
    writeFileSync(
      join(evidence, `${label}-processes.txt`),
      `${processes.map((process) => JSON.stringify(process)).join("\n")}\n`,
    );
    facts.push(`app processes: ${describeProcesses(processes)}`);
  } catch (error) {
    facts.push(`app processes unread: ${(error as Error).message}`);
  }
  for (const { pid } of processes.filter(({ kind }) => kind === "main" || kind === "renderer"))
    facts.push(sampleProcess(pid, join(evidence, `${label}-sample-${pid}.txt`)));
  facts.push(`app records kept: ${keepAppRecords(data, evidence, label).join(", ") || "none"}`);
  const system = spawnSync(
    "/usr/bin/log",
    ["show", "--last", "5m", "--style", "compact", "--predicate", `process BEGINSWITH "${basename(bundle, ".app")}"`],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(
    join(evidence, `${label}-system.log`),
    `${system.stdout ?? ""}${system.stderr ?? ""}${system.error ? `\n${system.error.message}` : ""}`,
  );
  return facts.join("; ");
}
