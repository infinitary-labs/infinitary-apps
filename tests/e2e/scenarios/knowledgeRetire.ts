import { MOCK_FM_DONE_TEXT, type Scenario } from "../mockProvider";

/**
 * The mock Firstmate retires every `c-` or `f-` id the turn names as
 * `id@revision`, then closes. The collapsed-panel refresh journey uses it.
 */
export const KNOWLEDGE_RETIRE_PROMPT_MARKER = "retire these knowledge entries";

/** The first mate retires every knowledge entry the turn names by id and revision. */
export const knowledgeRetire: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (!isFirstmate || !wantsStream) return undefined;
    if (latestUserTail.includes(KNOWLEDGE_RETIRE_PROMPT_MARKER)) {
      if (!hasToolResults) {
        const named = [...latestUserTail.matchAll(/\b([cf]-[a-z0-9]{6})@(\d+)/g)];
        return {
          calls: named.map((match) => ({
            name: "record_knowledge",
            args: {
              action: "retire",
              request_id: `retire-${match[1]}`,
              id: match[1],
              expected_revision: Number(match[2]),
              reason: "the captain asked to retire it",
            },
          })),
        };
      } else {
        return { text: MOCK_FM_DONE_TEXT };
      }
    }
    return undefined;
  };
