import { createHash, randomBytes, randomUUID, verify, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  CONNECTION_PORT,
  type DeviceUser,
  type FetchAppRefusal,
  type FoundTools,
  fetchAppRequestSchema,
  type PairRefusal,
  pairRequestSchema,
} from "@shared/connection";
import { COMPUTER, HERE } from "@shared/deviceNames";
import {
  automaticStartupSchema,
  buildPairingLink,
  type DeviceAddresses,
  type DeviceChip,
  type DeviceInvite,
  type DeviceInviteRequest,
  type DeviceKind,
  type DeviceSystem,
  type DeviceView,
  deviceChipSchema,
  deviceLabel,
  deviceRunsWork,
  deviceSystemSchema,
  deviceViewSchema,
  type HomeFirewall,
  isPhone,
  KEY_TEXT_PATTERN,
  PAIRING_LINK_ALSO_MAX,
  PAIRING_LINK_TTL_MS,
  splitDialAddress,
  systemRunsWork,
} from "@shared/devices";
import type {
  PhonePushAnswer,
  PhonePushLetter,
  PhonePushRegistration,
  PhonePushTarget,
} from "@shared/phonePush";
import { remoteLoginAddressSchema } from "@shared/remoteLogin";
import { devicePlace } from "@shared/signIns";
import type { PhoneStandby } from "@shared/standbyPhone";
import { z } from "zod";
import {
  isThisMachine,
  LOOPBACK_ADDRESS,
  offeredAddresses,
  onLocalNetwork,
  privateAddresses,
  reachedNetwork,
} from "../connection/addresses";
import type { PairedDevice, PairedDevices, PairOutcome } from "../connection/connection";
import { readHomeNumber, writeHomeNumber } from "./homeNumber";
import { type LetterTaken, PairingPushRecords, type PhoneLetterBox } from "./pairingPushRecords";

/** Which takeover made this home, in its record (`TAKE_OVER_RECORD`, src/core/standby/takeOver.ts). */
const TAKE_OVER_FILE = "take-over.json";
const takeOverIdSchema = z.object({ id: z.string().uuid() });

/**
 * The way back of a home whose record is copied (docs/devices.md, "An old
 * home that returns"): a Mac on its own list whose id the record names
 * (`returning.json`, copied with it), and whose key only this home keeps
 * (`returning-key.json`, never copied), so a computer that takes over from
 * a copy already lets the old home in when it returns.
 */
const RETURNING_FILE = "returning.json";
/** Its file name in the devices folder; `WAY_BACK_KEY` in the record's terms (src/core/homeMove/record.ts). */
const RETURNING_KEY_FILE = "returning-key.json";
const returningKeySchema = z.object({
  version: z.literal(1),
  deviceId: z.string().min(1).max(64),
  key: z.string().min(1),
  cert: z.string().min(1),
});
export type ReturningIdentity = { deviceId: string; key: string; cert: string };
const returningIdSchema = z.object({ deviceId: z.string().min(1).max(64) });

import {
  HOST_TRUST_FILE,
  HOST_TRUST_KNOWN_HOSTS,
  type HostKey,
  hostTrustFileSchema,
  hostTrustSshOptions,
  knownHostsLine,
} from "./hostTrust";
import {
  createKeyIdentity,
  type KeyIdentity,
  keyPin,
  loadOrCreateHomeIdentity,
  peerPin,
  writePrivate,
} from "./identity";
import type { Locality } from "./locality";
import {
  makeOwnKey,
  OWN_KEY_PLACED_FILE,
  type OwnKey,
  ownKeyPlacedSchema,
  ownKeySshOptions,
  readOwnKey,
} from "./ownKey";

/**
 * Pairing (docs/devices.md): the one writer over `userData/devices/`, and
 * the connection's pairing seam. It makes one-use ten-minute links, spends
 * one when a device uses it, keeps the list of what joined, and answers who
 * a connection request proves to be. Its only secret is the home's own key:
 * a link's code lives only as its hash, in memory, and a device is known by
 * the pin of the key it showed in TLS, which is public. A link carries
 * every address this computer has; the saved choice of one is read no more.
 */

const LIST_FILE = "devices.json";
const LIST_VERSION = 1;
/**
 * When each device was last in reach, and the computers that run work the
 * captain chose to remove once they are back (docs/devices.md, "Remove"):
 * files of their own beside the list, so a list an older app reads is
 * still the list it knows.
 */
const SEEN_FILE = "seen.json";
const seenFileSchema = z.strictObject({
  version: z.literal(1),
  seen: z.record(z.string(), z.number().int().nonnegative()),
});
/**
 * The version of Firstmate that did not start on each computer that runs
 * work, which went back to the copy it kept (docs/helper.md, "A copy that
 * does not start"): never sent there again.
 */
const FAILED_UPDATES_FILE = "failed-updates.json";
const failedUpdatesFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.record(z.string(), z.string().min(1).max(64)),
});
/**
 * The computers the captain let run this Mac's source (docs/devices.md,
 * "Matching the home's build"): asked once per computer, the first time it
 * would build it; from then on each is matched by itself.
 */
const SOURCE_ALLOWED_FILE = "source-builds.json";
const sourceAllowedFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.array(z.string().min(1).max(64)),
});
const WHEN_BACK_FILE = "removing.json";
const whenBackFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.array(z.string().min(1).max(64)),
});
/**
 * A computer removed while out of reach has not heard it was removed
 * (docs/devices.md, "Remove"): its key's pin is kept, so the home listens for
 * it and refuses it, which it reads as removed, and then removes what
 * Firstmate set up there. Kept until it has been refused `FAREWELL_TELLS`
 * times - a device needs two refusals in a row - or for `FAREWELL_MS`.
 */
const FAREWELL_FILE = "removed.json";
const farewellFileSchema = z.strictObject({
  version: z.literal(1),
  removed: z.array(
    z.strictObject({
      keyPin: z.string().regex(KEY_TEXT_PATTERN),
      at: z.number().int().nonnegative(),
      told: z.number().int().nonnegative(),
    }),
  ),
});
/**
 * How this Mac reaches each computer it set up over Remote Login
 * (docs/devices.md, "Kept with the device"): the address it was added at,
 * which the home updates Firstmate at and removes what it set up there
 * through, and its connection - `ssh` when that computer reaches this Mac
 * only through this Mac's own SSH connection to the address, `network` when
 * it dials this Mac's network address itself.
 */
const SSH_FILE = "ssh.json";
const PACKAGE_UPDATE_ADDRESSES = "package-update-addresses.json";
const packageUpdateAddressesSchema = z.record(z.string(), remoteLoginAddressSchema);
const sshConnectionSchema = z.enum(["ssh", "network"]);
const sshRecordSchema = z.strictObject({
  address: remoteLoginAddressSchema,
  connection: sshConnectionSchema,
});
type SshRecord = z.infer<typeof sshRecordSchema>;
/**
 * A computer this Mac removed while what Firstmate set up there could not be
 * removed over SSH yet (docs/devices.md, "Removing it there"): bound to the
 * removed computer's id, never an active connection, and tried again until
 * thirty days after `at`. `name` is how the list named it, for the words.
 */
const sshCleanupSchema = z.strictObject({
  address: remoteLoginAddressSchema,
  name: z.string().min(1).max(160),
  at: z.number().int().nonnegative(),
});
export type SshCleanup = z.infer<typeof sshCleanupSchema> & { deviceId: string };
const sshFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.record(z.string(), sshRecordSchema),
  cleanups: z.record(z.string(), sshCleanupSchema).optional(),
});
/**
 * Where each device last reached this Mac: the address and port it dialed,
 * as its connection's socket says (docs/devices.md, "Finding the home
 * again"), so Devices can say when this Mac's address changed since.
 */
const REACHED_FILE = "reached.json";
const reachedFileSchema = z.strictObject({
  version: z.literal(1),
  reached: z.record(z.string(), z.string().min(1).max(64)),
});
/**
 * What each device said it is in its hello (docs/devices.md, "What a device
 * is"): its system and chip, kept beside the list in a file of their own, so
 * a list an older app reads is still the list it knows.
 */
const SYSTEMS_FILE = "systems.json";
const systemRecordSchema = z.strictObject({
  automaticStartup: automaticStartupSchema.optional(),
  system: deviceSystemSchema.optional(),
  chip: deviceChipSchema.optional(),
});
type SystemRecord = z.infer<typeof systemRecordSchema>;
const systemsFileSchema = z.strictObject({
  version: z.literal(1),
  devices: z.record(z.string(), systemRecordSchema),
});
const FAREWELL_TELLS = 3;
const FAREWELL_MS = 30 * 24 * 60 * 60 * 1000;
/** How often pairing looks at this Mac's own addresses while it follows the network. */
const NETWORK_LOOK_MS = 5_000;
/** How long a spent or expired link is still remembered, to say which it was. */
const REMEMBER_LINK_MS = 24 * 60 * 60 * 1000;

// What the list keeps of a device: never what the home reads of it live.
const entrySchema = deviceViewSchema
  .pick({ id: true, kind: true, name: true, pairedAt: true, user: true, onThisMac: true })
  .extend({ keyPin: z.string().regex(KEY_TEXT_PATTERN) });
type Entry = z.infer<typeof entrySchema>;
const listSchema = z.strictObject({
  version: z.literal(LIST_VERSION),
  devices: z.array(entrySchema),
});

type Link = {
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

/** How long a look at the firewall holds before the next read looks again. */
const FIREWALL_LOOK_MS = 10_000;

/** How long Devices' read of where devices find this computer waits for a look at the firewall. */
const FIREWALL_ANSWER_WAIT_MS = 2_000;

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const REASONS: Record<PairRefusal, string> = {
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
function sameUser(user: DeviceUser, ownUid: number | undefined, ownSid: string | null | undefined) {
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
function reachedOn(socket: { localAddress?: string; localPort?: number }): string | undefined {
  const host = socket.localAddress?.replace(/^::ffff:/, "");
  if (!host || !socket.localPort) return undefined;
  return `${host.includes(":") ? `[${host}]` : host}:${socket.localPort}`;
}

function defaultSchedule(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

export class DevicePairing implements PairedDevices {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly schedule: (ms: number, run: () => void) => () => void;
  private readonly onProblem: (text: string) => void;
  private readonly onJoined: (
    device: DeviceView,
    found: FoundTools | undefined,
    again: boolean,
  ) => void;
  private readonly onLeft: (device: DeviceView) => void;
  private readonly interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** The port a link names, which the connection listens on. */
  readonly port: number;
  private readonly ownUid: number | undefined;
  private readonly ownSid: () => string | null | undefined;
  private readonly joinsFromAnotherMac: boolean;
  private readonly leaveWithWork: (device: DeviceView) => boolean;
  private readonly lookAtFirewall: (() => Promise<HomeFirewall | null>) | null;
  /** What the last look at this home's firewall found, and when it looked. */
  private firewallSeen: { firewall: HomeFirewall | null; at: number } | null = null;
  private readonly addsByAddress: boolean;
  private firewallLooking: Promise<void> | null = null;
  private entries: Entry[] = [];
  /** When each device was last in reach. */
  private seenAt = new Map<string, number>();
  private failedUpdates = new Map<string, string>();
  /** The computers allowed to run this Mac's source (`SOURCE_ALLOWED_FILE`). */
  private sourceAllowedIds = new Set<string>();
  /** That could not be read this run: then no device reads as never in reach. */
  private seenUnreadable = false;
  /** The computers to remove once they are back. */
  private whenBack = new Set<string>();
  /** Removed while out of reach, by key pin: when, and how often refused since. */
  private farewells = new Map<string, { at: number; told: number }>();
  /** How this Mac reaches each computer it set up over Remote Login. */
  private sshRecords = new Map<string, SshRecord>();
  private sshCleanupRecords = new Map<string, z.infer<typeof sshCleanupSchema>>();
  /** Those records cannot be read: they are never written over, so nothing in them is lost. */
  private sshUnreadable = false;
  /** The yeses on a check line, by the address the captain typed. */
  private readonly updatePeers = new Map<string, string>();
  private packageUpdateAddresses: Record<string, string> | null = {};
  private hostTrust = new Map<string, HostKey>();
  /** That list cannot be read: it is never written over, and no new yes is kept. */
  private hostTrustUnreadable = false;
  /** The addresses where Firstmate's own SSH key is let in. */
  private ownKeyPlaced = new Set<string>();
  /** That list cannot be read: it is never written over. */
  private ownKeyPlacedUnreadable = false;
  /** Firstmate's own SSH key while it is being made, so two adds make one. */
  private makingOwnKey: Promise<OwnKey> | null = null;
  /** Where each device last reached this Mac. */
  private reachedAt = new Map<string, string>();
  /**
   * Whether each device listed before the list kept where it joined from
   * dials from this Mac itself, as its newest connection found it.
   */
  private dialsHere = new Map<string, boolean>();
  /** Network classification is a pure property of the literal address, not a per-row probe. */
  private reachedNetworks = new WeakMap<
    Entry,
    { address: string | undefined; network: ReturnType<typeof reachedNetwork> }
  >();
  /** This computer's name on the local network, such as `kuns-macbook-pro.local`. */
  private networkName: string | null = null;
  /** Where each computer that keeps a copy would answer should it take over; none until copies are kept. */
  private copyTargets: () => string[][] = () => [];
  /** Where each computer that keeps a copy listens for the other copies; none until copies are kept. */
  private copyListens: () => { deviceId: string; listens: string[] }[] = () => [];
  /** What each device said it is in its hello. */
  private systems = new Map<string, SystemRecord>();
  /** That could not be read this run: it is never written over, so nothing in it is lost. */
  private systemsUnreadable = false;
  private readonly phonePushRecords: PairingPushRecords;
  /** null when the saved list cannot be read: then nobody is admitted and nothing is written. */
  private unreadable: string | null = null;
  private readonly links = new Map<string, Link>();
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Set<() => void>();
  /** Stops following this Mac's network, while pairing follows it. */
  private following: (() => void) | null = null;
  private home: KeyIdentity | null = null;

  constructor(options: DevicePairingOptions) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.onProblem = options.onProblem ?? ((text) => console.warn(`[devices] ${text}`));
    this.onJoined = options.onJoined ?? (() => {});
    this.onLeft = options.onLeft ?? (() => {});
    this.interfaces = options.interfaces ?? networkInterfaces;
    this.port = options.port ?? CONNECTION_PORT;
    this.ownUid = options.ownUid ?? process.getuid?.();
    this.ownSid = options.ownSid ?? (() => null);
    this.addsByAddress = options.addsByAddress ?? true;
    this.joinsFromAnotherMac = options.joinsFromAnotherMac ?? false;
    this.leaveWithWork = options.leaveWithWork ?? (() => false);
    this.lookAtFirewall = options.firewall ?? null;
    this.phonePushRecords = new PairingPushRecords(
      this.dir,
      () => this.now(),
      (file, value) => this.writeFile(file, value),
      (text) => this.onProblem(text),
    );
    this.load();
    this.loadSeen();
    this.loadHostTrust();
    this.loadPackageUpdateAddresses();
    this.loadOwnKeyPlaced();
  }

  private projection:
    | { devices?: DeviceView[]; places: Map<string, ReturnType<typeof devicePlace>> }
    | undefined;

  /** Each device's place is derived once from this refresh's device snapshot. */
  placeOf(deviceId: string): ReturnType<typeof devicePlace> {
    const known = this.projection?.places.get(deviceId);
    if (known) return known;
    const place = devicePlace(this.list(), deviceId);
    this.projection?.places.set(deviceId, place);
    return place;
  }

  private invalidateProjection(): void {
    if (!this.projection) return;
    delete this.projection.devices;
    this.projection.places.clear();
  }

  /** Placement and move facts share the same device list during a synchronous read. */
  readProjection<T>(read: () => T): T {
    if (this.projection) return read();
    this.projection = { places: new Map() };
    try {
      return read();
    } finally {
      this.projection = undefined;
    }
  }

  /**
   * Whether the list may hold a device: one is paired, or the list cannot be
   * read, so it is never read as empty. Reads no device's view.
   */
  mayHoldDevices(): boolean {
    if (this.unreadable) return true;
    const own = this.ownReturning()?.deviceId;
    return this.entries.some((entry) => entry.id !== own);
  }

  /** The devices on the list, oldest first, never with their secrets. */
  list(): DeviceView[] {
    if (this.projection?.devices) return this.projection.devices;
    // This home's own way back is not a device of its own.
    const own = this.ownReturning()?.deviceId;
    const devices = this.entries
      .filter((entry) => entry.id !== own)
      .map((entry) => this.viewOf(entry));
    if (this.projection) this.projection.devices = devices;
    return devices;
  }

  /**
   * Makes a one-use link for one device of `kind`, good for ten minutes, or
   * for `lastsMs` when the caller says, as a command that downloads does.
   * The answer is for this Mac's own window and nothing else. A link the
   * home hands a Mac it reached over Remote Login keeps that address, which
   * the device that uses it is listed with, and where that Mac is, as the
   * look over SSH found it (`locality`), which pairing then reads in place
   * of where its socket dialed from.
   *
   * The link names the private address in use, or loopback with none, and
   * as many more as a link carries, first to last (`PAIRING_LINK_ALSO_MAX`);
   * a device that joined hears every one in its welcome. The
   * command for another user on this Mac names loopback always: that user
   * dials from this Mac itself, where loopback answers whatever network this
   * Mac is on, so a new address never strands its work. A link for a
   * computer that reaches this Mac only through this Mac's own SSH
   * connection (`via: "ssh"`) names loopback too, where that connection
   * delivers it, and says so, so the device never dials an address.
   */
  invite(
    request: DeviceInviteRequest,
    options: { remoteLogin?: string; via?: "ssh"; locality?: Locality; lastsMs?: number } = {},
  ): DeviceInvite {
    this.refuseWhileUnreadable();
    if (options.via && (!deviceRunsWork(request.kind) || !options.remoteLogin || request.command))
      throw new Error(
        `Only a computer that runs work, added by its address, reaches ${HERE.this} over SSH.`,
      );
    const { pin } = this.identity();
    const code = randomBytes(32).toString("base64url");
    const id = randomUUID();
    const lasts = options.lastsMs ?? PAIRING_LINK_TTL_MS;
    const expiresAt = this.now() + lasts;
    this.forgetOldLinks();
    this.links.set(hash(code), {
      id,
      kind: request.kind,
      expiresAt,
      spent: false,
      ...(options.remoteLogin ? { remoteLogin: options.remoteLogin } : {}),
      ...(options.via ? { via: options.via } : {}),
      ...(options.locality ? { locality: options.locality } : {}),
    });
    const cancel = this.schedule(lasts, () => {
      this.timers.delete(cancel);
      this.changed();
    });
    this.timers.add(cancel);
    this.changed();
    void this.checkFirewall();
    const targets =
      request.command === "another-user" || options.via
        ? [`${LOOPBACK_ADDRESS}:${this.port}`]
        : request.at
          ? [request.at]
          : this.offerTargets(request.phone);
    const [at, ...also] = targets.slice(0, 1 + PAIRING_LINK_ALSO_MAX);
    return {
      id,
      link: buildPairingLink({
        kind: request.kind,
        at: at ?? `${LOOPBACK_ADDRESS}:${this.port}`,
        key: pin,
        code,
        ...(options.via ? { via: options.via } : {}),
        ...(also.length > 0 ? { also } : {}),
      }),
      kind: request.kind,
      expiresAt,
    };
  }

  /**
   * Stop it: closes an open link before it expires, so a device that uses it
   * is refused as unknown. A link already used, expired or forgotten stays
   * as it is.
   */
  stop(linkId: string): void {
    for (const [key, link] of this.links) {
      if (link.id !== linkId) continue;
      if (link.spent || link.expiresAt <= this.now()) return;
      this.links.delete(key);
      this.changed();
      return;
    }
  }

  /** The device that used a link, by the link's handle; undefined while nobody has. */
  claimedBy(linkId: string): string | undefined {
    for (const link of this.links.values()) if (link.id === linkId) return link.deviceId;
    return undefined;
  }

  /**
   * Where devices find this Mac (docs/devices.md): its own private addresses
   * right now, bridges left out, and its name on the local network when it
   * has one. A saved choice is read no more.
   */
  addresses(): DeviceAddresses {
    const addresses = offeredAddresses(this.interfaces());
    const firewall = this.firewallSeen?.firewall;
    const local = addresses.some((entry) => entry.network === "local");
    return {
      addresses,
      // The saved choice is read no more. The field stays so an older client still reads the answer.
      chosen: null,
      current: addresses[0]?.address ?? null,
      ...(local && this.networkName ? { name: this.networkName } : {}),
      ...(firewall
        ? firewall.name === "windows"
          ? { windowsFirewall: firewall }
          : { firewall }
        : {}),
      ...(this.addsByAddress ? {} : { addsByAddress: false as const }),
    };
  }

  /**
   * Where devices find this computer, after a fresh look at a Linux home's
   * own firewall: Settings -> Devices reads it so, and the look has at most
   * two seconds before the answer goes without it, which a push then
   * carries. Answering after the look keeps an answer from landing after
   * the push it would undo.
   */
  async addressesAfterLook(): Promise<DeviceAddresses> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.checkFirewall(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FIREWALL_ANSWER_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    return this.addresses();
  }

  /**
   * Looks at this Linux home's own firewall again (docs/devices.md, "A Linux
   * home's firewall"), at most once every ten seconds, and tells pairing's
   * listeners when what it found changed, so Devices follows. Settings ->
   * Devices asks it each time it reads where devices find this computer, and
   * a new link asks it too. Nothing on a Mac.
   */
  checkFirewall(): Promise<void> {
    const look = this.lookAtFirewall;
    if (!look) return Promise.resolve();
    if (this.firewallLooking) return this.firewallLooking;
    if (this.firewallSeen && this.now() - this.firewallSeen.at < FIREWALL_LOOK_MS)
      return Promise.resolve();
    this.firewallLooking = look()
      .catch(() => null)
      .then((firewall) => {
        const before = JSON.stringify(this.firewallSeen?.firewall ?? null);
        this.firewallSeen = { firewall, at: this.now() };
        if (JSON.stringify(firewall) !== before) this.changed();
      })
      .finally(() => {
        this.firewallLooking = null;
      });
    return this.firewallLooking;
  }

  /** The first private address in use, for a reader that still asks for one. */
  address(): string | undefined {
    return offeredAddresses(this.interfaces())[0]?.address;
  }

  /** Every address the connection listens on beside loopback. */
  listenHosts(): string[] {
    return offeredAddresses(this.interfaces()).map((entry) => entry.address);
  }

  /**
   * The addresses a new link carries, local name first when this computer is
   * on a local network, then each local address, then the private network.
   * A phone asks for private addresses first, retaining the same local fallbacks.
   * Bridges are left out. With none, loopback, which reaches only this computer.
   */
  offerTargets(phone = false): string[] {
    const offered = offeredAddresses(this.interfaces());
    const local = offered.filter((entry) => entry.network === "local");
    const priv = offered.filter((entry) => entry.network === "private");
    const hosts: string[] = [];
    if (phone) for (const entry of priv) hosts.push(entry.address);
    if (local.length > 0 && this.networkName) hosts.push(this.networkName);
    for (const entry of local) hosts.push(entry.address);
    if (!phone) for (const entry of priv) hosts.push(entry.address);
    if (hosts.length === 0) hosts.push(LOOPBACK_ADDRESS);
    return hosts.map((host) => `${host}:${this.port}`);
  }

  /**
   * Every address a welcome offers: this computer's own, then where each
   * computer that keeps a copy would answer should it take over
   * (docs/devices.md, "Taking over"), so a device dials there when this
   * home is out of reach and finds the home that took over by its key.
   */
  welcomeTargets(phone = false): string[] {
    const own = this.offerTargets(phone);
    const copies = this.copyTargets().filter((each) => each.length > 0);
    // A grant keeps the address that answered and as many more as a link
    // carries (`grantRoutes`), in the welcome's order: each copy's first
    // address goes ahead of the home's later ones, so none falls past it.
    const room = Math.max(1, PAIRING_LINK_ALSO_MAX - copies.length);
    return [
      ...new Set([
        ...own.slice(0, room),
        ...copies.map((each) => each[0] as string),
        ...own.slice(room),
        ...copies.flatMap((each) => each.slice(1)),
      ]),
    ];
  }

  /**
   * Who says where each copy would answer, and where each listens for the
   * other copies; the home's copies set it while they run.
   */
  offerCopies(
    targets: (() => string[][]) | null,
    listens: (() => { deviceId: string; listens: string[] }[]) | null = null,
  ): void {
    this.copyTargets = targets ?? (() => []);
    this.copyListens = listens ?? (() => []);
  }

  /**
   * Each computer that keeps a copy, as a phone is told it in its welcome
   * (`standby-phone`, docs/devices.md "Taking over from a phone"): its id,
   * name, its key's pin and where it listens, so a phone that cannot reach
   * this home reaches the copy itself, pinned to that key.
   */
  phoneStandbys(): PhoneStandby[] {
    return this.copyListens().flatMap(({ deviceId, listens }) => {
      const entry = this.entries.find((each) => each.id === deviceId);
      // One that never said where it listens is nowhere a phone could reach.
      if (!entry || listens.length === 0) return [];
      return [
        {
          deviceId,
          name: deviceLabel(this.viewOf(entry)).slice(0, 64) || deviceId.slice(0, 64),
          pin: entry.keyPin,
          listens: listens.slice(0, PAIRING_LINK_ALSO_MAX + 1),
        },
      ];
    });
  }

  /** This computer's name on the local network, told when it is read. */
  noteNetworkName(name: string | null): void {
    const next = name && name.length > 0 ? name : null;
    if (next === this.networkName) return;
    this.networkName = next;
    this.changed();
  }

  /**
   * The request that used to choose one address. It still answers, and still
   * refuses an address that is not this computer's own, and it changes
   * nothing: a link carries every address, so there is nothing to choose.
   * The saved choice is read no more.
   */
  setAddress(address: string | null): DeviceAddresses {
    if (
      address !== null &&
      !privateAddresses(this.interfaces()).some((entry) => entry.address === address)
    )
      throw new Error(`${address} is not one of ${HERE.this}'s own addresses right now.`);
    return this.addresses();
  }

  /**
   * Follows this Mac's network (docs/devices.md, "Where devices find this
   * Mac"). Nothing tells the app when an address comes or goes, so pairing
   * looks at this Mac's own private addresses every few seconds and tells
   * its listeners once a change has held for two looks in a row: the
   * connection then listens where this Mac is now, and Devices says so. A
   * moment off the network while this Mac changes Wi-Fi is no change.
   * Answers its own stop; `dispose` stops it too.
   */
  followNetwork(): () => void {
    this.following?.();
    const read = () => JSON.stringify(offeredAddresses(this.interfaces()));
    let told = read();
    let last = told;
    let stopped = false;
    let cancel = () => {};
    const look = () => {
      cancel = () => {};
      const now = read();
      if (now === last && now !== told) {
        told = now;
        this.changed();
      }
      last = now;
      if (!stopped) cancel = this.schedule(NETWORK_LOOK_MS, look);
    };
    cancel = this.schedule(NETWORK_LOOK_MS, look);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      cancel();
      if (this.following === stop) this.following = null;
    };
    this.following = stop;
    return stop;
  }

  /**
   * Takes a device off the list. Listeners hear of it before this returns,
   * so the connection has cut the device by then (docs/devices.md, "Remove").
   * With `cleanUpThere`, a computer this Mac reaches over its own SSH
   * connection leaves a cleanup-only record (`sshCleanups`), so what
   * Firstmate set up there is removed over SSH once it can be.
   */
  remove(
    deviceId: string,
    options: { farewell?: boolean; cleanUpThere?: boolean } = {},
  ): DeviceView {
    this.refuseWhileUnreadable();
    const gone = this.entries.find((entry) => entry.id === deviceId);
    if (!gone) throw new Error("No device with that id is on the list.");
    this.save(this.entries.filter((entry) => entry !== gone));
    // Out of reach, it hears it was removed the next time it dials.
    if (options.farewell) {
      this.farewells.set(gone.keyPin, { at: this.now(), told: 0 });
      this.saveFarewells();
    }
    const view = this.viewOf(gone);
    this.updatePeers.delete(deviceId);
    if (this.seenAt.delete(deviceId)) this.saveSeen();
    if (this.failedUpdates.delete(deviceId)) this.saveFailedUpdates();
    if (this.sourceAllowedIds.delete(deviceId)) this.saveSourceAllowed();
    if (this.packageUpdateAddresses && Object.hasOwn(this.packageUpdateAddresses, deviceId)) {
      const { [deviceId]: _removed, ...remaining } = this.packageUpdateAddresses;
      try {
        this.writeFile(PACKAGE_UPDATE_ADDRESSES, remaining);
        this.packageUpdateAddresses = remaining;
      } catch {
        this.onProblem("The Ubuntu update address could not be removed.");
      }
    }
    if (this.whenBack.delete(deviceId)) this.saveWhenBack();
    const ssh = this.sshRecords.get(deviceId);
    if (ssh) {
      this.sshRecords.delete(deviceId);
      if (options.cleanUpThere && ssh.connection === "ssh")
        this.sshCleanupRecords.set(deviceId, {
          address: ssh.address,
          name: deviceLabel(view),
          at: this.now(),
        });
      this.saveSshRecords();
    }
    if (this.reachedAt.delete(deviceId)) this.saveReached();
    if (this.systems.delete(deviceId) && !this.systemsUnreadable) this.saveSystems();
    this.phonePushRecords.remove(deviceId);
    this.changed();
    return view;
  }

  /** Only a phone on the paired list can keep a push registration. */
  setPush(deviceId: string, registration: PhonePushRegistration | null): PhonePushAnswer {
    this.refuseWhileUnreadable();
    this.phonePushRecords.refuseWhileUnreadable();
    if (!this.entries.some((entry) => entry.id === deviceId))
      throw new Error("No device with that id is on the list.");
    if (!isPhone({ system: this.systems.get(deviceId)?.system }))
      throw new Error("Only a paired phone has its cards pushed.");
    return this.phonePushRecords.set(deviceId, registration);
  }

  pushTargets(): PhonePushTarget[] {
    return this.unreadable ? [] : this.phonePushRecords.targets(this.entries);
  }

  forgetPush(deviceId: string, grant: string): void {
    this.phonePushRecords.forget(deviceId, grant);
  }

  /** Each paired phone whose box of letters is read (docs/phone-push.md, "Letters"). */
  letterBoxes(): PhoneLetterBox[] {
    return this.unreadable ? [] : this.phonePushRecords.letterBoxes(this.entries);
  }

  noteLetterRead(deviceId: string, at: number): void {
    this.phonePushRecords.noteLetterRead(deviceId, at);
  }

  takeLetter(deviceId: string, key: string, letter: PhonePushLetter): LetterTaken {
    return this.phonePushRecords.takeLetter(deviceId, key, letter);
  }

  /**
   * Whether `signature` (base64url) over `text` was made with the key of the
   * device `deviceId` on the list, whose certificate `cert` is: the pin of
   * the certificate's key must be the one the list holds for it.
   */
  provenBy(deviceId: string, cert: string, text: string, signature: string): boolean {
    const entry = this.entries.find((candidate) => candidate.id === deviceId);
    if (!entry) return false;
    try {
      const publicKey = new X509Certificate(cert).publicKey;
      if (keyPin(publicKey) !== entry.keyPin) return false;
      return verify(
        "sha256",
        Buffer.from(text),
        { key: publicKey, dsaEncoding: "der" },
        Buffer.from(signature, "base64url"),
      );
    } catch {
      return false;
    }
  }

  /**
   * A device was in reach at `at`, or went out of reach then: kept, so
   * Devices says when it was last seen after this Mac restarts.
   */
  seen(deviceId: string, at: number): void {
    if (this.unreadable || !this.entries.some((entry) => entry.id === deviceId)) return;
    if (this.seenAt.get(deviceId) === at) return;
    this.seenAt.set(deviceId, at);
    this.saveSeen();
  }

  /**
   * What a device on the list said it is in its hello: kept when it says
   * something new, and Devices hears of it.
   */
  noteSystem(
    deviceId: string,
    said: {
      system?: DeviceSystem;
      chip?: DeviceChip;
      automaticStartup?: import("@shared/devices").AutomaticStartup;
    },
  ): void {
    if (this.keepSystem(deviceId, said)) this.changed();
  }

  /** The version of Firstmate that did not start on a computer that runs work, if one did not. */
  failedUpdate(deviceId: string): string | undefined {
    return this.failedUpdates.get(deviceId);
  }

  /**
   * Keeps the version that did not start on a computer that runs work, or
   * forgets it with null; true when that changed what is kept.
   */
  noteFailedUpdate(deviceId: string, version: string | null): boolean {
    if (this.unreadable) return false;
    if (version !== null && !this.entries.some((entry) => entry.id === deviceId)) return false;
    if ((this.failedUpdates.get(deviceId) ?? null) === version) return false;
    if (version === null) this.failedUpdates.delete(deviceId);
    else this.failedUpdates.set(deviceId, version);
    try {
      this.saveFailedUpdates();
    } catch (error) {
      this.onProblem(`could not keep which version did not start: ${(error as Error).message}`);
    }
    return true;
  }

  /** Whether the captain let this computer run this Mac's source. */
  sourceAllowed(deviceId: string): boolean {
    return this.sourceAllowedIds.has(deviceId);
  }

  /** Keeps the captain's yes to this computer running this Mac's source; true when it was new. */
  noteSourceAllowed(deviceId: string): boolean {
    if (this.unreadable || this.sourceAllowedIds.has(deviceId)) return false;
    if (!this.entries.some((entry) => entry.id === deviceId)) return false;
    this.sourceAllowedIds.add(deviceId);
    try {
      this.saveSourceAllowed();
    } catch (error) {
      this.onProblem(`could not keep which computers run source: ${(error as Error).message}`);
    }
    return true;
  }

  /** Keeps what a device said it is; true when that changed what is kept. */
  private keepSystem(
    deviceId: string,
    said: {
      system?: DeviceSystem;
      chip?: DeviceChip;
      automaticStartup?: import("@shared/devices").AutomaticStartup;
    },
  ): boolean {
    if (this.unreadable || this.systemsUnreadable) return false;
    if (!this.entries.some((entry) => entry.id === deviceId)) return false;
    const kept = this.systems.get(deviceId);
    const next: SystemRecord = { ...kept, ...said };
    if (
      kept?.system === next.system &&
      kept?.chip === next.chip &&
      kept?.automaticStartup === next.automaticStartup
    )
      return false;
    this.systems.set(deviceId, next);
    try {
      this.saveSystems();
    } catch (error) {
      this.onProblem(`could not keep what a device is: ${(error as Error).message}`);
    }
    return true;
  }

  /** When the device was last in reach, if this Mac ever saw it. */
  lastSeen(deviceId: string): number | undefined {
    return this.seenAt.get(deviceId);
  }

  /**
   * Whether this Mac's address changed since the device last reached it
   * (docs/devices.md, "Finding the home again"): where it dialed then is not
   * among `listening`, where the connection listens now. Loopback is
   * listened on whatever this Mac's address, so only its port can move;
   * another address only counts while the connection listens on one of this
   * Mac's own, since on no network nothing from another Mac reaches it
   * anywhere. Nothing is said while the connection listens nowhere, nor of
   * a computer that reaches this Mac through this Mac's own SSH connection:
   * that connection follows this Mac wherever it listens.
   */
  addressChanged(deviceId: string, listening: readonly string[]): boolean {
    if (this.sshRecords.get(deviceId)?.connection === "ssh") return false;
    const reached = this.reachedAt.get(deviceId);
    const where = reached ? splitDialAddress(reached) : null;
    if (!reached || !where || listening.length === 0 || listening.includes(reached)) return false;
    if (where.host === LOOPBACK_ADDRESS) return true;
    return listening.some((at) => splitDialAddress(at)?.host !== LOOPBACK_ADDRESS);
  }

  /**
   * Whether a computer on the list runs on this Mac itself: as it joined,
   * or, for one listed before the list kept that, from where its newest
   * connection dials, by the same look a join takes - never one that
   * reaches this Mac only through this Mac's own SSH connection, whose dial
   * arrives on loopback. False for one not connected since this started.
   */
  onThisMac(deviceId: string): boolean {
    const entry = this.entries.find((candidate) => candidate.id === deviceId);
    if (!entry) return false;
    return entry.onThisMac ?? this.dialsHere.get(deviceId) ?? false;
  }

  /**
   * Whether a socket dials from this Mac itself, as this Mac finds it from
   * the address it came from, never while it stands in for another Mac.
   */
  private dialsFromThisMac(address: string | undefined): boolean {
    return !this.joinsFromAnotherMac && isThisMachine(address, this.interfaces());
  }

  /**
   * Whether macOS on another Mac holds its work's dial to this Mac
   * (docs/devices.md, "Held on the local network"): a computer that runs
   * work, joined from another Mac, never in reach since it joined, that
   * dials this Mac itself at an address on the local network, where macOS
   * holds a background program's dial until someone at that Mac allows it.
   * Never one this Mac reaches over its own SSH connection, which no such
   * dial touches, nor while when devices were last seen cannot be read.
   */
  heldOnLocalNetwork(deviceId: string): boolean {
    const entry = this.entries.find((candidate) => candidate.id === deviceId);
    if (!entry || !deviceRunsWork(entry.kind) || entry.onThisMac !== false) return false;
    if (this.sshRecords.get(deviceId)?.connection === "ssh") return false;
    if (this.seenUnreadable || this.seenAt.has(deviceId)) return false;
    const reached = this.reachedAt.get(deviceId);
    const where = reached ? splitDialAddress(reached) : null;
    return where !== null && onLocalNetwork(where.host);
  }

  /**
   * Remove when it is back (docs/devices.md, "Remove"): a computer that runs
   * work, out of reach now, is removed the next time it is in reach, once
   * its work is here. `false` is Keep it, which takes the wait back.
   */
  removeWhenBack(deviceId: string, wait: boolean): void {
    this.refuseWhileUnreadable();
    if (!this.entries.some((entry) => entry.id === deviceId))
      throw new Error("No device with that id is on the list.");
    if (this.whenBack.has(deviceId) === wait) return;
    if (wait) this.whenBack.add(deviceId);
    else this.whenBack.delete(deviceId);
    this.saveWhenBack();
    this.changed();
  }

  /** Whether the captain chose to remove the device once it is back. */
  removingWhenBack(deviceId: string): boolean {
    return this.whenBack.has(deviceId);
  }

  /**
   * The computers that reach this Mac only through this Mac's own SSH
   * connection, with the address it reaches each at: what keeps that
   * connection open reads them (docs/devices.md, "Through the home's SSH").
   * None when what was kept cannot be read: they are out of reach, never
   * off the list.
   */
  sshConnections(): { deviceId: string; address: string }[] {
    return [...this.sshRecords]
      .filter(([deviceId, record]) => record.connection === "ssh" && this.holds(deviceId))
      .map(([deviceId, record]) => ({ deviceId, address: record.address }));
  }

  /**
   * The computers this Mac removed whose Firstmate it has yet to remove over
   * SSH, bound to the removed computer's id and the address it was reached
   * at (docs/devices.md, "Removing it there"). None when what was kept cannot
   * be read.
   */
  sshCleanups(): SshCleanup[] {
    return [...this.sshCleanupRecords].map(([deviceId, cleanup]) => ({ deviceId, ...cleanup }));
  }

  /** What Firstmate set up on a removed computer is gone there, or this Mac stopped trying. */
  cleanedUp(deviceId: string): void {
    if (!this.sshCleanupRecords.delete(deviceId)) return;
    this.saveSshRecords();
  }

  /**
   * Change address (docs/devices.md, "Changing its address"): this Mac
   * reaches a computer it reaches over its own SSH connection at `address`
   * from now on, once the look there found that same computer. Nothing
   * else about it changes.
   */
  setSshAddress(deviceId: string, address: string): DeviceView {
    this.refuseWhileUnreadable();
    const record = this.sshRecords.get(deviceId);
    const entry = this.entries.find((each) => each.id === deviceId);
    if (!record || !entry)
      throw new Error(`${HERE.This} reaches no computer with that id over SSH.`);
    if (this.sshUnreadable)
      throw new Error(
        `How ${HERE.this} reaches the ${COMPUTER.many} it added by their address cannot be read.`,
      );
    if (record.address !== address) {
      this.sshRecords.set(deviceId, { ...record, address });
      this.saveSshRecords();
      this.changed();
    }
    return this.viewOf(entry);
  }

  /**
   * The key the captain said was that Mac, for the address they typed, or
   * null when Firstmate has no yes for it. Null too when the list cannot be
   * read: a missing yes asks again, and a yes that cannot be read is never
   * replaced.
   */
  rememberedHost(address: string): HostKey | null {
    return this.hostTrust.get(address) ?? null;
  }

  /** Whether the yeses cannot be read, so a new one must not be written. */
  hostTrustCannotBeRead(): boolean {
    return this.hostTrustUnreadable;
  }

  /**
   * Remembers the captain's yes for `address`. Writes Firstmate's own list
   * and the known-hosts file SSH reads for it, never the captain's SSH
   * settings. Refuses when the list cannot be read, so nothing in it is lost.
   */
  rememberHost(address: string, key: HostKey): void {
    if (this.hostTrustUnreadable)
      throw new Error(`The ${COMPUTER.many} ${HERE.this} has checked cannot be read.`);
    this.hostTrust.set(address, key);
    this.saveHostTrust();
  }

  /**
   * What ssh adds so it checks the remembered key and writes nothing of the
   * captain's. Null when nothing is remembered for `address`.
   */
  hostTrustOptions(address: string): string[] | null {
    const key = this.hostTrust.get(address);
    if (!key) return null;
    return hostTrustSshOptions(join(this.dir, HOST_TRUST_KNOWN_HOSTS), address, key);
  }

  /**
   * What every ssh to `address` adds: the remembered check, then, once
   * Firstmate's own key is let in there, that key first. Null when neither.
   */
  sshOptions(address: string): string[] | null {
    const trusted = this.hostTrustOptions(address) ?? [];
    const own = this.ownKeyPlaced.has(address) ? readOwnKey(this.dir) : null;
    const options = [...trusted, ...(own ? ownKeySshOptions(own) : [])];
    return options.length > 0 ? options : null;
  }

  /**
   * Firstmate's own SSH key (docs/devices.md, "The password, once"), made
   * in its own folder the first time it is needed.
   */
  ownSshKey(): Promise<OwnKey> {
    this.makingOwnKey ??= makeOwnKey(this.dir).finally(() => {
      this.makingOwnKey = null;
    });
    return this.makingOwnKey;
  }

  /** Remembers that Firstmate's own key is let in at `address`, so later SSH offers it. */
  ownKeyPlacedAt(address: string): void {
    if (this.ownKeyPlaced.has(address)) return;
    this.ownKeyPlaced.add(address);
    // A list that cannot be read is never written over; this reach still uses it.
    if (this.ownKeyPlacedUnreadable) return;
    this.writeFile(OWN_KEY_PLACED_FILE, { version: 1, addresses: [...this.ownKeyPlaced] });
  }

  /**
   * Leave (docs/devices.md): a connected device's person took it off the
   * list from that device. The same removal as Remove, said in the feed by
   * the device's own name. A device no longer on the list changes nothing.
   */
  leave(deviceId: string): void {
    const entry = this.entries.find((candidate) => candidate.id === deviceId);
    if (!entry) return;
    if (deviceRunsWork(entry.kind) && this.leaveWithWork(this.viewOf(entry))) {
      try {
        this.onLeft(this.viewOf(entry));
      } catch (error) {
        this.onProblem(`could not say a device left: ${(error as Error).message}`);
      }
      return;
    }
    const gone = this.remove(deviceId);
    try {
      this.onLeft(gone);
    } catch (error) {
      this.onProblem(`could not say a device left: ${(error as Error).message}`);
    }
  }

  /**
   * A device uses its link (`POST /pair`), on a TLS socket where it showed
   * its own key; that key is what it proves itself with from then on.
   * Synchronous from parse to save, so two devices racing for one link
   * cannot both have it, and only a link used well is spent.
   *
   * A device already on the list may use a link to find this Mac where the
   * link says it is now (`again`, docs/devices.md "Finding the home again"):
   * it shows the key it was paired with, the link is spent, and its entry
   * stays as it was, so what names it - a project's Runs on, a task placed
   * there - still does. A key the list no longer holds is `removed`.
   */
  claim(body: unknown, on: IncomingMessage): PairOutcome {
    const refuse = (refused: PairRefusal): PairOutcome => ({
      ok: false,
      refused,
      reason: REASONS[refused],
    });
    const request = pairRequestSchema.safeParse(body);
    if (!request.success) return refuse("malformed");
    const link = this.links.get(hash(request.data.code));
    if (!link) return refuse("unknown");
    if (link.spent) return refuse("used");
    if (link.expiresAt <= this.now()) return refuse("expired");
    if (link.kind !== request.data.kind) return refuse("kind");
    // Firstmate open at its first launch takes no link made for another user here.
    if (request.data.window && link.kind === "work") return refuse("kind");
    // A phone controls and runs nothing, so a link made for another user here is not for it.
    const { system } = request.data;
    if (isPhone({ system }) && link.kind === "work") return refuse("kind");
    if (this.unreadable) return refuse("unknown");
    const { user } = request.data;
    // A device that may run work says which macOS user it runs as.
    if (deviceRunsWork(link.kind) && !isPhone({ system }) && !user) return refuse("malformed");
    // Where it joins from, as this Mac found it - over SSH before the link
    // existed, or where its socket dialed from - never what the device says.
    const onThisMac = this.joinsFromAnotherMac
      ? false
      : link.locality
        ? link.locality === "this-mac"
        : this.dialsFromThisMac(on.socket.remoteAddress);
    const kind = joinedKind(link.kind, onThisMac, request.data.window === true, system);
    // Work run as the home's own user on this Mac could read and change
    // everything the captain can: it must run as another user here.
    // On Windows the user says its identifier, and the home compares its own.
    if (deviceRunsWork(kind) && onThisMac && user && sameUser(user, this.ownUid, this.ownSid()))
      return refuse("same-user");
    const devicePin = peerPin(on.socket);
    if (!devicePin) return refuse("unproven");
    const listed = this.entries.find((entry) => entry.keyPin === devicePin);
    const reached = reachedOn(on.socket);
    if (request.data.again)
      return this.foundAgain(link, listed, devicePin, request.data.found, reached, system);
    // One entry per key, so Remove always cuts the key off.
    if (listed) return refuse("paired");
    const entry: Entry = {
      id: randomUUID(),
      kind,
      name: request.data.name,
      pairedAt: this.now(),
      ...(deviceRunsWork(kind) && user ? { user: user.name } : {}),
      onThisMac,
      keyPin: devicePin,
    };
    link.spent = true;
    try {
      this.save([...this.entries, entry]);
    } catch (error) {
      link.spent = false;
      throw error;
    }
    link.deviceId = entry.id;
    this.noteReached(entry.id, reached);
    this.keepSshRecord(entry.id, link);
    // What it said it runs is kept now, so a phone is known to be one before its first hello.
    if (system) this.keepSystem(entry.id, { system });
    this.changed();
    const view = this.viewOf(entry);
    try {
      this.onJoined(view, deviceRunsWork(kind) ? request.data.found : undefined, false);
    } catch (error) {
      this.onProblem(`could not say a device joined: ${(error as Error).message}`);
    }
    return { ok: true, grant: { deviceId: entry.id, kind: entry.kind } };
  }

  /**
   * A device on the list found this Mac with a link: the link is spent and
   * the entry stays. One the list no longer holds was removed while out of
   * reach; this answer is how it hears it, so the home stops listening for it.
   */
  private foundAgain(
    link: Link,
    listed: Entry | undefined,
    devicePin: string,
    found: FoundTools | undefined,
    reached: string | undefined,
    system: DeviceSystem | undefined,
  ): PairOutcome {
    if (!listed) {
      if (this.farewells.delete(devicePin)) {
        this.saveFarewells();
        this.changed();
      }
      return { ok: false, refused: "removed", reason: REASONS.removed };
    }
    // A computer keeps its kind when it finds this Mac again: one that runs
    // work may use any link that adds one, and gains nothing by it.
    // A phone, a view, finds it again with the link for a Mac it joined by.
    const phone = isPhone({ system }) && listed.kind === "view" && link.kind !== "work";
    if (
      listed.kind !== link.kind &&
      !phone &&
      !(deviceRunsWork(listed.kind) && deviceRunsWork(link.kind))
    )
      return { ok: false, refused: "kind", reason: REASONS.kind };
    link.spent = true;
    link.deviceId = listed.id;
    // It reached this Mac where it is now, and dials here from now on.
    this.noteReached(listed.id, reached);
    // Found by Add it at an address over Remote Login: that address now
    // reaches it, to update it there and remove what it set up there.
    this.keepSshRecord(listed.id, link);
    this.changed();
    try {
      this.onJoined(this.viewOf(listed), deviceRunsWork(listed.kind) ? found : undefined, true);
    } catch (error) {
      this.onProblem(
        `could not say a device found ${HERE.this} again: ${(error as Error).message}`,
      );
    }
    return { ok: true, grant: { deviceId: listed.id, kind: listed.kind } };
  }

  /**
   * Whether a command may get Firstmate with this code (docs/devices.md,
   * "Getting Infinitary from this Mac"): null for an open link made for a
   * computer that runs work, else why not. It only reads the link: the
   * code is spent by `/pair` alone. With no code, a computer that runs work
   * already on the list gets it to update itself (docs/devices.md,
   * "Updating over the connection"): null when the key its TLS socket showed
   * is that computer's.
   */
  opened(body: unknown, on?: IncomingMessage): FetchAppRefusal | null {
    const request = fetchAppRequestSchema.safeParse(body);
    if (!request.success) return "malformed";
    if (request.data.code === undefined) {
      const devicePin = on ? peerPin(on.socket) : null;
      const entry = devicePin
        ? this.entries.find((candidate) => candidate.keyPin === devicePin)
        : undefined;
      if (!entry || this.unreadable) return "unknown";
      return deviceRunsWork(entry.kind) ? null : "kind";
    }
    const link = this.links.get(hash(request.data.code));
    if (!link || this.unreadable) return "unknown";
    if (link.spent) return "used";
    if (link.expiresAt <= this.now()) return "expired";
    if (!deviceRunsWork(link.kind)) return "kind";
    return null;
  }

  // The connection's pairing seam (docs/connection.md).

  any(): boolean {
    if (this.unreadable) return false;
    if (this.entries.length > 0) return true;
    if (this.awaitingFarewell()) return true;
    const now = this.now();
    for (const link of this.links.values()) if (!link.spent && link.expiresAt > now) return true;
    return false;
  }

  /** A phone may use a direct computer link; no code or identity leaves this owner. */
  phoneMayJoin(): boolean {
    return [...this.links.values()].some(
      (link) => link.kind !== "work" && !link.via && !link.spent && link.expiresAt > this.now(),
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The device whose key the request's TLS socket showed, or null. */
  admit(request: IncomingMessage): PairedDevice | null {
    if (this.unreadable) return null;
    const devicePin = peerPin(request.socket);
    if (!devicePin) return null;
    const entry = this.entries.find((candidate) => candidate.keyPin === devicePin);
    if (entry) {
      this.noteReached(entry.id, reachedOn(request.socket));
      if (request.headers.upgrade?.toLowerCase() === "websocket") {
        const peer = request.socket.remoteAddress?.replace(/^::ffff:/, "");
        if (
          peer &&
          !this.sshRecords.has(entry.id) &&
          reachedNetwork(peer) &&
          !this.dialsFromThisMac(peer)
        )
          this.updatePeers.set(entry.id, peer);
        else this.updatePeers.delete(entry.id);
      }
      if (entry.onThisMac === undefined)
        this.dialsHere.set(
          entry.id,
          this.sshRecords.get(entry.id)?.connection !== "ssh" &&
            this.dialsFromThisMac(request.socket.remoteAddress),
        );
      return {
        id: entry.id,
        kind: entry.kind,
        ...(entry.onThisMac !== undefined ? { onThisMac: entry.onThisMac } : {}),
      };
    }
    const farewell = this.farewells.get(devicePin);
    if (farewell) {
      // Refused, it hears it was removed; told enough, it is forgotten.
      farewell.told += 1;
      if (farewell.told >= FAREWELL_TELLS) this.farewells.delete(devicePin);
      this.saveFarewells();
      if (!this.farewells.has(devicePin)) this.changed();
    }
    return null;
  }

  /** Whether a computer removed while out of reach has yet to hear it, within its time. */
  private awaitingFarewell(): boolean {
    const now = this.now();
    for (const [pin, farewell] of this.farewells)
      if (farewell.at + FAREWELL_MS <= now) this.farewells.delete(pin);
    return this.farewells.size > 0;
  }

  /** Whether the saved list could be read: an unreadable one holds no device, yet loses none. */
  readable(): boolean {
    return !this.unreadable;
  }

  holds(deviceId: string): boolean {
    return !this.unreadable && this.entries.some((entry) => entry.id === deviceId);
  }

  identity(): KeyIdentity {
    this.home ??= loadOrCreateHomeIdentity(this.dir);
    return this.home;
  }

  /**
   * The takeover that made this home from a copy, read from its record
   * (`devices/take-over.json`, docs/devices.md "Taking over"), said in every
   * welcome; null for a home a move or a first start made.
   */
  takeOver(): string | null {
    try {
      const read = takeOverIdSchema.safeParse(
        JSON.parse(readFileSync(join(this.dir, TAKE_OVER_FILE), "utf8")),
      );
      return read.success ? read.data.id : null;
    } catch {
      return null;
    }
  }

  /** Which home of its record this is (`./homeNumber.ts`), said in every welcome. */
  homeNumber(): number {
    return readHomeNumber(this.dir);
  }

  /**
   * Takes a higher home number for this home, said in every welcome from now
   * on: a first mate started here again after a move whose destination never
   * answered (docs/devices.md, "A destination that never answers").
   */
  raiseHomeNumber(homeNumber: number): void {
    if (homeNumber <= readHomeNumber(this.dir)) return;
    writeHomeNumber(this.dir, homeNumber);
  }

  /**
   * This home's way back should a computer that keeps a copy take over
   * (docs/devices.md, "An old home that returns"), made once while copies
   * are kept: a Mac on the list, named in the record, with a key that stays
   * here. Answers it, or null while the list cannot be read.
   */
  returningIdentity(name: string): ReturningIdentity | null {
    if (this.unreadable) return null;
    const kept = this.ownReturning();
    if (kept && this.entries.some((entry) => entry.id === kept.deviceId)) return kept;
    const made = this.addMovedHome(name);
    writePrivate(
      join(this.dir, RETURNING_KEY_FILE),
      `${JSON.stringify({ version: 1, ...made })}\n`,
    );
    writePrivate(
      join(this.dir, RETURNING_FILE),
      `${JSON.stringify({ version: 1, deviceId: made.deviceId })}\n`,
    );
    return made;
  }

  /** The way back this home made, whose key it keeps; null on a home that made none. */
  ownReturning(): ReturningIdentity | null {
    try {
      const read = returningKeySchema.parse(
        JSON.parse(readFileSync(join(this.dir, RETURNING_KEY_FILE), "utf8")),
      );
      return { deviceId: read.deviceId, key: read.key, cert: read.cert };
    } catch {
      return null;
    }
  }

  /** No copy is kept any more: the way back goes from the list and the record. */
  dropReturning(): void {
    const kept = this.ownReturning();
    if (!kept) return;
    this.removeMovedHome(kept.deviceId);
    rmSync(join(this.dir, RETURNING_KEY_FILE), { force: true });
    rmSync(join(this.dir, RETURNING_FILE), { force: true });
  }

  /**
   * The window this computer becomes when the first mate moves away from it
   * (docs/devices.md, "Moving the first mate"): a Mac on the list, with a
   * key made here, written before the record crosses so the new home holds
   * it. Answers its id and key; the grant dials the new home.
   */
  addMovedHome(name: string): { deviceId: string; key: string; cert: string } {
    if (this.unreadable) throw new Error(this.unreadable);
    const own = createKeyIdentity("Firstmate device");
    const entry: Entry = {
      id: randomUUID(),
      // The old home stays a computer that controls the first mate and runs its work.
      kind: "mac",
      name: name.trim().slice(0, 64) || COMPUTER.one,
      pairedAt: this.now(),
      onThisMac: false,
      keyPin: own.pin,
    };
    this.save([...this.entries, entry]);
    this.changed();
    return { deviceId: entry.id, key: own.key, cert: own.cert };
  }

  /** Takes back the window `addMovedHome` added, for a move that did not finish. */
  removeMovedHome(deviceId: string): void {
    if (!this.entries.some((entry) => entry.id === deviceId)) return;
    this.save(this.entries.filter((entry) => entry.id !== deviceId));
    this.changed();
  }

  /** Stops the link timers and following the network; the list and the key stay on disk. */
  dispose(): void {
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.following?.();
  }

  private load(): void {
    const path = join(this.dir, LIST_FILE);
    if (!existsSync(path)) return;
    try {
      chmodSync(this.dir, 0o700);
      chmodSync(path, 0o600);
      this.entries = listSchema.parse(JSON.parse(readFileSync(path, "utf8"))).devices;
    } catch {
      this.unreadable =
        "The list of paired devices cannot be read, or a newer version wrote it. No device can join until it is moved away.";
      this.onProblem(this.unreadable);
      return;
    }
    this.dropCarriedReturning();
  }

  /**
   * A way back that crossed a move (docs/devices.md, "An old home that
   * returns"): the record names it, but its key stayed on the old home, and
   * no takeover made this home, whose record would keep it so the old home
   * can return. The old home joins as a Mac of its own, so it leaves the
   * list and the record.
   */
  private dropCarriedReturning(): void {
    if (
      existsSync(join(this.dir, RETURNING_KEY_FILE)) ||
      existsSync(join(this.dir, TAKE_OVER_FILE))
    )
      return;
    let deviceId: string;
    try {
      deviceId = returningIdSchema.parse(
        JSON.parse(readFileSync(join(this.dir, RETURNING_FILE), "utf8")),
      ).deviceId;
    } catch {
      return;
    }
    if (this.entries.some((entry) => entry.id === deviceId))
      this.save(this.entries.filter((entry) => entry.id !== deviceId));
    rmSync(join(this.dir, RETURNING_FILE), { force: true });
  }

  /** When devices were last seen, and which wait to be removed; what cannot be read is nothing. */
  private loadSeen(): void {
    try {
      const path = join(this.dir, FAILED_UPDATES_FILE);
      if (existsSync(path))
        this.failedUpdates = new Map(
          Object.entries(
            failedUpdatesFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).devices,
          ),
        );
    } catch {
      this.onProblem("Which versions did not start on each computer cannot be read.");
    }
    try {
      const path = join(this.dir, SOURCE_ALLOWED_FILE);
      if (existsSync(path))
        this.sourceAllowedIds = new Set(
          sourceAllowedFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).devices,
        );
    } catch {
      // Unread, every computer is asked again before it runs source.
      this.onProblem("Which computers may run this computer's source cannot be read.");
    }
    try {
      const path = join(this.dir, SEEN_FILE);
      if (existsSync(path))
        this.seenAt = new Map(
          Object.entries(seenFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).seen),
        );
    } catch {
      this.seenUnreadable = true;
      this.onProblem("When devices were last seen cannot be read; Devices starts without it.");
    }
    try {
      const path = join(this.dir, FAREWELL_FILE);
      if (existsSync(path))
        this.farewells = new Map(
          farewellFileSchema
            .parse(JSON.parse(readFileSync(path, "utf8")))
            .removed.map(({ keyPin, at, told }) => [keyPin, { at, told }]),
        );
    } catch {
      this.onProblem("Which removed computers have yet to hear it cannot be read.");
    }
    try {
      const path = join(this.dir, SSH_FILE);
      if (existsSync(path)) {
        const read = sshFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
        this.sshRecords = new Map(Object.entries(read.devices));
        this.sshCleanupRecords = new Map(Object.entries(read.cleanups ?? {}));
      }
    } catch {
      this.sshUnreadable = true;
      this.onProblem(
        `How ${HERE.this} reaches the ${COMPUTER.many} it added by their address cannot be read.`,
      );
    }
    try {
      const path = join(this.dir, REACHED_FILE);
      if (existsSync(path))
        this.reachedAt = new Map(
          Object.entries(reachedFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).reached),
        );
    } catch {
      this.onProblem(
        `Where devices last reached ${HERE.this} cannot be read; Devices starts without it.`,
      );
    }
    try {
      const path = join(this.dir, WHEN_BACK_FILE);
      if (existsSync(path))
        this.whenBack = new Set(
          whenBackFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).devices,
        );
    } catch {
      this.onProblem("Which devices to remove once they are back cannot be read.");
    }
    try {
      const path = join(this.dir, SYSTEMS_FILE);
      if (existsSync(path))
        this.systems = new Map(
          Object.entries(systemsFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).devices),
        );
    } catch {
      this.systemsUnreadable = true;
      this.onProblem("What each device is cannot be read; Devices names each one a computer.");
    }
    this.phonePushRecords.load();
  }

  private loadHostTrust(): void {
    const path = join(this.dir, HOST_TRUST_FILE);
    if (!existsSync(path)) return;
    try {
      const read = hostTrustFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      this.hostTrust = new Map(Object.entries(read.hosts));
    } catch {
      this.hostTrustUnreadable = true;
      this.onProblem(`The ${COMPUTER.many} ${HERE.this} has checked cannot be read.`);
    }
  }

  private loadPackageUpdateAddresses(): void {
    const path = join(this.dir, PACKAGE_UPDATE_ADDRESSES);
    if (!existsSync(path)) return;
    try {
      this.packageUpdateAddresses = packageUpdateAddressesSchema.parse(
        JSON.parse(readFileSync(path, "utf8")),
      );
    } catch {
      this.packageUpdateAddresses = null;
      this.onProblem("The saved Ubuntu update addresses cannot be read.");
    }
  }

  /** One candidate from the authenticated socket, never a trusted SSH identity. */
  packageUpdatePeer(deviceId: string): string | undefined {
    return this.updatePeers.get(deviceId);
  }

  /** Keeps an address only after Remote Login verified this worker's grant. */
  rememberPackageUpdateAddress(deviceId: string, address: string): void {
    const before = this.packageUpdateAddresses;
    if (!before || !this.holds(deviceId) || before[deviceId] === address) return;
    const next = { ...before, [deviceId]: address };
    try {
      this.writeFile(PACKAGE_UPDATE_ADDRESSES, next);
      this.packageUpdateAddresses = next;
      this.changed();
    } catch {
      this.onProblem("The Ubuntu update address could not be saved.");
    }
  }

  private loadOwnKeyPlaced(): void {
    const path = join(this.dir, OWN_KEY_PLACED_FILE);
    if (!existsSync(path)) return;
    try {
      const read = ownKeyPlacedSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      this.ownKeyPlaced = new Set(read.addresses);
    } catch {
      this.ownKeyPlacedUnreadable = true;
      this.onProblem("Where Infinitary's own SSH key is let in cannot be read.");
    }
  }

  private saveHostTrust(): void {
    const hosts = Object.fromEntries(this.hostTrust);
    this.writeFile(HOST_TRUST_FILE, { version: 1, hosts });
    const lines = [...this.hostTrust].map(([address, key]) => knownHostsLine(address, key));
    writePrivate(join(this.dir, HOST_TRUST_KNOWN_HOSTS), `${lines.join("\n")}\n`);
  }

  /**
   * A link the home used over Remote Login: the address that reached the
   * device is kept with it, and how it reaches this Mac from now on.
   */
  private keepSshRecord(deviceId: string, link: Link): void {
    if (!link.remoteLogin) return;
    const record: SshRecord = {
      address: link.remoteLogin,
      connection: link.via === "ssh" ? "ssh" : "network",
    };
    const kept = this.sshRecords.get(deviceId);
    if (kept?.address === record.address && kept.connection === record.connection) return;
    this.sshRecords.set(deviceId, record);
    try {
      this.saveSshRecords();
    } catch (error) {
      this.onProblem(`could not keep where a device was added: ${(error as Error).message}`);
    }
  }

  private saveSshRecords(): void {
    if (this.sshUnreadable) {
      this.onProblem(
        `How ${HERE.this} reaches the ${COMPUTER.many} it added by their address is kept as it was.`,
      );
      return;
    }
    this.writeFile(SSH_FILE, {
      version: 1,
      devices: Object.fromEntries(this.sshRecords),
      ...(this.sshCleanupRecords.size > 0
        ? { cleanups: Object.fromEntries(this.sshCleanupRecords) }
        : {}),
    });
  }

  /** A device as every reader sees it: never its key's pin, with where it was added over Remote Login. */
  private viewOf(entry: Entry): DeviceView {
    const { keyPin: _pin, ...view } = entry;
    const remoteLogin = this.sshRecords.get(entry.id)?.address;
    const packageUpdateAt = this.packageUpdateAddresses?.[entry.id];
    const said = this.systems.get(entry.id);
    const reached = this.reachedAt.get(entry.id);
    let classified = this.reachedNetworks.get(entry);
    if (!classified || classified.address !== reached) {
      const where = reached ? splitDialAddress(reached) : null;
      classified = { address: reached, network: where ? reachedNetwork(where.host) : null };
      this.reachedNetworks.set(entry, classified);
    }
    const reachedOn = classified.network;
    return {
      ...view,
      ...(remoteLogin ? { remoteLogin } : {}),
      ...(packageUpdateAt && this.rememberedHost(packageUpdateAt) ? { packageUpdateAt } : {}),
      ...(said?.system ? { system: said.system } : {}),
      ...(said?.chip ? { chip: said.chip } : {}),
      ...(said?.automaticStartup ? { automaticStartup: said.automaticStartup } : {}),
      ...(reachedOn ? { reachedOn } : {}),
    };
  }

  private saveFarewells(): void {
    this.writeFile(FAREWELL_FILE, {
      version: 1,
      removed: [...this.farewells].map(([keyPin, farewell]) => ({ keyPin, ...farewell })),
    });
  }

  private saveSeen(): void {
    this.writeFile(SEEN_FILE, { version: 1, seen: Object.fromEntries(this.seenAt) });
  }

  /** A device on the list reached this Mac at `where`; kept when it is somewhere new. */
  private noteReached(deviceId: string, where: string | undefined): void {
    if (!where || this.reachedAt.get(deviceId) === where) return;
    this.reachedAt.set(deviceId, where);
    this.invalidateProjection();
    try {
      this.saveReached();
    } catch (error) {
      this.onProblem(
        `could not keep where a device reached ${HERE.this}: ${(error as Error).message}`,
      );
    }
  }

  private saveSourceAllowed(): void {
    this.writeFile(SOURCE_ALLOWED_FILE, { version: 1, devices: [...this.sourceAllowedIds] });
  }

  private saveFailedUpdates(): void {
    this.writeFile(FAILED_UPDATES_FILE, {
      version: 1,
      devices: Object.fromEntries(this.failedUpdates),
    });
  }

  private saveSystems(): void {
    this.writeFile(SYSTEMS_FILE, { version: 1, devices: Object.fromEntries(this.systems) });
  }

  private saveReached(): void {
    this.writeFile(REACHED_FILE, { version: 1, reached: Object.fromEntries(this.reachedAt) });
  }

  private saveWhenBack(): void {
    this.writeFile(WHEN_BACK_FILE, { version: 1, devices: [...this.whenBack] });
  }

  private writeFile(file: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    writePrivate(join(this.dir, file), `${JSON.stringify(value, null, 2)}\n`);
  }

  private save(entries: Entry[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    writePrivate(
      join(this.dir, LIST_FILE),
      `${JSON.stringify({ version: LIST_VERSION, devices: entries }, null, 2)}\n`,
    );
    this.entries = entries;
  }

  private refuseWhileUnreadable(): void {
    if (this.unreadable) throw new Error(this.unreadable);
  }

  private forgetOldLinks(): void {
    const now = this.now();
    for (const [key, link] of this.links)
      if (link.expiresAt + REMEMBER_LINK_MS <= now) this.links.delete(key);
  }

  private changed(): void {
    this.invalidateProjection();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.onProblem(`a listener failed: ${(error as Error).message}`);
      }
    }
  }
}
