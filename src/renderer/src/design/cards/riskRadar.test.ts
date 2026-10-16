import { RISK_WORDS } from "@shared/risk";
import { describe, expect, it } from "vitest";
import { RISK_CHART_HEIGHT, radarPoint, riskRadarGeometry } from "./riskRadar";

/** An 11 px mono label's ink above and below its baseline. */
const ASCENT = 9;
const DESCENT = 3;

describe("the risk radar's box", () => {
  it("is 128 px tall with 80 px rings, as wide as the seven labels need (216 px)", () => {
    const geometry = riskRadarGeometry();
    expect(geometry.height).toBe(RISK_CHART_HEIGHT);
    expect(geometry.height).toBe(128);
    expect(geometry.radius * 2).toBe(80);
    expect(geometry.width).toBe(216);
    expect(geometry.axes.map((axis) => axis.dimension)).toEqual([
      "blast",
      "behavior",
      "undo",
      "evidence",
      "sensitivity",
      "novelty",
      "deps",
    ]);
  });

  it("keeps every label on the outer ring inside the box", () => {
    const geometry = riskRadarGeometry();
    for (const axis of geometry.axes) {
      const width = RISK_WORDS[axis.dimension].label.length * 6.6;
      const left =
        axis.label.anchor === "start"
          ? axis.label.x
          : axis.label.anchor === "end"
            ? axis.label.x - width
            : axis.label.x - width / 2;
      expect(left, axis.dimension).toBeGreaterThanOrEqual(0);
      expect(left + width, axis.dimension).toBeLessThanOrEqual(geometry.width);
      expect(axis.label.y - ASCENT, axis.dimension).toBeGreaterThanOrEqual(0);
      expect(axis.label.y + DESCENT, axis.dimension).toBeLessThanOrEqual(geometry.height);
      // Each label sits beyond its axis end, never over the rings.
      const [x, y] = radarPoint(geometry, geometry.radius, axis.angle);
      const near = Math.hypot(axis.label.x - geometry.cx, axis.label.y - geometry.cy);
      expect(near, axis.dimension).toBeGreaterThan(Math.hypot(x - geometry.cx, y - geometry.cy));
    }
  });
});
