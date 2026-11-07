import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { appPathsFor } from "../paths";
import { PANEL_LOG_MAX_BYTES, PanelLog, panelLogAside } from "./panelLog";

// INF-2817: in the windowed app a panel's log lines went to a console nobody
// kept, so a refused save looked like GitHub had stopped answering. The
// panels' log is a file a person or a crewmate reads; these are its bounds.

/** A line as a panel writes one: the host's prefix, then the panel's own words. */
const REFUSED_SAVE =
  'personal rolling-alpha: Rolling alpha could not save its iOS reading (119 bytes): Error: writing "ios" would take the store past 1048576 bytes';

const at = new Date("2026-11-06T08:57:00.000Z");

describe("the panels' log", () => {
  it("keeps each line with its time, indents a message's later lines, and makes its own folder", () => {
    const path = appPathsFor(scratchDir("infinitary-panel-log-")).panelLogPath;
    const log = new PanelLog(path, () => at);
    log.write(REFUSED_SAVE);
    log.write(
      "personal rolling-alpha: stderr: Error: store went away\n    at save (server.ts:12:5)",
    );
    expect(readFileSync(path, "utf8")).toBe(
      `${at.toISOString()} ${REFUSED_SAVE}\n` +
        `${at.toISOString()} personal rolling-alpha: stderr: Error: store went away\n` +
        "      at save (server.ts:12:5)\n",
    );
  });

  it("drops a line whose data folder is gone, without making it again", () => {
    const userData = join(scratchDir("infinitary-panel-log-gone-"), "removed");
    const log = new PanelLog(appPathsFor(userData).panelLogPath, () => at);
    expect(() => log.write(REFUSED_SAVE)).not.toThrow();
    expect(existsSync(userData)).toBe(false);
  });

  it("moves aside past its bound, counting what an earlier launch left, and keeps the newest lines", () => {
    const path = appPathsFor(scratchDir("infinitary-panel-log-bound-")).panelLogPath;
    const line = `${at.toISOString()} ${REFUSED_SAVE}\n`;
    // An earlier launch left the file one line short of its bound.
    new PanelLog(path, () => at).write("personal: an earlier launch's first line");
    const earlier = readFileSync(path, "utf8");
    const filler = line.repeat(
      Math.floor((PANEL_LOG_MAX_BYTES - Buffer.byteLength(earlier)) / line.length),
    );
    writeFileSync(path, earlier + filler);

    const log = new PanelLog(path, () => at);
    log.write(REFUSED_SAVE);
    log.write("personal: the first line after the move");

    const aside = readFileSync(panelLogAside(path), "utf8");
    expect(aside.startsWith(earlier)).toBe(true);
    expect(aside.endsWith(line)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(
      `${at.toISOString()} personal: the first line after the move\n`,
    );
  });
});
