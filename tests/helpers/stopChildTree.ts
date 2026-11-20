import type { ChildProcess } from "node:child_process";
import { endHolder } from "../../src/core/placed/folderHolders";
import { type ProcessReading, readProcesses } from "../../src/core/placed/processResources";

/** Register at launch, so cleanup can await close even when the direct child exits on its own. */
export function trackChildTree(child: ChildProcess): () => Promise<void> {
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return async () => {
    await stopChildTree(child);
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
 * `processes` reads the table in place of the system's own reading.
 */
export async function stopChildTree(
  child: ChildProcess,
  options: { processes?: () => Promise<ProcessReading[] | null> } = {},
): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return;
  }
  const read = options.processes ?? readProcesses;
  const rows = await read();
  if (!rows) throw new Error("Could not read the journey child's process tree");
  const owned = new Set([child.pid]);
  for (const row of rows) if (row.group === child.pid) owned.add(row.pid);
  for (;;) {
    const before = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
    if (owned.size === before) break;
  }
  const targets = rows.filter((row) => owned.has(row.pid) && !row.exited);
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
