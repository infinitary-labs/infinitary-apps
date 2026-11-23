import { z } from "zod";
import type { ActionLine, HandoverOffer } from "./actions";
import { offersAddressChange, offersHomeMove, offersStandby } from "./deviceActs";
import { COMPUTER, HERE } from "./deviceNames";
import { GITHUB_HOST } from "./deviceSetup";
import { type DeviceView, deviceRunsWork, deviceWords } from "./devices";
import { KEPT_ITEM_PREFIX, type KeptJobsView } from "./keptJobs";
import { SECRETS_AREAS, SECRETS_WORDS } from "./secrets";
import { type DeviceSignIns, signInPlace } from "./signIns";
import { runsForAnotherFirstmate } from "./sshConnection";
import type { StandbyViews } from "./standby";
import { workSetupWordsInEnglish } from "./workSetupWords";

/**
 * The acts in Settings that stay the captain's own click, each with the card
 * the first mate offers for it (primitives/app-actions.md, "Hand over"): the
 * host writes the card from the line's current value, and its one button
 * opens the exact place in Settings where the captain does it. None of
 * these runs anything from the card; the captain's click in Settings does.
 */

function slug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const deviceIdSchema = z.strictObject({ deviceId: z.string().min(1).max(64) });

/** The computers as the device lines read them: enough to name one and say why a card is refused. */
function devicesValue(current: unknown): Record<string, unknown> {
  return {
    devices: (current as DeviceView[]).map((device) => ({
      id: device.id,
      kind: device.kind,
      name: device.name,
      ...(deviceRunsWork(device.kind) ? { inReach: device.inReach === true } : {}),
      ...(device.otherVersion ? { otherVersion: true } : {}),
      ...(device.removal ? { removal: device.removal } : {}),
      ...(device.remoteLogin ? { byAddress: true } : {}),
    })),
  };
}

function workComputer(current: unknown, deviceId: unknown): { device: DeviceView; label: string } {
  const device = (current as DeviceView[]).find((candidate) => candidate.id === deviceId);
  if (!device) throw new Error("No device with that id is on the list. Look with app_state.");
  const label = deviceWords.label(device);
  if (!deviceRunsWork(device.kind))
    throw new Error(`${label} controls the first mate and runs no work, so this does not apply.`);
  if (device.removal) throw new Error(`${label} is being removed.`);
  if (runsForAnotherFirstmate(device.ssh))
    throw new Error(`${label} runs work for another first mate now, so only Remove applies.`);
  return { device, label };
}

/**
 * A card whose one button opens a computer's row in Settings → Devices;
 * `fromHome` for an act that row shows only on the first mate's own computer.
 */
function deviceCard(
  cardId: string,
  device: DeviceView,
  title: string,
  paragraphs: string[],
  fromHome = false,
): HandoverOffer {
  return {
    cardId: `${cardId}-${slug(device.id)}`,
    title,
    paragraphs,
    label: `Open ${deviceWords.label(device)}`,
    decline: "Not now",
    arrival: { item: device.id, ...(fromHome ? { fromHome: true as const } : {}) },
  };
}

/** The Secrets pages a card opens, by the name Settings gives each. */
const SECRETS_PAGES = SECRETS_AREAS.map((area) => area.value) as [
  (typeof SECRETS_AREAS)[number]["value"],
  ...(typeof SECRETS_AREAS)[number]["value"][],
];

const SECRETS_PAGE_SAYS: Record<(typeof SECRETS_PAGES)[number], string> = {
  decisions: "It lists the decisions you saved on secret requests, and removes one.",
  phone: "It lists the phones that approve secret requests, and stops one approving.",
  history: "It lists each use of a secret, and exports or deletes that history.",
  copy: "It saves the Secrets to recovery files, or restores them from those files.",
};

export const handoverLines = {
  "device-change-address": {
    area: "general",
    tier: "hands",
    handover: "devices",
    change: null,
    current: "inf:devices:list",
    value: deviceIdSchema,
    line: `Offer to change the address ${HERE.this} reaches a ${COMPUTER.one} at, for one added by its address, when the captain asks: app_change offers the captain one card whose button opens that ${COMPUTER.one} in Settings → Devices, where they type the new address and Change address looks there first. Name it by its id from app_state.`,
    alwaysTrail: true,
    toRequest: () => [],
    readValue: devicesValue,
    done: () => `offered to change a ${COMPUTER.one}'s address`,
    offer: (v, c) => {
      const { device, label } = workComputer(c, v.deviceId);
      if (!device.remoteLogin)
        throw new Error(`${label} was not added by its address, so it has no address to change.`);
      if (!offersAddressChange(device))
        throw new Error(`${HERE.This} does not reach ${label} by its address now.`);
      return deviceCard("app-device-change-address", device, `Change the address of ${label}?`, [
        `Open ${label} in Settings → Devices, choose Change address in its ⋯ menu, and type the address it answers at now.`,
        `${HERE.This} looks there first and keeps the new address only if the same ${COMPUTER.one} answers.`,
      ]);
    },
  },
  "home-move": {
    area: "general",
    tier: "hands",
    handover: "devices",
    change: null,
    current: "inf:devices:list",
    value: deviceIdSchema,
    line: `Offer to move you, the first mate, with your whole record, to a ${COMPUTER.one} that runs work when the captain asks: app_change offers one card whose button opens that ${COMPUTER.one} in Settings → Devices, where Move your first mate here shows what differs after the move, and only their Move now starts it. It must be in reach, on ${HERE.this}'s version, and not being removed. Name it by its id from app_state.`,
    alwaysTrail: true,
    toRequest: () => [],
    readValue: devicesValue,
    done: () => "offered to move the first mate",
    offer: (v, c) => {
      const { device, label } = workComputer(c, v.deviceId);
      if (device.inReach !== true)
        throw new Error(`${label} is out of reach, so the first mate cannot move there now.`);
      if (device.otherVersion)
        throw new Error(`${label} runs another version of Infinitary. Update it first.`);
      if (!offersHomeMove(device)) throw new Error(`${label} cannot take the first mate now.`);
      return deviceCard(
        "app-home-move",
        device,
        `Move your first mate to ${label}?`,
        [
          `Your first mate and its record would then run on ${label}, and ${HERE.this} would control it from there.`,
          `Move your first mate here, in its ⋯ menu, shows what differs after the move first. Only your Move now starts it.`,
        ],
        true,
      );
    },
  },
  "standby-keep": {
    area: "general",
    tier: "hands",
    handover: "devices",
    change: null,
    current: "inf:devices:list",
    offerReads: "inf:standby:list",
    value: deviceIdSchema,
    line: `Offer to keep a live copy of your record on a ${COMPUTER.one} that runs work, so it can take over if ${HERE.this} is lost, when the captain asks: app_change offers one card whose button opens that ${COMPUTER.one} in Settings → Devices, where only their Keep a copy here starts it. Stopping a copy is theirs there too. Name it by its id from app_state.`,
    alwaysTrail: true,
    toRequest: () => [],
    readValue: devicesValue,
    done: () => "offered to keep a copy on a computer",
    offer: (v, c, here) => {
      const { device, label } = workComputer(c, v.deviceId);
      const kept = (here.also as StandbyViews | undefined)?.standbys.some(
        (view) => view.deviceId === device.id,
      );
      if (!offersStandby(device, kept === true))
        throw new Error(
          `${label} keeps a copy already. Its row in Settings → Devices says how it stands.`,
        );
      return deviceCard(
        "app-standby-keep",
        device,
        `Keep a copy of your first mate on ${label}?`,
        [
          `${label} would keep a live copy of your first mate's record, so it can take over if ${HERE.this} is lost. The copy is never opened there.`,
          `Open ${label} in Settings → Devices and choose Keep a copy here in its ⋯ menu.`,
        ],
        true,
      );
    },
  },
  "device-forge-sign-in": {
    area: "integrations",
    tier: "hands",
    handover: "projects",
    multiMachine: true,
    change: null,
    current: "inf:devices:sign-ins",
    value: deviceIdSchema,
    line: `Sign a ${COMPUTER.one} that runs work in to GitHub with a sign-in of its own when the captain asks: app_change offers one card whose button opens Settings → Integrations with that ${COMPUTER.one}'s GitHub sign-in started under its row. Name it by its deviceId from app_state. Nothing from ${HERE.this}'s sign-in goes there, and you never see the code.`,
    alwaysTrail: true,
    toRequest: () => [],
    readValue: (c) => ({
      computers: (c as DeviceSignIns[]).map((device) => ({
        deviceId: device.deviceId,
        name: signInPlace(device).label,
        reach: device.reach,
        github:
          device.signIns?.forges?.signIns.some((entry) => entry.host === GITHUB_HOST) ?? false,
      })),
    }),
    done: () => "offered a GitHub sign-in on a computer",
    offer: (v, c) => {
      const device = (c as DeviceSignIns[]).find((candidate) => candidate.deviceId === v.deviceId);
      if (!device)
        throw new Error(
          `No ${COMPUTER.one} that runs work has that deviceId. Look with app_state.`,
        );
      const place = signInPlace(device);
      if (device.reach !== "in-reach") {
        const why = workSetupWordsInEnglish(
          place.label,
          device.workSetup,
          device.heldOnLocalNetwork,
        );
        throw new Error(
          `${place.who} is not connected for work, so no sign-in was offered.${why ? ` ${why}` : ""}`,
        );
      }
      const forges = device.signIns?.forges;
      if (!forges?.hosts.some((host) => host.host === GITHUB_HOST))
        throw new Error(`${place.who} has not said it can sign in to GitHub yet.`);
      if (forges.signIns.some((entry) => entry.host === GITHUB_HOST))
        throw new Error(`${place.who} is already signed in to GitHub.`);
      return {
        cardId: `app-device-forge-sign-in-${slug(device.deviceId)}`,
        title: `Sign in to GitHub ${place.where}`,
        paragraphs: [
          `${place.who} signs in to GitHub with a sign-in of its own, so its tasks can clone and open pull requests. Nothing from ${HERE.this}'s sign-in goes there.`,
          `Sign in opens Settings → Integrations, where the code to enter on GitHub shows under ${place.label}.`,
        ],
        label: "Sign in",
        decline: "Not now",
        arrival: { forgeSignInOn: { deviceId: device.deviceId, host: GITHUB_HOST } },
      };
    },
  },
  "keep-home": {
    area: "general",
    tier: "hands",
    handover: "devices",
    change: null,
    current: "inf:standby:list",
    value: z.strictObject({}),
    line: `When two first mates answer with one number, as after a takeover whose old home came back, offer the captain the card that keeps one: app_change opens Settings → Devices, where only their Keep this one or Keep the other chooses. Until then, acts that cannot be undone wait. app_state says twoHomes when it happens.`,
    alwaysTrail: true,
    toRequest: () => [],
    readValue: (c) => {
      const other = (c as StandbyViews).twoHomes;
      return other ? { twoHomes: { name: other.name } } : {};
    },
    done: () => "offered to keep one of two first mates",
    offer: (_v, c) => {
      const other = (c as StandbyViews).twoHomes;
      if (!other) throw new Error("Only one first mate answers, so there is nothing to keep.");
      return {
        cardId: "app-keep-home",
        title: "Keep one of your two first mates",
        paragraphs: [
          `The first mate on ${other.name} answers with this first mate's number too, so acts that cannot be undone wait until you keep one.`,
          "Settings → Devices asks which one to keep. The other steps down and keeps a copy.",
        ],
        label: "Open Devices",
        decline: "Not now",
        arrival: { fromHome: true },
      };
    },
  },
  "kept-job-forget": {
    area: "automation",
    tier: "hands",
    handover: "settings",
    change: null,
    current: "inf:automation:kept",
    value: z.strictObject({ id: z.string().trim().min(1).max(256) }),
    line: "Offer to forget a job kept running past its task's close whose remove did not finish, by id, when the captain asks: app_change offers one card whose button opens it in Settings → Automation, where only their Forget takes it off the list. Forget runs nothing, so the job may still run on its computer; try kept-job-remove first.",
    alwaysTrail: true,
    toRequest: () => [],
    readValue: (current) => ({
      jobs: (current as KeptJobsView).jobs.map((job) => ({
        id: job.id,
        label: job.label,
        computer: job.computerName,
        ...(job.removeFailed ? { removeFailed: job.removeFailed.outcome } : {}),
      })),
    }),
    done: () => "offered to forget a kept job",
    offer: (v, c) => {
      const job = (c as KeptJobsView).jobs.find((entry) => entry.id === v.id);
      if (!job) throw new Error(`No kept job ${v.id}. Its id is in this action's current value.`);
      if (!job.removeFailed)
        throw new Error(
          `Forget is offered only once a remove did not finish. Use kept-job-remove for ${job.label}.`,
        );
      return {
        cardId: `app-kept-job-forget-${slug(job.id)}`,
        title: `Forget the kept job ${job.label}?`,
        paragraphs: [
          `Its remove on ${job.computerName} did not finish. Forget takes it off the list and runs nothing, so it may still run there.`,
          "Open it in Settings → Automation and choose Forget.",
        ],
        label: "Open Automation",
        decline: "Not now",
        arrival: { section: "automation", item: `${KEPT_ITEM_PREFIX}${job.id}` },
      };
    },
  },
  "secrets-page": {
    area: "general",
    tier: "hands",
    handover: "settings",
    change: null,
    current: null,
    value: z.strictObject({ page: z.enum(SECRETS_PAGES) }),
    line: `Open a page of Secrets for the captain when they ask to see or manage it: app_change offers one card whose button opens it in Settings → Secrets. page: ${SECRETS_AREAS.map((area) => `${area.value} (${area.label})`).join(", ")}. Every act there, such as Export history, stays their click, and no value ever reaches you.`,
    alwaysTrail: true,
    toRequest: () => [],
    readValue: () => ({}),
    done: () => "offered a page of Secrets",
    offer: (v) => {
      const page = v.page as (typeof SECRETS_PAGES)[number];
      const name = SECRETS_AREAS.find((area) => area.value === page)?.label ?? page;
      return {
        cardId: `app-secrets-page-${page}`,
        title: `Open ${name} in Secrets`,
        paragraphs: [
          SECRETS_PAGE_SAYS[page],
          `It opens in Settings → Secrets, under ${SECRETS_WORDS.management}. What you do there stays yours.`,
        ],
        label: "Open Secrets",
        decline: "Not now",
        arrival: { section: "secrets", item: page, fromHome: true },
      };
    },
  },
} as const satisfies Record<string, ActionLine>;
