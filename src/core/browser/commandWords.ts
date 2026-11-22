/**
 * The words a crewmate reads name its browser by the command it runs
 * (docs/task-browser.md, "What a crewmate has"): `infinitary-browser-axi` in its
 * shell. Every answer, refusal and wake that says how to look again, open a
 * page or stop the browser names the command from here, so the name has
 * one owner.
 */

/** The task browser's command on a crewmate's search path (docs/axi-commands.md). */
export const BROWSER_COMMAND = "infinitary-browser-axi";

export function browserCommand(args?: string): string {
  return `\`${args ? `${BROWSER_COMMAND} ${args}` : BROWSER_COMMAND}\``;
}
