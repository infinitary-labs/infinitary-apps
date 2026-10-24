import { describe, expect, it } from "vitest";
import { type FocusLightState, lightFrame, OUT_OF_FOCUS_LIGHT } from "./focusLight";
import { CrewOrbit, DEFAULT_ORBIT, type OrbitFrame } from "./orbit";

/**
 * The project focus on the stage (INF-1091, the captain's staged settings:
 * crew of other projects dim to a quarter of their light, nothing hides or
 * moves). The frames are the orbit model's own, three crewmates on the ring.
 */

const seeded = () => {
  let s = 7;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
};

/** Three crewmates settled on the ring: two on the site, one on the app. */
function ring(): OrbitFrame {
  const model = new CrewOrbit(0, { ...DEFAULT_ORBIT }, seeded());
  model.spawn("t-site-1", "working", 0);
  model.spawn("t-site-2", "working", 0);
  model.spawn("t-app", "working", 0);
  return model.update(DEFAULT_ORBIT.spawnMs * 4, true);
}

const projectOf = (taskId: string) =>
  ({ "t-site-1": "p-site", "t-site-2": "p-site", "t-app": "p-app" })[taskId];

const alphaOf = (frame: OrbitFrame, id: string) => frame.crew.find((c) => c.id === id)?.alpha;

describe("lightFrame", () => {
  it("dims only the crew of other projects, and keeps every crewmate where it was", () => {
    const frame = ring();
    expect(alphaOf(frame, "t-app")).toBeGreaterThan(0.5);
    const lit = lightFrame(frame, { project: "p-site", projectOf }, new Map(), 0, 0);
    expect(lit.crew.map((c) => [c.id, c.x, c.y])).toEqual(frame.crew.map((c) => [c.id, c.x, c.y]));
    expect(alphaOf(lit, "t-site-1")).toBe(alphaOf(frame, "t-site-1"));
    expect(alphaOf(lit, "t-site-2")).toBe(alphaOf(frame, "t-site-2"));
    expect(alphaOf(lit, "t-app")).toBeCloseTo((alphaOf(frame, "t-app") ?? 0) * OUT_OF_FOCUS_LIGHT);
  });

  it("lights every crewmate with no project focused, and one whose project it does not know", () => {
    const frame = ring();
    expect(lightFrame(frame, { project: null, projectOf }, new Map(), 0, 0)).toBe(frame);
    const unknown = lightFrame(
      frame,
      { project: "p-site", projectOf: () => undefined },
      new Map(),
      0,
      0,
    );
    expect(unknown).toBe(frame);
  });

  it("eases the light over the move and back, and cuts with no duration (reduced motion)", () => {
    const frame = ring();
    const state: FocusLightState = new Map();
    const full = alphaOf(frame, "t-app") ?? 0;
    lightFrame(frame, { project: null, projectOf }, state, 0, 360);
    const half = lightFrame(frame, { project: "p-site", projectOf }, state, 180, 360);
    expect(alphaOf(half, "t-app")).toBeCloseTo((full * (1 + OUT_OF_FOCUS_LIGHT)) / 2);
    const dim = lightFrame(frame, { project: "p-site", projectOf }, state, 180, 360);
    expect(alphaOf(dim, "t-app")).toBeCloseTo(full * OUT_OF_FOCUS_LIGHT);
    const back = lightFrame(frame, { project: null, projectOf }, state, 1, 0);
    expect(alphaOf(back, "t-app")).toBe(full);
  });
});
