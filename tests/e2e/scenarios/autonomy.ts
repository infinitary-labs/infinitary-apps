import { MOCK_STANDARD_CARD_BODY } from "../crewCards";
import type { Scenario } from "../mockProvider";

/**
 * The autonomy hold (contract v3.9). Briefed with this marker, the mock
 * crewmate emits its merge card declaring the merge and reports - the
 * ordinary end of a direct-pr task. The task title carries the marker, so
 * the card's title carries it too and two tasks in one app never collide.
 * `AUTONOMY_ASK_MARKER` in the title is the captain's words on who merges,
 * which the shared stand-in's spawn relays as `autonomy_ask: true`.
 */
export const AUTONOMY_PROMPT_MARKER = "ship and wait to be merged";
/**
 * INF-2744: a task whose crewmate cites a standing direction that leaves
 * this merge to the captain, so its merge card declares `asks_first` even
 * where the task merges on its own.
 */
export const AUTONOMY_ASKS_FIRST_MARKER = "ship, a direction asks first";
export const MOCK_ASKS_FIRST_REASON =
  "A standing direction says the captain merges every change to the meter.";
export const MOCK_AUTONOMY_CARD_TITLE = (title: string) => `Ready to merge - ${title}`;
export const MOCK_AUTONOMY_REPORT =
  "Intent: the meter reads on the first paint. What changed: the panel awaits the snapshot. Verified: pnpm test on the final commit; the PR is green. Risk: low. Not done: nothing.";

/**
 * The autonomy-hold crewmate: an ordinary finished direct-pr task - one
 * merge card declaring the merge (INF-2744), and the report. Who may click that
 * merge is the host's question, not its.
 */
export const autonomy: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (
      isFirstmate ||
      !wantsStream ||
      !(
        latestUserTail.includes(AUTONOMY_PROMPT_MARKER) ||
        latestUserTail.includes(AUTONOMY_ASKS_FIRST_MARKER)
      )
    )
      return undefined;
    const asksFirst = latestUserTail.includes(AUTONOMY_ASKS_FIRST_MARKER);
    if (!hasToolResults) {
      return {
        calls: [
          {
            name: "bash",
            args: { command: 'git commit --allow-empty -m "fix: make the meter read on time"' },
          },
        ],
      };
    }
    if (latestUserTail.includes(MOCK_AUTONOMY_REPORT)) return { text: "done" };
    const title = latestUserTail.match(/commission a crewmate: ([^"\\]+)/)?.[1]?.trim();
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: MOCK_AUTONOMY_CARD_TITLE(title ?? AUTONOMY_PROMPT_MARKER),
            body: MOCK_STANDARD_CARD_BODY,
            actions: [
              {
                id: "ship",
                label: "Ship it",
                default: true,
                effect: {
                  kind: "merge",
                  after: "close",
                  ...(asksFirst ? { asks_first: MOCK_ASKS_FIRST_REASON } : {}),
                },
              },
            ],
          },
        },
        { name: "report", args: { text: MOCK_AUTONOMY_REPORT } },
      ],
    };
  };
