import {
  CARD_CLOSED_STEER_NEEDLE,
  calledTool,
  contextRepos,
  RETRIEVAL_TASK_ASK,
  RETRIEVAL_TASK_GOAL,
  type Scenario,
  toolAnswers,
} from "../mockProvider";
import { providerMessages } from "../providerRequest";

export const RETRIEVAL_TASK_TITLE = "Read meterlab release facts";

export const RETRIEVAL_CARD_TITLE = "Release 0.1.31 includes video demos";

export const RETRIEVAL_SOURCE = '{"version":"0.1.31","videoDemos":true}';

/**
 * The lookup ask: the first mate spawns the retrieval task, and its crewmate
 * reads the committed release facts and answers on one decision card. A
 * closed card's steer passes on to the shared answer-task close.
 */
export const retrievalTask: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate && wantsStream) {
      if (!hasToolResults && latestUserTail.includes(RETRIEVAL_TASK_ASK)) {
        return {
          calls: [
            {
              name: "spawn_crewmate",
              args: {
                title: RETRIEVAL_TASK_TITLE,
                goal: RETRIEVAL_TASK_GOAL,
                user_words: RETRIEVAL_TASK_ASK,
                repo_id: contextRepos(body).find(([name]) => name === "meterlab")?.[1],
                constraints: [{ kind: "read-only" }],
              },
            },
          ],
        };
      }
    }
    // The closed card's steer is the shared answer-task close's.
    if (
      !isFirstmate &&
      body.includes(RETRIEVAL_TASK_ASK) &&
      !latestUserTail.includes(CARD_CLOSED_STEER_NEEDLE) &&
      wantsStream
    ) {
      if (calledTool(body, "emit_card")) return { text: "The lookup answer is ready." };
      if (!calledTool(body, "read"))
        return { calls: [{ name: "read", args: { path: "release-info.json" } }] };
      const results = toolAnswers(providerMessages(body)).join("\n");
      if (!results.includes(RETRIEVAL_SOURCE))
        throw new Error("Retrieval fixture did not read its committed release facts");
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "release-facts",
              title: RETRIEVAL_CARD_TITLE,
              body: "<p>Release 0.1.31 includes video demos.</p><p>Source: <code>release-info.json</code>, version and videoDemos fields.</p>",
            },
          },
          {
            name: "report",
            args: {
              text: "Read release-info.json: version 0.1.31, videoDemos true. No changes made.",
              summary: "The recorded release includes video demos.",
              waiting_on_captain: { reason: "Read the lookup answer" },
            },
          },
        ],
      };
    }
    return undefined;
  };
