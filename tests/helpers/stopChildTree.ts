import type { ChildProcess } from "node:child_process";
import { endHolder } from "../../src/core/placed/folderHolders";
import { type ProcessReading, readProcesses } from "../../src/core/placed/processResources";
import { prefixesOf, readWorkingFolders, under } from "../../src/core/placed/workingFolders";

/** What a journey child's stop reads in place of the system's own readings. */
export type ChildTreeReadings = {
  processes?: () => Promise<ProcessReading[] | null>;
  workingFolders?: (pids: readonly number[]) => Promise<Map<number, string> | null>;
};

/**
 * Register at launch, so cleanup can await close even when the direct child
 * exits on its own. `folder` is the working folder the child was started in,
 * made for it alone.
 */
export function trackChildTree(child: ChildProcess, folder?: string): () => Promise<void> {
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return async () => {
    await stopChildTree(child, { folder });
    await closed;
  };
}

/** How often a reading checks again on a program still listed after its kill. */
const POLL_MS = 100;

/**
 * A journey's own detached child group, plus descendants that opened another
 * group (the work app's display keeper does). Snapshot them before ending
 * their parent, or the system adopts them and the tree loses its owner.
 * Group members still belong to the fixture after the direct child exits.
 *
 * A descendant in a session of its own whose parent already ended on its
 * own was adopted before any snapshot: the work app's update leaves its
 * watcher (src/core/helper/updateTrial.ts) that way as its run ends. Every
 * program inherits its parent's working folder, so with `folder`, the one
 * the child was started in, a program still working there belongs to the
 * tree too. Programs keep starting while others end - the watcher starts a
 * `sleep` each second - so the stop reads again after each pass and returns
 * only once a reading finds nothing of the tree.
 */
export async function stopChildTree(
  child: ChildProcess,
  options: ChildTreeReadings & { folder?: string } = {},
): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return;
  }
  const read = options.processes ?? readProcesses;
  const prefixes = options.folder ? await prefixesOf([options.folder]) : [];
  for (;;) {
    const targets = await treeOf(child.pid, read, prefixes, options.workingFolders);
    if (targets.length === 0) return;
    await endAll(targets, read);
  }
}

/** The tree's programs still running: the child, its group, what works in its folder, and their descendants. */
async function treeOf(
  pid: number,
  read: () => Promise<ProcessReading[] | null>,
  prefixes: readonly string[],
  workingFolders = readWorkingFolders,
): Promise<ProcessReading[]> {
  const rows = await read();
  if (!rows) throw new Error("Could not read the journey child's process tree");
  const owned = new Set([pid]);
  for (const row of rows) if (row.group === pid) owned.add(row.pid);
  if (prefixes.length > 0) {
    const folders = await workingFolders(rows.map((row) => row.pid));
    if (!folders) throw new Error(`Could not read where journey child ${pid}'s programs work`);
    for (const [holder, folder] of folders) if (under(folder, prefixes)) owned.add(holder);
  }
  for (;;) {
    const before = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
    if (owned.size === before) break;
  }
  return rows.filter((row) => owned.has(row.pid) && !row.exited);
}

async function endAll(
  targets: readonly ProcessReading[],
  read: () => Promise<ProcessReading[] | null>,
): Promise<void> {
  const outcomes = await Promise.all(
    targets.map((row) =>
      endHolder(
        { pid: row.pid, started: row.started, name: "journey child" },
        { graceMs: 0, processes: read },
      ),
    ),
  );
  // endHolder counts a program still listed two seconds after its kill as
  // surviving. A kill cannot be refused, but the system lists the program
  // until it finishes ending: a work app killed while its quit waits on a
  // disk flush stays listed until the flush completes, about two seconds on
  // a Linux runner and longer under load. The claim here is the order: no
  // journey child is left once cleanup returns. So cleanup waits for each
  // one's end, killing it again while its birth reads the same, and the
  // test's own timeout catches one that never ends, its log naming the child
  // it waited on.
  await Promise.all(
    targets
      .filter((_, index) => outcomes[index]?.outcome === "survived")
      .map((row) => ended(row, read)),
  );
}

async function ended(
  target: ProcessReading,
  read: () => Promise<ProcessReading[] | null>,
): Promise<void> {
  process.stderr.write(
    `Journey child ${target.pid} outlasted the kill window; waiting for its end\n`,
  );
  for (;;) {
    const rows = await read();
    if (!rows) throw new Error(`Could not read whether journey child ${target.pid} ended`);
    const row = rows.find((candidate) => candidate.pid === target.pid);
    if (!row || row.exited || row.started !== target.started) return;
    try {
      process.kill(target.pid, "SIGKILL");
    } catch {
      /* Ended between the reading and the kill; the next reading says so. */
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
