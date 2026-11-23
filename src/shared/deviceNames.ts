import type { DeviceChip, DeviceSystem } from "./devices";
import { type Said, saidPart } from "./i18n/said.ts";

/**
 * What a device is called (design skill `copy/Vocabulary.prompt.md`, "a
 * computer, a phone"): every computer - a Mac, a Linux computer, later a
 * Windows one - is a computer, a phone is a phone, and the computer
 * Firstmate is open on is "this computer". The captain chose it for the
 * Linux app (FI3-1432, question 6: "Computer" for every computer, Macs
 * included, and "phone" for a phone).
 *
 * The one owner of those words: a sentence that names this computer or
 * another device reads them here, never its own copy. The ids saved under
 * the older words (the `mac` device kind, the `this-mac` choice of where a
 * task runs) keep their names; only the words a person reads change.
 * macOS's own names for its own settings, such as Remote Login, are not
 * device names and stay where the sentence points at macOS.
 */

/** This computer, as it names itself: mid-sentence and leading one. */
export const HERE = {
  this: "this computer",
  This: "This computer",
} as const;

/**
 * A sentence the first mate's computer says of itself as this computer,
 * shown on another computer that controls it: there it names that computer
 * by `name` instead (docs/view.md, "Settings on a view"). With no name, the
 * sentence is shown where it was written, and stays as it is.
 */
export function hereAs(text: string, name: string | null): string {
  return name === null ? text : text.replaceAll(HERE.This, name).replaceAll(HERE.this, name);
}

/**
 * This computer and here as a saved fact fills a blank with them (docs/i18n.md,
 * "Saved facts"): a line the first mate's computer says of itself, which a
 * computer that controls it names by `placesAs`.
 */
export const PLACE_SAID = {
  this: saidPart("placeThisComputer"),
  here: saidPart("placeHere"),
} as const;

/**
 * A fact the first mate's computer said of itself (`PLACE_SAID`), shown on
 * another computer that controls it: there each blank filled with this
 * computer names the first mate's computer by `name`, and each filled with
 * here says on it (docs/view.md, "The first mate's own words").
 */
export function placesAs(fact: Said, name: string): Said {
  if (!fact.a) return fact;
  let moved = false;
  const fills: NonNullable<Said["a"]> = {};
  for (const [blank, fill] of Object.entries(fact.a)) {
    const place = typeof fill === "object" && "m" in fill ? fill.m : undefined;
    fills[blank] =
      place === PLACE_SAID.this.m
        ? name
        : place === PLACE_SAID.here.m
          ? saidPart("placeOn", { computer: name })
          : fill;
    if (fills[blank] !== fill) moved = true;
  }
  return moved ? { ...fact, a: fills } : fact;
}

/** The computer where your first mate lives, named from another one that does not know its name. */
export const HOME = {
  the: "the computer where your first mate lives",
  The: "The computer where your first mate lives",
} as const;

/** Every other computer, by its noun. */
export const COMPUTER = {
  one: "computer",
  One: "Computer",
  many: "computers",
  Many: "Computers",
} as const;

export type DeviceNoun = "computer" | "phone";

/**
 * A device's noun, by the system it said it runs: a phone is a phone, and
 * every computer is a computer, as is a device that never said its system.
 */
export function deviceNoun(device: { system?: DeviceSystem | undefined }): DeviceNoun {
  return device.system === "ios" ? "phone" : "computer";
}

/**
 * What another user on this computer may read of the person's own files,
 * and where the person makes that user (design skill
 * `components/devices/AddAMac`, "Another user on this computer"): macOS
 * keeps private folders such as Desktop and Documents from every other
 * user, and makes users in System Settings; Linux leaves it to the home
 * folder's own permissions, and makes users in the desktop's settings.
 * Windows keeps each user's own folder from every other user who is not an
 * administrator, makes users in Settings, and installs Infinitary for each
 * user apart, so that user installs it too.
 */
export function anotherUserHere(platform: string): {
  /** The sentence the question in a terminal says. */
  reads: string;
  /** The same, as Firstmate's card says it of that user. */
  thatUserReads: string;
  /** The same, as Settings -> Devices says it under its list. */
  readsHere: string;
  makeUser: string;
} {
  if (platform === "win32")
    return {
      reads:
        "Windows keeps your user folder from it, unless it is an administrator, who can open it.",
      thatUserReads:
        "Windows keeps your user folder from that user, unless it is an administrator, who can open it.",
      readsHere: "Windows keeps your user folder from it, unless it is an administrator.",
      makeUser: "Make the user in Windows Settings first, and install Infinitary as that user.",
    };
  return platform === "darwin"
    ? {
        reads: `Like every user on ${HERE.this}, it can read files in your home folder, outside private folders such as Desktop and Documents.`,
        thatUserReads: `That user, like every user on ${HERE.this}, can read files in your home folder, outside private folders such as Desktop and Documents.`,
        readsHere: "Like every user here, it can read files in your home folder.",
        makeUser: "Make the user in System Settings first.",
      }
    : {
        reads: `Like every user on ${HERE.this}, it can read the files your home folder lets other users read.`,
        thatUserReads: `That user, like every user on ${HERE.this}, can read the files your home folder lets other users read.`,
        readsHere:
          "Like every user here, it can read the files your home folder lets other users read.",
        makeUser: "Make the user in your desktop's settings first.",
      };
}

export function aDevice(device: { system?: DeviceSystem | undefined }): string {
  return `a ${deviceNoun(device)}`;
}

/** A system by the name its maker gives it. */
export const SYSTEM_WORDS: Record<DeviceSystem, string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
  ios: "iOS",
};

/**
 * A chip in a person's words: Apple silicon or Intel on a Mac, and Arm or
 * Intel or AMD on another system. With no system said, a Mac's words.
 */
export function chipWords(chip: DeviceChip, system?: DeviceSystem): string {
  const mac = system === undefined || system === "macos";
  if (chip === "arm64") return mac ? "Apple silicon" : "Arm";
  return mac ? "Intel" : "Intel or AMD";
}
