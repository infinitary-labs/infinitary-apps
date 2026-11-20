import type { ChangePresentation } from "./changePresentation";
import { LIVE_VALIDATION_WORDS, type LiveValidation } from "./liveValidation";
import { type LiveValidationSummary, liveValidationSummary } from "./liveValidationSummary";

/** Public words belong to the author; result, order, evidence and counts belong to the record. */
export function presentationValidation(
  state: LiveValidation | undefined,
  head: string,
  rows: ChangePresentation["validationRows"],
): LiveValidationSummary | undefined {
  const summary = liveValidationSummary(state, head, false);
  if (!summary) {
    if (rows?.length) throw new Error("Public validation rows need a live validation record.");
    return undefined;
  }
  if (!rows && summary.rows.length === 0) rows = [];
  const ids = new Set(rows?.map((row) => row.id));
  if (
    !rows ||
    rows.length !== summary.rows.length ||
    ids.size !== rows.length ||
    summary.rows.some((row) => !ids.has(row.id))
  )
    throw new Error(
      "Give one public validation row for every recorded scenario, with no missing, repeated or unknown ids.",
    );
  if (
    [LIVE_VALIDATION_WORDS.noSurface, LIVE_VALIDATION_WORDS.awaiting].some(
      (label) => label === summary.label,
    )
  )
    return { ...summary, rows: [] };
  return {
    ...summary,
    rows: summary.rows.map((row) => {
      const publicRow = rows.find((item) => item.id === row.id)!;
      return {
        ...row,
        // Kept files stay with their validation owner, never in the public story.
        evidence: [],
        action: publicRow.scenario,
        reason:
          row.result === "Accepted without live proof"
            ? `Accepted without live proof. ${publicRow.evidence}`
            : publicRow.evidence,
      };
    }),
  };
}
