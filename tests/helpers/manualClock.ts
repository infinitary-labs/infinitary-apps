import type { SessionClock } from "../../src/core/session/bounds";

export type ManualClock = SessionClock & {
  /** Moves the clock on by `ms`, then runs every registration once: one tick. */
  advance: (ms: number) => void;
  /** The names registered on it now, in the order they registered. */
  registrations: () => string[];
};

/**
 * The host's one clock (the ticker's `now` and `register`) with nothing
 * running it: a test moves it with `advance`, and each advance is one tick
 * of every registration, whatever its cadence. A bound is a tick past its
 * due time, never a wall-clock wait.
 */
export function manualClock(start = 1_000_000): ManualClock {
  let now = start;
  const runs = new Map<string, (now: number) => void>();
  return {
    now: () => now,
    register: (name, _cadenceMs, run) => {
      if (runs.has(name)) throw new Error(`The clock already runs "${name}".`);
      runs.set(name, run);
      return () => {
        runs.delete(name);
      };
    },
    advance: (ms) => {
      now += ms;
      for (const run of [...runs.values()]) run(now);
    },
    registrations: () => [...runs.keys()],
  };
}
