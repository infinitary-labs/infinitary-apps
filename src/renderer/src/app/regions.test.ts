import { describe, expect, it } from "vitest";
import { type RegionDirection, regionDistance } from "./regions";

// The window's parts as Home draws them in a 1280 by 860 window: a side panel
// on each rail, the shown card in the middle, the main message under it.
const leftPanel = { left: 16, right: 296, top: 64, bottom: 520 };
const card = { left: 344, right: 936, top: 96, bottom: 700 };
const rightPanel = { left: 984, right: 1264, top: 64, bottom: 520 };
const mainMessage = { left: 360, right: 920, top: 690, bottom: 800 };
const parts = { leftPanel, card, rightPanel, mainMessage };

/** The part a directional command goes to from `from`, as `moveToRegionToward` ranks them. */
function nearest(from: keyof typeof parts, direction: RegionDirection): string | null {
  const ranked = Object.entries(parts)
    .filter(([name]) => name !== from)
    .map(([name, box]) => ({ name, distance: regionDistance(parts[from], box, direction) }))
    .filter((entry): entry is { name: string; distance: number } => entry.distance !== null)
    .sort((a, b) => a.distance - b.distance);
  return ranked[0]?.name ?? null;
}

// INF-3547's accepted plan, piece 2: "directional part commands" beside F6.
describe("the directional part commands", () => {
  it("go to the part drawn that way, straight ahead before one off to the side", () => {
    expect(nearest("card", "left")).toBe("leftPanel");
    expect(nearest("card", "right")).toBe("rightPanel");
    expect(nearest("card", "down")).toBe("mainMessage");
    expect(nearest("mainMessage", "up")).toBe("card");
    expect(nearest("leftPanel", "right")).toBe("card");
    expect(nearest("rightPanel", "left")).toBe("card");
  });

  it("go nowhere where no part lies that way", () => {
    expect(nearest("leftPanel", "left")).toBeNull();
    expect(nearest("rightPanel", "right")).toBeNull();
    expect(nearest("mainMessage", "down")).toBeNull();
  });
});
