import { sign, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DeviceFold, type DeviceGrant, deviceFoldText } from "@shared/devices";
import { keyPin } from "../devices/identity";
import { type Joined, JoinedHome } from "../devices/joinedHome";
import type { Launcher } from "./background";
import { FolderBusyError, lockFolder } from "./lock";
import type { InBackground } from "./words";
import { backgroundFromRecord, keepWindowGrant } from "./workSetup";

/**
 * A Mac's two halves (docs/helper.md, "A Mac that also controls"): the app
 * with its window controls its home with the grant in `userData/joined/`,
 * and its work runs with no window from the work folder (`./place.ts`).
 * Both are one device on the home's list, of kind `mac`, with one key: the
 * app keeps the same grant in each folder, and each connection says which
 * half it is (`DeviceRole`).
 *
 * - A Mac whose window joined keeps its grant in the work folder too, and
 *   its window sets its work up in the background at every connection to
 *   its home, never before a welcome (`setUpWork` in `./workSetup.ts`); the hand-over of a first
 *   mate that moved to another computer sets it up once (`workFromWindow`).
 * - A Mac a command or its address added (`windowFromWork`) opens Firstmate
 *   later as a view of its home, with the grant its work keeps: no new link.
 * - A Mac whose window joined but whose work never kept the grant, added
 *   again by a command or its address (`adoptWindowGrant`): its work takes
 *   the window's grant, so the home keeps one entry for it.
 * - A Mac already on the list twice, once for each half (`foldProof`): its
 *   window asks the home to fold its own entry into the one its work keeps,
 *   signed with that entry's key (docs/devices.md, "One computer, one entry").
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

/** A moved first mate's grant: the work keeps it too and starts in the background. */
export async function workFromWindow(options: WorkFromWindowOptions): Promise<WorkFromWindow> {
  const kept = keepWindowGrant(options);
  if (kept === "other-device") return "other-home";
  if (kept !== "kept") return "busy";
  // Out of the folder's lock, so the run the background starts can take it.
  if (!options.background) return "none";
  return options
    .background(backgroundFromRecord(options.dataDir))
    .catch((): InBackground => "failed");
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

/**
 * The grant the window beside a work folder keeps for the home `homeKey`
 * (`userData/joined/` beside `userData/work/`): only one of kind `mac`, which
 * runs work as well as controlling. Null when the window joined no home,
 * another home, or only controls.
 */
export function windowGrantFor(dataDir: string, homeKey: string): Joined | null {
  const window = new JoinedHome(join(dirname(dataDir), "joined"), () => {}).read();
  if (!window || window.grant.kind !== "mac" || window.grant.homeKey !== homeKey) return null;
  return window;
}

/**
 * One computer, one entry (docs/helper.md, "A Mac that also controls"): a
 * join for the home `homeKey`, from a work folder that keeps no grant
 * beside a window that joined that home as a Mac, keeps the window's grant
 * here first, under the folder's lock, so the join finds the home again
 * with the window's key and the home's entry for this computer stays the
 * one it has. False, and nothing written, when there is no such window, the
 * folder keeps a grant already, is in use, or a removal there has not
 * finished.
 */
export function adoptWindowGrant(dataDir: string, homeKey: string): boolean {
  const window = windowGrantFor(dataDir, homeKey);
  if (!window) return false;
  let release: () => void;
  try {
    release = lockFolder(dataDir);
  } catch (error) {
    if (error instanceof FolderBusyError) return false;
    throw error;
  }
  try {
    const joinedHome = new JoinedHome(dataDir, () => {});
    if (joinedHome.read() || joinedHome.unfinished()) return false;
    joinedHome.join(window.grant, window.joinedAt, window.name);
    return true;
  } finally {
    release();
  }
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

/**
 * The request that folds the window's entry `held` into the one its work
 * keeps, `kept`, for the same home: signed with `kept`'s own key, which
 * proves this Mac holds both. Null when they are not two entries of one
 * home, or `kept`'s key does not sign.
 */
export function foldProof(held: Joined, kept: Joined): DeviceFold | null {
  const { grant } = kept;
  if (held.grant.kind !== "mac" || grant.kind !== "mac") return null;
  if (held.grant.homeKey !== grant.homeKey || held.grant.deviceId === grant.deviceId) return null;
  try {
    const text = deviceFoldText(grant.homeKey, held.grant.deviceId, grant.deviceId);
    const signature = sign("sha256", Buffer.from(text), { key: grant.key, dsaEncoding: "der" });
    return { into: grant.deviceId, cert: grant.cert, signature: signature.toString("base64url") };
  } catch {
    return null;
  }
}
