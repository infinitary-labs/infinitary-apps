import { randomUUID } from "node:crypto";
import type { AttachmentRef } from "@shared/attachments";
import type { AskAttachedVia, AskImage, AskRecord } from "../storage/askStore";
import type { TaskRecord } from "../storage/taskStore";
import type { TaskService } from "../tasks/taskService";

/**
 * The capture guarantee (task-system design section 6, captain requirement
 * 1 and decision D1): every captain ask lands in a task. The row is opened
 * before the Firstmate turn runs; the agent's own tool calls attach it to
 * the task they act on (attach first - an ask about existing work lands on
 * that work); and at turn end the HOST attaches whatever is still loose:
 * to the hinted task when the open card pointed at one, else as a
 * standalone question task filed closed. Failed turns file too, apart from
 * a message whose words go back on the lane for a retry.
 *
 * The owner selects the current ask at its read witness and names the asks
 * a turn end closes; merely queueing a steer does not answer it, so an
 * unread ask stays open for the turn that reads it, and a read one whose
 * words wait for a retry stays open for the turn that serves them again. A
 * turn a quit or crash cut is closed at the next boot the same way, marked
 * failed, apart from a message whose words still wait on the lane.
 * Operational [fm-op] wakes open no ask and get no fallback - their tool
 * calls still write the task-side records (a decision task, an answered
 * event), they just have no captain words to attach.
 *
 * `attachedVia` is the attribution-quality signal: `tool:<name>` means the
 * agent found the task; `host:fallback` means the floor held. The share of
 * fallbacks is what dogfood watches.
 */

export const ASK_TITLE_MAX = 64;

export type OpenTurnAsk = {
  text: string;
  images?: AskImage[];
  /** The message's own copies of its pictures, kept when it was accepted. */
  attachments?: AttachmentRef[] | undefined;
  hintTaskId?: string | undefined;
  /** The message this one sends again (Ask again on the answer-delivery notice). */
  retryOf?: string | undefined;
};

export type EndTurnInput = {
  /**
   * The asks this end closes: those the turn read, apart from one whose
   * words wait on the lane for a retry, or the one message an early failure
   * answers. Every other open ask - one parked on the lane for a turn of its
   * own - stays open, so the turn that serves it attaches and closes it.
   */
  asks: readonly string[];
  failed: boolean;
  /** The turn's closing assistant text (the answer a fallback question keeps). */
  closingText?: string | undefined;
  error?: string | undefined;
};

export type FallbackResult = {
  askId: string;
  via: "hint" | "question";
  taskId: string;
};

/** The first sentence of the ask, clipped, as a question task's title. */
export function askTitle(text: string, images: AskImage[] = []): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return images.length > 0 ? "Image attachment" : "Empty turn";
  const sentence = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  const clipped = sentence.length <= ASK_TITLE_MAX ? sentence : sentence.slice(0, ASK_TITLE_MAX);
  return clipped.trim() || flat.slice(0, ASK_TITLE_MAX);
}

export class AskCapture {
  /** The ask the in-flight tool calls attach to. */
  private currentAskId: string | undefined;

  /**
   * `onAttach` hears every tool attribution, with or without an ask - a
   * drain has no ask, yet its tools still act on tasks, and the turn's
   * decision record (R2) must know which.
   */
  constructor(
    private readonly tasks: TaskService,
    private readonly onAttach?: (taskId: string, tool: string) => void,
  ) {}

  /**
   * A captain turn begins: open its ask before anything runs. The new ask
   * is the current one from this moment, so a steer mid-turn re-points the
   * turn's later tool calls at the words that caused them.
   */
  open(input: OpenTurnAsk): AskRecord {
    const hint = input.hintTaskId && this.tasks.get(input.hintTaskId) ? input.hintTaskId : null;
    const record = this.tasks.openAsk({
      id: randomUUID().slice(0, 8),
      text: input.text,
      images: input.images ?? [],
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      hintTaskId: hint,
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    });
    this.currentAskId = record.id;
    return record;
  }

  /**
   * A turn starts running (a captain prompt or an inbox drain): adopt every
   * still-open ask as its scope, the latest one current. A drain with no
   * open ask is an operational wake and attaches nothing.
   */
  beginTurn(): void {
    const open = this.tasks.listOpenAsks();
    this.currentAskId = open.at(-1)?.id;
  }

  /** The owner's read witness selects which message in-flight tools may attach. */
  select(askId: string | undefined): void {
    this.currentAskId = askId;
  }

  current(): AskRecord | undefined {
    return this.currentAskId ? this.tasks.getAsk(this.currentAskId) : undefined;
  }

  /** The copies of the current message's pictures: what a tool acting on it carries along. */
  currentPictures(): AttachmentRef[] {
    return this.current()?.attachments ?? [];
  }

  /** The task the current ask's card or panel pointed at, if it still exists. */
  hintedTask(): TaskRecord | undefined {
    const ask = this.current();
    return ask?.hintTaskId ? this.tasks.get(ask.hintTaskId) : undefined;
  }

  /**
   * A tool acted on a task: the current ask is about it. No-op on an
   * operational wake (no ask) or an unknown task - the tool's own error
   * already said so.
   */
  attach(taskId: string, tool: string): boolean {
    this.onAttach?.(taskId, tool);
    if (!this.currentAskId) return false;
    if (!this.tasks.get(taskId)) return false;
    return this.tasks.attachAsk(this.currentAskId, taskId, `tool:${tool}` as AskAttachedVia);
  }

  /**
   * The turn ended: each open ask it names closes, and whatever nothing
   * attached is attached now - to the hinted task, else as a standalone
   * question task born closed in Scratch. Returns the fallbacks it had to take.
   */
  endTurn(input: EndTurnInput): FallbackResult[] {
    const fallbacks: FallbackResult[] = [];
    for (const ask of this.tasks.listOpenAsks()) {
      if (!input.asks.includes(ask.id)) continue;
      const fallback = this.settle(ask, input);
      if (fallback) fallbacks.push(fallback);
      this.tasks.closeAsk(ask.id, input.failed ? "failed" : "closed");
    }
    this.currentAskId = undefined;
    return fallbacks;
  }

  /**
   * Boot: asks the last process left open never got their turn end. They
   * are filed now, marked failed, so a quit mid-turn loses no ask. An ask
   * whose words still wait on the lane (`waiting`) is not stranded: the
   * turn that serves them reads it, attaches it and closes it.
   */
  reconcileStranded(waiting: readonly string[]): FallbackResult[] {
    const stranded = this.tasks
      .listOpenAsks()
      .map((ask) => ask.id)
      .filter((id) => !waiting.includes(id));
    if (stranded.length === 0) return [];
    return this.endTurn({
      asks: stranded,
      failed: true,
      error: "the app closed before this turn ended",
    });
  }

  private settle(ask: AskRecord, input: EndTurnInput): FallbackResult | undefined {
    if (ask.taskId) return undefined;
    const hinted = ask.hintTaskId ? this.tasks.get(ask.hintTaskId) : undefined;
    if (hinted) {
      this.tasks.attachAsk(ask.id, hinted.id, "host:fallback");
      return { askId: ask.id, via: "hint", taskId: hinted.id };
    }
    const outcome = input.failed
      ? `hit a problem: ${input.error ?? "unknown error"}`
      : input.closingText?.trim() || null;
    const task = this.tasks.fileQuestion({
      id: randomUUID().slice(0, 8),
      title: askTitle(ask.text, ask.images),
      outcome,
      actor: "host",
      fallback: "question",
    });
    this.tasks.attachAsk(ask.id, task.id, "host:fallback");
    return { askId: ask.id, via: "question", taskId: task.id };
  }
}
