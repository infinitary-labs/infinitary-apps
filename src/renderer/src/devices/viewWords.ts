import { type CardAction, opensSettings, takesTaskBrowser } from "@shared/cards";
import type { ComposerNotice } from "@shared/composer";
import type { JoinOutcome, ThisMac } from "@shared/devices";
import { formatDate, formatTime } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
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

/**
 * Whether this Mac's plain-text messages still go to the first mate while
 * changes are off: in reach, too far apart, and the first mate there hears
 * them while reading only (`messagesWhileReading`, docs/view.md "Read only").
 */
export function messagesWhileReading(thisMac: ThisMac | null): boolean {
  return (
    isView(thisMac) &&
    thisMac.contact === "in-reach" &&
    thisMac.readOnly !== null &&
    thisMac.messagesWhileReading === true
  );
}

/** What to do while the other Mac has a newer Firstmate: the tooltip, and the pill after its name. */
export const UPDATE_THIS_MAC = `Update Infinitary on ${HERE.this} to make changes`;

/** Why a card's button is off: its tooltip. */
export function changesOffWords(mac: ViewMac): string {
  if (mac.readOnly === "newer-there") return UPDATE_THIS_MAC;
  if (mac.readOnly === "older-there") return `Update Infinitary on ${mac.name} to make changes`;
  return `Changes are off until ${mac.name} is back`;
}

/** What this app says of an act only the first mate's own computer's Settings has. */
export function fromHomeWords(mac: ViewMac): string {
  return m.viewFromHomeOnly({ mac: mac.name });
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
  return m.viewGoogleUpdateThere({ mac: mac.name });
}

/**
 * What Settings says on a computer that controls a first mate when its
 * browser's return could not be caught here, so the address it ended on is
 * pasted instead (docs/view.md, "A sign-in that returns to the first mate's
 * computer").
 */
export const RETURN_PASTE_WORDS = {
  lead: (name: string) => m.viewReturnPasteLead({ name }),
  label: (name: string) => m.viewReturnPasteLabel({ name }),
  get placeholder() {
    return m.viewReturnPastePlaceholder();
  },
  send: (mac: ViewMac) => m.viewReturnPasteSend({ mac: mac.name }),
  /** A pasted address the waiting sign-in turned away, such as one from an earlier sign-in. */
  get refused() {
    return m.viewReturnPasteRefused();
  },
};

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
 * What a card's button says when this app never sends it: one that hands
 * the captain a task's browser, or one that opens Settings - Devices
 * included - that a first mate on an older version cannot answer. Nothing is
 * sent, and the card stays on both computers. Null for every other button.
 */
export function doneThereWords(mac: ViewMac, action: Pick<CardAction, "effect">): string | null {
  // An act Settings shows only on the first mate's own computer: moving it,
  // keeping a copy, keeping one of two, its Secrets (docs/view.md).
  if (action.effect?.kind === "open" && action.effect.fromHome) return fromHomeWords(mac);
  if (
    action.effect?.kind === "open" &&
    action.effect.target === "devices" &&
    mac.devicesNeedUpdateThere
  )
    return updateThereWords(mac);
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
 * How a replay or a reread brings this Mac level with the other one after a
 * gap (docs/view.md, "Live, catching up or out of reach"): `replay` while the
 * changes it missed arrive one by one, `reload` while it reads everything
 * again.
 */
export type CatchUp = "replay" | "reload";

/**
 * Whether this Mac is catching up, and how: only while the other Mac is in
 * reach, reading everything again until the window has read the newest
 * `caughtUp` (`rereadThrough`), then the missed changes still arriving.
 */
export function catchUpOf(mac: ViewMac, rereadThrough: number): CatchUp | null {
  if (mac.contact !== "in-reach") return null;
  if (mac.caughtUp > rereadThrough) return "reload";
  return mac.replaying ? "replay" : null;
}

/**
 * How current what this Mac shows is: `reaching` before it has heard the
 * other Mac since it started, `live` while every change there is shown here,
 * `catching-up` while missed changes are still being applied, and
 * `out-of-reach` once contact is gone.
 */
export type Freshness = "reaching" | "live" | "catching-up" | "out-of-reach";

export function freshnessOf(mac: ViewMac, catchUp: CatchUp | null): Freshness {
  if (mac.contact === "lost" || mac.contact === "closed") return "out-of-reach";
  if (mac.contact === "reaching") return "reaching";
  return catchUp ? "catching-up" : "live";
}

/** "14:02" today, otherwise "Nov 11 14:02": since when the other Mac is out of reach. */
export function sinceWhen(at: number, now: number): string {
  const date = new Date(at);
  const time = formatTime(date, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${formatDate(date, { month: "short", day: "numeric" })} ${time}`;
}

/**
 * The top line's parts: the dot, the words before the name, the name, what
 * follows it - "· live", "· catching up on what was missed", "· catching
 * up, reading everything again", "· read only" while the Firstmates are too
 * far apart, or "is out of reach · since" - and the time, in mono, that
 * names the day when it was not today.
 */
export function topLine(
  mac: ViewMac,
  catchUp: CatchUp | null = null,
  now: number = Date.now(),
): {
  tone: "ok" | "warn" | "ring";
  lead: string;
  name: string;
  tail: string | null;
  when: string | null;
  freshness: Freshness;
} {
  const freshness = freshnessOf(mac, catchUp);
  if (freshness === "out-of-reach")
    return {
      tone: "warn",
      lead: "",
      name: mac.name,
      tail:
        mac.heardAt === null
          ? m.devicesRemoteLineOutOfReach()
          : m.devicesRemoteLineOutOfReachSince(),
      when: mac.heardAt === null ? null : sinceWhen(mac.heardAt, now),
      freshness,
    };
  const tail =
    freshness === "catching-up"
      ? catchUp === "reload"
        ? m.devicesRemoteLineReadingAgain()
        : m.devicesRemoteLineCatchingUp()
      : mac.readOnly
        ? m.devicesRemoteLineReadOnly()
        : freshness === "live"
          ? m.devicesRemoteLineLive()
          : null;
  return {
    tone: freshness === "live" ? (mac.readOnly ? "warn" : "ok") : "ring",
    lead: m.devicesRemoteLineControlling(),
    name: mac.name,
    tail,
    when: null,
    freshness,
  };
}

/** The one line under the top bar that says why changes are off, or null while they are on. */
export function pillWords(mac: ViewMac): string | null {
  if (mac.contact === "lost")
    return `Changes are off until ${mac.name} is back. It may be asleep, or on another network.`;
  if (mac.contact === "closed")
    return `Infinitary is closed on ${mac.name}. Changes are off until it opens again.`;
  if (mac.contact !== "in-reach") return null;
  if (mac.readOnly !== null && mac.messagesWhileReading)
    return mac.readOnly === "newer-there"
      ? m.viewPillNewerHears({ name: mac.name })
      : m.viewPillOlderHears({ name: mac.name });
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
