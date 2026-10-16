import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ledgerProblems } from "../scripts/release-notes";

/**
 * The pull request's own check of the real ledger (docs/release-notes.md
 * "The release check"): the part of `validate` that needs no git history.
 * A change that adds a note without its area, or a maintenance note for
 * internal work that takes an exclusion, or a visible change without a hero
 * picture pair or a reason for none, or a picture that is missing, half a
 * pair, not a WebP or PNG, too wide, too large or portrait, fails here, on
 * its own pull request, instead of at the next alpha.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("the release-notes ledger", () => {
  it("declares every note's area and hero picture, and every picture passes the caps", () => {
    expect(ledgerProblems(ROOT)).toEqual([]);
  });
});
