import { type CardAction, opensSettings, takesTaskBrowser } from "@shared/cards";
import type { ComposerNotice } from "@shared/composer";
import type { JoinOutcome, ThisMac } from "@shared/devices";
import { COMPUTER, HERE } from "../../../shared/deviceNames";

/**
 * The words an app controlling Firstmate on another Mac says (design skill
 * `components/devices/RemoteControl` and `JoinAnotherMac`; docs/view.md).
 * The other Mac is named by its own name, never as a home or a server, and
 * an address stays the thing itself.
 */

export type ViewMac = Extract<ThisMac, { role: "view" }>;

/** This app controls another Mac. */
export function isView(thisMac: ThisMac | null): thisMac is ViewMac {
  return thisMac?.role === "view";
}

/**
 * Whether this app shows a Settings section: all of them where the first mate
 * lives; on a computer that controls another, those a view shows (docs/view.md).
 */
export function showsSection(
  thisMac: ThisMac | null,
  section: { readonly onAView?: boolean },
): boolean {
  return !isView(thisMac) || section.onAView === true;
}

/**
 * Where the first mate lives, as a sentence in its Settings names it: this
 * computer, or that computer by its name from one that controls it.
 */
export function firstMatePlace(thisMac: ThisMac | null): { this: string; This: string } {
  return isView(thisMac) ? { this: thisMac.name, This: thisMac.name } : HERE;
}

/**
 * Whether this Mac may change anything on the other one right now: only
 * while it is in reach and the two Firstmates are close enough. Changes
 * are refused at once otherwise, and never sent later.
 */
export function changesOff(thisMac: ThisMac | null): boolean {
  return isView(thisMac) && (thisMac.contact !== "in-reach" || thisMac.readOnly !== null);
}

/** "14:32": the clock the app's other lines use. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** What to do while the other Mac has a newer Firstmate: the tooltip, and the pill after its name. */
export const UPDATE_THIS_MAC = `Update Infinitary on ${HERE.this} to make changes`;

/** Why a card's button is off: its tooltip. */
export function changesOffWords(mac: ViewMac): string {
  if (mac.readOnly === "newer-there") return UPDATE_THIS_MAC;
  if (mac.readOnly === "older-there") return `Update Infinitary on ${mac.name} to make changes`;
  return `Changes are off until ${mac.name} is back`;
}

/**
 * What a card's button that opens the first mate's Devices section says:
 * its computers and phones are not changed from another computer yet.
 */
export function devicesNotHereWords(mac: ViewMac): string {
  return `${mac.name}'s computers and phones cannot be changed from here yet.`;
}

/** What this app says of something the first mate there is too old to answer. */
export function updateThereWords(mac: ViewMac): string {
  return `Update Infinitary on ${mac.name} to do this from here.`;
}

/** Whether the first mate there is too old to answer what this version asks of it. */
export function waitsForUpdate(thisMac: ThisMac | null): thisMac is ViewMac {
  return isView(thisMac) && thisMac.needsUpdateThere === true;
}

/** Whether a Settings section waits for an update on the first mate's computer. */
export function sectionWaitsForUpdate(
  thisMac: ThisMac | null,
  section: { readonly onAnOlderFirstMate?: boolean },
): thisMac is ViewMac {
  return waitsForUpdate(thisMac) && !section.onAnOlderFirstMate;
}

/**
 * What Google's notice says on a computer that controls a first mate too old
 * to take its sign-in's return from here (docs/view.md, "A sign-in that
 * returns to the first mate's computer"), in place of its accept.
 */
export function googleUpdateThereWords(mac: ViewMac): string {
  return `Update Infinitary on ${mac.name} to sign in to Google from here.`;
}

/**
 * What Settings says on a computer that controls a first mate when its
 * browser's return could not be caught here, so the address it ended on is
 * pasted instead (docs/view.md, "A sign-in that returns to the first mate's
 * computer").
 */
export const RETURN_PASTE_WORDS = {
  lead: (name: string) =>
    `Approve on ${name}'s page. Your browser then ends on a page that cannot be reached. Copy that page's address and paste it here.`,
  label: (name: string) => `The address your browser ended on after ${name}`,
  placeholder: "paste the address",
  send: (mac: ViewMac) => `Send to ${mac.name}`,
  /** A pasted address the waiting sign-in turned away, such as one from an earlier sign-in. */
  refused:
    "That address is not this sign-in's. Paste the address your browser ended on after this sign-in.",
} as const;

/**
 * What a request card's button that hands the captain a task's browser says
 * when the first mate there is too old to show it here.
 */
export function browserNotHereWords(mac: ViewMac): string {
  return `Update Infinitary on ${mac.name} to show this task's browser here.`;
}

/** Whether the first mate there is too old to show its task's browsers here. */
export function browserWaitsForUpdate(thisMac: ThisMac | null): thisMac is ViewMac {
  return isView(thisMac) && thisMac.browserNeedsUpdateThere === true;
}

/**
 * What a card's button says when this app never sends it: one that opens
 * Devices, or one that hands the captain a task's browser or opens Settings
 * that a first mate on an older version cannot answer. Nothing is sent, and
 * the card stays on both computers. Null for every other button.
 */
export function doneThereWords(mac: ViewMac, action: Pick<CardAction, "effect">): string | null {
  if (action.effect?.kind === "open" && action.effect.target === "devices")
    return devicesNotHereWords(mac);
  if (takesTaskBrowser(action) && mac.browserNeedsUpdateThere) return browserNotHereWords(mac);
  if (opensSettings(action) && mac.needsUpdateThere) return updateThereWords(mac);
  return null;
}

/**
 * What a task's browser view shows in place of its page while the first mate
 * there is too old to show it here.
 */
export function browserShownThereWords(mac: ViewMac): { lead: string; detail: string } {
  return {
    lead: browserNotHereWords(mac),
    detail: `Until then, only a window on ${mac.name} can show it.`,
  };
}

/** What the input says when sending was refused; the words stay in it. */
export function notSentWords(mac: ViewMac): string {
  if (mac.readOnly === "newer-there")
    return `Not sent. Update Infinitary on ${HERE.this} to send it.`;
  if (mac.readOnly === "older-there")
    return `Not sent. Update Infinitary on ${mac.name} to send it.`;
  return `Not sent. Your words stay here until ${mac.name} is back.`;
}

/** What the input says when a file that is neither a picture nor text was not added. */
export function fileOtherMacWords(mac: ViewMac): string {
  return `Only pictures and text files can go to ${mac.name}. Other files were not added.`;
}

/** A composer notice's words that name the other Mac; null for the rest, which read the same on any Mac. */
export function namedNoticeWords(notice: ComposerNotice, mac: ViewMac): string | null {
  if (notice === "away") return notSentWords(mac);
  if (notice === "file-other-mac") return fileOtherMacWords(mac);
  return null;
}

/**
 * The top line's parts: the dot, the words before the name, the name, and
 * what follows it - "· as of 14:32" while out of reach, "· read only" while
 * the Firstmates are too far apart.
 */
export function topLine(mac: ViewMac): {
  tone: "ok" | "warn" | "ring";
  lead: string;
  name: string;
  tail: string | null;
} {
  if (mac.contact === "lost" || mac.contact === "closed")
    return {
      tone: "warn",
      lead: "",
      name: mac.name,
      tail: mac.heardAt === null ? "is out of reach" : "is out of reach · as of",
    };
  return {
    tone: mac.contact === "reaching" ? "ring" : mac.readOnly ? "warn" : "ok",
    lead: "Controlling your first mate on",
    name: mac.name,
    tail: mac.readOnly ? "· read only" : null,
  };
}

/** The one line under the top bar that says why changes are off, or null while they are on. */
export function pillWords(mac: ViewMac): string | null {
  if (mac.contact === "lost")
    return `Changes are off until ${mac.name} is back. It may be asleep, or on another network.`;
  if (mac.contact === "closed")
    return `Infinitary is closed on ${mac.name}. Changes are off until it opens again.`;
  if (mac.contact !== "in-reach") return null;
  if (mac.readOnly === "newer-there")
    return `${mac.name} has a newer Infinitary. ${UPDATE_THIS_MAC}.`;
  if (mac.readOnly === "older-there")
    return `${mac.name} has an older Infinitary. Update Infinitary there to make changes.`;
  return null;
}

/** Said once when contact returns, then it fades. */
export function backWords(mac: ViewMac): string {
  return `${mac.name} is back. ${HERE.This} caught up.`;
}

/** The line under the first launch's chips after this app stopped controlling a Mac. */
export function leftLine(left: NonNullable<Extract<ThisMac, { role: "home" }>["left"]>): string {
  return left.reason === "left"
    ? `${HERE.This} left ${left.name}.`
    : `${left.name} removed ${HERE.this}. Paste a new link to come back.`;
}

/** The question before joining, either side of the address the link names. */
export const JOIN_CONFIRM_WORDS = {
  before: `Your first mate stays on the ${COMPUTER.one} at`,
  after: ". Control it from here?",
  orPrivate: ", or on your private network",
};

/** The confirm question's line for a link that adds a Mac that also runs work. */
export const JOIN_RUNS_WORK = "It can also run work you give it, with sign-ins of its own.";

/** The sentence a refused join says, with the address the link names. */
export function joinRefusalWords(
  refused: Exclude<JoinOutcome, { ok: true }>["refused"],
  address: string | null,
): string {
  const at = address ?? "that address";
  switch (refused) {
    case "not-a-link":
      return `That is not a link from Infinitary. Copy it again on your other ${COMPUTER.one}.`;
    case "kind":
      return `That link is for another user on your other ${COMPUTER.one}. Make a link for ${HERE.this} there.`;
    case "used":
      return `That link was used already. Make a new one on your other ${COMPUTER.one}.`;
    case "expired":
      return `That link expired. A link lasts ten minutes; make a new one on your other ${COMPUTER.one}.`;
    case "unknown":
      return `That link no longer works. Make a new one on your other ${COMPUTER.one}.`;
    case "unreachable":
      return `Could not reach ${at}. Both ${COMPUTER.many} need the same network, or the same private network.`;
    case "not-that-mac":
      return `Something answered at ${at}, but not the ${COMPUTER.one} that made this link. Nothing was sent to it.`;
    default:
      return `${HERE.This} could not join. Make a new link on your other ${COMPUTER.one} and try again.`;
  }
}
