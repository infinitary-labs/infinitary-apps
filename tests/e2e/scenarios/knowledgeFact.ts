import {
  calledTool,
  FIRST_RUN_WAKE_MARKER,
  MOCK_FM_DONE_TEXT,
  type Scenario,
} from "../mockProvider";

/**
 * The mock Firstmate asked to remember a fact where knowledge is on: it
 * records the fact with record_knowledge, then closes the turn.
 */
export const KNOWLEDGE_FACT_PROMPT_MARKER = "remember that deploys happen on tuesdays";

/** The first mate records the deploy-day fact. The first-run wake outranks it, as in the shared stand-in. */
export const knowledgeFact: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (!hasToolResults && latestUserTail.includes(FIRST_RUN_WAKE_MARKER)) return undefined;
    if (!latestUserTail.includes(KNOWLEDGE_FACT_PROMPT_MARKER)) return undefined;
    if (calledTool(latestUserTail, "record_knowledge")) return { text: MOCK_FM_DONE_TEXT };
    return {
      calls: [
        {
          name: "record_knowledge",
          args: {
            action: "publish",
            request_id: "deploy-day",
            kind: "concept",
            title: "Deploy day",
            text: "Deploys happen on Tuesdays.",
          },
        },
      ],
    };
  };
