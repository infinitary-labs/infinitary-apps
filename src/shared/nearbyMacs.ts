import { z } from "zod";
import { COMPUTER } from "./deviceNames";
import { type DeviceView, deviceNameSchema } from "./devices";

/**
 * Macs on this network with Remote Login on, listed while "By its address"
 * is open in Settings -> Devices (docs/devices.md, "Macs nearby"; design
 * skill `components/devices/AddAMac`, "Nearby"). Remote Login announces
 * itself over Bonjour, and this Mac only listens for that: it never tries
 * the addresses around it. Picking one fills the address field with this
 * Mac's own user name at that Mac's name on the network, which the captain
 * may change before Add it; typing an address still works.
 */

/** A Mac's name on this network, such as `Kuns-Mac-mini.local`: what an address takes after the `@`. */
export const nearbyMacNameSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,190}$/);

/** A user name an address may carry before the `@` (`remoteLoginAddressSchema`). */
export const nearbyUserSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/);

export const nearbyMacSchema = z.strictObject({
  /** The name it announces, its own name in System Settings, drawn as text. */
  name: deviceNameSchema,
  /** Its name on this network. */
  at: nearbyMacNameSchema,
});
export type NearbyMac = z.infer<typeof nearbyMacSchema>;

/**
 * Where the looking stands:
 *
 * - `off`: nobody asked, it stopped, or this computer cannot look (a Linux computer
 *   without Avahi's `avahi-browse`).
 * - `looking`: listening now; `macs` holds each Mac that answered so far.
 * - `not-allowed`: macOS said this app may not use the local network
 *   (Bonjour's policy-denied answer); a Mac that answers once it is allowed
 *   still appears.
 * - `failed`: the looking itself stopped or was refused for another reason.
 */
export const nearbyMacsStateSchema = z.enum(["off", "looking", "not-allowed", "failed"]);
export type NearbyMacsState = z.infer<typeof nearbyMacsStateSchema>;

export const nearbyMacsViewSchema = z.strictObject({
  state: nearbyMacsStateSchema,
  /** The user Firstmate runs as here, filled in before each Mac's name; null when no address could carry it. */
  user: nearbyUserSchema.nullable(),
  /** Every Mac but this one, in the order they answered. */
  macs: z.array(nearbyMacSchema).max(64),
});
export type NearbyMacsView = z.infer<typeof nearbyMacsViewSchema>;

export const NEARBY_OFF: NearbyMacsView = { state: "off", user: null, macs: [] };

/** How long a look runs after the last ask, so a window that went away leaves nothing listening. */
export const NEARBY_LEASE_MS = 60_000;

/** How often an open aside asks again, well inside the lease. */
export const NEARBY_RENEW_MS = 20_000;

/** The address a nearby Mac fills in: this Mac's user at that Mac's name on the network. */
export function nearbyAddress(mac: NearbyMac, user: string | null): string {
  return user ? `${user}@${mac.at}` : mac.at;
}

/** The part of an address after its user, as names compare: no case, no closing dot. */
function placeOf(address: string): string {
  const at = address.lastIndexOf("@");
  return (at < 0 ? address : address.slice(at + 1)).replace(/\.$/, "").toLowerCase();
}

/**
 * Whether a nearby Mac is one already on Your devices: one added at its
 * name on this network, or one that joined under the same name. Another
 * user on this Mac carries this Mac's name, and this Mac is never a nearby
 * row, so it is never matched by name.
 */
export function nearbyOnList(mac: NearbyMac, devices: readonly DeviceView[]): boolean {
  const at = placeOf(mac.at);
  return devices.some(
    (device) =>
      (device.remoteLogin !== undefined && placeOf(device.remoteLogin) === at) ||
      (device.onThisMac !== true && device.name === mac.name),
  );
}

/** The words Settings -> Devices says about Macs nearby. */
export const nearbyMacsWords = {
  /** The list's micro label. */
  label: "On this network",
  /** While nothing answered yet. */
  looking: `Looking for ${COMPUTER.many} on this network with Remote Login on…`,
  /** The same on a Linux home, which also hears a Linux computer's SSH server (Avahi). */
  lookingSsh: `Looking for ${COMPUTER.many} on this network that announce SSH…`,
  /** A Mac already on Your devices. */
  onList: "on your list",
  /** macOS did not let this app use the local network. */
  notAllowed: [
    `macOS has not let Infinitary look for ${COMPUTER.many} on this network.`,
    "Allow it in System Settings, under Privacy & Security, Local Network. You can still type an address.",
  ] as const,
  /** The looking stopped. */
  failed: `Could not look for ${COMPUTER.many} on this network. You can still type an address.`,
} as const;
