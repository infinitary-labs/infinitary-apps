import { describe, expect, it } from "vitest";
import { LABEL_RECENT_MS, labelArrival, labelSpot } from "./iconLabel";

const view = { width: 1000, height: 600 };
const label = { width: 80, height: 22 };
const button = (left: number, top: number, size = 28) => ({
  left,
  top,
  right: left + size,
  bottom: top + size,
});

describe("an icon button's label", () => {
  it("sits centred under its button", () => {
    expect(labelSpot(button(400, 100), label, view)).toEqual({ x: 374, y: 134 });
  });

  it("stays inside the window beside an edge", () => {
    expect(labelSpot(button(980, 10, 20), label, view).x).toBe(1000 - 8 - 80);
    expect(labelSpot(button(0, 10, 20), label, view).x).toBe(8);
  });

  it("sits over its button near the bottom edge", () => {
    expect(labelSpot(button(400, 560), label, view)).toEqual({ x: 374, y: 560 - 6 - 22 });
  });

  it("waits before the first label, moves between buttons, and shows at once just after one went", () => {
    expect(labelArrival(false, Number.POSITIVE_INFINITY)).toBe("wait");
    expect(labelArrival(true, Number.POSITIVE_INFINITY)).toBe("move");
    expect(labelArrival(false, LABEL_RECENT_MS - 1)).toBe("cut");
    expect(labelArrival(false, LABEL_RECENT_MS)).toBe("wait");
  });
});
