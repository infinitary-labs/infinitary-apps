import { type Scenario, sinceLastUser } from "../mockProvider";

export const UPGRADED_TIMELINE_PROMPT = "Read the upgraded task's unified timeline:";

/** INF-1296 B piece 5: the real tasks tool pages the exact retained source records. */
export const upgradedTimelineRead: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (!isFirstmate || !wantsStream || !latestUserTail.includes(UPGRADED_TIMELINE_PROMPT))
      return undefined;
    const key = latestUserTail.match(/timeline: ([A-Za-z0-9]+-[0-9]+)/)?.[1];
    if (!key) return undefined;
    const results = sinceLastUser(body).results.filter((result) =>
      result.startsWith("field timeline as json,"),
    );
    const next = results.at(-1)?.match(/nextOffset (\d+|none)/)?.[1];
    if (results.length === 0 || (next && next !== "none"))
      return {
        calls: [
          {
            name: "tasks",
            args: { key, field: "timeline", ...(next ? { offset: Number(next) } : {}) },
          },
        ],
      };
    return { text: "I read the retained timeline and its exact sources." };
  };
