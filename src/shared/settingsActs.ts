import { z } from "zod";
import type { ActionLine } from "./actions";
import type { DecisionsView } from "./decisions";
import { type DeviceView, deviceWords } from "./devices";
import type { IntegrationsView } from "./integrations";
import type { KeptJobsView, KeptJobView } from "./keptJobs";
import type { PersonalSnapshot } from "./personal/manifest";
import type { PrivateSiteChange, PrivateSitesView } from "./privateSites";
import type { SecretsView } from "./secrets";
import type { StandbyViews } from "./standby";
import { type UpdateStatus, updateChannelSchema } from "./update";

/**
 * Settings' one-off acts and undos the first mate runs too
 * (primitives/app-actions.md, "Acts"): each is the button's own request, and
 * its trail is the act it did (`trailOf`), never a value compared before and
 * after, since an act like Check for updates leaves none.
 */
const idSchema = z.string().trim().min(1).max(64);

/** A computer as an act on its row needs it: what it is and what the act changes. */
function deviceBrief(device: DeviceView): Record<string, unknown> {
  return {
    id: device.id,
    kind: device.kind,
    name: device.name,
    ...(device.removal ? { removal: device.removal } : {}),
    ...(device.workSetup ? { workSetup: device.workSetup.state } : {}),
    ...(device.ssh ? { ssh: device.ssh.state } : {}),
  };
}
function devicesBrief(current: unknown): Record<string, unknown> {
  return { devices: (current as DeviceView[]).map(deviceBrief) };
}
function deviceOf(current: unknown, id: unknown): DeviceView | undefined {
  return (current as DeviceView[] | null)?.find((device) => device.id === id);
}
function okText(result: unknown): Record<string, unknown> {
  const { ok, text } = result as { ok: boolean; text: string };
  return { ok, text };
}

export const settingsActs = {
  "update-channel": {
    fields: ["stable", "alpha"],
    area: "general",
    tier: "asked",
    change: "inf:update:channel",
    current: "inf:update:status",
    value: z.strictObject({ channel: updateChannelSchema }),
    line: "Which releases this app updates to, stable or alpha, when asked: alpha brings new things sooner and less tested. Only where this app chooses its own channel (choosable true).",
    toRequest: (v) => [v.channel],
    readValue: (current) => ({
      channel: (current as UpdateStatus).channel,
      choosable: (current as UpdateStatus).channelChoice === true,
    }),
    done: (v) => `updates follow the ${v.channel} releases`,
  },
  "update-check": {
    area: "general",
    tier: "asked",
    change: "inf:update:check",
    current: "inf:update:status",
    value: z.strictObject({}),
    line: "Check for updates now, as Settings' Check for updates does, when asked: answers the newest version and whether it is newer than this one.",
    toRequest: () => [],
    readValue: (current) => ({
      version: (current as UpdateStatus).currentVersion,
      latest: (current as UpdateStatus).latestVersion,
      available: (current as UpdateStatus).updateAvailable,
    }),
    // A check that failed says so, never the status it read before.
    trailOf: (_args, result) =>
      (result as UpdateStatus).problem
        ? { failed: true }
        : {
            latest: (result as UpdateStatus).latestVersion,
            available: (result as UpdateStatus).updateAvailable,
          },
    answers: (result) => ({
      latest: (result as UpdateStatus).latestVersion,
      available: (result as UpdateStatus).updateAvailable,
      ...((result as UpdateStatus).problem ? { problem: (result as UpdateStatus).problem } : {}),
    }),
    done: (v) =>
      v.failed
        ? "could not check for updates"
        : v.available
          ? `checked for updates: ${v.latest} is ready`
          : "checked for updates: up to date",
  },
  "inbox-link": {
    area: "integrations",
    tier: "asked",
    change: "inf:integrations:inbox-link",
    current: "inf:integrations:list",
    value: z.strictObject({}),
    line: "Make the Infinitary command's short name, as Settings → Integrations' link button does, when asked: only while its link is offered.",
    toRequest: () => [],
    readValue: (current) => ({
      link:
        (current as IntegrationsView).integrations.find((entry) => entry.door)?.door?.link.state ??
        null,
    }),
    done: (v) => `Infinitary command link ${v.link ?? "not offered"}`,
  },
  "panel-retry": {
    area: "panels",
    tier: "own-words",
    change: "inf:plugins:retry",
    current: "inf:plugins:personal:list",
    value: z.strictObject({ surface: idSchema }),
    line: "Start a panel's background work again after the app stopped it, as its Retry does, in the captain's own words: name the panel by its id from this action's current value.",
    toRequest: (v) => [v.surface],
    readValue: (current) => ({
      stopped: (current as PersonalSnapshot).extensions
        .filter((panel) => panel.stopped)
        .map((panel) => ({ surface: panel.id, title: panel.title, why: panel.stopped?.reason })),
    }),
    trailOf: (args, result) => (result === true ? { surface: args[0] } : null),
    answers: (result) => ({ retried: result === true }),
    done: (v) => `${v.surface} started again`,
  },
  "panel-ask-again": {
    area: "panels",
    tier: "asked",
    change: "inf:plugins:ask-again",
    current: "inf:plugins:personal:list",
    value: z.strictObject({
      surface: idSchema,
      integration: z.string().min(1).max(200),
      action: z.string().min(1).max(200),
    }),
    line: "Ask again for a panel's integration call that waits on the captain or that the captain turned down, as its Ask again does, when asked: the approval card shows again.",
    toRequest: (v) => [v.surface, v.integration, v.action],
    readValue: (current) => ({
      asks: (current as PersonalSnapshot).extensions.flatMap((panel) =>
        (panel.integrationAsks ?? []).map((ask) => ({
          surface: panel.id,
          integration: ask.integration,
          action: ask.action,
          label: ask.label,
          state: ask.state,
        })),
      ),
    }),
    trailOf: (args, result) => (result === true ? { surface: args[0], action: args[2] } : null),
    answers: (result) => ({ asked: result === true }),
    done: (v) => `asked again for ${v.surface}'s ${v.action}`,
  },
  "decision-use-off": {
    fields: ["id", "on"],
    area: "intelligence",
    tier: "asked",
    change: "inf:decisions:use:set",
    current: "inf:settings:decisions",
    value: z.strictObject({ use: z.string().min(1).max(200) }),
    line: "Turn off one way the app asks a decision model, by its use id, when asked. Turning one on stays with the captain in Settings, since it may need the captain's approval.",
    toRequest: (v) => [{ id: v.use, on: false }],
    refuses: (args) => {
      const [request] = args as [Record<string, unknown> | undefined];
      return request?.on === false && request.approve === undefined && request.agreed === undefined
        ? null
        : "Turning a decision model use on stays with the captain in Settings.";
    },
    readValue: (current) => ({
      uses: ((current as DecisionsView).uses ?? []).map(({ id, name, on }) => ({ id, name, on })),
    }),
    trailOf: (args, result, before) => {
      const [request] = args as [{ id: string; on: boolean }];
      const was = (before as DecisionsView).uses?.find((use) => use.id === request.id);
      const now = (result as DecisionsView).uses?.find((use) => use.id === request.id);
      return was && now && was.on !== now.on ? { use: now.name, on: now.on } : null;
    },
    done: (v) => `decision model use ${v.use} ${v.on ? "on" : "off"}`,
  },
  "private-site-remove": {
    area: "integrations",
    tier: "own-words",
    change: "inf:browser:private-sites:remove",
    current: "inf:browser:private-sites",
    value: z.strictObject({ site: z.string().min(1).max(2_048) }),
    line: "Take a private site off Settings → Integrations → Private sites, in the captain's own words: task browsers stop reaching it.",
    toRequest: (v) => [v.site],
    readValue: (current) => ({ privateSites: (current as PrivateSitesView).sites }),
    // Removing a site the list never held answers ok too, and is no line.
    trailOf: (_args, result, before) => {
      const change = result as PrivateSiteChange;
      const gone = change.ok
        ? (before as PrivateSitesView).sites.find((site) => !change.sites.includes(site))
        : undefined;
      return gone ? { site: gone } : null;
    },
    answers: (result) =>
      (result as PrivateSiteChange).ok ? {} : { text: (result as { text: string }).text },
    done: (v) => `removed ${String(v.site)} from private sites`,
  },
  "secret-end-read": {
    // One variant of Settings' secret request; every other stays the captain's (`refuses`).
    fields: ["kind", "kind=end-read", "id"],
    area: "general",
    tier: "own-words",
    change: "inf:secrets:action",
    current: "inf:secrets:view",
    value: z.strictObject({ id: z.string().min(1).max(200) }),
    line: "End a temporary permission to read secrets before it runs out, as its End now does, in the captain's own words: name it by its id from this action's current value.",
    toRequest: (v) => [{ kind: "end-read", id: v.id }],
    refuses: (args) =>
      (args[0] as { kind?: unknown } | undefined)?.kind === "end-read"
        ? null
        : "Every secret action but ending a read stays with the captain.",
    readValue: (current) => ({
      reads: (current as SecretsView).reads.map(({ id, label, destination, expires }) => ({
        id,
        label,
        destination,
        expires,
      })),
    }),
    // The other secret actions are the captain's own and leave no line of this one's.
    trailOf: (args, _result, before) => {
      const [request] = args as [{ kind: string; id?: string }];
      if (request.kind !== "end-read") return null;
      const read = (before as SecretsView).reads.find((entry) => entry.id === request.id);
      return read ? { label: read.label } : null;
    },
    done: (v) => `ended the permission to read ${String(v.label)}`,
  },
  "device-keep": {
    area: "general",
    tier: "asked",
    change: "inf:devices:keep",
    current: "inf:devices:list",
    value: z.strictObject({ deviceId: idSchema }),
    line: "Keep a computer that waits to be removed once it is back (removal when-back), as its Keep it does, when asked: it stays on the list.",
    toRequest: (v) => [v.deviceId],
    readValue: devicesBrief,
    trailOf: (args, result, before) =>
      deviceOf(before, args[0])?.removal === "when-back" ? { device: result } : null,
    done: (v) => `${deviceWords.label(v.device as DeviceView)} stays on the list`,
  },
  "home-move-cancel": {
    area: "general",
    tier: "asked",
    change: "inf:home-move:cancel",
    current: "inf:app:healthcheck",
    value: z.strictObject({}),
    line: "Cancel moving the first mate to another computer while the move runs, as its Cancel does, when asked: answers whether it stopped and what stays where.",
    toRequest: () => [],
    readValue: () => ({}),
    trailOf: (_args, result) => ((result as { ok: boolean }).ok ? okText(result) : null),
    answers: okText,
    done: (v) => String(v.text),
  },
  "copy-stop": {
    area: "general",
    tier: "asked",
    change: "inf:standby:name",
    current: "inf:standby:list",
    value: z.strictObject({ deviceId: idSchema }),
    line: "Stop keeping a copy of the record on a computer, as its Stop keeping a copy does, when asked. Starting one stays with the captain in Settings.",
    toRequest: (v) => [v.deviceId, false],
    refuses: (args) =>
      args[1] === false ? null : "Starting to keep a copy stays with the captain in Settings.",
    readValue: (current) => ({
      copies: (current as StandbyViews).standbys.map(({ deviceId, state }) => ({
        deviceId,
        state,
      })),
    }),
    // Stopping a copy no computer keeps answers ok too, and is no line.
    trailOf: (args, result, before) =>
      args[1] === false &&
      (result as { ok: boolean }).ok &&
      (before as StandbyViews).standbys.some((copy) => copy.deviceId === args[0])
        ? okText(result)
        : null,
    answers: okText,
    done: (v) => String(v.text),
  },
  "device-fix-work": {
    area: "general",
    tier: "asked",
    change: "inf:devices:fix-work",
    current: "inf:devices:list",
    value: z.strictObject({ deviceId: idSchema }),
    line: "Ask a Mac whose work has not finished setting up (workSetup) to set it up again, as its Fix it does, when asked: only while its window is connected.",
    toRequest: (v) => [v.deviceId],
    readValue: devicesBrief,
    trailOf: (args, result, before) => {
      const device = deviceOf(before, args[0]);
      return (result as { asked: boolean }).asked && device ? { device } : null;
    },
    answers: (result) => ({ asked: (result as { asked: boolean }).asked }),
    done: (v) => `asked ${deviceWords.label(v.device as DeviceView)} to set up its work again`,
  },
  "device-try-again": {
    area: "general",
    tier: "asked",
    change: "inf:devices:try-again",
    current: "inf:devices:list",
    value: z.strictObject({ deviceId: idSchema.optional() }),
    line: "Try this computer's own SSH connection to a computer added by its address again now, as its Try again does, when asked; with no deviceId, every one it stopped trying.",
    toRequest: (v) => (v.deviceId === undefined ? [] : [v.deviceId]),
    readValue: devicesBrief,
    trailOf: (_args, result) => {
      const { tried } = result as { tried: number };
      return tried > 0 ? { tried } : null;
    },
    answers: (result) => ({ tried: (result as { tried: number }).tried }),
    done: (v) => `tried ${v.tried} SSH ${v.tried === 1 ? "connection" : "connections"} again`,
  },
  "kept-job-check": {
    area: "automation",
    tier: "asked",
    change: "inf:automation:kept-check",
    current: "inf:automation:kept",
    value: z.strictObject({ id: z.string().trim().min(1).max(256) }),
    line: "Check that one job kept running past its task's close still runs, by id, when asked: its recorded check runs on the computer it runs on.",
    toRequest: (v) => [v.id],
    readValue: (current) => ({
      jobs: (current as KeptJobsView).jobs.map((job) => ({
        id: job.id,
        label: job.label,
        computer: job.computerName,
        ...(job.checked ? { checked: job.checked.outcome } : {}),
      })),
    }),
    trailOf: (_args, result) => ({
      label: (result as KeptJobView).label,
      outcome: (result as KeptJobView).checked?.outcome ?? null,
    }),
    answers: (result) => ({ checked: (result as KeptJobView).checked?.outcome ?? null }),
    done: (v) => `checked ${String(v.label)}: ${v.outcome ?? "no answer"}`,
  },
} as const satisfies Record<string, ActionLine>;
