import { RESOURCE_REFRESH_MS } from "@shared/resources";
import { describe, expect, it, vi } from "vitest";
import { ComputerResourceFeed } from "./computerResourceFeed";

// INF-1621 piece 1: crew work, not a screen, must keep the shared reading alive.
describe("resource demand while crew work exists", () => {
  it("starts on task activity, shares the screen cadence, and stops when both demands end", async () => {
    vi.useFakeTimers();
    let working = false;
    let changed = () => {};
    let samples = 0;
    const feed = new ComputerResourceFeed({
      resources: {
        read: () => ({ status: "unknown", reason: "missing" }),
        refresh: async () => {
          samples++;
          return { status: "unknown", reason: "missing" };
        },
        sampledAt: () => undefined,
      },
      computers: () => [{ computerId: null, label: "This computer" }],
      onComputers: (listener) => {
        changed = listener;
        return () => {};
      },
      onContact: () => () => {},
      working: () => working,
      emit: () => {},
      now: () => Date.now(),
    });
    try {
      await vi.advanceTimersByTimeAsync(RESOURCE_REFRESH_MS);
      expect(samples).toBe(0);
      working = true;
      changed();
      await vi.advanceTimersByTimeAsync(RESOURCE_REFRESH_MS);
      expect(samples).toBe(2);
      working = false;
      await vi.advanceTimersByTimeAsync(RESOURCE_REFRESH_MS * 2);
      expect(samples).toBe(2);
    } finally {
      feed.dispose();
      vi.useRealTimers();
    }
  });
});
