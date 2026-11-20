import { describe, expect, it } from "vitest";
import { cardBodyHeight } from "./PrototypeBody";

describe("cardBodyHeight", () => {
  it("lets long card bodies grow past the former iframe scroll cap", () => {
    expect(cardBodyHeight(2_001)).toBe(2_001);
  });

  it("retains the minimum usable frame height", () => {
    expect(cardBodyHeight(0)).toBe(48);
  });

  it("gives a frame with no floor, the fact strip beside the buttons, its exact height", () => {
    expect(cardBodyHeight(36.4, 0)).toBe(37);
  });
});
