import { CREWMATE_ANSWER_ASK } from "../../../src/core/orchestrator/answerDelivery";
import type { Scenario } from "../mockProvider";
import { providerMessages } from "../providerRequest";

/**
 * The deliverable axis (crew-posture rationalization Task B). A Firstmate
 * turn carrying "find out and answer:" spawns an investigation with the
 * typed `read-only` constraint, so the host derives `deliverable: answer`
 * from a fact rather than from the classifier's mood; the crewmate that
 * receives that brief lands ONE decision card carrying the answer and
 * reports. It emits no completion card and never commits: the brief told
 * it so, and the host refuses either way.
 */
export const ANSWER_READ_MARKER = "I read the answer; finish without starting a build.";
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
 * INF-1879: the captain explicitly asks the answer's author to finish without a build.
 * The author answers the thread, withdraws the obsolete decision and reports finished.
 * The first mate hears that report and closes the answer through settle_task answered.
 */
export const MOCK_ANSWER_FINISHED_REPORT =
  "The captain read the answer on the card, and nothing is left for me to do.";
/**
 * With no marked answer card, the answer-delivery boundary refuses the finished report once
 * (INF-1610 piece 2); the author explains the explicit finish request, and its report stands.
 */
export const MOCK_ANSWER_FINISHED_AGAIN =
  "My card held the whole answer and the captain explicitly asked me to finish without a build; I have nothing more to show.";

/** The investigation answers on one card and finishes only on the captain's explicit words. */
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
    // A serialized transport tail escapes quotation marks; read the actual reply through its owner.
    if (body.includes(ANSWER_TASK_PROMPT_MARKER) && latestUserTail.includes(ANSWER_READ_MARKER)) {
      const reply =
        providerMessages(body).findLast((message) => message.role === "user")?.text ?? "";
      const cardId = reply.match(/\((card-[\w-]+)\)/)?.[1] ?? "missing";
      if (hasToolResults && body.includes(CREWMATE_ANSWER_ASK) && !saidWhy) {
        saidWhy = true;
        return {
          calls: [{ name: "report", args: { text: MOCK_ANSWER_FINISHED_AGAIN, finished: true } }],
        };
      }
      if (hasToolResults) return { text: "done" };
      return {
        calls: [
          {
            name: "reply",
            args: {
              card_id: cardId,
              text: "The answer is complete; I will not start a build.",
            },
          },
          {
            name: "close_card",
            args: {
              card_id: cardId,
              reason: "The captain explicitly finished without a build.",
            },
          },
          { name: "report", args: { text: MOCK_ANSWER_FINISHED_REPORT, finished: true } },
        ],
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
