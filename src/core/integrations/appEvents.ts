import type { IntegrationEventSpec } from "./binding";

/**
 * Events the app itself tells, listed beside the integrations' events so
 * Settings → Automation and the agents' integrations tool name them
 * (docs/automation.md, "A task closes"). Nothing is connected for them:
 * they are always there. Each is declared here and looked at by its owner,
 * the task events by `taskEvents` (src/core/orchestrator/taskEvents.ts).
 */
export type AppEventSource = {
  /** The id a rule keeps, like an integration's. */
  id: string;
  /** Its name as the person reads it. */
  name: string;
  events: readonly IntegrationEventSpec[];
};

export const TASK_EVENTS_ID = "tasks";

export const TASK_CLOSED_EVENT: IntegrationEventSpec = {
  name: "task_closed",
  label: "A task closes",
  description:
    "The named task closed, whatever closed it: merged, done, dropped or replaced. A task the record no longer holds counts as closed. Name the task by its key in the task filter; the rule runs once it is closed.",
  // Every minute, the cadence's floor; a close also looks at once.
  every: 1,
  filters: [{ name: "task", label: "Task", required: true }],
  atOnce: true,
};

export const APP_EVENTS: readonly AppEventSource[] = [
  { id: TASK_EVENTS_ID, name: "Tasks", events: [TASK_CLOSED_EVENT] },
];

/** The app's own event source a rule names by id or name, if any. */
export function appEventSource(integration: string): AppEventSource | undefined {
  const wanted = integration.trim().toLowerCase();
  return APP_EVENTS.find((source) => source.id === wanted || source.name.toLowerCase() === wanted);
}
