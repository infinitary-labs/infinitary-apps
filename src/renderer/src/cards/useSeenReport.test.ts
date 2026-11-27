import { PROTOCOL_VERSION } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportDrawnUpdate, reportWhileHere, type Touches } from "./useSeenReport";

// INF-2022: an updated desktop against an older home must send no unsupported request.
const drawn = {
  id: "card-findings",
  offerId: "findings-offer",
  lifecycleId: "findings-life",
  currentUpdateId: "released-answer",
};

describe("drawn update request compatibility", () => {
  it("uses only the legacy two-argument sighting when the home did not advertise shared marks", async () => {
    const seen = vi.fn(async () => ({ ok: true as const }));
    const seenUpdate = vi.fn(async () => {
      throw new Error("Unsupported request");
    });
    await reportDrawnUpdate(drawn, {}, { seen, seenUpdate });
    await reportDrawnUpdate(
      drawn,
      { protocolVersion: "12.0.0", changes: ["another-change"] },
      { seen, seenUpdate },
    );
    expect(seen.mock.calls).toEqual([
      [drawn.id, drawn.offerId],
      [drawn.id, drawn.offerId],
    ]);
    expect(seenUpdate).not.toHaveBeenCalled();
  });

  it("uses the exact released identifier only when supported, never falling back for an unidentified update", async () => {
    const seen = vi.fn(async () => ({ ok: true as const }));
    const seenUpdate = vi.fn(async () => ({ ok: true as const }));
    // An older home names the change; a home on major 13 or later folds the name in.
    await reportDrawnUpdate(
      drawn,
      { protocolVersion: "12.0.0", changes: ["card-current-update-seen"] },
      { seen, seenUpdate },
    );
    await reportDrawnUpdate(
      drawn,
      { protocolVersion: PROTOCOL_VERSION, changes: [] },
      { seen, seenUpdate },
    );
    expect(seenUpdate.mock.calls).toEqual([
      [drawn.id, drawn.lifecycleId, drawn.currentUpdateId],
      [drawn.id, drawn.lifecycleId, drawn.currentUpdateId],
    ]);
    await reportDrawnUpdate(
      { ...drawn, currentUpdateId: undefined },
      { protocolVersion: PROTOCOL_VERSION },
      { seen, seenUpdate },
    );
    expect(seenUpdate).toHaveBeenCalledTimes(2);
    expect(seen).not.toHaveBeenCalled();
  });
});

/**
 * A computer whose keyboard and mouse a test touches: the system's idle
 * reading counts whole seconds since the last touch, as Electron's
 * `powerMonitor.getSystemIdleTime` does, and a touch in the window is heard
 * at once.
 */
function computer(lastTouch: number) {
  const listeners = new Set<() => void>();
  let systemTouch = lastTouch;
  let windowTouch = Number.NEGATIVE_INFINITY;
  const touches: Touches = {
    now: () => Date.now(),
    idleSeconds: async () => Math.floor((Date.now() - systemTouch) / 1000),
    lastWindowTouch: () => windowTouch,
    onWindowTouch: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    touches,
    /** A key or the mouse somewhere on the computer, which only the system's reading sees. */
    touchElsewhere: () => {
      systemTouch = Date.now();
    },
    /** A key in this window, which the page hears itself. */
    touchWindow: () => {
      systemTouch = Date.now();
      windowTouch = Date.now();
      for (const listener of listeners) listener();
    },
  };
}

const here = { away: false, watched: true };

// INF-7038's approved plan, Part 1: a window marks a card seen only while someone is there.
describe("a drawn update is reported only while someone is at the computer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-11-26T12:00:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drawn while the screen is locked, it is reported only after the unlock", async () => {
    const pc = computer(Date.now() - 600_000);
    const report = vi.fn();
    reportWhileHere({ away: true, watched: true }, Date.now(), report, pc.touches);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(report).not.toHaveBeenCalled();
    // Unlocking is typing the password; the window draws the card anew once the lock ends.
    pc.touchElsewhere();
    reportWhileHere(here, Date.now(), report, pc.touches);
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("drawn 30 seconds after the last touch, it waits for the next touch", async () => {
    const pc = computer(Date.now() - 30_000);
    const report = vi.fn();
    reportWhileHere(here, Date.now(), report, pc.touches);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(report).not.toHaveBeenCalled();
    pc.touchElsewhere();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("the same card is reported at once when the window itself is touched", async () => {
    const pc = computer(Date.now() - 30_000);
    const report = vi.fn();
    reportWhileHere(here, Date.now(), report, pc.touches);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(report).not.toHaveBeenCalled();
    pc.touchWindow();
    expect(report).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("drawn 3 seconds after a touch, it is reported at once", async () => {
    const pc = computer(Date.now() - 3_000);
    const report = vi.fn();
    reportWhileHere(here, Date.now(), report, pc.touches);
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("a computer that cannot tell reports at once, as before", () => {
    const pc = computer(Date.now() - 600_000);
    const report = vi.fn();
    reportWhileHere({ away: false, watched: false }, Date.now(), report, pc.touches);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("a stopped wait never reports", async () => {
    const pc = computer(Date.now() - 30_000);
    const report = vi.fn();
    const stop = reportWhileHere(here, Date.now(), report, pc.touches);
    stop();
    pc.touchWindow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(report).not.toHaveBeenCalled();
  });
});
