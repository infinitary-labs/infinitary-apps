import { speaksSince } from "@shared/contractFeatures";
import { contractChange, listsChange } from "./contractChanges";

/** Major 15 includes this button; older read-only views still need its historical name. */
export function readsTaskAllow(version: string, changes?: readonly string[]): boolean {
  return speaksSince(version, "15.0.0") || (changes?.includes("integration-task-allow") ?? false);
}

/** The contract change that names the Keep going on credits button (`keep-going-on-credits.md`). */
export const KEEP_GOING_ON_CREDITS_CHANGE = contractChange("keep-going-on-credits");

/**
 * Whether a view reads the Keep going on credits button: a desktop view lists
 * the change by name; the phone reads a host effect's operation as text.
 */
export function readsKeepGoing(changes?: readonly string[], system?: string): boolean {
  return system === "ios" || listsChange(changes, KEEP_GOING_ON_CREDITS_CHANGE);
}

/** Which card buttons an older view reads strictly, and so must not be sent. */
export interface ActionReads {
  /** Allow for the rest of this task (`readsTaskAllow`). */
  taskAllow: boolean;
  /** Keep going on credits (`readsKeepGoing`). */
  keepGoing: boolean;
}

/** The markers only a frame carrying one of those buttons holds, so most frames pass as they are. */
const TASK_ALLOW_MARK = '"integration":"task"';
const KEEP_GOING_MARK = '"op":"keep-going-on-credits"';

function effectOf(action: unknown): { kind?: unknown; integration?: unknown; op?: unknown } {
  return (action as { effect?: { kind?: unknown } } | null)?.effect ?? {};
}

/** Whether this action is a button the view cannot read. */
function unread(action: unknown, reads: ActionReads): boolean {
  const effect = effectOf(action);
  if (!reads.taskAllow && effect.kind === "request_write" && effect.integration === "task")
    return true;
  return !reads.keepGoing && effect.kind === "host" && effect.op === "keep-going-on-credits";
}

/** The value with every button the view cannot read left out, at any depth. */
export function withoutUnreadActions(value: unknown, reads: ActionReads): unknown {
  if (reads.taskAllow && reads.keepGoing) return value;
  if (Array.isArray(value)) return value.map((entry) => withoutUnreadActions(entry, reads));
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value).map(([key, entry]) => [
    key,
    key === "actions" && Array.isArray(entry)
      ? entry
          .filter((action) => !unread(action, reads))
          .map((action) => withoutUnreadActions(action, reads))
      : withoutUnreadActions(entry, reads),
  ]);
  return Object.fromEntries(entries);
}

/** A frame's text for such a view: unchanged unless it carries a button the view cannot read. */
export function frameWithoutUnreadActions(text: string, reads: ActionReads): string {
  const carries =
    (!reads.taskAllow && text.includes(TASK_ALLOW_MARK)) ||
    (!reads.keepGoing && text.includes(KEEP_GOING_MARK));
  return carries ? JSON.stringify(withoutUnreadActions(JSON.parse(text), reads)) : text;
}

/** The value with every Allow for the rest of this task button left out, at any depth. */
export function withoutTaskAllow(value: unknown): unknown {
  return withoutUnreadActions(value, { taskAllow: false, keepGoing: true });
}

/** A frame's text for a view without Allow for the rest of this task. */
export function frameWithoutTaskAllow(text: string): string {
  return frameWithoutUnreadActions(text, { taskAllow: false, keepGoing: true });
}
