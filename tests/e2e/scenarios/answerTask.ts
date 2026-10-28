import { CREWMATE_ANSWER_ASK } from "../../../src/core/orchestrator/answerDelivery";
import { CARD_CLOSED_STEER_NEEDLE, type Scenario } from "../mockProvider";

/**
 * The deliverable axis (crew-posture rationalization Task B). A Firstmate
 * turn carrying "find out and answer:" spawns an investigation with the
 * typed `read-only` constraint, so the host derives `deliverable: answer`
 * from a fact rather than from the classifier's mood; the crewmate that
 * receives that brief lands ONE decision card carrying the answer and
 * reports. It emits no completion card and never commits: the brief told
 * it so, and the host refuses either way.
 */
export const ANSWER_TASK_PROMPT_MARKER = "find out and answer:";
export const MOCK_ANSWER_CARD_TITLE = "The meter idles because the claim query filters on repo_id";
export const MOCK_ANSWER_ACTION_LABEL = "Fix the claim query";
const MOCK_ANSWER_CARD_BODY =
  "<p>The meter idles because the claim query filters on repo_id, and seven rows carry none.</p>" +
  "<p>Every idle row shares an empty repo_id; the sweep skips each one, so nothing is ever claimed.</p>" +
  "<details><summary>Evidence</summary><p>src/core/tasks/taskStore.ts listReady, line 211.</p></details>";
export const MOCK_ANSWER_REPORT =
  "The claim query filters on repo_id and seven idle rows carry none; the card shows where.";
/**
 * The captain's close reaches its crewmate (FI3-435). The answer-task
 * crewmate steered with the close of its card judges it read and finished
 * and reports so with `finished: true`; the mock Firstmate, woken by a
 * report that declared its work finished, closes the task the way its
 * instructions say - `settle_task answered` on an answer, in the shared
 * stand-in.
 */
export const MOCK_ANSWER_FINISHED_REPORT =
  "The captain read the answer on the card, and nothing is left for me to do.";
/**
 * A decision the captain closed without a choice does not answer their
 * message (INF-1610 piece 2), so the finished report is refused once; the
 * crewmate says why it has no more to show, and its report stands.
 */
export const MOCK_ANSWER_FINISHED_AGAIN =
  "My card held the whole answer and the captain closed it after reading; I have nothing more to show.";

/** The first mate spawns the investigation; its crewmate answers on one card, and finishes once it is closed. */
export const answerTask: Scenario = () => {
  let saidWhy = false;
  return ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!wantsStream) return undefined;
    if (isFirstmate) {
      if (hasToolResults || !latestUserTail.includes(ANSWER_TASK_PROMPT_MARKER)) return undefined;
      const title =
        latestUserTail.match(/find out and answer: ([^"\\]+)/)?.[1]?.trim() ?? "Mock investigation";
      return {
        calls: [
          {
            name: "spawn_crewmate",
            args: {
              title,
              goal: `Find out ${title} and answer it.`,
              user_words: `${ANSWER_TASK_PROMPT_MARKER} ${title}`,
              constraints: [{ kind: "read-only" }],
            },
          },
        ],
      };
    }
    // The crewmate told the captain closed its card: it judges the answer
    // read and finished (FI3-435).
    if (
      body.includes(ANSWER_TASK_PROMPT_MARKER) &&
      latestUserTail.includes(CARD_CLOSED_STEER_NEEDLE)
    ) {
      if (hasToolResults && body.includes(CREWMATE_ANSWER_ASK) && !saidWhy) {
        saidWhy = true;
        return {
          calls: [{ name: "report", args: { text: MOCK_ANSWER_FINISHED_AGAIN, finished: true } }],
        };
      }
      if (hasToolResults) return { text: "done" };
      return {
        calls: [{ name: "report", args: { text: MOCK_ANSWER_FINISHED_REPORT, finished: true } }],
      };
    }
    // One decision card carrying the answer, and a report. No completion
    // card, nothing committed.
    if (latestUserTail.includes(ANSWER_TASK_PROMPT_MARKER)) {
      if (hasToolResults) return { text: "done" };
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: MOCK_ANSWER_CARD_TITLE,
              body: MOCK_ANSWER_CARD_BODY,
              actions: [
                { id: "fix-it", label: MOCK_ANSWER_ACTION_LABEL, default: true },
                { id: "leave-it", label: "Leave it for now" },
              ],
            },
          },
          { name: "report", args: { text: MOCK_ANSWER_REPORT } },
        ],
      };
    }
    return undefined;
  };
};
