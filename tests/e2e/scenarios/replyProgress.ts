import { answering, calledTool, type Scenario } from "../mockProvider";

/**
 * A crewmate working on a captain reply that takes a while (INF-990
 * friction 3, tests/e2e/reply-progress.spec.ts): its card goes up, and a
 * reply asking for a code change gets a one-line interim answer, a command
 * with its own description, and then the model taking its time the way a
 * long piece of work keeps going, before the crewmate gives its real answer
 * and reports.
 */
export const REPLY_PROGRESS_PROMPT_MARKER = "keep working on my reply";
export const REPLY_PROGRESS_CARD_TITLE = "The review step is ready to rename";
/** The captain's words under that card: a code change that takes a while. */
export const REPLY_PROGRESS_REPLY = "rename review to audit and run the evaluations again";
/** The crewmate's one-line interim answer, posted before the long work. */
export const REPLY_PROGRESS_INTERIM =
  "Renaming review to audit now; the evaluations take about twenty minutes after that.";
/** The description the crewmate gives the command it runs on the reply. */
export const REPLY_PROGRESS_DOING = "Rename review to audit across the app";
/** The crewmate's real answer once the work is done. */
export const REPLY_PROGRESS_ANSWER = "Renamed review to audit; the evaluations pass again.";

/** How long the stand-in takes over the work before it answers. */
const REPLY_PROGRESS_WORK_MS = 15_000;

export const replyProgress: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream || !body.includes(REPLY_PROGRESS_PROMPT_MARKER)) {
      return undefined;
    }
    const shownCardId = body.match(/Card shown: [^(]*\((card-[\w-]+)\)/)?.[1] ?? "";
    if (latestUserTail.includes(REPLY_PROGRESS_REPLY)) {
      if (!calledTool(latestUserTail, "reply")) {
        return {
          calls: [
            {
              name: "reply",
              args: { card_id: shownCardId, text: REPLY_PROGRESS_INTERIM, interim: true },
            },
            { name: "bash", args: { command: "true", description: REPLY_PROGRESS_DOING } },
          ],
        };
      }
      // The long work: the next step takes its time, so the thread shows
      // the crewmate at work on the reply long before its answer.
      if (!calledTool(latestUserTail, "report")) {
        return {
          afterMs: REPLY_PROGRESS_WORK_MS,
          calls: [
            {
              name: "reply",
              args: {
                card_id: shownCardId,
                text: REPLY_PROGRESS_ANSWER,
                ...answering(latestUserTail),
              },
            },
            { name: "report", args: { text: REPLY_PROGRESS_ANSWER } },
          ],
        };
      }
      return { text: "Answered on the card." };
    }
    if (!hasToolResults && !calledTool(body, "emit_card")) {
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "reply-progress",
              title: REPLY_PROGRESS_CARD_TITLE,
              body: "<p>The review step can be called audit everywhere it shows.</p><p>The evaluations rerun after the rename.</p>",
              actions: [
                { id: "rename", label: "Rename it", default: true },
                { id: "keep", label: "Keep review" },
              ],
            },
          },
        ],
      };
    }
    return { text: "The card is up and I am holding for the captain." };
  };
