import { describe, expect, it } from "vitest";
import {
  DECISION_MODEL_CATALOG,
  DEFAULT_DECISIONS,
  type DecisionsView,
  decisionConsent,
  decisionKeyRejectedNote,
  decisionProviderPick,
  decisionsSettingsSchema,
  decisionsViewBeforeProviders,
  providerDecisionConsent,
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
      [offering.name, providerDecisionConsent(offering, "openrouter")],
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

  it("names the provider, the maker and the cost of a provider's decision model", () => {
    // Intent: the approved plan for OpenCode Go's decision models - the
    // approval screen names the provider, the maker and the cost, and a
    // subscription's call is charged to its allowance at list price.
    const jev = { id: "jev-1.14", name: "Jev 1.14", vendor: "TypeSafe", inputPrice: 0.042 };
    const [shared, , cost] = providerDecisionConsent(jev, "opencode-go");
    expect(shared).toBe(
      "Jev 1.14 (TypeSafe) answers Infinitary's decision questions through OpenCode Go, like your other models. Questions can include task details, your replies, nearby conversation and code.",
    );
    expect(cost).toBe(
      "Each call counts against your OpenCode Go allowance at list price, $0.042 per million input tokens; output is free. If Jev 1.14 cannot answer, your own models answer instead.",
    );
    expect(providerDecisionConsent(jev, "openrouter")[2]).toBe(
      "Your OpenRouter account pays $0.042 per million input tokens; output is free. If Jev 1.14 cannot answer, your own models answer instead.",
    );
    const luna = {
      id: "gpt-6-luna-decision",
      name: "GPT-6 Luna Decision",
      vendor: "OpenAI",
      inputPrice: 0.1,
    };
    expect(providerDecisionConsent(luna, "opencode-go")[2]).toContain(
      "$0.10 per million input tokens",
    );
  });

  it("says a rejected key moved decisions to the user's own models", () => {
    // The key-rejected journey reads this note from the feed; its words are owned here.
    expect(decisionKeyRejectedNote(DECISION_MODEL_CATALOG[0].name)).toBe(
      "Jev rejected the key - decisions are running on your own models until it is replaced",
    );
  });
});

describe("decision settings from before decision-providers", () => {
  // Intent: the approved plan - a saved OpenRouter pick is read as provider
  // openrouter - and the contract rule that a view from before the change
  // reads the view strictly, so it gets the shape it knows.
  const view = (answerer: DecisionsView["settings"]["answerer"]): DecisionsView => ({
    settings: {
      ...DEFAULT_DECISIONS,
      answerer,
      egress: { openrouter: { enabled: true, consentedVersion: 1 } },
    },
    stateVersion: 1,
    providers: [
      {
        provider: "openrouter",
        models: [
          { id: "typesafe/jev-1.13", name: "Jev 1.13", vendor: "TypeSafe", inputPrice: 0.042 },
        ],
        state: "ready",
        consented: true,
        last: null,
      },
      {
        provider: "opencode-go",
        models: [{ id: "jev-1.14", name: "Jev 1.14", vendor: "TypeSafe", inputPrice: 0.042 }],
        state: "off",
        consented: false,
        last: null,
      },
    ],
    natives: [],
  });

  it("reads a saved OpenRouter pick as provider openrouter", () => {
    const saved = decisionsSettingsSchema.parse({
      ...DEFAULT_DECISIONS,
      answerer: { kind: "openrouter", model: "typesafe/jev-1.13" },
    });
    expect(decisionProviderPick(saved.answerer)).toEqual({
      provider: "openrouter",
      model: "typesafe/jev-1.13",
    });
  });

  it("gives an older view OpenRouter's row and pick in the shape it knows", () => {
    const older = decisionsViewBeforeProviders(
      view({ kind: "provider", provider: "openrouter", model: "typesafe/jev-1.13" }),
    );
    expect(older.providers).toBeUndefined();
    expect(older.settings.answerer).toEqual({ kind: "openrouter", model: "typesafe/jev-1.13" });
    expect(older.openrouter).toEqual({
      models: [
        { id: "typesafe/jev-1.13", name: "Jev 1.13", vendor: "TypeSafe", inputPrice: 0.042 },
      ],
      state: "ready",
      consented: true,
      last: null,
    });
  });

  it("shows an older view another provider's pick as auto", () => {
    const older = decisionsViewBeforeProviders(
      view({ kind: "provider", provider: "opencode-go", model: "jev-1.14" }),
    );
    expect(older.settings.answerer).toEqual({ kind: "adapted", offering: "auto" });
  });
});
