import { stripRounds } from "@shared/conversation";
import type { LastTurn } from "@shared/lastTurn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fadeDurationMs,
  fadeKey,
  getFade,
  READING_MS,
  replyAnnouncementKey,
  syncFade,
} from "./lastTurnFade";

// The captain's added request on INF-1969: fade 15 seconds after becoming
// second-to-last, not after the newest reply. These are the two rounds from
// the real-provider-stand-in reproduction; only the window's clock is virtual.
const turn: LastTurn = {
  you: "salute me, keep the newest turn working",
  reply: null,
  previous: {
    you: "salute me, keep my earlier clue visible",
    reply: { text: "The crew has it under way.", eligibility: "completed" },
  },
};

/** The strip the window draws from these messages alone, `seq` the newest's place. */
const strip = (shown: LastTurn, seq: number) =>
  stripRounds({ turn: shown, seq, page: null, limit: 2 });

describe("the second-to-last round's reading clock", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.stubGlobal("window", globalThis);
    syncFade(null, false);
  });
  afterEach(() => {
    syncFade(null, false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts when a previous round exists and never restarts for a newest reply", () => {
    expect(fadeKey(strip({ ...turn, previous: null }, 1))).toBeNull();
    const key = fadeKey(strip(turn, 2));
    syncFade(key, true);
    vi.advanceTimersByTime(READING_MS / 2);
    const answered: LastTurn = {
      ...turn,
      reply: { text: "The crew has it under way.", eligibility: "completed" },
    };
    expect(fadeKey(strip(answered, 2))).toBe(key);
    syncFade(fadeKey(strip(answered, 2)), true);
    vi.advanceTimersByTime(READING_MS / 2 - 1);
    expect(getFade().phase).toBe("shown");
    vi.advanceTimersByTime(1);
    expect(getFade().phase).toBe("fading");
    vi.advanceTimersByTime(fadeDurationMs());
    expect(getFade().phase).toBe("hidden");
  });

  it("does not depend on the newest reply's status or the older reply's eligibility", () => {
    const key = fadeKey(strip(turn, 2));
    for (const reply of [
      null,
      { text: "Noted" },
      { text: "Your message is waiting", eligibility: "queued" as const },
      { text: "Something went wrong", problem: true },
    ]) {
      expect(fadeKey(strip({ ...turn, reply }, 2))).toBe(key);
      expect(
        fadeKey(strip({ ...turn, previous: { you: turn.previous?.you ?? "", reply } }, 2)),
      ).toBe(key);
    }
    // A different message starts a new interval even when its words repeat.
    syncFade(key, true);
    vi.advanceTimersByTime(READING_MS);
    syncFade(fadeKey(strip(turn, 3)), true);
    expect(getFade()).toMatchObject({ phase: "shown", remainingMs: READING_MS });
  });

  it("keeps the remainder while the older round cannot be read, without reviving a hidden round", () => {
    const key = fadeKey(strip(turn, 2));
    syncFade(key, true);
    vi.advanceTimersByTime(READING_MS / 2);
    syncFade(key, false);
    expect(getFade().remainingMs).toBe(READING_MS / 2);
    vi.advanceTimersByTime(READING_MS * 2);
    expect(getFade().phase).toBe("shown");
    syncFade(key, true);
    vi.advanceTimersByTime(READING_MS / 2 + fadeDurationMs());
    expect(getFade().phase).toBe("hidden");
    syncFade(key, false);
    syncFade(key, true);
    expect(getFade().phase).toBe("hidden");
  });

  it("keeps newest-reply announcement identity separate from the older round", () => {
    expect(replyAnnouncementKey(turn, 1)).toBeNull();
    const answered: LastTurn = {
      ...turn,
      reply: { text: "The crew has it under way.", eligibility: "completed" },
    };
    expect(replyAnnouncementKey(answered, 2)).toBe(
      replyAnnouncementKey({ ...answered, previous: null }, 2),
    );
    expect(replyAnnouncementKey(answered, 3)).not.toBe(replyAnnouncementKey(answered, 2));
    expect(fadeKey(strip(answered, 2))).toBe(fadeKey(strip(turn, 2)));
  });
});
