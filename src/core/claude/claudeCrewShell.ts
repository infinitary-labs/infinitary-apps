import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { CREW_SHELL_PROGRAM } from "../axi/names";
import { hostPlatform } from "../platform";

/**
 * A Claude crewmate's shell commands run through the app's crew shell
 * program (docs/axi-commands.md, "Never the crew's"; docs/claude-client.md,
 * "A crewmate's shell"). The client starts each command's shell in a
 * process group of its own, which the app would never learn; with
 * `CLAUDE_CODE_SHELL_PREFIX` naming the program, the client runs
 * `'<program>' '<command>'` in that shell, and the program tells the task
 * channel its process number before it runs the command, so the command
 * door refuses what the command leaves running until its task closes.
 *
 * The program runs the command in `CLAUDE_CODE_SHELL`, so that variable
 * names the shell the client itself chooses first: its own setting when it
 * names a bash or zsh that runs, then the person's login shell when it is
 * one, then the system's zsh or bash, in the client's order. On Windows the
 * client runs every command in Git Bash, so the variable is left alone and
 * the program runs the command in Git Bash's own bash. A prefix the person
 * set for their own client is theirs, and stays; a program path the client
 * would split at ` -` gets no prefix.
 */
export function withCrewShell(
  env: NodeJS.ProcessEnv,
  shell: { path: readonly string[] } | undefined,
  runs: (path: string) => boolean = isProgram,
): NodeJS.ProcessEnv {
  if (!shell || env.CLAUDE_CODE_SHELL_PREFIX) return env;
  const program = shell.path
    .map((dir) => join(dir, CREW_SHELL_PROGRAM))
    .find((path) => !path.includes(" -") && runs(path));
  if (program && hostPlatform() === "win32") return { ...env, CLAUDE_CODE_SHELL_PREFIX: program };
  const clientShell = program ? crewClientShell(env, runs) : undefined;
  if (!program || !clientShell) return env;
  return { ...env, CLAUDE_CODE_SHELL: clientShell, CLAUDE_CODE_SHELL_PREFIX: program };
}

/** The shell the Claude client picks first for its commands, in its own order. */
function crewClientShell(
  env: NodeJS.ProcessEnv,
  runs: (path: string) => boolean,
): string | undefined {
  const named = [env.CLAUDE_CODE_SHELL, env.SHELL].filter(
    (path): path is string => !!path && (path.includes("bash") || path.includes("zsh")),
  );
  const names = env.SHELL?.includes("bash") ? ["bash", "zsh"] : ["zsh", "bash"];
  const system = names.flatMap((name) =>
    ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map((dir) => `${dir}/${name}`),
  );
  return [...named, ...system].find(runs);
}

function isProgram(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
