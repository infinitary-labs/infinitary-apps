import { automationEventWords } from "@shared/automationWords";
import type { CoreServices } from "./coreServices";
import type { EventFinder } from "./orchestrator/scheduler";
import type { RuleNotesVersion, ScheduleRecord } from "./storage/scheduleStore";

/**
 * A saved rule and its notes as Settings → Automation and the Automation
 * panel read them (`automation.list`, `automation.notes`; src/shared/automation.ts).
 */

/** A version of a rule's notes as Automation shows it, naming its task as it is now. */
export function automationNotesOf(services: CoreServices, notes: RuleNotesVersion) {
  const task = notes.taskId ? services.tasks.get(notes.taskId) : undefined;
  return {
    version: notes.version,
    text: notes.text,
    at: notes.at,
    revision: notes.revision,
    by: notes.by,
    ...(task ? { task: { id: task.id, key: task.key, title: task.title } } : {}),
  };
}

/**
 * Every saved rule as Automation lists them, the read a connected window
 * repeats every 30 seconds. One reading of what is connected serves every
 * rule, so the read does not grow by a read of every connection per rule.
 */
export function automationRulesOf(services: Pick<CoreServices, "scheduler">) {
  const events = services.scheduler.eventsNow();
  return services.scheduler.rules().map((record) => automationRuleOf(services, record, events));
}

/** A saved rule as Automation shows it (src/shared/automation.ts). */
export function automationRuleOf(
  services: Pick<CoreServices, "scheduler">,
  record: ScheduleRecord,
  events: EventFinder | undefined = services.scheduler.eventsNow(),
) {
  const scheduler = services.scheduler;
  const listened = scheduler.listening(record, events);
  const stopped = scheduler.stopped(record, events);
  return {
    id: record.id,
    ...(record.name ? { name: record.name } : {}),
    state: record.state,
    spec: record.spec,
    prompt: record.prompt,
    ...(record.projectId ? { projectId: record.projectId } : {}),
    revision: record.revision,
    // An event rule has no next time: it runs when its event arrives.
    nextFire: record.state === "enabled" && record.spec.kind !== "event" ? record.nextFire : null,
    lastFired: scheduler.history(record.id)[0]?.firedAt ?? null,
    captainRequested: record.captainRequested === true,
    ...(listened ? { when: automationEventWords(listened.label, listened.name) } : {}),
    ...(stopped ? { stopped } : {}),
  };
}
