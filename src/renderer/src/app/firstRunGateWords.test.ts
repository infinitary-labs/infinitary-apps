import { describe, expect, it } from "vitest";
import { GATE_HOME_TITLE, gateIntro } from "./firstRunGateWords";

/** The first-screen copy the captain approved on INF-417. */
describe("first-run gate words", () => {
  it("welcomes the captain in the first mate's voice", () => {
    expect(GATE_HOME_TITLE).toBe("Welcome aboard Infinitary, Captain");
    expect(gateIntro()).toBe(
      "I'm your first mate. I'll help you manage the rest of the crew. Set me up on a computer that stays on as much as possible. Your other devices need me awake.",
    );
  });
});
