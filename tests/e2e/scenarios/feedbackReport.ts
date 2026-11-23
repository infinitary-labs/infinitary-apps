import { WRITE_ANSWERED_LEAD } from "../../../src/core/orchestrator/deliveryWakes";
import { FEEDBACK_REQUEST_NOTE } from "../../../src/core/orchestrator/wakes";
import { FEEDBACK_COMMAND, FEEDBACK_WORD } from "../../../src/shared/feedback";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario, ScenarioAnswer } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

/**
 * A /feedback report from the message box to the captain's click
 * (docs/feedback.md). Hermetic replay of the host's part, not a claim that
 * a live model follows the Feedback runbook: the stand-in first mate starts
 * a crewmate for the feedback request it was served, and the stand-in
 * crewmate drafts the report with the feedback command and puts the kept
 * write on its card beside its own Not now.
 */
export const FEEDBACK_PROBLEM = "the merge card kept showing checks that had already finished";
export const FEEDBACK_TYPED = `${FEEDBACK_WORD} ${FEEDBACK_PROBLEM}`;
export const FEEDBACK_TASK_TITLE = "Report the merge card's stale checks";
export const FEEDBACK_CARD_TITLE = "Publish this problem report?";
export const FEEDBACK_ISSUE_TITLE = "Merge card keeps showing checks that already finished";
/** The words the crewmate writes; the host adds the diagnostics and the mark beneath them. */
export const FEEDBACK_WORDS = [
  "## What happened",
  "",
  "The merge card kept showing its checks as running after every check had finished.",
  "",
  "## What I expected",
  "",
  "The card shows the checks as passed once they finish.",
].join("\n");
const GOAL = "Draft a problem report for Infinitary's maker and ask the captain before it goes.";
const BODY_FILE = "feedback-report.md";

const call = (scripted: ScriptedCall): ScenarioAnswer => ({ calls: [scripted] });

export const feedbackReport: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (!wantsStream) return undefined;
    const { user, results } = sinceLastUser(body);
    if (isFirstmate) {
      if (!user.includes(FEEDBACK_REQUEST_NOTE) || !user.includes(FEEDBACK_PROBLEM))
        return undefined;
      if (results.length === 0)
        return call({
          name: "spawn_crewmate",
          args: {
            title: FEEDBACK_TASK_TITLE,
            goal: GOAL,
            user_words: FEEDBACK_TYPED,
            shape: { rigor_ask: "quick" },
          },
        });
      return { text: "A crewmate is drafting the report for your review." };
    }
    if (!body.includes(GOAL)) return undefined;
    if (latestUserTail.includes(WRITE_ANSWERED_LEAD)) {
      if (results.length === 0)
        return call({
          name: "report",
          args: {
            text: "The captain published the report.",
            summary: "The captain published the problem report.",
          },
        });
      return { text: "Published." };
    }
    if (results.length === 0)
      return call({
        name: "bash",
        args: {
          command: `cat > ${BODY_FILE} <<'REPORT'\n${FEEDBACK_WORDS}\nREPORT\n${FEEDBACK_COMMAND} draft --kind bug --title "${FEEDBACK_ISSUE_TITLE}" --body-file ${BODY_FILE}`,
        },
      });
    const ask = results[0]?.match(/ask: (wa[0-9a-f]+)/)?.[1];
    if (results.length === 1 && ask)
      return call({
        name: "emit_card",
        args: {
          id: "feedback-review",
          title: FEEDBACK_CARD_TITLE,
          body: "<p>This is the report as it would appear on Infinitary's public project.</p>",
          actions: [
            { id: "publish", effect: { kind: "request_write", ask } },
            { id: "not-now", label: "Not now", declines: true },
          ],
        },
      });
    if (results.length <= 2)
      return call({
        name: "report",
        args: {
          text: results.join("\n"),
          summary: "The report waits on the captain's review.",
        },
      });
    return { text: "The report is waiting on the captain." };
  };
