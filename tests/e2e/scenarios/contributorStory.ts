import { browserShellMessages } from "../browserScript";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";
import { preparedRevision, prepareMockStory } from "./changeStory";

export const CONTRIBUTOR_STORY_MARKER = "prove the contributor story";
export const CONTRIBUTOR_STORY_TITLE = "fix: keep the contributed meter reading current";

/** Accepted piece A and the captain's title choice: read, publish a separate
 * story, then let the captain queue the reviewed source at that version. */
export function contributorStory(number: number): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream }) => {
      if (isFirstmate || !wantsStream || !body.includes(CONTRIBUTOR_STORY_MARKER)) return undefined;
      const messages = providerMessages(body);
      if (calledTool(body, "emit_card") || browserShellMessages(messages).pending)
        return { text: "Waiting for the recorded contribution." };
      if (!calledTool(body, "bash"))
        return {
          calls: [
            {
              name: "bash",
              args: {
                background: true,
                command:
                  "git checkout contribution && git show HEAD -- meter.txt && git rev-parse HEAD^ HEAD",
              },
            },
          ],
        };
      const reading = messages
        .map((message) => message.text)
        .find((text) => /[0-9a-f]{40}\n[0-9a-f]{40}/.test(text));
      if (!reading) return { text: "Waiting for the contribution's code and version." };
      if (!calledTool(body, "check_change"))
        return { calls: [{ name: "check_change", args: { pull: number } }] };
      if (!calledTool(body, "prepare_change"))
        return { calls: [prepareMockStory(CONTRIBUTOR_STORY_TITLE, reading)] };
      const revision = preparedRevision(body);
      if (!calledTool(body, "open_change"))
        return {
          calls: [
            {
              name: "open_change",
              args: { title: CONTRIBUTOR_STORY_TITLE, presentation: revision },
            },
          ],
        };
      // A saved-story card uses the current change selected by check_change;
      // its tool contract refuses a separate effect.review alongside presentation.
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              id: "contributor-story-review",
              title: CONTRIBUTOR_STORY_TITLE,
              presentation: revision,
              actions: [
                {
                  id: "merge",
                  effect: {
                    kind: "merge",
                    after: "continue",
                    asks_first:
                      "The captain decides whether reviewed contributor code enters the queue.",
                  },
                },
              ],
            },
          },
        ],
      };
    };
}
