import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DeviceGrant } from "@shared/devices";
import type { WorkSetupReport } from "@shared/workSetup";
import { JoinedHome } from "../devices/joinedHome";
import { hostPlatform } from "../platform";
import { moveLockPathFor, moveLockRunning } from "../storage/moveLock";
import { type Launcher, readInstalled } from "./background";
import { fetchedLauncher } from "./join";
import { FolderBusyError, folderHolder, lockFolder } from "./lock";
import type { InBackground } from "./words";

/**
 * A Mac's window checks its work half (docs/view.md, "A Mac that runs
 * work"; `@shared/workSetup`) at every connection to its home, the first of
 * each launch included and never before a welcome, and on Try again or its
 * home's Fix it, with no new link:
 *
 * 1. the work folder keeps the window's own grant, written again when it is
 *    missing; another device's grant, or a removal there that has not
 *    finished, stays as it is and is named;
 * 2. a live run holds the folder, and then nothing is touched;
 * 3. otherwise the background is set up again, from the copy of the app
 *    the work folder records when it keeps one, else from the app that runs
 *    now unless that app runs from a place that does not last, and the check
 *    waits a moment for the run it starts to take the folder.
 *
 * Whether the work reached its home is the home's own reading, from the
 * work's contact, never this check's. Null when nothing here sets up work in
 * the background, as in a test that stands in none: there is nothing to say.
 */
export type WorkSetupOptions = {
  /** The work folder for this user. */
  dataDir: string;
  /** The grant the window controls its home with, of kind `mac`. */
  grant: DeviceGrant;
  /** The home's name, once it has said it. */
  name: string | null;
  joinedAt: number;
  /** Sets the work up to run in the background from this app; nothing when absent. */
  background?: (setUp: { launcher: Launcher | null; app: string | null }) => Promise<InBackground>;
  /** Where the app that runs now is, which the background would start (`process.execPath`). */
  appPath?: string;
  /** This computer's system, as `hostPlatform()` says it. */
  platform?: string;
  /** How long to wait for the run the background starts to take the folder. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** How long the check waits for a run it started to hold the folder, and how often it looks. */
const RUN_WAIT_MS = 15_000;
const RUN_LOOK_MS = 250;

/**
 * The window's grant kept in the work folder too (docs/helper.md, "A Mac that
 * also controls"), written when the folder keeps none: `kept` once it keeps
 * this device's grant; `other-device` when it keeps another's, which stays;
 * `removal-unfinished` when a removal there has not finished; `newer` when
 * a newer Infinitary saved the grant there, which this version cannot read
 * and never writes over; `busy` when a run holds the folder, which is then
 * left as it is. Both a check of the
 * work and the hand-over of a moved first mate take this one step.
 */
export type GrantKept = "kept" | "other-device" | "removal-unfinished" | "newer" | "busy";

export function keepWindowGrant(options: {
  dataDir: string;
  grant: DeviceGrant;
  name: string | null;
  joinedAt: number;
}): GrantKept {
  const joinedHome = new JoinedHome(options.dataDir, () => {});
  let release: () => void;
  try {
    release = lockFolder(options.dataDir);
  } catch (error) {
    if (error instanceof FolderBusyError) return "busy";
    throw error;
  }
  try {
    const already = joinedHome.read();
    if (already && already.grant.deviceId !== options.grant.deviceId) return "other-device";
    // A grant a newer Infinitary saved here is that version's, never written over.
    if (!already && joinedHome.savedByNewer()) return "newer";
    // A removal that has not finished here is the run's to finish first.
    if (!already && joinedHome.unfinished()) return "removal-unfinished";
    // The grant and the home's name in the one write that puts the record in
    // place: Windows refuses a second write while anything holds it open.
    if (!already) joinedHome.join(options.grant, options.joinedAt, options.name || null);
    return "kept";
  } finally {
    release();
  }
}

/**
 * What the background is set up from: the copy of the app kept beside the
 * work when the work folder records one (`installed.json`), as a command's
 * join or an update left it, so a removal and the home's updates still find
 * it; otherwise this app (a null launcher), as a window's own join does.
 */
export function backgroundFromRecord(dataDir: string): {
  launcher: Launcher | null;
  app: string | null;
  gone?: true;
} {
  const { app } = readInstalled(dataDir);
  const launcher = fetchedLauncher(app);
  // A copy the record names that is no longer there starts nothing: the app
  // asking is started instead, and setting it up clears the record.
  if (launcher && !existsSync(launcher.executable))
    return { launcher: null, app: null, gone: true };
  return { launcher, app };
}

export async function setUpWork(options: WorkSetupOptions): Promise<WorkSetupReport | null> {
  const { dataDir, grant } = options;
  const named = (): WorkSetupReport | null => {
    // The folder's own grant names whose work it is: another first mate's, or
    // this one's under another entry; with none, a removal is finishing.
    const joinedHome = new JoinedHome(dataDir, () => {});
    const held = joinedHome.read();
    if (!held && joinedHome.savedByNewer()) return { state: "blocked", reason: "newer-work" };
    if (held?.grant.deviceId === grant.deviceId)
      return options.background ? { state: "running" } : null;
    if (!held) return { state: "blocked", reason: "removal-unfinished" };
    return held.grant.homeKey === grant.homeKey
      ? { state: "blocked", reason: "other-entry" }
      : { state: "blocked", reason: "other-home" };
  };
  const kept = keepWindowGrant(options);
  // A run holds the folder: for this grant it is the work running.
  if (kept === "busy" || kept === "other-device") return named();
  if (kept === "removal-unfinished") return { state: "blocked", reason: "removal-unfinished" };
  if (kept === "newer") return { state: "blocked", reason: "newer-work" };
  if (!options.background) return null;
  const now = options.now ?? Date.now;
  // A live run, or one the data folder's move is about to start, is left alone.
  if (folderHolder(dataDir) !== null) return { state: "running" };
  if (moveLockRunning(moveLockPathFor(dirname(dataDir)), now)) return { state: "starting" };
  const from = backgroundFromRecord(dataDir);
  // Only this app's own place matters when it is what the background starts.
  if (
    !from.app &&
    options.appPath &&
    placeDoesNotLast(options.appPath, options.platform ?? hostPlatform())
  )
    return { state: "blocked", reason: "app-place" };
  const started = await options
    .background({ launcher: from.launcher, app: from.app })
    .catch((): InBackground => "failed");
  // The background now starts this app where the copy it named was gone: said once.
  const gone = from.gone ? ({ copyGone: true } as const) : {};
  switch (started) {
    case "failed":
      return { state: "blocked", reason: "background-off" };
    case "unavailable":
    case "unknown":
      return { state: "blocked", reason: "no-background" };
    case "none":
      return null;
    case "at-login":
      return { state: "starting", ...gone };
    default:
      break;
  }
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = now() + (options.waitMs ?? RUN_WAIT_MS);
  for (;;) {
    if (folderHolder(dataDir) !== null) return { state: "running", ...gone };
    if (now() >= until) return { state: "starting", ...gone };
    await sleep(RUN_LOOK_MS);
  }
}

/**
 * Whether a Mac's app runs from a place the background cannot start it from
 * later: the copy macOS runs from a hidden folder when an app downloaded from
 * the internet was never moved (App Translocation), or a disk image mounted
 * under /Volumes, which is read-only and goes when it is ejected. A drive
 * under /Volumes the person can write to is a place like any other. Never on
 * another system.
 */
export function placeDoesNotLast(
  appPath: string,
  platform: string,
  writable: (path: string) => boolean = canWrite,
): boolean {
  if (platform !== "darwin") return false;
  if (appPath.includes("/AppTranslocation/")) return true;
  return appPath.startsWith("/Volumes/") && !writable(dirname(appPath));
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
