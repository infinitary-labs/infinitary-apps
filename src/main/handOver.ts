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
  progressLine,
} from "./handOverPage";
import { standaloneDocument, standaloneWindow } from "./savedDataRefusal";

/**
 * The one-time move's hand-over (src/core/folderMove/move.ts): the window a
 * person sees while an app with a new identity brings an older folder's
 * saved work into its own, before anything opens either folder. It shows
 * the move as it goes, asks which work to open when both folders hold some,
 * and says why a move stopped with a way to try again. Once the work is in,
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

/** How long the finished view stays before the app opens on its folder. */
const READY_HOLD_MS = 1200;

export async function runHandOver(move: FolderMove, options: HandOverOptions): Promise<void> {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = standaloneWindow({
    title: options.names.to,
    width: 680,
    height: 540,
    backgroundColor: dark ? "#05070d" : "#eef1f7",
  });
  let finished = false;
  win.on("closed", () => {
    if (!finished) options.quit();
  });
  let answer: ((action: HandOverAction) => void) | undefined;
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    const action = actionOf(url);
    if (action) answer?.(action);
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
  let lastDrawn = 0;
  let lastPhase: string | undefined;
  const progress = (update: MoveProgress) => {
    if (shownKind !== "working") {
      lastPhase = update.phase;
      void show({ kind: "working", progress: update });
      return;
    }
    // A new phase always draws; within one, at most every PROGRESS_EVERY_MS.
    const now = Date.now();
    if (update.phase === lastPhase && now - lastDrawn < PROGRESS_EVERY_MS) return;
    lastDrawn = now;
    lastPhase = update.phase;
    const line = progressLine(update);
    const script = `(() => {
      document.getElementById("status").textContent = ${JSON.stringify(line.status)};
      document.getElementById("amount").textContent = ${JSON.stringify(line.amount)};
      document.getElementById("fill").style.width = ${JSON.stringify(`${(line.fill * 100).toFixed(1)}%`)};
    })()`;
    void draw(() => win.webContents.executeJavaScript(script));
  };

  await show({ kind: "working", progress: { phase: "checking", done: 0, total: 0 } });
  if (!options.hidden) win.show();

  let choice: MoveChoice | undefined;
  for (;;) {
    const outcome = await runMove(move, { ...options.deps, progress }, choice);
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
}
