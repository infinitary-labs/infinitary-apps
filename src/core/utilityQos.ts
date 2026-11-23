import { existsSync } from "node:fs";
import { hostPlatform } from "./platform";

/**
 * Heavy work the core starts on the captain's behalf - dependency installs
 * and the native builds under them, git checkouts and removals, crewmate
 * shell jobs, deleting a retired worktree - runs below the UI.
 *
 * On macOS a child inherits the scheduling class of the thread that spawns
 * it, and the core spawns from Electron's main thread, which a Dock-launched
 * app runs at user-interactive QoS: the same band as the renderer and GPU
 * threads that draw the character. `taskpolicy -c utility` clamps the child,
 * and everything it starts, to utility QoS, so it still gets every idle
 * core but yields to the drawing when they compete (character-jank scout,
 * fm3000-character-anim-jank-s1: spawn-time frame drops 19.6% -> 8.2% with
 * app-started CPU load clamped to utility). `taskpolicy` execs the program
 * in its own process, so the pid, signals, exit status and output are the
 * program's own. Elsewhere, and on a Mac without the tool, the command is
 * returned unchanged. A separate Mac that runs work draws no character, so
 * its crewmates' shell jobs run at its own priority there, while another
 * user's work on the home's own Mac keeps them below the UI
 * (`JobManagerOptions.belowUi`).
 */

const TASKPOLICY = "/usr/sbin/taskpolicy";

export type QosHost = { platform: NodeJS.Platform; hasTaskpolicy: () => boolean };

let taskpolicyPresent: boolean | undefined;

const localHost: QosHost = {
  platform: hostPlatform(),
  hasTaskpolicy: () => {
    taskpolicyPresent ??= existsSync(TASKPOLICY);
    return taskpolicyPresent;
  },
};

export function atUtilityQos(
  file: string,
  args: readonly string[],
  host: QosHost = localHost,
): { file: string; args: string[] } {
  if (host.platform === "darwin" && host.hasTaskpolicy()) {
    return { file: TASKPOLICY, args: ["-c", "utility", file, ...args] };
  }
  return { file, args: [...args] };
}
