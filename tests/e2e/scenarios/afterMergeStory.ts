import type { AfterMergeStep } from "@shared/afterMerge";
import { FOLLOWUP_PROVENANCE_OPENING } from "../../../src/core/orchestrator/intentBrief";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";

/**
 * INF-2796: a local-only crewmate commits the meter fix and offers its merge
 * with a story that lists one after-merge step, or none. The step's own
 * crewmate, once the app starts it, keeps its turn open, the way a crewmate
 * goes on working.
 */
export const AFTER_MERGE_STORY_MARKER = "offer the meter fix with what comes after";
export const NO_AFTER_MERGE_STORY_MARKER = "offer the meter fix with nothing after";
export const WAITING_AFTER_MERGE_STORY_MARKER = "offer the meter fix with work that waits";
export const AFTER_MERGE_STORY_TITLE = "fix: the meter reads on time";

/** The work the meter fix leaves for after its merge: the dashboard corrects for the old lag. */
export const METER_AFTER_MERGE_STEP = {
  title: "Remove the dashboard's lag correction",
  goal: "The meter dashboard shows readings as they arrive, with no lag correction added.",
  why: "The dashboard adds a correction for the meter's old lag. Once this fix reads on time, the correction double-counts, so it comes out after the merge.",
} satisfies AfterMergeStep;

/**
 * The dashboard project's work the meter fix leaves for after its merge,
 * which also waits for the dashboard's feed task (DASH-1) to merge: the lag
 * correction comes out in the dashboard's own project, and DASH-2, already
 * on the board, starts too.
 */
export const DASHBOARD_PROJECT_KEY = "DASH";
export const DASHBOARD_FEED_KEY = "DASH-1";
export const DASHBOARD_EXISTING_KEY = "DASH-2";
export const WAITING_AFTER_MERGE_STEPS = [
  { ...METER_AFTER_MERGE_STEP, project: DASHBOARD_PROJECT_KEY, blockedBy: [DASHBOARD_FEED_KEY] },
  { task: DASHBOARD_EXISTING_KEY, blockedBy: [DASHBOARD_FEED_KEY] },
] satisfies AfterMergeStep[];

export function afterMergeStory(): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream }) => {
      if (isFirstmate || !wantsStream) return undefined;
      // The filed step's crewmate: its brief says who filed it and why.
      if (body.includes(FOLLOWUP_PROVENANCE_OPENING) && body.includes(METER_AFTER_MERGE_STEP.why))
        return { held: true };
      const waiting = body.includes(WAITING_AFTER_MERGE_STORY_MARKER);
      const steps = waiting
        ? WAITING_AFTER_MERGE_STEPS
        : body.includes(AFTER_MERGE_STORY_MARKER)
          ? [METER_AFTER_MERGE_STEP]
          : undefined;
      if (!steps && !body.includes(NO_AFTER_MERGE_STORY_MARKER)) return undefined;
      const messages = providerMessages(body);
      if (calledTool(body, "emit_card")) return { text: "Waiting for the merge." };
      if (!calledTool(body, "bash"))
        return {
          calls: [
            {
              name: "bash",
              args: {
                command: `printf 'reads on time\\n' > meter.txt && git add meter.txt && git commit -m '${AFTER_MERGE_STORY_TITLE}' && git rev-parse main HEAD`,
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
            prepareMockStory(AFTER_MERGE_STORY_TITLE, reading, {
              ...MOCK_GITHUB_STORY,
              ...(steps ? { afterMerge: steps } : {}),
            }),
          ],
        };
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: AFTER_MERGE_STORY_TITLE,
              presentation: preparedRevision(body),
              actions: [{ id: "merge", default: true, effect: { kind: "settle", mode: "merge" } }],
            },
          },
          { name: "report", args: { text: "The meter fix is committed and ready to merge." } },
        ],
      };
    };
}
