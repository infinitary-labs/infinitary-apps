import { type Card, cardWord } from "@shared/cards";
import {
  type CostLimit,
  type CostLimitSource,
  costHoldTitle,
  effectiveCostLimit,
  formatUsd,
  limitUsd,
  raisedLimit,
} from "@shared/costLimit";
import { overridePasses } from "@shared/holds";
import type { CostHold, CostLimitStore } from "../storage/costLimitStore";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import type { InterruptSource, TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { HOST_CARD_PRIORITY } from "./hostCards";

/** The id of the card a task's cost hold puts up. */
export function costCardId(taskId: string): string {
  return `card-cost-${taskId}`;
}

/** What the cost limits read: the store beneath them and the app's own limit. */
export type CostLimitFacts = {
  store: CostLimitStore;
  /** The app's own limit, from Settings → Intelligence. */
  appLimit(): CostLimit;
};

/** The captain's answer on a hold's card. */
export type CostAnswer = "allow" | "lift" | "stop";

/** What the cost limits reach of the supervisor beyond its options. */
export type CostLimitsHost = {
  now(): number;
  /** Every crewmate open here now. */
  runtimes(): Iterable<TaskRuntime>;
  /** Put the host's card on the stack, or revise it under its id. */
  raiseCard(card: Card): void;
  /** Take a card down unanswered. */
  takeDown(cardId: string, resolution: string): void;
  /** Deliver what is due on a task's lane now. */
  sweepTaskLane(taskId: string, now: number): Promise<void>;
  /** Run the ready sweep now, so held starts go. */
  sweepGates(now: number): Promise<void>;
  /** A started task goes back to the backlog with its work kept (`HostOps.moveToBacklog`). */
  moveToBacklog(taskId: string, source: InterruptSource): { ok: boolean; text: string };
};

/**
 * The per-task cost limit (docs/usage.md, "The cost limit"; INF-3112's
 * plan). Each recorded response checks the task and every task above it:
 * the outermost one whose family - it and everything under it - has spent
 * its limit is held (the `cost-limit` soft hold). Its crewmates stop at a
 * safe point, nothing new starts on its family's lanes, and one host card
 * asks the captain: Allow more, No limit for this task, or Stop here. The
 * captain's words, declared as an override, pass it too.
 */
export class CostLimits {
  constructor(
    private readonly options: Pick<CrewSupervisorOptions, "tasks" | "inbox" | "repos"> & {
      costLimits?: CostLimitFacts;
    },
    private readonly host: CostLimitsHost,
  ) {}

  /** The limit a task follows now, and where it was set. */
  limitFor(record: TaskRecord): { limit: CostLimit; source: CostLimitSource } | undefined {
    const facts = this.options.costLimits;
    if (!facts) return undefined;
    return effectiveCostLimit({
      task: facts.store.limitOf("task", record.id),
      project: record.repoId ? facts.store.limitOf("project", record.repoId) : null,
      app: facts.appLimit(),
    });
  }

  /**
   * The hold that stands over a task: its own, or one on a task above it,
   * whose family it belongs to. Read by `CrewFacts.laneHeld`, so nothing
   * new starts on a held family's lanes.
   */
  heldBy(taskId: string): CostHold | undefined {
    const store = this.options.costLimits?.store;
    if (!store) return undefined;
    for (const record of this.chain(taskId)) {
      // A closed task holds nothing: its parts carry on under their own limits.
      const hold = TaskService.isClosed(record) ? undefined : store.hold(record.id);
      if (hold) return hold;
    }
    return undefined;
  }

  /**
   * A response was recorded for this task: the outermost task above it, or
   * itself, whose family reached its limit is held, unless a hold already
   * stands over it. A turn running in a held family stops at a safe point.
   */
  recorded(taskId: string): void {
    const facts = this.options.costLimits;
    if (!facts) return;
    const chain = this.chain(taskId);
    const standing = this.heldBy(taskId);
    if (standing) {
      this.stopFamily(standing.taskId);
      return;
    }
    for (const record of [...chain].reverse()) {
      if (TaskService.isClosed(record)) continue;
      const limit = this.limitFor(record);
      const usd = limit ? limitUsd(limit.limit) : null;
      if (usd === null) continue;
      if (overridePasses(record.delivery, "cost-limit", record.delivery?.headSha)) continue;
      const spent = facts.store.familySpend(record.id);
      if (spent.usd < usd) continue;
      this.hold(record, usd, spent.usd, spent.unpriced);
      return;
    }
  }

  /** Places the hold on a task whose family passed its limit, and asks the captain. */
  private hold(record: TaskRecord, limit: number, spent: number, unpriced: number): void {
    const store = this.options.costLimits?.store;
    if (!store) return;
    const now = this.host.now();
    store.placeHold({ taskId: record.id, limitUsd: limit, spentUsd: spent, at: now });
    this.options.tasks.note(
      record.id,
      `passed its ${formatUsd(limit)} cost limit at about ${formatUsd(spent)}: its crew stopped at a safe point and waits for your answer`,
      { news: true, feed: true, data: { costHold: { limitUsd: limit, spentUsd: spent } } },
    );
    this.stopFamily(record.id);
    const card = this.card(record, limit, spent, unpriced, now);
    this.host.raiseCard(card);
    this.options.tasks.capture.recordCardRaised(record.id, {
      cardId: card.id,
      kind: cardWord(card),
      title: card.title,
      actor: "host",
    });
  }

  /** The step Allow more raises a limit by: the limit the task would follow without its own. */
  private step(record: TaskRecord, limit: number): number {
    const facts = this.options.costLimits;
    if (!facts) return limit;
    const inherited = effectiveCostLimit({
      project: record.repoId ? facts.store.limitOf("project", record.repoId) : null,
      app: facts.appLimit(),
    }).limit;
    return limitUsd(inherited) ?? limit;
  }

  private card(
    record: TaskRecord,
    limit: number,
    spent: number,
    unpriced: number,
    now: number,
  ): Card {
    const step = this.step(record, limit);
    const next = raisedLimit(limit, step, spent);
    const source = this.limitFor(record)?.source ?? "app";
    const setAt =
      source === "task"
        ? "the limit set for this task"
        : source === "project"
          ? "the limit set for its project"
          : "the limit in Settings → Intelligence";
    const hasParts = this.options.tasks.graph.children(record.id).length > 0;
    const counted = hasParts ? "This task and the work under it have" : "This task has";
    return {
      id: costCardId(record.id),
      taskId: record.id,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: costHoldTitle(record.title, limit),
      meta: "",
      body: [
        `<p>${counted} spent about ${formatUsd(spent)}, past ${setAt}, ${formatUsd(limit)}. Its crewmate stopped at a safe point: the step it was running finished, and nothing new starts until you answer.</p>`,
        `<p>Allow ${formatUsd(step)} more lets it go on until ${formatUsd(next)}. No limit for this task lets it finish without asking again. Stop here moves it to the backlog with its work kept. To set another amount, reply here.</p>`,
        `<p class="inf-muted">The amount is the estimate Settings → Usage shows, at the models' listed prices, not your bill. Some models report their cost only when a turn ends, so a task can pass its limit by up to one turn.${unpriced > 0 ? ` ${unpriced === 1 ? "One response" : `${unpriced} responses`} could not be priced and ${unpriced === 1 ? "adds" : "add"} nothing here.` : ""}</p>`,
      ].join(""),
      // A reply goes to the first mate, which can set another amount or
      // record the captain's words as the override (as on the stall card).
      answeredBy: "firstmate",
      actions: [
        {
          id: "allow-more",
          label: `Allow ${formatUsd(step)} more`,
          variant: "primary",
          default: true,
          effect: { kind: "host", op: "allow-cost", arg: record.id },
        },
        {
          id: "no-limit",
          label: "No limit for this task",
          variant: "secondary",
          effect: { kind: "host", op: "lift-cost-limit", arg: record.id },
        },
        {
          id: "stop-here",
          label: "Stop here",
          variant: "secondary",
          effect: { kind: "host", op: "stop-at-cost", arg: record.id },
        },
      ],
      status: "ready",
      createdAt: now,
    };
  }

  /**
   * The captain's click on a hold's card. Allow more raises this task's own
   * limit by one step past what it spent; No limit sets none on it; Stop
   * here moves every started task of its family to the backlog with its
   * work kept. Each lifts the hold, and the family's lanes carry on.
   */
  answer(taskId: string, answer: CostAnswer): void {
    const facts = this.options.costLimits;
    const record = this.options.tasks.get(taskId);
    if (!facts || !record) return;
    const hold = facts.store.hold(taskId);
    const now = this.host.now();
    if (answer === "allow") {
      const limit = hold?.limitUsd ?? limitUsd(this.limitFor(record)?.limit ?? { none: true });
      if (limit === null) {
        this.release(record.id);
        return;
      }
      const spent = facts.store.familySpend(taskId).usd;
      const next = raisedLimit(limit, this.step(record, limit), spent);
      this.setTaskLimit(taskId, { usd: next });
      return;
    }
    if (answer === "lift") {
      this.setTaskLimit(taskId, { none: true });
      return;
    }
    facts.store.clearHold(taskId);
    this.options.tasks.note(taskId, "stopped at its cost limit: moved to the backlog", {
      news: true,
      actor: "captain",
    });
    for (const member of this.family(taskId)) {
      if (member.kind !== "work" || member.status !== "active" || member.backlogSince != null)
        continue;
      const moved = this.host.moveToBacklog(member.id, {
        actor: "captain",
        via: "shell",
        decision: null,
      });
      if (!moved.ok) console.warn("[crew] a task at its cost limit stayed:", moved.text);
    }
    void this.host.sweepGates(now);
  }

  /**
   * Sets one task's own limit, on the captain's click or their words
   * (`update_task cost_limit`): a hold it no longer passes is lifted, and
   * its family carries on. Null lets the task follow its project's or the
   * app's limit again.
   */
  setTaskLimit(taskId: string, limit: CostLimit | null): void {
    const facts = this.options.costLimits;
    const record = this.options.tasks.get(taskId);
    if (!facts || !record) return;
    facts.store.setLimit("task", taskId, limit, this.host.now());
    const usd = limitUsd(this.limitFor(record)?.limit ?? { none: true });
    const words =
      limit === null
        ? "its cost limit follows its project or the app again"
        : usd === null
          ? "no cost limit for this task"
          : `its cost limit is now ${formatUsd(usd)}`;
    this.options.tasks.note(taskId, words, { news: true });
    const hold = facts.store.hold(taskId);
    if (hold && (usd === null || facts.store.familySpend(taskId).usd < usd)) this.release(taskId);
  }

  /**
   * The captain's override changed on a task (`update_task override`): one
   * that passes the cost limit lifts the hold standing on it.
   */
  overrideChanged(taskId: string): void {
    const record = this.options.tasks.get(taskId);
    if (!record || !this.options.costLimits?.store.hold(taskId)) return;
    if (overridePasses(record.delivery, "cost-limit", record.delivery?.headSha))
      this.release(taskId);
  }

  /** Lifts a task's hold: its card comes down and every lane of its family carries on. */
  private release(taskId: string): void {
    this.options.costLimits?.store.clearHold(taskId);
    this.host.takeDown(costCardId(taskId), "answered");
    const now = this.host.now();
    for (const member of this.family(taskId)) void this.host.sweepTaskLane(member.id, now);
    void this.host.sweepGates(now);
  }

  /** Every turn running in a held task's family stops at a safe point. */
  private stopFamily(rootId: string): void {
    for (const task of [...this.host.runtimes()]) {
      if (task.state !== "streaming" || task.cancelled || task.paused) continue;
      if (!this.chain(task.id).some((record) => record.id === rootId)) continue;
      this.stopSafely(task);
    }
  }

  /**
   * One crewmate's turn stops where nothing is lost, as for an update: the
   * calls it runs finish and keep their results, and a lane row carries it
   * on once the captain lets it go on (`turn-resumed`, stopped at the cost
   * limit). Its end is a pause, never a failure (`turnComplete`).
   */
  private stopSafely(task: TaskRuntime): void {
    const session = task.session;
    if (!session) return;
    const row = this.options.inbox.enqueue(task.id, {
      facts: { kind: "turn-resumed", stopped: "cost-limit" },
    });
    task.paused = { row, cost: true };
    const stopped = session.stopSafely ? session.stopSafely() : session.abort();
    void Promise.resolve(stopped).catch((caught: unknown) => {
      console.warn("[crew] a turn at its cost limit could not be stopped:", caught);
    });
  }

  /** A task and every task above it, nearest first. */
  private chain(taskId: string): TaskRecord[] {
    const chain: TaskRecord[] = [];
    const seen = new Set<string>();
    let record = this.options.tasks.get(taskId);
    while (record && !seen.has(record.id)) {
      chain.push(record);
      seen.add(record.id);
      record = record.parentId ? this.options.tasks.get(record.parentId) : undefined;
    }
    return chain;
  }

  /** A task and every task under it. */
  private family(taskId: string): TaskRecord[] {
    const out: TaskRecord[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const record = this.options.tasks.get(id);
      if (!record) return;
      out.push(record);
      for (const child of this.options.tasks.graph.children(id)) visit(child.id);
    };
    visit(taskId);
    return out;
  }
}
