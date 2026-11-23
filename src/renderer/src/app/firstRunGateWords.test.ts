import { describe, expect, it } from "vitest";
import { GATE_HOME_TITLE, gateIntro, gateMoveLater, gateWhere } from "./firstRunGateWords";

/**
 * The first-screen copy the captain approved: the heading on INF-417, and the
 * introduction, the question and the move-later line as drawn on INF-6207.
 */
describe("first-run gate words", () => {
  it("welcomes the captain in the first mate's voice and asks where it lives", () => {
    expect(GATE_HOME_TITLE).toBe("Welcome aboard Infinitary, Captain");
    expect(gateIntro()).toBe("I'm your first mate. I'll help you manage the rest of the crew.");
    expect(gateWhere()).toBe(
      "Where should I live? Pick a computer that stays on as much as possible.",
    );
    expect(gateMoveLater()).toBe(
      "You can move me to another computer later, in Settings → Devices.",
    );
  });
});
