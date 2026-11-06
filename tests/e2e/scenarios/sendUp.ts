import { browserShellMessages } from "../browserScript";
import { MOCK_STANDARD_CARD_BODY } from "../crewCards";
import type { Scenario } from "../mockProvider";
import { calledTool, providerMessages } from "../providerRequest";

/**
 * A project on a plain Git host (git integration PR 1.1, forge-seam e2e): a
 * brief carrying this marker saves a point in its working copy and sends it
 * up with its own shell, reads the raw checks and explicitly declares ready,
 * then offers the completion card and reports. The host's forge seam finds
 * the sent-up copy; the captain's separate click puts it in.
 */
export const SEND_UP_PROMPT_MARKER = "send the meter fix up to its host";

export const MOCK_SENT_UP_CARD_TITLE = "The meter fix is ready to go in";

/** The forge seam crewmate commits and pushes its branch, then offers the change on a card. */
export const sendUp: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream || !body.includes(SEND_UP_PROMPT_MARKER)) return undefined;
    // INF-1099: a push past the shell's limit becomes a background
    // job. Its receipt is not the push being done: end the turn, and
    // declare the card from that job's exit wake, never pushing again.
    if (calledTool(body, "emit_card") || browserShellMessages(providerMessages(body)).pending) {
      return { text: "done" };
    }
    if (!calledTool(body, "bash")) {
      return {
        calls: [
          {
            name: "bash",
            args: {
              command:
                "printf 'reads on time\\nreads each minute\\nreads in the dark\\n' > meter.txt && git add meter.txt && " +
                'git commit -m "fix: the meter reads on time" && git push origin HEAD',
            },
          },
        ],
      };
    }
    // INF-1479: no checks is a fact, not automatic readiness, on a plain host too.
    const results = providerMessages(body)
      .filter((message) => message.role === "tool")
      .map((message) => message.text);

    if (!results.some((result) => result.includes("facts: ")))
      return { calls: [{ name: "check_change", args: {} }] };
    return {
      calls: [
        {
          name: "emit_card",
          args: {
            title: MOCK_SENT_UP_CARD_TITLE,
            body: MOCK_STANDARD_CARD_BODY,
            actions: [
              {
                id: "put-in",
                label: "Put it in",
                default: true,
                effect: { kind: "settle", mode: "merge" },
              },
            ],
          },
        },
        { name: "report", args: { text: "The meter fix is saved and sent up." } },
      ],
    };
  };
