import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type {
  knowledgeCollectionsSchema,
  knowledgeConceptsSchema,
  knowledgeDirectionReadSchema,
  knowledgeEntryReadSchema,
  knowledgeFindingsSchema,
  knowledgeGraphSchema,
} from "../knowledge";
import type {
  PanelKnowledgeCollections,
  PanelKnowledgeConcepts,
  PanelKnowledgeDirectionRead,
  PanelKnowledgeEntryRead,
  PanelKnowledgeFindings,
  PanelKnowledgeGraph,
  PersonalManifest,
  PersonalPresence,
  StoreValue,
} from "./contracts";
import {
  MIN_BACKGROUND_INTERVAL_MS,
  PERSONAL_HOST_MODULES,
  personalManifestSchema,
  type personalPresenceSchema,
  presenceSatisfied,
  type storeValueSchema,
} from "./manifest";

/**
 * The runtime schemas and the public types are two spellings of one
 * contract: what the host accepts is exactly what `infinitary-env.d.ts`
 * tells an extension it may write.
 */
describe("personal contracts", () => {
  it("pins the manifest, presence, and store schemas to the public types", () => {
    expectTypeOf<z.infer<typeof personalManifestSchema>>().toEqualTypeOf<PersonalManifest>();
    expectTypeOf<z.infer<typeof personalPresenceSchema>>().toEqualTypeOf<PersonalPresence>();
    expectTypeOf<z.infer<typeof storeValueSchema>>().toEqualTypeOf<StoreValue>();
    // The knowledge reads a panel is handed are the wire shapes the core answers.
    expectTypeOf<
      z.infer<typeof knowledgeCollectionsSchema>
    >().toEqualTypeOf<PanelKnowledgeCollections>();
    expectTypeOf<z.infer<typeof knowledgeGraphSchema>>().toEqualTypeOf<PanelKnowledgeGraph>();
    expectTypeOf<z.infer<typeof knowledgeConceptsSchema>>().toEqualTypeOf<PanelKnowledgeConcepts>();
    expectTypeOf<z.infer<typeof knowledgeFindingsSchema>>().toEqualTypeOf<PanelKnowledgeFindings>();
    expectTypeOf<
      z.infer<typeof knowledgeEntryReadSchema>
    >().toEqualTypeOf<PanelKnowledgeEntryRead>();
    expectTypeOf<
      z.infer<typeof knowledgeDirectionReadSchema>
    >().toEqualTypeOf<PanelKnowledgeDirectionRead>();
    expect(MIN_BACKGROUND_INTERVAL_MS).toBe(60_000);
    expect(Object.keys(PERSONAL_HOST_MODULES)).toEqual([
      "react",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@infinitary/ui",
    ]);
  });

  it("parses a manifest strictly and refuses a key the contract does not name", () => {
    expect(
      personalManifestSchema.parse({
        title: "Open PRs",
        placement: { x: "left", y: "top" },
        presence: { store: "items", when: "nonEmpty" },
        origin: { taskId: "t-1" },
      }),
    ).toEqual({
      title: "Open PRs",
      placement: { x: "left", y: "top" },
      presence: { store: "items", when: "nonEmpty" },
      origin: { taskId: "t-1" },
    });
    expect(personalManifestSchema.safeParse({ main: "index.js" }).success).toBe(false);
    expect(
      personalManifestSchema.safeParse({ presence: { store: "x", when: "always" } }).success,
    ).toBe(false);
    expect(personalManifestSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("reads presence as data: empty values hide, real values show, always always shows", () => {
    const read = (values: Record<string, StoreValue | undefined>) => (key: string) => values[key];
    const store: PersonalPresence = { store: "items", when: "nonEmpty" };
    for (const empty of [undefined, null, "", [], {}]) {
      expect(presenceSatisfied(store, read({ items: empty }))).toBe(false);
    }
    for (const value of [0, false, "x", [0], { a: 1 }]) {
      expect(presenceSatisfied(store, read({ items: value }))).toBe(true);
    }
    expect(presenceSatisfied({ always: true }, read({}))).toBe(true);
  });
});
