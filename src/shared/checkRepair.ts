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
  /**
   * Set by the host when the reservation is for a workflow run's failed job
   * rather than the pull request's current version (INF-688): only a rerun
   * of this run dates it.
   */
  runId?: number;
  /** Set by the host when the gateway sent the rerun: the one reservation is spent. */
  startedAt?: number;
};

/**
 * A workflow run as the crewmate's short read or the run watch last read it
 * (INF-688): its version, the attempt read, and that attempt's failed job
 * names. A job named here is an observed failing head/check with or without
 * a pull request, and stays current until a newer reading of the run stops
 * listing it.
 */
export type ObservedRun = {
  runId: number;
  headSha: string;
  attempt: number;
  failed: string[];
};

/**
 * How a crewmate judges what a repair of its approved change did to that
 * work (FI3-304, guard = builder; INF-493): `none` leaves it as approved and
 * keeps the captain's merge approval, whatever the repair was; `changed-work`
 * ends it; `unknown` holds it until an independent assessment decides
 * (FI3-663). The impact is the crewmate's to declare and the host records
 * it; the host never sorts the repair into a kind.
 */
export const MERGE_REPAIR_IMPACTS = ["none", "changed-work", "unknown"] as const;
export type MergeRepairImpact = (typeof MERGE_REPAIR_IMPACTS)[number];

/**
 * `none`'s name before INF-493, which still means it wherever it arrives:
 * the work request a computer sends its home carries it, so the published
 * contract keeps its shape and two builds understand each other, and an
 * older crewmate's tools, an assessment asked before then or a saved repair
 * may still say it.
 */
export const LEGACY_NO_IMPACT = "conflict-only";

/** The impact a declaration or an assessment names, `none`'s older name read as `none`. */
export function repairImpact(value: unknown): MergeRepairImpact | undefined {
  if (value === LEGACY_NO_IMPACT) return "none";
  return MERGE_REPAIR_IMPACTS.find((impact) => impact === value);
}

/** An impact as the work request to the home carries it: `none` by its older name. */
export function wireRepairImpact(
  impact: MergeRepairDeclaration["impact"],
): Exclude<MergeRepairDeclaration["impact"], "none"> {
  return impact === "none" ? LEGACY_NO_IMPACT : impact;
}

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
 * the base it sits on, the crewmate's judgment of its impact and its
 * evidence. Any new head is a repair - bringing the change up to date, a
 * reworded commit, a fix for what refused the merge. The host checks the
 * closed facts (lineage, ancestry, the paths it touches); the judgment of
 * semantic equivalence is the crewmate's.
 */
export type MergeRepairDeclaration = {
  /** The head the repair started from: the approved head or the last accepted repair. */
  fromHead: string;
  /** The pushed head after the repair. */
  toHead: string;
  /** The default branch's commit the repaired change sits on: newer work it took in, or the base it already had. */
  newBase: string;
  /** Saved repairs and older senders may name `none` as `conflict-only` (`LEGACY_NO_IMPACT`). */
  impact: MergeRepairImpact | typeof LEGACY_NO_IMPACT;
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

/**
 * The workflow run whose newest reading still lists `check` failed at
 * `headSha` (INF-688): the one whose reading changed last when several do.
 * A run counts only at the change's current version, or while the task has
 * no pull request version at all, so a new version ends what an older run
 * showed, as it does for a pull request's checks.
 */
export function failingRun(
  delivery: { headSha?: string; ciRepair?: CheckRepairLedger } | null | undefined,
  failed: { headSha: string; check: string },
): ObservedRun | undefined {
  if (delivery?.headSha !== undefined && delivery.headSha !== failed.headSha) return undefined;
  return delivery?.ciRepair?.runs?.findLast(
    (run) => run.headSha === failed.headSha && run.failed.includes(failed.check),
  );
}

/** Persisted independently of raw check observations and the captain's round hold. */
export type CheckRepairLedger = {
  /** Pre-upgrade failed-version counts are history, not declared repair attempts. */
  legacyFailedVersions?: number;
  failures: { headSha: string; checks: string[] }[];
  /** Workflow runs read with failed jobs, newest change last; absent before INF-688. */
  runs?: ObservedRun[];
  /** `at`: when the host recorded it (absent on rows from before FI3-250). */
  diagnoses: (CheckDiagnosis & { at?: number })[];
  /**
   * `superseded`: the change moved past the attempt's version before the host
   * ran any check there, so it can never have a result and spends nothing (INF-988).
   */
  repairs: (CheckRepair & { outcome?: "passed" | "failed" | "superseded" })[];
  rerun?: CheckRerun;
};
