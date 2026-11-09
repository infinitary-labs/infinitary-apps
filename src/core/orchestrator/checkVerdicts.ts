import type { CheckDiagnosis, CheckRepairLedger } from "@shared/checkRepair";
import {
  type CheckSnapshot,
  checksFailingOnMain,
  type MainCheckEvidence,
} from "@shared/checkSnapshot";
import { checksFinishedAgo } from "@shared/checksSpan";
import { QUEUE_STATUS } from "@shared/repos";
import { escapeCardText } from "./cardText";

/** The crewmate's judgment, never a host inference from logs or report prose. */
export const CHECK_VERDICT_WORDS: Record<CheckDiagnosis["classification"], string> = {
  "own-regression": "Caused by this change",
  "baseline-blocked": "Broken on main too",
  "suspected-flake": "Suspected intermittent failure",
  unknown: "Cause not established",
};
export const CHECK_VERDICT_MISSING = "Not diagnosed yet";
/**
 * The host's own fact for a check the crewmate has not diagnosed (INF-1915
 * fix 1): the default branch's newest run of it failed too, read from the
 * recorded evidence, never a judgment about the cause.
 */
export const CHECK_FAILS_ON_MAIN_WORDS = "Fails on main too";

/**
 * The sentence under a check that fails on the default branch too: what
 * failed and why it is outside the change, in the open, so the captain
 * decides on that card without opening anything or asking (INF-1891, the
 * captain: "make it very clear to the user what the failure is, and why it
 * is outside of the change").
 */
export function failsOnMainSentence(main: { sha: string; at: number }, now: number): string {
  return `Main's newest run of this check failed too, at ${main.sha.slice(0, 7)}, read ${checksFinishedAgo(main.at, now)}, so the failure is outside this change; the app watches main's run of it.`;
}

/**
 * Only failures at the offered version belong on its merge card (nightly
 * audit finding 3), and only the pull request's own checks: the crewmate's
 * diagnosis applies to them, while the project's queue status says the
 * queue's own words in the strip's Batch check cell (INF-3208).
 */
export function checkVerdicts(
  delivery: {
    ci?: string;
    headSha?: string;
    ciRepair?: CheckRepairLedger;
    checks?: CheckSnapshot;
    mainChecks?: MainCheckEvidence & { head: string };
  },
  now: number,
): string {
  const { ci, headSha, ciRepair, mainChecks } = delivery;
  if (ci !== "red" || !headSha || !ciRepair) return "";
  const failed = (
    ciRepair.failures.find((reading) => reading.headSha === headSha)?.checks ?? []
  ).filter((check) => check !== QUEUE_STATUS);
  const onMain = new Set(checksFailingOnMain(delivery));
  return failed
    .map((check) => {
      const diagnosis = ciRepair.diagnoses.findLast(
        (d) => d.headSha === headSha && d.check === check,
      );
      const main = onMain.has(check) ? mainChecks : undefined;
      const name = `<span class="inf-mono">${escapeCardText(check)}</span>`;
      const verdict = diagnosis
        ? CHECK_VERDICT_WORDS[diagnosis.classification]
        : main
          ? CHECK_FAILS_ON_MAIN_WORDS
          : CHECK_VERDICT_MISSING;
      const summary = `${name} <span>· ${verdict}</span>`;
      // The host's fact stays in the open under the check, whatever the
      // crewmate's verdict says, so the two never hide each other.
      const fact = main
        ? `<p class="inf-check-outside" data-check-outside="${escapeCardText(check)}">${escapeCardText(failsOnMainSentence(main, now))}</p>`
        : "";
      if (!diagnosis)
        return `<p class="inf-check-verdict" data-check-verdict>${summary}</p>${fact}`;
      // A stable disclosure identity keeps the captain's open evidence through
      // live age refreshes, but not when its version or diagnosis changes.
      const identity = escapeCardText(JSON.stringify([headSha, check, diagnosis]));
      return `<details class="inf-check-verdict" data-check-verdict data-inf-disclosure="${identity}"><summary>${summary}</summary><p class="inf-check-evidence">${escapeCardText(diagnosis.evidence)}</p></details>${fact}`;
    })
    .join("");
}
