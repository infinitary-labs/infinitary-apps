import type { FolderMove } from "@core/folderMove/due";
import { type MoveChoice, type MoveDeps, type MoveProgress, runMove } from "@core/folderMove/move";
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
 * and says why a move stopped with a way to try again. While it counts,
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
  win.on("closed", () => {
    if (finished) return;
    if (moving) quitWhileMoving();
    else options.quit();
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
      if (stop.signal.aborted) {
        if (outcome.kind === "moved" && outcome.startAtLogin) options.startAtLogin();
        finished = true;
        options.quit();
        return;
      }
      if (outcome.kind === "ask") {
        await show(outcome);
        const action = await nextAction();
        if (action === "bring" || action === "keep") {
          choice = action;
          continue;
        }
        options.quit();
        return;
      }
      if (outcome.kind === "refused") {
        await show(outcome);
        const action = await nextAction();
        if (action === "again") continue;
        options.quit();
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
