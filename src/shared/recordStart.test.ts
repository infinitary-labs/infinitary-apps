import { describe, expect, it } from "vitest";
import { inLanguage } from "./i18n/current";
import { type RecordStartInput, recordStartOf } from "./recordStart";

const NOW = 1_000_000;

function task(overrides: Partial<RecordStartInput> = {}): RecordStartInput {
  return { activity: null, startedAt: null, ...overrides };
}

const preparing = (ago: number) => task({ startAttempt: { phase: "preparing", since: NOW - ago } });

describe("what the record says of a task's start", () => {
  it("leaves the shared status's reason to a task with no start in flight and none failed", () => {
    expect(recordStartOf(task(), NOW)).toEqual({ reason: null, notice: null });
    expect(recordStartOf(task({ activity: "running", startedAt: NOW - 60_000 }), NOW)).toEqual({
      reason: null,
      notice: null,
    });
  });

  it("says nothing of its own while a start has prepared under 15 seconds", () => {
    expect(recordStartOf(preparing(14_999), NOW)).toEqual({ reason: null, notice: null });
  });

  it("says it is still starting from 15 seconds on, from the attempt's own time", () => {
    for (const ago of [15_000, 40_000]) {
      expect(recordStartOf(preparing(ago), NOW)).toEqual({
        reason: "Still starting. You can keep working.",
        notice: null,
      });
    }
  });

  it("times a crewmate still starting with no attempt from when the task started", () => {
    const starting = (startedAt: number | null) => task({ activity: "starting", startedAt });
    expect(recordStartOf(starting(NOW - 20_000), NOW).reason).toBe(
      "Still starting. You can keep working.",
    );
    expect(recordStartOf(starting(NOW - 5_000), NOW).reason).toBeNull();
    expect(recordStartOf(starting(null), NOW).reason).toBeNull();
  });

  it("says it is checking whether the start began, however long that has taken", () => {
    for (const ago of [1_000, 40_000]) {
      expect(
        recordStartOf(task({ startAttempt: { phase: "checking", since: NOW - ago } }), NOW),
      ).toEqual({ reason: "Checking whether it started", notice: null });
    }
  });

  it("says why a start could not begin in the bar and leaves the pill's reason empty", () => {
    expect(
      recordStartOf(task({ startNotice: { reason: "No crewmate could start." } }), NOW),
    ).toEqual({ reason: "", notice: "Could not start. No crewmate could start." });
  });

  it("words the notice and the start's reason in the process's language", () => {
    const failed = task({ startNotice: { reason: "its working copy could not be made" } });
    expect(inLanguage("de", () => recordStartOf(failed, NOW).notice)).toBe(
      "Konnte nicht starten. its working copy could not be made",
    );
    expect(inLanguage("de", () => recordStartOf(preparing(20_000), NOW).reason)).toBe(
      "Startet noch. Du kannst weiterarbeiten.",
    );
  });
});
