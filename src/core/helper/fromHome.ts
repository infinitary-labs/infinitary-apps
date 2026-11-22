import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DeviceGrant } from "@shared/devices";
import type { WorkOutcome } from "@shared/remoteLogin";
import type { ExpectedHome } from "@shared/sshConnection";
import { JoinedHome } from "../devices/joinedHome";
import {
  type BackgroundContext,
  type Launcher,
  pauseInBackground,
  readInstalled,
  resumeInBackground,
  type Service,
  startInBackground,
  writeInstalled,
} from "./background";
import { cleanUp } from "./cleanUp";
import { homePlace } from "./homePlace";
import { fetchedLauncher, keepApp } from "./join";
import { STOPPED_RUN_WAIT_MS, takeFolderWithin } from "./lock";
import {
  beginTrial,
  putBack,
  setAside,
  setAsidePath,
  trialPathOf,
  trialWatchOf,
  watchTrial,
} from "./updateTrial";
import { homeLabel } from "./words";

/**
 * What the work mode does when its home started it over Remote Login
 * (docs/helper.md, "Started by the home"): the home's own click updated
 * Firstmate here, or removed what Firstmate set up here. Nobody reads
 * Terminal: each answers one typed outcome the home reads
 * (`workOutcomeSchema`), and says nothing for a person.
 *
 * Both stop the background's run first, so the folder is free, and wait a
 * moment for it to go. A run someone started by hand in Terminal keeps the
 * folder: that is `busy`, and the background is loaded again as it was.
 */

export type FromHomeContext = {
  dataDir: string;
  /**
   * The home and computer the home expects this folder to run work for:
   * a folder that runs work for another home, or as another computer, is
   * refused (`other-home`) before anything here is touched, so an address
   * that now reaches another Mac never removes or updates its Firstmate.
   */
  expected: ExpectedHome;
  /**
   * Whether this computer runs on the home's own Mac, as the home's list
   * found where it joined from (`onThisMac`), which an update's arguments
   * carry (`--on-home-mac`); absent when the list does not say. Its Update
   * holds its SSH connection to this computer, so nothing here can dial the
   * home to hear it while the update runs.
   */
  onHomeMac?: boolean;
  /** Where this user's agent is and how its service manager is asked; null when nothing is set up in the background. */
  background: BackgroundContext | null;
  /** What the background carries of this process's environment: a development run's stand-ins alone. */
  backgroundEnv: Readonly<Record<string, string>>;
  now?: () => number;
  /** How long to wait for a stopped run to let the folder go. */
  lockWaitMs?: number;
  /** How long a copy kept on trial has to reach the home; the update's wait unless a test says. */
  trialSeconds?: number;
};

/**
 * Update: keeps the copy the home sent in place of the one kept here, then
 * starts the background from it again. Where the service manager can be
 * asked from outside this run, the update is on trial (docs/helper.md, "A
 * copy that does not start"): the agent's file, the record and the copy
 * kept here are set aside first, and a copy that does not reach the home
 * within the update's wait is taken away and they are put back, so the
 * background starts the one before it again.
 */
export async function updateFromHome(
  context: FromHomeContext,
  fetched: string,
): Promise<WorkOutcome> {
  const { dataDir, background } = context;
  const joined = new JoinedHome(dataDir, () => {}).read();
  if (!joined) return { firstmate: "refused", reason: "not-joined" };
  if (!expectedHere(joined.grant, context.expected))
    return { firstmate: "refused", reason: "other-home" };
  const before = readInstalled(dataDir);
  const release = await takeFolder(context, before.service);
  if (!release) return { firstmate: "refused", reason: "busy" };
  const watch = background && before.service ? trialWatchOf(background, before.service) : null;
  const previous = setAsidePath(dataDir);
  let aside: { from: string; to: string }[] = [];
  let kept: string | null = null;
  try {
    if (watch && before.service)
      aside = setAside(previous, [
        { path: before.service.file },
        { path: join(dataDir, "installed.json") },
        ...(before.app ? [{ path: before.app, move: true }] : []),
      ]);
    kept = keepApp(fetched, dataDir);
    if (watch) beginTrial(dataDir, kept, previous);
  } catch {
    if (kept) rmSync(kept, { recursive: true, force: true });
    kept = null;
  } finally {
    release();
  }
  if (!kept) {
    // Nothing changed here: the run it stopped starts again as it was.
    if (watch) putBack(aside, previous);
    if (before.service && background) await resumeInBackground(background, before.service);
    return { firstmate: "refused", reason: "not-kept" };
  }
  const launcher = fetchedLauncher(kept);
  keepWhereItRuns(context);
  const state =
    background && launcher
      ? await startInBackground(background, {
          launcher,
          env: context.backgroundEnv,
          app: kept,
        }).catch(() => "failed" as const)
      : "none";
  // A copy under another name - the app on the other side of the Infinitary
  // rename - replaces the one here once the record names it. A background
  // that would not move to it left the one here running as it was.
  if (before.app && before.app !== kept) {
    if (!background) writeInstalled(dataDir, { service: before.service, app: kept });
    const moved = readInstalled(dataDir).app === kept;
    if (!moved) {
      rmSync(kept, { recursive: true, force: true });
      if (watch && before.service && background) {
        rmSync(trialPathOf(dataDir), { force: true });
        putBack(aside, previous);
        await resumeInBackground(background, before.service);
      }
      return { firstmate: "refused", reason: "not-kept" };
    }
    rmSync(before.app, { recursive: true, force: true });
  }
  // Only a copy the background started now can reach the home within the
  // trial's wait; one that starts at the next login, or not at all, is kept
  // with no trial, so the update is not taken back and refused here for good.
  if (watch && before.service && state === "running")
    await watchTrial(dataDir, watch, {
      ...(context.trialSeconds === undefined ? {} : { seconds: context.trialSeconds }),
      restore: {
        restore: aside,
        remove: before.app === kept ? [] : [kept],
        commands: watch.reload(before.service),
      },
    });
  else if (watch) {
    rmSync(trialPathOf(dataDir), { force: true });
    rmSync(previous, { recursive: true, force: true });
  }
  return { firstmate: "updated", background: state };
}

/**
 * The package is already this version. Stop the run and start it again from
 * the installed program, without keeping a copy in the work folder.
 */
export async function restartInstalled(
  context: FromHomeContext,
  launcher: Launcher,
): Promise<WorkOutcome> {
  const { dataDir, background } = context;
  const joined = new JoinedHome(dataDir, () => {}).read();
  if (!joined) return { firstmate: "refused", reason: "not-joined" };
  if (!expectedHere(joined.grant, context.expected))
    return { firstmate: "refused", reason: "other-home" };
  const before = readInstalled(dataDir);
  const release = await takeFolder(context, before.service);
  if (!release) return { firstmate: "refused", reason: "busy" };
  release();
  keepWhereItRuns(context);
  const state = background
    ? await startInBackground(background, {
        launcher,
        env: context.backgroundEnv,
        app: null,
      }).catch(() => "failed" as const)
    : "none";
  return { firstmate: "updated", background: state };
}

/**
 * Remove: its home took it off the list. It lets the home go, keeping one
 * note of which, and removes what Firstmate set up here (`cleanUp`), but a
 * working copy that still holds unmerged work. A removal an earlier run
 * could not finish is finished the same way, with the home already gone.
 * Over Remote Login it is not in this user's login session, so a Claude
 * login Firstmate made here is left to the work's own run, which it starts.
 */
export async function removeFromHome(context: FromHomeContext): Promise<WorkOutcome> {
  const { dataDir, background } = context;
  const joinedHome = new JoinedHome(dataDir, () => {});
  const joined = joinedHome.read();
  if (!joined && !joinedHome.unfinished()) return { firstmate: "refused", reason: "not-joined" };
  // A removal that has not finished has let its home go already, whichever it was.
  if (joined && !expectedHere(joined.grant, context.expected))
    return { firstmate: "refused", reason: "other-home" };
  const { service } = readInstalled(dataDir);
  const release = await takeFolder(context, service);
  if (!release) return { firstmate: "refused", reason: "busy" };
  let outcome: WorkOutcome;
  let claudeLater = false;
  try {
    // Noted as not finished until the removal says what it could not remove.
    if (joined)
      joinedHome.leave(
        {
          name: homeLabel(homePlace(joined.grant), joined.name),
          reason: "removed",
          at: (context.now ?? Date.now)(),
        },
        [],
      );
    const { unremoved, claude, ...result } = await cleanUp({ dataDir, background });
    claudeLater = claude === "later";
    outcome = {
      firstmate: "removed",
      ...result,
      ...(unremoved ? { unremoved: unremoved.slice(0, 64) } : {}),
    };
  } finally {
    release();
  }
  // The Claude login Firstmate made here is signed out only in this user's
  // login session, by the work's own run: started again now, the agent does
  // that and finishes the removal, or does at the next login.
  if (claudeLater && service && background) await resumeInBackground(background, service);
  return outcome;
}

/**
 * Keeps the home's word on where this computer runs on the grant, before the
 * agent is set up anew, which reads it (docs/helper.md, "In the background"):
 * one that joined before its home said it, updated before its run heard a
 * welcome, starts at the priority the home's word gives. With no word, the
 * grant stays as it was.
 */
function keepWhereItRuns(context: FromHomeContext): void {
  if (context.onHomeMac === undefined) return;
  new JoinedHome(context.dataDir, () => {}).onHomeMac(context.onHomeMac);
}

function expectedHere(grant: DeviceGrant, expected: ExpectedHome): boolean {
  return grant.homeKey === expected.homeKey && grant.deviceId === expected.deviceId;
}

/**
 * Stops the background's run and takes the folder once it let it go;
 * null, with the background loaded again, while someone else holds it.
 */
async function takeFolder(
  context: FromHomeContext,
  service: Service | null,
): Promise<(() => void) | null> {
  const { background, dataDir } = context;
  if (service && background) await pauseInBackground(background, service);
  const release = await takeFolderWithin(dataDir, context.lockWaitMs ?? STOPPED_RUN_WAIT_MS);
  if (!release && service && background) await resumeInBackground(background, service);
  return release;
}
