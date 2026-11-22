import { AsyncLocalStorage } from "node:async_hooks";
import { THROUGH_THE_COMMAND, type Through } from "@shared/through";

/**
 * Work the captain's own command, `infinitary-axi`, asked for
 * (docs/axi-commands.md, "Infinitary from your terminal"; INF-1895): the
 * command acts as the captain, and what it changes is recorded as the
 * captain's from the command, so the record and the first mate can tell it
 * from a click in the window. Only the command's door enters it.
 */
const asking = new AsyncLocalStorage<true>();

/** The `through` an event the captain's command caused carries in its data. */
export { THROUGH_THE_COMMAND };

export function asTheCommand<T>(work: () => T): T {
  return asking.run(true, work);
}

export function askedFromTheCommand(): boolean {
  return asking.getStore() === true;
}

/**
 * The mark a record the captain writes now carries: `command` while a
 * request of the captain's command runs, else none (the window).
 */
export function throughNow(): Through | undefined {
  return askedFromTheCommand() ? THROUGH_THE_COMMAND : undefined;
}
