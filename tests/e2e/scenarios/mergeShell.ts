import type { ScriptedCall } from "../../helpers/scriptedCalls";
import { browserShellMessages } from "../browserScript";
import { providerMessages, requestToolNames } from "../providerRequest";

/**
 * INF-1342: a git job's receipt is not its output, and its exit is not a
 * new assignment. Keep the merge script on the same command across that
 * turn boundary, using the existing shell-message reader.
 */
export function mergeShellTurn(body: string, marker: string) {
  const { readings, pending } = browserShellMessages(providerMessages(body));
  // A check-back ask about the running command is supervision, not a new
  // merge assignment. Only this scenario's named assignment advances it.
  const at = readings.findLastIndex(
    (message) => message.role === "user" && message.text.includes(marker),
  );
  return {
    user: readings[at]?.text ?? "",
    results: readings
      .slice(at + 1)
      .flatMap((message) => (message.role === "tool" ? [message.text] : [])),
    pending,
  };
}

/** Exercise the job-exit path on Pi even on a quiet host; Claude owns its own shell. */
export function mergeShellCall(body: string, command: string): ScriptedCall {
  return {
    name: "bash",
    args: {
      command,
      ...(requestToolNames(body).includes("bash") ? { background: true } : {}),
    },
  };
}
