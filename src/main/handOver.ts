import type { FolderMove } from "@core/folderMove/due";
import { type MoveChoice, type MoveDeps, type MoveProgress, runMove } from "@core/folderMove/move";
import { stopOlderCopyNow, type TakeOverDeps, takeOverOlderCopy } from "@core/folderMove/takeOver";
import type { Service } from "@core/helper/background";
import { isProfileRetired } from "@core/storage/retiredProfile";
import { nativeTheme } from "electron";
import {
  actionOf,
  HAND_OVER_CSS,
  type HandOverAction,
  type HandOverNames,
  type HandOverView,
  handOverBody,
  type MoveClock,
  workingLive,
} from "./handOverPage";
import { standaloneDocument, standaloneWindow } from "./savedDataRefusal";

/**
 * The one-time move's hand-over (src/core/folderMove/move.ts): the window a
 * person sees while an app with a new identity brings an older folder's
 * saved work into its own, before anything opens either folder. It shows
 * the move as it goes, asks which work to open when both folders hold some,
 * and says why a move stopped with a way to try again. An older copy still
 * running with no window that holds the older folder is taken over first:
 * asked to save and stop, and ended only on the person's Stop it now when it
 * does not (src/core/folderMove/takeOver.ts). While it counts,
 * copies and checks, Quit, continue later stops the move - which leaves
 * nothing changed - and quits; the next launch starts it again. Once the work is in,
 * it turns on start at login when the older app had it, and starts the app
 * again on its own folder.
 *
 * Chromium keeps its own files in userData from the moment it starts, so
 * the hand-over runs on a throwaway profile of its own beside the folders
 * (`handOverProfileDir`): the app's folder is not opened by this process at
 * all, and is put in place whole by the move's rename.
 */

/** The throwaway Chromium profile the hand-over runs on: beside the app's own folder, never in it. */
export function handOverProfileDir(to: string): string {
  return `${to}.hand-over`;
}

export type HandOverOptions = {
  names: HandOverNames;
  hidden: boolean;
  deps: Omit<MoveDeps, "progress">;
  /** How the window takes over from an older copy holding the older folder; absent, it only says to quit it. */
  takeOver?: TakeOverDeps;
  /** Turns start at login on for this app. */
  startAtLogin: () => void;
  /** Starts the app again, now on its own folder, and ends this process. */
  relaunch: () => void;
  quit: () => void;
};

/** How often a move under way redraws its progress, at most. */
const PROGRESS_EVERY_MS = 200;

/** How often the time a move has taken is redrawn while nothing else moves. */
const CLOCK_EVERY_MS = 1000;

/** How long the finished view stays before the app opens on its folder. */
const READY_HOLD_MS = 1200;

export async function runHandOver(move: FolderMove, options: HandOverOptions): Promise<void> {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = standaloneWindow({
    title: options.names.to,
    width: 680,
    height: 640,
    backgroundColor: dark ? "#05070d" : "#eef1f7",
  });
  let finished = false;
  // A quit while the move works stops it first, so it leaves nothing changed,
  // and the app quits once the move has ended.
  const stop = new AbortController();
  let moving = false;
  const quitWhileMoving = () => {
    if (stop.signal.aborted) return;
    stop.abort(new Error("The move was stopped to continue later."));
    void draw(() =>
      win.webContents.executeJavaScript(
        `(() => {
          const leave = document.getElementById("leave");
          if (leave) leave.innerHTML = '<p class="note">Stopping the move. Nothing changes, and ${options.names.to} quits once it has stopped.</p>';
          document.getElementById("opens")?.remove();
        })()`,
      ),
    );
  };
  // Agents the take-over let go: started again whenever the hand-over ends
  // without moving, so the older copy's work runs as it did.
  const paused: Service[] = [];
  let left = false;
  const leave = async () => {
    if (left) return;
    left = true;
    // Once the move committed, the older folder is a frozen recovery copy: nothing starts on it again.
    const retired = isProfileRetired(move.from);
    for (const service of paused.splice(0))
      if (!retired) await options.takeOver?.resumeAgent?.(service).catch(() => {});
    options.quit();
  };
  let closed = false;
  let takingOver = false;
  win.on("closed", () => {
    if (finished) return;
    closed = true;
    if (moving) quitWhileMoving();
    else if (!takingOver) void leave();
  });
  let answer: ((action: HandOverAction) => void) | undefined;
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    const action = actionOf(url);
    if (action === "quit" && moving) quitWhileMoving();
    else if (action) answer?.(action);
  });
  const nextAction = () =>
    new Promise<HandOverAction>((resolve) => {
      answer = resolve;
    });

  // One drawing at a time, so a progress update never lands on the page being replaced.
  let drawing: Promise<unknown> = Promise.resolve();
  const draw = (step: () => Promise<unknown>) => {
    drawing = drawing.then(step).catch(() => {});
    return drawing;
  };
  // A page is in once its own type is: a view is never shown in a stand-in face.
  const painted = () =>
    win.webContents.executeJavaScript(
      "document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))",
    );
  let shownKind: string | undefined;
  const show = (view: HandOverView) => {
    shownKind = view.kind;
    const html = standaloneDocument({
      title: options.names.to,
      body: handOverBody(view, options.names),
      css: HAND_OVER_CSS,
      theme: dark ? "dark" : "light",
    });
    return draw(async () => {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await painted();
    });
  };
  let latest: MoveProgress = { phase: "checking", done: 0, total: 0 };
  let moveStarted = Date.now();
  let stepStarted = moveStarted;
  const clock = (): MoveClock => ({
    elapsedMs: Date.now() - moveStarted,
    stepElapsedMs: Date.now() - stepStarted,
  });
  const redraw = () => {
    const live = workingLive(latest, clock());
    const script = `(() => {
      const live = document.getElementById("live");
      if (!live) return;
      live.innerHTML = ${JSON.stringify(live)};
      const leave = document.getElementById("leave");
      if (leave) leave.hidden = ${latest.phase === "finishing"};
    })()`;
    void draw(() => win.webContents.executeJavaScript(script));
  };
  let lastDrawn = 0;
  const progress = (update: MoveProgress) => {
    const newStep = update.phase !== latest.phase;
    if (newStep) stepStarted = Date.now();
    // The steps after the copy say nothing of what was counted; the window keeps it.
    latest = update.counted || !latest.counted ? update : { ...update, counted: latest.counted };
    if (shownKind !== "working") {
      void show({ kind: "working", progress: update, clock: clock() });
      return;
    }
    // A new step always draws; within one, at most every PROGRESS_EVERY_MS.
    const now = Date.now();
    if (!newStep && now - lastDrawn < PROGRESS_EVERY_MS) return;
    lastDrawn = now;
    redraw();
  };
  // The time taken moves on while a single long step says nothing new.
  const ticking = setInterval(() => {
    if (shownKind === "working" && Date.now() - lastDrawn >= CLOCK_EVERY_MS) {
      lastDrawn = Date.now();
      redraw();
    }
  }, CLOCK_EVERY_MS);

  await show({ kind: "working", progress: latest, clock: clock() });
  if (!options.hidden) win.show();

  try {
    let choice: MoveChoice | undefined;
    // One take-over per try: a copy that holds the folder again after it is
    // the person's to see, with today's words.
    let tookOver = false;
    for (;;) {
      moveStarted = Date.now();
      stepStarted = moveStarted;
      latest = { phase: "checking", done: 0, total: 0 };
      moving = true;
      const outcome = await runMove(
        move,
        { ...options.deps, progress, signal: stop.signal },
        choice,
      ).finally(() => {
        moving = false;
      });
      // The work is in: a close from here on lets the app open on it, as relaunch does.
      if (outcome.kind === "moved") finished = true;
      if (stop.signal.aborted) {
        if (outcome.kind === "moved") {
          if (outcome.startAtLogin) options.startAtLogin();
          finished = true;
          options.quit();
        } else await leave();
        return;
      }
      if (outcome.kind === "ask") {
        await show(outcome);
        const action = await nextAction();
        if (action === "bring" || action === "keep") {
          choice = action;
          continue;
        }
        await leave();
        return;
      }
      if (outcome.kind === "refused") {
        const held =
          outcome.refusal.reason === "old-app-open" ||
          outcome.refusal.reason === "old-work-running";
        if (held && options.takeOver && !tookOver) {
          tookOver = true;
          takingOver = true;
          // The stopping words show only once the holder is one of ours with no window.
          const taken = await takeOverOlderCopy(move.from, {
            ...options.takeOver,
            stopping: () => show({ kind: "stopping" }),
          }).finally(() => {
            takingOver = false;
          });
          if (taken.kind !== "free" && taken.kind !== "left" && taken.unloaded)
            paused.push(taken.unloaded);
          if (closed) {
            await leave();
            return;
          }
          if (taken.kind === "free" || taken.kind === "stopped") continue;
          if (taken.kind === "still-running") {
            await show({ kind: "wont-stop" });
            const action = await nextAction();
            if (action !== "force") {
              await leave();
              return;
            }
            await show({ kind: "stopping" });
            takingOver = true;
            const forced = await stopOlderCopyNow(move.from, taken.pid, options.takeOver).finally(
              () => {
                takingOver = false;
              },
            );
            if (forced.unloaded) paused.push(forced.unloaded);
            if (closed) {
              await leave();
              return;
            }
            continue;
          }
        }
        await show(outcome);
        const action = await nextAction();
        if (action === "again") {
          tookOver = false;
          continue;
        }
        await leave();
        return;
      }
      if (outcome.kind === "moved") {
        await show({ kind: "moved" });
        if (outcome.startAtLogin) options.startAtLogin();
        // Long enough to read that the work is in before the window gives way to the app.
        await new Promise((resolve) => setTimeout(resolve, READY_HOLD_MS));
      }
      finished = true;
      options.relaunch();
      return;
    }
  } finally {
    clearInterval(ticking);
  }
}
