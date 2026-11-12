import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BrowserContext } from "@playwright/test";
import type { MockProviderServer } from "./mockProvider";
import { runDir } from "./runEvidence";

/** INF-909: diagnostics survive fixture cleanup inside the existing failure upload. */
export function launchDiagnostics(
  userDataDir: string,
  provider?: MockProviderServer,
  root = join(runDir(), "launches"),
) {
  mkdirSync(root, { recursive: true });
  const dir = join(root, `${process.pid}-${randomUUID()}`);
  mkdirSync(dir);
  writeFileSync(
    join(dir, "launch.json"),
    JSON.stringify({ userDataDir, worker: process.env.TEST_WORKER_INDEX }),
  );
  for (const file of ["main.stdout.log", "main.stderr.log", "provider.requests.jsonl"]) {
    writeFileSync(join(dir, file), "");
  }
  let sequence = 0;
  const stopRecording = provider?.recordRequests((body) => {
    appendFileSync(
      join(dir, "provider.requests.jsonl"),
      `${JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), body: JSON.parse(body) })}\n`,
    );
  });
  return {
    dir,
    watch(child: Pick<ChildProcess, "stdout" | "stderr">) {
      child.stdout?.on("data", (chunk: Buffer) =>
        appendFileSync(join(dir, "main.stdout.log"), chunk),
      );
      child.stderr?.on("data", (chunk: Buffer) =>
        appendFileSync(join(dir, "main.stderr.log"), chunk),
      );
    },
    snapshot() {
      // Only app-owned session diagnostics, never accounts, auth stores, or a whole HOME.
      const crew = join(userDataDir, "crewmates");
      if (!existsSync(crew)) return;
      for (const task of readdirSync(crew, { withFileTypes: true })) {
        if (!task.isDirectory()) continue;
        const sessions = join(crew, task.name, "sessions");
        if (!existsSync(sessions)) continue;
        const target = join(dir, "crewmates", task.name, "sessions");
        mkdirSync(target, { recursive: true });
        try {
          // A link (a staged skill) points into the disposable scratch; copied, it
          // would dangle once that is removed, and packaging stats every file.
          cpSync(sessions, target, {
            recursive: true,
            filter: (source) => !lstatSync(source).isSymbolicLink(),
          });
        } catch (error) {
          // Diagnostics must not replace the assertion or prevent app cleanup.
          appendFileSync(join(dir, "collection-errors.log"), `${task.name}: ${String(error)}\n`);
        }
      }
    },
    /**
     * On Linux, appends what each thread of the app's processes waits on
     * (`appThreads`), read while the app still runs: before its close, where
     * Playwright's failure picture waits for the window to draw.
     */
    threads(pid: number | undefined, moment: string) {
      if (process.platform !== "linux" || pid === undefined) return;
      try {
        appendFileSync(
          join(dir, "threads.txt"),
          `# ${moment}, ${new Date().toISOString()}\n${appThreads(pid)}\n`,
        );
      } catch (error) {
        appendFileSync(join(dir, "collection-errors.log"), `threads: ${String(error)}\n`);
      }
    },
    stop() {
      stopRecording?.();
    },
  };
}

type Stat = { comm: string; state: string; ppid: number };

/** One `stat` file of `/proc`: the name sits in parentheses and may hold spaces or parentheses. */
function readStat(path: string): Stat | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const close = text.lastIndexOf(")");
    const [state = "?", ppid = "0"] = text.slice(close + 2).split(" ");
    return { comm: text.slice(text.indexOf("(") + 1, close), state, ppid: Number(ppid) };
  } catch {
    return undefined;
  }
}

/**
 * A Chromium process's kind from its command line (`--type=gpu-process`); the
 * app's own is the browser. Chromium rewrites most of its processes' command
 * lines as one title separated by spaces, the zygote's keeps its NULs.
 */
function processKind(proc: string, pid: number, root: number, comm: string): string {
  if (pid === root) return "browser";
  try {
    const line = readFileSync(join(proc, String(pid), "cmdline"), "utf8");
    return /(?:^|[\s\0])--type=([^\s\0]+)/.exec(line)?.[1] ?? comm;
  } catch {
    return comm;
  }
}

/**
 * Every process of a launched app, and the virtual screen's
 * (`Xvfb`), with each thread's name, its state as Linux reports it (R
 * running, S sleeping, D waiting on a disk or device, T stopped) and the
 * kernel function it sleeps in (`wchan`, `0` when running or when Linux
 * keeps it from this user). A window whose drawing process stops raises no
 * error and leaves no picture: the map card's frame was never marked drawn
 * and Playwright's failure picture timed out, so this names the process and
 * thread that held it. Empty where there is no `/proc`.
 */
export function appThreads(root: number, proc = "/proc"): string {
  let names: string[];
  try {
    names = readdirSync(proc);
  } catch {
    return "";
  }
  const stats = new Map<number, Stat>();
  const children = new Map<number, number[]>();
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readStat(join(proc, name, "stat"));
    if (!stat) continue;
    const pid = Number(name);
    stats.set(pid, stat);
    const siblings = children.get(stat.ppid);
    if (siblings) siblings.push(pid);
    else children.set(stat.ppid, [pid]);
  }
  const shown: number[] = [];
  const queue = stats.has(root) ? [root] : [];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    shown.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  for (const [pid, stat] of stats) if (stat.comm === "Xvfb") shown.push(pid);
  const lines: string[] = [];
  for (const pid of shown) {
    lines.push(`${pid} ${processKind(proc, pid, root, stats.get(pid)?.comm ?? "?")}`);
    let tids: string[] = [];
    try {
      tids = readdirSync(join(proc, String(pid), "task"));
    } catch {
      // The process ended while it was read.
    }
    for (const tid of tids) {
      const task = join(proc, String(pid), "task", tid);
      const stat = readStat(join(task, "stat"));
      if (!stat) continue;
      let wchan = "?";
      try {
        wchan = readFileSync(join(task, "wchan"), "utf8").trim() || "0";
      } catch {
        // The thread ended while it was read.
      }
      lines.push(`  ${tid} ${stat.comm} ${stat.state} ${wchan}`);
    }
  }
  return lines.join("\n");
}

/** INF-1555 F16: Electron's context is not the runner's default traced browser context. */
export async function recordAppTrace(
  context: BrowserContext,
  path: string,
): Promise<() => Promise<void>> {
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  return () => context.tracing.stop({ path });
}
