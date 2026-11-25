import type { FmEvent } from "@shared/events";
import { frameServedInput } from "@shared/servedFrame";
import { TAKE_BACK_WINDOW_MS, type TakeBackRefusal, type TakeBackResult } from "@shared/takeBack";
import { throughNow } from "../askedFromTheCommand";
import { FIRSTMATE_RECIPIENT, type InboxRow, type InboxStore } from "../storage/inboxStore";
import type { TaskService } from "../tasks/taskService";
import { excerptOf } from "./answerDelivery";
import type { AskCapture } from "./askCapture";
import { takenBackHeldWake, takenBackWake } from "./captainWakes";
import type { ServedInput } from "./decisionCapture";
import { renderWake, type TypedWake } from "./wakes";

/**
 * Taking back a message (docs/task-capture.md, "Taking back a message"):
 * the typed facts the first mate's agent reads to withdraw, refuse and
 * undo what a message the captain took back would cause. The record write
 * is `TaskCapture.takeBack`; the agent owns when each step runs.
 */

/**
 * The reply line's English for a message taken back before any turn read
 * it, for a reader without the window's words; the window words it from
 * the line's `withdrawn`.
 */
// i18n-exempt: a reader with no words of its own draws it; the window words the line from `withdrawn`
export const WITHDRAWN_LINE = "Taken back before your first mate read it.";

/**
 * The receipt of a message just saved (`user_turn`), sent after its ask
 * opens: its id and time let any window take it back without a reload.
 */
export function receiptOf(text: string, ask: { id: string; at: number }): FmEvent {
  const through = throughNow();
  return {
    type: "user_turn",
    text,
    ...(through ? { through } : {}),
    askId: ask.id,
    sentAt: ask.at,
  };
}

/** The inbox ref the taken-back wake rides; its once-name keeps it to one per message. */
export const TAKEN_BACK_REF = "taken-back";

/** Why a take back of this message changes nothing, or undefined when it may go ahead. */
export function takeBackRefusal(
  tasks: TaskService,
  askId: string,
  now: number,
  window = true,
): TakeBackRefusal | undefined {
  const ask = tasks.capture.getAsk(askId);
  if (!ask) return "unknown";
  if (ask.takenBackAt !== undefined) return "taken-back";
  if (tasks.capture.latestAskId() !== askId) return "not-newest";
  if (window && now - ask.at > TAKE_BACK_WINDOW_MS) return "past-window";
  return undefined;
}

function carries(row: InboxRow, askId: string): boolean {
  return row.facts?.kind === "captain-turn" && row.facts.askId === askId;
}

/** Whether a lane row carrying the message's words was handed to a running turn. */
export function inFlight(inbox: InboxStore, askId: string): boolean {
  return inbox.inFlight(FIRSTMATE_RECIPIENT).some((row) => carries(row, askId));
}

/**
 * Takes the message's words off the lane where no turn was handed them
 * (`InboxStore.withdraw`). Answers whether any were withdrawn.
 */
export function withdrawWaiting(inbox: InboxStore, askId: string): boolean {
  const rows = inbox.allFor(FIRSTMATE_RECIPIENT).filter((row) => carries(row, askId));
  return inbox.withdraw(rows.map((row) => row.id)).length > 0;
}

/** The first message the turn read that the captain took back, if any. */
export function takenBackOf(tasks: TaskService, askIds: Iterable<string>): string | undefined {
  for (const id of askIds) {
    if (tasks.capture.getAsk(id)?.takenBackAt !== undefined) return id;
  }
  return undefined;
}

/**
 * The asks the take-back gate counts a tool call as credited to, as the
 * delivery record credits them: the message `ask_id` names, none for an
 * empty `ask_id`, and every message the turn read for a call naming none.
 */
export function creditedAsks(params: unknown, read: ReadonlySet<string>): readonly string[] {
  const declared =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>).ask_id
      : undefined;
  if (typeof declared === "string") return declared ? [declared] : [];
  return [...read];
}

// i18n-exempt: served to the first mate as a refusal, never shown to a person
export const TAKEN_BACK_NAMED =
  'ask_id names a message the captain took back: nothing more is done for it. Name another message, or set ask_id to "" for unrelated work.';

/** The tool text a call meets when it would be credited to a taken-back message. */
export function takenBackRefusalText(askId: string): string {
  // i18n-exempt: served to the first mate as a refusal, never shown to a person
  return `The captain took back message ${askId}, so this call is refused and nothing happened. Work for another message names that message's ask_id; unrelated work sets ask_id to "". What the message already caused is listed for you to undo once this turn ends.`;
}

function facts(tasks: TaskService, askId: string, replacement?: string) {
  const ask = tasks.capture.getAsk(askId);
  if (!ask) return undefined;
  const caused = ask.deliveryFacts.entries.flatMap((entry) => {
    if (entry.outcome !== "action" || entry.kind === "reaction") return [];
    const task = entry.ref ? tasks.get(entry.ref) : undefined;
    return [
      {
        tool: entry.tool,
        ...(task
          ? { task: { id: task.id, key: task.key || task.id, title: task.title } }
          : entry.ref
            ? { ref: entry.ref }
            : {}),
      },
    ];
  });
  return {
    askId,
    excerpt: excerptOf(ask.text),
    sentAt: new Date(ask.at).toISOString(),
    caused,
    ...(replacement !== undefined ? { replacement: excerptOf(replacement) } : {}),
  };
}

/** The live steer for the turn holding the message. */
export function heldWake(
  tasks: TaskService,
  askId: string,
  replacement?: string,
): TypedWake | undefined {
  const found = facts(tasks, askId, replacement);
  return found ? takenBackHeldWake(found) : undefined;
}

/**
 * Queues the one wake asking the first mate to undo what the message
 * caused, once per message. The replacement is the newer message whose
 * `correction_of` names it.
 */
export function queueTakenBackWake(
  tasks: TaskService,
  inbox: InboxStore,
  askId: string,
): number | null {
  const replacement = tasks.capture.replacementOf(askId);
  const found = facts(tasks, askId, replacement?.text);
  if (!found) return null;
  return inbox.enqueueCaptainOnce(FIRSTMATE_RECIPIENT, takenBackWake(found), TAKEN_BACK_REF);
}

/** What the first mate's agent lends the take back: its record, its lane and its running turn. */
export type TakeBackHost = {
  tasks: TaskService;
  inbox: InboxStore;
  asks: AskCapture;
  now(): number;
  /** Whether a running turn read the message or holds its live words. */
  holds(askId: string): boolean;
  /** Tells the running turn at once; best effort, as the refusal gate holds without it. */
  steer(input: ServedInput): void;
  /** The message leaves the turn's unread list. */
  forget(askId: string): void;
  broadcastEvent(event: FmEvent): void;
  /** Serves a queued wake now if the seat is idle. */
  drain(): void;
};

/**
 * When each step of a take back runs, for the first mate's agent: withdrawn
 * if no turn read the message, refused every action for it while a turn
 * holds it, and one wake asking the first mate to undo what it caused once
 * no turn holds it.
 */
export class TakeBacks {
  /** Messages taken back while a running turn held them: their undo is asked for when it ends. */
  private readonly held = new Set<string>();
  /**
   * Messages saved but not yet handed to a turn, while sending them awaits
   * a session or admission (false) or a steer the running turn may already
   * read (true). A steer's mark ends with that turn, or when it is refused.
   */
  private readonly handingOff = new Map<string, boolean>();
  /** Messages whose undo wake the running turn was served: its reply line is theirs. */
  private readonly undoing = new Set<string>();

  constructor(private readonly host: TakeBackHost) {}

  /** The captain takes back their newest message within the window. */
  takeBack(askId: string): TakeBackResult {
    const refusal = takeBackRefusal(this.host.tasks, askId, this.host.now());
    if (refusal) return { outcome: "refused", reason: refusal };
    if (!this.host.tasks.capture.takeBack(askId))
      return { outcome: "refused", reason: "taken-back" };
    return { outcome: this.after(askId) };
  }

  /**
   * The message a new one replaces, when it may: the newest and not taken
   * back. No window applies, since the mark was shown while the draft was open.
   */
  replaces(turn: string | { replaces?: string }): string | undefined {
    const askId = typeof turn === "string" ? undefined : turn.replaces;
    if (!askId || takeBackRefusal(this.host.tasks, askId, this.host.now(), false)) return undefined;
    return askId;
  }

  /** After the replacement opened, taking `askId` back in the same write. */
  replaced(askId: string, replacement: string): void {
    this.after(askId, replacement);
  }

  /** The message is on its way to a turn; `steering` once its words were sent into a running one. */
  handing(askId: string, steering = false): void {
    this.handingOff.set(askId, steering);
  }

  /** Whether the captain took back a message still being handed on, so its words are dropped. */
  dropped(askId: string): boolean {
    if (this.host.tasks.capture.getAsk(askId)?.takenBackAt === undefined) return false;
    this.handingOff.delete(askId);
    return true;
  }

  private after(askId: string, replacement?: string): "withdrawn" | "stopping" | "undoing" {
    const { inbox, tasks } = this.host;
    const withdrawn = withdrawWaiting(inbox, askId);
    const handing = this.handingOff.get(askId);
    if (inFlight(inbox, askId) || this.host.holds(askId) || handing === true) {
      this.held.add(askId);
      const wake = heldWake(tasks, askId, replacement);
      const body = wake && renderWake(wake);
      if (body)
        this.host.steer({ framed: frameServedInput([{ kind: "user", body, origin: "captain" }]) });
      return "stopping";
    }
    this.host.forget(askId);
    this.host.asks.closeTakenBack(askId);
    // Not read yet: the hand-off drops the words when it sees the take back.
    if (handing === false) return this.withdrawn(askId);
    // Words a failed turn read and parked again may already have caused something.
    const caused = tasks.capture
      .getAsk(askId)
      ?.deliveryFacts.entries.some((entry) => entry.outcome === "action");
    if (withdrawn && !caused) return this.withdrawn(askId);
    queueTakenBackWake(tasks, inbox, askId);
    this.host.drain();
    return "undoing";
  }

  /** No turn read the message, so no turn's line will stand beside it: this typed one does. */
  private withdrawn(askId: string): "withdrawn" {
    const reply = { text: WITHDRAWN_LINE, eligibility: "completed", withdrawn: true } as const;
    this.host.tasks.capture.setAskReply(askId, reply);
    this.host.broadcastEvent({ type: "firstmate_reply", ...reply, askId });
    return "withdrawn";
  }

  /** The batch a turn is served: each undo wake in it names the message the turn undoes. */
  serving(rows: readonly InboxRow[]): void {
    this.undoing.clear();
    for (const row of rows)
      if (row.facts?.kind === "taken-back" && row.facts.stage === "ended")
        this.undoing.add(row.facts.askId);
  }

  /**
   * Where the running turn's reply line goes (docs/task-capture.md, "Taking
   * back a message"): the newest message when the turn read it, as for any
   * turn; else, for a turn that read no message, each message whose undo
   * it was served, so the line saying what was undone stands beside the
   * message the captain took back.
   */
  replyTargets(read: readonly string[]): readonly string[] {
    const latest = this.host.tasks.capture.latestAskId();
    if (latest && read.includes(latest)) return [latest];
    return read.length === 0 ? [...this.undoing] : [];
  }

  /** Before the turn's capture floor: a held message's words never wait on the lane for another turn. */
  beforeFloor(): void {
    for (const id of this.held) withdrawWaiting(this.host.inbox, id);
  }

  /**
   * A turn ended, or boot found asks a turn never ended: each taken-back
   * message it held or read leaves the lane, closes, and the first mate is
   * asked once to undo what it caused.
   */
  ended(read: Iterable<string>): void {
    const ids = new Set([...this.held, ...read]);
    this.held.clear();
    this.undoing.clear();
    // A steer the turn never read is parked on the lane again, where a take back withdraws it.
    for (const [id, steering] of this.handingOff) if (steering) this.handingOff.delete(id);
    for (const id of ids) {
      this.handingOff.delete(id);
      if (this.host.tasks.capture.getAsk(id)?.takenBackAt === undefined) continue;
      withdrawWaiting(this.host.inbox, id);
      this.host.asks.closeTakenBack(id);
      queueTakenBackWake(this.host.tasks, this.host.inbox, id);
    }
  }
}
