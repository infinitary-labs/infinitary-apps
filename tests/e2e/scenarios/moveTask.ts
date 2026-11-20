import { crewmateRestartText } from "../../../src/core/orchestrator/crewSession";
import type { Scenario } from "../mockProvider";

/** INF-849: a crewmate whose provider signs it out, and that goes on wherever its task moves. */
export const MOVE_TASK_PROMPT_MARKER = "survey the hull plates";
export const MOVED_TASK_REPORT = "The hull plates are surveyed; two need new rivets.";

/**
 * The opening a moved crewmate's first prompt carries, for the provider it
 * moved to: the owner's own restart words, up to the reason.
 */
export function movedOpening(providerName: string): string {
  const text = crewmateRestartText({
    restart: { from: "", changed: "moved", to: providerName },
    taskKey: "",
  });
  return text.slice(0, text.indexOf(","));
}

/**
 * Every turn of the marked crewmate is refused the way Anthropic refuses a
 * signed-out login (a 401), until its task moves to `providerName`; there it
 * reports once and ends its turn.
 */
export function moveTask(providerName: string): Scenario {
  const opening = movedOpening(providerName);
  return () =>
    ({ body, isFirstmate, hasToolResults }) => {
      if (isFirstmate || !body.includes(MOVE_TASK_PROMPT_MARKER)) return undefined;
      if (!body.includes(opening))
        return {
          refusal: {
            status: 401,
            error: { type: "authentication_error", message: "invalid x-api-key" },
          },
        };
      return hasToolResults
        ? { text: "done" }
        : { calls: [{ name: "report", args: { text: MOVED_TASK_REPORT } }] };
    };
}
