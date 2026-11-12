import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import {
  type RunAgentContext,
  runAgentAtLogin,
  runAgentInPlace,
  setRunAgentAtLogin,
  startRunAgent,
  stopRunAgent,
} from "@core/helper/runAgent";
import { runLabelOf } from "@shared/codeNames";
import { settingFrom } from "@shared/envSettings";
import type { BuildFlavor } from "@shared/userDataFolders";
import { userUnitsDir } from "./startAtBoot";
import { carriedRunEnv } from "./startAtBootContext";
import type { WorkContext } from "./workContext";

/**
 * The window's starter for the command (docs/run.md, "The window starts
 * it"; INF-1352's plan, piece 7): what the window asks of this account's
 * service manager to run its first mate in a program of its own, through
 * the agent `src/core/helper/runAgent.ts` sets up.
 */
export type CommandStarter = {
  /** Sets the agent up and starts the run; false where it cannot start here. */
  start: () => Promise<boolean>;
  /** Start at login, for the command rather than the window. */
  atLogin: { get: () => boolean; set: (enabled: boolean) => void };
  /** Whether its agent is in place, as a start entry that starts the run again. */
  inPlace: () => boolean;
  /** Lets the agent go, which stops its run; with `forget` no login starts it again. */
  stop: (options: { forget: boolean }) => Promise<void>;
};

/**
 * Whether this window's home is not the account's own: macOS's
 * CFFIXED_USER_HOME, which Electron's appData follows, or a HOME naming
 * another folder. The service manager starts the run with the account's
 * own home, so that run would open another data folder than this window's,
 * and the window would wait on a command that never opens its own.
 */
function homePinned(env: NodeJS.ProcessEnv): boolean {
  if (env.CFFIXED_USER_HOME) return true;
  if (!env.HOME) return false;
  try {
    return resolve(env.HOME) !== resolve(userInfo().homedir);
  } catch {
    // No user record for this account (a container's arbitrary user): no own home to match.
    return true;
  }
}

/**
 * The starter, or null where the window runs its first mate itself: with no
 * service manager to start it (another system, or a test that stands in
 * none), for a data folder the person named with a switch, and for an
 * installed app whose home is pinned away from the account's own, each a
 * folder a run started by the service manager would not open. A development run, a
 * test with isolated data among them, starts a command only when it asks to
 * (`WINDOW_STARTS_RUN`), so `pnpm dev` and every other journey keep the
 * window's own first mate and the code they run; an installed app with
 * isolated data never starts one.
 */
export function commandStarter(options: {
  work: WorkContext;
  flavor: BuildFlavor;
  dataDir: string;
  isolated: boolean;
  switched: boolean;
  packaged: boolean;
}): CommandStarter | null {
  const { serviceManager } = options.work;
  if (!serviceManager || options.switched) return null;
  // An installed app's agent carries no settings, so its run opens the account's own home's folder.
  if (options.packaged && homePinned(process.env)) return null;
  const asked = settingFrom(process.env, "WINDOW_STARTS_RUN")?.trim() === "1";
  if (options.packaged ? options.isolated : !asked) return null;
  const context: RunAgentContext = {
    label: runLabelOf(options.flavor),
    dataDir: options.dataDir,
    homeDir: homedir(),
    uid: process.getuid?.() ?? userInfo().uid,
    unitsDir: userUnitsDir(process.env, homedir()),
    launcher: options.work.launcher,
    env: options.packaged ? {} : { ...carriedRunEnv(process.env), ...options.work.backgroundEnv },
    ...serviceManager,
  };
  return {
    start: async () => {
      try {
        return (await startRunAgent(context)) === "running";
      } catch (error) {
        console.warn(`[run] could not start the command: ${(error as Error).message}`);
        return false;
      }
    },
    atLogin: {
      get: () => runAgentAtLogin(context),
      set: (enabled) => setRunAgentAtLogin(context, enabled),
    },
    inPlace: () => runAgentInPlace(context),
    stop: (how) => stopRunAgent(context, how),
  };
}
