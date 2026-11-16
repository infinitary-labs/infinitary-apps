import { hasSince16, speaksSince } from "@shared/contractFeatures";
import { contractChange, listsChange } from "./contractChanges";

/** Asking to keep a secret (`secrets-ask.md`). */
const SECRETS_ASK = contractChange("secrets-ask");

/** Major 15 includes this button; older read-only views still need its historical name. */
export function readsTaskAllow(version: string, changes?: readonly string[]): boolean {
  return speaksSince(version, "15.0.0") || (changes?.includes("integration-task-allow") ?? false);
}

/**
 * Whether a view reads the Keep going on credits button: a desktop view has
 * it from major 16, or lists `keep-going-on-credits` on major 15
 * (`hasSince16`); the phone reads a host effect's operation as text.
 */
export function readsKeepGoing(
  version: string | undefined,
  changes?: readonly string[],
  system?: string,
): boolean {
  return system === "ios" || hasSince16(version, changes, "keep-going-on-credits");
}

/**
 * Whether a view draws the masked fields of an ask to keep a secret and
 * sends their values (`secrets-ask.md`): only a view, desktop or phone,
 * that lists the change. One without it reads the ask's words and its
 * line saying where to answer, with no Keep button.
 */
export function readsSecretKeep(changes?: readonly string[]): boolean {
  return listsChange(changes, SECRETS_ASK);
}

/** Which card buttons an older view reads strictly, and so must not be sent. */
export interface ActionReads {
  /** Allow for the rest of this task (`readsTaskAllow`). */
  taskAllow: boolean;
  /** Keep going on credits (`readsKeepGoing`). */
  keepGoing: boolean;
  /** Keep in Secrets on an ask to keep a secret (`readsSecretKeep`); absent reads as true. */
  secretKeep?: boolean;
}

/** The markers only a frame carrying one of those buttons holds, so most frames pass as they are. */
const TASK_ALLOW_MARK = '"integration":"task"';
const KEEP_GOING_MARK = '"op":"keep-going-on-credits"';
const SECRET_KEEP_MARK = '"op":"secrets-keep"';

function effectOf(action: unknown): { kind?: unknown; integration?: unknown; op?: unknown } {
  return (action as { effect?: { kind?: unknown } } | null)?.effect ?? {};
}

/** Whether this action is a button the view cannot read. */
function unread(action: unknown, reads: ActionReads): boolean {
  const effect = effectOf(action);
  if (!reads.taskAllow && effect.kind === "request_write" && effect.integration === "task")
    return true;
  if (reads.secretKeep === false && effect.kind === "host" && effect.op === "secrets-keep")
    return true;
  return !reads.keepGoing && effect.kind === "host" && effect.op === "keep-going-on-credits";
}

/** The value with every button the view cannot read left out, at any depth. */
export function withoutUnreadActions(value: unknown, reads: ActionReads): unknown {
  if (reads.taskAllow && reads.keepGoing && reads.secretKeep !== false) return value;
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
    (!reads.keepGoing && text.includes(KEEP_GOING_MARK)) ||
    (reads.secretKeep === false && text.includes(SECRET_KEEP_MARK));
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
