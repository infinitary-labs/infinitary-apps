import { describe, expect, it } from "vitest";
import { CREW_FIT, sceneBox } from "./CrewOrbit";

/**
 * The captain's ask (INF-5726): no box holds a crewmate in, so with one
 * computer a companion's circle or a task's moons may reach past the home
 * formation's 560 px square. The crew canvases cover the window then, as they
 * do with several computers, so such a crewmate is drawn whole, not cut off
 * at the square's edge.
 */
describe("the crew canvases", () => {
  it("cover the window with one computer, past the formation's square", () => {
    const viewport = { width: 1280, height: 860 };
    const box = sceneBox(undefined, viewport, CREW_FIT.extentPx);
    expect(box.width).toBeGreaterThanOrEqual(viewport.width);
    expect(box.height).toBeGreaterThanOrEqual(viewport.height - CREW_FIT.reservePx);
    // The same room several computers' scene gets when it reaches no further.
    expect(box).toEqual(sceneBox({ halfWidth: 0, halfHeight: 0 }, viewport, CREW_FIT.extentPx));
  });

  it("never draw smaller than the formation's square in a small window", () => {
    const box = sceneBox(undefined, { width: 400, height: 500 }, CREW_FIT.extentPx);
    expect(box.width).toBeGreaterThanOrEqual(CREW_FIT.extentPx);
    expect(box.height).toBeGreaterThanOrEqual(CREW_FIT.extentPx);
  });
});
