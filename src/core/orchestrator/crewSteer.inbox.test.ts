/**
 * The durable inbox (docs/inbox.md, design A) as `CrewSteer` keeps a
 * task's lane: guidance a quit stranded delivered at the next boot, a failed
 * native steer retried, the attempt budget, and a lane whose task is gone.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  fakeQueuedSteerCrewmate,
  intentOf,
  reboot,
  served,
} from "../../../tests/helpers/crewHarness";
import { idleLadderHarness, settle } from "../../../tests/helpers/idleLadderHarness";
import { INBOX_ATTEMPT_MAX, InboxStore } from "../storage/inboxStore";
import { RESTART_REPLAY_NOTE, renderWake, type WakeFacts } from "./wakes";

fakeCrewTimersEachTest();

describe("the durable inbox (design A)", () => {
  const { clock, hostClock, clockedSetup } = idleLadderHarness();

  /** Two minutes pass: every attempted row is past the retry grace. */
  const passGrace = () => {
    clock.now += 120_000;
  };

  it("re-delivers guidance a quit stranded once the next boot sweeps", async () => {
    const crewmate = fakeQueuedSteerCrewmate();
    const { supervisor, db, paths, workspace, cardStore } = clockedSetup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await settle();

    // Mid-turn guidance on a followup-queue backend: durably recorded.
    expect(await supervisor.steer.steerCrewmate(taskId, "use the other library")).toBe(
      "queued-next-turn",
    );

    // The app quits here: nothing acked, the turn never ends. A fresh
    // supervisor over the same database is the next boot.
    supervisor.disposeAll();
    const bootCrewmate = fakeCrewmate();
    const fresh = reboot(
      // Opening the task record again marks running -> interrupted, as boot does.
      { paths, db, workspace },
      vi.fn(async () => bootCrewmate),
      { now: hostClock, cardStore },
    );
    new InboxStore(db, { now: hostClock }).resetInFlight();
    await fresh.watch.sweepInbox(clock.now);
    await settle();

    // The stranded guidance became the resumed crewmate's next turn.
    expect(bootCrewmate.promptCalls).toEqual(["use the other library"]);
  });

  // INF-405: the quit lets go of each Claude client, and the background
  // tasks it still ran end with it; the next boot tells the crewmate once.
  it("tells a crewmate once, at the next boot, of each background task its Claude client still ran when the quit let go of it (INF-405)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, db, paths, workspace, cardStore } = clockedSetup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Suite",
      intent: intentOf("Start"),
    });
    await settle();
    crewmate.finishPrompt();
    await settle();
    crewmate.emit({
      type: "background_work_changed",
      count: 1,
      tasks: [{ id: "bybac1mss", description: "Run the long suite" }],
    });
    clock.now += 12 * 60_000;

    await supervisor.disposeAll();
    const bootCrewmate = fakeCrewmate();
    const inbox = new InboxStore(db, { now: hostClock });
    const fresh = reboot(
      { paths, db, workspace },
      vi.fn(async () => bootCrewmate),
      { now: hostClock, cardStore, inbox },
    );
    inbox.resetInFlight();
    await fresh.watch.sweepInbox(clock.now);
    await settle();

    expect(bootCrewmate.promptCalls).toEqual([
      expect.stringContaining(
        '[job] background job bybac1mss did not finish: "Run the long suite" was stopped after 12m 0s, when Infinitary stopped on the computer running it.',
      ),
    ]);
    bootCrewmate.finishPrompt();
    await settle();
    expect(inbox.allFor(taskId)).toEqual([]);
    await fresh.disposeAll();
  });

  // INF-721 friction 9: an update of this Mac quits it under a Claude
  // client's own continuation, which no lane row carried, and the next
  // launch carries the crewmate on with no message from the captain.
  it("carries on, at the next launch, a turn the quit cut that no message was serving (INF-721 friction 9)", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, db, paths, workspace, cardStore } = clockedSetup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Suite",
      intent: intentOf("Start"),
    });
    await settle();
    crewmate.finishPrompt();
    await settle();
    // The client went on by itself once its background work ended.
    crewmate.emit({ type: "continuation_started" });
    await settle();

    await supervisor.disposeAll();
    const bootCrewmate = fakeCrewmate();
    const inbox = new InboxStore(db, { now: hostClock });
    const fresh = reboot(
      { paths, db, workspace },
      vi.fn(async () => bootCrewmate),
      { now: hostClock, cardStore, inbox },
    );
    inbox.resetInFlight();
    await fresh.watch.sweepInbox(clock.now);
    await settle();

    expect(bootCrewmate.promptCalls).toEqual([
      renderWake({ facts: { kind: "turn-resumed", stopped: "quit" } }),
    ]);
    bootCrewmate.finishPrompt();
    await settle();
    expect(inbox.allFor(taskId)).toEqual([]);
    await fresh.disposeAll();
  });

  it("replays a turn the app closed under at every launch, saying so, and never sets it aside", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, db, paths, workspace, cardStore } = clockedSetup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Publish",
      intent: intentOf("Dispatch the release workflow"),
    });
    await settle();
    // The brief's turn runs and never ends: the app closes under it.
    const brief = crewmate.promptCalls[0] ?? "";
    expect(brief).toContain("Dispatch the release workflow");
    expect(brief).not.toContain(RESTART_REPLAY_NOTE);

    let running = supervisor;
    let turnCrewmate = crewmate;
    const setAside: WakeFacts[] = [];
    // One more launch than the message has tries: each quit lands mid-turn.
    for (let launch = 2; launch <= INBOX_ATTEMPT_MAX + 1; launch += 1) {
      running.disposeAll();
      const bootCrewmate = fakeCrewmate();
      const notes: string[] = [];
      const fresh = reboot(
        { paths, db, workspace },
        vi.fn(async () => bootCrewmate),
        {
          now: hostClock,
          cardStore,
          broadcastEvent: (event) => {
            if (event.type === "firstmate_note") notes.push(event.text);
          },
        },
      );
      fresh.setFirstmateHooks({
        notifyOp: (wake) => {
          if (wake.facts.kind === "guidance-set-aside") setAside.push(wake.facts);
        },
        retryConverse: vi.fn(),
      });
      // The boot: the quit left the brief in flight.
      expect(new InboxStore(db, { now: hostClock }).resetInFlight()).toBe(1);
      passGrace();
      await fresh.watch.sweepInbox(clock.now);
      await settle();

      // The same message again, opened by the note that it is a replay.
      expect(bootCrewmate.promptCalls).toEqual([`${RESTART_REPLAY_NOTE}\n\n${brief}`]);
      expect(new InboxStore(db).inFlight(taskId)).toEqual([
        expect.objectContaining({ attempts: 1, cuts: launch - 1, escalatedAt: null }),
      ]);
      expect(notes.some((text) => text.includes("could not be delivered"))).toBe(false);
      running = fresh;
      turnCrewmate = bootCrewmate;
    }
    expect(setAside).toEqual([]);

    // The last replay's turn ends clean: the message is handled and leaves the lane.
    turnCrewmate.emit({ type: "turn_end", taskId });
    turnCrewmate.finishPrompt();
    await settle();
    expect(new InboxStore(db).allFor(taskId)).toEqual([]);
    expect(new InboxStore(db).inFlight(taskId)).toEqual([]);
    running.disposeAll();
  });

  it("records a failed native steer, retries it, and delivers on recovery", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, inbox } = clockedSetup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await settle();

    (crewmate.steer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("busy"));
    expect(await supervisor.steer.steerCrewmate(taskId, "make it blue")).toBe("recorded-retrying");
    expect(inbox.pending(taskId, clock.now + 120000)).toHaveLength(1);

    // The tick sweep retries once the grace passes; the steer now lands.
    passGrace();
    await supervisor.watch.sweepInbox(clock.now);
    expect(crewmate.steer).toHaveBeenCalledTimes(2);
    expect(crewmate.steer).toHaveBeenLastCalledWith(
      "make it blue",
      undefined,
      expect.stringMatching(/^rows:\d+:/),
    );

    // Ack after handling: the row clears when the turn it landed in ends.
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await settle();
    expect(inbox.allFor(taskId)).toHaveLength(0);
  });

  it("escalates guidance loudly after the attempt budget and stops retrying", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, inbox, ops, events, cards } = clockedSetup(crewmate);
    const refs: Array<string | undefined> = [];
    supervisor.setFirstmateHooks({
      notifyOp: (wake, _origin, ref) => {
        ops.push(served(wake));
        refs.push(ref);
      },
      retryConverse: vi.fn(),
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start"),
    });
    await settle();

    (crewmate.steer as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("always busy"));
    expect(await supervisor.steer.steerCrewmate(taskId, "urgent fix")).toBe("recorded-retrying");
    for (let round = 0; round < 3; round += 1) {
      passGrace();
      await supervisor.watch.sweepInbox(clock.now);
    }

    const escalated = inbox.allFor(taskId);
    expect(escalated).toHaveLength(1);
    expect(escalated[0]?.escalatedAt).not.toBeNull();
    expect(ops.some((line) => line.includes("could not be delivered after 3 attempts"))).toBe(true);
    expect(refs).toContain(taskId);
    expect(
      events.some(
        (event) => event.type === "firstmate_note" && event.text.includes("could not be delivered"),
      ),
    ).toBe(true);
    await settle();
    // The wake and the feed line are the escalation; no host card (P0, WI-3).
    expect(cards()).toEqual([]);

    // The budget is spent: no further delivery attempts.
    const attempts = (crewmate.steer as ReturnType<typeof vi.fn>).mock.calls.length;
    passGrace();
    await supervisor.watch.sweepInbox(clock.now);
    expect((crewmate.steer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(attempts);
  });

  it("retries the brief when the first turn fails at the provider", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor } = clockedSetup(crewmate);
    const { taskId } = await supervisor.intake.commission({
      title: "Job",
      intent: intentOf("Start the work"),
    });
    await settle();

    // Pi resolves a provider-failed turn; the task stays steerable and the
    // brief - the task's first inbox row - is released for retry.
    crewmate.emit({ type: "turn_failed", taskId, error: "upstream 529" });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await settle();

    passGrace();
    await supervisor.watch.sweepInbox(clock.now);
    await settle();
    expect(crewmate.promptCalls).toHaveLength(2);
    expect(crewmate.promptCalls[0]).toContain("Start the work");
    expect(crewmate.promptCalls[1]).toBe(crewmate.promptCalls[0]);
  });

  it("turns a lane whose task is gone into one honest notice", async () => {
    const crewmate = fakeCrewmate();
    const { supervisor, inbox, ops, events } = clockedSetup(crewmate);
    inbox.enqueue("ghost-task", "hello out there");
    await supervisor.watch.sweepInbox(clock.now);
    expect(events).toContainEqual({
      type: "firstmate_note",
      text: "Guidance for a task that no longer exists was never delivered - the task is gone: hello out there",
    });
    expect(ops).toEqual([]);
    expect(inbox.allFor("ghost-task")).toHaveLength(0);
  });
});
