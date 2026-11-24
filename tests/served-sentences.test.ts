import { describe, expect, it } from "vitest";
import { compareServed, type ServedReading } from "../scripts/served-sentences.ts";

// INF-6559's plan, part 2, which the captain approved: a script lists every
// served sentence a change removed or altered, before and after, for both
// instruction sets, and the trimmer marks each one. The sentences below are
// check_change's and the crewmate prompt's own words before and after the
// trim that dropped "settlement" and "not a host count".

const CHECK_BEFORE =
  "Raw readings never settle a repair. Judge readiness, flakes, settlement and when to stop from your delivery guidance, not a host count. Never replay an unclear write.";
const CHECK_AFTER =
  "Raw readings never settle a repair. Judge readiness, flakes and when to stop from your delivery guidance.";
const PROMPT =
  "Do no unrelated work on the side. Photograph each noticeable view or state afterward, matching Before's window size, theme, data, state and crop.";

function crewmate(label: string, systemPrompt: string, check: string): ServedReading {
  return {
    label,
    systemPrompt,
    tools: [
      {
        name: "check_change",
        description: check,
        parameters: { properties: { rerun: { description: "Record the decision to rerun." } } },
      },
    ],
  };
}

describe("the served-sentence list (INF-6559 part 2)", () => {
  it("lists each altered and removed sentence once, with its after, and nothing unchanged", () => {
    const before = {
      Crewmate: [
        crewmate("claude direct-pr/reviewed", PROMPT, CHECK_BEFORE),
        crewmate("pi local-only/quick", PROMPT, CHECK_BEFORE),
      ],
    };
    const after = {
      Crewmate: [
        crewmate("claude direct-pr/reviewed", PROMPT, CHECK_AFTER),
        crewmate("pi local-only/quick", PROMPT, CHECK_AFTER),
      ],
    };
    const [seat] = compareServed(before, after);
    expect(seat.removedOrAltered).toEqual([
      {
        where: "tool check_change",
        before:
          "Judge readiness, flakes, settlement and when to stop from your delivery guidance, not a host count.",
        after: {
          where: "tool check_change",
          sentence: "Judge readiness, flakes and when to stop from your delivery guidance.",
        },
        readings: ["claude direct-pr/reviewed", "pi local-only/quick"],
      },
      {
        where: "tool check_change",
        before: "Never replay an unclear write.",
        after: undefined,
        readings: ["claude direct-pr/reviewed", "pi local-only/quick"],
      },
    ]);
  });

  it("names the readings a prompt sentence left and where a moved sentence now is", () => {
    const shorter =
      "Do no unrelated work on the side. Photograph each noticeable view or state afterward, matching Before's window size, theme, data and crop.";
    const before = {
      Crewmate: [
        crewmate("claude direct-pr/reviewed", PROMPT, CHECK_AFTER),
        crewmate("pi local-only/quick", PROMPT, CHECK_AFTER),
      ],
    };
    const after = {
      Crewmate: [
        crewmate("claude direct-pr/reviewed", PROMPT, CHECK_AFTER),
        crewmate(
          "pi local-only/quick",
          shorter.replace("Do no unrelated work on the side. ", ""),
          `${CHECK_AFTER} Do no unrelated work on the side.`,
        ),
      ],
    };
    const [seat] = compareServed(before, after);
    expect(seat.removedOrAltered).toEqual([
      {
        where: "prompt",
        before: "Do no unrelated work on the side.",
        after: { where: "tool check_change", sentence: "Do no unrelated work on the side." },
        readings: ["pi local-only/quick"],
      },
      {
        where: "prompt",
        before:
          "Photograph each noticeable view or state afterward, matching Before's window size, theme, data, state and crop.",
        after: {
          where: "prompt",
          sentence:
            "Photograph each noticeable view or state afterward, matching Before's window size, theme, data and crop.",
        },
        readings: ["pi local-only/quick"],
      },
    ]);
  });
});
