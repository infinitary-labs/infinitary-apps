import { describe, expect, it } from "vitest";
import {
  DECISION_MODEL_CATALOG,
  decisionConsent,
  decisionKeyRejectedNote,
  openRouterDecisionConsent,
} from "./decisions";

describe("decision consent wording", () => {
  it("treats a decision model like the person's other models, naming who answers and who pays", () => {
    // Intent: the captain asked the approval screen to stop promising no
    // code, no transcripts and no files - decision models are like the
    // person's other models - and to cover every use in one approval. This
    // generator owns the three rows; the journeys own how the dialog draws them.
    const native = DECISION_MODEL_CATALOG[0];
    // The shape the home reads from OpenRouter's classifier list.
    const offering = {
      id: "typesafe/jev-1.13",
      name: "Jev 1.13",
      vendor: "TypeSafe",
      inputPrice: 0.042,
    };
    for (const [name, rows] of [
      [native.name, decisionConsent(native)],
      [offering.name, openRouterDecisionConsent(offering)],
    ] as const) {
      expect(rows).toHaveLength(3);
      const [shared, choice, cost] = rows;
      expect(shared).toContain(name);
      expect(shared).toContain("like your other models");
      expect(shared).toContain("code");
      expect(choice).toContain("Turn off any use");
      expect(cost).toContain("your own models answer instead");
      expect(rows.join(" ")).not.toMatch(/\bno (code|transcripts?|files?|attachments)\b/i);
    }
  });

  it("says a rejected key moved decisions to the user's own models", () => {
    // The key-rejected journey reads this note from the feed; its words are owned here.
    expect(decisionKeyRejectedNote(DECISION_MODEL_CATALOG[0].name)).toBe(
      "Jev rejected the key - decisions are running on your own models until it is replaced",
    );
  });
});
