import type { Card } from "@shared/cards";
import { FIRSTMATE_RECIPIENT, type InboxRow, type InboxStore } from "../storage/inboxStore";
import type { TaskService } from "../tasks/taskService";
import {
  type DeliveryEntry,
  type DeliveryNote,
  excerptOf,
  judgeDelivery,
  noticeCard,
  noticeCardId,
  refusalOf,
} from "./answerDelivery";
import { answerMissingWake } from "./wakes";

/**
 * The inbox ref the answer-missing wake rides. The wake's once-name
 * (`answer-repair:<askId>`) is what keeps it to one retry per message.
 */
export const ANSWER_MISSING_REF = "answer-missing";

/** What the check needs from the app: the saved record, the lane, the stack. */
export type AnswerDeliveryHost = {
  tasks: TaskService;
  inbox: InboxStore;
  now: () => number;
  /** Put the one notice on the stack (a host card; its own record, no crewmate task). */
  raiseNotice: (card: Pick<Card, "id" | "title" | "meta" | "body" | "actions">) => void;
  /** The title of a card the captain replied under, when it is still on the stack. */
  cardTitle: (cardId: string) => string | undefined;
  /**
   * Judge nothing: no verdict, no retry, no notice. The replay harness and
   * the developer evaluations replay turns whose outcome is recorded, and the
   * replay scores delivery from the recording itself
   * (`asks_without_action`); the app never runs in this mode.
   */
  observe?: boolean;
};

/** A turn's scope: the messages it read, with the card each was a reply under. */
export type DeliveryTurnEnd = {
  /** The messages the turn opened or took in, still open when it ended. */
  asks: readonly string[];
  /** The turn failed or paused: its messages wait for the turn that serves them again. */
  held: boolean;
  /** Messages steered in that the session never delivered; their turn is a later one. */
  unread: readonly string[];
};

/**
 * Answer delivery, the stateful half (docs/task-capture.md "Answer
 * delivery"). It records, where each action succeeds, a fact against every
 * message the running turn has read; judges those messages when the turn
 * ends, after the normal card and thread capture; queues the one
 * output-only retry; and raises the one notice. The saved state lives on
 * `captain_asks` through `TaskService`, so a restart resumes where it
 * stopped and no message gets a second retry or notice.
 *
 * Which messages a turn has read is typed state, never the words: the asks
 * still open (the live one, and every steer it took in), plus the saved
 * messages a parked row or the retry wake carried back.
 */
export class AnswerDeliveryCheck {
  private adopted = new Set<string>();
  private about = new Map<string, string>();
  private retryAsk: string | undefined;

  constructor(private readonly host: AnswerDeliveryHost) {}

  /** The running turn is the one output-only retry: it may only show an answer. */
  get outputOnly(): boolean {
    return this.retryAsk !== undefined;
  }

  /** A message was a reply under one of Firstmate's own cards. */
  noteAbout(askId: string, cardId: string | undefined): void {
    if (cardId) this.about.set(askId, cardId);
  }

  /**
   * A drained batch carries saved messages back: parked captain words name
   * theirs, the answer-missing wake names the one it retries (and is judged
   * as retrying from here on).
   */
  adopt(rows: readonly InboxRow[], aboutOf: (row: InboxRow) => string | undefined): void {
    for (const row of rows) {
      const facts = row.facts;
      if (facts?.kind === "captain-turn" && facts.askId) {
        this.adopted.add(facts.askId);
        this.noteAbout(facts.askId, aboutOf(row));
      } else if (facts?.kind === "answer-missing") {
        this.adopted.add(facts.askId);
        this.noteAbout(facts.askId, facts.aboutCard?.id);
        this.retryAsk = facts.askId;
        if (this.host.tasks.getAsk(facts.askId)?.delivery !== "retrying") {
          this.host.tasks.setAskDelivery(facts.askId, "retrying");
        }
      }
    }
  }

  /** The saved messages a drained batch carried back to the running turn. */
  adoptedAsks(): string[] {
    return [...this.adopted];
  }

  /** The messages the running turn has read so far. */
  private scope(): string[] {
    return [...new Set([...this.host.tasks.listOpenAsks().map((ask) => ask.id), ...this.adopted])];
  }

  /**
   * Something succeeded or was refused after the running turn read these
   * messages. A refused or thrown call is saved as a refusal only for a
   * card; lookups are never saved at all.
   */
  // The live agent supplies backend-witnessed reads; standalone record users
  // retain the capture scope when they have no session witness.
  note(entry: DeliveryNote, read: readonly string[] = this.scope()): void {
    this.save(read, entry);
  }

  /** Closing words written into a card's replies count for the messages that were replies under it. */
  creditReply(cardId: string): void {
    const askIds = [...this.about].filter(([, about]) => about === cardId).map(([id]) => id);
    this.save(askIds, { outcome: "action", kind: "reply", tool: "reply", ref: cardId });
  }

  private save(askIds: readonly string[], entry: DeliveryNote): void {
    if (askIds.length === 0) return;
    try {
      this.host.tasks.noteDelivery(askIds, { ...entry, at: this.host.now() } as DeliveryEntry);
    } catch (caught) {
      console.warn("[firstmate] answer delivery could not save a fact:", caught);
    }
  }

  /**
   * The turn ended, and its cards and thread answers are already captured:
   * judge each message it read. A turn that failed or paused holds them for
   * the turn that serves them again; a message it never read waits, with no
   * facts of this turn, for the one that does.
   */
  endTurn(end: DeliveryTurnEnd): void {
    const unread = new Set(end.unread);
    const scope = [...new Set([...end.asks, ...this.adopted])];
    try {
      if (this.host.observe) return;
      for (const id of scope) {
        try {
          if (unread.has(id)) this.host.tasks.releaseAskDelivery(id);
          else if (end.held) this.hold(id);
          else this.judge(id);
        } catch (caught) {
          console.warn("[firstmate] answer delivery could not judge a message:", caught);
        }
      }
    } finally {
      this.clear();
    }
  }

  /**
   * The purge control emptied the lane: a retry still waiting on it is gone,
   * and a message nobody can retry gets no notice either - it ends unresolved.
   */
  lanePurged(): void {
    for (const ask of this.host.tasks.listAsksByDelivery("retrying")) {
      this.host.tasks.setAskDelivery(ask.id, "unresolved");
    }
  }

  /** Forget the running turn's scope. */
  clear(): void {
    this.adopted.clear();
    this.about.clear();
    this.retryAsk = undefined;
  }

  private hold(id: string): void {
    const ask = this.host.tasks.getAsk(id);
    if (ask?.delivery === "pending") this.host.tasks.setAskDelivery(id, "held");
  }

  /** One message, judged from its saved facts. */
  private judge(id: string): void {
    const ask = this.host.tasks.getAsk(id);
    if (!ask) return;
    const verdict = judgeDelivery(ask.delivery, ask.deliveryFacts.entries);
    if (verdict === "covered") this.host.tasks.setAskDelivery(id, "covered");
    else if (verdict === "retry") this.retry(id);
    else if (verdict === "notice") this.notify(id);
  }

  /** The one retry: a typed wake, queued before the state moves so a restart finds one or the other. */
  private retry(id: string): void {
    const ask = this.host.tasks.getAsk(id);
    if (!ask) return;
    const refusal = refusalOf(ask.deliveryFacts.entries);
    const filed = ask.taskId ? this.host.tasks.get(ask.taskId) : undefined;
    const aboutId = this.about.get(id);
    const aboutTitle = aboutId ? this.host.cardTitle(aboutId) : undefined;
    this.host.inbox.enqueueWake(
      FIRSTMATE_RECIPIENT,
      answerMissingWake({
        askId: id,
        excerpt: excerptOf(ask.text),
        ...(filed ? { filedOn: { id: filed.id, title: filed.title } } : {}),
        ...(aboutId ? { aboutCard: { id: aboutId, title: aboutTitle ?? aboutId } } : {}),
        ...(refusal?.outcome === "refused"
          ? { refusal: refusal.reason, ...(refusal.ref ? { ownedBy: refusal.ref } : {}) }
          : {}),
      }),
      "agent",
      ANSWER_MISSING_REF,
    );
    this.host.tasks.setAskDelivery(id, "retrying");
  }

  /** The one notice, raised under a fixed id and marked on the message so it is never raised again. */
  private notify(id: string): void {
    const ask = this.host.tasks.getAsk(id);
    if (!ask || ask.noticeCardId) return;
    this.host.raiseNotice(noticeCard(id, ask.text, ask.deliveryFacts.entries));
    this.host.tasks.markAskUnresolved(id, noticeCardId(id));
  }

  /**
   * The messages whose rows are still on the lane, waiting or in flight:
   * each hands its message back to the turn that serves it - the retry
   * wake, or the captain's words parked with the message.
   */
  waitingOnLane(): string[] {
    const lane = [
      ...this.host.inbox.allFor(FIRSTMATE_RECIPIENT),
      ...this.host.inbox.inFlight(FIRSTMATE_RECIPIENT),
    ];
    return lane.flatMap((row) =>
      row.facts?.kind === "answer-missing"
        ? [row.facts.askId]
        : row.facts?.kind === "captain-turn" && row.facts.askId
          ? [row.facts.askId]
          : [],
    );
  }

  /**
   * Boot. A message the last process left mid-turn never reached its turn's
   * end: it is judged from its saved facts as an uncovered message would be.
   * A retrying message whose wake is no longer on the lane has been served:
   * it is judged now, so a quit before the check still yields one retry and
   * at most one notice.
   */
  reconcile(stranded: readonly string[]): void {
    const queued = new Set(this.waitingOnLane());
    for (const id of stranded) {
      if (queued.has(id)) continue;
      try {
        this.judge(id);
      } catch (caught) {
        console.warn("[firstmate] answer delivery could not judge a stranded message:", caught);
      }
    }
    for (const ask of this.host.tasks.listAsksByDelivery("retrying")) {
      // A message just judged above has its retry queued now, not served.
      if (queued.has(ask.id) || stranded.includes(ask.id)) continue;
      try {
        this.judge(ask.id);
      } catch (caught) {
        console.warn("[firstmate] answer delivery could not judge a retried message:", caught);
      }
    }
  }
}
