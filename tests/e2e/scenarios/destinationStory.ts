import { browserShellMessages } from "../browserScript";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";
import { preparedRevision, prepareMockStory } from "./changeStory";

/** INF-1965: one saved-story author, with no forge calls for local-only work. */
export const DESTINATION_STORY_MARKER = "capture the destination completion";
export const DESTINATION_STORY_TITLE = "fix: the meter reads on time";

export function destinationStory(local: boolean): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream }) => {
      if (isFirstmate || !wantsStream || !body.includes(DESTINATION_STORY_MARKER)) return undefined;
      const messages = providerMessages(body);
      if (calledTool(body, "emit_card") || browserShellMessages(messages).pending)
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
      if (!calledTool(body, "prepare_change"))
        return { calls: [prepareMockStory(DESTINATION_STORY_TITLE, reading)] };
      if (!local && !calledTool(body, "open_change"))
        return {
          calls: [
            {
              name: "open_change",
              args: {
                title: DESTINATION_STORY_TITLE,
                presentation: preparedRevision(body),
              },
            },
          ],
        };
      if (!local && !calledTool(body, "check_change"))
        return { calls: [{ name: "check_change", args: {} }] };
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: DESTINATION_STORY_TITLE,
              presentation: preparedRevision(body),
              // INF-2744: one merge card whether or not the task merges on its own.
              actions: [{ id: "merge", default: true, effect: { kind: "merge", after: "close" } }],
            },
          },
          { name: "report", args: { text: "The meter change is committed and ready." } },
        ],
      };
    };
}
