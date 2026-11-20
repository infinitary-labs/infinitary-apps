import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ACTIVE_MARK_FILE, createActiveMarks, pacificDay } from "./activeMark";

// INF-4956's approved plan, piece 3: a copy's first answered feed read of each
// Pacific day carries "day", the first of a Pacific month "day, month", and
// the copy keeps only the last day and month it marked, written once the
// server answered.

/** A copy's marks with a clock the test moves. */
function copy(dataRoot = scratchDir("inf-active-mark-")) {
  const clock = { at: 0 };
  return { marks: createActiveMarks(dataRoot, () => clock.at), clock, dataRoot };
}

/** Takes the next mark and says the server answered it, as a feed read does. */
function read(marks: ReturnType<typeof createActiveMarks>): string | null {
  const mark = marks.next();
  mark?.answered();
  return mark?.value ?? null;
}

describe("the update check's active mark", () => {
  it("marks the first answered read of a Pacific day, and turns over at Pacific midnight", () => {
    const f = copy();
    // 11:59 PM on Nov 18 in Los Angeles (PST, UTC-8), then 12:00 AM on Nov 19.
    f.clock.at = Date.parse("2026-11-19T07:59:00Z");
    expect(read(f.marks)).toBe("day, month");
    expect(read(f.marks)).toBeNull();
    f.clock.at = Date.parse("2026-11-19T08:00:00Z");
    expect(read(f.marks)).toBe("day");
    f.clock.at = Date.parse("2026-11-20T07:59:59Z");
    expect(read(f.marks)).toBeNull();
  });

  it("adds the month on the first read of a new Pacific month", () => {
    const f = copy();
    f.clock.at = Date.parse("2026-11-30T20:00:00Z");
    expect(read(f.marks)).toBe("day, month");
    // Dec 1 in UTC is still Nov 30 in Los Angeles.
    f.clock.at = Date.parse("2026-12-01T07:30:00Z");
    expect(read(f.marks)).toBeNull();
    f.clock.at = Date.parse("2026-12-01T08:30:00Z");
    expect(read(f.marks)).toBe("day, month");
    f.clock.at = Date.parse("2026-12-02T18:00:00Z");
    expect(read(f.marks)).toBe("day");
  });

  it("follows Los Angeles across a daylight-saving change", () => {
    // Clocks went back at 2 AM PDT on Nov 1, 2026: Pacific midnight before it is UTC-7, after it UTC-8.
    expect(pacificDay(Date.parse("2026-11-01T06:59:00Z")).day).toBe("2026-10-31");
    expect(pacificDay(Date.parse("2026-11-01T07:00:00Z")).day).toBe("2026-11-01");
    expect(pacificDay(Date.parse("2026-11-02T07:59:00Z")).day).toBe("2026-11-01");
    expect(pacificDay(Date.parse("2026-11-02T08:00:00Z")).day).toBe("2026-11-02");
    const f = copy();
    f.clock.at = Date.parse("2026-11-01T06:59:00Z");
    expect(read(f.marks)).toBe("day, month");
    // An hour later in UTC is the first minute of Nov 1 there, a new day and month.
    f.clock.at = Date.parse("2026-11-01T07:00:00Z");
    expect(read(f.marks)).toBe("day, month");
    // The 25-hour day: 7:30 AM UTC on Nov 2 is still 11:30 PM on Nov 1.
    f.clock.at = Date.parse("2026-11-02T07:30:00Z");
    expect(read(f.marks)).toBeNull();
  });

  it("keeps the mark for the next read when the server never answered", () => {
    const f = copy();
    f.clock.at = Date.parse("2026-11-19T18:00:00Z");
    // The read failed: its mark is not spent, and nothing is kept.
    expect(f.marks.next()?.value).toBe("day, month");
    expect(readdirSync(f.dataRoot)).toEqual([]);
    expect(read(f.marks)).toBe("day, month");
    expect(read(f.marks)).toBeNull();
  });

  it("does not mark again after a relaunch the same day, and keeps only the day and month", () => {
    const first = copy();
    first.clock.at = Date.parse("2026-11-19T18:00:00Z");
    expect(read(first.marks)).toBe("day, month");
    const relaunched = copy(first.dataRoot);
    relaunched.clock.at = Date.parse("2026-11-19T23:00:00Z");
    expect(read(relaunched.marks)).toBeNull();
    expect(readdirSync(first.dataRoot)).toEqual([ACTIVE_MARK_FILE]);
    expect(JSON.parse(readFileSync(join(first.dataRoot, ACTIVE_MARK_FILE), "utf8"))).toEqual({
      schemaVersion: 1,
      day: "2026-11-19",
      month: "2026-11",
    });
  });

  it("reads a file it cannot understand as never marked", () => {
    const f = copy();
    writeFileSync(join(f.dataRoot, ACTIVE_MARK_FILE), "{not json");
    f.clock.at = Date.parse("2026-11-19T18:00:00Z");
    expect(read(f.marks)).toBe("day, month");
    expect(read(f.marks)).toBeNull();
  });
});
