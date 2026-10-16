import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { acquireMoveLock, moveLockHeld, moveLockPathFor, releaseMoveLock } from "./moveLock";

// A process id no machine hands out: signalling it finds no process.
const DEAD_PID = 2147483646;

describe("the move lock", () => {
  it("sits beside the data folder, never inside it", () => {
    const appData = scratchDir("fm-move-lock-");
    const data = join(appData, "firstmate-3000");
    expect(moveLockPathFor(data)).toBe(join(appData, "firstmate-3000.move-lock"));
  });

  it("is not held when nothing is there", () => {
    const lock = join(scratchDir("fm-move-lock-"), "x.move-lock");
    expect(moveLockHeld(lock)).toBe(false);
  });

  it("is held by a live move, and a second move cannot take it", () => {
    const lock = join(scratchDir("fm-move-lock-"), "x.move-lock");
    expect(acquireMoveLock(lock)).toBe(true);
    expect(moveLockHeld(lock)).toBe(true);
    expect(acquireMoveLock(lock, process.pid + 1)).toBe(false);
  });

  it("is stale once its process is gone, and a new move takes it", () => {
    const lock = join(scratchDir("fm-move-lock-"), "x.move-lock");
    writeFileSync(lock, `${JSON.stringify({ schemaVersion: 1, pid: DEAD_PID, startedAt: "t" })}\n`);
    expect(moveLockHeld(lock)).toBe(false);
    expect(acquireMoveLock(lock)).toBe(true);
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
  });

  it("holds when it cannot be read, rather than guessing the move is over", () => {
    const lock = join(scratchDir("fm-move-lock-"), "x.move-lock");
    writeFileSync(lock, "{ not json");
    expect(moveLockHeld(lock)).toBe(true);
  });

  it("is released only by the process that holds it", () => {
    const lock = join(scratchDir("fm-move-lock-"), "x.move-lock");
    acquireMoveLock(lock);
    releaseMoveLock(lock, process.pid + 1);
    expect(moveLockHeld(lock)).toBe(true);
    releaseMoveLock(lock);
    expect(moveLockHeld(lock)).toBe(false);
  });
});
