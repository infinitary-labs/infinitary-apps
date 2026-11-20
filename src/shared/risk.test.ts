import { describe, expect, it } from "vitest";
import {
  RISK_DIMENSIONS,
  RISK_LEVELS,
  RISK_WORDS,
  riskAssessmentSchema,
  riskDeclarationSchema,
} from "./risk";

const rating = { level: "low", why: "One file" } as const;
const declared = Object.fromEntries(RISK_DIMENSIONS.map((dimension) => [dimension, rating]));

describe("a merge card's risk", () => {
  it("names seven dimensions, each with three levels in words and no overall", () => {
    expect(RISK_DIMENSIONS).toEqual([
      "blast",
      "behavior",
      "undo",
      "evidence",
      "sensitivity",
      "novelty",
      "deps",
    ]);
    expect(RISK_DIMENSIONS.map((dimension) => RISK_WORDS[dimension].label)).toEqual([
      "Blast radius",
      "Behavior",
      "Undo",
      "Evidence",
      "Sensitivity",
      "Novelty",
      "Dependencies",
    ]);
    for (const dimension of RISK_DIMENSIONS) {
      for (const level of RISK_LEVELS) expect(RISK_WORDS[dimension].levels[level]).toBeTruthy();
    }
    expect(riskAssessmentSchema.keyof().options).toEqual(["declared"]);
  });

  it("takes a declaration only with every dimension rated in one line", () => {
    expect(riskDeclarationSchema.safeParse(declared).success).toBe(true);
    const { deps: _deps, ...six } = declared;
    expect(riskDeclarationSchema.safeParse(six).success).toBe(false);
    expect(
      riskDeclarationSchema.safeParse({ ...declared, undo: { level: "huge", why: "x" } }).success,
    ).toBe(false);
    expect(
      riskDeclarationSchema.safeParse({ ...declared, undo: { level: "low", why: "" } }).success,
    ).toBe(false);
    expect(
      riskDeclarationSchema.safeParse({ ...declared, overall: { level: "high", why: "x" } })
        .success,
    ).toBe(false);
  });

  it("reads only the declaration from a historical assessment with extra fields", () => {
    expect(riskAssessmentSchema.parse({ declared, measured: { files: 24 } })).toEqual({ declared });
  });
});
