/**
 * A task command's name (docs/axi-commands.md, "The launcher"): every
 * `infinitary-<tool>-axi` in `resources/axi-bin` is a copy of the one
 * launcher, and so is the `fm-<tool>-axi` name Firstmate 3000 gave it,
 * kept for a crewmate whose instructions predate the Infinitary rename. The
 * name it ran as says which command it is.
 */
export const TASK_COMMAND_NAME = /^(infinitary|fm)-[a-z][a-z0-9-]*-axi$/;

/**
 * The program a Claude crewmate's client runs each shell command through
 * (`resources/axi-bin/infinitary-crew-shell`, docs/axi-commands.md, "Never
 * the crew's"), and the name its message on the task channel carries. It is
 * no command of a crewmate's: it only names its shell's process group.
 */
export const CREW_SHELL_PROGRAM = "infinitary-crew-shell";

export function ownTaskCommand(name: string): string {
  return name.startsWith("fm-") ? `infinitary-${name.slice("fm-".length)}` : name;
}

/**
 * Whether a shell command line runs one of the app's own task commands:
 * its first word is one. A crewmate's record leaves such a call out, as it
 * leaves out the app's own tools (docs/task-record.md, "A crewmate's
 * actions"), so what a crewmate types into a page never reaches its lines.
 */
export function runsTaskCommand(commandLine: string): boolean {
  const first = commandLine.trim().split(/\s+/, 1)[0] ?? "";
  return TASK_COMMAND_NAME.test(first.slice(first.lastIndexOf("/") + 1));
}

/**
 * A task command line as a transcript names it: the command and what it was
 * asked to do (`infinitary-browser-axi fill`), never its other words, which may
 * hold what a crewmate types into a page.
 */
export function taskCommandShown(commandLine: string): string {
  const [first = "", second] = commandLine.trim().split(/\s+/, 2);
  const name = first.slice(first.lastIndexOf("/") + 1);
  return second && /^[a-z][a-z-]*$/.test(second) ? `${name} ${second}` : name;
}
