import { formatDate, formatTime } from "@shared/i18n/format";
import type { DeviceMake } from "../../../shared/cards";
import { aDevice, COMPUTER, chipWords, HERE } from "../../../shared/deviceNames";
import {
  automaticStartupOf,
  automaticStartupWords,
  awayWord,
  type DeviceView,
  deviceConnecting,
  deviceLabel,
  deviceRunsWork,
  LINK_SAY,
  namesInWords,
  userDisplayName,
} from "../../../shared/devices";
import { catalogEntry } from "../../../shared/providers";
import { type RemoteLoginCopy, remoteLoginWords } from "../../../shared/remoteLogin";
import { type DeviceSignIns, signInPlace } from "../../../shared/signIns";
import { runsForAnotherFirstmate, sshConnectionWords } from "../../../shared/sshConnection";

/**
 * The words of Settings -> Devices (`DevicesTab.tsx`; design skill
 * `components/devices/DevicesTab`): what each panel, row and way says, and
 * the lines a device's row reads from what the home knows of it.
 */

/** How other devices find this computer. */
export const WAYS_WORDS = {
  label: `How other devices find ${HERE.this}`,
  local: "On this network",
  localLine: "Computers on the same Wi-Fi or cable network.",
  localOff: "Not on a Wi-Fi or cable network right now.",
  private: "On your private network",
  privateOffTitle: "On a private network",
  privateLine: "Computers on the same private network, wherever they are.",
  privateOff:
    "Not on one. Put both computers on the same private network to connect from somewhere else.",
  internet: "Over the internet",
  internetLine: `Never. Infinitary does not open ${HERE.this} to the internet. A private network covers that.`,
  foot: "A link or command carries every way at once. The other computer uses whichever one answers, so there is nothing to choose here.",
  copyLink: "Copy a link",
  copyCommand: "Copy a command",
  ready: "ready",
  off: "off",
  reachedLocal: "reached on this network",
  reachedPrivate: "reached on your private network",
  noNetwork: `${HERE.This} is on no network right now, so a link works only on ${HERE.this}.`,
} as const;

export function wayCount(count: number): string {
  return count === 1 ? "1 computer" : `${count} computers`;
}

/** The phone panel uses the same Mac link; its presentation stays local to Settings. */
export type DevicePanelMake = DeviceMake | "phone";

/** What each panel says, by what it holds. */
export const PANEL_WORDS: Record<
  DevicePanelMake,
  { label: string; say: [string, ...string[]]; copy: string; thing: "link" | "command" }
> = {
  link: {
    label: "New link",
    say: [...LINK_SAY.computer],
    copy: "Copy link",
    thing: "link",
  },
  phone: {
    label: "New link · a phone",
    say: [...LINK_SAY.phone],
    copy: "Copy link",
    thing: "link",
  },
  command: {
    label: `New command · another ${COMPUTER.one}`,
    say: [
      `Run this once in Terminal on the other ${COMPUTER.one}, as the user who should run its work.`,
      `It gets Infinitary from ${HERE.this}, so both need the same network.`,
    ],
    copy: "Copy command",
    thing: "command",
  },
  "user-command": {
    label: "New command · running as another user",
    say: [
      "Log in as the user who should run the work, and run this once in Terminal.",
      "Switch back when it says it joined.",
    ],
    copy: "Copy command",
    thing: "command",
  },
};

/** Whether a device answers now, or since when it has not: the end of its mono line. */
export const SEEN_WORDS = {
  now: "seen just now",
  /** The two words a computer not in reach reads as have one home, `awayWord`. */
  outOfReach: awayWord(false),
  /** The state on a row's right, and the mono line, of a computer whose connection is being made. */
  connecting: awayWord(true),
  /** Followed by when it was last in reach: "out of reach since 14:02". */
  since: `${awayWord(false)} since`,
  removedWhenBack: `${awayWord(false)} · removed when it is back`,
  removedWhenBackConnecting: `${awayWord(true)} · removed when it is back`,
  removedOnceUpdated: "takes no new work · removed once it is updated",
  restarted: `not logged in since ${HERE.this} restarted`,
};

/** What a Mac's summary leads with while Firstmate is open on it, controlling this one. */
export const CONTROLLING_NOW = "Controlling your first mate now";

/** A computer's summary while no project runs on it. */
export const RUNS_NO_PROJECT = "Runs no project yet";

/** The mono state on the right of a computer that takes no new work. */
export const NO_NEW_WORK = "no new work";

/** The words of Remove's question (design skill `components/devices/DevicesTab`, "Remove"). */
export function removeLines(device: DeviceView): [string, ...string[]] {
  const label = deviceLabel(device);
  if (!deviceRunsWork(device.kind))
    return [`Remove ${label}? It is cut off at once.`, "To come back, it needs a new link."];
  const runs = device.runs ?? [];
  const work = `Its unmerged work${runs.length > 0 ? ` on ${namesInWords(runs)}` : ""}`;
  // Its Firstmate runs work for another one now, so its work never comes here.
  if (runsForAnotherFirstmate(device.ssh))
    return [
      `Remove ${label}? It runs work for another first mate now.`,
      `${work} stays there. Nothing changes there for the other first mate.`,
    ];
  // Connected on another version that takes no new work, its work cannot
  // come here until it is updated.
  if (!device.inReach && device.otherVersion)
    return [
      `Remove ${label}? It takes no new work.`,
      `${work} is still there. Update it, and its work comes to ${HERE.this} before ${label} is removed.`,
    ];
  if (!device.inReach)
    return [
      `Remove ${label}? It is ${awayWord(deviceConnecting(device))}.`,
      `${work} is still there. Wait, and it comes to ${HERE.this} before ${label} is removed.`,
    ];
  const tasks = device.tasks ?? 0;
  const stops =
    tasks === 0
      ? ""
      : `${tasks === 1 ? "Its task" : `Its ${tasks} tasks`}${runs.length > 0 ? ` on ${namesInWords(runs)}` : ""} ${tasks === 1 ? "stops" : "stop"}. `;
  return [
    `Remove ${label}? Its unmerged work comes to ${HERE.this} first.`,
    `${stops}Infinitary then removes what it set up there, with its sign-ins.`,
    ...(runs.length > 0
      ? [`${namesInWords(runs)} ${runs.length === 1 ? "runs" : "run"} on ${HERE.this} after.`]
      : []),
  ];
}

/** "9:41": the minutes and seconds a link has left. */
export function linkTimeLeft(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "today 14:06", "yesterday 09:12" or "Oct 1 18:40": when a device joined. */
export function joinedWhen(at: number, now: number): string {
  const date = new Date(at);
  const time = formatTime(date, { hour: "2-digit", minute: "2-digit" });
  const day = new Date(now);
  if (date.toDateString() === day.toDateString()) return `today ${time}`;
  day.setDate(day.getDate() - 1);
  if (date.toDateString() === day.toDateString()) return `yesterday ${time}`;
  return `${formatDate(date, { month: "short", day: "numeric" })} ${time}`;
}

/** "14:02" today, otherwise "Oct 1 14:02": since when a device is out of reach. */
function sinceWhen(at: number, now: number): string {
  const date = new Date(at);
  const time = formatTime(date, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${formatDate(date, { month: "short", day: "numeric" })} ${time}`;
}

/** Whether a device answers now, or since when it has not. */
function seenWords(device: DeviceView, now: number): string {
  if (device.removal === "when-back")
    return device.otherVersion
      ? SEEN_WORDS.removedOnceUpdated
      : deviceConnecting(device)
        ? SEEN_WORDS.removedWhenBackConnecting
        : SEEN_WORDS.removedWhenBack;
  // On another version it is connected, whether or not it takes work.
  if (device.inReach || device.otherVersion) return SEEN_WORDS.now;
  if (device.restartedSince) return SEEN_WORDS.restarted;
  return device.seenAt === undefined
    ? SEEN_WORDS.outOfReach
    : `${SEEN_WORDS.since} ${sinceWhen(device.seenAt, now)}`;
}

/**
 * What a device is, with a computer's chip as it said at pairing (INF-1456):
 * "a computer · Intel", so a person can see why Automatic leaves it out of a
 * project held to this computer's chip.
 */
function whatDevice(device: DeviceView): string {
  return device.chip && device.system !== "ios"
    ? `${aDevice(device)} · ${chipWords(device.chip, device.system)}`
    : aDevice(device);
}

/** The mono line under a device's name: what it is, when it joined, and when it was last seen. */
export function deviceDetail(device: DeviceView, now: number): string {
  const startup = automaticStartupOf(device);
  if (startup === "unavailable" || startup === "unknown")
    return `${whatDevice(device)} · ${device.remoteLogin ?? (device.user ? `running as ${device.user}` : seenWords(device, now))} · ${automaticStartupWords[startup]}`;
  // Reached over this Mac's own SSH, it is named by its address and that connection.
  if (device.remoteLogin && device.ssh) {
    const what =
      device.onThisMac && device.user ? `another user on ${HERE.this}` : whatDevice(device);
    const where =
      device.removal === "when-back" || device.ssh.state === "stopped"
        ? seenWords(device, now)
        : sshConnectionWords.detail(device.ssh, device);
    return `${what} · ${device.remoteLogin} · ${where}`;
  }
  if (device.onThisMac && device.user) {
    const who = userDisplayName(device.user);
    return `another user on ${HERE.this} · runs work only, while ${who} is logged in · ${seenWords(device, now)}`;
  }
  // A Mac added by its address is named by it (components/devices/DevicesTab).
  if (device.remoteLogin)
    return `${whatDevice(device)} · ${device.remoteLogin} · ${seenWords(device, now)}`;
  const reached =
    device.reachedOn === "local"
      ? WAYS_WORDS.reachedLocal
      : device.reachedOn === "private"
        ? WAYS_WORDS.reachedPrivate
        : null;
  return `${whatDevice(device)} · joined ${joinedWhen(device.pairedAt, now)}${reached ? ` · ${reached}` : ""} · ${seenWords(device, now)}`;
}

/** The names of what a computer is signed in to: its subscriptions, then where projects live. */
function signedInNames(signIns: DeviceSignIns | undefined): string[] | null {
  if (!signIns?.signIns) return null;
  const names = signIns.signIns.accounts.map(
    (account) => catalogEntry(account.providerId)?.name ?? account.providerId,
  );
  for (const forge of signIns.signIns.forges?.signIns ?? []) names.push(forge.name);
  return [...new Set(names)];
}

/**
 * What a computer that runs work runs and is signed in to, or where its
 * removal stands: "Runs website and api · Signed in to Codex and GitHub".
 * A Mac that controls this Firstmate leads with "Controlling your Firstmate
 * now" while Firstmate is open on it; one that only controls says nothing
 * else (design skill `components/devices/DevicesTab`).
 */
export function deviceSummary(device: DeviceView, signIns: DeviceSignIns | undefined): string {
  const controlling = device.controlling ? [CONTROLLING_NOW] : [];
  if (!deviceRunsWork(device.kind)) return controlling.join("");
  const runs = device.runs ?? [];
  if (device.removal === "bringing-work")
    return runs.length > 0
      ? `Bringing ${namesInWords(runs)}'s unmerged work to ${HERE.this}…`
      : `Bringing its unmerged work to ${HERE.this}…`;
  if (device.removal === "cleaning-up")
    return `Removing what Infinitary set up ${signInPlace({ ...device, onThisMac: device.onThisMac ?? false }).where}…`;
  const parts = [...controlling, runs.length > 0 ? `Runs ${namesInWords(runs)}` : RUNS_NO_PROJECT];
  const names = signedInNames(signIns);
  if (names)
    parts.push(names.length > 0 ? `Signed in to ${namesInWords(names)}` : "No sign-ins yet");
  return parts.join(" · ");
}

/**
 * The mono state on a computer's right: its tasks, idle, no new work,
 * connecting, or out of reach. A computer whose connection is still being
 * made, such as one just updated, is connecting; out of reach is for one
 * whose connection stopped, failed or dropped.
 */
export function deviceState(device: DeviceView): { text: string; tone: "busy" | "idle" | "warn" } {
  if (device.otherVersion?.takesWork === false) return { text: NO_NEW_WORK, tone: "warn" };
  if (!device.inReach) {
    const connecting = deviceConnecting(device);
    return { text: awayWord(connecting), tone: connecting ? "idle" : "warn" };
  }
  const tasks = device.tasks ?? 0;
  if (tasks > 0) return { text: tasks === 1 ? "1 task" : `${tasks} tasks`, tone: "busy" };
  return { text: "idle", tone: "idle" };
}

/**
 * The line under an out-of-reach computer's summary once this Mac's address
 * changed since it was last in reach, saying how it comes back; null
 * otherwise (design skill `components/devices/DevicesTab`, "Bringing a
 * computer back").
 */
export function strandedLine(device: DeviceView): string | null {
  // Connected on another version, it is not out of reach.
  if (
    !deviceRunsWork(device.kind) ||
    device.inReach ||
    device.otherVersion ||
    !device.addressChanged
  )
    return null;
  const said = `It still looks for ${HERE.this} at its old address.`;
  // Reached over this Mac's own SSH, it follows this Mac wherever it listens.
  if (device.remoteLogin) return null;
  if (device.onThisMac && device.user)
    return `${said} A new command run as ${userDisplayName(device.user)} brings it back.`;
  return `${said} A new command run there brings it back.`;
}

/**
 * The way back for an out-of-reach computer added by a command, once this
 * Mac's address changed: a new command. One added by its address comes back
 * by itself over this Mac's own SSH, or by Try again.
 */
export function wayBack(device: DeviceView): { label: string; does: DeviceMake } | null {
  if (!deviceRunsWork(device.kind) || device.inReach || device.otherVersion) return null;
  if (device.remoteLogin || !device.addressChanged) return null;
  return { label: "Make a command", does: device.onThisMac ? "user-command" : "command" };
}

/**
 * Why a computer a command added on another Mac has not reached this Mac
 * since it joined, under its summary, while macOS there holds its dial on
 * the local network; null otherwise (design skill
 * `components/devices/DevicesTab`, "Held on the local network"). Its way
 * back is Add it by its address.
 */
export function heldLine(device: DeviceView): string | null {
  if (!deviceRunsWork(device.kind) || device.inReach || device.otherVersion) return null;
  if (!device.heldOnLocalNetwork) return null;
  return [
    `It has not reached ${HERE.this} since it joined.`,
    `macOS lets Infinitary on ${deviceLabel(device)} use your local network only once someone there allows it.`,
    `Added by its address, ${HERE.this} reaches it with your SSH key instead.`,
  ].join(" ");
}

/**
 * Why this Mac stopped trying its SSH connection to a computer, and what to
 * do, under its summary in `--warn`; null while it connects or tries again
 * by itself.
 */
export function sshStoppedLine(device: DeviceView): string | null {
  if (device.ssh?.state !== "stopped" || !device.ssh.reason || !device.remoteLogin) return null;
  return sshConnectionWords
    .stopped(device.ssh.reason, { address: device.remoteLogin, device })
    .join(" ");
}

/**
 * A Mac this Mac is adding by its address: reaching it - or, on the call
 * that carries the password typed once, letting Firstmate's own key in -
 * then setting it up once it said its name, or, for a computer already on
 * the list (`deviceId`), telling it where this Mac is now; `copy` is how far
 * the copy of Firstmate has gone there since.
 */
export type AddingMac = {
  address: string;
  stage: "reaching" | "letting-in" | "setting-up" | "finding";
  name?: string;
  deviceId?: string;
  copy?: RemoteLoginCopy;
};

/**
 * Where a Mac being added by its address stands, as its row says it: how far
 * the copy has gone once it is sent - the bytes sent so far, never a share of
 * a total - and before that the stage. `name` is how the row names it.
 */
export function addingWords(mac: AddingMac, name: string): string {
  if (mac.copy?.download)
    return remoteLoginWords.downloading(name, mac.copy.download.received, mac.copy.download.total);
  if (mac.copy?.state === "sending") return remoteLoginWords.sendingRow(name, mac.copy.sent ?? 0);
  if (mac.copy?.state === "starting") return remoteLoginWords.startingRow(name);
  switch (mac.stage) {
    case "setting-up":
      return remoteLoginWords.settingUpRow(name);
    case "finding":
      return remoteLoginWords.findingRow({ name });
    case "letting-in":
      return remoteLoginWords.lettingInRow(mac.address);
    default:
      return remoteLoginWords.reachingRow(mac.address);
  }
}
