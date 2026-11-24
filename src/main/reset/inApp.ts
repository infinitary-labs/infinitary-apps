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
import { windowProfileDir } from "../runCommand";
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
import { bootEntryOff, forgetOwnRunEntries } from "./ownEntries";
import { runReset } from "./running";
import { restartOnWindows } from "./windowsRestart";
import { leaveWorkHome } from "./workHome";

/**
 * Where a reset runs and what it reaches outside the folder: shared by the
 * window's own reset and by a reset with no first mate running (the screens
 * shown when Infinitary cannot open, and the command; ./withoutFirstMate.ts).
 */
export type ResetPlace = {
  dataDir: string;
  choice: UserDataChoice;
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
  /**
   * A run with no window (docs/run.md): on a Mac or Linux a stop through its
   * own start entry would end it partway, so it takes the entry's files away
   * instead (`bootEntryOff`), and the next start turns the entry off; a
   * window beside it keeps its own profile in the folder and starts again
   * once the run ends.
   */
  inRun?: boolean;
};

/**
 * Starts the app again and quits this one, after any reset. The fresh start
 * is an ordinary one: neither a run's hand-over nor a job's let-go.
 */
export function restartForReset(input: {
  /** A run on a test's or another chosen isolated folder. */
  isolated: boolean;
  /** Starts the app again with these arguments once it quits. */
  relaunch: (args: string[]) => void;
  quit: () => void;
}): () => Promise<void> {
  const args = process.argv
    .slice(1)
    .filter((arg) => arg !== START_HERE_ARG && arg !== LET_GO_JOB_ARG);
  // On Windows the app starts again only once this program has ended, so the
  // next start finds the folder free (./windowsRestart.ts); false leaves it
  // to the relaunch.
  const restartAfterExit =
    hostPlatform() === "win32" && !input.isolated
      ? () => restartOnWindows({ pid: process.pid, executable: process.execPath, args })
      : undefined;
  return async () => {
    if (!(await restartAfterExit?.().catch(() => false))) input.relaunch(args);
    input.quit();
  };
}

/**
 * Reset Infinitary as this app composes it (./running.ts). A run on the
 * person's own folder of a flavor also clears the password store and its
 * start entries now, and leaves the app's own files outside the folder to
 * the next start; an isolated or chosen folder reaches nothing outside it.
 */
export function resetInApp(
  input: ResetPlace & {
    shell: Shell;
    /** Starts the app again and quits this one (`restartForReset`). */
    restart: () => Promise<void>;
  },
): (ask?: ResetAsk) => Promise<ResetAnswer> {
  const platform = hostPlatform();
  const clear = outsideNow(input);
  const own = input.choice.kind === "flavor";
  return (ask = { kind: "here" }) =>
    runReset({
      // A computer that controls this one asks only once its person
      // confirmed there; this one's own first mate runs nowhere else.
      prepare: () =>
        ask.kind === "of-home"
          ? Promise.resolve()
          : input.shell.dispatch("inf:app:reset-prepare", []),
      ...(ask.kind === "of-home"
        ? {
            askHome: async () => {
              await input.shell.dispatch("inf:home-reset:start", []);
              return true;
            },
          }
        : {}),
      clear,
      atStart: own
        ? [...outsideAtStart(input.choice), ...(input.inRun ? ["start-entries" as const] : [])]
        : [],
      dataDir: input.dataDir,
      stopFirstMate: () => input.shell.stopForReset(),
      endLeftovers: () =>
        endLeftoverPrograms(
          input.dataDir,
          undefined,
          input.inRun ? [windowProfileDir(input.dataDir)] : [],
        ),
      restart: input.restart,
      within: withinMs,
      confirm: () =>
        ask.kind === "for-controller"
          ? Promise.resolve(true)
          : confirmPerson(input.authentication, platform, ask.kind === "of-home" ? ask.home : null),
    });
}

/**
 * Who asked a reset (docs/reset.md): the person at this computer, in its
 * own row; a computer that controls this one, whose person confirmed it
 * there; or, on such a computer, its row, which asks the first mate's
 * computer `home` before this computer resets itself.
 */
export type ResetAsk =
  | { kind: "here" }
  | { kind: "for-controller" }
  | { kind: "of-home"; home: string };

/**
 * What a run on the person's own folder of a flavor clears outside it before
 * it quits, by kind; an isolated or chosen folder reaches nothing outside it.
 */
export function outsideNow(
  input: ResetPlace,
): Partial<Record<ResetOutsideKind, () => Promise<boolean>>> {
  const { choice } = input;
  const platform = hostPlatform();
  const own = choice.kind === "flavor" ? choice : null;
  return own
    ? {
        "password-store": () =>
          clearPasswordStore(passwordStoreCustodies({ platform, flavor: own.flavor })),
        "start-entries": () => clearStartEntries(input, own),
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
}

/** Kinds the next start clears whatever happened now, once the old app no longer writes them. */
export function outsideAtStart(choice: UserDataChoice): ResetOutsideKind[] {
  return choice.kind === "flavor" ? ["app-files", "safe-storage"] : [];
}

/**
 * The system's own confirmation, after the row's question: only the person at
 * this computer can give it. Where the system has none to ask (an isolated or
 * chosen folder, or no polkit agent), the row's question alone confirms, as
 * only the window's own page reaches the reset.
 */
export async function confirmPerson(
  authentication: FreshAuthentication | undefined,
  platform: NodeJS.Platform,
  home: string | null,
): Promise<boolean> {
  if (!authentication || !(await authentication.available().catch(() => false))) return true;
  // macOS puts its own "Infinitary is trying to" before the reason.
  const reason = home
    ? platform === "darwin"
      ? m.resetConfirmReasonBothMac({ home })
      : m.resetConfirmReasonBoth({ home })
    : platform === "darwin"
      ? m.resetConfirmReasonMac()
      : m.resetConfirmReason();
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
  input: Pick<ResetPlace, "starter" | "work" | "inRun">,
  own: { flavor: BuildFlavor; dir: string },
): Promise<boolean> {
  const folder = own.dir;
  let cleared = true;
  const attempt = async (work: () => unknown) => {
    try {
      await work();
    } catch {
      cleared = false;
    }
  };
  await attempt(() => input.starter?.stop({ forget: true }));
  await attempt(() =>
    bootEntryOff(
      { inRun: input.inRun === true, platform: hostPlatform() },
      {
        forget: () => forgetOwnRunEntries(own.flavor, folder, true),
        off: async () => {
          const answer = await answerBootCommand({ boot: ["--off"], help: null }, folder);
          if (answer.code !== 0) throw new Error(answer.error);
        },
      },
    ),
  );
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
