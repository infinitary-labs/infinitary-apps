import { RISK_LEVELS, type RiskDimension, type RiskLevel } from "./cards";
import * as m from "./i18n/messages.generated.ts";

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

/**
 * Each dimension's name and what each level means as a person reads them on the card, in the process's language.
 * `RISK_WORDS` keeps the English the crew's guidance and a pull request's story read.
 */
export const RISK_LABELS: Readonly<
  Record<RiskDimension, { label: string; levels: Readonly<Record<RiskLevel, string>> }>
> = {
  blast: {
    get label() {
      return m.riskBlast();
    },
    levels: {
      get low() {
        return m.riskBlastLow();
      },
      get medium() {
        return m.riskBlastMedium();
      },
      get high() {
        return m.riskBlastHigh();
      },
    },
  },
  behavior: {
    get label() {
      return m.riskBehavior();
    },
    levels: {
      get low() {
        return m.riskBehaviorLow();
      },
      get medium() {
        return m.riskBehaviorMedium();
      },
      get high() {
        return m.riskBehaviorHigh();
      },
    },
  },
  undo: {
    get label() {
      return m.riskUndo();
    },
    levels: {
      get low() {
        return m.riskUndoLow();
      },
      get medium() {
        return m.riskUndoMedium();
      },
      get high() {
        return m.riskUndoHigh();
      },
    },
  },
  evidence: {
    get label() {
      return m.riskEvidence();
    },
    levels: {
      get low() {
        return m.riskEvidenceLow();
      },
      get medium() {
        return m.riskEvidenceMedium();
      },
      get high() {
        return m.riskEvidenceHigh();
      },
    },
  },
  sensitivity: {
    get label() {
      return m.riskSensitivity();
    },
    levels: {
      get low() {
        return m.riskSensitivityLow();
      },
      get medium() {
        return m.riskSensitivityMedium();
      },
      get high() {
        return m.riskSensitivityHigh();
      },
    },
  },
  novelty: {
    get label() {
      return m.riskNovelty();
    },
    levels: {
      get low() {
        return m.riskNoveltyLow();
      },
      get medium() {
        return m.riskNoveltyMedium();
      },
      get high() {
        return m.riskNoveltyHigh();
      },
    },
  },
  deps: {
    get label() {
      return m.riskDeps();
    },
    levels: {
      get low() {
        return m.riskDepsLow();
      },
      get medium() {
        return m.riskDepsMedium();
      },
      get high() {
        return m.riskDepsHigh();
      },
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
