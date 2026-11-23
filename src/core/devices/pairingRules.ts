import type { DeviceUser, PairRefusal } from "@shared/connection";
import { HERE } from "@shared/deviceNames";
import { type DeviceKind, type DeviceSystem, isPhone, systemRunsWork } from "@shared/devices";

/** What pairing decides from what a device said, with no files or links in it (`./pairing.ts`). */

export const REASONS: Record<PairRefusal, string> = {
  malformed: "The request to join is not one this home reads.",
  unknown: "This home has no open link with that code. Ask for a new link.",
  unproven: "The device showed no key of its own.",
  kind: "This link is for another kind of device.",
  paired: "This device is paired with this home already.",
  removed: "This home removed this device. Use the link again to join anew.",
  "same-user": `This is the user Infinitary already runs as. Log in as another user on ${HERE.this}, and run it there.`,
  used: "This link was used already. Ask for a new one.",
  expired: "This link has expired. Ask for a new one.",
};

/**
 * Whether a user joining from this computer is the one the home runs as: the
 * same number on a Mac or Linux, or on Windows the same security identifier,
 * or one the home could not compare with its own, which might be it.
 */
export function sameUser(
  user: DeviceUser,
  ownUid: number | undefined,
  ownSid: string | null | undefined,
) {
  if ("uid" in user) return user.uid === ownUid;
  return !ownSid || user.sid === ownSid;
}

/**
 * The kind a device joins as (docs/devices.md, "Joining"): what its link
 * was made for, but a link for a Mac used from this Mac itself - as another
 * macOS user by its command, or by a second app at its first launch - joins
 * as another user here, which only runs work, or as a second app, which
 * only controls. A phone only controls.
 */
export function joinedKind(
  link: DeviceKind,
  onThisMac: boolean,
  window: boolean,
  system?: DeviceSystem,
): DeviceKind {
  // A phone only controls, whichever link it used.
  if (isPhone({ system })) return "view";
  // A device whose system runs no work only controls (`systemRunsWork`).
  if (window && !systemRunsWork(system) && link === "mac") return "view";
  if (link !== "mac" || !onThisMac) return link;
  return window ? "view" : "work";
}

/** Where a device reached this Mac on a socket: the address and port it dialed. */
export function reachedOn(socket: {
  localAddress?: string;
  localPort?: number;
}): string | undefined {
  const host = socket.localAddress?.replace(/^::ffff:/, "");
  if (!host || !socket.localPort) return undefined;
  return `${host.includes(":") ? `[${host}]` : host}:${socket.localPort}`;
}
