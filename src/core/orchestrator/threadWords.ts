/**
 * The feed's words around a card's thread (`crewSupervisor.ts`), in a plain
 * module so an e2e spec reads them from their owner (docs/e2e-contracts.md,
 * "Words come from their owner").
 */

/**
 * The one line the captain sees while a crewmate works on his reply under
 * its card; an ordinary card waits off the stack meanwhile.
 */
export function askedUnderCardLine(crewmate: string, title: string): string {
  return `You asked ${crewmate} under "${title}"`;
}

/**
 * The one line the feed shows for a line the captain typed in a task's
 * Crewmate tab (docs/task-card-tabs.md, "Typing"); his words stay on the
 * task's own record.
 */
export function toldInCrewmateTabLine(crewmate: string, title: string): string {
  return `You told ${crewmate} on "${title}"`;
}
