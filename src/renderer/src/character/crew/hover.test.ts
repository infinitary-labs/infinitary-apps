import { describe, expect, it } from "vitest";
import {
  CREW_HOVER,
  crewHit,
  crewHitRadius,
  crewZoneRadius,
  placeCrewSummary,
  placeKeySummary,
  placeRowSummary,
  type SummaryRoom,
} from "./hover";
import { CROWDED_PLANES } from "./orbitalPlanes";

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

describe("the slow zone", () => {
  it("is the outermost occupied orbit plus the margin, in screen pixels", () => {
    const inner = { plane: 0, phase: "orbiting" as const };
    const outer = { plane: 2, phase: "orbiting" as const };
    expect(crewZoneRadius({ crew: [inner], ringRadius: 190 })).toBe(
      CROWDED_PLANES[0].radius + CREW_HOVER.zoneMarginPx,
    );
    expect(crewZoneRadius({ crew: [inner, outer], ringRadius: 190 })).toBe(
      CROWDED_PLANES[2].radius + CREW_HOVER.zoneMarginPx,
    );
    // The fitted formation shrinks the orbit, not the margin.
    expect(crewZoneRadius({ crew: [inner, outer], ringRadius: 190 }, 0.75)).toBe(
      CROWDED_PLANES[2].radius * 0.75 + CREW_HOVER.zoneMarginPx,
    );
  });
  it("does not exist with nobody out, and ignores a departing crewmate's orbit", () => {
    expect(crewZoneRadius({ crew: [], ringRadius: 190 })).toBeNull();
    expect(
      crewZoneRadius({
        crew: [
          { plane: 0, phase: "orbiting" },
          { plane: 1, phase: "leaving" },
        ],
        ringRadius: 190,
      }),
    ).toBe(CROWDED_PLANES[0].radius + CREW_HOVER.zoneMarginPx);
    expect(crewZoneRadius({ crew: [{ phase: "leaving" }], ringRadius: 190 })).toBeNull();
  });
  it("uses the ring's own radius in the historical ring mode", () => {
    expect(crewZoneRadius({ crew: [{ phase: "orbiting" }], ringRadius: 190 })).toBe(230);
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
