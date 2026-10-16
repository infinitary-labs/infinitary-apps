import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The variable a GitHub Actions runner finds a job's processes by at the job's end. */
const RUNNER_TRACKING_ID = "RUNNER_TRACKING_ID";

// One watcher per worker, however many times a runner re-imports this module.
const KEY = Symbol.for("infinitary.tests.workerApps");
const holder = globalThis as { [KEY]?: ChildProcess };

/**
 * Every app a Playwright worker launches stops when that worker ends, however
 * it ends.
 *
 * Playwright stops a worker's apps from the worker's own exit handlers, which
 * a killed worker never runs, and it starts each app in a process group of
 * its own, so nothing else reaches the app either. A cancelled CI job on a
 * self-hosted runner ends that way: the runner stops only the step's shell,
 * the run goes on, and at the job's end the runner kills the job's processes
 * one at a time from a list it took first, apps before workers. An app a
 * worker launches in those seconds is on no list and runs on with no parent;
 * two cancelled Mac jobs left four, one of them busy on a whole core for a day.
 *
 * So each worker keeps one small watcher process (`workerAppsWatcher.cjs`)
 * on the other end of a pipe. A launch names the app's user-data folder to
 * it before the app starts; when the pipe closes because the worker has
 * exited, the watcher stops every process still running with one of those
 * folders. The watcher does not carry the runner's tracking variable, so the
 * runner's own cleanup never stops it before the worker it watches.
 */
export function stopWithWorker(userDataDir: string): void {
  if (process.platform === "win32") return;
  holder[KEY] ??= startWatcher();
  holder[KEY].stdin?.write(`${userDataDir}\n`);
}

function startWatcher(): ChildProcess {
  const env = { ...process.env };
  delete env[RUNNER_TRACKING_ID];
  const watcher = spawn(
    process.execPath,
    [fileURLToPath(new URL("./workerAppsWatcher.cjs", import.meta.url))],
    // A group of its own: a signal to the run's group stops the run, never the
    // watcher ahead of it.
    { detached: true, stdio: ["pipe", "ignore", "ignore"], env },
  );
  // Neither the watcher nor its pipe keeps the worker running, and a watcher
  // already gone costs the worker nothing.
  watcher.unref();
  watcher.stdin?.on("error", () => {});
  (watcher.stdin as { unref?: () => void } | null)?.unref?.();
  return watcher;
}
