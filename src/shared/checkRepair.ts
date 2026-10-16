/** Agent-declared diagnosis; the host never infers ownership from report prose. */
export type CheckDiagnosis = {
  headSha: string;
  check: string;
  classification: "own-regression" | "baseline-blocked" | "suspected-flake" | "unknown";
  /** Logs and reproduction/comparison evidence, not merely a wait instruction. */
  evidence: string;
  dependencyTask?: string;
};

export type CheckRepair = {
  id: string;
  sourceHead: string;
  headSha: string;
  check: string;
  evidence: string;
};

export type CheckRerun = {
  headSha: string;
  check: string;
  evidence: string;
  /** Set by the host when the gateway sent the rerun: the one reservation is spent. */
  startedAt?: number;
};

/**
 * How a crewmate judges what bringing its approved change up to date did
 * (FI3-304, guard = builder): `conflict-only` keeps the captain's merge
 * approval, `changed-work` ends it, `unknown` holds it until an independent
 * assessment decides (FI3-663).
 */
export const MERGE_REPAIR_IMPACTS = ["conflict-only", "changed-work", "unknown"] as const;
export type MergeRepairImpact = (typeof MERGE_REPAIR_IMPACTS)[number];

/**
 * How the host establishes an independent repair assessment's kind
 * (`kind_source`, FI3-663): a review-kind read of one repair of an approved
 * change, never a review of the change itself.
 */
export const REPAIR_ASSESSMENT_SOURCE = "host:repair-assessment";

/** Whether a task's shape is an independent repair assessment rather than a code review. */
export function isRepairAssessment(
  shape: { kind?: string; kind_source?: string } | null | undefined,
): boolean {
  return shape?.kind === "review" && shape.kind_source === REPAIR_ASSESSMENT_SOURCE;
}

/**
 * A repair of an approved change, declared at its new head: the transition,
 * the newer work it took in, the crewmate's judgment and its evidence. The
 * host checks the closed facts (lineage, ancestry, the paths it touches);
 * the judgment of semantic equivalence is the crewmate's.
 */
export type MergeRepairDeclaration = {
  /** The head the repair started from: the approved head or the last accepted repair. */
  fromHead: string;
  /** The pushed head after the repair. */
  toHead: string;
  /** The default branch's commit the change was brought up to date with. */
  newBase: string;
  impact: MergeRepairImpact;
  /** Paths the repair changed beyond the approved change, or that it no longer touches. */
  changedPaths: string[];
  /** How the approved behavior was compared with the repaired change. */
  evidence: string;
  /** The validation run at toHead. */
  validation: string;
};

/**
 * How a crewmate judges the captain's newer words while his kept merge
 * approval stands (FI3-662): `none` leaves the approved work as it was, so
 * the merge goes on; `changed-work` ends the approval.
 */
export const MERGE_GUIDANCE_IMPACTS = ["none", "changed-work"] as const;
export type MergeGuidanceImpact = (typeof MERGE_GUIDANCE_IMPACTS)[number];

/**
 * The crewmate's declaration about the captain's guidance that holds a kept
 * merge: the newest mark it read (the host numbers each guidance on the
 * message it steers), its judgment, and why. Marks it never read stay held.
 */
export type MergeGuidanceDeclaration = {
  mark: number;
  impact: MergeGuidanceImpact;
  evidence: string;
};

/** Optional declarations on the existing check_change seam, shared by both seats. */
export type CheckChangeInput = {
  diagnosis?: CheckDiagnosis;
  repair?: CheckRepair;
  /** Reserve the task's one flake rerun BEFORE rerunning the failed job. */
  rerun?: CheckRerun;
  /** A repair of a change the captain already approved to merge (FI3-304). */
  conflictRepair?: MergeRepairDeclaration;
  /** What the captain's newer words do to the change his kept approval covers (FI3-662). */
  captainGuidance?: MergeGuidanceDeclaration;
  /**
   * Prepare a merge review of this pull request in the task's project
   * (FI3-1543). The answer's review id is what `request_merge` references.
   * Preparing it grants no approval and merges nothing.
   */
  pull?: number;
  /**
   * This exact head intentionally has no checks. The host stores it on the
   * review; an empty or unreadable check list alone never qualifies.
   */
  absentChecks?: { headSha: string; evidence: string; localGate: string };
  /**
   * Prepare `pull` as a merge past the branch rules (FI3-1571 piece 2): the
   * version the crewmate read and the method. GitHub only; only the
   * captain's click on its card sends it.
   */
  skipRules?: { headSha: string; method: "squash" };
};

/** Persisted independently of raw check observations and the captain's round hold. */
export type CheckRepairLedger = {
  /** Pre-upgrade failed-version counts are history, not declared repair attempts. */
  legacyFailedVersions?: number;
  failures: { headSha: string; checks: string[] }[];
  /** `at`: when the host recorded it (absent on rows from before FI3-250). */
  diagnoses: (CheckDiagnosis & { at?: number })[];
  repairs: (CheckRepair & { outcome?: "passed" | "failed" })[];
  rerun?: CheckRerun;
};
