import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/**
 * How large the panels' log grows before it moves aside: the file and the
 * one before it stay on disk, so the log never takes more than twice this.
 */
export const PANEL_LOG_MAX_BYTES = 1024 * 1024;

/** Where the log moves aside to: `panels.log` becomes `panels.old.log`, replacing the one before. */
export function panelLogAside(path: string): string {
  return path.endsWith(".log") ? `${path.slice(0, -".log".length)}.old.log` : `${path}.old`;
}

/**
 * The panels' log (docs/personal-panels.md, "The panel log"): one file in
 * the app's data folder (`AppPaths.panelLogPath`) that keeps every panel's
 * lines - what its code hands `context.log`, what its process prints, and
 * the host's own lines about it - whether the app has a window or not.
 * Each line starts with the time it was written; a message of several
 * lines keeps its later lines indented under the first.
 *
 * Its one writer is the home's personal setup (`personal/homePersonal.ts`).
 * A line is appended at once, so nothing is left to write when the app
 * quits. A line that cannot be written - the data folder gone, a full disk -
 * is dropped: the log never stops a panel or the app.
 */
export class PanelLog {
  /** What the file holds now, read once from disk and counted after. */
  private size: number | null = null;

  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(message: string): void {
    const text = `${this.now().toISOString()} ${message.replace(/\r?\n/g, "\n  ")}\n`;
    try {
      this.append(text);
    } catch {}
  }

  private append(text: string): void {
    this.size ??= sizeOf(this.path);
    try {
      appendFileSync(this.path, text, { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Only the log's own folder is made: a data folder that is gone stays gone.
      mkdirSync(dirname(this.path), { mode: 0o700 });
      appendFileSync(this.path, text, { mode: 0o600 });
    }
    this.size += Buffer.byteLength(text);
    if (this.size <= PANEL_LOG_MAX_BYTES) return;
    renameSync(this.path, panelLogAside(this.path));
    this.size = 0;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
