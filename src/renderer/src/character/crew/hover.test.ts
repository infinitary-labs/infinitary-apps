import type { DeviceView } from "@shared/devices";
import { describe, expect, it } from "vitest";
import { CLUSTER_LAYOUT, ComputerOrbits } from "./computers";
import {
  CREW_HOVER,
  crewHit,
  crewHitRadius,
  inCrewZone,
  placeCrewSummary,
  placeKeySummary,
  placeRowSummary,
  type SummaryRoom,
} from "./hover";
import { CrewOrbit, DEFAULT_ORBIT, type OrbitFrame } from "./orbit";
import { planeRadius, projectPlane } from "./orbitalPlanes";

const mate = (id: string, x: number, y: number, extra = {}) => ({
  id,
  x,
  y,
  size: 25,
  depth: 0.5,
  phase: "orbiting" as const,
  unfold: 1,
  ...extra,
});

const MARGIN = CREW_HOVER.zoneMarginPx;

/** The home stage with `count` crew settled on their slots, every other one idle. */
function homeStage(count: number): CrewOrbit {
  const model = new CrewOrbit(0, { ...DEFAULT_ORBIT }, () => 0.37, "adaptive");
  for (let i = 0; i < count; i++) model.spawn(`c${i}`, i % 2 ? "idle" : "working", 0, true);
  model.settleBootRoster(0);
  return model;
}

/** Each point at which a crewmate takes the pointer, eight ways round it, screen px. */
function reachOf(frame: OrbitFrame, scale = 1): { x: number; y: number }[] {
  return frame.crew.flatMap((c) => {
    const r = crewHitRadius(c.size, scale);
    return Array.from({ length: 8 }, (_, k) => ({
      x: c.x * scale + r * Math.cos((k * Math.PI) / 4),
      y: c.y * scale + r * Math.sin((k * Math.PI) / 4),
    }));
  });
}

/** Those of `points` the stage would not slow at. */
function outside(frame: OrbitFrame, points: { x: number; y: number }[], scale = 1) {
  return points.filter((p) => !inCrewZone(frame, p.x, p.y, scale));
}

/** How far a plane's orbit at `radius` is painted above its centre, px. */
function topOf(plane: number, radius: number): number {
  let top = 0;
  for (let deg = 0; deg < 360; deg += 0.1)
    top = Math.max(top, -projectPlane(plane, (deg * Math.PI) / 180, radius).y);
  return top;
}

/** The unit direction of a plane's major axis, where its orbit reaches out farthest. */
function tipOf(plane: number): { x: number; y: number } {
  const tip = projectPlane(plane, 0);
  const length = Math.hypot(tip.x, tip.y);
  return { x: tip.x / length, y: tip.y / length };
}

const device = (id: string, patch: Partial<DeviceView> = {}): DeviceView => ({
  id,
  kind: "work",
  name: `Computer ${id}`,
  pairedAt: 1,
  inReach: true,
  ...patch,
});

/** A crewmate placed on `computer` (home when null), settled on its slot. */
function place(model: ComputerOrbits, id: string, computer: string | null, now = 0) {
  model.setPlacement(id, computer);
  model.spawn(id, "working", now, true);
}

// The captain's asks: the stage slows when the pointer comes close to the
// crew (FI3-398), and only then (INF-56): "right now it seems my mouse is
// nowhere near the animation but it would already trigger the slow motion".
describe("the slow zone", () => {
  it("is over the crew's orbit, not the air above and below it", () => {
    const frame = homeStage(3).update(0, true);
    const radius = planeRadius(0, [3]);
    const top = topOf(0, radius);
    // On the orbit and inside it, the character included.
    expect(inCrewZone(frame, 0, 0)).toBe(true);
    expect(inCrewZone(frame, 0, -top)).toBe(true);
    expect(inCrewZone(frame, 0, top)).toBe(true);
    // Past the margin above and below its painted edge, the stage runs on...
    expect(inCrewZone(frame, 0, -(top + MARGIN + 1))).toBe(false);
    expect(inCrewZone(frame, 0, top + MARGIN + 1)).toBe(false);
    // ...though the orbit itself reaches that far out along its own axis.
    const far = radius + MARGIN - 0.5;
    const tip = tipOf(0);
    expect(inCrewZone(frame, tip.x * far, tip.y * far)).toBe(true);
    expect(inCrewZone(frame, 0, -far)).toBe(false);
  });
  it.each([1, 8, 24, 25, 36, 48, 60])(
    "slows wherever a crewmate would take the pointer, with %i out",
    (count) => {
      const frame = homeStage(count).update(0, true);
      expect(outside(frame, reachOf(frame))).toEqual([]);
    },
  );
  it("covers every occupied orbit by its own shape, and grows as one opens", () => {
    const three = homeStage(3).update(0, true);
    const thirty = homeStage(30).update(0, true);
    const far = planeRadius(1, [24, 6]) + MARGIN - 0.5;
    const tip = tipOf(1);
    expect(inCrewZone(three, tip.x * far, tip.y * far)).toBe(false);
    expect(inCrewZone(thirty, tip.x * far, tip.y * far)).toBe(true);
    // The second orbit sits inside the first: above the centre the zone ends at the taller one.
    const top = Math.max(topOf(0, planeRadius(0, [24, 6])), topOf(1, planeRadius(1, [24, 6])));
    expect(inCrewZone(thirty, 0, -(top + MARGIN + 1))).toBe(false);
  });
  it("measures the margin in screen pixels when the formation is fitted", () => {
    const frame = homeStage(3).update(0, true);
    const scale = 0.75;
    const tip = tipOf(0);
    const edge = planeRadius(0, [3]) * scale + MARGIN;
    expect(inCrewZone(frame, tip.x * (edge - 0.5), tip.y * (edge - 0.5), scale)).toBe(true);
    expect(inCrewZone(frame, tip.x * (edge + 0.5), tip.y * (edge + 0.5), scale)).toBe(false);
    expect(outside(frame, reachOf(frame, scale), scale)).toEqual([]);
  });
  it("does not exist with nobody out, and ignores a departing crewmate and its orbit", () => {
    expect(homeStage(0).update(0, true).orbits).toEqual([]);
    const model = homeStage(25);
    const inner = model.update(0, true).crew.find((c) => c.plane === 1);
    if (!inner) throw new Error("The 25th crewmate is not on the second orbit");
    model.leave(inner.id, "home", 16);
    const frame = model.update(32);
    const leaving = frame.crew.find((c) => c.id === inner.id);
    expect(leaving?.phase).toBe("leaving");
    // Its orbit is gone: the zone is the first orbit's alone, as with 24 out.
    expect(frame.orbits).toEqual(homeStage(24).update(0, true).orbits);
    // Nor does the departing crewmate itself hold the zone.
    expect(inCrewZone({ orbits: [], crew: frame.crew }, leaving?.x ?? 0, leaving?.y ?? 0)).toBe(
      false,
    );
    const alone = homeStage(1);
    alone.leave("c0", "away", 16);
    expect(alone.update(32).orbits).toEqual([]);
  });
  it("follows the ring as it glides into the orbits around the first crewmate", () => {
    const model = new CrewOrbit(0, { ...DEFAULT_ORBIT }, () => 0.37, "adaptive");
    model.spawn("a", "working", 0);
    model.spawn("b", "idle", 0);
    let landing: OrbitFrame | null = null;
    for (let now = 0; now <= 3000; now += 16) {
      const frame = model.update(now);
      const landed = { ...frame, crew: frame.crew.filter((c) => c.unfold >= 0.5) };
      expect(outside(frame, reachOf(landed))).toEqual([]);
      if (!landing && frame.crew.find((c) => c.id === "a")?.phase === "orbiting") landing = frame;
    }
    // The frame it lands, still mid-glide, the working crewmate sits exactly
    // on its orbit's curve at the working ring's radius, inside the idle one.
    if (!landing) throw new Error("The first crewmate never landed");
    const mix = landing.planeBlend;
    expect(mix).toBeGreaterThan(0.05);
    expect(mix).toBeLessThan(0.95);
    const a = landing.crew.find((c) => c.id === "a");
    const [orbit] = landing.orbits;
    if (!a || !orbit) throw new Error("The landing frame has no crewmate or orbit");
    const ring = DEFAULT_ORBIT.radius;
    const idle = ring * (1 + DEFAULT_ORBIT.idleOffset);
    const inner = planeRadius(0, [2]);
    const cos = Math.cos(orbit.angle);
    const sin = Math.sin(orbit.angle);
    const along = ((a.x - orbit.x) * cos + (a.y - orbit.y) * sin) / orbit.major;
    const across = ((a.y - orbit.y) * cos - (a.x - orbit.x) * sin) / orbit.minor;
    expect(Math.hypot(along, across)).toBeCloseTo(
      (ring + (inner - ring) * mix) / (idle + (inner - idle) * mix),
      9,
    );
  });
  it("slows near a reviewer circling the work it reviews, off the orbit", () => {
    const model = homeStage(3);
    model.setReview("c1", "c0");
    let off = false;
    for (let now = 0; now <= 20_000; now += 16) {
      const frame = model.update(now);
      const reviewer = frame.crew.filter((c) => c.id === "c1");
      expect(outside(frame, reachOf({ ...frame, crew: reviewer }))).toEqual([]);
      // Its circle takes it beyond the orbit's own margin.
      const [c1] = reviewer;
      if (c1 && !inCrewZone({ orbits: frame.orbits, crew: [] }, c1.x, c1.y)) off = true;
    }
    expect(off).toBe(true);
  });
  it("is the ring itself in the historical ring formation", () => {
    const model = new CrewOrbit(0, { ...DEFAULT_ORBIT }, () => 0.37);
    model.spawn("a", "idle", 0, true);
    const frame = model.update(0, true);
    // The idle crew's ring, the outer one.
    const across = DEFAULT_ORBIT.radius * (1 + DEFAULT_ORBIT.idleOffset);
    const up = across * DEFAULT_ORBIT.tilt;
    expect(inCrewZone(frame, across + MARGIN - 0.5, 0)).toBe(true);
    expect(inCrewZone(frame, across + MARGIN + 0.5, 0)).toBe(false);
    expect(inCrewZone(frame, 0, -(up + MARGIN - 0.5))).toBe(true);
    expect(inCrewZone(frame, 0, -(up + MARGIN + 0.5))).toBe(false);
  });
  it("covers another computer's cluster by its own orbits, not a circle out to it", () => {
    const model = new ComputerOrbits(0, () => 0.37);
    model.configure([device("peer")]);
    for (let i = 0; i < 4; i++) place(model, `home${i}`, null);
    for (let i = 0; i < 6; i++) place(model, `peer${i}`, "peer");
    model.settleBootRoster(0);
    const frame = model.update(0, true);
    const cluster = model.clusters().find((c) => c.id === "peer");
    if (!cluster) throw new Error("The other computer has no cluster");
    expect(outside(frame, reachOf(frame))).toEqual([]);
    expect(inCrewZone(frame, cluster.x, cluster.y)).toBe(true);
    // Straight above the character, as far out as the cluster, and above the cluster's own orbit.
    expect(inCrewZone(frame, 0, -Math.abs(cluster.x))).toBe(false);
    const top = topOf(0, planeRadius(0, [6])) * CLUSTER_LAYOUT.sizeShare;
    expect(inCrewZone(frame, cluster.x, cluster.y - (top + MARGIN + 1))).toBe(false);
  });
  it("follows an unreachable computer's cluster as it moves aside for home", () => {
    const model = new ComputerOrbits(0, () => 0.37);
    model.configure([device("peer", { inReach: false })]);
    for (let i = 0; i < 4; i++) place(model, `home${i}`, null);
    for (let i = 0; i < 6; i++) place(model, `peer${i}`, "peer");
    model.settleBootRoster(0);
    const before = model.update(0, true);
    const from = model.clusters().find((c) => c.id === "peer")?.x;
    // Home's orbit widens with eight more crew, so the cluster's seat glides outward.
    for (let i = 4; i < 12; i++) place(model, `home${i}`, null, 16);
    const peerReach = (frame: OrbitFrame) =>
      reachOf({ ...frame, crew: frame.crew.filter((c) => c.computerId === "peer") });
    expect(outside(before, peerReach(before))).toEqual([]);
    for (let now = 16; now <= 3000; now += 16) {
      const frame = model.update(now);
      const seat = model.clusters().find((c) => c.id === "peer");
      if (!seat) throw new Error("The other computer lost its seat");
      // Its orbit glides with the seat, and its crew with it.
      const centred = frame.orbits.filter(
        (o) => Math.abs(o.x - seat.x) < 1e-6 && Math.abs(o.y - seat.y) < 1e-6,
      );
      expect(centred).toHaveLength(1);
      expect(outside(frame, peerReach(frame))).toEqual([]);
    }
    expect(model.clusters().find((c) => c.id === "peer")?.x).not.toBeCloseTo(from ?? 0, 0);
  });
});

describe("the crewmate under the pointer", () => {
  it("acquires within half the glyph plus the pad, never less than the minimum", () => {
    expect(crewHitRadius(25)).toBe(20.5);
    expect(crewHitRadius(12)).toBe(CREW_HOVER.minPx);
    expect(crewHitRadius(30, 0.5)).toBe(CREW_HOVER.minPx);
    const crew = [mate("a", 100, 0)];
    expect(crewHit(crew, 120.5, 0)).toBe("a");
    expect(crewHit(crew, 121, 0)).toBeNull();
    expect(crewHit(crew, 100, -20)).toBe("a");
  });
  it("measures in screen pixels when the formation is fitted", () => {
    const crew = [mate("a", 200, 0)];
    // Painted at 150 px from the centre; the glyph is 18.75 px there.
    expect(crewHit(crew, 150, 0, 0.75)).toBe("a");
    expect(crewHit(crew, 200, 0, 0.75)).toBeNull();
    expect(crewHit(crew, 150 + crewHitRadius(25, 0.75), 0, 0.75)).toBe("a");
  });
  it("sticks to the held crewmate out to its release radius, then lets go", () => {
    const crew = [mate("a", 0, 0)];
    const release = 20.5 * CREW_HOVER.release;
    expect(crewHit(crew, 30, 0, 1, "a")).toBe("a");
    expect(crewHit(crew, release, 0, 1, "a")).toBe("a");
    expect(crewHit(crew, release + 0.1, 0, 1, "a")).toBeNull();
    // The same spot does not acquire it in the first place.
    expect(crewHit(crew, 30, 0)).toBeNull();
  });
  it("prefers the nearer centre, and the nearer to the camera when equally near", () => {
    const near = mate("near", 10, 0, { depth: 0.9 });
    const far = mate("far", -10, 0, { depth: 0.1 });
    expect(crewHit([far, near], 4, 0)).toBe("near");
    expect(crewHit([far, near], -4, 0)).toBe("far");
    expect(crewHit([far, near], 0, 0)).toBe("near");
    expect(crewHit([near, far], 0, 0)).toBe("near");
  });
  it("hands over to a neighbour only once the pointer has left the held one", () => {
    const crew = [mate("a", 0, 0), mate("b", 45, 0)];
    // Inside both: the held one keeps it.
    expect(crewHit(crew, 20, 0, 1, "a")).toBe("a");
    // Past a's acquire radius but still inside its release radius, on b.
    expect(crewHit(crew, 26, 0, 1, "a")).toBe("b");
  });
  it("never lands on a departing crewmate or a spark that has not unfolded", () => {
    expect(crewHit([mate("a", 0, 0, { phase: "leaving" })], 0, 0)).toBeNull();
    expect(crewHit([mate("a", 0, 0, { phase: "leaving" })], 0, 0, 1, "a")).toBeNull();
    expect(crewHit([mate("a", 0, 0, { phase: "spawning", unfold: 0.2 })], 0, 0)).toBeNull();
    expect(crewHit([mate("a", 0, 0, { phase: "spawning", unfold: 0.8 })], 0, 0)).toBe("a");
  });
  it("lets go when the held crewmate is no longer there", () => {
    expect(crewHit([], 0, 0, 1, "gone")).toBeNull();
    expect(crewHit([mate("b", 0, 0)], 0, 0, 1, "gone")).toBe("b");
  });
});

describe("where the summary sits", () => {
  const panel = { width: 240, height: 110 };
  const within = { left: -600, top: -340, right: 600, bottom: 260 };
  const roomy: SummaryRoom = { within, avoid: [] };
  const reach = 16;
  const lead = CREW_HOVER.leadPx;
  const around = (x: number, y: number) => ({
    left: x - reach,
    top: y - reach,
    right: x + reach,
    bottom: y + reach,
  });
  const place = (x: number, y: number, room = roomy, clear = around(x, y)) =>
    placeCrewSummary({ x, y }, reach, clear, panel, room);
  const inside = (at: { x: number; y: number }, box = within) =>
    at.x >= box.left &&
    at.x + panel.width <= box.right &&
    at.y >= box.top &&
    at.y + panel.height <= box.bottom;

  it("sits beside the crewmate on the side away from the character, level with it", () => {
    expect(place(150, -40)).toMatchObject({ x: 150 + reach + lead, y: -95 });
    expect(place(-150, 40)).toMatchObject({ x: -150 - reach - lead - 240, y: -15 });
  });
  it("joins the brackets to the panel with a level hairline", () => {
    const right = place(150, -40);
    expect(right.line.x).toBeCloseTo(150 + reach);
    expect(right.line.y).toBeCloseTo(-40);
    expect(right.line.length).toBeCloseTo(lead);
    expect(right.line.angle).toBeCloseTo(0);
    const left = place(-150, 40);
    expect(left.line.x).toBeCloseTo(-150 - reach);
    expect(Math.abs(left.line.angle)).toBeCloseTo(Math.PI);
  });
  it("clears the crewmate's name as well as its brackets", () => {
    const named = { left: 86, top: -76, right: 214, bottom: -24 };
    const at = place(150, -40, roomy, named);
    expect(at.x).toBe(214 + lead);
    // The hairline still starts at the brackets and runs under the name.
    expect(at.line.x).toBeCloseTo(150 + reach);
    expect(at.line.length).toBeCloseTo(214 + lead - 150 - reach);
  });
  it("stays level with the crewmate as far as the window allows", () => {
    const low = place(150, 240);
    expect(low.y).toBe(within.bottom - panel.height);
    expect(low.line.length).toBeCloseTo(lead);
    expect(place(150, -330).y).toBe(within.top);
  });
  it("goes under or over the crewmate, away from the character, when beside it has no room", () => {
    const narrow = { within: { ...within, left: -150, right: 150 }, avoid: [] };
    const under = place(120, 100, narrow);
    expect(under).toMatchObject({ x: -90, y: 100 + reach + lead });
    expect(under.line.angle).toBeCloseTo(Math.PI / 2);
    const over = place(-120, -100, narrow);
    expect(over).toMatchObject({ x: -150, y: -100 - reach - lead - 110 });
    // Under has no room near the input: over it instead.
    expect(place(120, 200, narrow)).toMatchObject({ x: -90, y: 200 - reach - lead - 110 });
    for (const at of [under, over]) expect(inside(at, narrow.within)).toBe(true);
  });
  it("never sits under a rail's panel", () => {
    // A tall panel docked on the right: beside has no room, over does.
    const docked = { within, avoid: [{ left: 300, top: -340, right: 600, bottom: 40 }] };
    expect(place(150, -40, docked)).toMatchObject({ x: 30, y: -40 - reach - lead - 110 });
    // Over and under are taken too: the character's side is what is left.
    const boxed = {
      within,
      avoid: [
        { left: 170, top: -340, right: 600, bottom: 260 },
        { left: 140, top: -340, right: 600, bottom: -60 },
        { left: 140, top: -20, right: 600, bottom: 260 },
      ],
    };
    expect(place(150, -40, boxed)).toMatchObject({ x: 150 - reach - lead - 240, y: -95 });
  });
  it("still lands inside the window when nowhere has room", () => {
    const tiny = { within: { left: -100, top: -60, right: 100, bottom: 60 }, avoid: [] };
    const at = place(40, 0, tiny);
    expect(at.x).toBe(-100);
    expect(at.y).toBe(-55);
  });
});

describe("where a Tasks row's summary sits", () => {
  // A 1200 x 800 window under a 40 px top bar, with the Tasks panel in the
  // right rail and the summary 240 x 110.
  const window = { left: 0, top: 40, right: 1200, bottom: 800 };
  const rightPanel = { left: 900, right: 1180 };
  const panel = { width: 240, height: 110 };
  const lead = CREW_HOVER.leadPx;
  const row = (top: number) => ({ top, bottom: top + 26 });

  it("sits outside the panel on the stage's side, centred on the row, its hairline across the lead", () => {
    const at = placeRowSummary(row(300), rightPanel, panel, { within: window, avoid: [] });
    expect(at).toMatchObject({ x: 900 - lead - 240, y: 313 - 55 });
    expect(at.line).toMatchObject({ x: 900, y: 313, length: lead });
    expect(at.line.angle).toBeCloseTo(Math.PI);
    // A panel in the left rail opens it on the right.
    const left = placeRowSummary(row(300), { left: 20, right: 300 }, panel, {
      within: window,
      avoid: [],
    });
    expect(left).toMatchObject({ x: 300 + lead, y: 258 });
    expect(left.line).toMatchObject({ x: 300, y: 313, length: lead, angle: 0 });
  });

  it("stays under the top bar and inside the window, its hairline still reaching the row", () => {
    const top = placeRowSummary(row(44), rightPanel, panel, { within: window, avoid: [] });
    expect(top.y).toBe(40);
    const bottom = placeRowSummary(row(770), rightPanel, panel, { within: window, avoid: [] });
    expect(bottom.y).toBe(800 - 110);
    expect(bottom.line).toMatchObject({ x: 900, y: 783, length: lead });
  });

  it("rises above the input where the input is in the way", () => {
    const input = { left: 500, top: 700, right: 800, bottom: 790 };
    const at = placeRowSummary(row(700), rightPanel, panel, { within: window, avoid: [input] });
    expect(at).toMatchObject({ x: 646, y: 700 - 110 });
    // The hairline climbs from the row's middle to the summary's corner.
    expect(at.line.x).toBe(900);
    expect(at.line.y).toBe(713);
    expect(at.line.angle).toBeLessThan(-Math.PI / 2);
  });

  it("takes the other side where something fills the stage's side from top to bottom", () => {
    const within = { left: 0, top: 40, right: 1000, bottom: 800 };
    const tall = { left: 200, top: 0, right: 500, bottom: 800 };
    const at = placeRowSummary(row(300), { left: 500, right: 700 }, panel, {
      within,
      avoid: [tall],
    });
    expect(at).toMatchObject({ x: 700 + lead, y: 258 });
    expect(at.line).toMatchObject({ x: 700, y: 313, length: lead, angle: 0 });
  });

  it("still lands inside the window when neither side has room", () => {
    const tiny = { left: 0, top: 40, right: 400, bottom: 800 };
    const at = placeRowSummary(row(300), { left: 120, right: 380 }, panel, {
      within: tiny,
      avoid: [],
    });
    expect(at.x).toBeGreaterThanOrEqual(0);
    expect(at.x + 240).toBeLessThanOrEqual(400);
  });
});

describe("where a task key's summary sits (FI3-594)", () => {
  // A 1200 x 800 window under a 40 px top bar, a card in the middle with a
  // key on one of its lines, and the summary 240 x 110.
  const window = { left: 0, top: 40, right: 1200, bottom: 800 };
  const card = { left: 400, right: 800 };
  const panel = { width: 240, height: 110 };
  const lead = CREW_HOVER.leadPx;
  const key = { left: 520, top: 300, right: 580, bottom: 318 };

  it("sits beside the card, level with the key, its hairline from the card's edge on the key's line", () => {
    const at = placeKeySummary(key, card, panel, { within: window, avoid: [] });
    expect(at).toMatchObject({ x: 800 + lead, y: 309 - 55 });
    expect(at.line).toMatchObject({ x: 800, y: 309, length: lead, angle: 0 });
  });

  it("takes the card's other side where a rail fills this one", () => {
    const rail = { left: 820, top: 40, right: 1200, bottom: 800 };
    const at = placeKeySummary(key, card, panel, { within: window, avoid: [rail] });
    expect(at).toMatchObject({ x: 400 - lead - 240, y: 254 });
    expect(at.line).toMatchObject({ x: 400, y: 309, length: lead });
    expect(at.line.angle).toBeCloseTo(Math.PI);
  });

  it("sits under the key's line where neither side of the card has room, never over the key", () => {
    const narrow = { left: 0, top: 40, right: 820, bottom: 800 };
    const wide = { left: 10, right: 810 };
    const at = placeKeySummary(key, wide, panel, { within: narrow, avoid: [] });
    expect(at).toMatchObject({ x: 550 - 120, y: 318 + lead });
    // The hairline drops from the key's foot to the summary.
    expect(at.line).toMatchObject({ x: 550, y: 318, length: lead });
    expect(at.line.angle).toBeCloseTo(Math.PI / 2);
    // With the input under the key, it sits over the key's line instead.
    const input = { left: 0, top: 400, right: 820, bottom: 800 };
    const over = placeKeySummary(key, wide, panel, { within: narrow, avoid: [input] });
    expect(over).toMatchObject({ x: 430, y: 300 - lead - 110 });
    expect(over.line).toMatchObject({ x: 550, y: 300, length: lead });
  });
});
