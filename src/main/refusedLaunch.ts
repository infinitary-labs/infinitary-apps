import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { STOPPED_RUN_WAIT_MS } from "@core/helper/lock";
import { settingFrom } from "@shared/envSettings";
import { app } from "electron";
import { hostPlatform } from "../core/platform";
import { OPEN_ONCE_CLOSED } from "./personWord";
import {
  answerLaunch,
  commandPipe,
  commandPipeHeld,
  holderIsWindow,
  lockHolderKind,
  runningByCommand,
  windowAnswerAsked,
  windowAnswerAsker,
  windowAnswerFile,
  writeWindowAnswer,
} from "./runCommand";
import { endRefusedLaunch } from "./runReopen";
import { personTeller } from "./tellPerson";
import { bringWindowForward, personWindows } from "./windows";

/**
 * What a launch refused the folder's lock does while it waits to learn who holds the
 * folder: its watch, its questions to the person, and how it ends. `startApp` calls it
 * where `requestSingleInstanceLock` refused a window launch that asked its holder.
 */
export function watchRefusedLaunch(deps: {
  answerAsk: string;
  lockAsk: { windowAnswers: string; asker: number } | undefined;
  askedHolder: number | null | undefined;
  lockHolderNow: () => number | null | undefined;
  dataDir: string;
  hideWindow: boolean;
  privacy: { readonly refused: unknown } | null;
  onWindows: boolean;
  startsHere: boolean;
  sourceOnOwnData: boolean;
  relaunchWith: (args: string[]) => void;
}): void {
  const {
    answerAsk,
    lockAsk,
    askedHolder,
    lockHolderNow,
    dataDir,
    hideWindow,
    privacy,
    onWindows,
    startsHere,
    sourceOnOwnData,
    relaunchWith,
  } = deps;
  // On a Mac this launch never opens a window of its own while it waits: no Dock icon and no
  // menu bar, so the one Infinitary in the Dock is the holder the person may be told to click,
  // and a word it shows comes from its copy, which shows no Dock icon either (`askPersonWord`).
  if (hostPlatform() === "darwin") app.setActivationPolicy("prohibited");
  const answer = join(dataDir, windowAnswerFile(answerAsk));
  // A word to the person, shown through a copy of this program (`personTeller`).
  const tellPerson = personTeller({ hideWindow, dataDir, privacy });
  void (async () => {
    // A holder never shown to be a command that let the lock go, or one that still shows
    // nothing on a second read, as an older window on a Windows PC that answers nothing and
    // holds no pipe, is never taken for a window, but the person is asked once whether to open
    // here when it closes, so a window they then quit on purpose stays quit. A question not
    // shown keeps the launch's own way: it opens here once the folder is free.
    let shownWhy = new AbortController();
    let openOnceClosed: Promise<boolean> | null = null;
    let leftIt: () => void = () => {};
    const left = new Promise<"left">((resolve) => {
      leftIt = () => resolve("left");
    });
    const askOnceClosed = async () => {
      const why = shownWhy;
      // Only the person's Open here opens: their Leave it, and a question that could not be
      // shown, leave the holder open; one not shown on purpose keeps the launch's own way.
      const reply = await tellPerson("once-closed", why.signal);
      const open = reply === OPEN_ONCE_CLOSED || reply === null;
      if (!open && !why.signal.aborted) leftIt();
      return open;
    };
    // The window a launch told by what it runs as, the one the person is told of.
    let classified: number | null | undefined;
    // One watch of the folder from the refusal to the launch's end: each holder seen is asked
    // once and told apart by what it shows (`lockHolderKind`), through the question and after
    // the window the person was told of quit, so a window that takes over is always one asked.
    let asked = askedHolder;
    let found: "run" | "free" | "window" | "left";
    for (;;) {
      // The watch ends with the person's word to leave the holder: no read or ask after it.
      const watching = new AbortController();
      const raced = await Promise.race([
        left,
        lockHolderKind({
          signal: watching.signal,
          running: () => runningByCommand(dataDir),
          answered: () => existsSync(answer),
          holder: lockHolderNow,
          asked,
          windowHolder: (holder) =>
            holderIsWindow(
              holder,
              onWindows ? { commandPipe: () => commandPipeHeld(commandPipe(dataDir)) } : {},
            ),
          lockFree: () => app.requestSingleInstanceLock(lockAsk),
          // A pipe is read again each second, so a command's pipe gone is seen and its next holder asked.
          readEveryMs: onWindows ? 1_000 : STOPPED_RUN_WAIT_MS,
          onUnknown: () => {
            openOnceClosed ??= askOnceClosed();
          },
          onWindow: (holder) => {
            classified = holder;
          },
        }),
      ]);
      watching.abort();
      // Only the person's word stops the watch, and that word came first.
      const read = raced === "stopped" ? "left" : raced;
      // The lock this launch took to read it free is let go before anything waits, so the
      // person's answer holds nothing and the launch started again reads the folder afresh.
      if (read === "free") app.releaseSingleInstanceLock();
      found = read;
      if (read === "free" && openOnceClosed !== null) {
        // A lock let go while the question is up waits for the person's answer, since a window
        // quit on purpose and a command that ended look the same. The folder is watched
        // meanwhile without taking it: a window's answer or a run found ends the question, and
        // a holder seen taking the folder is watched again from the top, asked once there.
        // Open here acts on the folder as it is then: free, it starts the launch again, which
        // reads it afresh; held, the holder is watched as any other.
        const asking: Promise<boolean> = openOnceClosed;
        let settled = false;
        const watched = (async (): Promise<"run" | "window" | "held" | null> => {
          while (!settled) {
            if (existsSync(answer)) return "window";
            if (runningByCommand(dataDir)) return "run";
            if (lockHolderNow() !== null) return "held";
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          return null;
        })();
        const next = await Promise.race([
          asking.then((open) => (open ? ("open" as const) : ("left" as const))),
          watched,
        ]);
        settled = true;
        if (next === "left" || next === "run" || next === "window") found = next;
        else if (next === "held" || (next === "open" && lockHolderNow() !== null)) {
          asked = null;
          continue;
        }
      }
      // What was found ends the question, whatever the person did not answer.
      shownWhy.abort();
      // A window told only by what it runs as is one from before the answer: on a Mac it may
      // have closed its last window and opened none at the ask, so the person is told to click
      // it in the Dock unless a window's answer confirms it (`endRefusedLaunch`). One that quit
      // first or meanwhile while another took the folder leaves that other to be watched as any
      // holder.
      const kind = await endRefusedLaunch({
        found,
        answered: () => existsSync(answer),
        holderAlive: () => typeof classified === "number" && lockHolderNow() === classified,
        occupied: () => runningByCommand(dataDir) || lockHolderNow() !== null,
        platform: hostPlatform(),
        tellDock: async () => {
          // Taken away once a window answers or the holder asked to reopen lets the folder go,
          // and never shown once either came first.
          const withdrawn = new AbortController();
          const stale = () => existsSync(answer) || lockHolderNow() !== classified;
          const watch = setInterval(() => {
            if (stale()) withdrawn.abort();
          }, 250);
          try {
            await tellPerson("dock", withdrawn.signal, () => !stale());
          } finally {
            clearInterval(watch);
          }
        },
        relaunch: () => relaunchWith(process.argv.slice(1)),
        quit: () => app.quit(),
      });
      if (kind === "follow") {
        asked = classified;
        classified = undefined;
        openOnceClosed = null;
        shownWhy = new AbortController();
        continue;
      }
      console.warn(
        `[app] ${startsHere ? "Start it here" : "the launch"} found the folder held by ${found === "left" ? "a holder the person left open" : kind === "free" ? "nothing now" : `a ${kind}`}`,
      );
      // One app writes a data folder: pnpm dev says in its terminal why it ended.
      if (sourceOnOwnData && kind === "window")
        console.warn(
          `[data folder] Infinitary is already open on ${dataDir}; quit it to run this copy on your saved data.`,
        );
      break;
    }
    rmSync(answer, { force: true });
  })().catch((error: unknown) => {
    console.warn(`[app] the refused launch could not finish: ${(error as Error).message}`);
    app.quit();
  });
}

/** A second launch finding this window holding the folder: it brings the window forward and answers the launch that asked. */
export function followSecondLaunches(deps: {
  windowless: boolean;
  isDev: boolean;
  asked: Set<string>;
  answers: Map<string, number | null>;
  keepsWorkingClosed: boolean;
  reopen: () => void;
}): void {
  const { windowless, isDev, asked, answers, keepsWorkingClosed } = deps;
  app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
    if (windowless) return;
    const asker = windowAnswerAsker(additionalData);
    // A development window may stand in for one from before windows answered a launch: it brings
    // itself forward and answers nothing (tests/e2e/window-starts-run.spec.ts).
    const answersNoLaunch = isDev && settingFrom(process.env, "ANSWERS_NO_LAUNCH") === "1";
    answerLaunch(answersNoLaunch ? null : windowAnswerAsked(additionalData), {
      asked,
      // A window the person uses, a refusal shown in its place included, never a hidden helper such
      // as a panel's capture; with none, where closing the last window left the app working, as on
      // a Mac, a second launch opens it again.
      bringForward: () =>
        bringWindowForward(personWindows(), keepsWorkingClosed ? deps.reopen : null),
      shown: () => personWindows().length > 0,
      whenMade: (then) => app.once("browser-window-created", () => setImmediate(then)),
      answer: (word) => {
        try {
          return writeWindowAnswer(app.getPath("userData"), word, asker, answers);
        } catch (error) {
          console.warn(`[app] could not answer a launch: ${(error as Error).message}`);
          return false;
        }
      },
      later: (then) => setTimeout(then, 1_000),
    });
  });
}
