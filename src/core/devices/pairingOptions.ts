import type { NetworkInterfaceInfo } from "node:os";
import type { FoundTools } from "@shared/connection";
import type { DeviceKind, DeviceView, HomeFirewall } from "@shared/devices";
import type { Locality } from "./locality";

/** The shapes `DevicePairing` is made with and keeps its links in (`./pairing.ts`). */

export type Link = {
  id: string;
  kind: DeviceKind;
  expiresAt: number;
  spent: boolean;
  /** The address the home reached the device at to have it use this link, over Remote Login. */
  remoteLogin?: string;
  /** The device reaches this Mac only through this Mac's SSH connection to `remoteLogin`. */
  via?: "ssh";
  /**
   * Where the device joins from, as the home found it over SSH before the
   * link existed (`./locality.ts`); absent, where its socket dialed from.
   */
  locality?: Locality;
  /** The device that used it. */
  deviceId?: string;
};

export type DevicePairingOptions = {
  /** `userData/devices`: 0700, every file in it 0600. */
  dir: string;
  now?: () => number;
  /** Runs `run` after `ms`; answers its own cancel. Tests pass a manual clock. */
  schedule?: (ms: number, run: () => void) => () => void;
  /** Where pairing says what it could not do; never given a link or a code. */
  onProblem?: (text: string) => void;
  /**
   * A device used its link and is on the list; told after the list is
   * written, with what a computer that runs work said it found there.
   * `again` when one already on the list used it to find this Mac again.
   */
  onJoined?: (device: DeviceView, found: FoundTools | undefined, again: boolean) => void;
  /** A device's person chose Leave and it is off the list; told after the list is written. */
  onLeft?: (device: DeviceView) => void;
  /** This Mac's network interfaces right now; tests stand in their own. */
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** The port a link names; the connection's own unless a test moves it. */
  port?: number;
  /**
   * The number of the macOS user the home runs as, which a computer that
   * runs work on this Mac may not run as (docs/helper.md). This process's
   * own unless a test, which has one user to run as, stands in another.
   */
  ownUid?: number;
  /**
   * The security identifier of the Windows user the home runs as, which a
   * computer that runs work on this PC may not run as: Windows gives a user
   * no number. Undefined until the home has read it, and null when it could
   * not; either refuses a join from this PC that says an identifier, since
   * it might be the home's own.
   */
  ownSid?: () => string | null | undefined;
  /**
   * A development run's stand-in for another Mac (`INFINITARY_JOINS_FROM_ANOTHER_MAC`):
   * every device joins as from another Mac, so two apps on one Mac read as
   * two Macs, as `INFINITARY_DEVICE_NAME` makes them say.
   */
  joinsFromAnotherMac?: boolean;
  /**
   * Leave from a Mac that runs work (docs/devices.md, "Leave"): its work
   * comes here before it is off the list, so the removal is Remove's
   * (`Computers`); answers whether it took it over.
   */
  leaveWithWork?: (device: DeviceView) => boolean;
  /**
   * A Linux or Windows home's look at its own firewall (`firewallKeepsOut`,
   * `windowsFirewallKeepsOut`, `./firewall.ts`), which Devices says may keep
   * devices out; none on a Mac.
   */
  firewall?: () => Promise<HomeFirewall | null>;
  /**
   * False on a home that cannot set a computer up by its address (a Windows
   * PC, whose own ssh keeps no control connection): Devices and the first
   * mate offer the link and the command there instead.
   */
  addsByAddress?: false;
};
