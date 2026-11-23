import { browserShellMessages } from "../browserScript";
import type { Scenario, ScenarioAnswer } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";
import { MOCK_GITHUB_STORY, preparedRevision, prepareMockStory } from "./changeStory";

/**
 * A change whose rest must wait for it to merge (forge-signin e2e): a brief
 * carrying this marker opens its pull request, files the rest as a
 * `Continue:` follow-up on green and reports; the first mate links the
 * follow-up behind it and steers the crewmate to its completion card. The
 * follow-up, once started, reports that it read its origin.
 */
export const CONTINUE_CHANGE_PROMPT_MARKER = "open the staged meter fix then carry on";
export const CONTINUE_CHANGE_TITLE = "Continue: check the landed meter";
export const MOCK_CONTINUE_CHANGE = {
  title: "fix: stage the meter",
  body: "## Intent\nStage the meter.",
};
export const CONTINUE_CHANGE_CARD_TITLE = MOCK_CONTINUE_CHANGE.title;
export const MOCK_CONTINUE_STORY = {
  ...MOCK_GITHUB_STORY,
  whatChanged: ["Stage the meter."],
  unfinished: [`${CONTINUE_CHANGE_TITLE} starts once it is merged.`],
};

export const continueChange: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream, latestUserTail }) => {
    if (!wantsStream) return undefined;
    if (isFirstmate) return firstmateMove(latestUserTail);
    if (body.includes("Goal: Check the meter after the first fix is in.")) {
      return calledTool(latestUserTail, "report")
        ? { text: "The continuation read its origin." }
        : {
            calls: [
              {
                name: "report",
                args: { text: "Read the first fix and checked the landed meter." },
              },
            ],
          };
    }
    if (!body.includes(CONTINUE_CHANGE_PROMPT_MARKER)) return undefined;
    if (latestUserTail.includes("Now emit the completion decision")) {
      if (calledTool(latestUserTail, "emit_card")) return { text: "The first change is ready." };
      return {
        calls: [
          {
            name: "emit_card",
            args: {
              title: CONTINUE_CHANGE_CARD_TITLE,
              presentation: preparedRevision(body),
              actions: [
                {
                  id: "put-in",
                  label: "Put it in",
                  default: true,
                  effect: { kind: "merge", after: "close" },
                },
              ],
            },
          },
        ],
      };
    }
    if (!calledTool(body, "bash"))
      return {
        calls: [
          {
            name: "bash",
            args: {
              command:
                'git commit --allow-empty -m "fix: stage the meter" && git push origin HEAD && git rev-parse main HEAD',
            },
          },
        ],
      };
    // INF-1099: a push past the shell's limit becomes a background job.
    // Its receipt is not the push being done: end the turn, and carry on
    // from that job's exit wake, never pushing again.
    const shell = browserShellMessages(providerMessages(body));
    if (shell.pending) return { text: "The push is still running." };
    const gitReading = shell.readings.find((message) => message.role === "tool")?.text;
    if (calledTool(latestUserTail, "report")) return { text: "The first change is ready." };

    if (calledTool(latestUserTail, "check_change")) {
      if (!calledTool(latestUserTail, "file_followup"))
        return {
          calls: [
            {
              name: "file_followup",
              args: {
                title: CONTINUE_CHANGE_TITLE,
                goal: "Check the meter after the first fix is in.",
                why: "The first fix must be in before checking the landed meter.",
              },
            },
          ],
        };
      return {
        calls: [
          {
            name: "report",
            args: {
              text: `The first fix is ready; filed ${CONTINUE_CHANGE_TITLE} for after put-in.`,
            },
          },
        ],
      };
    }
    if (calledTool(latestUserTail, "open_change"))
      return { calls: [{ name: "check_change", args: {} }] };
    if (!calledTool(latestUserTail, "prepare_change"))
      return {
        calls: [prepareMockStory(CONTINUE_CHANGE_CARD_TITLE, gitReading, MOCK_CONTINUE_STORY)],
      };
    return {
      calls: [
        {
          name: "open_change",
          args: { title: MOCK_CONTINUE_CHANGE.title, presentation: preparedRevision(body) },
        },
      ],
    };
  };

/**
 * A report with a continuation: the model makes the two existing
 * task-graph calls in this turn, rather than inventing a runner.
 */
function firstmateMove(latestUserTail: string): ScenarioAnswer | undefined {
  if (
    !latestUserTail.includes("Filed this turn:") ||
    !latestUserTail.includes(CONTINUE_CHANGE_TITLE)
  )
    return undefined;
  const origin = latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
  const filing = latestUserTail.match(/Filed this turn: ([A-Z0-9-]+)/)?.[1] ?? "missing";
  if (!calledTool(latestUserTail, "link_tasks"))
    return { calls: [{ name: "link_tasks", args: { from: origin, to: filing, type: "blocks" } }] };
  if (!calledTool(latestUserTail, "update_task"))
    return {
      calls: [
        {
          name: "update_task",
          args: { task: filing, start_policy: "when-ready", blocked_by: [origin] },
        },
      ],
    };
  if (!calledTool(latestUserTail, "steer_crewmate"))
    return {
      calls: [
        {
          name: "steer_crewmate",
          args: {
            task_id: origin,
            message: "Now emit the completion decision, naming the continuation in its body.",
          },
        },
      ],
    };
  return { text: "The continuation waits on the first change." };
}
