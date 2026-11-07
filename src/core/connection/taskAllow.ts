import { contractChange } from "./contractChanges";

/**
 * A view that reads the integration approval card's Allow for the rest of
 * this task (`integration-task-allow.md`, INF-2993). A view that does not
 * list it reads a `request_write` effect's choices strictly, so the home
 * sends it every card without that button, and it shows the other three.
 */
export const INTEGRATION_TASK_ALLOW = contractChange("integration-task-allow");

/** The marker only a frame carrying that button holds, so most frames are passed as they are. */
const MARK = '"integration":"task"';

/** Whether this action is the button such a view cannot read. */
function isTaskAllow(action: unknown): boolean {
  const effect = (action as { effect?: { kind?: unknown; integration?: unknown } } | null)?.effect;
  return effect?.kind === "request_write" && effect.integration === "task";
}

/** The value with every Allow for the rest of this task button left out, at any depth. */
export function withoutTaskAllow(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTaskAllow);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value).map(([key, entry]) => [
    key,
    key === "actions" && Array.isArray(entry)
      ? entry.filter((action) => !isTaskAllow(action)).map(withoutTaskAllow)
      : withoutTaskAllow(entry),
  ]);
  return Object.fromEntries(entries);
}

/** A frame's text for such a view: unchanged unless it carries the button. */
export function frameWithoutTaskAllow(text: string): string {
  return text.includes(MARK) ? JSON.stringify(withoutTaskAllow(JSON.parse(text))) : text;
}
