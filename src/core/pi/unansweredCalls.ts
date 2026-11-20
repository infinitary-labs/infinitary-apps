import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * What a reopened record says for a tool call the app stopped in the middle
 * of (a quit, a restart or a crash ends the process before the running tool
 * returns, so its result is never saved). The call may have taken effect -
 * a crewmate may have started - so the answer says the outcome is unknown,
 * never that the call failed, and the model checks before repeating it.
 */
export const UNANSWERED_CALL_TEXT =
  "No result was saved for this call: the app stopped while it was running, so its outcome is unknown. It may have taken effect. Check whether it did before repeating it.";

type MessageEntry = Extract<SessionEntry, { type: "message" }>;

function failedAssistant(entry: MessageEntry): boolean {
  const message = entry.message;
  return (
    message.role === "assistant" &&
    (message.stopReason === "error" || message.stopReason === "aborted")
  );
}

/** What a turn the model never answered leaves: its user message, its failed reply, a stamp. */
function refusedTurn(entry: SessionEntry): boolean {
  if (entry.type === "custom") return true;
  return entry.type === "message" && (entry.message.role === "user" || failedAssistant(entry));
}

/**
 * Answer the tool call on the record's active path that has no saved
 * result, before the session is built from it. Pi's providers would
 * otherwise send a stand-in "No result provided" (which reads as a failure
 * and invites a duplicate), and a custom API connection refuses the history
 * outright, so every later turn fails (INF-3089).
 *
 * The answer goes right after the call's own results. When the call ends
 * the path, it is appended there. When only turns that never reached the
 * model follow it (a user message and its failed reply, as each refused
 * turn leaves), the path branches after the call, the answer is written,
 * and those messages are written again after it; the old branch stays in
 * the file. Any other later history means a provider already accepted the
 * record with its own stand-in, so that call is left as it is. Returns how
 * many calls it answered.
 */
export function answerUnansweredCalls(manager: SessionManager, now = Date.now()): number {
  const path = manager.getBranch();
  for (let index = 0; index < path.length; index++) {
    const entry = path[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant" || failedAssistant(entry))
      continue;
    const calls = entry.message.content.filter((part) => part.type === "toolCall");
    if (calls.length === 0) continue;
    const answered = new Set<string>();
    let end = index;
    for (let next = index + 1; next < path.length; next++) {
      const later = path[next];
      if (later?.type !== "message") continue;
      if (later.message.role !== "toolResult") break;
      answered.add(later.message.toolCallId);
      end = next;
    }
    const missing = calls.filter((call) => !answered.has(call.id));
    if (missing.length === 0) continue;
    const tail = path.slice(end + 1);
    if (!tail.every(refusedTurn)) continue;
    const at = path[end];
    if (at && at.id !== manager.getLeafId()) manager.branch(at.id);
    for (const call of missing) {
      const answer: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: UNANSWERED_CALL_TEXT }],
        isError: true,
        timestamp: now,
      };
      manager.appendMessage(answer);
    }
    for (const later of tail) {
      if (later.type !== "message") {
        if (later.type === "custom") manager.appendCustomEntry(later.customType, later.data);
      } else if (later.message.role === "user" || later.message.role === "assistant")
        manager.appendMessage(later.message);
    }
    return missing.length;
  }
  return 0;
}
