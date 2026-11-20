import type { RequiredAction } from "@shared/requiredActions";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";

/**
 * The freeze journey's merged close with a required action (INF-4224): a
 * local-only crewmate commits a change and offers its merge with a story
 * that declares one action the captain takes afterwards, so the captain's
 * merge click runs the close step that files that action's task. On the
 * captain's record that step read every task and held the main thread
 * 491 ms.
 */
export const FREEZE_MERGE_MARKER = "offer the gauge fix with an install after";
export const FREEZE_MERGE_TITLE = "fix: the gauge reads on time";

/** The action the captain takes once the gauge fix merges. */
export const FREEZE_MERGE_ACTION = {
  id: "install-on-the-work-computer",
  target: "the work computer",
  title: "Install the gauge fix on the work computer",
  consequence: "Until then the work computer shows the late reading.",
  instructions: ["Open Infinitary on the work computer.", "Choose Update now."],
  criterion: "The work computer shows the gauge reading on time.",
  prerequisites: [],
  completion: { kind: "manual", label: "I installed it" },
} satisfies RequiredAction;

export function freezeMerge(): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream }) => {
      if (isFirstmate || !wantsStream || !body.includes(FREEZE_MERGE_MARKER)) return undefined;
      const messages = providerMessages(body);
      if (calledTool(body, "emit_card")) return { text: "Waiting for the merge." };
      if (!calledTool(body, "bash"))
        return {
          calls: [
            {
              name: "bash",
              args: {
                command: `printf 'reads on time\\n' > gauge.txt && git add gauge.txt && git commit -m '${FREEZE_MERGE_TITLE}' && git rev-parse main HEAD`,
              },
            },
          ],
        };
      const reading = messages
        .map((message) => message.text)
        .find((text) => /[0-9a-f]{40}\n[0-9a-f]{40}/.test(text));
      if (!reading) return { text: "Waiting for the committed change." };
      if (!calledTool(body, "prepare_change"))
        return {
          calls: [
            prepareMockStory(FREEZE_MERGE_TITLE, reading, {
              ...MOCK_GITHUB_STORY,
              requiredActions: [FREEZE_MERGE_ACTION],
            }),
          ],
        };
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: FREEZE_MERGE_TITLE,
              presentation: preparedRevision(body),
              actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
            },
          },
          { name: "report", args: { text: "The gauge fix is committed and ready to merge." } },
        ],
      };
    };
}
