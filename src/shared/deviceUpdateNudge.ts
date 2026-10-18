import type { CardAction } from "./cards";
import { HERE } from "./deviceNames";
import {
  type DeviceOtherVersion,
  type DeviceSystem,
  deviceLabel,
  userDisplayName,
} from "./devices";
import { remoteLoginWords } from "./remoteLogin";

/**
 * The card that nudges the captain to update a computer on an older Firstmate
 * (docs/devices.md, "Another version, and updating"; design skill
 * `components/devices/UpdateNudge`): one per computer that runs work and is
 * connected on an older version than this computer's, built from the typed
 * comparison the Devices row reads (`DeviceOtherVersion`). Its title and
 * button are the ones the Firstmate's "update the computer" offer uses, so
 * one thing keeps one name.
 */

/** The computer the card is about, as the home lists it. */
export type DeviceUpdateNudgeFacts = {
  deviceId: string;
  name: string;
  user?: string | undefined;
  onThisMac?: boolean | undefined;
  remoteLogin?: string | undefined;
  system?: DeviceSystem | undefined;
  other: DeviceOtherVersion;
  /** This computer's Firstmate version. */
  homeApp?: string | undefined;
  /** What a refused update said, once one was. */
  refusal?: readonly string[] | undefined;
};

/** A card id's part from a device's id: lowercase words joined by dashes. */
function slug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The card's id; the Firstmate's own offer for the same computer is the same card. */
export function deviceUpdateCardId(deviceId: string): string {
  return `card-device-update-${slug(deviceId)}`;
}

/** The id the Firstmate's offer for the computer carries, for the host to find the card it stands for. */
export function deviceUpdateOfferCardId(deviceId: string): string {
  return `app-device-update-${slug(deviceId)}`;
}

/** The host's card an offer card id stands for, when the offer is the update of a computer. */
export function deviceUpdateCardOfOffer(offerCardId: string): string | undefined {
  const prefix = "app-device-update-";
  return offerCardId.startsWith(prefix)
    ? `card-device-update-${offerCardId.slice(prefix.length)}`
    : undefined;
}

/** The actions the card declares; the host reads them only as resolutions, each for one gap. */
export const DEVICE_UPDATE_ACTIONS = {
  update: "update",
  notNow: "not-now",
} as const;

/** What names the gap: this computer's version against that one's, as each is known. */
export function deviceUpdateGap(facts: Pick<DeviceUpdateNudgeFacts, "homeApp" | "other">): string {
  return `${facts.homeApp ?? "?"}>${facts.other.app ?? "?"}`;
}

/** An action's id for one gap, so a restart remembers which gap an answer was for. */
export function deviceUpdateActionId(action: string, gap: string): string {
  return `${action}@${gap}`;
}

/** A version in words: "alpha 0.4.0-alpha.70", "Infinitary 0.4.0". */
function versionWords(app: string): string {
  return /-alpha\b/.test(app) ? `alpha ${app}` : `Infinitary ${app}`;
}

export function deviceUpdateTitle(facts: DeviceUpdateNudgeFacts): string {
  return `Update Infinitary on ${deviceLabel(facts)}`;
}

/** The card's meta line: which computer it is about. */
export function deviceUpdateMeta(facts: DeviceUpdateNudgeFacts): string {
  return deviceLabel(facts);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** What the gap costs, and only while it costs something. */
function cost(facts: DeviceUpdateNudgeFacts): string {
  return facts.other.takesWork
    ? "It still takes work. Updating keeps the two in step."
    : "It takes no new work until it is updated. Tasks for projects set to run there wait, and Automatic skips it. Work already running there goes on.";
}

/** What Update it does, by how this computer reaches that one. */
function how(facts: DeviceUpdateNudgeFacts): string {
  const stops = "Its running work stops for a moment and goes on after.";
  if (facts.other.updateBy === "command")
    return "Its version of Infinitary is too old to update from here, so it needs a new command. Make the command here, then run it once in Terminal there.";
  if (facts.onThisMac === true && facts.remoteLogin)
    return `${remoteLoginWords.updateLocalCopyOffer()} ${stops}`;
  if (facts.onThisMac === true)
    return `Update it starts it again on ${HERE.this}'s own Infinitary${facts.user !== undefined ? `, as ${userDisplayName(facts.user)}` : ""}. ${stops}`;
  if (facts.other.updateBy === "remote-login")
    return facts.system === "linux"
      ? `Update it gets ${HERE.this}'s version of Infinitary there over Remote Login, with your own SSH key, and starts it again. ${stops}`
      : `${remoteLoginWords.updateDownloadOffer()} ${stops}`;
  return `Update it sends ${HERE.this}'s Infinitary to it over your network, and it starts again. ${stops}`;
}

export function deviceUpdateBody(facts: DeviceUpdateNudgeFacts): string {
  const label = escapeHtml(deviceLabel(facts));
  const has = facts.other.app
    ? `${label} has ${escapeHtml(versionWords(facts.other.app))}.`
    : `${label} has an older Infinitary.`;
  const here = facts.homeApp ? ` ${HERE.This} has ${escapeHtml(versionWords(facts.homeApp))}.` : "";
  const paragraphs = [`${has}${here} ${escapeHtml(cost(facts))}`, escapeHtml(how(facts))];
  if (facts.refusal && facts.refusal.length > 0)
    paragraphs.push(escapeHtml(`The last update was refused. ${facts.refusal.join(" ")}`));
  return paragraphs.map((text) => `<p>${text}</p>`).join("\n");
}

/** Update it (or Make the command), opening Settings -> Devices, beside Not now. */
export function deviceUpdateActions(facts: DeviceUpdateNudgeFacts): CardAction[] {
  const gap = deviceUpdateGap(facts);
  const hereAsUser = facts.onThisMac === true && facts.user !== undefined;
  const command = facts.other.updateBy === "command";
  return [
    {
      id: deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.update, gap),
      label: command ? "Make the command" : "Update it",
      default: true,
      effect: {
        kind: "open",
        target: "devices",
        ...(command
          ? { make: hereAsUser ? ("user-command" as const) : ("command" as const) }
          : { update: facts.deviceId }),
      },
    },
    {
      id: deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.notNow, gap),
      label: "Not now",
      variant: "ghost",
    },
  ];
}

/** The feed's one line when the gap appears. */
export function deviceUpdateSeenLine(facts: DeviceUpdateNudgeFacts): string {
  const label = deviceLabel(facts);
  const versions =
    facts.other.app && facts.homeApp
      ? `${label} has ${versionWords(facts.other.app)}, ${HERE.this} has ${versionWords(facts.homeApp)}.`
      : `${label} has an older Infinitary than ${HERE.this}.`;
  return `${versions} ${facts.other.takesWork ? "Update it to keep the two in step." : "It takes no new work until it is updated."}`;
}

/**
 * The feed's line when a task waits for a computer that is connected on an
 * older Firstmate and takes no new work (design skill `components/devices/RunsOn`);
 * `subject` is who waits, "website's next task" or the task by its title.
 */
export function noNewWorkWaitLine(subject: string, who: string): string {
  return `${subject} waits for ${who}. It takes no new work until it is updated.`;
}

/** The day's line for the same wait. */
export function noNewWorkDayLine(label: string, subject: string): string {
  return `${label} has taken no new work for a day. ${subject} still waits.`;
}

/** Start now's refusal for the same wait. */
export function noNewWorkStartRefusal(handle: string, who: string, here: string): string {
  return `${handle} waits for ${who}, which takes no new work until it is updated. It never runs on ${here} instead.`;
}
