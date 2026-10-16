import type { FmEvent, FmUsage } from "@shared/events";
import { FIRSTMATE_SESSION_ID } from "@shared/observe";
import type { TaskView } from "@shared/tasks";
import { afterEach, describe, expect, it } from "vitest";
import { FLICKER_TUNING, takeFirstmateFlicker, tokenIntensity } from "../flicker";
import { simulateReducedMotion } from "../reducedMotion";
import { ComputerOrbits } from "./computers";
import { applyCrewEvent, crewStatusOf, seedCrew } from "./crewSignal";
import { CrewOrbit, DEFAULT_ORBIT, type OrbitFrame } from "./orbit";

type Changed = Extract<FmEvent, { type: "task_changed" }>;

function changed(patch: Partial<Changed>): Changed {
  return {
    type: "task_changed",
    taskId: "t1",
    key: "SCR-1",
    kind: "work",
    status: "active",
    from: "open",
    activity: "starting",
    closedReason: null,
    seq: 1,
    ...patch,
  };
}

function run(model: CrewOrbit, from: number, until: number): OrbitFrame {
  let frame = model.update(from);
  for (let t = from + 16; t <= until; t += 16) frame = model.update(t);
  return frame;
}

function view(patch: Partial<TaskView>): TaskView {
  return {
    id: "t1",
    key: "SCR-1",
    projectId: "scratch",
    parentId: null,
    kind: "work",
    title: "a task",
    goal: null,
    priority: 2,
    status: "active",
    activity: "running",
    closedReason: null,
    startPolicy: "when-ready",
    flags: { blocked: false, held: false, needsYou: false, ready: false },
    blockedBy: [],
    blocks: [],
    children: { total: 0, closed: 0 },
    assignee: "crewmate 1",
    model: null,
    tier: null,
    repo: null,
    delivery: null,
    outcomeSummary: null,
    waitingCardId: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    closedAt: null,
    ...patch,
  };
}

describe("crew orbit wiring", () => {
  it("keeps older-home placement unknown until the board supplies the actual computer", () => {
    const model = new ComputerOrbits(0, () => 0.5);
    model.configure([{ id: "peer", kind: "work", name: "Studio", pairedAt: 1, inReach: true }]);
    seedCrew(model, [view({})], 0);
    expect(model.multiple).toBe(false);
    seedCrew(model, [view({ executionDeviceId: "peer" })], 1);
    expect(model.multiple).toBe(true);
    expect(model.update(1, true).crew[0]?.computerId).toBe("peer");
  });

  it("uses the same posture on boot and live changes while the thread badge stays turn-only", () => {
    const m = new CrewOrbit(0);
    seedCrew(m, [view({ activity: "idle", workPosture: { state: "active", reason: "job" } })], 0);
    expect(m.update(0).working).toBe(1);
    applyCrewEvent(
      m,
      changed({ activity: "idle", workPosture: { state: "idle", reason: "captain" } }),
      1,
    );
    expect(m.update(1).idle).toBe(1);
    applyCrewEvent(
      m,
      changed({ activity: "idle", workPosture: { state: "active", reason: "guidance" } }),
      2,
    );
    expect(m.update(2).working).toBe(1);
    expect(crewStatusOf("idle")).toBe("idle");
  });

  it("reads working vs idle the way the core counts it", () => {
    expect(crewStatusOf("starting")).toBe("working");
    expect(crewStatusOf("running")).toBe("working");
    expect(crewStatusOf("idle")).toBe("idle");
    expect(crewStatusOf("interrupted")).toBe("idle");
    expect(crewStatusOf(null)).toBe("idle");
  });

  it("sends a crewmate out on task_started and follows its activity", () => {
    const m = new CrewOrbit(0);
    applyCrewEvent(
      m,
      { type: "task_started", taskId: "t1", title: "x", machineId: "m", crewmate: "crewmate 1" },
      0,
    );
    expect(m.present()).toEqual(["t1"]);
    // The record's own write for the same dispatch is not a second spawn.
    applyCrewEvent(m, changed({ activity: "starting" }), 5);
    expect(m.present()).toEqual(["t1"]);
    applyCrewEvent(m, changed({ activity: "idle", from: "active" }), 10);
    expect(m.statusOf("t1")).toBe("idle");
  });

  it("only work tasks are crewmates", () => {
    const m = new CrewOrbit(0);
    applyCrewEvent(m, changed({ kind: "question" }), 0);
    applyCrewEvent(m, changed({ kind: "operation" }), 0);
    expect(m.present()).toEqual([]);
  });

  it("folds a finished crewmate home and lets a dropped one drift away", () => {
    const m = new CrewOrbit(0);
    applyCrewEvent(m, changed({ taskId: "a" }), 0);
    applyCrewEvent(m, changed({ taskId: "b" }), 0);
    run(m, 0, 2000);
    m.takeCues();
    applyCrewEvent(
      m,
      changed({ taskId: "a", status: "done", from: "active", closedReason: "landed" }),
      2000,
    );
    applyCrewEvent(
      m,
      changed({ taskId: "b", status: "dropped", from: "active", closedReason: "cancelled" }),
      2000,
    );
    const mid = m.update(2100);
    expect(mid.crew.find((c) => c.id === "a")?.leaveMode).toBe("home");
    expect(mid.crew.find((c) => c.id === "b")?.leaveMode).toBe("away");
    const end = run(m, 2116, 2000 + DEFAULT_ORBIT.awayMs + 40);
    expect(end.crew).toEqual([]);
    // Only the one that came home is received by the Firstmate.
    expect(m.takeCues()).toEqual([{ kind: "receive" }]);
    // A later write on the closed row changes nothing.
    applyCrewEvent(m, changed({ taskId: "a", status: "done", from: "done" }), 3000);
    expect(m.present()).toEqual([]);
  });

  it("turns reports, steers and failed turns into their moments", () => {
    const m = new CrewOrbit(0);
    applyCrewEvent(m, changed({}), 0);
    run(m, 0, 2000);
    m.takeCues();
    applyCrewEvent(
      m,
      { type: "task_report", taskId: "t1", title: "x", crewmate: "crewmate 1" },
      2000,
    );
    expect(m.update(2100).packets.map((p) => p.direction)).toEqual(["report"]);
    applyCrewEvent(
      m,
      {
        type: "task_event",
        taskId: "t1",
        key: "SCR-1",
        kind: "steered",
        text: "go",
        at: 0,
        feed: false,
      },
      2100,
    );
    expect(m.takeCues().map((c) => c.kind)).toEqual(["sendoff"]);
    // A Firstmate-side failed turn is not a crewmate's.
    const v = m.version;
    applyCrewEvent(m, { type: "turn_failed", taskId: "firstmate", error: "x" }, 2200);
    expect(m.version).toBe(v);
    applyCrewEvent(
      m,
      { type: "turn_failed", taskId: "t1", error: "x", crewmate: "crewmate 1" },
      2200,
    );
    expect(m.update(2300).crew[0]?.nudge ?? 0).toBeGreaterThan(0);
  });

  it("seeds the roster at boot settled on the ring, with no send-off", () => {
    const m = new CrewOrbit(0);
    seedCrew(
      m,
      [
        view({ id: "a", activity: "running" }),
        view({ id: "b", activity: "interrupted" }),
        view({ id: "c", status: "done", activity: null }),
        view({ id: "d", kind: "question" }),
      ],
      0,
    );
    const frame = m.update(16);
    expect(frame.crew.map((c) => [c.id, c.phase, c.unfold, c.spark])).toEqual([
      ["a", "orbiting", 1, 0],
      ["b", "orbiting", 1, 0],
    ]);
    expect(frame.working).toBe(1);
    expect(frame.idle).toBe(1);
    expect(m.takeCues()).toEqual([]);
  });

  it("marks only the builder of a live adversarial review, and clears it when review ends", () => {
    const m = new CrewOrbit(0);
    seedCrew(
      m,
      [
        view({ id: "builder", activity: "idle" }),
        view({ id: "ordinary-child", parentId: "builder" }),
        view({ id: "reviewer", parentId: "builder", reviewOf: "builder", activity: "idle" }),
      ],
      0,
    );
    const marked = () =>
      m
        .update(1000)
        .crew.filter((c) => c.reviewActive)
        .map((c) => c.id);
    expect(marked()).toEqual(["builder"]);
    // A second live reviewer does not replace the first or put electrons on itself.
    applyCrewEvent(m, changed({ taskId: "reviewer-2", reviewOf: "builder" }), 1010);
    expect(marked()).toEqual(["builder"]);
    applyCrewEvent(
      m,
      changed({ taskId: "reviewer", reviewOf: "builder", status: "done", from: "active" }),
      1020,
    );
    expect(marked()).toEqual(["builder"]);
    applyCrewEvent(
      m,
      changed({ taskId: "reviewer-2", reviewOf: "builder", status: "done", from: "active" }),
      1030,
    );
    expect(marked()).toEqual([]);
    // An ordinary child changing activity cannot trigger the review cue.
    applyCrewEvent(m, changed({ taskId: "ordinary-child", activity: "running" }), 1040);
    expect(marked()).toEqual([]);
  });

  it("leaves crewmate spin and position byte-for-byte unchanged by the review cue", () => {
    const plain = new CrewOrbit(0, undefined, () => 0.5);
    const reviewed = new CrewOrbit(0, undefined, () => 0.5);
    for (const model of [plain, reviewed]) model.spawn("builder", "working", 0, true);
    reviewed.setReview("reviewer", "builder");
    for (const t of [0, 16, 200, 1000, 2300, 3600]) {
      const a = plain.update(t).crew[0];
      const b = reviewed.update(t).crew[0];
      expect(b?.spin).toBe(a?.spin);
      expect(b?.x).toBe(a?.x);
      expect(b?.y).toBe(a?.y);
      expect(b?.work).toBe(a?.work);
    }
  });

  it("paints each crewmate's solid from the slot it is served on", () => {
    const m = new CrewOrbit(0);
    // At boot the board says which slot each crewmate runs on; a row that
    // never routed (null) keeps the unknown solid.
    seedCrew(
      m,
      [
        view({ id: "p", tier: "premium" }),
        view({ id: "h", tier: "high" }),
        view({ id: "n", tier: null }),
      ],
      0,
    );
    let t = 16;
    /** The crewmate's tier as the painter sees it, a little later. */
    const tierOf = (id: string) => {
      t += 1000;
      return run(m, t - 984, t).crew.find((c) => c.id === id)?.tier;
    };
    expect(tierOf("p")).toBe("premium");
    expect(tierOf("h")).toBe("high");
    expect(tierOf("n")).toBeUndefined();

    // Live, the record's change carries it: a new crewmate arrives with its
    // solid, a re-route moves it, a change that says nothing leaves it, and
    // a row that lost its routing goes back to the unknown solid.
    applyCrewEvent(m, changed({ taskId: "l", tier: "low" }), t);
    expect(tierOf("l")).toBe("low");
    applyCrewEvent(m, changed({ taskId: "l", tier: "medium", activity: "running" }), t);
    expect(tierOf("l")).toBe("medium");
    applyCrewEvent(m, changed({ taskId: "l", activity: "idle" }), t);
    expect(tierOf("l")).toBe("medium");
    applyCrewEvent(m, changed({ taskId: "l", tier: null, activity: "running" }), t);
    expect(tierOf("l")).toBeUndefined();
  });

  it("a crewmate sent out before its slot is known takes its solid when the record says", () => {
    const m = new CrewOrbit(0);
    applyCrewEvent(
      m,
      { type: "task_started", taskId: "t1", title: "x", machineId: "m", crewmate: "crewmate 1" },
      0,
    );
    expect(m.update(16).crew[0]?.tier).toBeUndefined();
    applyCrewEvent(m, changed({ tier: "high" }), 20);
    expect(m.update(36).crew[0]?.tier).toBe("high");
  });
});

describe("the token flicker", () => {
  const seeded = () => {
    let s = 11;
    return () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  };
  const turnEnd = (taskId: string, usage?: FmUsage): FmEvent => ({
    type: "turn_end",
    taskId,
    ...(usage ? { usage } : {}),
  });
  /** Two crewmates settled on the ring by 2s, nothing else going on. */
  const crew = () => {
    const m = new CrewOrbit(0, { ...DEFAULT_ORBIT }, seeded());
    applyCrewEvent(m, changed({ taskId: "a" }), 0);
    applyCrewEvent(m, changed({ taskId: "b" }), 0);
    run(m, 0, 2000);
    m.takeCues();
    return m;
  };
  const flickerOf = (frame: OrbitFrame, id: string) =>
    frame.crew.find((c) => c.id === id)?.flicker ?? Number.NaN;
  /** The brightest a crewmate gets across a flicker, sampled every frame. */
  const peak = (m: CrewOrbit, id: string, from: number) => {
    let max = 0;
    for (let t = from; t < from + FLICKER_TUNING.durationMs; t += 16) {
      max = Math.max(max, flickerOf(m.update(t), id));
    }
    return max;
  };
  const drain = () => {
    const out: number[] = [];
    for (let s = takeFirstmateFlicker(); s !== undefined; s = takeFirstmateFlicker()) out.push(s);
    return out;
  };

  afterEach(() => {
    simulateReducedMotion(null);
    drain();
  });

  it("flickers the crewmate whose request finished, and nobody else", () => {
    const m = crew();
    applyCrewEvent(m, turnEnd("a", { input: 30_000, output: 900, cacheRead: 9_100 }), 2000);
    const frame = m.update(2060);
    expect(flickerOf(frame, "a")).toBeGreaterThan(0);
    expect(flickerOf(frame, "b")).toBe(0);
    expect(drain()).toEqual([]);
  });

  it("queues the Firstmate's own request for the character, not the ring", () => {
    const m = crew();
    const usage = { input: 12_000, output: 400, cacheWrite: 600 };
    applyCrewEvent(m, turnEnd(FIRSTMATE_SESSION_ID, usage), 2000);
    expect(drain()).toEqual([tokenIntensity(13_000)]);
    const frame = m.update(2060);
    expect(flickerOf(frame, "a")).toBe(0);
    expect(flickerOf(frame, "b")).toBe(0);
  });

  it("is brighter for a bigger request", () => {
    const small = crew();
    const big = crew();
    applyCrewEvent(small, turnEnd("a", { input: 300, output: 60 }), 2000);
    applyCrewEvent(big, turnEnd("a", { input: 250_000, output: 4_000, cacheRead: 150_000 }), 2000);
    const smallPeak = peak(small, "a", 2000);
    const bigPeak = peak(big, "a", 2000);
    expect(smallPeak).toBeGreaterThan(0);
    expect(bigPeak).toBeGreaterThan(smallPeak * 4);
  });

  it("leaves the crew exactly as it was once the flicker is over", () => {
    const flickered = crew();
    const untouched = crew();
    applyCrewEvent(flickered, turnEnd("a", { input: 400_000, output: 8_000 }), 2000);
    peak(flickered, "a", 2000);
    peak(untouched, "a", 2000);
    const t = 2000 + FLICKER_TUNING.durationMs + 16;
    expect(flickered.update(t)).toEqual(untouched.update(t));
  });

  it("flickers a crewmate of every tier, whatever its solid", () => {
    const m = new CrewOrbit(0, { ...DEFAULT_ORBIT }, seeded());
    const tiers = ["low", "medium", "high", "premium"] as const;
    for (const tier of tiers) applyCrewEvent(m, changed({ taskId: tier, tier }), 0);
    run(m, 0, 2000);
    for (const tier of tiers) {
      applyCrewEvent(m, turnEnd(tier, { input: 60_000 }), 2000);
      const frame = m.update(2060);
      expect(frame.crew.find((c) => c.id === tier)?.tier).toBe(tier);
      expect(flickerOf(frame, tier)).toBeGreaterThan(0);
      run(m, 2076, 2000 + FLICKER_TUNING.durationMs + 32);
    }
  });

  it("does nothing for a turn with no usage, or none spent", () => {
    const m = crew();
    const v = m.version;
    applyCrewEvent(m, turnEnd("a"), 2000);
    applyCrewEvent(m, turnEnd("a", { cost: 0.01 }), 2000);
    applyCrewEvent(m, turnEnd(FIRSTMATE_SESSION_ID), 2000);
    expect(peak(m, "a", 2000)).toBe(0);
    expect(drain()).toEqual([]);
    expect(m.version).toBe(v);
  });

  it("does nothing under reduced motion", () => {
    simulateReducedMotion(true);
    const m = crew();
    applyCrewEvent(m, turnEnd("a", { input: 400_000 }), 2000);
    applyCrewEvent(m, turnEnd(FIRSTMATE_SESSION_ID, { input: 400_000 }), 2000);
    expect(peak(m, "a", 2000)).toBe(0);
    expect(drain()).toEqual([]);
  });
});
