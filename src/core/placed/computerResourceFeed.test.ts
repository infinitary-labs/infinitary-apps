import type { LoadRun } from "@shared/load";
import { type ComputerResourcesView, RESOURCE_REFRESH_MS } from "@shared/resources";
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
      onComputers: () => () => {},
      onWork: (listener) => {
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

// INF-2420, approved on its card: a task change re-sent every computer's
// reading to every window. It re-sends only when crew work starts or a
// declared run moved, so a wait in the line still shows at once.
describe("what a task change re-sends", () => {
  it("sends when crew work starts or a declared run moves, and nothing for other task writes", async () => {
    vi.useFakeTimers();
    let working = false;
    let worked = () => {};
    let runs: LoadRun[] = [];
    const sent: ComputerResourcesView[] = [];
    const feed = new ComputerResourceFeed({
      resources: {
        read: () => ({ status: "unknown", reason: "missing" }),
        refresh: async () => ({ status: "unknown", reason: "missing" }),
        sampledAt: () => undefined,
      },
      computers: () => [{ computerId: null, label: "This computer" }],
      onComputers: () => () => {},
      onWork: (listener) => {
        worked = listener;
        return () => {};
      },
      onContact: () => () => {},
      working: () => working,
      load: () => ({ status: "fresh", runs }),
      emit: (view) => sent.push(view),
      now: () => Date.now(),
    });
    try {
      worked();
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(0);

      working = true;
      worked();
      await vi.advanceTimersByTimeAsync(0);
      const started = sent.length;
      expect(started).toBeGreaterThan(0);

      for (let write = 0; write < 10; write++) worked();
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(started);

      const waiting: LoadRun = {
        id: "9b2f4c1e-6a3d-4e8b-9f17-2c5d8a0e4b61",
        taskId: "eed0fad6",
        demand: { cpu: 4, memoryBytes: 8 * 1024 ** 3 },
        state: "waiting",
        ahead: 1,
        reason: "line",
      };
      runs = [waiting];
      worked();
      expect(sent).toHaveLength(started + 1);
      expect(sent.at(-1)?.computers[0]?.load?.runs).toEqual([waiting]);
    } finally {
      feed.dispose();
      vi.useRealTimers();
    }
  });
});
