import { browserShellMessages, calledTool, type Scenario } from "../mockProvider";
import { providerMessages } from "../providerRequest";

/** INF-1870: leave disposable evidence beside a basis and read it from a continuation. */
export const BASIS_PROBE = "basis locality probe";
export const BASIS_EVIDENCE = "The basis reproduction is available.";
export const basisPlacement: Scenario =
  () =>
  ({ body, isFirstmate, wantsStream }) => {
    if (isFirstmate || !wantsStream) return undefined;
    const messages = providerMessages(body);
    const assignment = messages.findLastIndex(
      (message) => message.role === "user" && message.text.includes(BASIS_PROBE),
    );
    if (assignment < 0) return undefined;
    if (calledTool(body, "report")) return { text: "The check is complete." };
    const { readings, pending } = browserShellMessages(messages);
    if (pending) return { text: "" };
    const result = readings
      .slice(assignment + 1)
      .findLast((message) => message.role === "tool")?.text;
    if (result === undefined) {
      const path = messages[assignment]?.text.match(/BASIS_FILE=(\/[^\s"<>]+)/)?.[1];
      return {
        calls: [
          {
            name: "bash",
            args: {
              command: path
                ? `cat ${JSON.stringify(path)}`
                : `printf '%s\\n' '${BASIS_EVIDENCE}' > basis-evidence.txt; printf 'BASIS_FILE=%s/basis-evidence.txt\\n' "$PWD"`,
            },
          },
        ],
      };
    }
    const path = result.match(/BASIS_FILE=(\/[^\s"<>]+)/)?.[1];
    return {
      calls: [
        {
          name: "report",
          args: {
            text: path
              ? `Reproduction ready. BASIS_FILE=${path}`
              : result.includes(BASIS_EVIDENCE)
                ? BASIS_EVIDENCE
                : `Evidence read failed: ${result}`,
          },
        },
      ],
    };
  };
