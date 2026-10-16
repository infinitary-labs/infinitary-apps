import { MIN_BACKGROUND_INTERVAL_MS } from "@shared/personal/manifest";
import { describe, expect, it, vi } from "vitest";
import { loadServerHost } from "./serverHost";

function context(log: string[] = []) {
  const kv = new Map<string, unknown>();
  return {
    id: "clock",
    db: {
      get: (key: string) => kv.get(key) as never,
      set: (key: string, value: unknown) => void kv.set(key, value),
      delete: (key: string) => void kv.delete(key),
      list: () =>
        [...kv.entries()].map(([key, value]) => ({ key, value: value as never, updatedAt: 0 })),
    },
    log: (message: string) => log.push(message),
    sql: async () => ({ refused: "sql_view_not_declared" as const, message: "no grant" }),
    kv,
  };
}

describe("loadServerHost", () => {
  it("invokes a named action with the bound context and refuses an unknown one by name", async () => {
    const ctx = context();
    const host = await loadServerHost({
      extensionId: "clock",
      entryPath: "/nowhere/server.mjs",
      context: ctx,
      importModule: async () => ({
        actions: {
          bump: (input: unknown, c: typeof ctx) => {
            c.db.set("n", (input as number) + 1);
            return c.db.get("n");
          },
          notAFunction: 3,
        },
      }),
    });
    expect(host.actions).toEqual(["bump"]);
    expect(await host.invoke("bump", 1)).toBe(2);
    await expect(host.invoke("nope", null)).rejects.toThrow(
      '"clock" has no action "nope" (it has bump)',
    );
    host.dispose();
  });

  it("clamps a background cadence under the floor, runs on start, never overlaps, and logs a throw", async () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const ctx = context(log);
      let runs = 0;
      let release: () => void = () => {};
      const host = await loadServerHost({
        extensionId: "clock",
        entryPath: "/nowhere/server.mjs",
        context: ctx,
        importModule: async () => ({
          background: {
            fast: {
              everyMs: 1_000,
              run: () =>
                new Promise<void>((r) => {
                  runs += 1;
                  release = r;
                }),
            },
            slow: {
              everyMs: 300_000,
              runOnStart: false,
              run: () => {
                throw new Error("boom");
              },
            },
            malformed: { everyMs: -1, run: () => {} },
          },
        }),
      });
      expect(host.background).toEqual([
        { id: "fast", everyMs: MIN_BACKGROUND_INTERVAL_MS, declaredMs: 1_000 },
        { id: "slow", everyMs: 300_000, declaredMs: 300_000 },
      ]);
      // runOnStart (the default) ran `fast` once, immediately.
      expect(runs).toBe(1);
      // A second tick arrives while the first run is still in flight: skipped.
      await vi.advanceTimersByTimeAsync(MIN_BACKGROUND_INTERVAL_MS);
      expect(runs).toBe(1);
      release();
      await vi.advanceTimersByTimeAsync(MIN_BACKGROUND_INTERVAL_MS);
      expect(runs).toBe(2);
      // The declared 1s cadence did not fire 60 times: it was clamped.
      release();
      await vi.advanceTimersByTimeAsync(300_000 - 2 * MIN_BACKGROUND_INTERVAL_MS);
      expect(log).toEqual(['background task "slow" failed: boom']);
      host.dispose();
      release();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(runs).toBeLessThanOrEqual(6);
      expect(log).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
