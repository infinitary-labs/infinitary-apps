import type { CheckDiagnosis, CheckRepairLedger } from "@shared/checkRepair";
import { escapeCardText } from "./cardText";

/** The crewmate's judgment, never a host inference from logs or report prose. */
export const CHECK_VERDICT_WORDS: Record<CheckDiagnosis["classification"], string> = {
  "own-regression": "Caused by this change",
  "baseline-blocked": "Broken on main too",
  "suspected-flake": "Suspected intermittent failure",
  unknown: "Cause not established",
};
export const CHECK_VERDICT_MISSING = "Not diagnosed yet";

/** Only failures at the offered version belong on its merge card (nightly audit finding 3). */
export function checkVerdicts(delivery: {
  ci?: string;
  headSha?: string;
  ciRepair?: CheckRepairLedger;
}): string {
  const { ci, headSha, ciRepair } = delivery;
  if (ci !== "red" || !headSha || !ciRepair) return "";
  const failed = ciRepair.failures.find((reading) => reading.headSha === headSha)?.checks ?? [];
  return failed
    .map((check) => {
      const diagnosis = ciRepair.diagnoses.findLast(
        (d) => d.headSha === headSha && d.check === check,
      );
      const name = `<span class="inf-mono">${escapeCardText(check)}</span>`;
      const verdict = diagnosis
        ? CHECK_VERDICT_WORDS[diagnosis.classification]
        : CHECK_VERDICT_MISSING;
      const summary = `${name} <span>· ${verdict}</span>`;
      if (!diagnosis) return `<p class="inf-check-verdict" data-check-verdict>${summary}</p>`;
      // A stable disclosure identity keeps the captain's open evidence through
      // live age refreshes, but not when its version or diagnosis changes.
      const identity = escapeCardText(JSON.stringify([headSha, check, diagnosis]));
      return `<details class="inf-check-verdict" data-check-verdict data-inf-disclosure="${identity}"><summary>${summary}</summary><p class="inf-check-evidence">${escapeCardText(diagnosis.evidence)}</p></details>`;
    })
    .join("");
}
