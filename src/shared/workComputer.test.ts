import { describe, expect, it } from "vitest";
import { resolveWorkComputer } from "./workComputer";

// INF-1582: starting or placing work accepts a computer's name, without guessing a target.
const computers = [
  { id: "mini-1", name: "Kun's Mac mini" },
  { id: "studio-1", name: "Mac Studio" },
];

describe("work computer names", () => {
  it("resolves full names regardless of case and surrounding spaces to stable IDs", () => {
    expect(resolveWorkComputer("Kun's Mac mini", computers)).toBe("mini-1");
    expect(resolveWorkComputer("  KUN'S MAC MINI  ", computers)).toBe("mini-1");
    expect(resolveWorkComputer("Mac Studio", computers)).toBe("studio-1");
  });

  it("keeps explicit IDs and placement modes, even if a name collides", () => {
    const collision = [...computers, { id: "other", name: "mini-1" }];
    for (const selector of ["mini-1", "this-mac", "automatic"])
      expect(resolveWorkComputer(selector, collision)).toBe(selector);
  });

  it("refuses duplicate names with the IDs needed to disambiguate", () => {
    expect(() =>
      resolveWorkComputer("Kun's Mac mini", [
        ...computers,
        { id: "mini-2", name: "Kun's Mac mini" },
      ]),
    ).toThrow(/More than one.*mini-1.*mini-2/);
  });

  it("never guesses a partial, missing or empty name", () => {
    for (const selector of ["mini", "Missing", " "])
      expect(() => resolveWorkComputer(selector, computers)).toThrow(/No computer/);
  });
});
