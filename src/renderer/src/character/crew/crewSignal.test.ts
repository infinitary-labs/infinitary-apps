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

/** The core's announcement that something sent reached a crewmate (INF-759). */
function reached(taskId: string): FmEvent {
  return {
    type: "task_event",
    taskId,
    key: "SCR-1",
    kind: "reached",
    text: "",
    at: 0,
    feed: false,
    reached: true,
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

  // INF-676, the captain's direction A: waiting on its checks stays among the
  // working, banked at idle pace inside the checks ring, from boot or a live
  // change, and heats back to full ember the moment a turn runs.
  it("banks a crewmate waiting on its checks and heats it again when its turn runs", () => {
    const checks = { state: "active", reason: "checks" } as const;
    const booted = new CrewOrbit(0);
    seedCrew(booted, [view({ activity: "idle", workPosture: checks })], 0);
    const boot = booted.update(0);
    expect(boot.working).toBe(1);
    expect(boot.crew[0]).toMatchObject({ status: "working", work: 0, checks: 1 });

    const m = new CrewOrbit(0);
    seedCrew(m, [view({ workPosture: { state: "active", reason: "turn" } })], 0);
    expect(m.update(0).crew[0]?.checks).toBeUndefined();
    applyCrewEvent(m, changed({ activity: "idle", workPosture: checks }), 16);
    const waiting = run(m, 16, 2000);
    expect(waiting.working).toBe(1);
    expect(waiting.crew[0]?.work).toBeLessThan(0.01);
    expect(waiting.crew[0]?.checks).toBeGreaterThan(0.99);
    expect(waiting.crew[0]?.checksArc).toBeDefined();
    // Reduced motion draws the ring whole and still.
    expect(m.update(2016, true).crew[0]?.checksArc).toBeUndefined();

    applyCrewEvent(
      m,
      changed({ activity: "running", workPosture: { state: "active", reason: "turn" } }),
      2032,
    );
    const turn = run(m, 2032, 4000);
    expect(turn.crew[0]?.work).toBeGreaterThan(0.99);
    expect(turn.crew[0]?.checks).toBeUndefined();
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
    // INF-759: a message only recorded - held for its account, say - draws
    // nothing; the spark flies when the core says it reached the crewmate.
    applyCrewEvent(
      m,
      {
        type: "task_event",
        taskId: "t1",
        key: "SCR-1",
        kind: "steered",
        text: "go",
        at: 0,
        feed: true,
      },
      2100,
    );
    expect(m.takeCues()).toEqual([]);
    applyCrewEvent(m, reached("t1"), 2100);
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

  // INF-759, the captain's answer "After the spark lands": a close that
  // reached the crewmate sparks first, and it leaves once the spark lands.
  it("lets a closing crewmate's spark land before it leaves", () => {
    const m = new CrewOrbit(0);
    applyCrewEvent(m, changed({}), 0);
    run(m, 0, 2000);
    m.takeCues();
    applyCrewEvent(m, reached("t1"), 2000);
    applyCrewEvent(
      m,
      changed({ status: "done", from: "active", closedReason: "merged", activity: null }),
      2000,
    );
    expect(m.takeCues().map((c) => c.kind)).toEqual(["sendoff"]);
    const flying = run(m, 2016, 2000 + DEFAULT_ORBIT.packetMs - 20);
    expect(flying.packets.map((p) => p.direction)).toEqual(["steer"]);
    expect(flying.crew[0]?.phase).toBe("orbiting");
    const landed = run(m, 2000 + DEFAULT_ORBIT.packetMs, 2000 + DEFAULT_ORBIT.packetMs + 40);
    expect(landed.packets).toEqual([]);
    expect(landed.crew[0]?.phase).toBe("leaving");
    expect(landed.crew[0]?.leaveMode).toBe("home");
  });

  it("leaves at once under reduced motion, its spark landed with the frame", () => {
    const m = new CrewOrbit(0);
    applyCrewEvent(m, changed({}), 0);
    m.update(16, true);
    applyCrewEvent(m, reached("t1"), 100);
    applyCrewEvent(
      m,
      changed({ status: "dropped", from: "active", closedReason: "cancelled", activity: null }),
      100,
    );
    expect(m.update(116, true).crew).toEqual([]);
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

  // Captain's INF-51 choice: the reviewer circles its builder in place of electrons.
  describe("a live review", () => {
    const adaptive = () => new CrewOrbit(0, undefined, () => 0.5, "adaptive");
    const rows = [
      view({ id: "builder", key: "SCR-1", activity: "idle" }),
      view({ id: "ordinary-child", key: "SCR-3", parentId: "builder" }),
      view({
        id: "reviewer",
        key: "SCR-2",
        parentId: "builder",
        reviewOf: "builder",
        activity: "idle",
      }),
      view({ id: "other", key: "SCR-4", activity: "idle" }),
    ];
    const gap = (m: CrewOrbit, t: number, a: string, b: string) => {
      const crew = m.update(t, true).crew;
      const p = crew.find((c) => c.id === a);
      const q = crew.find((c) => c.id === b);
      return Math.hypot((p?.x ?? 0) - (q?.x ?? 0), (p?.y ?? 0) - (q?.y ?? 0));
    };
    const base = (reviewOf: string | undefined) => {
      const m = adaptive();
      seedCrew(
        m,
        rows.map((r) => (r.id === "reviewer" && !reviewOf ? { ...r, reviewOf: undefined } : r)),
        0,
      );
      return m;
    };

    it("moves only the reviewer onto a circle about its builder, and back when the review closes", () => {
      const plain = base(undefined);
      const m = base("builder");
      const a = plain.update(0, true).crew;
      const b = m.update(0, true).crew;
      for (const id of ["builder", "ordinary-child", "other"]) {
        expect(b.find((c) => c.id === id)).toEqual(a.find((c) => c.id === id));
      }
      // Within the circle's reach (64 scene px, projected) and off its own slot.
      expect(gap(m, 0, "reviewer", "builder")).toBeLessThan(80);
      expect(gap(m, 0, "reviewer", "builder")).toBeGreaterThan(8);
      m.setReview("reviewer", null);
      expect(m.update(200, true).crew.find((c) => c.id === "reviewer")).toEqual(
        plain.update(200, true).crew.find((c) => c.id === "reviewer"),
      );
    });

    it("has no electrons and follows an idle re-review through the task record", () => {
      const m = base(undefined);
      applyCrewEvent(m, changed({ taskId: "reviewer", reviewOf: "builder", activity: "idle" }), 10);
      expect(m.update(20, true).crew.every((c) => !("reviewActive" in c))).toBe(true);
      expect(gap(m, 20, "reviewer", "builder")).toBeLessThan(80);
    });

    it("travels around its builder on the stage clock and holds still when settled", () => {
      const m = base("builder");
      const angle = (frame: OrbitFrame) => {
        const r = frame.crew.find((c) => c.id === "reviewer");
        const b = frame.crew.find((c) => c.id === "builder");
        return Math.atan2((r?.y ?? 0) - (b?.y ?? 0), (r?.x ?? 0) - (b?.x ?? 0));
      };
      const first = angle(run(m, 0, 3000));
      const turned = Math.abs(first - angle(run(m, 3016, 6000)));
      expect(Math.min(turned, 2 * Math.PI - turned)).toBeGreaterThan(0.1);
      const still = angle(m.update(3000, true));
      expect(angle(m.update(9000, true))).toBeCloseTo(still, 5);
    });

    it("circles its builder, not the other way, when the board holds the builder on the review", () => {
      // The real board: the host blocks the builder on its review and shows it idle on a dependency.
      const m = adaptive();
      seedCrew(
        m,
        [
          view({
            id: "builder",
            key: "SCR-1",
            activity: "idle",
            blockedBy: ["SCR-2"],
            workPosture: { state: "idle", reason: "dependency" },
          }),
          view({ id: "reviewer", key: "SCR-2", reviewOf: "builder", activity: "running" }),
        ],
        0,
      );
      const plain = adaptive();
      seedCrew(
        plain,
        [view({ id: "builder", key: "SCR-1" }), view({ id: "reviewer", key: "SCR-2" })],
        0,
      );
      const frame = m.update(0, true);
      const slots = plain.update(0, true).crew;
      // One arrow, the reviewer's to its builder: the builder draws none back (INF-304).
      expect(frame.links).toEqual([{ fromId: "reviewer", toId: "builder", kind: "review" }]);
      expect(frame.crew.find((c) => c.id === "builder")?.x).toBe(
        slots.find((c) => c.id === "builder")?.x,
      );
      expect(frame.crew.find((c) => c.id === "reviewer")?.x).not.toBe(
        slots.find((c) => c.id === "reviewer")?.x,
      );
    });

    it("leaves from the seat it was drawn at when its review task closes, then glides to its path", () => {
      const m = base("builder");
      run(m, 0, 3000);
      const seat = m.update(3016).crew.find((c) => c.id === "reviewer");
      applyCrewEvent(
        m,
        changed({ taskId: "reviewer", reviewOf: "builder", status: "done", from: "active" }),
        3016,
      );
      const first = m.update(3032).crew.find((c) => c.id === "reviewer");
      // No jump: one frame later it is still near the drawn seat, not at its reserved slot.
      expect(
        Math.hypot((first?.x ?? 0) - (seat?.x ?? 0), (first?.y ?? 0) - (seat?.y ?? 0)),
      ).toBeLessThan(10);
      expect(first?.phase).toBe("leaving");
      // The offset eases out over the fall: well on its way to the plain path before it ends.
      const plain = base(undefined);
      run(plain, 0, 3000);
      applyCrewEvent(plain, changed({ taskId: "reviewer", status: "done", from: "active" }), 3016);
      const reviewerAt = (model: CrewOrbit, from: number, to: number) => {
        const frame = run(model, from, to).crew.find((c) => c.id === "reviewer");
        expect(frame).toBeDefined();
        return frame;
      };
      const gap = (a?: { x: number; y: number }, b?: { x: number; y: number }) =>
        Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
      const early = gap(reviewerAt(m, 3048, 3100), reviewerAt(plain, 3048, 3100));
      const later = gap(reviewerAt(m, 3116, 3500), reviewerAt(plain, 3116, 3500));
      expect(later).toBeLessThan(early);
    });

    it("aims a steer's send-off and its packets at where the reviewer is drawn", () => {
      const m = base("builder");
      m.update(0, true);
      m.signal("reviewer", "report", 0);
      const frame = m.update(100);
      const drawn = frame.crew.find((c) => c.id === "reviewer");
      const packet = frame.packets[0];
      // A report packet starts at the crewmate itself.
      expect(packet?.direction).toBe("report");
      expect(
        Math.hypot((packet?.x ?? 0) - (drawn?.x ?? 0), (packet?.y ?? 0) - (drawn?.y ?? 0)),
      ).toBeLessThan(Math.hypot(drawn?.x ?? 0, drawn?.y ?? 0));
      m.takeCues();
      m.signal("reviewer", "steer", 200);
      const cue = m.takeCues().find((c) => c.kind === "sendoff");
      const len = Math.hypot(drawn?.x ?? 0, drawn?.y ?? 0);
      expect(cue).toMatchObject({
        dx: expect.closeTo((drawn?.x ?? 0) / len, 1),
        dy: expect.closeTo((drawn?.y ?? 0) / len, 1),
      });
    });

    it("keeps an ordinary child and a reviewer of someone absent on their slots", () => {
      const m = adaptive();
      seedCrew(m, [view({ id: "a" }), view({ id: "r", reviewOf: "gone" })], 0);
      const plain = adaptive();
      seedCrew(plain, [view({ id: "a" }), view({ id: "r" })], 0);
      expect(m.update(0, true).crew).toEqual(plain.update(0, true).crew);
    });

    it("shares three seats and keeps reviewers beyond them on their slots, each with its arrow", () => {
      const ids = ["r1", "r2", "r3", "r4"];
      const stage = (reviewers: string[], reviewing: boolean) => {
        const m = adaptive();
        seedCrew(
          m,
          [
            view({ id: "builder", activity: "idle" }),
            ...reviewers.map((id) =>
              view({ id, reviewOf: reviewing ? "builder" : undefined, activity: "idle" }),
            ),
          ],
          0,
        );
        return m.update(0, true);
      };
      const arrows = (frame: OrbitFrame) =>
        frame.links.map((link) => `${link.fromId}>${link.toId}`).sort();
      const xOf = (frame: OrbitFrame, id: string) => frame.crew.find((c) => c.id === id)?.x;
      // Four: every reviewer keeps its slot, and each still points at the builder (INF-304).
      const four = stage(ids, true);
      const fourSlots = stage(ids, false);
      expect(arrows(four)).toEqual(ids.map((id) => `${id}>builder`));
      for (const id of ids) expect(xOf(four, id)).toBe(xOf(fourSlots, id));
      // Three: all circle the builder, with the same arrows.
      const three = stage(ids.slice(0, 3), true);
      const threeSlots = stage(ids.slice(0, 3), false);
      expect(arrows(three)).toEqual(ids.slice(0, 3).map((id) => `${id}>builder`));
      for (const id of ids.slice(0, 3)) expect(xOf(three, id)).not.toBe(xOf(threeSlots, id));
    });
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
