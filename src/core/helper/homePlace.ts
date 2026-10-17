import type { NetworkInterfaceInfo } from "node:os";
import { type DeviceGrant, type HomeVia, splitDialAddress } from "@shared/devices";
import { isThisMachine } from "../connection/addresses";
import type { HomePlace } from "./words";

/**
 * Where a home's link or grant sends this Mac, as its person knows it. One
 * that reaches its home through the home's SSH connection names the home's
 * loopback, the far end of that connection, which is never this Mac's own.
 */
export function homePlace(
  reach: { at: string; via?: HomeVia },
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>,
): HomePlace {
  const host = splitDialAddress(reach.at)?.host ?? reach.at;
  if (reach.via === "ssh") return { host, thisMac: false, overSsh: true };
  return { host, thisMac: isThisMachine(host, interfaces?.()) };
}

/**
 * Whether the work here runs on the home's own Mac, whose window draws the
 * character: as another user there, joined by the command for one or added
 * at this Mac's own address. That user's run and all it starts then keep
 * low priority - its agent starts it as a daemon, and its crewmates' builds
 * and tests stay below that UI - while a separate Mac's run starts as an app
 * and runs them at its own priority (captain on INF-255: "Keep low priority
 * for another user on your own Mac"; docs/helper.md, "In the background" and
 * "Holding a conversation").
 *
 * The address the grant dials tells, whatever its kind: loopback or this
 * Mac's own is the home's own Mac, and another address a separate Mac, as
 * for a Mac that joined as `work` before a Mac could do both. Through the
 * home's SSH connection the grant names only that connection's far end, so
 * its kind is all it tells: the home's look makes a join from its own Mac
 * `work`, and an older `work` join over SSH reads the same. `separateMac`
 * (`./background.ts`) asks the home's SSH session, and the agent's file
 * that keeps its answer, before this.
 */
export function onHomeMac(
  grant: Pick<DeviceGrant, "kind" | "at" | "via">,
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>,
): boolean {
  const place = homePlace(grant, interfaces);
  return place.overSsh ? grant.kind === "work" : place.thisMac;
}
