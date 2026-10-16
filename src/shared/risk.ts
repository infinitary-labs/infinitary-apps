import { RISK_LEVELS, type RiskDimension, type RiskLevel } from "./cards";

// The wire shape lives with the card it rides (`./cards`, which loads in
// plain Node and so imports no sibling); it is re-exported here beside the
// words and the drawing's reading of it.
export {
  RISK_DIMENSIONS,
  RISK_LEVELS,
  RISK_WHY_MAX,
  type RiskAssessment,
  type RiskDeclaration,
  type RiskDimension,
  type RiskLevel,
  type RiskRating,
  riskAssessmentSchema,
  riskDeclarationSchema,
  riskRatingSchema,
} from "./cards";

/**
 * A merge card's risk assessment (FI3-1127's plan, built in FI3-1128;
 * docs/card-authoring.md "The risk chart"): seven dimensions a person weighs
 * before merging, each declared by the crewmate that did the work at one of
 * three levels with one line why. The app draws it as a radar at the card's top right, one
 * dot per dimension in its level's color. There is no overall level: the
 * shape and the dots are the reading, and nothing sums them up.
 */

/**
 * What each dimension is called and what each of its levels means, in the
 * words the card's notes show and the crewmate's tool description names.
 */
export const RISK_WORDS: Readonly<
  Record<RiskDimension, { label: string; ask: string; levels: Readonly<Record<RiskLevel, string>> }>
> = {
  blast: {
    ask: "how much of the project it touches",
    label: "Blast radius",
    levels: {
      low: "narrow: one area",
      medium: "some: a few areas",
      high: "wide: shared code or many areas",
    },
  },
  behavior: {
    ask: "what changes for a person",
    label: "Behavior",
    levels: {
      low: "nothing, or a defect corrected",
      medium: "adds something a person opts into",
      high: "changes what happens by default",
    },
  },
  undo: {
    ask: "how hard it is to take back",
    label: "Undo",
    levels: {
      low: "revert and done",
      medium: "needs a step: saved data or settings moved",
      high: "hard: data rewritten, released or sent outside",
    },
  },
  evidence: {
    ask: "how well it was shown to work",
    label: "Evidence",
    levels: {
      low: "shown working end to end",
      medium: "tests only",
      high: "not shown",
    },
  },
  sensitivity: {
    ask: "which sensitive areas it touches",
    label: "Sensitivity",
    levels: {
      low: "none",
      medium: "saved data or settings",
      high: "sign-ins, keys, payments or a release",
    },
  },
  novelty: {
    ask: "how new the code is",
    label: "Novelty",
    levels: {
      low: "edits well-trodden code",
      medium: "new code beside existing",
      high: "a new subsystem",
    },
  },
  deps: {
    ask: "what it brings in",
    label: "Dependencies",
    levels: {
      low: "none",
      medium: "updates a package",
      high: "adds a package",
    },
  },
};

/** A level's place on the scale, 1 to 3: how far out its dot sits. */
export function riskStep(level: RiskLevel): 1 | 2 | 3 {
  return (RISK_LEVELS.indexOf(level) + 1) as 1 | 2 | 3;
}

/** A level's color, in the checks' language: calm cyan, ember, lava. */
export function riskTone(level: RiskLevel): "ok" | "warn" | "danger" {
  return level === "low" ? "ok" : level === "medium" ? "warn" : "danger";
}
