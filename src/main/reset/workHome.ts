import { dialHome } from "@core/devices/dial";
import { HomeLink } from "@core/devices/homeLink";
import { JoinedHome } from "@core/devices/joinedHome";
import type { BackgroundContext } from "@core/helper/background";
import { cleanUp } from "@core/helper/cleanUp";
import { homePlace } from "@core/helper/homePlace";
import { STOPPED_RUN_WAIT_MS, takeFolderWithin } from "@core/helper/lock";
import { homeDialOptions } from "@core/helper/route";
import { homeLabel } from "@core/helper/words";
import type { DeviceGrant } from "@shared/devices";

/** The part of a link to the home a leave uses. */
export type LeavingLink = {
  start(): void;
  connection(): unknown;
  leave(timeoutMs?: number): Promise<boolean>;
};

export type WorkHomeSeams = {
  /** A link to the home as this computer's work, dialed as the work's own run dials it. */
  link: (grant: DeviceGrant, homeNumber: number) => LeavingLink;
  /** How long the home may take to answer before the work leaves without telling it. */
  reachMs: number;
  /** Waits between looks at whether the link is open. */
  wait: (ms: number) => Promise<void>;
  now: () => number;
};

const REACH_MS = 10_000;
const LOOK_MS = 200;

export const WORK_HOME_SEAMS: Omit<WorkHomeSeams, "link"> = {
  reachMs: REACH_MS,
  wait: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
};

/**
 * A reset leaves the home this computer runs work for (docs/reset.md,
 * "Before it quits"): the home hears Leave, as a device's own Leave sends it,
 * and takes this computer off its list instead of keeping it as out of
 * reach; then the work lets the home go and removes what was set up here
 * for it, as the home's own removal does (`removeFromHome`). The work's
 * working copies sit inside the data folder, so the next start deletes them
 * with it. Called once the work's run is
 * stopped, so its folder is free. True once nothing of that home is left
 * here; a home out of reach still lists this computer until it is removed
 * there.
 */
export async function leaveWorkHome(
  input: { dataDir: string; background: BackgroundContext | null },
  seams: WorkHomeSeams = { ...WORK_HOME_SEAMS, link: workLink(input.dataDir) },
): Promise<boolean> {
  const joinedHome = new JoinedHome(input.dataDir, () => {});
  const joined = joinedHome.read();
  if (!joined && !joinedHome.unfinished()) return true;
  const release = await takeFolderWithin(input.dataDir, STOPPED_RUN_WAIT_MS);
  if (!release) return false;
  try {
    if (joined) {
      const link = seams.link(joined.grant, joinedHome.homeNumber());
      link.start();
      const until = seams.now() + seams.reachMs;
      while (!link.connection() && seams.now() < until) await seams.wait(LOOK_MS);
      await link.leave().catch(() => false);
      joinedHome.leave(
        {
          name: homeLabel(homePlace(joined.grant), joined.name),
          reason: "left",
          at: seams.now(),
        },
        [],
      );
    }
    const { unremoved } = await cleanUp({ dataDir: input.dataDir, background: input.background });
    return !unremoved?.length;
  } finally {
    release();
  }
}

function workLink(dataDir: string): WorkHomeSeams["link"] {
  return (grant, homeNumber) =>
    new HomeLink({
      grant,
      as: "work",
      homeNumber,
      // A link that only leaves listens to nothing the home sends.
      onPush: () => {},
      dial: (dialing, reached) =>
        dialHome(dialing, { ...homeDialOptions(dataDir, dialing), reached }),
    });
}
