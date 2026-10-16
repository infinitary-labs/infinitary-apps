import { describe, expect, it } from "vitest";
import { withoutSignIn } from "./placedCopies";

/**
 * The address a computer that runs work clones a project from
 * (docs/helper.md, "Its working copies"): the project's origin, never with a
 * sign-in someone wrote into it, which would cross to the other Mac.
 */
describe("the origin a computer that runs work clones from", () => {
  it("takes a name or password out of a web address", () => {
    expect(withoutSignIn("https://sam:ghp_secret@github.com/sam/website.git")).toBe(
      "https://github.com/sam/website.git",
    );
    expect(withoutSignIn("http://token@git.example.com/website.git")).toBe(
      "http://git.example.com/website.git",
    );
  });

  it("leaves every other address as it is", () => {
    for (const origin of [
      "https://github.com/sam/website.git",
      "git@github.com:sam/website.git",
      "ssh://git@git.example.com/website.git",
      "/Volumes/projects/website.git",
    ])
      expect(withoutSignIn(origin)).toBe(origin);
  });
});
