import { describe, expect, it } from "vitest";
import { DECISION_MODEL_CATALOG, decisionConsent, decisionKeyRejectedNote } from "./decisions";

describe("decision consent wording", () => {
  it("names the recipient, bounded facts, exclusions, billing and subscription fallback", () => {
    // The journey checks that this guidance reaches the form. This focused
    // oracle owns its words independently of that imported rendering.
    const native = DECISION_MODEL_CATALOG[0];
    expect(decisionConsent(native)).toEqual([
      "Jev will receive, for each task your first mate starts: the task's title and goal, your words for it, how it should be worked, the repository's name and delivery posture, and the title and summary of a task it builds on.",
      "It receives no code, no transcript and no file. Answers come back as one word.",
      "TypeSafe bills your key per token.",
      "If Jev cannot answer, one of your own subscription models answers instead, as it does today.",
    ]);
  });

  it("says a rejected key moved decisions to the user's own models", () => {
    // The key-rejected journey reads this note from the feed; its words are owned here.
    expect(decisionKeyRejectedNote(DECISION_MODEL_CATALOG[0].name)).toBe(
      "Jev rejected the key - decisions are running on your own models until it is replaced",
    );
  });
});
