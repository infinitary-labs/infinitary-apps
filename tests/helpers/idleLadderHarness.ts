/**
 * The crew harness on the host's one clock (P5, `ticker.ts`), as the idle
 * ladder's tests and the durable inbox's tests drive it: the test moves
 * `clock.now` itself. A file that uses it fakes its timers
 * (`fakeCrewTimersEachTest`), since a turn's end ticks the fake clock.
 * A describe calls `idleLadderHarness()` once at its top; the clock resets
 * to the faked `Date.now()` before each case.
 */

import type { SpawnIntent } from "@core/orchestrator/intentBrief";
import { FIRSTMATE_RECIPIENT } from "@core/storage/inboxStore";
import { beforeEach, vi } from "vitest";
import {
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  intentOf,
  type SetupExtras,
  served,
  setup,
} from "./crewHarness";

/** Minutes in milliseconds. */
export const minutes = (n: number) => n * 60_000;

/** The idle ladder's wakes among the first mate's served lines. */
export const idleWakes = (ops: string[]) =>
  ops.filter((line) => line.includes("has been idle for"));

/** One turn of the event loop: the supervisor's promise chains settle; no clock moves. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The real agent's notifyOp: the inbox's wake path, which holds a wake
 * that names a `once` to once. `ops` keeps every call, served, whether
 * or not the inbox queued it - so a doubled wake is still seen. A live
 * Firstmate takes each wake it is sent in its next turn (the drain hands
 * it over and the clean turn acks it); a paused seat takes none, so its
 * wakes wait on the lane.
 */
export function wakesThroughInbox<
  H extends Pick<ReturnType<typeof setup>, "supervisor" | "inbox" | "ops">,
>(harness: H, firstmate: "live" | "paused" = "live"): H {
  harness.supervisor.setFirstmateHooks({
    notifyOp: (wake, origin, ref) => {
      const id = harness.inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref);
      harness.ops.push(served(wake));
      if (id !== null && firstmate === "live") {
        harness.inbox.markDelivered([id]);
        harness.inbox.ack([id]);
      }
    },
    retryConverse: vi.fn(),
  });
  return harness;
}

/** A crewmate's turn that fails at the provider, then ends. */
export async function failTurn(crewmate: FakeCrewmate, taskId: string, error = "upstream 529") {
  crewmate.emit({ type: "turn_failed", taskId, error });
  crewmate.emit({ type: "turn_end", taskId });
  crewmate.finishPrompt();
  await settle();
}

/** The host's clock and the crew harness set on it, for the describe that calls it. */
export function idleLadderHarness() {
  const clock = { now: 0 };
  const hostClock = () => clock.now;
  beforeEach(() => {
    clock.now = Date.now();
  });

  /** The harness on the host's clock, its card stack read as the broadcast carries it. */
  const clockedSetup = (crewmate: FakeCrewmate, extras: SetupExtras = {}) => {
    const harness = setup(crewmate, { now: hostClock, ...extras });
    return { ...harness, cards: () => harness.supervisor.cards.snapshot() };
  };

  /** A Pi crewmate that reported and stopped: nobody's turn, clock running. */
  async function stopped(
    extras: SetupExtras = {},
    crewmate = fakeCrewmate(),
    intent: SpawnIntent = intentOf("Start"),
  ) {
    const harness = wakesThroughInbox(clockedSetup(crewmate, extras));
    const { taskId } = await harness.supervisor.intake.commission({ title: "Job", intent });
    await settle();
    await endTurn(crewmate, taskId, "Done with step one.");
    // A job running at that end earns its one check-back ask (INF-1244),
    // which the crewmate answers without naming one.
    if (harness.tasks.get(taskId)?.activity === "running") {
      await endTurn(crewmate, taskId, "Not waiting on it.");
    }
    const idleSince = harness.tasks.get(taskId)?.idleSince ?? 0;
    /** The tick at `ms` idle minutes past the clock's start. */
    const at = async (ms: number) => {
      clock.now = idleSince + ms;
      harness.supervisor.watch.reconcileIdle(clock.now);
      await settle();
    };
    return { ...harness, crewmate, taskId, idleSince, at };
  }

  /** Move the clock to when the lane's first row is due, and sweep it. */
  async function sweepWhenDue(harness: ReturnType<typeof setup>, taskId: string) {
    const due = Math.max(
      clock.now,
      ...harness.inbox.allFor(taskId).map((row) => row.nextAttemptAt ?? 0),
    );
    clock.now = due;
    harness.supervisor.watch.reconcileIdle(clock.now);
    await harness.supervisor.watch.sweepInbox(clock.now);
    await settle();
  }

  return { clock, hostClock, clockedSetup, stopped, sweepWhenDue };
}
