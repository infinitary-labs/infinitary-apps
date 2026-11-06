import type { Scenario } from "../mockProvider";
import { type ChatRequest, calledTool, messageText, toolResults } from "../providerRequest";
import { preparedRevision, prepareMockStory } from "./changeStory";

/**
 * INF-1219 direction A: a crewmate on a task that merges on its own. Its
 * brief carries this marker; it commits, sends its branch up, prepares and
 * opens a saved story, reads its checks, and on green shows that story on a
 * note with no actions, as the served rule tells it to, and reports.
 */
export const SELF_MERGE_NOTE_PROMPT_MARKER = "open the meter fix to merge on its own";
export const MOCK_SELF_MERGE_CHANGE_TITLE = "fix: the meter reads on time on its own";

export const selfMergeNote: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(SELF_MERGE_NOTE_PROMPT_MARKER))
      return undefined;
    const messages = (JSON.parse(body) as ChatRequest).messages ?? [];
    const results = messages.flatMap(toolResults);
    const gitReading = [
      ...results,
      ...messages
        .filter((message) => message.role === "user")
        .map((message) => messageText(message.content)),
    ].find((reading) => /https:\/\/github[^\s]*\n[0-9a-f]{40}\n[0-9a-f]{40}/.test(reading));
    if (!calledTool(body, "bash"))
      return {
        calls: [
          {
            name: "bash",
            args: {
              background: true,
              command: `git commit --allow-empty -m "${MOCK_SELF_MERGE_CHANGE_TITLE}" && git push origin HEAD && git config --get remote.origin.url && git rev-parse main HEAD`,
            },
          },
        ],
      };
    if (!gitReading) return { text: "Waiting for the committed change." };
    if (calledTool(body, "emit_card")) return { text: "done" };
    const reading = results.findLast((result) => result.includes("facts: "));

    if (results.some((result) => result.includes("facts: ")))
      return {
        calls: [
          {
            name: "emit_card",
            args: { title: MOCK_SELF_MERGE_CHANGE_TITLE, presentation: preparedRevision(body) },
          },
          {
            name: "report",
            args: {
              text: "The meter fix is open and its checks passed.",
              needs_firstmate: "merge the pull request",
            },
          },
        ],
      };
    if (calledTool(body, "open_change")) return { calls: [{ name: "check_change", args: {} }] };
    if (!calledTool(body, "prepare_change"))
      return { calls: [prepareMockStory(MOCK_SELF_MERGE_CHANGE_TITLE, gitReading)] };
    return {
      calls: [
        {
          name: "open_change",
          args: { title: MOCK_SELF_MERGE_CHANGE_TITLE, presentation: preparedRevision(body) },
        },
      ],
    };
  };
