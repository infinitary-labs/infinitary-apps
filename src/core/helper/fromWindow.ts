import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeviceGrant } from "@shared/devices";
import { keyPin } from "../devices/identity";
import { type Joined, JoinedHome } from "../devices/joinedHome";
import type { Launcher } from "./background";
import { FolderBusyError, lockFolder } from "./lock";
import type { InBackground } from "./words";

/**
 * A Mac's two halves (docs/helper.md, "A Mac that also controls"): the app
 * with its window controls its home with the grant in `userData/joined/`,
 * and its work runs with no window from the work folder (`./place.ts`).
 * Both are one device on the home's list, of kind `mac`, with one key: the
 * app keeps the same grant in each folder, and each connection says which
 * half it is (`DeviceRole`).
 *
 * - A Mac that joined at Firstmate's first launch (`workFromWindow`) keeps
 *   its grant in the work folder too and sets its work up in the background,
 *   as a command's join does.
 * - A Mac a command or its address added (`windowFromWork`) opens Firstmate
 *   later as a view of its home, with the grant its work keeps: no new link.
 */

/**
 * How setting up the work went: `running`, `at-login`, `failed` or `none`
 * as the background answered; `other-home` when this user runs work for
 * another home already, which stays; `busy` when the folder is in use or a
 * removal there has not finished.
 */
export type WorkFromWindow = InBackground | "other-home" | "busy";

export type WorkFromWindowOptions = {
  /** The work folder for this user. */
  dataDir: string;
  /** The grant the window joined with, of kind `mac`. */
  grant: DeviceGrant;
  /** The home's name, once it has said it. */
  name: string | null;
  joinedAt: number;
  /** Sets the work up to run in the background from this app; nothing when absent. */
  background?: (setUp: { launcher: Launcher | null; app: string | null }) => Promise<InBackground>;
};

/** The window joined as a Mac: its work keeps the same grant and starts in the background. */
export async function workFromWindow(options: WorkFromWindowOptions): Promise<WorkFromWindow> {
  const { dataDir, grant } = options;
  const joinedHome = new JoinedHome(dataDir, () => {});
  let release: () => void;
  try {
    release = lockFolder(dataDir);
  } catch (error) {
    if (error instanceof FolderBusyError) return "busy";
    throw error;
  }
  try {
    const already = joinedHome.read();
    if (already && already.grant.deviceId !== grant.deviceId) return "other-home";
    // A removal that has not finished here is the run's to finish first.
    if (!already && joinedHome.unfinished()) return "busy";
    if (!already) {
      joinedHome.join(grant, options.joinedAt);
      if (options.name) joinedHome.name(options.name);
    }
  } finally {
    release();
  }
  // Out of the folder's lock, so the run the background starts can take it.
  if (!options.background) return "none";
  return options.background({ launcher: null, app: null }).catch((): InBackground => "failed");
}

/**
 * The grant a Mac's work keeps, for its window to control the same home
 * with (`Shell`): only a grant of kind `mac`, never one that only runs work,
 * never the device this app last left or was removed as, and never the
 * first mate this app's own data folder holds, which a move brought here
 * (docs/devices.md, "Moving the first mate").
 */
export function windowFromWork(dataDir: string, leftDeviceId: string | null): Joined | null {
  const joined = new JoinedHome(dataDir, () => {}).read();
  if (!joined || joined.grant.kind !== "mac") return null;
  if (joined.grant.deviceId === leftDeviceId) return null;
  if (ownHomePin(dirname(dataDir)) === joined.grant.homeKey) return null;
  return joined;
}

/** The pin of the home key a data folder keeps, or null when it keeps none. */
function ownHomePin(userData: string): string | null {
  try {
    const cert = readFileSync(join(userData, "devices", "home-cert.pem"), "utf8");
    return keyPin(new X509Certificate(cert).publicKey);
  } catch {
    return null;
  }
}
