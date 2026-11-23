import { homedir, userInfo } from "node:os";
import { basename } from "node:path";
import { readInstalled, type ServiceManager, stopInBackground } from "@core/helper/background";
import type { ResetOutsideKind } from "@core/reset/mark";
import type { Spelling } from "@shared/codeNames";
import type { ResetAnswer } from "@shared/reset";
import type { BuildFlavor } from "@shared/userDataFolders";
import type { CommandStarter } from "../commandStarter";
import { startAtLoginFor } from "../host/electronHost";
import type { Shell } from "../shell";
import { answerBootCommand } from "../startAtBootContext";
import type { UserDataChoice } from "../userDataDir";
import { clearPasswordStore, passwordStoreCustodies } from "./outside";
import { runReset } from "./running";

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
  platform: NodeJS.Platform;
  /** The command starter this window keeps, if any; let go for good. */
  starter: CommandStarter | null;
  /** This computer's work for another home, whose background agent goes. */
  work: {
    dataDir: string;
    flavor: BuildFlavor;
    spelling: Spelling;
    serviceManager: ServiceManager | null;
  };
  /** Starts the app again once it quits. */
  relaunch: () => void;
  quit: () => void;
}): () => Promise<ResetAnswer> {
  const { choice, platform } = input;
  const own = choice.kind === "flavor" ? choice : null;
  const clear: Partial<Record<ResetOutsideKind, () => Promise<boolean>>> = own
    ? {
        "password-store": () =>
          clearPasswordStore(passwordStoreCustodies({ platform, flavor: own.flavor })),
        "start-entries": () => clearStartEntries(input, own.dir),
      }
    : {};
  return () =>
    runReset({
      prepare: () => input.shell.dispatch("inf:app:reset-prepare", []),
      clear,
      atStart: own ? ["app-files"] : [],
      dataDir: input.dataDir,
      stopFirstMate: () => input.shell.stopForReset(),
      restart: () => {
        input.relaunch();
        input.quit();
      },
      within,
    });
}

/**
 * Everything that would start this app or its work again by itself: the
 * command's starter, the start-at-boot entry, the start-at-login item, and
 * the background agent of work this computer runs for another home. Each is
 * tried; true once every one is gone.
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
  const service = readInstalled(input.work.dataDir).service;
  if (service && serviceManager)
    await attempt(() =>
      stopInBackground(
        {
          flavor: input.work.flavor,
          dataDir: input.work.dataDir,
          spelling: input.work.spelling,
          homeDir: homedir(),
          uid: process.getuid?.() ?? userInfo().uid,
          ...serviceManager,
        },
        service,
      ),
    );
  return cleared;
}

function within<T>(work: Promise<T>, ms: number): Promise<T | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed-out">((done) => {
    timer = setTimeout(() => done("timed-out"), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
