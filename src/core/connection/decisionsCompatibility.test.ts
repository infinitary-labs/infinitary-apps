import { DEFAULT_DECISIONS, type DecisionsView, decisionsViewSchema } from "@shared/decisions";
import { expect, it } from "vitest";
import { DECISION_PROVIDERS, decisionsFor } from "./cardCompatibility";

// Intent: the contract rule that a new member of a closed set breaks an
// older strict view - a view from before `decision-providers` reads the
// Decisions view in the shape it knows, and a current view reads it whole.
const go: DecisionsView = {
  settings: {
    ...DEFAULT_DECISIONS,
    answerer: { kind: "provider", provider: "opencode-go", model: "jev-1.14" },
    egress: { "opencode-go": { enabled: true, consentedVersion: 2 } },
  },
  stateVersion: 1,
  providers: [
    {
      provider: "opencode-go",
      models: [{ id: "jev-1.14", name: "Jev 1.14", vendor: "TypeSafe", inputPrice: 0.042 }],
      state: "ready",
      consented: true,
      last: null,
    },
  ],
  natives: [],
};

/** The Decisions view as a home before `decision-providers` sent it, read as strictly as that view read it. */
const olderViewSchema = decisionsViewSchema.omit({ providers: true }).extend({
  settings: decisionsViewSchema.shape.settings.extend({
    answerer: decisionsViewSchema.shape.settings.shape.answerer.refine(
      (answerer) => answerer.kind !== "provider",
    ),
  }),
});

it("answers an older view on every Decisions channel in the shape it reads strictly", () => {
  for (const channel of [
    "inf:settings:decisions",
    "inf:settings:decisions:set",
    "inf:decisions:key:set",
    "inf:decisions:key:remove",
    "inf:decisions:use:set",
  ]) {
    const older = decisionsFor(channel, go, []) as DecisionsView;
    expect(olderViewSchema.safeParse(older).success).toBe(true);
    expect(older.settings.answerer).toEqual({ kind: "adapted", offering: "auto" });
  }
});

it("answers a current view, and every other channel, unchanged", () => {
  expect(decisionsFor("inf:settings:decisions", go, [DECISION_PROVIDERS])).toBe(go);
  expect(decisionsFor("inf:settings:look", go, [])).toBe(go);
});
