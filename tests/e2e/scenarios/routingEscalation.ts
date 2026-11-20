import { type Scenario, settleNeedle } from "../mockProvider";
import { findCrewTaskId } from "../providerRequest";

/**
 * Escalation (intelligence-bucket routing S4). "not good enough, escalate
 * the task <title>" is the captain turn Q2 requires: the mock Firstmate
 * spawns again with `escalate_from` naming that task. The blocked-report
 * pair is the other half - a crewmate briefed with "report that you are
 * blocked" ends its turn with a report that says so, and the whose-turn
 * rule hands it to the Firstmate as an [fm-op] because the crewmate has
 * stopped; the mock Firstmate then tries the same `escalate_from` off that
 * wake, which the tool boundary must refuse.
 */
export const ESCALATE_PROMPT_MARKER = "not good enough, escalate the task ";

export const BLOCKED_REPORT_PROMPT_MARKER = "report that you are blocked";

export const MOCK_BLOCKED_REPORT =
  "I cannot get the meter to reset, so I am blocked; escalate this to the captain.";

const BLOCKED_REPORT_NEEDLE = "I cannot get the meter to reset";

/**
 * The captain's rejection in words becomes a spawn with escalate_from, and a
 * crewmate that reports itself blocked has the first mate file the triage.
 */
export const routingEscalation: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate && wantsStream) {
      if (!hasToolResults && latestUserTail.includes(ESCALATE_PROMPT_MARKER)) {
        // The captain rejected a result in words: a regular spawn with
        // escalate_from, never a new tool (the captain's second-pass call).
        const needle = settleNeedle(latestUserTail, ESCALATE_PROMPT_MARKER);
        const taskId =
          findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
        return {
          calls: [
            {
              name: "spawn_crewmate",
              args: {
                title: needle,
                goal: `Complete the task "${needle}" properly this time.`,
                user_words: `${ESCALATE_PROMPT_MARKER}${needle}`,
                shape: { escalate_from: taskId },
              },
            },
          ],
        };
      }
    }
    if (isFirstmate && wantsStream) {
      if (!hasToolResults && latestUserTail.includes(BLOCKED_REPORT_NEEDLE)) {
        // The wrong trigger on purpose: a crewmate's own "I am blocked",
        // reaching the Firstmate as an [fm-op] because the whose-turn
        // rule found it stopped. The tool boundary refuses it.
        const taskId =
          findCrewTaskId(body, BLOCKED_REPORT_PROMPT_MARKER) ??
          latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ??
          latestUserTail.match(/\(task ([\w-]+)\)/)?.[1] ??
          "missing";
        return {
          calls: [
            {
              name: "spawn_crewmate",
              args: {
                title: "Stronger meter attempt",
                goal: "The meter resets.",
                user_words: MOCK_BLOCKED_REPORT,
                shape: { escalate_from: taskId },
              },
            },
          ],
        };
      }
    }
    // A crewmate that reports it is blocked (S4, O2): its own account of
    // itself is never an escalation trigger, so the report carries the
    // triage marker and reaches the Firstmate as an [fm-op].
    if (
      !isFirstmate &&
      latestUserTail.includes(BLOCKED_REPORT_PROMPT_MARKER) &&
      !hasToolResults &&
      wantsStream
    ) {
      return { text: MOCK_BLOCKED_REPORT };
    }
    return undefined;
  };
