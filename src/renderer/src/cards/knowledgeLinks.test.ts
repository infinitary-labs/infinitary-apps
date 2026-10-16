import type { KnowledgeRef } from "@shared/knowledge";
import { describe, expect, it } from "vitest";
import { knowledgeHere, knowledgeOpenSchema } from "../plugins/point/openKnowledge";
import { referenceLabel, referenceTone } from "./knowledgeLinks";

/**
 * A card body's knowledge references (docs/knowledge.md, "References in an
 * answer"): the words each is read by and the mark its standing takes, and
 * that they open only where the window has the Knowledge browser.
 */

const finding = (patch: Partial<KnowledgeRef> = {}): KnowledgeRef => ({
  id: "f-abc123",
  kind: "finding",
  scope: "repo-harbor",
  title: "A retry keeps the original message identity.",
  revision: 2,
  retired: false,
  standing: "checked",
  ...patch,
});

describe("a knowledge reference", () => {
  it("is read by what it is, its id, what it says and where it stands", () => {
    expect(referenceLabel(finding())).toBe(
      "Finding f-abc123: A retry keeps the original message identity · Checked",
    );
    expect(referenceLabel(finding({ standing: "recheck" }))).toBe(
      "Finding f-abc123: A retry keeps the original message identity · Needs rechecking",
    );
    expect(
      referenceLabel(
        finding({ id: "c-def456", kind: "concept", title: "Retry policy", standing: null }),
      ),
    ).toBe("Concept c-def456: Retry policy");
    expect(
      referenceLabel(
        finding({ kind: "concept", title: "Old idea", standing: null, retired: true }),
      ),
    ).toBe("Concept f-abc123: Old idea · Retired");
  });

  it("marks a finding checked with evidence, one worth another look, and the rest alike", () => {
    expect(referenceTone(finding())).toBe("ok");
    expect(referenceTone(finding({ standing: "recheck" }))).toBe("warn");
    expect(referenceTone(finding({ standing: "differing" }))).toBe("warn");
    expect(referenceTone(finding({ standing: "unchecked" }))).toBe("none");
    expect(referenceTone(finding({ kind: "concept", standing: null }))).toBe("none");
  });

  it("opens only where the window has the Knowledge browser, and only an entry by its id", () => {
    const panels = (cards?: Record<string, unknown>) => ({
      get: (id: string) => (id === "knowledge" ? ({ cards } as never) : undefined),
    });
    expect(knowledgeHere(panels({ browser: { view: "browser" } }))).toBe(true);
    expect(knowledgeHere(panels())).toBe(false);
    expect(knowledgeHere({ get: () => undefined })).toBe(false);
    expect(
      knowledgeOpenSchema.safeParse({ id: "f-abc123", scope: "repo-harbor", revision: 1 }).success,
    ).toBe(true);
    expect(knowledgeOpenSchema.safeParse({ id: "claim:f-abc123", scope: "x" }).success).toBe(false);
    expect(knowledgeOpenSchema.safeParse({ id: "f-abc123", scope: "x", revision: 0 }).success).toBe(
      false,
    );
  });
});
