import type { Card } from "@shared/cards";
import type { KeptPutOff, PutOffUntil } from "@shared/putOff";
import { cutText } from "@shared/textCut";
import type { CardStore } from "../storage/cardStore";
import type { ScheduleRecord, ScheduleSpec } from "../storage/scheduleStore";
import type { TaskRecord } from "../storage/taskRecords";
import { closedIn } from "../tasks/taskCloses";
import type { TaskService } from "../tasks/taskService";
import { lookOnClose, TASK_CLOSED_EVENT, TASK_EVENTS_ID } from "./taskEvents";

/**
 * Automation as a put-off reaches it (docs/automation.md, "A rule that
 * shows a card"): make a rule whose run raises a card, take one away, and
 * check an event the way a rule's event is checked.
 */
export type PutOffRules = {
  create(spec: ScheduleSpec, prompt: string, card: string): ScheduleRecord;
  cancel(id: string): void;
  checkEvent(spec: ScheduleSpec): unknown;
  /** Once the rule's first look answered: whether it holds its place in its event. */
  placed(id: string): Promise<boolean>;
};

type PutOffsHost = {
  now: () => number;
  tasks: TaskService;
  cardStore: CardStore;
  /** Raise the stored card again under its own id (`CardService.put`, which reopens its row). */
  raise(card: Card): void;
};

/**
 * The Automation rule a put-off waits through: a time is a one-time rule,
 * a task's close or any event something connected tells is an event rule,
 * and the captain's word is no rule at all. A time that passed between the
 * card going up and the click comes at the next moment.
 */
export function putOffRule(until: PutOffUntil, now: number): ScheduleSpec | undefined {
  switch (until.kind) {
    case "date":
      return { kind: "once", at: Math.max(until.at, now + 1) };
    case "close":
      return {
        kind: "event",
        integration: TASK_EVENTS_ID,
        event: TASK_CLOSED_EVENT,
        filter: { task: until.task },
      };
    case "event":
      return {
        kind: "event",
        integration: until.integration,
        event: until.event,
        ...(until.filter ? { filter: until.filter } : {}),
      };
    case "word":
      return undefined;
  }
}

/** The rule's prompt, which Automation lists it by. */
const ruleWords = (card: Card) => `Show the card "${cutText(card.title, 80)}" again`;

/**
 * The put-offs the host keeps (INF-3846 piece 3, docs/card-authoring.md
 * "Not until"): a choice its author offered with `until`, which the captain
 * clicked. The card closes like any choice and its author hears it; the
 * host keeps the put-off on the card's row and makes an Automation rule
 * that raises the same card again when its moment comes, so the moment is
 * whatever Automation can wait for and nothing here is a sweep of its own.
 */
export class PutOffs {
  private rules: PutOffRules | undefined;

  constructor(private readonly host: PutOffsHost) {
    // A put-off whose own task closed has no one left to answer it.
    host.tasks.onChange((change) => {
      for (const id of closedIn(change)) this.letGo(id);
    });
  }

  /** Automation, bound once both are built (`bindPutOffRules`). */
  bindRules(rules: PutOffRules): void {
    this.rules = rules;
  }

  /** An event put-off names an event something connected tells, as a rule would. */
  check(until: PutOffUntil): void {
    const spec = until.kind === "event" ? putOffRule(until, this.host.now()) : undefined;
    if (!spec) return;
    if (!this.rules) throw new Error("Automation is not running, so nothing can wait for it.");
    this.rules.checkEvent(spec);
  }

  /**
   * Keep the captain's put-off, in the transaction that records the choice,
   * with the rule that brings the card back.
   */
  keep(card: Card, action: string, until: PutOffUntil): void {
    const now = this.host.now();
    const spec = putOffRule(until, now);
    const rule = spec && this.rules ? this.rules.create(spec, ruleWords(card), card.id) : undefined;
    // The task it belongs to, read now while the click's row is still open:
    // its own task, else the decision or host-card row the click left open.
    const task = card.taskId ?? this.host.tasks.capture.openCardTaskFor(card.id)?.id;
    const putOff: KeptPutOff = {
      action,
      until,
      at: now,
      ...(rule ? { rule: rule.id } : {}),
      ...(task ? { task } : {}),
    };
    this.host.cardStore.keepPutOff(card.id, putOff);
    // The click cannot wait for an event rule's first look, which may cross
    // the network; a rule that cannot take its place in its event would never
    // run, so its card comes back now rather than waiting on nothing.
    if (rule && spec?.kind === "event")
      void this.rules?.placed(rule.id).then((placed) => {
        if (!placed && this.host.cardStore.putOffOf(card.id)?.rule === rule.id)
          this.raiseCard(card.id);
      });
  }

  kept(cardId: string): KeptPutOff | undefined {
    return this.host.cardStore.putOffOf(cardId);
  }

  /** The cards put off on a task, as its witness and its record read them. */
  forTask(taskId: string): { card: Card; putOff: KeptPutOff }[] {
    return this.host.cardStore.listPutOff().filter((entry) => entry.putOff.task === taskId);
  }

  /**
   * Every put-off that belongs to a task, in one read, as the next-move
   * check reads them once a pass: which tasks the captain holds this way,
   * and which tasks their close put-offs wait for.
   */
  onTasks(): (KeptPutOff & { task: string })[] {
    return this.host.cardStore
      .listPutOff()
      .flatMap(({ putOff }) => (putOff.task ? [{ ...putOff, task: putOff.task }] : []));
  }

  /**
   * How the task's put-offs wait, as its witness reads it: `word` when only
   * the captain's word brings each back, `wait` when a rule raises one.
   */
  witness(taskId: string): "wait" | "word" | undefined {
    const entries = this.forTask(taskId);
    if (entries.length === 0) return undefined;
    return entries.every(({ putOff }) => putOff.until.kind === "word") ? "word" : "wait";
  }

  /** The tasks the task's close put-offs wait to close, which count as its waits. */
  awaits(taskId: string): TaskRecord[] {
    return this.forTask(taskId).flatMap(({ putOff }) => {
      if (putOff.until.kind !== "close") return [];
      const task = this.host.tasks.resolve(putOff.until.task);
      return task ? [task] : [];
    });
  }

  /**
   * A put-off's rule ran: raise its card, unless the put-off is gone (raised
   * already, or let go). The rule finishes on its own. True when the card
   * came back.
   */
  raiseCard(cardId: string): boolean {
    const putOff = this.host.cardStore.putOffOf(cardId);
    const card = putOff ? this.host.cardStore.get(cardId) : undefined;
    if (!card) return false;
    this.host.cardStore.keepPutOff(cardId, undefined);
    this.host.raise(card);
    return true;
  }

  /**
   * The captain's word (the first mate's `update_task raise_put_off` on
   * their words): raise the task's put-off
   * cards now, whatever they wait for. Returns how many came back.
   */
  raiseForTask(taskId: string): number {
    const entries = this.forTask(taskId);
    for (const { card, putOff } of entries) this.raise(card, putOff);
    return entries.length;
  }

  private raise(card: Card, putOff: KeptPutOff): void {
    this.drop(card, putOff);
    this.host.raise(card);
  }

  private letGo(taskId: string): void {
    for (const { card, putOff } of this.forTask(taskId)) this.drop(card, putOff);
  }

  private drop(card: Card, putOff: KeptPutOff): void {
    this.host.cardStore.keepPutOff(card.id, undefined);
    if (putOff.rule) this.rules?.cancel(putOff.rule);
  }
}

/**
 * Put-offs wait through Automation (docs/card-authoring.md "Not until"): a
 * rule they make raises its card when it runs, its making and its taking
 * away each say so in the feed as any rule's do, and every task close looks
 * at once at the rules waiting for one (`lookOnClose`).
 */
export function waitThroughAutomation(
  putOffs: PutOffs,
  scheduler: {
    create(
      spec: ScheduleSpec,
      prompt: string,
      captainRequested: boolean,
      name: string | undefined,
      projectId: string | undefined,
      options: { card: string },
    ): ScheduleRecord;
    cancel(id: string): boolean;
    checkEvent(spec: ScheduleSpec): unknown;
    lookNow(integration: string): void;
    placed(id: string): Promise<boolean>;
  },
  tasks: Pick<TaskService, "onChange">,
): void {
  putOffs.bindRules({
    create: (spec, prompt, card) =>
      scheduler.create(spec, prompt, true, undefined, undefined, { card }),
    cancel: (id) => void scheduler.cancel(id),
    checkEvent: (spec) => scheduler.checkEvent(spec),
    placed: (id) => scheduler.placed(id),
  });
  lookOnClose(tasks, scheduler);
}
