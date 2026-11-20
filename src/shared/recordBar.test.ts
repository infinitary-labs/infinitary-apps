import { describe, expect, it } from "vitest";
import { type RecordBarInput, recordBarOf } from "./recordBar";

function task(overrides: Partial<RecordBarInput> = {}): RecordBarInput {
  return {
    kind: "work",
    status: "open",
    activity: null,
    closedReason: null,
    startPolicy: "on-request",
    flags: { blocked: false, held: false, needsYou: false, ready: false },
    waitingCardId: null,
    blockedBy: [],
    children: { total: 0, closed: 0 },
    startedAt: null,
    ...overrides,
  };
}

/** Live blockers always set the blocked flag (taskProtocol's view), so fixtures do too. */
const blockedOn = (...keys: string[]): Partial<RecordBarInput> => ({
  blockedBy: keys,
  flags: { blocked: true, held: false, needsYou: false, ready: false },
});

const active = (overrides: Partial<RecordBarInput> = {}) =>
  task({ status: "active", activity: "idle", startedAt: 5, ...overrides });

describe("the record's action bar, from typed state only", () => {
  // INF-2062: a started task back in the backlog offers Start, whatever it waits on.
  it("offers Start on started work back in the backlog, never blocked", () => {
    expect(recordBarOf(active({ backlogSince: 9, ...blockedOn("FI3-6") }))).toEqual({
      end: "stop-task",
      next: "start",
      blocked: false,
    });
  });
  it("gives every open status the bar as drawn: Drop task, then its one next step", () => {
    const bars = {
      planned: recordBarOf(task()),
      blocked: recordBarOf(task(blockedOn("FI3-6"))),
      queued: recordBarOf(task({ startPolicy: "when-ready" })),
      working: recordBarOf(active({ activity: "running" })),
      idle: recordBarOf(active()),
      interrupted: recordBarOf(active({ activity: "interrupted" })),
      waiting: recordBarOf(active({ waitingCardId: "card-1" })),
    };
    expect(bars).toEqual({
      planned: {
        end: "drop-task",
        next: "start",
        blocked: false,
      },
      blocked: { end: "drop-task", next: "start", blocked: true },
      queued: {
        end: "drop-task",
        next: null,
        blocked: false,
      },
      working: { end: "stop-task", next: null, blocked: false },
      idle: {
        end: "stop-task",
        next: null,
        blocked: false,
      },
      interrupted: {
        end: "stop-task",
        next: "continue",
        blocked: false,
      },
      waiting: {
        end: "stop-task",
        next: "show-card",
        blocked: false,
      },
    });
  });

  it("has no bar on Done work, but offers Start again on dropped work", () => {
    expect(recordBarOf(task({ status: "done", closedReason: "merged" }))).toBeNull();
    expect(recordBarOf(task({ status: "dropped", closedReason: "cancelled" }))).toEqual({
      end: null,
      next: "start-again",
      blocked: false,
    });
    for (const extra of [
      { replacedBy: "FI3-9" },
      { children: { total: 1, closed: 1 } },
      { kind: "decision" as const },
    ])
      expect(recordBarOf(task({ status: "dropped", ...extra }))).toBeNull();
    expect(recordBarOf(active({ status: "done", waitingCardId: "stale" }))).toBeNull();
  });

  it("ends never-started work with the record's own drop, and started work with the stall card's", () => {
    expect(recordBarOf(task())?.end).toBe("drop-task");
    expect(recordBarOf(task({ children: { total: 2, closed: 0 } }))?.end).toBe("drop-task");
    expect(recordBarOf(task({ waitingCardId: "card-1" }))?.end).toBe("drop-task");
    expect(recordBarOf(active())?.end).toBe("stop-task");
    // Work returned to the queue after it started has no host op that ends it.
    expect(recordBarOf(task({ startedAt: 5 }))?.end).toBeNull();
    // The Firstmate's own decision and operation rows end on their cards.
    expect(recordBarOf(task({ kind: "decision", waitingCardId: "card-1" }))).toEqual({
      end: "dismiss-question",
      next: "show-card",
      blocked: false,
    });
    expect(recordBarOf(task({ kind: "operation" }))).toEqual({
      end: null,
      next: null,
      blocked: false,
    });
  });

  it("keeps Start disabled on a dropped dependency edge and gives queued work no Start now", () => {
    expect(
      recordBarOf(task({ flags: { blocked: true, held: false, needsYou: true, ready: false } })),
    ).toEqual({
      end: "drop-task",
      next: "start",
      blocked: true,
    });
    // Blocked when-ready work reads Planned, with its Start disabled.
    expect(recordBarOf(task({ startPolicy: "when-ready", ...blockedOn("FI3-6") }))).toMatchObject({
      next: "start",
      blocked: true,
    });
    // Held work on request still starts on the captain's word: Start clears
    // the hold, as start_now does.
    const held = { blocked: false, held: true, needsYou: false, ready: false };
    expect(recordBarOf(task({ flags: held }))).toMatchObject({ next: "start", blocked: false });
    // Work that starts by itself - queued, or held for a later start - gets no Start now.
    expect(recordBarOf(task({ startPolicy: "when-ready" }))?.next).toBeNull();
    expect(recordBarOf(task({ startPolicy: "when-ready", flags: held }))).toMatchObject({
      next: null,
    });
  });

  it("leaves a parent's next slot empty: its parts do the work", () => {
    expect(recordBarOf(task({ children: { total: 5, closed: 3 } }))).toEqual({
      end: "drop-task",
      next: null,
      blocked: false,
    });
    // A blocked parent still gets no Start: its parts start, not it.
    expect(recordBarOf(task({ ...blockedOn("FI3-6"), children: { total: 1, closed: 0 } }))).toEqual(
      { end: "drop-task", next: null, blocked: false },
    );
  });

  it("lets a waiting decision outrank an interruption or a blocker, as the status does", () => {
    expect(recordBarOf(active({ activity: "interrupted", waitingCardId: "card-1" }))).toMatchObject(
      { next: "show-card" },
    );
    expect(recordBarOf(task({ ...blockedOn("FI3-6"), waitingCardId: "card-1" }))).toMatchObject({
      next: "show-card",
      blocked: false,
    });
    // A wait the crewmate declared with no card to show leaves the slot empty.
    expect(recordBarOf(active({ captainWait: true }))).toMatchObject({
      next: null,
    });
  });

  it("reads background work as Working, with nothing for the captain to do", () => {
    expect(recordBarOf(active({ workPosture: { state: "active", reason: "job" } }))).toMatchObject({
      next: null,
      end: "stop-task",
    });
  });
});
