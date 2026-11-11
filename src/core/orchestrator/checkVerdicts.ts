import { type CheckDiagnosis, type CheckRepairLedger, failingRun } from "@shared/checkRepair";
import {
  type CheckSnapshot,
  checksFailingOnMain,
  isRedCheckState,
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
 * Whether a check recorded failed at `headSha` still fails there, by the
 * newest reading of it (the captain's answer on INF-3709's plan: an earlier
 * failure the newest reading no longer shows is left out). The pull
 * request's reading of that version shows it red, or a requested run's
 * newest attempt still lists it failed. A reading that is missing, or could
 * not list every check, cannot say a check stopped failing, so the check
 * stays.
 */
function stillFails(
  delivery: { headSha?: string; ciRepair?: CheckRepairLedger; checks?: CheckSnapshot },
  headSha: string,
  check: string,
): boolean {
  const reading = delivery.checks?.headSha === headSha ? delivery.checks : undefined;
  if (!reading) return true;
  if (reading.items.some((item) => item.name === check && isRedCheckState(item.state))) return true;
  if (failingRun(delivery, { headSha, check })) return true;
  if (reading.items.some((item) => item.name === check)) return false;
  return reading.complete === false || Boolean(reading.problem);
}

/**
 * The rows under a merge card's status line, one per failed check: the
 * crewmate's verdict first, then the check's name in mono on the same line,
 * cut by an ellipsis where it runs long; a diagnosed row opens to the whole
 * name and the evidence. Only failures at the offered version belong on its
 * merge card (nightly audit finding 3), only while the newest reading still
 * shows them failing (`stillFails`), and only the pull request's own checks:
 * the crewmate's diagnosis applies to them, while the project's queue status
 * says the queue's own words under the Batch check state (INF-3208).
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
  ).filter((check) => check !== QUEUE_STATUS && stillFails(delivery, headSha, check));
  const onMain = new Set(checksFailingOnMain(delivery));
  return failed
    .map((check) => {
      const diagnosis = ciRepair.diagnoses.findLast(
        (d) => d.headSha === headSha && d.check === check,
      );
      const main = onMain.has(check) ? mainChecks : undefined;
      const verdict = diagnosis
        ? CHECK_VERDICT_WORDS[diagnosis.classification]
        : main
          ? CHECK_FAILS_ON_MAIN_WORDS
          : CHECK_VERDICT_MISSING;
      const summary = `<span class="inf-check-v">${verdict}</span> <span class="inf-mono inf-check-name">${escapeCardText(check)}</span>`;
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
