import { describe, expect, it } from "vitest";
import {
  checksDuration,
  checksFinishedAgo,
  checksRestWords,
  checksSpanOf,
  checksSpanWords,
} from "./checksSpan";

// The captain's ask (INF-587): the checks cell says how long the checks have
// been running, or took, rather than when the app last read them. The times
// are main's own checks on a0cf68a2, as GitHub gave them.
const started = Date.parse("2026-10-20T03:30:47Z");
const finished = Date.parse("2026-10-20T03:34:25Z");
const read = Date.parse("2026-10-20T03:40:02Z");

describe("the checks cell's time", () => {
  it("counts running checks from the first start, and finished ones to their finish", () => {
    const running = checksSpanOf({ ci: "pending", ciStartedAt: started });
    expect(running && checksSpanWords("running", running, started + 15 * 60_000)).toBe(
      "running for 15m",
    );
    const passed = checksSpanOf({ ci: "green", ciStartedAt: started, ciFinishedAt: finished });
    // Long after they finished, they still took what they took.
    expect(passed && checksSpanWords("passed", passed, read)).toBe("passed in 3m");
    const failed = checksSpanOf({ ci: "red", ciStartedAt: started, ciFinishedAt: finished });
    expect(failed && checksSpanWords("failed", failed, read)).toBe("failed after 3m");
  });

  it("shows no time where none stands", () => {
    // Checks that have not started, a reading with no finish, merged elsewhere, not read.
    expect(checksSpanOf({ ci: "pending" })).toBeNull();
    expect(checksSpanOf({ ci: "green", ciStartedAt: started })).toBeNull();
    expect(checksSpanOf({ ci: "merged", ciStartedAt: started, ciFinishedAt: finished })).toBeNull();
    expect(checksSpanOf({})).toBeNull();
  });

  it("says how long ago finished checks finished", () => {
    expect(checksFinishedAgo(finished, finished + 5 * 60_000)).toBe("5m ago");
    expect(checksFinishedAgo(finished, finished + 20_000)).toBe("just now");
  });

  it("says whole minutes", () => {
    expect(checksDuration(40_000)).toBe("under 1m");
    expect(checksDuration(15 * 60_000 + 59_000)).toBe("15m");
    expect(checksDuration(65 * 60_000)).toBe("1h 05m");
  });

  it("puts the start and the last reading on rest, either part only where it is known", () => {
    const span = checksSpanOf({ ci: "pending", ciStartedAt: started });
    expect(checksRestWords(span, read)).toMatch(
      /^Started \d{1,2}:\d{2}\S* ?\S* · read \d{1,2}:\d{2}/,
    );
    expect(checksRestWords(null, read)).toMatch(/^Read \d{1,2}:\d{2}/);
    expect(checksRestWords(null, null)).toBe("");
  });
});
