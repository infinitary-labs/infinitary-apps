import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Work the captain's own command, `infinitary-axi`, asked for
 * (docs/axi-commands.md, "Infinitary from your terminal"; INF-1895): the
 * command acts as the captain, and what it changes is recorded as the
 * captain's from the command, so the record and the first mate can tell it
 * from a click in the window. Only the command's door enters it.
 */
const asking = new AsyncLocalStorage<true>();

/** The `through` an event the captain's command caused carries in its data. */
export const THROUGH_THE_COMMAND = "command";

/** Runs one request of the captain's command. */
export function asTheCommand<T>(work: () => T): T {
  return asking.run(true, work);
}

/** Whether the work running now began with a request of the captain's command. */
export function askedFromTheCommand(): boolean {
  return asking.getStore() === true;
}
