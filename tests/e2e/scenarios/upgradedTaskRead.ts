import { type Scenario, sinceLastUser } from "../mockProvider";

/**
 * The first mate reads an upgraded task's record by key (INF-1296 piece 1):
 * asked with `UPGRADED_TASK_PROMPT` and the task's key, it pages the record's
 * history fields one tool call each, in `UPGRADED_TASK_FIELDS` order, and
 * then answers. The journey reads what each call returned.
 */
export const UPGRADED_TASK_PROMPT = "Read the upgraded task's history:";
export const UPGRADED_TASK_FIELDS = ["reports", "result", "decisions", "brief"] as const;
const ANSWER = "I read the task's reports, result, decisions and brief.";

export const upgradedTaskRead: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (!isFirstmate || !wantsStream || !latestUserTail.includes(UPGRADED_TASK_PROMPT)) {
      return undefined;
    }
    const key = latestUserTail.match(/history: ([A-Za-z0-9]+-[0-9]+)/)?.[1];
    if (!key) return undefined;
    const field = UPGRADED_TASK_FIELDS[sinceLastUser(body).results.length];
    if (field) return { calls: [{ name: "tasks", args: { key, field } }] };
    return { text: ANSWER };
  };
