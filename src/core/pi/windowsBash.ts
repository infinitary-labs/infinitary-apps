import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { windowsGit } from "../windowsGit";

type ShellConfig = ReturnType<typeof getShellConfig>;

/**
 * The bash a crewmate's commands run in on Windows (`jobs/jobManager.ts`):
 * Git Bash from Git for Windows, found by Pi's own lookup, which tries Git's
 * Program Files folders and then the first `bash.exe` on the search path.
 * On many PCs that first one is the Linux subsystem's, in System32, with
 * its own files and programs; Pi marks it by sending the command on stdin,
 * and it is never used. The installed app names the Git for Windows it
 * found or installed before its window opened (`../windowsGit.ts`), and
 * then its Git Bash is the one, wherever that Git lives. Absent: this
 * computer has no bash to use.
 */
export function windowsBash(
  find: () => ShellConfig = () => getShellConfig(windowsGit()?.bash),
): string | undefined {
  let config: ShellConfig;
  try {
    config = find();
  } catch {
    return undefined;
  }
  return config.commandTransport === "stdin" ? undefined : config.shell;
}
