import { dirname, join } from "node:path";
import { workLabelOf } from "@shared/codeNames";
import type { MoveDeps } from "../folderMove/move";
import { type TakeOverDeps, takeOverOlderCopy } from "../folderMove/takeOver";
import { isProfileRetired } from "../storage/retiredProfile";
import {
  type BackgroundContext,
  type Launcher,
  moveInBackground,
  pauseInBackground,
  readInstalled,
  resumeInBackground,
  rewriteInBackground,
  type Service,
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
 * An older copy's background work holding the older folder is taken over
 * first, as the window's hand-over does (src/core/folderMove/takeOver.ts):
 * its agent let go, the ordinary stop sent, and the move made once it let
 * the folder go. A run a command started is a first mate the person runs,
 * so, like the older app's window, it is theirs to stop: nobody watches this
 * run. An older work run that does not stop, another move under way, or a
 * move committed and not finished ends this run, and the background starts
 * it again. Any other refusal leaves the work where it is for this run,
 * which goes on from the older folder, and the next run tries again.
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
  /** Stand-ins for the take-over's reads and signals, as a test gives them. */
  takeOver?: Partial<TakeOverDeps>;
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
  let outcome = await runMove(move, options.deps);
  // Starts the agent a take-over let go again, for a run that ends without
  // the work before anything was committed: on `stay` this run carries the
  // work from the older folder itself, and once committed the older folder
  // is a frozen recovery copy that nothing should start on again.
  let resumeOnLater = async () => {};
  if (outcome.kind === "refused" && outcome.refusal.reason === "old-work-running") {
    const background = options.background(place.dataDir, place.folderSpelling);
    const deps: TakeOverDeps = {
      platform: options.deps.platform,
      hostname: options.deps.hostname,
      ...(options.deps.alive ? { alive: options.deps.alive } : {}),
      ...(background
        ? {
            unloadAgent: (service) => pauseInBackground(background, service),
            resumeAgent: (service) => resumeInBackground(background, service),
          }
        : {}),
      ...options.takeOver,
    };
    const taken = await takeOverOlderCopy(move.from, deps);
    const resume = async (service: Service | undefined) => {
      if (service && !isProfileRetired(move.from))
        await deps.resumeAgent?.(service).catch(() => {});
    };
    if (taken.kind === "stopped") {
      // i18n-exempt: a note in the work's own log, which a person reading a fault reads in English
      log(
        `stopped the older copy's ${taken.copy === "work" ? "background work" : "run"} holding ${move.from}${taken.unloaded ? `, after letting its agent ${taken.unloaded.label} go` : ""}`,
      );
      resumeOnLater = () => resume(taken.unloaded);
      outcome = await runMove(move, options.deps);
    } else if (taken.kind === "still-running") {
      // i18n-exempt: a note in the work's own log, which a person reading a fault reads in English
      log(`the older copy holding ${move.from} did not stop when asked`);
      await resume(taken.unloaded);
      return { kind: "later" };
    }
  }
  if (outcome.kind === "refused") {
    const { refusal } = outcome;
    if (refusal.reason === "busy" || refusal.reason === "old-work-running") {
      await resumeOnLater();
      return { kind: "later" };
    }
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
  return (await handBackgroundOver(now.dataDir, { ...options, ...place }))
    ? { kind: "handed-over" }
    : { kind: "here", dataDir: now.dataDir };
}

export type BackgroundHandOver = Pick<HelperPlace, "spelling" | "flavor"> &
  Pick<MoveWorkOptions, "background" | "launcher" | "env" | "log">;

/**
 * Hands the background to this app's own label, set up anew from the work
 * folder it moved into; the agent recorded before it goes last, which ends
 * this run when it is that agent's own. The work run calls it after its
 * move, and so does the window's hand-over, so the older agent's file does
 * not start the older program again at the next login. True once the new
 * agent runs the work. With no agent, or one under this app's label
 * already, nothing changes. A new agent the service manager refuses leaves
 * the one before as it was, its file naming this folder, and the next run
 * tries again.
 */
export async function handBackgroundOver(
  dataDir: string,
  options: BackgroundHandOver,
): Promise<boolean> {
  const installed = readInstalled(dataDir);
  const background = options.background(dataDir, options.spelling);
  const label = workLabelOf(options.spelling, options.flavor);
  if (!installed.service || !background || installed.service.label === label) return false;
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
    return false;
  }
  await moved.retire();
  return true;
}
