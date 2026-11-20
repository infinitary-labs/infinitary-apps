import {
  appEventSource,
  TASK_CLOSED_EVENT as TASK_CLOSED_SPEC,
  TASK_EVENTS_ID,
} from "../integrations/appEvents";
import type { IntegrationsService } from "../integrations/service";
import type { TaskRecord } from "../storage/taskRecords";
import { closedIn } from "../tasks/taskCloses";
import { TaskService } from "../tasks/taskService";
import type { EventFinder, EventLook, ListenedEvent, SchedulerEvents } from "./scheduler";

/**
 * The app's own task events an Automation rule can listen for beside the
 * integrations' (docs/automation.md, "A task closes"), declared with the
 * app's other events (`APP_EVENTS`) so Settings and the agents list them.
 * A task's close is how a dependency between tasks is said everywhere
 * else, so a rule can wait for one: "Not until" waits through it
 * (docs/card-authoring.md).
 */
export { TASK_EVENTS_ID };
export const TASK_CLOSED_EVENT = TASK_CLOSED_SPEC.name;

type TaskReader = { resolve(ref: string): TaskRecord | undefined };

function taskClosed(tasks: TaskReader): ListenedEvent {
  return {
    integration: TASK_EVENTS_ID,
    connection: TASK_EVENTS_ID,
    name: appEventSource(TASK_EVENTS_ID)?.name ?? "Tasks",
    event: TASK_CLOSED_SPEC.name,
    label: TASK_CLOSED_SPEC.label,
    every: TASK_CLOSED_SPEC.every,
    filters: [...(TASK_CLOSED_SPEC.filters ?? [])],
    atOnce: true,
    // A task key that names no task could only fire at once: refuse it.
    checkFilter: (filter) => {
      const ref = filter?.task?.trim() ?? "";
      return tasks.resolve(ref)
        ? undefined
        : `No task is named "${ref}". Name the task by its key.`;
    },
  };
}

/**
 * The task events as an event rule reaches them. A look answers the named
 * task's close once it is closed, whatever closed it; a task the record no
 * longer holds counts as closed. Its cursor only marks that the rule looked,
 * so a task that closed before the rule's first look still fires it on the
 * next one, and the close's id is carried once, so it never fires twice.
 */
export function taskEvents(tasks: TaskReader): SchedulerEvents {
  return {
    find: (integration, event) =>
      isTaskEvents(integration) && event === TASK_CLOSED_EVENT ? taskClosed(tasks) : undefined,
    look: async (_integration, _event, _cursor, filter): Promise<EventLook> => {
      const ref = filter?.task ?? "";
      const task = tasks.resolve(ref);
      if (task && !TaskService.isClosed(task)) return { cursor: "looked", items: [] };
      return {
        cursor: "looked",
        items: [
          {
            id: `closed:${task?.id ?? ref}`,
            summary: task ? `${task.key} ${task.title} closed` : `${ref} is gone`,
          },
        ],
      };
    },
  };
}

function isTaskEvents(integration: string): boolean {
  return appEventSource(integration)?.id === TASK_EVENTS_ID;
}

/**
 * The integrations as an event rule reaches them (docs/automation.md,
 * "Events"), with one reading of what is connected for a caller asking
 * about many rules at once.
 */
export function integrationEvents(
  integrations: Pick<IntegrationsService, "listenable" | "listenables" | "look">,
): SchedulerEvents {
  return {
    find: (integration, event) => integrations.listenable(integration, event),
    snapshot: () => ({ find: integrations.listenables() }),
    // A hold's rule hands what arrived to its task, whose conversation then holds the words.
    look: (integration, event, cursor, filter, connection, task) =>
      integrations.look(
        integration,
        event,
        cursor,
        filter,
        connection,
        task ? { kind: "task", taskId: task } : undefined,
      ),
  };
}

/** The task events first, then whatever else the app listens to. */
export function withTaskEvents(tasks: TaskReader, others?: SchedulerEvents): SchedulerEvents {
  const own = taskEvents(tasks);
  const across = (theirs: EventFinder | undefined): EventFinder => ({
    find: (integration, event) => own.find(integration, event) ?? theirs?.find(integration, event),
  });
  return {
    ...across(others),
    snapshot: () => across(others?.snapshot?.() ?? others),
    look: (integration, event, cursor, filter, connection, task) =>
      isTaskEvents(integration)
        ? own.look(integration, event, cursor, filter, connection)
        : others
          ? others.look(integration, event, cursor, filter, connection, task)
          : Promise.reject(new Error(`Nothing connected tells "${event}" from "${integration}".`)),
  };
}

/**
 * Every close looks at once at the rules waiting for one, rather than at
 * the next minute. Returns the unsubscribe.
 */
export function lookOnClose(
  tasks: Pick<TaskService, "onChange">,
  scheduler: { lookNow(integration: string): void },
): () => void {
  return tasks.onChange((change) => {
    if (closedIn(change).length > 0) scheduler.lookNow(TASK_EVENTS_ID);
  });
}
