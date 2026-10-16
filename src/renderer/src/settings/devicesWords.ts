import type { DeviceMake } from "../../../shared/cards";
import { COMPUTER, HERE } from "../../../shared/deviceNames";
import {
  type DeviceView,
  deviceLabel,
  deviceRunsWork,
  namesInWords,
} from "../../../shared/devices";
import { runsForAnotherFirstmate } from "../../../shared/sshConnection";

/** The words of Settings -> Devices (`DevicesTab.tsx`; design skill `components/devices/DevicesTab`). */

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

/** What each panel says, by what it holds. */
export const PANEL_WORDS: Record<
  DeviceMake,
  { label: string; say: [string, ...string[]]; copy: string; thing: "link" | "command" }
> = {
  link: {
    label: "New link",
    say: [
      `Your first mate stays on ${HERE.this}. Your other ${COMPUTER.one} will show it and can run work for it.`,
      `Paste this link into Infinitary on your other ${COMPUTER.one}, at its first launch.`,
    ],
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
  outOfReach: "out of reach",
  /** Followed by when it was last in reach: "out of reach since 14:02". */
  since: "out of reach since",
  removedWhenBack: "out of reach · removed when it is back",
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
      `${work} is still there. Update it, and its work comes here before ${label} is removed.`,
    ];
  if (!device.inReach)
    return [
      `Remove ${label}? It is out of reach.`,
      `${work} is still there. Wait, and it comes here before ${label} is removed.`,
    ];
  const tasks = device.tasks ?? 0;
  const stops =
    tasks === 0
      ? ""
      : `${tasks === 1 ? "Its task" : `Its ${tasks} tasks`}${runs.length > 0 ? ` on ${namesInWords(runs)}` : ""} ${tasks === 1 ? "stops" : "stop"}. `;
  return [
    `Remove ${label}? Its unmerged work comes here first.`,
    `${stops}Infinitary then removes what it set up there, with its sign-ins.`,
    ...(runs.length > 0
      ? [`${namesInWords(runs)} ${runs.length === 1 ? "runs" : "run"} on ${HERE.this} after.`]
      : []),
  ];
}
