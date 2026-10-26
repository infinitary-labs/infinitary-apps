import { type Scenario, sinceLastUser } from "../mockProvider";

/**
 * The first mate reads an upgraded task's relationships by key (INF-1296
 * piece 2): asked with `UPGRADED_RELATIONSHIPS_PROMPT`, a task's key and the
 * fields to read, comma-separated, it pages each field one tool call at a
 * time, in the order asked, and then answers. The journey reads what each
 * call returned.
 */
export const UPGRADED_RELATIONSHIPS_PROMPT = "Read the upgraded task's relationships:";
const ANSWER = "I read the task's relationships.";

/** The words that ask for these fields of the task with this key. */
export function relationshipsAsk(key: string, fields: readonly string[]): string {
  return `${UPGRADED_RELATIONSHIPS_PROMPT} ${key} fields ${fields.join(",")}`;
}

export const upgradedRelationshipsRead: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (!isFirstmate || !wantsStream || !latestUserTail.includes(UPGRADED_RELATIONSHIPS_PROMPT)) {
      return undefined;
    }
    const asked = latestUserTail.match(/relationships: ([A-Za-z0-9]+-[0-9]+) fields ([a-z_,]+)/);
    if (!asked?.[1] || !asked[2]) return undefined;
    const field = asked[2].split(",")[sinceLastUser(body).results.length];
    if (field) return { calls: [{ name: "tasks", args: { key: asked[1], field } }] };
    return { text: ANSWER };
  };
