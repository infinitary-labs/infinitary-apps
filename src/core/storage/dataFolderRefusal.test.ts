import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { dataFolderRefusal } from "./dataFolderRefusal";
import { acquireMoveLock, moveLockPathFor } from "./moveLock";
import { RETIRED_PROFILE_MARKER, RETIRED_PROFILE_TITLE } from "./retiredProfile";

function folderBeside(): { appData: string; data: string } {
  const appData = scratchDir("fm-data-refusal-");
  const data = join(appData, "firstmate-3000");
  mkdirSync(data);
  return { appData, data };
}

describe("refusing a data folder before it opens", () => {
  it("opens a folder with neither a marker nor a move", () => {
    expect(dataFolderRefusal(folderBeside().data)).toBeNull();
  });

  it("refuses a folder that moved to Infinitary, whatever the marker holds", () => {
    const { data } = folderBeside();
    writeFileSync(join(data, RETIRED_PROFILE_MARKER), "not even json");
    expect(dataFolderRefusal(data)?.title).toBe(RETIRED_PROFILE_TITLE);
  });

  it("refuses a folder while a move holds its lock, and opens it once the move is over", () => {
    const { data } = folderBeside();
    const lock = moveLockPathFor(data);
    expect(acquireMoveLock(lock)).toBe(true);
    expect(dataFolderRefusal(data)?.next).toBe("You can close this window.");
    writeFileSync(
      lock,
      `${JSON.stringify({ schemaVersion: 1, pid: 2147483646, startedAt: "t" })}\n`,
    );
    expect(dataFolderRefusal(data)).toBeNull();
  });
});
