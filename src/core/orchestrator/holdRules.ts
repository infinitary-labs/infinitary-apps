import { compareSemver } from "@shared/semver";
import { cutText } from "@shared/textCut";
import type { ScheduleRecord, ScheduleSpec } from "../storage/scheduleStore";
import type { AppUpdateWait, TaskRecord } from "../storage/taskRecords";
import type { TaskService } from "../tasks/taskService";

/** The event a hold ends sooner on, as a put-off's event names it (`PutOffUntil`). */
export type HoldEvent = { integration: string; event: string; filter?: Record<string, string> };

/**
 * A hold as the first mate gives it: its latest time, its reason, an event
 * that ends it sooner, and an app update that ends it sooner - the version
 * it waits for, or with none named the next newer one.
 */
export type HoldInput = {
  until: number;
  reason: string;
  onEvent?: HoldEvent;
  onUpdate?: { version?: string };
};

/**
 * Automation as a hold reaches it (docs/automation.md, "A rule that ends a
 * hold"): make a one-run event rule tied to a task, take one away, list them,
 * and check an event the way a rule's event is checked.
 */
export type HoldRuleScheduler = {
  create(
    spec: ScheduleSpec,
    prompt: string,
    captainRequested: boolean,
    name: string | undefined,
    projectId: string | undefined,
    options: { task: string },
  ): ScheduleRecord;
  cancel(id: string): boolean;
  checkEvent(spec: ScheduleSpec): unknown;
  /** The rules that end a hold: one task's, or every task's. */
  linked(taskId?: string): ScheduleRecord[];
  /** Once the rule's first look answered: whether it holds its place in its event. */
  placed(id: string): Promise<boolean>;
};

type HoldRulesHost = {
  tasks: TaskService;
  /** End the hold whose gate names the rule, with the events that came (`IdleLadder.endHoldOnEvent`). */
  endHold(taskId: string, ruleId: string, events: string): boolean;
  /** End the task's hold on an app update, saying what was installed (`IdleLadder.endHoldOnEvent`). */
  endUpdateHold(taskId: string, installed: string): boolean;
};

/** The key a computer's version is kept under: its device id, or this Mac's. */
const THIS_MAC = "";

/** A task's hold and the end of its last turn: what a newer move changes, and a pin does not. */
function lastMove(task: TaskRecord | undefined): string {
  return JSON.stringify([task?.gate ?? null, task?.idleSince ?? null]);
}

/**
 * A started task's hold that ends sooner on an event (INF-5145 part 2): the
 * hold is the task's `at-time` gate, and its `ref` names a one-run
 * Automation event rule tied to the task, whose run ends the hold with what
 * arrived, on its own, as a put-off's rule raises its card. The rule lives
 * only as long as the hold it ends: whatever ends that hold first - a lift,
 * any turn, its time, a new hold, the task's close - takes the rule away,
 * read from the task's gate on every change, so no path keeps one of its own.
 */
export class HoldRules {
  private rules: HoldRuleScheduler | undefined;
  /** Rules still taking their place, which no gate names yet. */
  private readonly arming = new Set<string>();
  /** The app version each computer last said it runs, this Mac's under `THIS_MAC` (`appRan`). */
  private readonly running = new Map<string, string>();

  constructor(private readonly host: HoldRulesHost) {
    host.tasks.onChange((change) => {
      if (!this.rules) return;
      const touched = new Set([...change.taskIds, ...change.removed]);
      if (change.reset || touched.size > 0) this.letGo(change.reset ? undefined : touched);
    });
  }

  /** Automation, bound once both are built: a rule a quit left behind its hold goes now. */
  bindRules(rules: HoldRuleScheduler): void {
    this.rules = rules;
    this.letGo();
  }

  /**
   * Hold the task, with the rule that ends it sooner when an event is
   * named: the event is checked and the hold's refusals read first, so a
   * refused hold makes no rule; `null` lifts the hold, and its rule goes
   * with it. An event hold is written only once its rule holds its place
   * in the event, so whatever the first mate does next comes after the
   * first event the rule can see; until then the task keeps whatever hold
   * it had, and a rule that cannot take its place refuses the new hold and
   * leaves that one as it was.
   */
  async hold(taskId: string, hold: HoldInput | null): Promise<{ ok: boolean; text: string }> {
    const turns = this.host.tasks.turns;
    if (hold === null) return turns.hold(taskId, null);
    const waited = hold.onUpdate ? this.updateWait(taskId, hold.onUpdate.version) : undefined;
    if (waited && "refusal" in waited) return { ok: false, text: waited.refusal };
    const update = waited ? { update: waited.update } : {};
    if (!hold.onEvent) {
      const held = turns.hold(taskId, { until: hold.until, reason: hold.reason, ...update });
      return held.ok && waited ? { ok: true, text: `${held.text} ${waited.ends}` } : held;
    }
    const rules = this.rules;
    if (!rules)
      return { ok: false, text: "Automation is not running, so no event can end a hold." };
    const refusal = turns.holdRefusal(taskId, hold);
    if (refusal) return { ok: false, text: refusal };
    const spec: ScheduleSpec = {
      kind: "event",
      integration: hold.onEvent.integration.trim(),
      event: hold.onEvent.event.trim(),
      ...(hold.onEvent.filter ? { filter: hold.onEvent.filter } : {}),
    };
    try {
      rules.checkEvent(spec);
    } catch (caught) {
      return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
    }
    const task = this.host.tasks.get(taskId);
    const name = task?.key || taskId;
    // The move this hold answers: the task's hold and its last turn now.
    const asked = lastMove(task);
    const rule = rules.create(
      spec,
      `End the hold on ${name} "${cutText(task?.title ?? "", 60)}" when this comes: ${cutText(hold.reason.trim(), 120)}`,
      false,
      undefined,
      undefined,
      { task: taskId },
    );
    // No gate names the rule while it takes its place, so the task's changes
    // meanwhile leave it alone (`letGo`).
    this.arming.add(rule.id);
    let placed: boolean;
    try {
      placed = await rules.placed(rule.id);
    } finally {
      this.arming.delete(rule.id);
    }
    const ran = rules.linked(taskId).find((entry) => entry.id === rule.id)?.state === "completed";
    // The task may have closed, moved to the backlog or turned while the rule
    // looked; and a newer hold, a lift or a finished turn owns its next move,
    // which this older hold never overwrites. Other changes, such as a pin, do not count.
    const moved =
      lastMove(this.host.tasks.get(taskId)) === asked
        ? undefined
        : `${name} moved on while the event's watch started - a newer hold, a lift or a turn - so this hold was not written; what that move left stands.`;
    const now = turns.holdRefusal(taskId, hold) ?? moved;
    const held =
      placed && !now
        ? turns.hold(taskId, { until: hold.until, reason: hold.reason, ref: rule.id, ...update })
        : undefined;
    if (held?.ok)
      return {
        ok: true,
        text: `${held.text} The event ${spec.event} from ${spec.integration} ends it sooner, once, with what arrived.${waited ? ` ${waited.ends}` : ""}`,
      };
    rules.cancel(rule.id);
    if (held) return held;
    if (now) return { ok: false, text: now };
    return {
      ok: false,
      text: ran
        ? `${spec.event} from ${spec.integration} came while its watch started, so ${name} is not held for it; any hold it had stands.`
        : `${spec.integration} could not start watching for ${spec.event}, so nothing would end the hold sooner; ${name} is not held for it, and any hold it had stands. Hold it again, or without on_event.`,
    };
  }

  /**
   * The app update a hold waits for (INF-5578 finding 4), on the computer
   * the task runs on: the version named, or with none the next one newer
   * than the version that computer runs now. Refused when nothing could
   * tell that update: no version named and none heard from that computer,
   * a version that is not one, or one that computer already runs.
   */
  private updateWait(
    taskId: string,
    version: string | undefined,
  ): { update: AppUpdateWait; ends: string } | { refusal: string } {
    const device = this.host.tasks.get(taskId)?.deviceId ?? null;
    const from = this.running.get(device ?? THIS_MAC);
    const named = version?.trim() || undefined;
    const where = device ? "the computer it runs on" : "this Mac";
    if (named !== undefined && compareSemver(named, named) === null)
      return {
        refusal: `on_update.version takes an app version, such as 0.8.5-alpha.7; "${named}" is not one.`,
      };
    if (named !== undefined && from !== undefined && (compareSemver(from, named) ?? -1) >= 0)
      return {
        refusal: `The app on ${where} already runs ${from}, at or past ${named}, so that update is installed; nothing changed.`,
      };
    if (named === undefined && from === undefined)
      return {
        refusal: `The app version on ${where} is not known now, so nothing would tell its update; name the version it waits for in on_update.version, or hold without on_update. Nothing changed.`,
      };
    return {
      update: {
        device,
        ...(from !== undefined ? { from } : {}),
        ...(named ? { version: named } : {}),
      },
      ends: `It ends sooner, with one steer, once the app on ${where} runs ${named ?? `a version newer than ${from}`}.`,
    };
  }

  /**
   * A computer said which app version it runs: this Mac's own at each
   * start (`device` null), and each computer that runs work at each
   * welcome. Each started task held for an update there that this version
   * meets is woken, its hold ended (INF-5578 finding 4).
   */
  appRan(device: string | null, version: string): void {
    this.running.set(device ?? THIS_MAC, version);
    for (const record of this.host.tasks.listActive()) {
      const update = record.gate?.update;
      if (record.gate?.kind !== "at-time" || !update || update.device !== device) continue;
      if (!updateInstalled(update, version)) continue;
      this.host.endUpdateHold(
        record.id,
        `Infinitary ${version} is installed on ${device ? "the computer this task runs on" : "this Mac"}`,
      );
    }
  }

  /** A hold's rule ran: end the hold it names, if it still stands. */
  ran(taskId: string, ruleId: string, events: string): void {
    this.host.endHold(taskId, ruleId, events);
  }

  /**
   * Take away each waiting rule whose hold no longer stands: its task is
   * gone, not started, or its gate no longer names it. A rule that already
   * ran is left to the scheduler, which retires it once completed, as a put-off's.
   */
  private letGo(taskIds?: ReadonlySet<string>): void {
    const rules = this.rules;
    if (!rules) return;
    const linked = taskIds ? [...taskIds].flatMap((id) => rules.linked(id)) : rules.linked();
    for (const rule of linked) {
      if (!rule.task || rule.state === "completed" || this.arming.has(rule.id)) continue;
      const task = this.host.tasks.get(rule.task);
      const stands =
        task?.status === "active" && task.gate?.kind === "at-time" && task.gate.ref === rule.id;
      if (!stands) rules.cancel(rule.id);
    }
  }
}

/** Whether the version a computer now runs is the update a hold waits for. */
export function updateInstalled(update: AppUpdateWait, version: string): boolean {
  if (update.version !== undefined) return (compareSemver(version, update.version) ?? -1) >= 0;
  return update.from !== undefined && (compareSemver(version, update.from) ?? -1) > 0;
}
