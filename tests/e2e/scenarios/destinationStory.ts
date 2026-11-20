import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { browserShellMessages } from "../browserScript";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages, toolCallCount } from "../providerRequest";
import { mockStory } from "./changeStory";

/** INF-1965: one saved-story author, with no forge calls for local-only work. */
export const DESTINATION_STORY_MARKER = "capture the destination completion";
export const DESTINATION_STORY_TITLE = "fix: the meter reads on time";

export function destinationStory(local: boolean): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream }) => {
      if (isFirstmate || !wantsStream || !body.includes(DESTINATION_STORY_MARKER)) return undefined;
      const messages = providerMessages(body);
      if (calledTool(body, "report") || browserShellMessages(messages).pending)
        return { text: "Waiting for the recorded work." };
      if (!calledTool(body, "bash"))
        return {
          calls: [
            {
              name: "bash",
              args: {
                background: true,
                command: `printf 'reads on time\\n' > meter.txt && git add meter.txt && git commit -m '${DESTINATION_STORY_TITLE}'${local ? "" : " && git push origin HEAD"} && git rev-parse main HEAD`,
              },
            },
          ],
        };
      const reading = messages
        .map((message) => message.text)
        .find((text) => /[0-9a-f]{40}\n[0-9a-f]{40}/.test(text));
      if (!reading) return { text: "Waiting for the committed change." };
      // INF-3717 piece 2: one call prepares the story, publishes it where
      // the branch is pushed and shows the merge card, or names the one
      // thing missing; called again, it repeats nothing.
      if (/Showed the merge card from story revision \d/.test(body))
        return {
          calls: [{ name: "report", args: { text: "The meter change is committed and ready." } }],
        };
      const shows = toolCallCount(body, "show_merge_card");
      if (shows === 0)
        return {
          calls: [
            {
              name: "show_merge_card",
              args: {
                id: "merge-meter",
                story: mockStory(DESTINATION_STORY_TITLE, reading),
              },
            },
          ],
        };
      if (shows >= 3) return { text: "The merge card is still missing a step." };
      // A step not yet true, such as the checks: read them, then call again.
      const again: ScriptedCall[] = [
        { name: "check_change", args: {} },
        { name: "show_merge_card", args: { id: "merge-meter" } },
      ];
      return { calls: again };
    };
}
