import { dirname, join } from "node:path";
import { workLabelOf } from "@shared/codeNames";
import type { MoveDeps } from "../folderMove/move";
import {
  type BackgroundContext,
  type Launcher,
  moveInBackground,
  readInstalled,
  rewriteInBackground,
} from "./background";
import { fetchedLauncher } from "./join";
import { type HelperPlace, workFolderNow } from "./place";

/**
 * The work's own part in the one-time move of the Infinitary rename
 * (docs/helper.md, "Under the other name"): a run of this app that finds
 * its work still in an older spelling's folder brings that whole folder
 * into its own with the move engine (src/core/folderMove/move.ts) before it
 * starts, as the app's window does with its hand-over. Then it hands its
 * background to this app's own label, set up anew from the folder the work
 * is in now, and that agent's run takes the work on: an agent names its
 * folder, and only a process other than the agent's own run can set up an
 * agent anew under the same label.
 *
 * A move another process holds up - the older app's run letting the folder
 * go, another move under way - ends this run, and the background starts it
 * again. Any other refusal leaves the work where it is for this run, which
 * goes on from the older folder, and the next run tries again.
 */

export type MoveWorkOptions = {
  /** Where the work is now, with the move due (`HelperPlace.move`). */
  place: HelperPlace;
  /** The background of a work folder whose agent's label is that spelling's; null when nothing is set up in the background. */
  background: (dataDir: string, spelling: HelperPlace["spelling"]) => BackgroundContext | null;
  /** How this app starts itself, for an agent with no copy of Firstmate kept beside the work. */
  launcher: Launcher;
  /** What the background carries of this process's environment. */
  env: Readonly<Record<string, string>>;
  deps: MoveDeps;
  log: (line: string) => void;
};

export type MovedWork =
  /** The work is in this app's own folder now, and this run goes on from it. */
  | { kind: "here"; dataDir: string }
  /** The background under this app's own label runs the work now: this run ends. */
  | { kind: "handed-over" }
  /** Left where it is this time: this run goes on from the older folder. */
  | { kind: "stayed"; dataDir: string }
  /** Held up by another process: this run ends, and the background starts it again. */
  | { kind: "later" };

export async function moveWork(options: MoveWorkOptions): Promise<MovedWork> {
  const { place, log } = options;
  const move = place.move;
  if (!move) return { kind: "here", dataDir: place.dataDir };
  const stay = (why: string): MovedWork => {
    log(`the work stays in ${move.from} for now: ${why}`);
    return { kind: "stayed", dataDir: place.dataDir };
  };
  const ownLabel = workLabelOf(place.spelling, place.flavor);
  // An agent already under this app's own label that names the older folder
  // is this run's own: once the folder moved it could not be set up anew.
  const before = readInstalled(place.dataDir).service;
  if (place.dataDir !== join(move.to, "work") && before?.label === ownLabel)
    return stay("its agent is under this app's own label already");
  // The move itself loads only when one is due.
  const { runMove } = await import("../folderMove/move");
  const outcome = await runMove(move, options.deps);
  if (outcome.kind === "refused") {
    const { refusal } = outcome;
    if (refusal.reason === "busy" || refusal.reason === "old-work-running")
      return { kind: "later" };
    // Committed and not finished: the next run finishes it.
    if (refusal.reason === "failed" && refusal.committed) {
      log(`the move of ${move.from} stopped after it was committed: ${refusal.detail}`);
      return { kind: "later" };
    }
    return stay(refusal.reason === "failed" ? refusal.detail : refusal.reason);
  }
  if (outcome.kind === "ask")
    return stay("both folders hold saved work, which the window asks about");
  const now = workFolderNow({
    appData: dirname(move.to),
    spelling: place.spelling,
    flavor: place.flavor,
  });
  if (now.dataDir !== join(move.to, "work")) return stay("its work is not in this app's folder");
  log(`moved the work from ${move.from} into ${move.to}`);
  return handOver(now.dataDir, options);
}

/**
 * Hands the background to this app's own label, set up anew from the work
 * folder it moved into; the agent recorded before it goes last, which ends
 * this run when it is that agent's own. With no agent, or one under this
 * app's label already, the run goes on from the folder. A new agent the
 * service manager refuses leaves the one before running as it was, and the
 * next run tries again.
 */
async function handOver(dataDir: string, options: MoveWorkOptions): Promise<MovedWork> {
  const { place } = options;
  const installed = readInstalled(dataDir);
  const background = options.background(dataDir, place.spelling);
  const label = workLabelOf(place.spelling, place.flavor);
  if (!installed.service || !background || installed.service.label === label)
    return { kind: "here", dataDir };
  const moved = await moveInBackground(background, {
    label,
    launcher: fetchedLauncher(installed.app) ?? options.launcher,
    env: options.env,
    app: installed.app,
  });
  if (moved.state === "failed") {
    // The agent before it runs on as it was loaded, naming the older
    // folder; its file names this one from its next load.
    rewriteInBackground(background, installed.service, {
      launcher: fetchedLauncher(installed.app) ?? options.launcher,
      env: options.env,
      app: installed.app,
    });
    options.log("could not start the background under this app's own label");
    return { kind: "here", dataDir };
  }
  await moved.retire();
  return { kind: "handed-over" };
}
