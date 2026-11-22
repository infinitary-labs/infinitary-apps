/**
 * Guidance still waiting for a task's crewmate (INF-4072, finding 4): the
 * messages its lane holds that no turn finished with, named so the first
 * mate can tell which one holds a close and drop one the crewmate no
 * longer needs (`settle_task` done, `drop_waiting`).
 *
 * A message set aside after its refusals (`escalatedAt`) went to the first
 * mate instead and is never delivered, so it is not waiting (INF-3307).
 */

import type { InboxRow, InboxStore } from "../storage/inboxStore";
import { excerptOf as clip } from "./answerDelivery";
import type { WaitingMessage } from "./waitingWords";
import { renderWake, replyWordsSpan, type WakeBody } from "./wakes";

/**
 * The message's own words, on one line and clipped at a character boundary:
 * a carrier's guidance unwrapped, and the captain's verbatim words alone
 * where a thread reply or a Crewmate tab line puts the host's lead before
 * them (`replyWordsSpan`); any other message as it is served.
 */
function excerptOf(row: InboxRow): string {
  let wake: WakeBody = row.facts
    ? { facts: row.facts, ...(row.ways ? { ways: row.ways } : {}) }
    : (row.text ?? "");
  while (typeof wake !== "string" && "guidance" in wake.facts) {
    const guidance = wake.facts.guidance;
    if (typeof guidance === "string") wake = guidance;
    else if (guidance && !Array.isArray(guidance)) wake = { facts: guidance };
    else break;
  }
  const served = renderWake(wake);
  const span = replyWordsSpan(wake);
  return clip(span ? served.slice(span.from, span.to) : served);
}

export function waitingGuidance(inbox: InboxStore, taskId: string, now: number): WaitingMessage[] {
  const rows = [
    ...inbox.allFor(taskId).filter((row) => row.escalatedAt === null),
    ...inbox.inFlight(taskId),
  ].sort((a, b) => a.id - b.id);
  return rows.map((row) => ({
    id: row.id,
    ageMs: Math.max(0, now - row.createdAt),
    state: row.deliveredAt !== null ? "handed" : row.attempts > 0 ? "tried" : "queued",
    attempts: row.attempts,
    excerpt: excerptOf(row),
  }));
}

/**
 * Drop the named messages from a task's lane while no turn runs (the
 * caller checks): a message not yet handed is taken back, and one a turn
 * was handed and never finished with is let go first. Ids that are not waiting for this task
 * are left alone. Answers the messages it dropped.
 */
export function dropWaiting(
  inbox: InboxStore,
  taskId: string,
  ids: readonly number[],
  now: number,
): WaitingMessage[] {
  const wanted = new Set(ids);
  const named = waitingGuidance(inbox, taskId, now).filter((message) => wanted.has(message.id));
  if (named.length === 0) return [];
  return inbox.transaction(() => {
    const handed = named.filter((message) => message.state === "handed").map((m) => m.id);
    if (handed.length > 0) inbox.release(handed);
    const taken = new Set(inbox.withdraw(named.map((message) => message.id)));
    // A response request whose message is dropped is cancelled by the same
    // declaration: nothing will deliver it now.
    for (const request of inbox.pendingResponses(taskId))
      if (taken.has(request.inboxId)) inbox.cancelResponse(request.id);
    return named.filter((message) => taken.has(message.id));
  });
}
