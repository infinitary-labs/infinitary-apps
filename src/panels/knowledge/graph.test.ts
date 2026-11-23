import { describe, expect, it } from "vitest";
import {
  type Box,
  type Camera,
  HOME_CAMERA,
  LAYOUT_RADIUS,
  layoutGraph,
  ORBIT_BUTTON_STEP,
  ORBIT_KEY_STEP,
  orbitByDrag,
  orbitStep,
  PITCH_LIMIT,
  placeEdgeLabel,
  placeNodeLabel,
  project,
  tiltStep,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomStep,
} from "./graph";

/**
 * The knowledge graph's camera and layout (the design skill's
 * `components/knowledge/KnowledgeBrowser`, "The camera"): the captain's
 * approved orbit - a drag to the right moves the camera right, the buttons
 * and Shift with the arrows move it the same way, either button orbits -
 * held as signs and as real projected places, and a layout that is the
 * same every time for the same collection.
 */

const W = 640;
const H = 360;

describe("the camera", () => {
  it("turns right on a rightward drag: the far side sweeps left and the near side right", () => {
    const after = orbitByDrag(HOME_CAMERA, 70, 0);
    expect(after.yaw).toBeLessThan(HOME_CAMERA.yaw);
    expect(after.pitch).toBe(HOME_CAMERA.pitch);
    const flat: Camera = { yaw: 0, pitch: 0, zoom: 1 };
    const turned = orbitByDrag(flat, 50, 0);
    const far = { x: 0, y: 0, z: 200 };
    const near = { x: 0, y: 0, z: -200 };
    expect(project(far, turned, W, H).x).toBeLessThan(project(far, flat, W, H).x);
    expect(project(near, turned, W, H).x).toBeGreaterThan(project(near, flat, W, H).x);
    expect(project({ x: 0, y: 0, z: 0 }, turned, W, H)).toMatchObject({ x: W / 2, y: H / 2 });
  });

  it("moves the same way from the buttons and from Shift with the arrows", () => {
    expect(orbitStep(HOME_CAMERA, "right").yaw).toBeCloseTo(HOME_CAMERA.yaw - ORBIT_BUTTON_STEP);
    expect(orbitStep(HOME_CAMERA, "left").yaw).toBeCloseTo(HOME_CAMERA.yaw + ORBIT_BUTTON_STEP);
    expect(orbitStep(HOME_CAMERA, "right", ORBIT_KEY_STEP).yaw).toBeLessThan(HOME_CAMERA.yaw);
    // Down tilts as a downward drag does; the tilt stops short of straight down.
    expect(tiltStep(HOME_CAMERA, "down").pitch).toBeGreaterThan(HOME_CAMERA.pitch);
    expect(orbitByDrag(HOME_CAMERA, 0, 30).pitch).toBeGreaterThan(HOME_CAMERA.pitch);
    expect(orbitByDrag(HOME_CAMERA, 0, 10_000).pitch).toBe(PITCH_LIMIT);
    expect(orbitByDrag(HOME_CAMERA, 0, -10_000).pitch).toBe(-PITCH_LIMIT);
  });

  it("zooms from 60% to 145% in steps of ten, and nearer points draw larger", () => {
    let camera = HOME_CAMERA;
    for (let i = 0; i < 20; i++) camera = zoomStep(camera, "in");
    expect(camera.zoom).toBe(ZOOM_MAX);
    for (let i = 0; i < 20; i++) camera = zoomStep(camera, "out");
    expect(camera.zoom).toBe(ZOOM_MIN);
    expect(zoomStep(HOME_CAMERA, "in").zoom).toBe(1.1);
    const flat: Camera = { yaw: 0, pitch: 0, zoom: 1 };
    const near = project({ x: 100, y: 0, z: -200 }, flat, W, H);
    const far = project({ x: 100, y: 0, z: 200 }, flat, W, H);
    expect(near.radius).toBeGreaterThan(far.radius);
    expect(near.x - W / 2).toBeGreaterThan(far.x - W / 2);
    expect(near.depth).toBeLessThan(far.depth);
  });
});

describe("the layout", () => {
  const concepts = ["c-aaaaaa", "c-bbbbbb", "c-cccccc", "c-dddddd", "c-eeeeee"].map((id) => ({
    id,
  }));
  const connections = [
    { from: "c-aaaaaa", to: "c-bbbbbb" },
    { from: "c-bbbbbb", to: "c-cccccc" },
    { from: "c-dddddd", to: "c-eeeeee" },
  ];

  it("places the same collection the same way every time, inside its sphere", () => {
    const first = layoutGraph(concepts, connections);
    const second = layoutGraph([...concepts].reverse(), [...connections].reverse());
    expect([...first.entries()].sort()).toEqual([...second.entries()].sort());
    for (const point of first.values()) {
      expect(Math.hypot(point.x, point.y, point.z)).toBeLessThanOrEqual(LAYOUT_RADIUS + 1e-6);
    }
    // Real depth: the places are not all on one plane.
    const depths = new Set([...first.values()].map((point) => Math.round(point.z)));
    expect(depths.size).toBeGreaterThan(1);
  });

  it("keeps connected concepts nearer each other than unconnected ones", () => {
    const places = layoutGraph(concepts, connections);
    const gap = (a: string, b: string) => {
      const p = places.get(a);
      const q = places.get(b);
      if (!p || !q) throw new Error("missing");
      return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    };
    expect(gap("c-aaaaaa", "c-bbbbbb")).toBeLessThan(gap("c-aaaaaa", "c-eeeeee"));
  });
});

describe("the labels", () => {
  it("never places one label over another, and leaves out one with no room", () => {
    const taken: Box[] = [];
    const placed: Box[] = [];
    for (let i = 0; i < 12; i++) {
      const box = placeNodeLabel({ x: 200, y: 180 }, "Message delivery", taken, W, H);
      if (!box) continue;
      taken.push(box);
      placed.push(box);
    }
    expect(placed.length).toBeGreaterThan(1);
    expect(placed.length).toBeLessThan(12);
    for (const [i, a] of placed.entries()) {
      for (const b of placed.slice(i + 1)) {
        const apart =
          a.x + a.width < b.x ||
          b.x + b.width < a.x ||
          a.y + a.height < b.y ||
          b.y + b.height < a.y;
        expect(apart).toBe(true);
      }
    }
    const edge = placeEdgeLabel({ x: 100, y: 100 }, { x: 400, y: 100 }, "pins", taken, W, H);
    expect(edge).not.toBeNull();
    for (const other of taken) {
      if (!edge) break;
      const apart =
        edge.x + edge.width < other.x ||
        other.x + other.width < edge.x ||
        edge.y + edge.height < other.y ||
        other.y + other.height < edge.y;
      expect(apart).toBe(true);
    }
  });
});
