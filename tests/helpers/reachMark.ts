import { readFileSync, watch, writeFileSync } from "node:fs";

/**
 * A mark another process sets when it reaches a step, and a promise that
 * resolves once it has: the mark is made here, empty, and that process
 * appends to it (`printf reached >> "$mark"`), so the step is reached once
 * the mark holds anything.
 *
 * It watches the mark itself, never the folder it is in (INF-2578). On macOS
 * a folder's watch is FSEvents, which held a new file's event past a test's
 * whole budget, or dropped it, while other unit rounds churned the disk; a
 * file's watch is kqueue there and inotify on Linux, which keep every change
 * to that file. The mark is read once more after the watch is in place, so a
 * process that appended before then is seen too.
 */
export function reachMark(mark: string): Promise<void> {
  writeFileSync(mark, "", { flag: "wx" });
  return new Promise((resolve) => {
    const watcher = watch(mark);
    const look = () => {
      let held: string;
      try {
        held = readFileSync(mark, "utf8");
      } catch {
        // The test's scratch folder went once its file finished.
        watcher.close();
        return;
      }
      if (held === "") return;
      watcher.close();
      resolve();
    };
    watcher.on("change", look);
    watcher.on("error", () => watcher.close());
    // The event loop's next poll puts the watch in place; two turns on, one has.
    setImmediate(() => setImmediate(look));
  });
}
