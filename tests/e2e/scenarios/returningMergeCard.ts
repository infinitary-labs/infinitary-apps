import { MERGE_NOT_NOW_WORDS } from "../../../src/shared/vocabulary";
import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { browserShellMessages } from "../browserScript";
import type { Scenario } from "../mockProvider";
import { providerMessages } from "../providerRequest";
import { mockStory } from "./changeStory";
import { mergeShellCall } from "./mergeShell";

/**
 * INF-5035: a merge card that comes back after the captain saw or answered
 * an earlier one. A scripted crewmate on a local project commits, shows its
 * merge card, and shows it again at a new version with its summary of what
 * changed (`since_seen`), once after the captain's reply on the card and
 * once after their Not now. It is a hermetic replay of the host's part, not
 * a claim that a live model writes a good summary.
 */
export const RETURNING_MERGE_MARKER = "show the meter merge card again";
export const RETURNING_MERGE_TITLE = "fix: the meter reads on time";

/** The captain's reply on the first card, which asks for one more file. */
export const RETURNING_MERGE_REPLY = "Keep the dial file with the meter too.";

/** What the crewmate writes on each returning card. */
export const RETURNING_MERGE_SUMMARIES = {
  reply: "I added the dial file you asked for. The meter change itself is unchanged.",
  notNow: "I added the gauge file so the meter can be read at a glance.",
} as const;

type Stage = "first" | "reply" | "notNow";

const FILES: Record<Stage, string> = { first: "meter", reply: "dial", notNow: "gauge" };

export const returningMergeCard: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(RETURNING_MERGE_MARKER)) return undefined;
    const { readings, pending } = browserShellMessages(providerMessages(body));
    if (pending) return { text: "" };
    // The newest message that asks something of this crewmate: its brief,
    // the captain's reply on the card, or their Not now.
    const asks = (text: string, index: number) =>
      index === 0
        ? text.includes(RETURNING_MERGE_MARKER)
        : text.includes(RETURNING_MERGE_REPLY) || text.includes(MERGE_NOT_NOW_WORDS);
    const users = readings.flatMap((message, index) =>
      message.role === "user" ? [{ message, index }] : [],
    );
    const anchor = users.filter(({ message }, order) => asks(message.text, order)).at(-1);
    if (!anchor) return undefined;
    const stage: Stage =
      anchor === users[0]
        ? "first"
        : anchor.message.text.includes(RETURNING_MERGE_REPLY)
          ? "reply"
          : "notNow";
    const results = readings
      .slice(anchor.index + 1)
      .flatMap((message) => (message.role === "tool" ? [message.text] : []));
    const file = FILES[stage];
    const reading = results[0];
    const steps: ScriptedCall[] = [
      mergeShellCall(
        body,
        `printf '${file}\\n' > ${file}.txt && git add ${file}.txt && git commit -m 'fix: keep the ${file} file' && git rev-parse main HEAD`,
      ),
      {
        name: "show_merge_card",
        args: {
          id: "merge-meter",
          after: "continue",
          story: mockStory(RETURNING_MERGE_TITLE, reading),
          ...(stage === "first" ? {} : { since_seen: RETURNING_MERGE_SUMMARIES[stage] }),
          // The captain's reply, their first message under the card, waits on
          // the crewmate's answer, which rides the revision.
          ...(stage === "reply"
            ? { reply: "I added the dial file and showed the card again.", answers_message: 1 }
            : {}),
        },
      },
      {
        name: "report",
        args: { text: `The ${file} change is committed and its merge card is up.` },
      },
    ];
    const next = steps[results.length];
    return next ? { calls: [next] } : { text: "Waiting for the captain." };
  };
