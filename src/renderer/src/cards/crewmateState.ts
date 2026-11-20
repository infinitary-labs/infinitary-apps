import type { CrewLine, CrewLive, CrewTranscript } from "@shared/crewTranscript";
import { browserDriverOf } from "@shared/taskBrowser";
import type { TaskDetail } from "@shared/tasks";

/**
 * Where the crewmate stands, as the Crewmate tab's status line reads it
 * (docs/task-card-tabs.md, "The Crewmate tab"): its turn running, the
 * captain holding its browser, a card of its waiting on him, idle, or the
 * task closed - read from the task's typed state, never from words.
 */
export type CrewState = "working" | "paused" | "waiting" | "idle" | "closed";

export function crewStateOf(detail: TaskDetail, live: CrewLive | null): CrewState {
  if (detail.status === "done" || detail.status === "dropped") return "closed";
  if (detail.browser && browserDriverOf(detail, detail.browser) === "captain") return "paused";
  if (detail.activity === "running" || detail.activity === "starting" || live?.since != null) {
    return "working";
  }
  if (detail.waitingCardId || detail.flags.needsYou || detail.captainWait) return "waiting";
  return "idle";
}

/**
 * What the crewmate is writing now that its session does not show yet:
 * nothing once the transcript's newest words already hold it, so the same
 * words never read twice while the session catches up.
 */
export function liveWords(transcript: CrewTranscript | null, live: CrewLive | null): string {
  const text = live?.text.trim() ?? "";
  if (!text) return "";
  const last = transcript?.lines.findLast((line) => line.kind === "said");
  return last && last.kind === "said" && last.text.includes(text) ? "" : text;
}

/**
 * Whether a call that has not answered is running now: while the turn
 * runs, a call after the last line the crewmate was sent; otherwise it
 * never answered.
 */
export function runningCalls(lines: readonly CrewLine[], working: boolean): Set<string> {
  const running = new Set<string>();
  if (!working) return running;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    if (line.kind === "sent" && !line.queued) break;
    if (line.kind === "tool" && line.result === null) running.add(line.id);
  }
  return running;
}

/** The card a card block names on the task's record: by its id, else the newest with its title. */
export function cardOfBlock(
  detail: Pick<TaskDetail, "id" | "cards">,
  block: Extract<CrewLine, { kind: "card" }>,
): TaskDetail["cards"][number] | undefined {
  if (block.cardId) {
    // As the card layer names a crewmate's card from the id it gave (`CardService`).
    const own = `card-${detail.id}-`;
    const id = block.cardId.startsWith(own) ? block.cardId : `${own}${block.cardId}`;
    const named = detail.cards.find((card) => card.id === id);
    if (named) return named;
  }
  return detail.cards.find((card) => card.title === block.title);
}

/** A typed line's draft per task, kept while the card hides and shows again; never saved. */
const drafts = new Map<string, string>();

export const crewDraftOf = (taskId: string): string => drafts.get(taskId) ?? "";

export function keepCrewDraft(taskId: string, text: string): void {
  if (text) drafts.set(taskId, text);
  else drafts.delete(taskId);
}
