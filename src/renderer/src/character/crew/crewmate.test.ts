import { BATCH_GATE } from "@shared/batchGate";
import { describe, expect, it } from "vitest";
import {
  type CrewColors,
  crewmateLight,
  drawCrewmate,
  drawDependencyLink,
  solidFor,
  TIER_SOLIDS,
} from "./crewmate";
import type { CrewmateFrame } from "./orbit";

const colors: CrewColors = { accent: [127, 220, 255], hot: [255, 162, 87], boost: 1 };

describe("crewmateLight", () => {
  it("keeps an idle crewmate a dim ice cyan and heats a working one to ember, like the rig", () => {
    const idle = crewmateLight(colors, 0);
    const working = crewmateLight(colors, 1);
    expect(idle.color).toEqual(colors.accent);
    expect(working.color).toEqual(colors.hot);
    // Idle recedes by strength, never by a second hue.
    expect(idle.strength).toBeLessThan(working.strength);
    expect(working.strength).toBe(1);
  });
});

// INF-676, the captain's direction A, and INF-1777, the captain's approved
// plan: a background wait banks the crewmate to idle strength inside a dashed
// cyan ring - "when waiting for checks, the crewmate should become blue ...
// when crewmate is waiting for a background command, it should be orange" -
// and the ring is never the beacon's full one ("perhaps it's the 'ring' that
// needs to look different from a full ring").
describe("a crewmate on a background wait", () => {
  it("banks to idle strength, ember for a background command and ice cyan for checks", () => {
    const local = crewmateLight(colors, 0, 1, 0, 1);
    const checks = crewmateLight(colors, 0, 1, 0, 0);
    expect(local.color).toEqual(colors.hot);
    expect(checks.color).toEqual(colors.accent);
    expect(local.strength).toBeCloseTo(0.6, 5);
    expect(checks.strength).toBeCloseTo(0.6, 5);
    expect(local.strength).toBeLessThan(crewmateLight(colors, 1).strength);
  });

  it("draws a dashed cyan ring with a travelling arc round the solid, and no tick or halo", () => {
    for (const [job, wires] of [
      [1, colors.hot],
      [undefined, colors.accent],
    ] as const) {
      const rec = recordingContext();
      drawCrewmate(rec.ctx, { ...settled, wait: 1, job, waitArc: 2 }, 0, 0, colors, 5_000);
      const ring = rec.log.filter((line) => line.startsWith("A120,0,24"));
      expect(ring).toHaveLength(2);
      // The faint ring is broken into twelve even dashes; the arc is whole.
      const dash = (2 * Math.PI * 24) / 12;
      expect(rec.dashes[0]?.[0]).toBeCloseTo(dash * 0.55, 5);
      expect(rec.dashes[0]?.[1]).toBeCloseTo(dash * 0.45, 5);
      const [faint, arc] = rec.strokes;
      expect(faint?.dash).toHaveLength(2);
      expect(arc?.dash).toHaveLength(0);
      expect(channels(faint?.style ?? "")).toEqual(colors.accent);
      expect(channels(arc?.style ?? "")).not.toEqual(colors.accent);
      // The solid itself carries the wait's color, with no white-hot filament tick.
      const solid = rec.strokes.slice(2);
      expect(solid.every((s) => channels(s.style).join() === wires.join())).toBe(true);
      expect(rec.strokes.some((s) => whiteHot(s.style))).toBe(false);
    }
  });

  it("holds the dashed ring whole and still on a settled frame, and draws none when not waiting", () => {
    const still = recordingContext();
    drawCrewmate(still.ctx, { ...settled, wait: 1 }, 0, 0, colors, 5_000);
    expect(still.log.filter((line) => line.startsWith("A120,0,24"))).toHaveLength(1);
    expect(still.strokes[0]?.dash).toHaveLength(2);
    const plain = recordingContext();
    drawCrewmate(plain.ctx, settled, 0, 0, colors, 5_000);
    expect(plain.log.filter((line) => line.startsWith("A120,0,24"))).toHaveLength(0);
  });
});

// INF-1543, the captain's direction A, the beacon: the Tasks row's Waiting on
// you ring round the solid, in the accent, breathing at the captain's settings.
describe("a crewmate waiting on the captain", () => {
  const ringAt = (log: string[], r: number) =>
    log.filter((line) => line.startsWith("A120,0,") && Number(line.split(",")[2]) === r);
  const alphaOf = (style: string) => Number(style.split(",")[3]?.replace(")", ""));

  it("draws an accent ring at 0.9 of the glyph breathing between 0.25 and 0.85", () => {
    const faint = recordingContext();
    drawCrewmate(faint.ctx, { ...settled, captain: 1, captainBreath: 0 }, 0, 0, colors, 5_000);
    const bright = recordingContext();
    drawCrewmate(bright.ctx, { ...settled, captain: 1, captainBreath: 1 }, 0, 0, colors, 5_000);
    // 30 px glyph: 27 px ring, swelling 6% across the breath.
    expect(ringAt(faint.log, 27 * 0.97)).toHaveLength(1);
    expect(ringAt(bright.log, 27 * 1.03)).toHaveLength(1);
    const [lo, hi] = [faint.strokes[0], bright.strokes[0]];
    expect(channels(lo?.style ?? "")).toEqual(colors.accent);
    expect(channels(hi?.style ?? "")).toEqual(colors.accent);
    expect(alphaOf(lo?.style ?? "")).toBeCloseTo(0.25, 5);
    expect(alphaOf(hi?.style ?? "")).toBeCloseTo(0.85, 5);
  });

  it("holds the ring whole at mid light on a settled frame, and draws none when not waiting", () => {
    const still = recordingContext();
    drawCrewmate(still.ctx, { ...settled, captain: 1 }, 0, 0, colors, 5_000);
    expect(ringAt(still.log, 27)).toHaveLength(1);
    expect(alphaOf(still.strokes[0]?.style ?? "")).toBeCloseTo(0.55, 5);
    const plain = recordingContext();
    drawCrewmate(plain.ctx, settled, 0, 0, colors, 5_000);
    expect(ringAt(plain.log, 27)).toHaveLength(0);
  });

  it("keeps the solid's own hue and holds its wires at idle strength", () => {
    expect(crewmateLight(colors, 0, 0, 1)).toEqual(crewmateLight(colors, 0));
    expect(crewmateLight(colors, 1, 0, 1).color).toEqual(colors.hot);
    expect(crewmateLight(colors, 1, 0, 1).strength).toBeCloseTo(0.55, 5);
  });
});

/** A 2D context that records what each stroke and fill would paint, and nothing else. */
function recordingContext() {
  const arcs: { x: number; y: number; r: number; start: number; end: number }[] = [];
  const strokes: { style: string; alpha: number; dash: number[] }[] = [];
  const dashes: number[][] = [];
  let dash: number[] = [];
  const fills: { style: string; alpha: number }[] = [];
  /** Every call in order, with its arguments: two identical logs paint identical pixels. */
  const log: string[] = [];
  const ctx = {
    strokeStyle: "" as unknown,
    fillStyle: "" as unknown,
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: "butt",
    createRadialGradient: () => ({ addColorStop: () => {} }),
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: (x: number, y: number) => log.push(`M${x},${y}`),
    lineTo: (x: number, y: number) => log.push(`L${x},${y}`),
    arc: (x: number, y: number, r: number, start: number, end: number) => {
      log.push(`A${x},${y},${r}`);
      arcs.push({ x, y, r, start, end });
    },
    fill: () => {
      fills.push({ style: String(ctx.fillStyle), alpha: ctx.globalAlpha });
      log.push(`F${String(ctx.fillStyle)}@${ctx.globalAlpha}`);
    },
    setLineDash: (segments: number[]) => {
      dash = [...segments];
      if (dash.length) dashes.push(dash);
      log.push(`D${dash.join(",")}`);
    },
    stroke: () => {
      strokes.push({ style: String(ctx.strokeStyle), alpha: ctx.globalAlpha, dash });
      log.push(`S${String(ctx.strokeStyle)}@${ctx.globalAlpha}/${ctx.lineWidth}`);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, fills, log, dashes, arcs };
}

const settled: CrewmateFrame = {
  id: "a",
  status: "idle",
  phase: "orbiting",
  leaveMode: null,
  x: 120,
  y: 0,
  depth: 1,
  size: 30,
  alpha: 1,
  unfold: 1,
  spark: 0,
  trail: [],
  work: 0,
  spin: 0.7,
  nudge: 0,
  flash: 0,
  flicker: 0,
  seed: 0.3,
};

const channels = (style: string) => (style.match(/\d+/g) ?? []).slice(0, 3).map(Number);
/** The filament's white-hot (255, 244, 224), give or take rounding. */
const whiteHot = (style: string) => {
  const [r = 0, g = 0, b = 0] = channels(style);
  return r >= 250 && g >= 238 && b >= 218;
};

describe("drawCrewmate's speed streak", () => {
  // The arc a racing crewmate just swept: from its own position, backwards.
  const streak = Array.from({ length: 13 }, (_, i) => ({ x: 120 + i * 4, y: -i * 2 }));
  const alphaOf = (style: string) => Number(style.split(",")[3]?.replace(")", ""));

  it("draws the streak under the solid and leaves the solid exactly as it was", () => {
    const plain = recordingContext();
    drawCrewmate(plain.ctx, settled, 0, 0, colors, 5_000);
    const racing = recordingContext();
    drawCrewmate(racing.ctx, { ...settled, streak }, 0, 0, colors, 5_000);
    // Twelve segments, painted first, then the very same solid.
    const segments = racing.log.slice(0, 12 * 3);
    expect(segments.filter((line) => line.startsWith("S"))).toHaveLength(12);
    expect(segments[0]).toBe("M120,0");
    expect(racing.log.slice(12 * 3)).toEqual(plain.log);
  });

  it("is the crewmate's own light lifted toward white, fading and thinning away from it", () => {
    const working = { ...settled, work: 1, streak };
    const rec = recordingContext();
    drawCrewmate(rec.ctx, working, 0, 0, colors, 5_000);
    const lines = rec.log.slice(0, 12 * 3).filter((line) => line.startsWith("S"));
    const styles = rec.strokes.slice(0, 12).map((s) => s.style);
    // Ember (the working light) a quarter of the way to white-hot.
    expect(channels(styles[0] ?? "")).toEqual([255, 183, 121]);
    const alphas = styles.map(alphaOf);
    const widths = lines.map((line) => Number(line.split("/")[1]));
    for (let i = 1; i < 12; i++) {
      expect(alphas[i]).toBeLessThan(alphas[i - 1] ?? 0);
      expect(widths[i]).toBeLessThanOrEqual(widths[i - 1] ?? 0);
    }
    expect(alphas[0]).toBeCloseTo(0.42, 6);
  });

  it("draws nothing while the crewmate is folded to a point", () => {
    const rec = recordingContext();
    drawCrewmate(rec.ctx, { ...settled, streak, unfold: 0 }, 0, 0, colors, 5_000);
    expect(rec.strokes).toEqual([]);
  });
});

// Captain (INF-304): "the arrows that mark a blocked or review relationshop should be
// present at all times to make it more clear there's a relationship".
describe("the arrow from a waiting crewmate or a reviewer", () => {
  /** The arrow's line and head as drawn from (0, 0) to (`apart`, 0). */
  const arrow = (apart: number) => {
    const rec = recordingContext();
    drawDependencyLink(rec.ctx, { x: 0, y: 0 }, { x: apart, y: 0 }, 0, 0, colors, false);
    const points = rec.log.map((line) => line.match(/^[ML](-?[\d.]+),(-?[\d.]+)$/));
    const xs = points.flatMap((m) => (m ? [Number(m[1])] : []));
    return { strokes: rec.strokes.length, start: xs[0] ?? Number.NaN, tip: xs[1] ?? Number.NaN };
  };

  it("stays off both glyphs when they are far apart", () => {
    const { strokes, start, tip } = arrow(120);
    expect(strokes).toBe(2);
    expect(start).toBeGreaterThan(settled.size / 2);
    expect(tip).toBeLessThan(120 - settled.size / 2);
  });

  // Captain (INF-556): "the gray color is okay", and "for a reviewer relationship, it
  // should use the orange color that we use as active".
  it("draws a wait in the quiet gray and a review in the working ember, at rest and lit", () => {
    const quiet: CrewColors = { ...colors, quiet: [148, 156, 168] };
    const paint = (lit: boolean, kind: "wait" | "review") => {
      const rec = recordingContext();
      drawDependencyLink(rec.ctx, { x: 0, y: 0 }, { x: 120, y: 0 }, 0, 0, quiet, lit, kind);
      const line = rec.log.find((entry) => entry.startsWith("S")) ?? "";
      const style = line.slice(1).split("@")[0] ?? "";
      const alpha = Number(style.split(",")[3]?.replace(")", ""));
      return { color: channels(style), alpha, width: line.split("/")[1] };
    };
    expect(paint(false, "wait")).toEqual({ color: [148, 156, 168], alpha: 0.28, width: "1" });
    expect(paint(true, "wait")).toEqual({ color: colors.accent, alpha: 0.7, width: "1.4" });
    expect(paint(false, "review")).toEqual({ color: colors.hot, alpha: 0.28, width: "1" });
    expect(paint(true, "review")).toEqual({ color: colors.hot, alpha: 0.7, width: "1.4" });
  });

  it("is drawn however close the two crewmates come on screen, pointing at the one waited on", () => {
    for (const apart of [44, 30, 18, 8, 3]) {
      const { strokes, start, tip } = arrow(apart);
      expect(strokes, `${apart} px apart`).toBe(2);
      expect(start, `${apart} px apart`).toBeGreaterThanOrEqual(0);
      expect(tip, `${apart} px apart`).toBeGreaterThan(start);
      expect(tip, `${apart} px apart`).toBeLessThanOrEqual(apart);
    }
  });
});

describe("a crewmate's solid follows the slot it is served on", () => {
  const TIERS = ["low", "medium", "high", "premium"] as const;
  /** Idle and between filament ticks, so every stroke is a wire and every fill a node. */
  const paint = (frame: CrewmateFrame) => {
    const rec = recordingContext();
    drawCrewmate(rec.ctx, frame, 0, 0, colors, 5_000);
    return rec;
  };

  it("draws a richer solid for a stronger slot: tetrahedron, octahedron, icosahedron, geodesic", () => {
    const counts = Object.fromEntries(
      TIERS.map((tier) => {
        const { strokes, fills } = paint({ ...settled, tier });
        return [tier, [strokes.length, fills.length]];
      }),
    );
    // Wires, then nodes: the geodesic sphere keeps a node only on the
    // icosahedron's own twelve corners.
    expect(counts).toEqual({
      low: [6, 4],
      medium: [12, 6],
      high: [30, 12],
      premium: [120, 12],
    });
  });

  it("paints a crewmate whose slot is unknown exactly as a low one: today's tetrahedron", () => {
    const unknown = paint(settled);
    expect(unknown.log).toEqual(paint({ ...settled, tier: "low" }).log);
    expect(unknown.strokes).toHaveLength(6);
    expect(solidFor(undefined)).toBe(TIER_SOLIDS.low);
  });

  it("keeps the status color on every solid: ice cyan idle, ember working", () => {
    for (const tier of TIERS) {
      const idle = paint({ ...settled, tier });
      expect(new Set(idle.strokes.map((s) => s.style))).toEqual(new Set(["rgba(127,220,255,1)"]));
      const working = paint({ ...settled, tier, work: 1, status: "working" });
      expect(new Set(working.strokes.map((s) => s.style))).toEqual(new Set(["rgba(255,162,87,1)"]));
    }
  });

  it("flickers every solid on its own wires, never whitening one at rest", () => {
    const sum = (xs: { alpha: number }[]) => xs.reduce((a, s) => a + s.alpha, 0);
    for (const tier of TIERS) {
      const rest = paint({ ...settled, tier });
      expect(rest.strokes.some((s) => whiteHot(s.style))).toBe(false);
      const lit = paint({ ...settled, tier, flicker: 2 });
      expect(lit.strokes.some((s) => whiteHot(s.style))).toBe(true);
      expect(new Set(lit.strokes.map((s) => s.style)).size).toBeGreaterThan(2);
      expect(sum(lit.strokes)).toBeGreaterThan(sum(rest.strokes) * 1.5);
    }
  });
});

// Approved batch gate: two banked accent arcs replace the checks dashes, without a tick or halo.
it("draws the approved paired gate arcs at the frame's turn, never the checks ring", () => {
  for (const turn of [0, 1]) {
    const rec = recordingContext();
    drawCrewmate(
      rec.ctx,
      { ...settled, wait: 1, batch: true, batchTurn: turn },
      0,
      0,
      colors,
      5000,
    );
    const arcs = rec.arcs.filter((arc) => arc.r === settled.size * BATCH_GATE.ring);
    expect(arcs).toHaveLength(2);
    const half = (BATCH_GATE.arcDeg * Math.PI) / 360;
    for (const [i, arc] of arcs.entries()) {
      expect(arc.start).toBeCloseTo(i * Math.PI - half + turn, 5);
      expect(arc.end).toBeCloseTo(i * Math.PI + half + turn, 5);
    }
    expect(rec.dashes).toEqual([]);
    expect(
      rec.strokes
        .slice(0, 2)
        .every((stroke) => channels(stroke.style).join() === colors.accent.join()),
    ).toBe(true);
    expect(rec.strokes.some((stroke) => whiteHot(stroke.style))).toBe(false);
  }
});
