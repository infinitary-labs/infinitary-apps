import type { ChildProcess } from "node:child_process";
import { endHolder } from "../../src/core/placed/folderHolders";
import { readProcesses } from "../../src/core/placed/processResources";

/** Register at launch, so cleanup can await close even when the direct child exits on its own. */
export function trackChildTree(child: ChildProcess): () => Promise<void> {
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return async () => {
    await stopChildTree(child);
    await closed;
  };
}

/**
 * A journey's own detached child group, plus descendants that opened another
 * group (the work app's display keeper does). Snapshot them before ending
 * their parent, or the system adopts them and the tree loses its owner.
 * Group members still belong to the fixture after the direct child exits.
 */
export async function stopChildTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return;
  }
  const rows = await readProcesses();
  if (!rows) throw new Error("Could not read the journey child's process tree");
  const owned = new Set([child.pid]);
  for (const row of rows) if (row.group === child.pid) owned.add(row.pid);
  for (;;) {
    const before = owned.size;
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
    if (owned.size === before) break;
  }
  const outcomes = await Promise.all(
    rows
      .filter((row) => owned.has(row.pid) && !row.exited)
      .map((row) =>
        endHolder({ pid: row.pid, started: row.started, name: "journey child" }, { graceMs: 0 }),
      ),
  );
  const survived = outcomes.filter((outcome) => outcome.outcome === "survived");
  if (survived.length)
    throw new Error(`Journey children survived cleanup: ${survived.map((p) => p.pid).join(", ")}`);
}
