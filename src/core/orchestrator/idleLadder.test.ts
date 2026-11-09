/**
 * The idle ladder as `IdleLadder` reconciles idle crew
 * (docs/report-sort.md): its wakes on the host's one clock and the stalls
 * that resolve themselves.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */
import { writeFileSync } from "node:fs";
import { type Card, cardPresentation, cardTakesReplies } from "@shared/cards";
import { describe, expect, it, vi } from "vitest";
import {
  askedOn,
  endTurn,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  type SetupExtras,
  served,
} from "../../../tests/helpers/crewHarness";
import {
  failTurn,
  idleLadderHarness,
  idleWakes,
  minutes,
  settle,
  wakesThroughInbox,
} from "../../../tests/helpers/idleLadderHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { initOverflowDir } from "../overflow";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import { TaskProtocol } from "../tasks/taskProtocol";
import { TIMELINE_CAP } from "../tasks/timelineCompaction";
import { SUPERVISOR_STEER } from "./crewRuntime";
import { IDLE_ANSWER_NUDGE_TEXT, IDLE_NUDGE_TEXT, idleNoteNudgeText } from "./idleWakes";

fakeCrewTimersEachTest();

describe("the idle ladder (idle crew recovery, docs/report-sort.md)", () => {
  const { clock, hostClock, clockedSetup, stopped, sweepWhenDue } = idleLadderHarness();

  it("still says the last plan stands after compaction folds the note that carried it (INF-866 K2)", async () => {
    const h = clockedSetup(fakeCrewmate());
    const { taskId } = await h.supervisor.intake.commission({
      title: "Long check",
      intent: intentOf("Check every fixture library"),
    });
    await settle();
    const progress = h.specs[0]?.onProgress;
    if (!progress) throw new Error("Missing production progress callback");
    progress("Starting the check.", [
      { label: "Check libraries", short: "Check", state: "current" },
    ]);
    for (let index = 0; index < TIMELINE_CAP; index += 1) {
      progress(`Checked library ${index}.`);
    }
    const timeline = h.tasks.timeline(taskId);
    expect(timeline.some((event) => event.text === "Starting the check.")).toBe(false);
    expect(progress("Checked the last library.")).toBe(
      "Noted on your task's timeline; your last plan stands.",
    );
  });

  it("keeps the last plan when a note omits it, through provider failure recovery", async () => {
    const crewmate = fakeCrewmate();
    const h = clockedSetup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Progress recovery",
      intent: intentOf("Check fixture libraries, prepare image, test"),
    });
    await settle();
    const protocol = new TaskProtocol({
      tasks: h.tasks,
      repos: h.repos,
      cards: { listOpen: () => [], snapshot: () => [] },
      broadcastEvent: () => {},
      emit: () => {},
      now: hostClock,
    });
    const plan = [
      { label: "Check fixture libraries", short: "Check", state: "current" },
      { label: "Prepare test image", short: "Image", state: "next" },
      { label: "Run the tests", short: "Test", state: "next" },
    ];
    const progress = h.specs[0]?.onProgress;
    if (!progress) throw new Error("Missing production progress callback");
    expect(progress("Briefing before a list exists.")).toBe("Noted on your task's timeline.");
    expect(protocol.detail(taskId).plan).toBeNull();
    progress("Starting the library check.", plan);
    clock.now += 11_000;
    const before = h.tasks.timeline(taskId).length;
    // INF-484 move 5: a note that omits the list is written, and the last list stands.
    const kept = progress("The library check completed; preparing the test image.");
    expect(kept).toBe("Noted on your task's timeline; your last plan stands.");
    expect(h.tasks.timeline(taskId)).toHaveLength(before + 1);
    expect(protocol.detail(taskId).plan?.items.map((item) => item.state)).toEqual([
      "current",
      "next",
      "next",
    ]);
    progress("The library check completed; preparing the test image.", [
      { ...plan[0], state: "done" },
      { ...plan[1], state: "current" },
      plan[2],
    ]);
    const checkpoint = protocol.detail(taskId).plan;
    expect(checkpoint?.items.map((item) => item.state)).toEqual(["done", "current", "next"]);
    for (let count = 1; count <= 3; count += 1) {
      await failTurn(crewmate, taskId);
      expect(h.inbox.allFor(taskId)).toMatchObject([
        { failures: count, attempts: 0, escalatedAt: null },
      ]);
      await sweepWhenDue(h, taskId);
      expect(crewmate.promptCalls).toHaveLength(count + 1);
      expect(protocol.detail(taskId).plan).toEqual(checkpoint);
    }
    await endTurn(crewmate, taskId);
    expect(h.inbox.allFor(taskId)).toEqual([]);
    expect(h.tasks.get(taskId)?.status).toBe("active");
    expect(h.tasks.timeline(taskId).filter((event) => event.kind === "steered")).toEqual([]);
    expect(protocol.detail(taskId).plan).toEqual(checkpoint);
    const evidence = process.env.INFINITARY_PROGRESS_EVIDENCE;
    if (evidence)
      writeFileSync(
        evidence,
        JSON.stringify(
          {
            kept,
            keptNote: h.tasks.timeline(taskId)[before],
            checkpoint,
            recovered: protocol.detail(taskId),
            providerAttempts: crewmate.promptCalls.length,
            pendingInbox: h.inbox.allFor(taskId),
          },
          null,
          2,
        ),
      );
    protocol.dispose();
    await h.supervisor.sessions.interruptCrewmate(taskId, "cancel");
  });

  describe("self-resolving stalls (INF-1550, approved B/C)", () => {
    it.each([false, true])(
      "INF-1554 F4: empty findings preserve the current owner (decision card: %s)",
      async (cardUp) => {
        const h = await stopped({ hasRunningJobs: () => true });
        if (cardUp) {
          h.specs[0]?.onCard?.({
            title: "Choose the remaining consent",
            body: "<p>Signing needs your consent.</p>",
            actions: [
              { id: "allow", label: "Allow signing", default: true },
              { id: "hold", label: "Keep waiting" },
            ],
          });
          await settle();
        }
        await h.supervisor.steer.steerCrewmate(h.taskId, "Report only the current state.");
        await settle();
        const before = h.ops.length;
        h.specs[0]?.onReport?.("The current owner still has the next move.", undefined, {
          recoveryWays: [],
        });
        await endTurn(h.crewmate, h.taskId);
        expect(h.ops.length).toBe(before);
        expect(h.sorts.at(-1)?.rule).toBe(cardUp ? "captain-card" : "still-moving");
        expect(h.tasks.reportEntries(h.taskId).at(-1)?.declared).not.toHaveProperty("recoveryWays");
        expect(
          h.tasks
            .timeline(h.taskId)
            .filter((e) => e.kind === "report")
            .at(-1)?.data,
        ).not.toHaveProperty("recoveryWays");
        console.info(
          "[F4] empty findings:",
          JSON.stringify({ cardUp, sort: h.sorts.at(-1)?.rule, wakes: h.ops.length - before }),
        );
      },
    );

    it("INF-1554 F5: serves the kept bounded recovery facts, retained overflow and one procedure", async () => {
      initOverflowDir(scratchDir("infinitary-recovery-wake-"));
      const h = await stopped();
      await h.supervisor.steer.steerCrewmate(h.taskId, "Report the observations and alternatives.");
      await settle();
      const observation =
        "The host fix is merged, but the running app still lacks it; the branch can move without an alpha. ".repeat(
          8,
        );
      h.specs[0]?.onReport?.("The wait has alternatives.", undefined, {
        workWait: { observation, cheapestWay: "Take over the blocked branch" },
        recoveryWays: Array.from({ length: 100 }, (_, index) => ({
          action: `Inspect report ${index + 1} for an available alternative.`,
          hold: "waits" as const,
          evidence: observation,
          nextFact: "Read the named owner's next fact",
        })),
      });
      await endTurn(h.crewmate, h.taskId);
      const kept = h.tasks.reportEntries(h.taskId).at(-1);
      const wake = h.ops.at(-1) ?? "";
      expect(wake).not.toContain(observation);
      expect(wake).toContain(kept?.declared.workWait?.observation);
      expect(wake).toContain("Full recovery details:");
      expect(wake.match(/On a typed stall or idle wake/g)).toHaveLength(1);
      expect(kept?.declared.recoveryWays?.length).toBeLessThan(100);
      expect(h.sorts.at(-1)?.rule).toBe("recovery");
      console.info(
        "[F5] served bounded recovery:",
        JSON.stringify({
          wakeCharacters: wake.length,
          waysKept: kept?.declared.recoveryWays?.length,
          hasFullDetailsPointer: wake.includes("Full recovery details:"),
          procedures: wake.match(/On a typed stall or idle wake/g)?.length,
        }),
      );
    });

    it("wakes for an unowned wait even behind a timed gate, then reports typed recovery ways without a card", async () => {
      const h = await stopped();
      await h.supervisor.steer.steerCrewmate(
        h.taskId,
        "Report the release wait and cheapest alternative.",
      );
      await settle();
      h.specs[0]?.onReport?.("The running app still lacks the host fix.", undefined, {
        checkBack: { minutes: 15, waitingFor: "the installed alpha" },
        workWait: {
          observation: "No alpha has been cut since the host fix merged.",
          cheapestWay: "Move the branch to a fresh task.",
        },
      });
      await endTurn(h.crewmate, h.taskId);
      expect(h.ops.at(-1)).toContain('"kind":"wait-without-owner"');
      expect(h.ops.at(-1)).toContain("Move the branch to a fresh task.");
      expect(h.cards()).toEqual([]);
      expect(h.sorts.at(-1)?.rule).toBe("recovery");
      console.info("[recovery] unowned wait wake:", h.ops.at(-1));
      const kept = h.tasks
        .timeline(h.taskId)
        .filter((event) => event.kind === "report")
        .at(-1);
      expect(kept?.data?.workWait).toMatchObject({
        cheapestWay: "Move the branch to a fresh task.",
      });

      await h.supervisor.steer.steerCrewmate(
        h.taskId,
        "Read-only: find ways around this host record; report, no card, then stop.",
      );
      await settle();
      h.specs[0]?.onReport?.(
        "The existing branch_from capability can move this work today.",
        undefined,
        {
          recoveryWays: [
            {
              action: "Take over the branch in a fresh task",
              approach: "workaround",
              hold: "waits",
              evidence: "branch_from is available in the running app",
              nextFact: "The new task starts on the branch",
            },
            {
              action: "Cut a signed alpha",
              hold: "asks-first",
              evidence: "The host fix is merged",
              nextFact: "The captain authorizes signing",
            },
          ],
        },
      );
      await endTurn(h.crewmate, h.taskId);
      expect(h.ops.at(-1)).toContain('"needsConsent":false');
      expect(h.ops.at(-1)).toContain('"needsConsent":true');
      expect(h.ops.at(-1)).toContain("Recovery ways");
      console.info("[recovery] findings to first mate:", h.ops.at(-1));
      expect(h.cards()).toEqual([]);
    });

    // Source: R6 of INF-1644, "rejects legitimate reports across the supported boundary".
    it("keeps a report whose recovery way names a hold this build retired, read as the captain's", async () => {
      const h = await stopped();
      await h.supervisor.steer.steerCrewmate(
        h.taskId,
        "Read-only: report ways around the failing checks.",
      );
      await settle();
      // INF-1688 retired the repair limit; a same-major work computer on an older build still names it.
      const way = {
        action: "Push one more repair",
        approach: "workaround",
        hold: "repairs",
        evidence: "The checks failed on the same version",
        nextFact: "Read the next check result",
      };
      expect(() =>
        h.specs[0]?.onReport?.("The checks still fail on the same version.", undefined, {
          recoveryWays: [way],
        }),
      ).not.toThrow();
      await endTurn(h.crewmate, h.taskId);
      expect(h.tasks.reportEntries(h.taskId).at(-1)?.declared.recoveryWays).toEqual([
        { ...way, basis: undefined, needsConsent: true },
      ]);
      expect(h.ops.at(-1)).toContain('"hold":"repairs"');
      expect(h.ops.at(-1)).toContain('"needsConsent":true');
      expect(h.sorts.at(-1)?.rule).toBe("recovery");
    });

    // Source: INF-1554 F1, "Keep the card for you after the last wake, and fix the wake's wording".
    describe("INF-1554 F1: the captain backstop after ignored recovery", () => {
      /** A crewmate that reported a typed wait, before the ladder's first rung. */
      async function waited(extras: SetupExtras = {}) {
        const h = await stopped(extras);
        // A verdict from before the wait is not an attempt at it.
        h.tasks.updateFields(
          h.taskId,
          { verdict: "Let the crewmate finish step one." },
          "firstmate",
        );
        clock.now += 1;
        await h.supervisor.steer.steerCrewmate(h.taskId, "Name the wait.");
        await settle();
        h.specs[0]?.onReport?.("No release owner exists.", undefined, {
          workWait: { observation: "No alpha is being cut", cheapestWay: "Take over the branch" },
        });
        await endTurn(h.crewmate, h.taskId);
        return { ...h, base: clock.now - h.idleSince };
      }
      const backstop = (h: Awaited<ReturnType<typeof waited>>) =>
        h.cards().find((card) => card.id === `card-stall-${h.taskId}`);

      it("names the same wait, the attempts recorded since it and the captain's ways out", async () => {
        const h = await waited();
        clock.now += 1;
        h.tasks.updateFields(
          h.taskId,
          { verdict: "Started the takeover check; the wait did not move." },
          "firstmate",
        );
        await h.at(h.base + minutes(10));
        await endTurn(h.crewmate, h.taskId);
        for (const step of [20, 50]) await h.at(h.base + minutes(step));
        expect(backstop(h)).toBeUndefined();
        await h.at(h.base + minutes(80));
        const body = backstop(h)?.body;
        expect(body).toContain(
          "<p>It stopped with nothing running and no question for you. It was nudged once, and your first mate was told twice, and nothing has moved since.</p>",
        );
        expect(body).toContain(
          "<p>It is still waiting: No alpha is being cut</p><p>Your first mate recorded one attempt to get around it since then; the latest: Started the takeover check; the wait did not move.</p>",
        );
        expect(body).not.toContain("Let the crewmate finish step one.");
        expect(backstop(h)?.actions.map((action) => action.label)).toEqual([
          "Nudge",
          "Back to backlog",
          "Discard",
        ]);
        expect(h.sorts.at(-1)).toEqual({ taskId: h.taskId, verdict: "captain", rule: "idle-card" });
        console.info("[F1] terminal backstop:", JSON.stringify({ body, ledger: h.sorts.at(-1) }));
      });

      it("raises nothing while a running job owns the wait", async () => {
        const h = await waited({ hasRunningJobs: () => true });
        for (const step of [10, 20, 50, 80, 120]) await h.at(h.base + minutes(step));
        expect(h.cards()).toEqual([]);
      });

      it("raises nothing once the crewmate's next turn resolves the wait", async () => {
        const h = await waited();
        await h.at(h.base + minutes(10));
        await endTurn(h.crewmate, h.taskId);
        await h.at(h.base + minutes(20));
        clock.now += 1;
        await h.supervisor.steer.steerCrewmate(h.taskId, "Read the owner again.");
        await settle();
        h.specs[0]?.onReport?.("The takeover started on the branch.");
        await endTurn(h.crewmate, h.taskId);
        // Where the old episode would have raised its card, the new one has
        // only reached its own nudge and first wake.
        await h.at(h.base + minutes(50));
        await endTurn(h.crewmate, h.taskId);
        await h.at(h.base + minutes(80));
        expect(backstop(h)).toBeUndefined();
        expect(h.sorts.map(({ rule }) => rule)).not.toContain("idle-card");
      });
    });

    // Source: INF-1554 F3, "if any watcher owns the wait, it is not a stall"; a timer with no claimed job is not one.
    it("INF-1554 F3: wakes on an unchanged work wait behind the crewmate's own timer with no job", async () => {
      const h = await stopped();
      const wait = {
        owner: "INF-1539",
        end: "the takeover starts",
        observation: "The takeover is still planned",
        cheapestWay: "Start the existing takeover now",
      };
      const report = async () => {
        await h.supervisor.steer.steerCrewmate(h.taskId, "Check the named owner once.");
        await settle();
        h.specs[0]?.onReport?.("Checked the takeover owner.", undefined, {
          workWait: wait,
          checkBack: { minutes: 15, waitingFor: "the takeover to start" },
        });
        await endTurn(h.crewmate, h.taskId);
      };
      await report();
      // R1 of INF-1644: the timer owns nothing in the sort either, so the
      // first report is a stop the first mate reads, not a moving task.
      expect(h.sorts.at(-1)?.rule).toBe("stopped");
      const before = h.ops.length;
      await report();
      expect(h.sorts.at(-1)?.rule).toBe("recovery");
      expect(h.ops).toHaveLength(before + 1);
      expect(h.ops.at(-1)).toContain('"kind":"repeated-wait"');
      expect(h.cards()).toEqual([]);
    });

    // Source: R1 of INF-1644, "apply the approved ownership rule consistently
    // across the sort, ladder and timer lifecycle", under INF-1554 F3's "A
    // timer with no claimed job is not an owner".
    it("R1 of INF-1644: a crewmate that only sets check-back timers still reaches the captain's card", async () => {
      const h = await stopped();
      const lookLater = async () => {
        h.specs[0]?.onReport?.("Nothing moved yet; I will look again.", undefined, {
          checkBack: { minutes: 15, waitingFor: "the release owner to answer" },
        });
        await endTurn(h.crewmate, h.taskId);
      };
      clock.now += 1;
      await h.supervisor.steer.steerCrewmate(h.taskId, "Check the release owner.");
      await settle();
      await lookLater();
      const base = clock.now - h.idleSince;
      const timerEnds: number[] = [];
      // Every turn the crewmate is given, it answers with one more timer and
      // no job, for two hours of the host's clock.
      for (let step = 5; step <= 120; step += 5) {
        const prompts = h.crewmate.promptCalls.length;
        const timer = h.tasks.get(h.taskId)?.gate;
        await h.at(base + minutes(step));
        await h.supervisor.watch.sweepGates(clock.now);
        await settle();
        if (timer?.kind === "at-time" && h.tasks.get(h.taskId)?.gate === null) timerEnds.push(step);
        if (h.crewmate.promptCalls.length > prompts) await lookLater();
      }
      // Its timers ended without steering it or restarting its idle episode:
      // the ladder's own nudge was its one look again, and the card went up.
      expect(timerEnds.length).toBeGreaterThan(0);
      expect(h.crewmate.promptCalls.filter((prompt) => prompt === IDLE_NUDGE_TEXT)).toHaveLength(1);
      expect(
        h.crewmate.promptCalls.some((prompt) => prompt.includes("the release owner to answer")),
      ).toBe(false);
      expect(h.cards().find((card) => card.id === `card-stall-${h.taskId}`)).toBeDefined();
      expect(h.sorts.filter(({ rule }) => rule === "idle-card")).toHaveLength(1);
    });

    // Source: INF-2133, the captain's direction B, "no change. background
    // sleep already has some UI showing it. this should be nothing special":
    // a crewmate waiting for time is told to start a background sleep, and
    // the sleep owns the check-back like any running job.
    it("INF-2133: a check-back with nothing running is told to start a background sleep, which then owns the wait", async () => {
      let sleeping = false;
      const h = await stopped({ hasRunningJobs: () => sleeping });
      await h.supervisor.steer.steerCrewmate(
        h.taskId,
        "Look at the release again in half an hour.",
      );
      await settle();
      const receipt = h.specs[0]?.onReport?.("The release is not out yet.", undefined, {
        checkBack: { minutes: 30, waitingFor: "the release to publish" },
      });
      expect(receipt).not.toContain("the app wakes you");
      expect(receipt).toContain("start a background sleep for that long before this turn ends");
      // The crewmate starts the sleep after its report, before its turn ends.
      sleeping = true;
      await endTurn(h.crewmate, h.taskId);
      const reportedAt = clock.now;
      expect(h.ops.some((op) => op.includes('"kind":"wait-without-owner"'))).toBe(false);
      expect(h.sorts.at(-1)?.rule).not.toBe("stopped");
      expect(h.tasks.get(h.taskId)?.gate).toEqual({
        kind: "at-time",
        until: reportedAt + minutes(30),
        reason: "the release to publish",
      });
      // A second check-back while the sleep runs keeps today's reply.
      await h.supervisor.steer.steerCrewmate(h.taskId, "Any change?");
      await settle();
      expect(
        h.specs[0]?.onReport?.("Still waiting.", undefined, {
          checkBack: { minutes: 20, waitingFor: "the release to publish" },
        }),
      ).toContain("the app wakes you in 20m");
    });

    it("INF-1554 F3: keeps a running job as owner across unchanged work-wait reports", async () => {
      const h = await stopped({ hasRunningJobs: () => true });
      const wait = {
        owner: "INF-1539",
        end: "the takeover starts",
        observation: "The task is still planned",
        cheapestWay: "Start the existing takeover now",
      };
      const report = async (observation: string) => {
        await h.supervisor.steer.steerCrewmate(h.taskId, "Check the named owner once.");
        await settle();
        h.specs[0]?.onReport?.("Checked the takeover owner.", undefined, {
          workWait: { ...wait, observation },
        });
        await endTurn(h.crewmate, h.taskId);
      };
      await report(wait.observation);
      const before = h.ops.length;
      await report(wait.observation);
      expect(h.ops.length).toBe(before);
      expect(h.sorts.at(-1)?.rule).toBe("still-moving");
      const repeated = h.ops.length;
      await report("The takeover is running on the branch");
      expect(h.ops.length).toBe(repeated);
      expect(h.cards()).toEqual([]);
    });
  });

  it("climbs nudge, wake, repeat and the host's card at 10, 20, 50 and 80 idle minutes, then holds", async () => {
    const { supervisor, crewmate, ops, sorts, ledgerFacts, taskId, at, cards } = await stopped();
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "stopped" });
    const promptsBefore = crewmate.promptCalls.length;

    await at(minutes(10) - 1);
    expect(crewmate.promptCalls).toHaveLength(promptsBefore);
    await at(minutes(10));
    // Rung 1: one typed steer to the crewmate, recorded as the supervisor's.
    expect(crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "routine", rule: "idle-nudge" });
    expect(ledgerFacts.at(-1)).toEqual({ kind: "idle-nudge", thread: false });
    // The nudge's own turn ends silently: the episode goes on, uncounted.
    await endTurn(crewmate, taskId);
    expect(idleWakes(ops)).toHaveLength(0);

    await at(minutes(20) - 1);
    expect(idleWakes(ops)).toHaveLength(0);
    await at(minutes(20));
    // Rung 2: the Firstmate hears it, with the ways out as a hold carries them.
    expect(idleWakes(ops)).toHaveLength(1);
    expect(idleWakes(ops)[0]).toContain(
      "with nothing running, nothing queued and no card up; the host's nudge did not move it",
    );
    expect(idleWakes(ops)[0]).toContain('"held": "idle-stall"');
    expect(idleWakes(ops)[0]).toContain('"tool": "interrupt_crewmate"');
    // INF-3143, direction A: the stall wake offers the park where the wait shows.
    expect(idleWakes(ops)[0]).toContain('"tool": "update_task"');
    expect(idleWakes(ops)[0]).toContain("Its last report: Done with step one.");
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "idle-wake" });
    expect(supervisor.facts.crewStatus(taskId)[0]?.stalled).toBe("stalled 20m · 1 wake");

    await at(minutes(50) - 1);
    expect(idleWakes(ops)).toHaveLength(1);
    await at(minutes(50));
    expect(idleWakes(ops)).toHaveLength(2);
    expect(idleWakes(ops)[1]).toContain("This is the second time");
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "idle-repeat" });

    await at(minutes(80) - 1);
    expect(cards()).toEqual([]);
    const opsBefore = ops.length;
    await at(minutes(80));
    // Rung 3: the host's own card, in place of any further wake.
    const card = cards().find((entry) => entry.id === `card-stall-${taskId}`);
    // INF-1670: the first mate answers a reply under it, and Drop task is gone.
    expect(card).toMatchObject({
      taskId,
      author: "host",
      title: "Job has been stuck for 1h 20m",
      answeredBy: "firstmate",
    });
    expect(card && cardPresentation(card)).toBe("attention");
    expect(card && cardTakesReplies(card)).toBe(true);
    expect(card?.actions.map((action) => action.label)).toEqual([
      "Nudge",
      "Back to backlog",
      "Discard",
    ]);
    expect(card?.body).toBe(
      "<p>It stopped with nothing running and no question for you. It was nudged once, and your first mate was told twice, and nothing has moved since.</p>" +
        "<p>What it last said: Done with step one.</p>" +
        "<p>Nudge tells it to finish or say what is in its way. Back to backlog parks it with its work kept until you start it, and your first mate hears once if news reaches it. Discard ends it and throws its work away. For anything else, reply here.</p>",
    );
    expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "idle-card" });
    // The card's row records what went up, a line with no wake to type.
    expect(ledgerFacts.at(-1)).toBeUndefined();
    expect(ops).toHaveLength(opsBefore);

    // While it is up the turn is the captain's: nothing repeats, ever.
    const sortsBefore = sorts.length;
    await at(minutes(600));
    expect(ops).toHaveLength(opsBefore);
    expect(sorts).toHaveLength(sortsBefore);
    expect(supervisor.facts.crewStatus(taskId)[0]?.stalled).toBe("stalled 10h · 2 wakes");
  });

  it("a wake the paused Firstmate never took is not ignored: no stall card while the seat waits, and the clock runs from delivery (W1 S9)", async () => {
    const harness = await stopped();
    // The Firstmate's seat is paused: nothing takes the wakes it is sent.
    wakesThroughInbox(harness, "paused");
    const { supervisor, crewmate, inbox, ops, taskId, at, cards } = harness;
    await at(minutes(10));
    await endTurn(crewmate, taskId);
    await at(minutes(20));
    expect(idleWakes(ops)).toHaveLength(1);

    // However long the pause, the wake waits unread: no repeat, no stall card.
    for (const idle of [50, 80, 200, 600]) await at(minutes(idle));
    expect(idleWakes(ops)).toHaveLength(1);
    expect(cards()).toEqual([]);
    expect(supervisor.facts.crewStatus(taskId)[0]?.stalled).toBe("stalled 10h · 1 wake");

    // The seat serves again at the 600-minute tick and its drain takes the wake.
    const waiting = inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.id);
    expect(waiting).toHaveLength(1);
    inbox.markDelivered(waiting);
    inbox.ack(waiting);
    wakesThroughInbox(harness);
    // Thirty minutes from delivery, not from the wake: the repeat, then the card.
    await at(minutes(630) - 1);
    expect(idleWakes(ops)).toHaveLength(1);
    await at(minutes(630));
    expect(idleWakes(ops)).toHaveLength(2);
    expect(idleWakes(ops)[1]).toContain("This is the second time");
    await at(minutes(660));
    expect(cards().find((entry) => entry.id === `card-stall-${taskId}`)).toBeDefined();
  });

  it("a Firstmate action on the task defers the next rung by thirty minutes", async () => {
    const { supervisor, crewmate, ops, taskId, at } = await stopped();
    await at(minutes(10));
    await endTurn(crewmate, taskId);
    await at(minutes(20));
    expect(idleWakes(ops)).toHaveLength(1);
    // The Firstmate asks for an interrupt at 40 minutes: an action on the
    // task, read from its timeline, so the first wake was not ignored.
    clock.now = clock.now + minutes(20);
    await supervisor.sessions.interruptCrewmate(taskId, "interrupt");
    await at(minutes(50));
    expect(idleWakes(ops)).toHaveLength(1);
    await at(minutes(71));
    expect(idleWakes(ops)).toHaveLength(2);
  });

  it("the task moving on its own ends the episode and takes the host's card down", async () => {
    const { supervisor, crewmate, taskId, at, cards, tasks, idleSince } = await stopped();
    await at(minutes(10));
    await endTurn(crewmate, taskId);
    for (const step of [20, 50, 80]) await at(minutes(step));
    expect(cards().some((card) => card.id === `card-stall-${taskId}`)).toBe(true);

    await supervisor.steer.steerCrewmate(taskId, "carry on with step two");
    await settle();
    expect(cards().some((card) => card.id === `card-stall-${taskId}`)).toBe(false);
    expect(tasks.get(taskId)).toMatchObject({ idleSince: null, recoveryRung: 0, recoveryCount: 0 });
    // Step two takes five minutes.
    clock.now = idleSince + minutes(85);
    await endTurn(crewmate, taskId, "Step two done.");
    // A fresh clock, from this idle boundary.
    expect(tasks.get(taskId)?.idleSince).toBe(idleSince + minutes(85));
    expect(supervisor.facts.crewStatus(taskId)[0]?.stalled).toBeUndefined();
  });

  it("the card's Nudge nudges with the captain's authority", async () => {
    const first = await stopped();
    await first.at(minutes(10));
    await endTurn(first.crewmate, first.taskId);
    for (const step of [20, 50, 80]) await first.at(minutes(step));
    first.supervisor.cardActions.act(`card-stall-${first.taskId}`, "nudge");
    await settle();
    expect(first.crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
    const steered = first.tasks
      .timeline(first.taskId)
      .filter((event) => event.kind === "steered")
      .at(-1);
    expect(steered).toMatchObject({ actor: "captain", data: { via: "card" } });
    expect(first.tasks.get(first.taskId)?.recoveryRung).toBe(0);
    // The stall card's click is a card choice, never also a task card click.
    expect(first.tasks.taskCardClicksSince(0)).toEqual([]);
  });

  // INF-3143, direction A ("Park it where it shows up", the captain's
  // Approve and build): a blocked task whose blocker has not changed parks
  // where its wait shows, instead of the supervision cycle starting again.
  describe("parking a stuck task in the backlog (INF-3143, direction A)", () => {
    const backlogNews = (ops: string[]) =>
      ops.filter((line) => line.includes("waited in the backlog"));

    // The captain's pick on this build: Back to backlog takes Keep waiting's place.
    it("the card's Back to backlog parks it: the card comes down, nothing climbs again, and its work stays", async () => {
      const h = await stopped();
      await h.at(minutes(10));
      await endTurn(h.crewmate, h.taskId);
      for (const step of [20, 50, 80]) await h.at(minutes(step));
      const prompts = h.crewmate.promptCalls.length;
      h.supervisor.cardActions.act(`card-stall-${h.taskId}`, "backlog");
      await settle();
      expect(h.cards().some((card) => card.id === `card-stall-${h.taskId}`)).toBe(false);
      const parked = h.tasks.get(h.taskId);
      expect(parked?.status).toBe("active");
      expect(parked?.backlogSince).toEqual(expect.any(Number));
      expect(parked?.sessionFile).toBeTruthy();
      // Parked, the task is the captain's: no nudge, wake or card, however long.
      const opsBefore = h.ops.length;
      for (const idle of [200, 600, 1_200]) await h.at(minutes(idle));
      expect(h.ops).toHaveLength(opsBefore);
      expect(h.crewmate.promptCalls).toHaveLength(prompts);
      expect(h.cards()).toEqual([]);
    });

    it("the first mate's move to the backlog takes the stuck card down too", async () => {
      const h = await stopped();
      await h.at(minutes(10));
      await endTurn(h.crewmate, h.taskId);
      for (const step of [20, 50, 80]) await h.at(minutes(step));
      expect(h.cards().some((card) => card.id === `card-stall-${h.taskId}`)).toBe(true);
      const moved = h.supervisor.hostOps.moveToBacklog(
        h.taskId,
        { actor: "firstmate", via: "tool", decision: null },
        "Blocked on an outside fix that has not changed.",
      );
      await settle();
      expect(moved.ok).toBe(true);
      expect(h.cards().some((card) => card.id === `card-stall-${h.taskId}`)).toBe(false);
    });

    it("news from the app wakes the first mate once per stay, and the parked crewmate takes no turn for it", async () => {
      const h = await stopped();
      await h.at(minutes(10));
      await endTurn(h.crewmate, h.taskId);
      for (const step of [20, 50, 80]) await h.at(minutes(step));
      h.supervisor.cardActions.act(`card-stall-${h.taskId}`, "backlog");
      await settle();
      const prompts = h.crewmate.promptCalls.length;
      await h.at(minutes(140));
      // A dependency closed: the host's own steer, held on the lane.
      const first = await h.supervisor.steer.steerInternal(
        h.taskId,
        "The task this one waits on has closed.",
        SUPERVISOR_STEER,
      );
      await settle();
      expect(first).toBe("recorded-held");
      expect(backlogNews(h.ops)).toHaveLength(1);
      expect(backlogNews(h.ops)[0]).toContain(
        `task ${h.taskId} "Job" has waited in the backlog for 1h`,
      );
      expect(backlogNews(h.ops)[0]).toContain("The news: The task this one waits on has closed.");
      // More news in the same stay - a job's exit - is held and wakes nobody again.
      h.supervisor.watch.deliverJobResult(h.taskId, "[job] the background wait ended");
      await h.supervisor.steer.steerInternal(h.taskId, "Checks passed.", SUPERVISOR_STEER);
      await settle();
      expect(backlogNews(h.ops)).toHaveLength(1);
      expect(h.crewmate.promptCalls).toHaveLength(prompts);
      expect(h.inbox.allFor(h.taskId).length).toBeGreaterThanOrEqual(3);
    });

    it("the first mate's own words to a parked task are not news", async () => {
      const h = await stopped();
      await endTurn(h.crewmate, h.taskId);
      h.supervisor.hostOps.moveToBacklog(h.taskId, {
        actor: "firstmate",
        via: "tool",
        decision: null,
      });
      await settle();
      await h.supervisor.steer.steerCrewmate(h.taskId, "Note the outside fix's issue link.");
      await settle();
      expect(backlogNews(h.ops)).toEqual([]);
    });
  });

  // INF-1670: the captain's "why is there no reply box to ask questions?",
  // answered by the first mate (question 3, A).
  it("sends a reply under the card to the first mate, never owed by the crewmate, and keeps the card up until it answers", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, ops, taskId, at, cards } = harness;
    const converseAboutCard = vi.fn();
    supervisor.setFirstmateHooks({
      notifyOp: (wake) => ops.push(served(wake)),
      retryConverse: vi.fn(),
      converseAboutCard,
    });
    await at(minutes(10));
    await endTurn(crewmate, taskId);
    for (const step of [20, 50, 80]) await at(minutes(step));
    const stall = `card-stall-${taskId}`;
    const question = "is it stuck because the secret PR hasn't landed yet?";
    supervisor.cardActions.replyToCard(stall, question);
    expect(converseAboutCard).toHaveBeenCalledWith(stall, question, undefined);
    expect(crewmate.promptCalls.some((call) => call.includes(question))).toBe(false);
    expect(
      supervisor.cards.threadActivitySince(0).find((entry) => entry.card.id === stall)?.owed,
    ).toBe("firstmate");

    // The task moves before the first mate answers: the card stays up.
    await supervisor.steer.steerCrewmate(taskId, "carry on with step two");
    await settle();
    expect(cards().some((card) => card.id === stall)).toBe(true);
    await endTurn(crewmate, taskId, "Step two done.");
    // The first mate's closing words are its line, naming no message: their
    // question stays open (the captain's "a handoff stays open").
    expect(supervisor.cards.recordFirstmateThreadAnswer(stall, "Reading PR #496 now.")).toBe(true);
    expect(
      supervisor.cards.threadActivitySince(0).find((entry) => entry.card.id === stall)?.owed,
    ).toBe("firstmate");
    await supervisor.steer.steerCrewmate(taskId, "and step three");
    await settle();
    expect(cards().some((card) => card.id === stall)).toBe(true);
    await endTurn(crewmate, taskId, "Step three done.");
    // Its answer names their message, in a reply on the app's own card.
    const shown = cards().find((card) => card.id === stall) as Card;
    expect(
      supervisor.contributeAsFirstmate({
        id: stall,
        title: shown.title,
        body: shown.body,
        actions: [],
        reply: "Yes: it waits on PR #496.",
        answersMessage: askedOn(supervisor, stall),
      }),
    ).toMatchObject({ effect: "reply-only" });
    expect(supervisor.cards.thread(stall).messages.map((message) => message.who)).toEqual([
      "captain",
      "firstmate",
      "firstmate",
    ]);

    // Answered, the next move takes it down as before.
    await supervisor.steer.steerCrewmate(taskId, "and step four");
    await settle();
    expect(cards().some((card) => card.id === stall)).toBe(false);
  });

  it("the card's Discard runs the host's discard, and the captain's close keeps the task quietly", async () => {
    const first = await stopped();
    await first.at(minutes(10));
    await endTurn(first.crewmate, first.taskId);
    for (const step of [20, 50, 80]) await first.at(minutes(step));
    first.supervisor.cardActions.act(`card-stall-${first.taskId}`, "discard");
    await settle();
    expect(first.tasks.get(first.taskId)).toMatchObject({ closedReason: "discarded" });

    const second = await stopped();
    await second.at(minutes(10));
    await endTurn(second.crewmate, second.taskId);
    for (const step of [20, 50, 80]) await second.at(minutes(step));
    second.supervisor.close(`card-stall-${second.taskId}`);
    await settle();
    const opsBefore = second.ops.length;
    await second.at(minutes(400));
    // The keep: no more wakes or cards this episode, the context line stays.
    expect(second.ops).toHaveLength(opsBefore);
    expect(second.cards()).toEqual([expect.objectContaining({ minimized: true })]);
    expect(second.supervisor.facts.crewStatus(second.taskId)[0]?.stalled).toBe(
      "stalled 6h 40m · 2 wakes",
    );
  });

  it("reads the same witnesses in the whose-turn order: each one holds the ladder back", async () => {
    type Harness = Awaited<ReturnType<typeof stopped>>;
    const witnesses: Array<{
      name: string;
      extras?: SetupExtras;
      arrange?: (harness: Harness) => void | Promise<void>;
    }> = [
      {
        name: "a crewmate's decision card",
        arrange: ({ specs }) => {
          specs[0]?.onCard?.({
            title: "Pick a course",
            body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
            actions: [
              { id: "hold", label: "Hold course" },
              { id: "change", label: "Plot new course", default: true },
            ],
          });
        },
      },
      {
        name: "a host card with actions",
        arrange: ({ supervisor, taskId }) =>
          supervisor.cards.hostCards.raiseHostCard({
            id: "card-host-consent",
            taskId,
            title: "Add a panel",
            meta: "panels",
            body: "<p>Add it?</p>",
            actions: [
              { id: "add", label: "Add", effect: { kind: "host", op: "add-plugin", arg: "p" } },
            ],
          }),
      },
      {
        name: "the crewmate's sign-in card",
        arrange: ({ supervisor, taskId }) =>
          supervisor.cards.hostCards.addAuthDecisionCard(
            `card-auth-${taskId}`,
            "crewmate 1",
            "Sign in.",
            {
              taskId,
            },
          ),
      },
      {
        name: "a young background job",
        extras: {
          hasRunningJobs: () => true,
          oldestRunningJob: () => ({ jobId: "j1", command: "pnpm test", startedAt: clock.now }),
        },
      },
      {
        name: "guidance waiting out its backoff",
        arrange: async ({ supervisor, crewmate, taskId }) => {
          await supervisor.steer.steerCrewmate(taskId, "try the other route");
          await settle();
          await failTurn(crewmate, taskId);
        },
      },
      {
        name: "a captured settle",
        arrange: ({ tasks, taskId }) =>
          tasks.delivery.setPendingSettle(taskId, {
            mode: "land",
            actor: "captain",
            requestedAt: clock.now,
            proceedWithOpen: false,
          }),
      },
    ];
    for (const witness of witnesses) {
      const harness = await stopped(witness.extras);
      await witness.arrange?.(harness);
      await settle();
      const prompts = harness.crewmate.promptCalls.length;
      await harness.at(minutes(200));
      expect(harness.crewmate.promptCalls, witness.name).toHaveLength(prompts);
      expect(idleWakes(harness.ops), witness.name).toEqual([]);
    }

    // A note holds nothing: the crewmate may post an FYI and stop. The
    // nudge names it rather than claim nothing is up (FI3-438).
    const noted = await stopped();
    noted.specs[0]?.onCard?.({ title: "FYI", body: "<p>The pin moved.</p>", actions: [] });
    await noted.at(minutes(10));
    const fyi = noted.cards().find((card) => card.title === "FYI") as Card;
    expect(noted.crewmate.promptCalls.at(-1)).toBe(idleNoteNudgeText({ id: fyi.id, title: "FYI" }));

    // Cards are read by task, never by id: a card that only LOOKS like the
    // task's sign-in card, carrying no task, holds nothing.
    const named = await stopped();
    named.supervisor.cards.hostCards.addAuthDecisionCard(
      `card-auth-${named.taskId}`,
      "crewmate 1",
      "Sign in.",
    );
    await named.at(minutes(10));
    expect(named.crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
  });

  // FI3-438, from FI3-434: a finished release's crewmate stopped with its
  // outcome note up and declared no wait. The note holds nothing, so the
  // ladder climbs - but each rung names the note, so the crewmate is not
  // asked to post it again and the Firstmate is never told no card is up.
  it("names the note up on the task at every rung, never claiming no card is up (FI3-438)", async () => {
    const { supervisor, crewmate, specs, ops, ledgerFacts, taskId, at, cards } = await stopped();
    specs[0]?.onCard?.({ title: "Released 0.1.30", body: "<p>0.1.30 is out.</p>", actions: [] });
    await settle();
    const outcome = cards().find((card) => card.title === "Released 0.1.30") as Card;
    const note = { id: outcome.id, title: outcome.title };

    await at(minutes(10));
    expect(crewmate.promptCalls.at(-1)).toBe(idleNoteNudgeText(note));
    expect(ledgerFacts.at(-1)).toEqual({ kind: "idle-nudge", thread: false, note });
    // Its nudge's turn ends with no wait declared, and it stays idle.
    await endTurn(crewmate, taskId);
    await at(minutes(20));
    expect(idleWakes(ops).map((wake) => wake.split("\n")[0])).toEqual([
      `[fm-op] crewmate 1 on task ${taskId} "Job" has been idle for 20m with nothing running, nothing queued and only the note "Released 0.1.30" (${note.id}) up, which asks the captain nothing; the host's nudge did not move it. If that note is its outcome, steer it to report waiting on the captain naming the note, never to post it again. Its last report: Done with step one.`,
    ]);
    expect(ledgerFacts.at(-1)).toMatchObject({ kind: "idle-stall", note });

    // The stall card's Nudge is the same nudge, naming the same note.
    for (const step of [50, 80]) await at(minutes(step));
    supervisor.cardActions.act(`card-stall-${taskId}`, "nudge");
    await settle();
    expect(crewmate.promptCalls.at(-1)).toBe(idleNoteNudgeText(note));
  });

  // INF-1732: INF-1718's crewmate was nudged for a completion card on an
  // answer task, said "The task is finished" in prose, and its task stayed
  // open. An answer task's nudge names the finished flag instead.
  it("nudges an idle answer task for finished, never a completion card (INF-1732)", async () => {
    const { crewmate, tasks, taskId, at, ledgerFacts } = await stopped(
      {
        classifier: {
          classify: async () =>
            ({
              kind: "research",
              source: "classifier:xai/grok-cheap",
              version: "kc1-abc",
            }) as const,
        },
      },
      fakeCrewmate(),
      { ...intentOf("why is nothing running?"), constraints: [{ kind: "read-only" }] },
    );
    expect(tasks.get(taskId)?.shape?.deliverable).toBe("answer");
    await at(minutes(10));
    expect(ledgerFacts.at(-1)).toEqual({ kind: "idle-nudge", thread: false, answer: true });
    expect(crewmate.promptCalls.at(-1)).toBe(IDLE_ANSWER_NUDGE_TEXT);
    expect(crewmate.promptCalls.at(-1)).toContain("report with finished true");
    expect(crewmate.promptCalls.at(-1)).not.toContain("completion card -");
  });
});
