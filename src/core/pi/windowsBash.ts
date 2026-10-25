import { getShellConfig } from "@earendil-works/pi-coding-agent";

type ShellConfig = ReturnType<typeof getShellConfig>;

/**
 * The bash a crewmate's commands run in on Windows (`jobs/jobManager.ts`):
 * Git Bash from Git for Windows, found by Pi's own lookup, which tries Git's
 * Program Files folders and then the first `bash.exe` on the search path.
 * On many PCs that first one is the Linux subsystem's, in System32, with
 * its own files and programs; Pi marks it by sending the command on stdin,
 * and it is never used. Absent: this computer has no bash to use.
 */
export function windowsBash(find: () => ShellConfig = () => getShellConfig()): string | undefined {
  let config: ShellConfig;
  try {
    config = find();
  } catch {
    return undefined;
  }
  return config.commandTransport === "stdin" ? undefined : config.shell;
}
