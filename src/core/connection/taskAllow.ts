import { speaksSince } from "@shared/contractFeatures";

/** Major 15 includes this button; older read-only views still need its historical name. */
export function readsTaskAllow(version: string, changes?: readonly string[]): boolean {
  return speaksSince(version, "15.0.0") || (changes?.includes("integration-task-allow") ?? false);
}

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
