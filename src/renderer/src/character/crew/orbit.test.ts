import { describe, expect, it } from "vitest";
import {
  CrewOrbit,
  DEFAULT_ORBIT,
  glyphScaleFor,
  type OrbitFrame,
  ringRadiusFor,
  SENDOFF_LEAD_MS,
} from "./orbit";

const seeded = () => {
  let s = 7;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
};

function orbit(now = 0): CrewOrbit {
  return new CrewOrbit(now, { ...DEFAULT_ORBIT }, seeded());
}

/** Step the model in 16ms frames up to `until`, returning the last frame. */
function run(model: CrewOrbit, from: number, until: number, settled = false): OrbitFrame {
  let frame = model.update(from, settled);
  for (let t = from + 16; t <= until; t += 16) frame = model.update(t, settled);
  return frame;
}

const dist = (f: { x: number; y: number }) => Math.hypot(f.x, f.y);

describe("CrewOrbit", () => {
  it("spawns from the core and arrives on the ring as a whole tetrahedron", () => {
    const m = orbit();
    m.spawn("a", "working", 0);
    const early = m.update(40);
    const a0 = early.crew[0];
    expect(a0?.phase).toBe("spawning");
    expect(a0?.unfold).toBe(0);
    expect(a0?.spark).toBe(1);
    // Starts inside the character (well under the ring radius).
    expect(dist(a0 ?? { x: 0, y: 0 })).toBeLessThan(DEFAULT_ORBIT.radius * 0.35);
    const done = run(m, 56, DEFAULT_ORBIT.spawnMs + 32);
    const a1 = done.crew[0];
    expect(a1?.phase).toBe("orbiting");
    expect(a1?.unfold).toBe(1);
    expect(a1?.spark).toBe(0);
    // On the ring: the ellipse radius at its angle.
    const ang = Math.atan2((a1?.y ?? 0) / DEFAULT_ORBIT.tilt, a1?.x ?? 0);
    const expected = DEFAULT_ORBIT.radius;
    const r = Math.hypot(a1?.x ?? 0, (a1?.y ?? 0) / DEFAULT_ORBIT.tilt);
    expect(Math.abs(r - expected)).toBeLessThan(2);
    expect(Number.isFinite(ang)).toBe(true);
  });

  it("raises the Firstmate's send-off cue ahead of emission, pointing at the slot", () => {
    const m = orbit();
    m.spawn("a", "working", 1000);
    // Emission is immediate for the first spawn, so the lead has already
    // passed: the cue rides the very first frame, pointing at the slot.
    m.update(1000);
    const cues = m.takeCues();
    expect(cues.length).toBe(1);
    expect(cues[0]?.kind).toBe("sendoff");
    expect(Math.hypot(cues[0]?.kind === "sendoff" ? cues[0].dx : 0, 0)).toBeLessThanOrEqual(1);
    expect(m.takeCues()).toEqual([]);
    // A staggered second spawn cues exactly SENDOFF_LEAD_MS before its turn.
    m.spawn("b", "idle", 1000);
    const second = 1000 + DEFAULT_ORBIT.staggerMs;
    m.update(second - SENDOFF_LEAD_MS - 1);
    expect(m.takeCues()).toEqual([]);
    m.update(second - SENDOFF_LEAD_MS);
    expect(m.takeCues().map((c) => c.kind)).toEqual(["sendoff"]);
  });

  it("staggers simultaneous spawns so they read one at a time", () => {
    const m = orbit();
    m.spawn("a", "working", 0);
    m.spawn("b", "working", 0);
    m.spawn("c", "working", 0);
    const f0 = m.update(20);
    expect(f0.crew.map((c) => c.id)).toEqual(["a"]);
    const f1 = m.update(DEFAULT_ORBIT.staggerMs + 20);
    expect(f1.crew.map((c) => c.id)).toEqual(["a", "b"]);
    // Every slot is open from the start: three-way spacing even before c shows.
    expect(f1.count).toBe(3);
  });

  it("spaces the ring evenly and re-spaces with a glide when one leaves", () => {
    const m = orbit();
    for (const id of ["a", "b", "c", "d"]) m.spawn(id, "working", 0);
    const settled = run(m, 0, 4000);
    const angles = settled.crew
      .map((c) => Math.atan2(c.y / DEFAULT_ORBIT.tilt, c.x))
      .sort((p, q) => p - q);
    const gaps = angles.map((a, i) => {
      const next = angles[(i + 1) % angles.length] ?? 0;
      return (next - a + Math.PI * 4) % (Math.PI * 2) || Math.PI * 2;
    });
    for (const g of gaps) expect(Math.abs(g - Math.PI / 2)).toBeLessThan(0.05);

    m.leave("b", "away", 4000);
    const mid = m.update(4200);
    // Still four bodies drawn (b is fading) but three on the roster.
    expect(mid.count).toBe(3);
    expect(mid.crew.find((c) => c.id === "b")?.phase).toBe("leaving");
    const after = run(m, 4216, 8000);
    expect(after.crew.map((c) => c.id)).toEqual(["a", "c", "d"]);
    const angles2 = after.crew
      .map((c) => Math.atan2(c.y / DEFAULT_ORBIT.tilt, c.x))
      .sort((p, q) => p - q);
    const gaps2 = angles2.map((a, i) => {
      const next = angles2[(i + 1) % angles2.length] ?? 0;
      return (next - a + Math.PI * 4) % (Math.PI * 2) || Math.PI * 2;
    });
    for (const g of gaps2) expect(Math.abs(g - (Math.PI * 2) / 3)).toBeLessThan(0.05);
  });

  it("never jumps: a frame moves a crewmate by a bounded step", () => {
    const m = orbit();
    for (const id of ["a", "b", "c"]) m.spawn(id, "working", 0);
    run(m, 0, 3000);
    m.spawn("d", "idle", 3000);
    m.spawn("e", "working", 3000);
    let prev = m.update(3016);
    for (let t = 3032; t <= 7000; t += 16) {
      const next = m.update(t);
      for (const c of next.crew) {
        const was = prev.crew.find((p) => p.id === c.id);
        if (!was || was.phase === "spawning") continue;
        expect(Math.hypot(c.x - was.x, c.y - was.y)).toBeLessThan(6);
      }
      prev = next;
    }
  });

  it("sends a finished crewmate home into the core and cues a receive", () => {
    const m = orbit();
    m.spawn("a", "working", 0);
    run(m, 0, 2000);
    m.leave("a", "home", 2000);
    const mid = m.update(2000 + DEFAULT_ORBIT.homeMs * 0.5);
    const a = mid.crew[0];
    expect(a?.phase).toBe("leaving");
    expect(a?.unfold).toBeLessThan(1);
    expect(dist(a ?? { x: 0, y: 0 })).toBeLessThan(DEFAULT_ORBIT.radius);
    m.takeCues();
    const end = run(m, 2000 + DEFAULT_ORBIT.homeMs * 0.5 + 16, 2000 + DEFAULT_ORBIT.homeMs + 40);
    expect(end.crew).toEqual([]);
    expect(m.takeCues()).toEqual([{ kind: "receive" }]);
    expect(m.has("a")).toBe(false);
  });

  it("fades a dropped crewmate away without a receive", () => {
    const m = orbit();
    m.spawn("a", "idle", 0);
    run(m, 0, 2000);
    m.takeCues();
    m.leave("a", "away", 2000);
    const mid = m.update(2000 + DEFAULT_ORBIT.awayMs * 0.5);
    expect(mid.crew[0]?.alpha ?? 1).toBeLessThan(0.9);
    const end = run(m, 2016, 2000 + DEFAULT_ORBIT.awayMs + 40);
    expect(end.crew).toEqual([]);
    expect(m.takeCues()).toEqual([]);
  });

  it("can be interrupted mid-spawn: leaving turns the spark around", () => {
    const m = orbit();
    m.spawn("a", "working", 0);
    m.update(200);
    m.leave("a", "home", 200);
    const f = m.update(216);
    expect(f.crew[0]?.phase).toBe("leaving");
    const end = run(m, 232, 200 + DEFAULT_ORBIT.homeMs + 40);
    expect(end.crew).toEqual([]);
  });

  it("blends working and idle without a jump, and idle sits farther out", () => {
    const m = orbit();
    m.spawn("a", "working", 0);
    const working = run(m, 0, 3000);
    m.setStatus("a", "idle");
    const soon = m.update(3016);
    expect(soon.crew[0]?.work ?? 0).toBeGreaterThan(0.9);
    const idle = run(m, 3032, 7000);
    expect(idle.crew[0]?.work ?? 1).toBeLessThan(0.02);
    const rw = Math.hypot(working.crew[0]?.x ?? 0, (working.crew[0]?.y ?? 0) / DEFAULT_ORBIT.tilt);
    const ri = Math.hypot(idle.crew[0]?.x ?? 0, (idle.crew[0]?.y ?? 0) / DEFAULT_ORBIT.tilt);
    expect(ri).toBeGreaterThan(rw * 1.03);
  });

  it("carries a report packet inward and a steer outward", () => {
    const m = orbit();
    m.spawn("a", "working", 0);
    run(m, 0, 2000);
    m.takeCues();
    m.signal("a", "report", 2000);
    const early = m.update(2000 + DEFAULT_ORBIT.packetMs * 0.15);
    const late = m.update(2000 + DEFAULT_ORBIT.packetMs * 0.85);
    expect(early.packets.length).toBe(1);
    expect(dist(early.packets[0] ?? { x: 0, y: 0 })).toBeGreaterThan(
      dist(late.packets[0] ?? { x: 0, y: 0 }),
    );
    run(m, 2000 + DEFAULT_ORBIT.packetMs * 0.85 + 16, 2000 + DEFAULT_ORBIT.packetMs + 40);
    expect(m.takeCues()).toEqual([{ kind: "receive" }]);

    m.signal("a", "steer", 3000);
    expect(m.takeCues().map((c) => c.kind)).toEqual(["sendoff"]);
    const out0 = m.update(3000 + DEFAULT_ORBIT.packetMs * 0.15);
    const out1 = m.update(3000 + DEFAULT_ORBIT.packetMs * 0.85);
    expect(dist(out0.packets[0] ?? { x: 0, y: 0 })).toBeLessThan(
      dist(out1.packets[0] ?? { x: 0, y: 0 }),
    );
    const landed = run(
      m,
      3000 + DEFAULT_ORBIT.packetMs * 0.85 + 16,
      3000 + DEFAULT_ORBIT.packetMs + 40,
    );
    expect(landed.crew[0]?.flash ?? 0).toBeGreaterThan(0);
  });

  it("widens and shrinks gracefully as the ring crowds", () => {
    expect(ringRadiusFor(1, DEFAULT_ORBIT)).toBe(DEFAULT_ORBIT.radius);
    expect(ringRadiusFor(5, DEFAULT_ORBIT)).toBe(DEFAULT_ORBIT.radius);
    expect(ringRadiusFor(12, DEFAULT_ORBIT)).toBeGreaterThan(DEFAULT_ORBIT.radius);
    expect(ringRadiusFor(40, DEFAULT_ORBIT)).toBe(DEFAULT_ORBIT.radius * 1.25);
    expect(glyphScaleFor(5)).toBe(1);
    expect(glyphScaleFor(12)).toBeCloseTo(0.65, 5);
    expect(glyphScaleFor(40)).toBe(0.6);
    // Twelve on the ring: no two glyphs overlap once settled.
    const m = orbit();
    for (let i = 0; i < 12; i++) m.spawn(`c${i}`, i % 2 ? "idle" : "working", 0);
    const f = run(m, 0, 9000);
    expect(f.crew.length).toBe(12);
    for (const a of f.crew) {
      for (const b of f.crew) {
        if (a.id >= b.id) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan((a.size + b.size) / 2);
      }
    }
  });

  it("settles instantly under reduced motion: no spark, no fall, no packet", () => {
    const m = orbit();
    m.spawn("a", "working", 0);
    m.spawn("b", "idle", 0);
    const f = m.update(1, true);
    expect(f.crew.map((c) => c.phase)).toEqual(["orbiting", "orbiting"]);
    expect(f.crew.every((c) => c.unfold === 1 && c.spark === 0)).toBe(true);
    m.signal("a", "report", 1);
    m.leave("b", "home", 1);
    const g = m.update(2, true);
    expect(g.packets).toEqual([]);
    expect(g.crew.map((c) => c.id)).toEqual(["a"]);
  });

  it("bumps its version on every command so a static frame repaints", () => {
    const m = orbit();
    const v0 = m.version;
    m.spawn("a", "idle", 0);
    expect(m.version).toBe(v0 + 1);
    m.setStatus("a", "working");
    expect(m.version).toBe(v0 + 2);
    m.setStatus("a", "working");
    expect(m.version).toBe(v0 + 2);
    m.leave("a", "away", 0);
    expect(m.version).toBe(v0 + 3);
  });

  it("carries each crewmate's slot to the painter, and repaints a still frame when it moves", () => {
    const m = orbit();
    m.spawn("known", "working", 0, true, "premium");
    m.spawn("unknown", "idle", 0, true);
    const tiers = (frame: OrbitFrame) => Object.fromEntries(frame.crew.map((c) => [c.id, c.tier]));
    expect(tiers(m.update(16, true))).toEqual({ known: "premium", unknown: undefined });
    const v0 = m.version;
    m.setTier("unknown", "medium");
    expect(m.version).toBe(v0 + 1);
    m.setTier("unknown", "medium");
    expect(m.version).toBe(v0 + 1);
    m.setTier("known", undefined);
    expect(m.version).toBe(v0 + 2);
    expect(tiers(m.update(32, true))).toEqual({ known: undefined, unknown: "medium" });
    expect(m.update(48, true).crew.find((c) => c.id === "known")).not.toHaveProperty("tier");
  });

  it("places a crewmate that was already out settled: no spark, no send-off, no stagger", () => {
    const m = orbit();
    m.spawn("a", "working", 0, true);
    m.spawn("b", "idle", 0, true);
    const f = m.update(16);
    expect(f.crew.map((c) => [c.id, c.phase, c.unfold, c.spark])).toEqual([
      ["a", "orbiting", 1, 0],
      ["b", "orbiting", 1, 0],
    ]);
    expect(m.takeCues()).toEqual([]);
    // Idle already sits in its posture, farther out, from the first frame.
    const [a, b] = f.crew;
    const ra = Math.hypot(a?.x ?? 0, (a?.y ?? 0) / DEFAULT_ORBIT.tilt);
    expect(Math.abs(ra - DEFAULT_ORBIT.radius)).toBeLessThan(2);
    expect(b?.work).toBe(0);
    // A live spawn after the boot roster is not staggered behind it.
    m.spawn("c", "working", 16);
    expect(m.update(32).crew.map((c) => c.id)).toContain("c");
  });
});
