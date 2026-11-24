import { homedir, userInfo } from "node:os";
import { basename } from "node:path";
import { readInstalled, type ServiceManager, stopInBackground } from "@core/helper/background";
import { hostPlatform } from "@core/platform";
import type { ResetOutsideKind } from "@core/reset/mark";
import { withinMs } from "@core/reset/prepare";
import type { FreshAuthentication } from "@core/secrets/approvals";
import type { Spelling } from "@shared/codeNames";
import * as m from "@shared/i18n/messages.generated";
import type { ResetAnswer } from "@shared/reset";
import type { BuildFlavor } from "@shared/userDataFolders";
import { app } from "electron";
import { LET_GO_JOB_ARG, START_HERE_ARG } from "../besideRun";
import type { CommandStarter } from "../commandStarter";
import { startAtLoginFor } from "../host/electronHost";
import type { Shell } from "../shell";
import { answerBootCommand } from "../startAtBootContext";
import type { UserDataChoice } from "../userDataDir";
import { endLeftoverPrograms } from "./leftovers";
import {
  clearCommandLink,
  clearPasswordStore,
  clearPhoneKeys,
  ownCommand,
  passwordStoreCustodies,
} from "./outside";
import { runReset } from "./running";
import { restartOnWindows } from "./windowsRestart";
import { leaveWorkHome } from "./workHome";

/**
 * Reset Infinitary as this app composes it (./running.ts). A run on the
 * person's own folder of a flavor also clears the password store and its
 * start entries now, and leaves the app's own files outside the folder to
 * the next start; an isolated or chosen folder reaches nothing outside it.
 */
export function resetInApp(input: {
  shell: Shell;
  dataDir: string;
  choice: UserDataChoice;
  /** A run on a test's or another chosen isolated folder. */
  isolated: boolean;
  /** The command starter this window keeps, if any; let go for good. */
  starter: CommandStarter | null;
  /** This computer's work for another home, whose background agent goes. */
  work: {
    dataDir: string;
    flavor: BuildFlavor;
    spelling: Spelling;
    serviceManager: ServiceManager | null;
  };
  /**
   * The system's own confirmation the app's Secrets use: Touch ID or the
   * password, Windows Hello, polkit. None on an isolated or chosen folder.
   */
  authentication: FreshAuthentication | undefined;
  /** Starts the app again with these arguments once it quits. */
  relaunch: (args: string[]) => void;
  quit: () => void;
}): () => Promise<ResetAnswer> {
  const { choice } = input;
  const platform = hostPlatform();
  // The fresh start is an ordinary one: neither a run's hand-over nor a job's let-go.
  const args = process.argv
    .slice(1)
    .filter((arg) => arg !== START_HERE_ARG && arg !== LET_GO_JOB_ARG);
  // On Windows the app starts again only once this program has ended, so the
  // next start finds the folder free (./windowsRestart.ts); false leaves it
  // to the relaunch.
  const restartAfterExit =
    platform === "win32" && !input.isolated
      ? () => restartOnWindows({ pid: process.pid, executable: process.execPath, args })
      : undefined;
  const own = choice.kind === "flavor" ? choice : null;
  const clear: Partial<Record<ResetOutsideKind, () => Promise<boolean>>> = own
    ? {
        "password-store": () =>
          clearPasswordStore(passwordStoreCustodies({ platform, flavor: own.flavor })),
        "start-entries": () => clearStartEntries(input, own.dir),
        "phone-keys": async () =>
          clearPhoneKeys({
            platform,
            flavor: own.flavor,
            dataDir: input.dataDir,
            homeDir: homedir(),
          }),
        "command-link": async () =>
          clearCommandLink({
            flavor: own.flavor,
            dataDir: input.dataDir,
            homeDir: homedir(),
            command: ownCommand({
              packaged: app.isPackaged,
              appDir: app.getAppPath(),
              resourcesDir: process.resourcesPath,
            }),
          }),
      }
    : {};
  return () =>
    runReset({
      prepare: () => input.shell.dispatch("inf:app:reset-prepare", []),
      clear,
      atStart: own ? ["app-files", "safe-storage"] : [],
      dataDir: input.dataDir,
      stopFirstMate: () => input.shell.stopForReset(),
      endLeftovers: () => endLeftoverPrograms(input.dataDir),
      restart: async () => {
        if (!(await restartAfterExit?.().catch(() => false))) input.relaunch(args);
        input.quit();
      },
      within: withinMs,
      confirm: () => confirmPerson(input.authentication, platform),
    });
}

/**
 * The system's own confirmation, after the row's question: only the person at
 * this computer can give it. Where the system has none to ask (an isolated or
 * chosen folder, or no polkit agent), the row's question alone confirms, as
 * only the window's own page reaches the reset.
 */
async function confirmPerson(
  authentication: FreshAuthentication | undefined,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (!authentication || !(await authentication.available().catch(() => false))) return true;
  // macOS puts its own "Infinitary is trying to" before the reason.
  const reason = platform === "darwin" ? m.resetConfirmReasonMac() : m.resetConfirmReason();
  return authentication.confirm(reason).catch(() => false);
}

/**
 * Everything that would start this app or its work again by itself: the
 * command's starter, the start-at-boot entry, the start-at-login item, and
 * the background agent of work this computer runs for another home, whose
 * home then hears this computer leave (./workHome.ts). Each is tried; true
 * once every one is gone.
 */
async function clearStartEntries(
  input: Parameters<typeof resetInApp>[0],
  folder: string,
): Promise<boolean> {
  let cleared = true;
  const attempt = async (work: () => unknown) => {
    try {
      await work();
    } catch {
      cleared = false;
    }
  };
  await attempt(() => input.starter?.stop({ forget: true }));
  await attempt(async () => {
    const answer = await answerBootCommand({ boot: ["--off"], help: null }, folder);
    if (answer.code !== 0) throw new Error(answer.error);
  });
  await attempt(() => startAtLoginFor(basename(folder)).set(false));
  const { serviceManager } = input.work;
  const background = serviceManager
    ? {
        flavor: input.work.flavor,
        dataDir: input.work.dataDir,
        spelling: input.work.spelling,
        homeDir: homedir(),
        uid: process.getuid?.() ?? userInfo().uid,
        ...serviceManager,
      }
    : null;
  const service = readInstalled(input.work.dataDir).service;
  if (service && background) await attempt(() => stopInBackground(background, service));
  await attempt(async () => {
    if (!(await leaveWorkHome({ dataDir: input.work.dataDir, background }))) cleared = false;
  });
  return cleared;
}
