import { type AppFollowReport, appFollowWhy } from "./appFollow";
import { shortCommit } from "./buildIdentity";
import type { CardAction } from "./cards";
import { HERE } from "./deviceNames";
import {
  type DeviceOtherVersion,
  type DeviceSystem,
  deviceLabel,
  installedThere,
  installItThereWords,
  userDisplayName,
} from "./devices";
import * as m from "./i18n/messages.generated.ts";
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

/**
 * Whether this computer updates that one by itself once it connects on an
 * older version, with no card to click (docs/devices.md, "Updating by
 * itself"): every computer but a Windows PC, which a newer Infinitary
 * installed there updates, and one too old to take the update order, which
 * a new command run there updates. A password asked there, or an update that
 * did not go through, puts the card up instead.
 */
export function deviceUpdatesItself(
  facts: Pick<DeviceUpdateNudgeFacts, "system" | "other">,
): boolean {
  return !installedThere(facts) && facts.other.updateBy !== "command";
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
  if (installedThere(facts)) return installItThereWords(deviceLabel(facts));
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
  if (facts.other.downloads) return `${remoteLoginWords.updateConnectionDownloadOffer()} ${stops}`;
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
  // One no home can update is updated by an install there: nothing here does it.
  if (installedThere(facts))
    return [
      {
        id: deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.notNow, gap),
        label: "Got it",
        default: true,
      },
    ];
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

/**
 * The card that asks the captain to update the app open on another computer
 * (docs/devices.md, "Updating the app open there"): it goes up only when that
 * app said it cannot get this computer's version by itself, or that getting
 * it did not go through; an app that follows by itself has no card.
 */
export type AppUpdateCardFacts = {
  deviceId: string;
  /** The computer the app is open on, as its row names it. */
  device: string;
  /** The app's own version. */
  app: string;
  /** This computer's version, the one the app follows. */
  home: string;
  follow: AppFollowReport;
};

/** The app card's id, beside the computer's own update card. */
export function appUpdateCardId(deviceId: string): string {
  return `card-app-update-${slug(deviceId)}`;
}

/** What names an app card's gap: both versions, and the step that raised it. */
export function appUpdateGap(facts: Pick<AppUpdateCardFacts, "app" | "home" | "follow">): string {
  return `app:${facts.home}>${facts.app}:${facts.follow.step}`;
}

export function appUpdateCard(facts: AppUpdateCardFacts): {
  title: string;
  meta: string;
  body: string;
  actions: CardAction[];
} {
  const { follow } = facts;
  const gap = appUpdateGap(facts);
  const paragraphs = [
    m.devicesAppCardHas({ device: facts.device, app: facts.app, home: facts.home }),
  ];
  if (follow.step === "cannot")
    paragraphs.push(
      `${m.devicesAppCannot({ version: facts.home })} ${appFollowWhy(follow.reason ?? "installation", facts.home)}`,
    );
  else paragraphs.push(m.devicesAppCardFailed());
  if (follow.problem) paragraphs.push(m.devicesAppCardSaid({ problem: follow.problem }));
  const notNow = deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.notNow, gap);
  return {
    title: m.devicesAppCardTitle({ device: facts.device }),
    meta: facts.device,
    body: paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("\n"),
    // Nothing here installs a copy that cannot follow: it is updated there.
    actions:
      follow.step === "cannot"
        ? [{ id: notNow, label: m.devicesAppCardGotIt(), default: true }]
        : [
            {
              id: deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.update, gap),
              label: m.devicesAppCardOpen(),
              default: true,
              effect: { kind: "open", target: "devices" },
            },
            { id: notNow, label: m.devicesAppCardNotNow(), variant: "ghost" },
          ],
  };
}

/**
 * The card that asks once whether a computer may run this computer's source
 * (docs/devices.md, "Matching the home's build"; design skill
 * `components/devices/UpdateNudge`, "Running this computer's code"): this
 * computer runs from source at a commit, and that computer runs another
 * build. Match it is the captain's yes for that computer, kept from then on;
 * after it, the computer is matched by itself whenever this one runs another
 * commit.
 */
export type SourceMatchCardFacts = {
  deviceId: string;
  /** The computer, as its row names it. */
  device: string;
  /** The commit this computer runs. */
  commit: string;
  /** What a refused match said, once one was. */
  refusal?: readonly string[] | undefined;
};

/** What names a source card's gap: the commit this computer runs. */
export function sourceMatchGap(facts: Pick<SourceMatchCardFacts, "commit">): string {
  return `source:${facts.commit}`;
}

export function sourceMatchCard(facts: SourceMatchCardFacts): {
  title: string;
  meta: string;
  body: string;
  actions: CardAction[];
} {
  const gap = sourceMatchGap(facts);
  const paragraphs = [
    m.devicesSourceCardBody({ device: facts.device, commit: shortCommit(facts.commit) }),
    m.devicesSourceCardOnce({ device: facts.device }),
  ];
  if (facts.refusal && facts.refusal.length > 0)
    paragraphs.push(m.devicesSourceCardRefused({ why: facts.refusal.join(" ") }));
  return {
    title: m.devicesSourceCardTitle({ device: facts.device }),
    meta: facts.device,
    body: paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join("\n"),
    actions: [
      {
        id: deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.update, gap),
        label: m.devicesSourceCardMatch(),
        default: true,
        effect: { kind: "open", target: "devices", update: facts.deviceId },
      },
      {
        id: deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.notNow, gap),
        label: m.devicesAppCardNotNow(),
        variant: "ghost",
      },
    ],
  };
}
