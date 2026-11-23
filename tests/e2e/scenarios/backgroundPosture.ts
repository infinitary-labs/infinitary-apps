import type { ScriptedCall } from "../../helpers/scriptedCalls";
import type { Scenario } from "../mockProvider";

/** Presentation regression: a real host job continues alongside a question. */
export const WORK_POSTURE_MARKER = "verify background posture";
export const WORK_POSTURE_QUIET_MARKER = "without a question";

export const backgroundPosture: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream || hasToolResults) return undefined;
    if (!latestUserTail.includes(WORK_POSTURE_MARKER)) return undefined;
    const calls: ScriptedCall[] = [
      {
        name: "bash",
        args: {
          command: "while [ ! -f .posture-release ]; do sleep 0.1; done",
          background: true,
        },
      },
    ];
    if (latestUserTail.includes(WORK_POSTURE_QUIET_MARKER)) return { calls };
    return {
      calls: [
        ...calls,
        {
          name: "emit_card",
          args: {
            title: "Background posture question",
            body: "<p>Continue after the background work finishes.</p><p>The disposable command is still running; Continue keeps this task available for its result.</p>",
            actions: [
              { id: "continue", label: "Continue", default: true },
              { id: "stop", label: "Stop" },
            ],
          },
        },
      ],
    };
  };
