import { describe, expect, it } from "vitest";
import { crewModelLabelPlacement, crewModelLabelsVisible } from "./modelLabels";
import { CREW_NAMES_UP_TO } from "./orbitalPlanes";

describe("single active orbit labels", () => {
  it("hides an empty roster and shows any one occupied orbit", () => {
    expect(crewModelLabelsVisible([])).toBe(false);
    expect(crewModelLabelsVisible([{ plane: 0, phase: "orbiting" }])).toBe(true);
    expect(crewModelLabelsVisible([{ plane: 2, phase: "orbiting" }])).toBe(true);
    expect(crewModelLabelsVisible([{ phase: "orbiting" }])).toBe(true);
  });
  it("hides all names as soon as a second orbit appears and restores them on departure", () => {
    const inner = { plane: 0, phase: "orbiting" as const };
    const middle = { plane: 1, phase: "spawning" as const };
    expect(crewModelLabelsVisible([inner, inner])).toBe(true);
    expect(crewModelLabelsVisible([inner, middle])).toBe(false);
    expect(crewModelLabelsVisible([inner, { ...middle, phase: "leaving" }])).toBe(true);
    expect(crewModelLabelsVisible([{ ...inner, phase: "leaving" }])).toBe(false);
  });
  it("hides names once the one orbit holds more than eight crew (captain, INF-1179)", () => {
    const first = { plane: 0, phase: "orbiting" as const };
    expect(crewModelLabelsVisible(Array(CREW_NAMES_UP_TO).fill(first))).toBe(true);
    expect(crewModelLabelsVisible(Array(CREW_NAMES_UP_TO + 1).fill(first))).toBe(false);
    expect(
      crewModelLabelsVisible([
        ...Array(CREW_NAMES_UP_TO).fill(first),
        { ...first, phase: "leaving" },
      ]),
    ).toBe(true);
  });
});

describe("crewModelLabelPlacement", () => {
  it("caps text in screen pixels and narrows it at the scaled canvas edge", () => {
    expect(crewModelLabelPlacement({ x: 0, y: 0, size: 25 }, 560, 0.75).width).toBe(128);
    expect(crewModelLabelPlacement({ x: 240, y: 0, size: 25 }, 560, 0.75).width).toBe(44);
    expect(crewModelLabelPlacement({ x: -240, y: 0, size: 25 }, 560, 0.75).width).toBe(44);
  });
});
