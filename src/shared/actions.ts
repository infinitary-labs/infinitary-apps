import { cutText } from "@shared/textCut";
import { z } from "zod";
import type { AccountView } from "./accounts";
import { type AutomationList, type AutomationRule, automationSpecSchema } from "./automation";
import { type BatchAnswer, batchAnswerSchema } from "./batches";
import type { DeviceMake } from "./cards";
import { type AppCostLimitView, costLimitSchema, formatUsd } from "./costLimit";
import { crewSpeedSchema, SPEED_NAMES } from "./crewSpeed";
import { type DecisionAnswerer, type DecisionsView, decisionAnswererSchema } from "./decisions";
import { anotherUserHere, COMPUTER, HERE } from "./deviceNames";
import {
  type DeviceView,
  deviceNameSchema,
  deviceRunsWork,
  deviceWords,
  userDisplayName,
} from "./devices";
import { FONT_SLOTS, type FontChoices, type FontSlot, fontFamilySchema } from "./fonts";
import { hostOfAddress, kindByName } from "./forge";
import { FORGE_HOST_NAME, type ForgesView } from "./forges";
import { englishOf, type Said } from "./i18n/said";
import {
  INTEGRATION_KIND_NAMES,
  INTEGRATIONS_SIGN_IN_HOST,
  type IntegrationKind,
  type IntegrationsView,
  integrationActionNameSchema,
  integrationIdSchema,
  integrationKindSchema,
  integrationMcpAddSchema,
  integrationSettingsPatchSchema,
} from "./integrations";
import { type CoreInvokeChannel, invokeContract } from "./ipc";
import { type KnowledgeDirections, knowledgeDirectionChangeSchema } from "./knowledge";
import { reasoningChoiceSchema, slotSchema } from "./modelSlots";
import { arrangePanels, movePanel } from "./panelArrangement";
import { AUTOMATIC_COMPUTER } from "./placement";
import {
  type Appearance,
  DEFAULT_APPEARANCE,
  type Layout,
  themeSchema,
  uiSizeSchema,
  washStrengthSchema,
} from "./preferences";
import { normalizePrivateSite, type PrivateSitesView } from "./privateSites";
import { projectSetupProposalSchema } from "./projectSetup";
import { catalogEntry } from "./providers";
import type { RoutingSettings } from "./quota";
import { reasoningWord } from "./reasoning";
import type { ReleaseNotesView } from "./releaseTracking";
import { remoteLoginAddressSchema, remoteLoginWords } from "./remoteLogin";
import {
  type QueueAnswer,
  queueAnswerSchema,
  type RepoView,
  repoPolicyOutcome,
  repoPolicyPatchSchema,
  runsHereOnly,
  runsOnSaid,
} from "./repos";
import { type DeviceSignIns, signInPlace } from "./signIns";

/**
 * Stable permissions, independent of Settings tabs. Captain can run every
 * line. `asked` and `own-words` are the first mate's at any wake, on its
 * judgment that the captain asked - in any form for `asked`, in his typed
 * words for `own-words` - with that evidence (INF-751). `judgment` is the
 * first mate's own judgment of what the captain wants, whatever began its
 * turn (INF-638), with its reason as evidence.
 */
export type ActionTier = "asked" | "own-words" | "hands" | "yours" | "judgment";
export type ActionLine = {
  alwaysTrail?: boolean;
  /** Settings owned inside a shared request object (or its selector enum). */
  fields?: string[];
  area:
    | "projects"
    | "appearance"
    | "general"
    | "panels"
    | "intelligence"
    | "automation"
    | "integrations";
  tier: ActionTier;
  change: CoreInvokeChannel | null;
  channels?: CoreInvokeChannel[];
  handover?: "settings" | "subscriptions" | "projects" | "devices";
  /**
   * A multi-machine line (docs/devices.md): with no host to hand it over,
   * the Firstmate is told the line alone, since no button it can put on a
   * card opens what the line needs. Every line whose handover is `devices`
   * is one already.
   */
  multiMachine?: boolean;
  /**
   * A hands line whose card the host writes from the checked request, at
   * any wake (the setup card, docs/fleet.md "Asking the first mate to add a
   * project"): app_change puts it up through its delegate's `propose`, and
   * only the captain's click on it runs the line's change.
   */
  proposes?: true;
  /**
   * The card a hands line offers in place of acting, from the value the
   * Firstmate passed and the line's current value: its words and its one
   * button. Absent, the host offers a plain Open Settings card. It throws a
   * reason when the value names nothing it can offer.
   */
  offer?: (
    value: Record<string, unknown>,
    current: unknown,
    /** The system the home runs, for a line whose words name its settings. */
    here: { platform: string },
  ) => HandoverOffer;
  current: CoreInvokeChannel | null;
  value: z.ZodType;
  line: string;
  toRequest: (
    value: Record<string, unknown>,
    current: unknown,
    expandHome: (path: string) => string,
    /** The first mate's evidence, for a line whose request keeps it. */
    evidence?: string,
  ) => unknown[];
  readValue: (current: unknown) => Record<string, unknown>;
  done: (value: Record<string, unknown>) => string;
  /**
   * A setting with a scale: the words of the captain's settled run
   * (docs/orchestrator-contract.md, "Settled runs"), from the value where
   * the run started to the value where it settled, each as `readValue`
   * reads it. Absent, a run says `done` of where it settled.
   */
  settled?: (from: Record<string, unknown>, to: Record<string, unknown>) => string;
};
/**
 * The card the host files for the captain when the Firstmate asks for a
 * hands action (app_change): built by the host from typed facts, never by
 * the Firstmate, so its button does exactly what its words say.
 */
export type HandoverOffer = {
  /** Stable, so asking twice revises one card. */
  cardId: string;
  title: string;
  /** Plain text, one sentence or two each. */
  paragraphs: string[];
  /** The default button, which opens Settings on the line's section. */
  label: string;
  danger?: boolean;
  /** The button that closes the card and does nothing. */
  decline: string;
  /** What the section does on arrival (`openEffectSchema`). */
  arrival?:
    | { make: DeviceMake }
    | { remove: string }
    | { add: string }
    | { update: string }
    | { privateSite: string }
    | { signIn: string }
    | { signInOn: { deviceId: string; providerId: string } };
};

/** An integration as the catalog reads it back: its settings, without its actions' words. */
/**
 * What the captain's own sign-in click started, read from the channel it
 * called (SCR-523: a click carries no catalog value, so the line once read
 * "undefined sign-in started"). A forge's own sign-in names its server kind
 * (`github` for GitHub Enterprise) and the address the captain typed.
 */
export function integrationSignInValue(
  channel: CoreInvokeChannel,
  args: readonly unknown[],
): { kind?: IntegrationKind; host?: string } {
  if (channel === "inf:integrations:sign-in") return { kind: args[0] as IntegrationKind };
  if (channel === "inf:forges:sign-in") {
    const host = String(args[0]);
    if (host === INTEGRATIONS_SIGN_IN_HOST) return { kind: "github" };
    const kind = kindByName(host);
    return kind === "gitlab"
      ? { kind, host }
      : kind === "github"
        ? { kind: "github-enterprise", host }
        : { host };
  }
  if (channel === "inf:forges:sign-in-cli") {
    // GitHub CLI's sign-in serves GitHub hosts alone: github.com, or GitHub Enterprise.
    const host = hostOfAddress(String(args[0])) ?? undefined;
    if (host === INTEGRATIONS_SIGN_IN_HOST) return { kind: "github" };
    return { kind: "github-enterprise", ...(host ? { host } : {}) };
  }
  const input = args[0] as { kind: string; address: string };
  const host = hostOfAddress(input.address) ?? undefined;
  const kind =
    input.kind === "github" ? "github-enterprise" : input.kind === "gitlab" ? "gitlab" : undefined;
  return { ...(kind ? { kind } : {}), ...(host ? { host } : {}) };
}

function integrationsBrief(view: IntegrationsView): Record<string, unknown>[] {
  return view.integrations.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    account: row.account,
    health: row.health,
    paused: row.paused,
    actionsOff: row.actions.filter((action) => !action.enabled).map((action) => action.name),
  }));
}

/** Whether a line is a multi-machine one (`multiMachine`). */
export function isMultiMachineLine(line: Pick<ActionLine, "handover" | "multiMachine">): boolean {
  return line.handover === "devices" || line.multiMachine === true;
}
/** A card id's part from a device's or provider's id: lowercase words joined by dashes. */
function cardSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
/** The rule an automation action names by id; the refusal says why there is none. */
function automationRule(current: unknown, id: unknown): AutomationRule {
  const list = current as AutomationList;
  if (list.state === "unavailable") throw new Error(list.reason);
  const rule = list.rules.find((entry) => entry.id === id);
  if (!rule) throw new Error(`No automation ${id}. Its id is in this action's current value.`);
  return rule;
}
/** Every rule as an edit reads it, or, `brief`, by id, label and state alone. */
function automationValue(current: unknown, brief = false): Record<string, unknown> {
  const list = current as AutomationList;
  return {
    rules: list.rules.map((rule) =>
      brief
        ? { id: rule.id, label: rule.name ?? cutText(rule.prompt, 80), state: rule.state }
        : {
            id: rule.id,
            name: rule.name,
            state: rule.state,
            spec: rule.spec,
            prompt: rule.prompt,
            projectId: rule.projectId,
            nextFire: rule.nextFire,
            captainRequested: rule.captainRequested,
          },
    ),
    ...(list.state === "unavailable" ? { unavailable: list.reason } : {}),
  };
}
const automationIdSchema = z.string().trim().min(1).max(64);
function presence(field: "startAtLogin" | "showInDock", label: string): ActionLine {
  return {
    area: "general",
    tier: "asked",
    fields: [field],
    change: "inf:presence:set",
    current: "inf:presence:get",
    value: z.strictObject({ enabled: z.boolean() }),
    line: `${label} when asked.`,
    toRequest: (v, c) => [{ ...(c as object), [field]: v.enabled }],
    readValue: (c) => ({ enabled: (c as Record<string, unknown>)[field] }),
    done: (v) => `${label} ${v.enabled ? "on" : "off"}`,
  };
}
function owned(
  change: CoreInvokeChannel,
  current: CoreInvokeChannel,
  line: string,
  done: string,
): ActionLine {
  return {
    area: "general",
    tier: "yours",
    change,
    current,
    value: z.strictObject({ args: invokeContract[change].request }),
    line,
    alwaysTrail: true,
    toRequest: (v) => v.args as unknown[],
    readValue: (c) => ({ state: c }),
    done: () => done,
  };
}
function guidance(
  area: ActionLine["area"],
  tier: ActionTier,
  line: string,
  channels: CoreInvokeChannel[] = [],
  handover?: ActionLine["handover"],
  auditText = "Settings action completed",
): ActionLine {
  return {
    area,
    tier,
    line,
    channels,
    handover,
    alwaysTrail: tier === "hands",
    change: null,
    current: null,
    value: z.strictObject({}),
    toRequest: () => [],
    readValue: () => ({}),
    done: () => auditText,
  };
}
/** A direction change as app_change takes it: its evidence is the reason kept. */
const [addDirection, reviseDirection, retireDirection] = knowledgeDirectionChangeSchema.options;
const directionValueSchema = z.discriminatedUnion("op", [
  addDirection.omit({ reason: true }),
  reviseDirection.omit({ reason: true }),
  retireDirection.omit({ reason: true }),
]);
const DIRECTION_DONE = { add: "saved", revise: "revised", retire: "retired" } as const;
/**
 * The line a project's Runs on change leaves (`project-runs-on`), as a saved
 * fact: the action's `done` words, and the feed line's fact beside them.
 */
export function runsOnDoneSaid(v: Record<string, unknown>): Said {
  return runsOnSaid(
    (v.repo as RepoView).name,
    (v.where as string | null | undefined) ?? null,
    v.fromHere !== false,
    (v.repo as RepoView).runsOn === AUTOMATIC_COMPUTER,
  );
}

const actionLines = {
  "project-setup": {
    area: "projects",
    tier: "hands",
    proposes: true,
    change: "inf:repos:setup",
    current: "inf:repos:list",
    value: projectSetupProposalSchema,
    line: "Propose a project at any time - on the captain's message, a crewmate's report, or your own judgment: app_change checks it, changes nothing, and puts up the captain's setup card, where only their Add project click adds it. clone needs origin (remote URL), init needs name (new local project), adopt needs path (absolute existing folder; a plain one gets git). clone and init go in the projects folder; adopt links in place, and the card also offers a fresh clone when the folder has a remote. Pass key (2-4 letters or digits, INF for INF-1) only when the captain chose the task key; otherwise the app derives one from the name, and it refuses a key another project has. Suggest delivery, autonomy, rigor and runsOn (work computer name/id, or null) only when you know them; the card otherwise shows today's defaults. work names, in a few words, the waiting work you start once they add it. You hear once how they answered. A project already on the list gets no card and is named instead. Settings adds its own projects at once.",
    toRequest: (v, _c, expandHome) => {
      const { delivery, autonomy, rigor, runsOn, work, ...spec } = v;
      return [
        { ...spec, ...(spec.kind === "adopt" ? { path: expandHome(spec.path as string) } : {}) },
      ];
    },
    readValue: (c) => ({ projects: c as RepoView[] }),
    done: (v) => `Set up project ${(v.repo as RepoView).name}`,
  },
  "project-remove": {
    area: "projects",
    tier: "own-words",
    change: "inf:repos:remove",
    current: "inf:repos:list",
    value: z.strictObject({ repoId: z.string().min(1) }),
    line: "Remove a project from the list when the captain asks you to in their own words. Its folder, files and history are never touched, and finished tasks stay readable. Refused while tasks are still planned or working on it; the refusal names them.",
    toRequest: (v) => [v.repoId],
    readValue: (c) => ({ projects: (c as RepoView[]).map(({ id, name }) => ({ id, name })) }),
    done: (v) => `Removed project ${(v.repo as RepoView).name}`,
  },
  "project-settings": {
    area: "projects",
    tier: "asked",
    change: "inf:repos:configure",
    current: "inf:repos:list",
    value: z.strictObject({
      repoId: z.string().min(1),
      changes: repoPolicyPatchSchema,
    }),
    line: "Change costLimit (estimated dollars as {usd}, {none:true} for no limit, null to follow the app), scope (what work belongs here; null clears it), delivery, autonomy, rigor, declared computer requirements (placementRequirements: systems, chips, tools, profile; null restores defaults), name, path (an already moved folder, with no planned or working tasks), or origin (the folder’s current git address, never a git configuration write). Exact captain words apply; otherwise the app asks on its exact-change card. Origin always asks. Personal workspace settings stay fixed; keys and history stay.",
    toRequest: (v) => [v.repoId, v.changes],
    readValue: (c) => ({
      projects: (c as RepoView[]).map(
        ({
          id,
          name,
          scope,
          path,
          origin,
          host,
          kind,
          delivery,
          autonomy,
          rigor,
          costLimit,
          placementRequirements,
        }) => ({
          id,
          name,
          scope,
          path,
          origin,
          host,
          kind,
          delivery,
          autonomy,
          rigor,
          costLimit,
          placementRequirements,
        }),
      ),
    }),
    done: (v) => (v.description as string | undefined) ?? repoPolicyOutcome(v.repo as RepoView),
  },
  // Where a project's next task starts (docs/helper.md, "Runs on"): asked,
  // like the project's other settings. A task already started finishes
  // where it started.
  "project-runs-on": {
    area: "projects",
    tier: "asked",
    change: "inf:devices:runs-on",
    current: "inf:repos:list",
    value: z.strictObject({
      repoId: z.string().min(1),
      deviceId: z.string().min(1).max(64).nullable(),
    }),
    line: `Choose where a project's tasks run when asked, such as "run website on the mini": a work computer’s name or deviceId (duplicates need IDs), null for ${HERE.this}, or automatic to choose once for each new task from fresh compatible computers with room. Its next task starts there; one already running finishes where it started. While that computer is out of reach its tasks wait and never run here instead. A project kept on ${HERE.this} only, and the personal workspace, run here.`,
    toRequest: (v) => [v.repoId, v.deviceId],
    readValue: (c) => ({
      projects: (c as RepoView[]).map((repo) => ({
        id: repo.id,
        name: repo.name,
        runsOn: repo.runsOn,
        ...(runsHereOnly(repo) ? { runsHereOnly: true } : {}),
      })),
    }),
    done: (v) => englishOf(runsOnDoneSaid(v)),
  },
  // Pairing (docs/devices.md). Both stay the captain's own, on this Mac's
  // window: the Firstmate only offers a card whose button acts in Settings
  // -> Devices, app_change never reads a link back, so one cannot reach a
  // conversation, and words typed on a paired view - which reach the
  // Firstmate as the captain's - can neither add a device nor remove one.
  "device-invite": {
    area: "general",
    tier: "hands",
    handover: "devices",
    change: "inf:devices:invite",
    current: "inf:devices:list",
    value: z.strictObject({
      name: deviceNameSchema.optional(),
      how: z.enum(["link", "command", "another-user", "address"]).optional(),
      address: remoteLoginAddressSchema.optional(),
    }),
    line: `Add a device when the captain asks: app_change offers the captain one card whose button makes it in Settings → Devices. When they have not said which way, never pick one for them: first ask them on one decision card, with every way as an option - a link, a command, the ${COMPUTER.one}'s address over Remote Login, or another user on ${HERE.this} - recommending the address, with a field for it, when they can name the ${COMPUTER.one}'s address; then pass their choice. how "link" (the default): a one-use link to paste into Infinitary on a ${COMPUTER.one} they sit at. how "command": a command they run once in Terminal on a ${COMPUTER.one} with no screen, which gets Infinitary from ${HERE.this}. how "address" with the address they gave, such as sam@mini.local: ${HERE.this} sets that ${COMPUTER.one} up over Remote Login with their own SSH key. Each of those three adds a ${COMPUTER.one} that can control you from Infinitary opened there and can run the work of projects set to run on it. how "another-user": a command they run once as another macOS user on ${HERE.this}, so work runs as that user, with sign-ins of its own, and cannot control you; like every user on a ${COMPUTER.one}, that user can still read files in their home folder outside private folders such as Documents. Only the captain's click makes a link or a command, or reaches a ${COMPUTER.one}, and you never see a link or a command. Pass the ${COMPUTER.one}'s name as the captain said it.`,
    alwaysTrail: true,
    toRequest: (v) =>
      v.how === "command" || v.how === "address"
        ? [{ kind: "mac", command: "another-mac" }]
        : v.how === "another-user"
          ? [{ kind: "work", command: "another-user" }]
          : [{ kind: "mac" }],
    readValue: (c) => ({ devices: c }),
    done: () => "made a ten-minute link to add a device",
    offer: (v, _current, here) => {
      const name = typeof v.name === "string" ? v.name : null;
      if (v.how === "address") {
        if (typeof v.address !== "string")
          throw new Error('Pass the address the captain gave, such as "sam@mini.local".');
        return {
          cardId: "app-device-invite",
          title: `Add the ${COMPUTER.one} at ${v.address}`,
          paragraphs: [
            "I set it up over Remote Login, with your own SSH key. Nothing needs to be open on it.",
            `Only your click can add a ${COMPUTER.one}, so I ask first.`,
          ],
          label: "Add it",
          decline: "Not now",
          arrival: { add: v.address },
        };
      }
      if (v.how === "another-user")
        return {
          cardId: "app-device-invite",
          title: `Run work as another user on ${HERE.this}`,
          paragraphs: [
            "Its work then runs as that user, with sign-ins of its own, and cannot control your first mate.",
            anotherUserHere(here.platform).thatUserReads,
            `${anotherUserHere(here.platform).makeUser} Then make the command here, and run it once as that user.`,
          ],
          label: "Make the command",
          decline: "Not now",
          arrival: { make: "user-command" },
        };
      if (v.how === "command")
        return {
          cardId: "app-device-invite",
          title: name ? `Add your ${name} by a command` : `Add a ${COMPUTER.one} by a command`,
          paragraphs: [
            `Make the command here, then run it once in Terminal on ${name ? `your ${name}` : `that ${COMPUTER.one}`}.`,
            "It works once, for ten minutes, or thirty when it downloads Infinitary there. Only your click can make it, so I never see it.",
          ],
          label: "Make the command",
          decline: "Not now",
          arrival: { make: "command" },
        };
      return {
        cardId: "app-device-invite",
        title: name ? `Connect your ${name}` : `Connect a ${COMPUTER.one}`,
        paragraphs: [
          `Your first mate stays on ${HERE.this}. ${name ? `Your ${name}` : `Your other ${COMPUTER.one}`} will show it and can run work for it.`,
          `Make a link here, then paste it into Infinitary on ${name ? `your ${name}` : `your other ${COMPUTER.one}`}.`,
          "It works once, for ten minutes. Only your click can make it, so I never see it.",
        ],
        label: "Make a link",
        decline: "Not now",
        arrival: { make: "link" },
      };
    },
  },
  // The captain's private sites list for task browsers (docs/task-browser.md,
  // "Private sites"): the first mate only offers the app's Allow card, and
  // only the captain's click on it, or their own entry in Settings, adds one.
  "private-site-allow": {
    area: "general",
    tier: "hands",
    handover: "settings",
    change: "inf:browser:private-sites:add",
    current: "inf:browser:private-sites",
    value: z.strictObject({ site: z.string().min(1).max(2_048) }),
    line: "Offer to let task browsers on every computer reach a private site - one on an office, home or VPN network - when a crewmate's report or the captain names one: app_change puts up the app's own card, and only the captain's Allow click adds it to Settings → General → Private sites. Pass site: the name the crewmate gave (wiki.corp.example), or a suffix of two or more parts (.corp.example.com) for every name under it, never an address. A listed site opens over https or http from any page; it never reaches loopback, link-local or cloud metadata addresses, so a program that listens only inside this computer stays out of reach.",
    toRequest: (v) => [v.site],
    readValue: (c) => ({ privateSites: (c as PrivateSitesView).sites }),
    done: (v) => `allowed ${String(v.site)} for task browsers`,
    offer: (v, c) => {
      const checked = normalizePrivateSite(String(v.site));
      if (!checked.ok) throw new Error(checked.text);
      const site = checked.site;
      if ((c as PrivateSitesView | null)?.sites.includes(site))
        throw new Error(`${site} is already on the private sites list.`);
      const suffix = site.startsWith(".");
      return {
        cardId: `app-private-site-${cardSlug(site)}`,
        title: suffix
          ? `Let task browsers reach sites under ${site}?`
          : `Let task browsers reach ${site}?`,
        paragraphs: [
          suffix
            ? `Task browsers on all your computers could then open every site whose name ends in ${site}, on an office, home or VPN network, over https or http.`
            : `Task browsers on all your computers could then open ${site} on an office, home or VPN network, over https or http.`,
          "Any page a crewmate opens could reach it too, as in an ordinary browser. It never reaches a program that listens only inside this computer, or cloud metadata addresses. You can remove it in Settings → General → Private sites.",
        ],
        label: "Allow",
        decline: "Not now",
        arrival: { privateSite: site },
      };
    },
  },
  "device-remove": {
    area: "general",
    tier: "hands",
    handover: "devices",
    change: "inf:devices:remove",
    current: "inf:devices:list",
    value: z.strictObject({ deviceId: z.string().min(1) }),
    line: `Remove a device when the captain asks: app_change offers the captain one card whose button removes it in Settings → Devices. Only the captain's click removes it; it is cut off at once and needs a new link or command to join again. A computer that runs work has its tasks stopped and its unmerged work brought here first, then removes what was set up there, and its projects run on ${HERE.this}. Name it by its id from app_state.`,
    toRequest: (v) => [v.deviceId],
    readValue: (c) => ({
      devices: (c as DeviceView[]).map(({ id, kind, name }) => ({ id, kind, name })),
    }),
    done: (v) => deviceWords.removed(v.device as DeviceView),
    offer: (v, c) => {
      const device = (c as DeviceView[]).find((candidate) => candidate.id === v.deviceId);
      if (!device) throw new Error("No device with that id is on the list. Look with app_state.");
      const label = deviceWords.label(device);
      return {
        cardId: `app-device-remove-${cardSlug(device.id)}`,
        title: `Remove ${label}?`,
        paragraphs: deviceRunsWork(device.kind)
          ? [
              deviceWords.removeStops(device),
              "Then I remove what I set up there, with its sign-ins. Only your click can remove it.",
            ]
          : [
              "It is cut off at once.",
              `To come back, it needs a new link. Only your click can remove a ${COMPUTER.one}.`,
            ],
        label: `Remove ${label}`,
        danger: true,
        decline: "Keep it",
        arrival: { remove: device.id },
      };
    },
  },
  // A computer that runs work signs in to its own subscriptions
  // (docs/helper.md, "Its own sign-ins"). The Firstmate only offers the
  // captain's card; the sign-in starts on his click in Settings ->
  // Intelligence, and what he types there never reaches a conversation.
  // Updating Firstmate on a computer that runs work (docs/devices.md,
  // "Updating"): the captain's own click, over his own SSH for a Mac added
  // by its address, otherwise over the connection; one too old to update
  // from here gets the command to run there instead. Like adding one, it
  // runs through no catalog channel, so its minutes never hold another
  // Settings change in line, and the feed says each step itself.
  "device-update": {
    area: "general",
    tier: "hands",
    handover: "devices",
    change: null,
    current: "inf:devices:list",
    value: z.strictObject({ deviceId: z.string().min(1) }),
    line: `Update Infinitary on a computer that runs work when the captain asks: app_change offers them one card whose button brings it to ${HERE.this}'s version - over Remote Login for a ${COMPUTER.one} added by its address, otherwise over the network - or, for one too old to update from here, makes the command to run there once. Its running work stops for a moment and goes on after. A computer in reach on another version says so as otherVersion in app_state; the app raises the same card for an older one itself, so offering it then finds that card standing. Name it by its id from app_state.`,
    toRequest: () => [],
    readValue: (c) => ({
      devices: (c as DeviceView[]).map(
        ({ id, kind, name, remoteLogin, inReach, otherVersion }) => ({
          id,
          kind,
          name,
          ...(remoteLogin ? { remoteLogin } : {}),
          ...(deviceRunsWork(kind) ? { inReach: Boolean(inReach || otherVersion) } : {}),
          ...(otherVersion ? { otherVersion } : {}),
        }),
      ),
    }),
    done: () => "offered to update Infinitary on a computer",
    offer: (v, c) => {
      const device = (c as DeviceView[]).find((candidate) => candidate.id === v.deviceId);
      if (!device) throw new Error("No device with that id is on the list. Look with app_state.");
      const label = deviceWords.label(device);
      if (!deviceRunsWork(device.kind))
        throw new Error(`${label} controls the first mate, and runs no work to update.`);
      const cardId = `app-device-update-${cardSlug(device.id)}`;
      const title = `Update Infinitary on ${label}`;
      const stops =
        "Its running work stops for a moment and goes on after. Only your click can update it.";
      if (device.remoteLogin)
        return {
          cardId,
          title,
          paragraphs: [
            device.onThisMac
              ? remoteLoginWords.updateLocalCopyOffer()
              : device.system === "linux"
                ? `I copy ${HERE.this}'s Infinitary there over Remote Login, with your own SSH key, and start it again.`
                : remoteLoginWords.updateDownloadOffer(),
            stops,
          ],
          label: "Update it",
          decline: "Not now",
          arrival: { update: device.id },
        };
      const other = device.otherVersion;
      if (!other) {
        if (device.inReach)
          throw new Error(`${label} already runs ${HERE.this}'s version of Infinitary.`);
        throw new Error(
          `${label} is out of reach, so ${HERE.this} cannot tell its version or update it now. Ask again once it is back.`,
        );
      }
      const hereAsUser = device.onThisMac === true && device.user !== undefined;
      if (other.updateBy === "command")
        return {
          cardId,
          title,
          paragraphs: [
            "Its version of Infinitary is too old to update from here, so it needs a new command.",
            hereAsUser
              ? `Make the command here, then run it once in Terminal as ${userDisplayName(device.user as string)}.`
              : `Make the command here, then run it once in Terminal on ${label}.`,
          ],
          label: "Make the command",
          decline: "Not now",
          arrival: { make: hereAsUser ? "user-command" : "command" },
        };
      return {
        cardId,
        title,
        paragraphs: [
          hereAsUser
            ? `I start it again on ${HERE.this}'s own Infinitary.`
            : other.downloads
              ? remoteLoginWords.updateConnectionDownloadOffer()
              : `I send ${HERE.this}'s Infinitary to it over your network, and it starts again.`,
          stops,
        ],
        label: "Update it",
        decline: "Not now",
        arrival: { update: device.id },
      };
    },
  },
  "device-sign-in": {
    area: "intelligence",
    tier: "hands",
    handover: "subscriptions",
    multiMachine: true,
    change: null,
    current: "inf:devices:sign-ins",
    value: z.strictObject({
      deviceId: z.string().min(1).max(64),
      provider: z.string().min(1).max(256),
    }),
    line: `Sign a computer that runs work in to one of its own subscriptions when the captain asks: app_change offers the captain one card whose button opens Settings → Intelligence with that sign-in started there. Name the computer by its deviceId and the subscription by its provider id from app_state. Nothing from ${HERE.this}'s sign-ins goes there, and you never see what the captain types.`,
    alwaysTrail: true,
    toRequest: () => [],
    readValue: (c) => ({
      computers: (c as DeviceSignIns[]).map((device) => ({
        deviceId: device.deviceId,
        name: signInPlace(device).label,
        reach: device.reach,
        providers: device.signIns?.providers.map((provider) => provider.id) ?? [],
        signedIn:
          device.signIns?.accounts.map((account) => ({
            provider: account.providerId,
            label: account.label,
          })) ?? [],
      })),
    }),
    done: () => "offered a sign-in on a computer that runs work",
    offer: (v, c) => {
      const device = (c as DeviceSignIns[]).find((candidate) => candidate.deviceId === v.deviceId);
      if (!device)
        throw new Error("No computer that runs work has that deviceId. Look with app_state.");
      const provider = catalogEntry(v.provider as string);
      if (!provider) throw new Error("No subscription has that provider id. Look with app_state.");
      const place = signInPlace(device);
      return {
        cardId: `app-device-sign-in-${cardSlug(device.deviceId)}-${cardSlug(provider.id)}`,
        title: `Sign in to ${provider.name} ${place.where}`,
        paragraphs: [
          `${place.who} signs in to ${provider.name} with a sign-in of its own. Nothing from ${HERE.this}'s sign-in goes there.`,
          `Sign in opens Settings, where it starts under ${place.label}.`,
        ],
        label: "Sign in",
        decline: "Not now",
        arrival: { signInOn: { deviceId: device.deviceId, providerId: provider.id } },
      };
    },
  },
  "device-address": guidance(
    "general",
    "hands",
    `A link carries every address ${HERE.this} has. There is nothing to choose in Settings → Devices.`,
    ["inf:devices:address:set"],
    "devices",
    `changed where devices find ${HERE.this}`,
  ),
  theme: {
    fields: ["theme"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({ theme: themeSchema }),
    line: "Switch between dark and light when asked, preserving size, window wash and crew model names.",
    toRequest: (v, c) => [{ ...(c as Appearance), theme: v.theme }],
    readValue: (c) => ({ theme: (c as Appearance).theme }),
    done: (v) => `switched to the ${v.theme} theme`,
  },
  font: {
    fields: ["fonts"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({ slot: z.enum(FONT_SLOTS), font: fontFamilySchema.nullable() }),
    line: "Set the font of one place when asked: app (the window's words), reading (what the crew writes on cards) or code. font is a family installed on the captain's computer by its exact name, system-ui (ui-monospace for code) for the computer's own font, or null for Infinitary's own. Reading follows the app font while it is null. Settings → Appearance lists the installed fonts.",
    toRequest: (v, c) => {
      const slot = v.slot as FontSlot;
      const font = v.font as string | null;
      const { [slot]: _was, ...others } = (c as Appearance).fonts ?? {};
      const fonts = font ? { ...others, [slot]: font } : others;
      const { fonts: _saved, ...look } = c as Appearance;
      return [{ ...look, ...(Object.keys(fonts).length > 0 ? { fonts } : {}) }];
    },
    readValue: (c) => ({ fonts: (c as Appearance).fonts ?? {} }),
    // A line is written from the fonts as `readValue` reads them, whoever chose.
    done: (v) => {
      const fonts = (v.fonts ?? {}) as FontChoices;
      const chosen = FONT_SLOTS.filter((slot) => fonts[slot]);
      return chosen.length === 0
        ? "set every font to Infinitary's own"
        : `set the fonts: ${chosen.map((slot) => `${slot} ${fonts[slot]}`).join(", ")}`;
    },
    settled: (from, to) => {
      const was = (from.fonts ?? {}) as FontChoices;
      const now = (to.fonts ?? {}) as FontChoices;
      const named = (font: string | undefined) => font ?? "Infinitary's own";
      const moved = FONT_SLOTS.filter((slot) => was[slot] !== now[slot]);
      return moved.length === 0
        ? "kept the fonts"
        : moved.map((slot) => `${slot} font ${named(was[slot])} → ${named(now[slot])}`).join(", ");
    },
  },
  panel: {
    fields: ["hiddenPanels", "arrangement"],
    area: "panels",
    tier: "asked",
    change: "inf:settings:layout:set",
    current: "inf:settings:layout:get",
    value: z
      .strictObject({
        surface: z.string().trim().min(1).max(64),
        rail: z.enum(["left", "right"]).optional(),
        position: z.enum(["top", "bottom"]).optional(),
        above: z.string().trim().min(1).max(64).optional(),
        below: z.string().trim().min(1).max(64).optional(),
        visible: z.boolean().optional(),
      })
      .refine(
        (v) =>
          v.rail !== undefined ||
          v.position !== undefined ||
          v.above !== undefined ||
          v.below !== undefined ||
          v.visible !== undefined,
        { message: "panel needs rail, position, above, below, or visible" },
      )
      .refine((v) => v.above === undefined || v.below === undefined, {
        message: "panel takes above or below, not both",
      })
      .refine(
        (v) =>
          (v.above === undefined && v.below === undefined) ||
          (v.rail === undefined && v.position === undefined),
        { message: "above or below already names the rail and position; leave those out" },
      ),
    line: "Move, hide or show one panel by its surface id when asked. rail and position move it to that slot's middle; above or below put it just above or below another panel. Removal stays in personalize.",
    // actionRequest resolves the surface, the panel it goes next to and
    // every surface before adapting (INF-2344: one saved arrangement).
    toRequest: (v, c) => {
      type Surface = {
        id: string;
        placement: { x: "left" | "right"; y: "top" | "bottom" };
        preferred: { x: "left" | "right"; y: "top" | "bottom" };
        declaredOrder: number;
        place?: number;
      };
      const { layout, surface, neighbour, surfaces } = c as {
        layout: Layout;
        surface: Surface;
        neighbour?: Surface;
        surfaces: Surface[];
      };
      const next = { ...layout, hiddenPanels: { ...layout.hiddenPanels } };
      const moves = v.rail !== undefined || v.position !== undefined || neighbour !== undefined;
      // The create-your-own-panel slot is the only surface with no place.
      if (moves && surface.place === undefined)
        throw new Error(
          `${surface.id} always sits at the top of the left rail; it can only be hidden or shown.`,
        );
      if (neighbour && neighbour.place === undefined)
        throw new Error(`${neighbour.id} is not a panel to move next to; name a panel.`);
      if (moves) {
        const arrangement = arrangePanels(
          layout,
          surfaces
            .filter((each) => each.place !== undefined)
            .map((each) => ({ id: each.id, preferred: each.preferred, order: each.declaredOrder })),
        );
        const target = neighbour
          ? neighbour.placement
          : { x: v.rail ?? surface.placement.x, y: v.position ?? surface.placement.y };
        const sameSlot =
          target.x === surface.placement.x && target.y === surface.placement.y && !neighbour;
        next.arrangement = sameSlot
          ? arrangement
          : movePanel(arrangement, surface.id, {
              slot: target as { x: "left" | "right"; y: "top" | "bottom" },
              ...(neighbour && v.above !== undefined ? { above: neighbour.id } : {}),
              ...(neighbour && v.below !== undefined ? { below: neighbour.id } : {}),
            });
      }
      if (v.visible === true) delete next.hiddenPanels[surface.id];
      else if (v.visible === false) next.hiddenPanels[surface.id] = true;
      return [next];
    },
    readValue: (c) => ({
      hiddenPanels: (c as Layout).hiddenPanels,
      arrangement: (c as Layout).arrangement ?? null,
    }),
    done: (v) => `${v.surface} ${v.description}`,
  },
  "voice-model": {
    ...owned(
      "inf:voice:ensure-model",
      "inf:voice:status",
      "Download the local voice model when asked; audio stays on this machine.",
      "voice model ready",
    ),
    tier: "asked",
    alwaysTrail: false,
    value: z.strictObject({}),
    toRequest: () => [],
    readValue: (c) => ({ ready: (c as { modelReady: boolean }).modelReady }),
  },
  "account-sign-in": guidance(
    "intelligence",
    "hands",
    "Add or sign in again to an account in Settings → Intelligence.",
    ["inf:accounts:add", "inf:accounts:sign-in"],
    "subscriptions",
    "account sign-in requested",
  ),
  "custom-connection": guidance(
    "intelligence",
    "hands",
    "Enter a custom connection in Settings → Intelligence.",
    ["inf:accounts:custom:save"],
    "subscriptions",
    "custom connection saved",
  ),
  "decision-key": guidance(
    "intelligence",
    "hands",
    "Enter or remove a decision key in Settings → Intelligence.",
    ["inf:decisions:key:set", "inf:decisions:key:remove"],
    "subscriptions",
    "decision key changed",
  ),
  "panel-remove": guidance(
    "panels",
    "own-words",
    "Use personalize to remove a panel, only on the captain's own words.",
  ),
  "task-actions": guidance(
    "general",
    "asked",
    "Use update_task, interrupt_crewmate or steer_crewmate for task start, stop, continue and drop, and move_task to move started work to another computer.",
    ["inf:task:abort", "inf:task:delete", "inf:task:run", "inf:task:move"],
  ),
  settle: guidance(
    "general",
    "asked",
    "Use settle_task for merge or discard; an ask-first merge still needs the captain's click.",
    ["inf:task:close-done"],
  ),
  "card-close": guidance(
    "general",
    "yours",
    "Closing someone else's card stays yours on that card.",
  ),
  "plugin-consent": guidance("panels", "yours", "Panel consent stays yours on its consent card."),
  recovery: guidance("general", "yours", "Recovery buttons stay yours on the recovery card."),
  "ask-first-merge": guidance(
    "projects",
    "yours",
    "An ask-first project's merge stays yours on its merge card.",
  ),
  "show-card": {
    area: "general",
    tier: "asked",
    change: "inf:cards:show",
    current: "inf:app:healthcheck",
    value: z.strictObject({ cardId: z.string().trim().min(1).max(128) }),
    line: "Bring a card forward when the captain asks to show or revisit it. A minimized open card returns to the stack; a closed card is read-only. Read cardId from open cards or resolution.card.id in tasks by key. It makes no new card and runs nothing. Never minimize a card yourself.",
    alwaysTrail: true,
    toRequest: (v) => [v.cardId],
    readValue: () => ({}),
    done: (v) => `showed the earlier card "${v.title}"`,
  },
  "show-whats-new": {
    area: "general",
    tier: "asked",
    change: "inf:release-notes:show",
    current: "inf:release-notes:list",
    value: z.strictObject({ version: z.string().trim().min(1).max(64).optional() }),
    line: "Bring a release note forward on the captain's stage when asked what is new or to read the notes again: the newest that listed changes, or the one for a version in current. An open note comes to the front, a closed one comes back read-only. It makes no new card.",
    alwaysTrail: true,
    toRequest: (v) => [v.version ?? null],
    readValue: (c) => ({
      notes: (c as ReleaseNotesView).notes.map(({ version, listed }) => ({ version, listed })),
    }),
    done: (v) => `showed the release note for ${v.version}`,
  },
  direction: {
    area: "general",
    tier: "judgment",
    alwaysTrail: true,
    change: "inf:knowledge:direction:set",
    current: "inf:knowledge:directions",
    value: directionValueSchema,
    line: "Add, revise or retire one of the captain's standing directions on your own judgment of what they want, whatever began the turn: their words, their choice on any card, a click. evidence is the reason its history keeps. add takes text and scope (captain: no crewmate reads it; or a project id); revise takes id and text; retire takes id; expectedRevision is optional.",
    toRequest: (v, _current, _expandHome, evidence) => [{ ...v, reason: evidence }],
    readValue: (current) => {
      const read = current as KnowledgeDirections;
      return read.state === "ready"
        ? {
            directions: read.rows.map((row) => ({
              id: `d:${row.id}`,
              scope: row.scope,
              project: row.scopeName,
              revision: row.revision,
              text: row.text,
            })),
            total: read.total,
          }
        : { unavailable: read.reason };
    },
    done: (v) => {
      const text = String(v.text);
      return `${DIRECTION_DONE[v.op as keyof typeof DIRECTION_DONE]} the standing direction "${text.length > 120 ? `${cutText(text, 119)}…` : text}"`;
    },
  },
  "start-at-login": presence("startAtLogin", "start at login"),
  "show-in-dock": presence("showInDock", "show in dock"),
  "release-page": {
    ...owned(
      "inf:update:open-release",
      "inf:update:status",
      "Open the release page when asked.",
      "release page opened",
    ),
    tier: "asked",
    value: z.strictObject({}),
    toRequest: () => [],
  },
  // Integrations (docs/integrations.md): Settings -> Integrations and
  // app_change write through these lines alike. A sign-in is always the
  // captain's hands; removal forgets one only on his own words.
  "integration-add": {
    area: "integrations",
    tier: "hands",
    handover: "projects",
    change: null,
    current: "inf:integrations:list",
    channels: [
      "inf:integrations:sign-in",
      "inf:forges:sign-in",
      "inf:forges:sign-in-key",
      "inf:forges:sign-in-browser",
      "inf:forges:sign-in-cli",
    ],
    // An MCP server is added from a form; a stand-in is a test run's own, never connected by hand.
    value: z.strictObject({
      kind: integrationKindSchema.exclude(["mcp", "stand-in"]),
      host: z.string().regex(FORGE_HOST_NAME).optional(),
    }),
    line: "Connect an integration (kind: github, gitlab, github-enterprise, or google for Gmail and Calendar; optional host for a server) when asked: app_change puts up the captain's card, and their click opens Settings → Integrations with the sign-in started. A sign-in is always their hands.",
    alwaysTrail: true,
    offer: (v, current) => {
      const kind = v.kind as keyof typeof INTEGRATION_KIND_NAMES;
      const name = INTEGRATION_KIND_NAMES[kind];
      const view = current as IntegrationsView;
      if (v.host && kind !== "gitlab" && kind !== "github-enterprise")
        throw new Error("A host is used only for GitLab or GitHub Enterprise.");
      if (
        !v.host &&
        kind !== "gitlab" &&
        kind !== "github-enterprise" &&
        view.integrations.some((row) => row.kind === kind)
      )
        throw new Error(`${name} is already connected; integrations lists it.`);
      if (!view.addable.some((entry) => entry.kind === kind))
        throw new Error(`${name} cannot be signed in to in this version of the app.`);
      return {
        cardId: `app-integration-add-${kind}`,
        title: `Connect ${name}`,
        paragraphs: [
          `Your first mate and your crew can then reach ${name} with your sign-in: reads run, and every change asks you on a card first.`,
          `Open Integrations to sign in to ${name}.`,
        ],
        label: "Open Integrations",
        decline: "Not now",
        // GitHub's sign-in is the forge's, by its host; any other kind signs in by its kind.
        arrival: {
          signIn: v.host
            ? `${kind}:${v.host}`
            : kind === "github"
              ? INTEGRATIONS_SIGN_IN_HOST
              : kind,
        },
      };
    },
    toRequest: () => [],
    readValue: (c) => ({ integrations: integrationsBrief(c as IntegrationsView) }),
    done: (v) => {
      const name = v.kind ? INTEGRATION_KIND_NAMES[v.kind as IntegrationKind] : null;
      const host = typeof v.host === "string" ? v.host : null;
      if (name && host) return `${name} sign-in started for ${host}`;
      return `${name ?? host ?? "Integration"} sign-in started`;
    },
  },
  "integration-add-mcp": {
    area: "integrations",
    tier: "asked",
    change: "inf:integrations:add",
    current: "inf:integrations:list",
    value: integrationMcpAddSchema,
    line: "Add an MCP server when asked: name is the captain's word for it, runs is what it runs as they gave it - a program and its arguments (npx -y @scope/server), or its https address. The app connects, keeps the server's tools as actions (each asks them until they choose Always allow) and answers the row; a server that cannot connect is refused with why. Never put a key or token in runs.",
    toRequest: (v) => [v],
    readValue: (c) => ({ integrations: integrationsBrief(c as IntegrationsView) }),
    done: (v) => `Added MCP server ${v.name}`,
  },
  "integration-remove": {
    area: "integrations",
    tier: "own-words",
    change: "inf:integrations:remove",
    current: "inf:integrations:list",
    value: z.strictObject({ id: integrationIdSchema }),
    line: "Remove an integration and forget its sign-in only on the captain's typed words. For GitHub it signs the app out of GitHub, so private clones and pull requests stop until they sign in again; an MCP server's program stops and its row goes.",
    toRequest: (v) => [v.id],
    readValue: (c) => ({ integrations: integrationsBrief(c as IntegrationsView) }),
    done: (v) => `Removed integration ${v.id}`,
  },
  "delete-outside": {
    area: "general",
    tier: "own-words",
    change: "inf:retention:delete-outside",
    current: "inf:retention:scope",
    value: z.strictObject({}),
    line: "Delete the Gmail and Calendar content saved in every conversation on this computer only on the captain's typed words: a note takes its place and every other word stays, and a conversation still working is cleaned once it pauses. It also goes on its own once past its days.",
    alwaysTrail: true,
    toRequest: () => [],
    readValue: (c) => ({ kept: (c as { kept?: unknown }).kept ?? [] }),
    done: () => "Deleted Gmail and Calendar content",
  },
  "integration-settings": {
    area: "integrations",
    tier: "asked",
    change: "inf:integrations:configure",
    current: "inf:integrations:list",
    value: z.strictObject({ id: integrationIdSchema, changes: integrationSettingsPatchSchema }),
    line: "Change an integration when asked: rename it (name; null restores its kind's name), pause or resume it (paused), or turn actions on or off by name (actions: { read: false }). A paused integration and an action turned off answer nobody.",
    toRequest: (v) => [v.id, v.changes],
    readValue: (c) => ({ integrations: integrationsBrief(c as IntegrationsView) }),
    done: (v) => `Changed integration ${v.id}`,
  },
  "integration-action-rule": {
    area: "integrations",
    tier: "yours",
    change: "inf:integrations:rule",
    current: "inf:integrations:list",
    value: z.strictObject({
      id: integrationIdSchema,
      action: integrationActionNameSchema,
      allowed: z.boolean(),
    }),
    line: "Only the captain changes action allowances, in Settings or on approval cards.",
    toRequest: (v) => [v.id, v.action, v.allowed],
    readValue: (c) => ({ integrations: (c as IntegrationsView).integrations }),
    done: (v) => `Changed approval for ${v.id}'s ${v.action}`,
  },
  "integration-key": guidance(
    "integrations",
    "hands",
    "The captain enters or removes an integration's key in Settings → Integrations, never in a message, a card or a task; integrations shows only whether each is kept.",
    ["inf:integrations:secret"],
    "settings",
    "integration key changed",
  ),
  "integration-check": {
    area: "integrations",
    tier: "asked",
    change: "inf:integrations:check",
    current: "inf:integrations:list",
    value: z.strictObject({ id: integrationIdSchema }),
    line: "Check an integration's connection now when asked; its row and integrations read the same answer.",
    toRequest: (v) => [v.id],
    readValue: (c) => ({ integrations: integrationsBrief(c as IntegrationsView) }),
    done: (v) => `Checked integration ${v.id}`,
  },
  "forge-sign-out": {
    area: "projects",
    tier: "own-words",
    change: "inf:forges:sign-out",
    current: "inf:forges:list",
    value: z.strictObject({ host: z.string().trim().toLowerCase().min(1).max(253) }),
    line: "Sign out of one project host the app is signed in to (github.com, a GitHub Enterprise or GitLab host) only on the captain's typed words.",
    toRequest: (v, c) => {
      if (!(c as ForgesView).signIns.some((signIn) => signIn.host === v.host))
        throw new Error(
          `No sign-in to ${v.host}. Signed in: ${(c as ForgesView).signIns.map((signIn) => signIn.host).join(", ") || "none"}.`,
        );
      return [v.host];
    },
    readValue: (c) => ({ hosts: c }),
    done: (v) => (v.host === "github.com" ? "GitHub signed out" : `${v.host} signed out`),
  },
  diagnostics: {
    fields: ["diagnostics"],
    ...owned(
      "inf:settings:sharing:set",
      "inf:settings:sharing:get",
      "Diagnostics stays yours: Settings → General, beside the preview.",
      "diagnostics changed",
    ),
    alwaysTrail: false,
    readValue: (c) => ({
      enabled: (c as { diagnostics: { enabled: boolean } }).diagnostics.enabled,
    }),
    done: (v) => `diagnostics ${v.enabled ? "on" : "off"}`,
  },
  contribution: {
    fields: ["contribution"],
    ...owned(
      "inf:settings:sharing:set",
      "inf:settings:sharing:get",
      "Contribution stays yours; unavailable until its terms are published.",
      "contribution changed",
    ),
    alwaysTrail: false,
    readValue: (c) => ({
      enabled: (c as { contribution: { enabled: boolean } }).contribution.enabled,
    }),
    done: (v) => `contribution ${v.enabled ? "on" : "off"}`,
  },
  "sharing-ask": owned(
    "inf:settings:sharing:ask",
    "inf:settings:sharing:get",
    "Answering the sharing ask stays yours in Settings → General.",
    "sharing ask answered",
  ),
  purge: owned(
    "inf:retention:purge",
    "inf:app:healthcheck",
    "Purge stays yours in Settings → General; it erases this conversation.",
    "task data purged",
  ),
  "panels-switch": {
    ...owned(
      "inf:settings:panels:set",
      "inf:shell:preferences",
      "The panels switch stays yours in Settings → General.",
      "panels switch changed",
    ),
    alwaysTrail: false,
    readValue: (c) => ({
      enabled: (c as { panels: { enabled: boolean } }).panels.enabled,
    }),
    done: (v) => `panels ${v.enabled ? "on" : "off"}`,
  },
  dictation: {
    ...owned(
      "inf:settings:dictation:set",
      "inf:settings:dictation:get",
      "Dictation choices stay yours in Settings → General.",
      "dictation changed",
    ),
    alwaysTrail: false,
    readValue: (c) => c as Record<string, unknown>,
    done: (v) => `dictation ${v.enabled ? "on" : "off"}, ${v.key}`,
  },
  "firstmate-model": {
    area: "intelligence",
    tier: "asked",
    change: "inf:settings:firstmate-model:set",
    current: "inf:settings:firstmate-model:get",
    value: z.strictObject({
      model: z.strictObject({ provider: z.string().min(1), id: z.string().min(1) }).nullable(),
    }),
    line: "Choose the first mate's model; null restores Auto. Applies after this answer, never mid-turn.",
    toRequest: (v) => [v.model],
    readValue: (c) => ({ model: c }),
    done: (v) =>
      `First mate model ${v.model ? `${(v.model as { provider: string; id: string }).provider}/${(v.model as { id: string }).id}` : "Auto"}`,
  },
  "firstmate-account": {
    area: "intelligence",
    tier: "asked",
    change: "inf:settings:firstmate-account:set",
    current: "inf:settings:firstmate-account:get",
    value: z.strictObject({ accountId: z.string().min(1).nullable() }),
    line: "Choose which account of its model's provider the first mate answers on, by id; null lets the app pick by allowance when it next binds. Applies after this answer, never mid-turn. Crew work's preferred account is account-prefer.",
    toRequest: (v) => [v.accountId],
    readValue: (c) => ({ accountId: c }),
    done: (v) => `First mate account ${(v.label as string | null | undefined) ?? "Auto"}`,
  },
  "crew-slots": {
    area: "intelligence",
    tier: "asked",
    change: "inf:models:slots:set",
    current: "inf:models:slots",
    value: z.strictObject({
      key: z.string().regex(/^[^/]+\/.+$/),
      slot: slotSchema,
      on: z.boolean(),
    }),
    line: "Add or remove one provider/model offering from a crew slot.",
    toRequest: (v) => [v.key, v.slot, v.on],
    readValue: (c) => ({ slots: c }),
    done: (v) => `${v.key} ${v.on ? "added to" : "removed from"} ${v.slot}`,
  },
  "crew-speed": {
    area: "intelligence",
    tier: "asked",
    change: "inf:models:speed:set",
    current: "inf:models:slots",
    value: z.strictObject({ key: z.string().regex(/^[^/]+\/.+$/), speed: crewSpeedSchema }),
    line: "Set one Codex model’s crew speed across supporting accounts. Ultrafast uses 8× plan allowance or 6× purchased credits; Standard is the default. The first mate and Decisions stay Standard.",
    toRequest: (v) => [v.key, v.speed],
    readValue: (c) => ({ slots: c }),
    done: (v) => `${v.key}: ${SPEED_NAMES[crewSpeedSchema.parse(v.speed)]}`,
  },
  "crew-reasoning": {
    area: "intelligence",
    tier: "asked",
    change: "inf:models:reasoning:set",
    current: "inf:models:slots",
    value: z.strictObject({
      key: z.string().regex(/^[^/]+\/.+$/),
      slot: slotSchema,
      level: reasoningChoiceSchema.nullable(),
    }),
    line: "Set reasoning for one provider/model offering at one intelligence level; null uses the level default.",
    toRequest: (v) => [v.key, v.slot, v.level],
    readValue: (c) => ({ slots: c }),
    done: (v) =>
      `${v.key} at ${v.slot}: ${v.level === null ? "Use level default" : reasoningWord({ level: reasoningChoiceSchema.parse(v.level) })}`,
  },
  "crew-slots-reset": {
    area: "intelligence",
    tier: "asked",
    change: "inf:models:slots:reset",
    current: "inf:models:slots",
    value: z.strictObject({ provider: z.string().min(1).optional() }),
    line: "Reset crew slots to starters for one provider, or all providers when omitted.",
    toRequest: (v) => (v.provider ? [v.provider] : []),
    readValue: (c) => ({ slots: c }),
    done: (v) => `crew slots reset for ${v.provider ?? "all providers"}`,
  },
  "model-pins": {
    fields: ["pins"],
    area: "intelligence",
    tier: "asked",
    change: "inf:settings:routing:set",
    current: "inf:settings:routing:get",
    value: z.strictObject({
      pins: z.array(z.strictObject({ provider: z.string().min(1), id: z.string().min(1) })),
    }),
    line: "Replace model pins without changing dynamic routing.",
    toRequest: (v, c) => [{ ...(c as RoutingSettings), pins: v.pins }],
    readValue: (c) => ({ pins: (c as RoutingSettings).pins }),
    done: (v) =>
      `model pins ${(v.pins as { provider: string; id: string }[]).map((p) => `${p.provider}/${p.id}`).join(", ") || "cleared"}`,
  },
  routing: {
    fields: ["dynamicRouting"],
    area: "intelligence",
    tier: "asked",
    change: "inf:settings:routing:set",
    current: "inf:settings:routing:get",
    value: z.strictObject({ enabled: z.boolean() }),
    line: "Turn dynamic routing on or off without changing model pins.",
    toRequest: (v, c) => [{ ...(c as RoutingSettings), dynamicRouting: v.enabled }],
    readValue: (c) => ({ enabled: (c as RoutingSettings).dynamicRouting }),
    done: (v) => `dynamic routing ${v.enabled ? "on" : "off"}`,
  },
  "decision-model": {
    fields: ["answerer"],
    area: "intelligence",
    tier: "asked",
    change: "inf:settings:decisions:set",
    current: "inf:settings:decisions",
    value: z.strictObject({ answerer: decisionAnswererSchema }),
    line: "Choose the decision model. Existing outbound consent is preserved; keys and consent stay in Settings.",
    toRequest: (v, c) => [{ ...(c as DecisionsView).settings, answerer: v.answerer }],
    readValue: (c) => ({ answerer: (c as DecisionsView).settings.answerer }),
    done: (v) => {
      const answerer = v.answerer as DecisionAnswerer;
      return `decision model ${answerer.kind === "native" ? answerer.id : answerer.kind === "openrouter" ? `OpenRouter · ${answerer.model}` : answerer.offering === "auto" ? "Auto" : answerer.offering}`;
    },
  },
  "refresh-usage": {
    area: "intelligence",
    tier: "asked",
    change: "inf:quota:refresh",
    current: "inf:quota:snapshot",
    value: z.strictObject({}),
    line: "Refresh subscription usage when asked; unknown remains unknown.",
    toRequest: () => [],
    readValue: (c) => ({ usage: c }),
    done: () => "usage refreshed",
  },
  "account-rename": {
    area: "intelligence",
    tier: "asked",
    change: "inf:accounts:rename",
    current: "inf:accounts:list",
    value: z.strictObject({
      accountId: z.string().min(1),
      label: z.string().trim().min(1).max(64),
    }),
    line: "Rename an account by id.",
    toRequest: (v) => [v.accountId, v.label],
    readValue: (c) => ({
      accounts: (c as AccountView[]).map((a) => ({ id: a.id, label: a.label })),
    }),
    done: (v) => `account ${v.accountId} renamed ${v.label}`,
  },
  "account-pause": {
    area: "intelligence",
    tier: "asked",
    change: "inf:accounts:set-enabled",
    current: "inf:accounts:list",
    value: z.strictObject({ accountId: z.string().min(1), paused: z.boolean() }),
    line: "Pause or resume an account by id; keeps its sign-in.",
    toRequest: (v) => [v.accountId, !v.paused],
    readValue: (c) => ({
      accounts: (c as AccountView[]).map((a) => ({ id: a.id, paused: !a.enabled })),
    }),
    done: (v) => `account ${v.accountId} ${v.paused ? "paused" : "resumed"}`,
  },
  "account-prefer": {
    area: "intelligence",
    tier: "asked",
    change: "inf:accounts:pin",
    current: "inf:accounts:list",
    value: z.strictObject({ provider: z.string().min(1), accountId: z.string().min(1).nullable() }),
    line: "Prefer an account of a provider for crew work; null clears the preference. The first mate's own account is firstmate-account.",
    toRequest: (v) => [v.provider, v.accountId],
    readValue: (c) => ({
      accounts: (c as AccountView[]).map((a) => ({
        id: a.id,
        provider: a.providerId,
        preferred: a.pinned,
      })),
    }),
    done: (v) => `preferred account for ${v.provider}: ${v.accountId ?? "Auto"}`,
  },
  "account-keep-going": {
    area: "intelligence",
    tier: "own-words",
    change: "inf:accounts:keep-going",
    current: "inf:accounts:list",
    value: z.strictObject({ accountId: z.string().min(1), on: z.boolean() }),
    line: "Turn an account's Keep going on credits on or off by id, only on typed captain words: once its allowance is spent it keeps serving on credits set up with its provider, after every included allowance. Claude and Codex only.",
    toRequest: (v) => [v.accountId, v.on],
    readValue: (c) => ({
      accounts: (c as AccountView[]).map((a) => ({
        id: a.id,
        provider: a.providerId,
        keepGoingOnCredits: a.keepGoingOnCredits === true,
      })),
    }),
    done: (v) => `account ${v.accountId} ${v.on ? "keeps going" : "stops"} on credits`,
  },
  "account-disconnect": {
    area: "intelligence",
    tier: "own-words",
    change: "inf:accounts:remove",
    current: "inf:accounts:list",
    value: z.strictObject({ accountId: z.string().min(1) }),
    line: "Disconnect an account only on typed captain words. Cannot disconnect the account running the first mate.",
    toRequest: (v) => [v.accountId],
    readValue: (c) => ({ accounts: (c as AccountView[]).map((a) => ({ id: a.id })) }),
    done: (v) => `account ${v.accountId} disconnected`,
  },
  "projects-folder": {
    area: "projects",
    tier: "own-words",
    change: "inf:repos:folder:set",
    current: "inf:repos:folder",
    value: z.strictObject({ path: z.string().trim().min(1).nullable() }),
    line: "Where new projects go; null restores the default. Only on the captain's own words. Existing projects stay put; a missing folder is refused.",
    toRequest: (v, _current, expandHome) => [v.path === null ? null : expandHome(v.path as string)],
    readValue: (current) => ({ path: (current as { path: string }).path }),
    done: (v) => `new projects now go in ${v.path}`,
  },
  "project-queue-answer": {
    area: "projects",
    tier: "own-words",
    change: "inf:repos:queue-answer",
    current: "inf:repos:list",
    value: z.strictObject({ repoId: z.string().min(1), answer: queueAnswerSchema }),
    line: "Resume a project's paused batch, or send one paused change back, with the captain's reason. Only on the captain's own words; the queue closes the pause's issue with that reason.",
    toRequest: (v) => [v.repoId, v.answer],
    readValue: (c) => ({
      paused: (c as RepoView[])
        .filter((repo) => repo.queuePause)
        .map(({ id, name, queuePause }) => ({ id, name, pause: queuePause })),
    }),
    done: (v) =>
      (v.answer as QueueAnswer).action === "resume"
        ? "asked the queue to resume"
        : `asked the queue to send #${(v.answer as Extract<QueueAnswer, { action: "send-back" }>).number} back`,
  },
  "project-batch-answer": {
    area: "projects",
    tier: "own-words",
    change: "inf:repos:batch-answer",
    current: "inf:repos:list",
    value: z.strictObject({ repoId: z.string().min(1), answer: batchAnswerSchema }),
    line: "Try a project's held batch of the captain's approved changes again, or send changes back from it, each by its taskId with the captain's reason. Only on the captain's own words; head is the held version.",
    toRequest: (v) => [v.repoId, v.answer],
    readValue: (c) => ({
      held: (c as RepoView[])
        .filter((repo) => repo.batch?.open?.hold)
        .map(({ id, name, batch }) => ({ id, name, batch: batch?.open })),
    }),
    done: (v) =>
      (v.answer as BatchAnswer).action === "try-again"
        ? "asked for the held batch to be tried again"
        : `sent ${(v.answer as Extract<BatchAnswer, { action: "send-back" }>).changes.length} of the held batch's changes back`,
  },
  "cost-limit": {
    area: "intelligence",
    tier: "asked",
    change: "inf:settings:cost-limit:set",
    current: "inf:settings:cost-limit:get",
    value: z.strictObject({ limit: costLimitSchema }),
    line: "Set the app's per-task cost limit when asked: {usd} in estimated US dollars, or {none:true} for no limit. It counts each task and everything under it, parts included. Project and task choices take precedence. The default lives in Settings → Intelligence.",
    toRequest: (v) => [v.limit],
    readValue: (current) => ({ limit: (current as AppCostLimitView).limit }),
    done: (v) => {
      const limit = v.limit as AppCostLimitView["limit"];
      return "usd" in limit ? `task cost limit ${formatUsd(limit.usd)}` : "no task cost limit";
    },
  },
  notifications: {
    area: "general",
    tier: "asked",
    change: "inf:settings:notifications:set",
    current: "inf:settings:notifications:get",
    value: z.strictObject({ enabled: z.boolean() }),
    line: "Turn notifications on or off when asked.",
    toRequest: (v) => [v.enabled],
    readValue: (current) => ({ enabled: current }),
    done: (v) => `notifications ${v.enabled ? "on" : "off"}`,
  },
  runbook: {
    area: "intelligence",
    tier: "asked",
    change: "inf:settings:runbooks:set",
    current: "inf:settings:runbooks:get",
    value: z.strictObject({ id: z.string(), enabled: z.boolean() }),
    line: "Turn a named runbook on or off when asked. Read the available names and ids first.",
    toRequest: (v) => [v.id, v.enabled],
    readValue: (current) => ({ runbooks: current }),
    done: (v) =>
      `${v.name} ${v.enabled ? "on" : "off"}${v.replacement ? `; ${v.replacement} off` : ""}`,
  },
  "runbook-copy": {
    area: "intelligence",
    tier: "asked",
    change: "inf:settings:runbooks:copy",
    current: "inf:settings:runbooks:get",
    value: z.strictObject({ id: z.string(), copyId: z.string(), name: z.string().min(1) }),
    line: "Copy a built-in runbook into the personal workspace when asked. Choose an unused copyId and a name. The copy starts off and its path is returned in the runbooks list. Edit its files there; turning it on with runbook turns the named built-in off. To restore ours, turn the copy off and ours on.",
    toRequest: (v) => [v.id, v.copyId, v.name],
    readValue: (current) => ({ runbooks: current }),
    done: (v) =>
      `copied ${v.source} as ${v.name} in your personal workspace; off until you turn it on`,
  },
  "personal-resources": {
    area: "intelligence",
    tier: "asked",
    change: "inf:settings:personal-resources:set",
    current: "inf:settings:personal-resources:get",
    value: z.strictObject({ enabled: z.boolean() }),
    line: `Use each ${COMPUTER.one}'s own global instructions and skills for crewmates when asked. Crew rules govern delivery; personal instructions guide style and judgment. MCP and hooks stay off.`,
    toRequest: (v) => [v.enabled],
    readValue: (current) => ({ enabled: current }),
    done: (v) => `global instructions and skills ${v.enabled ? "on" : "off"}`,
  },
  "window-wash": {
    fields: ["washStrength"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({ strength: washStrengthSchema }),
    line: "Window wash opacity, 0–100 percent, when asked.",
    toRequest: (v, current) => [{ ...(current as Appearance), washStrength: v.strength }],
    readValue: (current) => ({
      strength: (current as Appearance).washStrength ?? DEFAULT_APPEARANCE.washStrength,
    }),
    done: (v) => `window wash ${v.strength}%`,
    settled: (from, to) => `window wash ${from.strength}% → ${to.strength}%`,
  },
  "window-size": {
    fields: ["size"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({ size: uiSizeSchema }),
    line: "Whole-window size, 100, 110, 125 or 150 percent, when asked: larger makes text and everything around it bigger. The size keys and the View menu step through the same sizes.",
    toRequest: (v, current) => [{ ...(current as Appearance), size: v.size }],
    readValue: (current) => ({
      size: (current as Appearance).size ?? DEFAULT_APPEARANCE.size,
    }),
    done: (v) => `window size ${v.size}%`,
    settled: (from, to) => `window size ${from.size}% → ${to.size}%`,
  },
  "crew-model-names": {
    fields: ["showCrewModelNames"],
    area: "appearance",
    tier: "asked",
    change: "inf:settings:appearance:set",
    current: "inf:settings:appearance:get",
    value: z.strictObject({ visible: z.boolean() }),
    line: "Show or hide crew model names when asked.",
    toRequest: (v, current) => [{ ...(current as Appearance), showCrewModelNames: v.visible }],
    readValue: (current) => ({ visible: (current as Appearance).showCrewModelNames ?? true }),
    done: (v) => `crew model names ${v.visible ? "shown" : "hidden"}`,
  },
  "panel-collapse": {
    fields: ["collapsedPanels"],
    area: "panels",
    tier: "asked",
    change: "inf:settings:layout:set",
    current: "inf:settings:layout:get",
    value: z.strictObject({ surface: z.string().min(1).max(64), collapsed: z.boolean() }),
    line: "Collapse or expand a panel by its surface id when asked.",
    toRequest: (v, current) => [
      {
        ...(current as Layout),
        collapsedPanels: {
          ...(current as Layout).collapsedPanels,
          [v.surface as string]: v.collapsed,
        },
      },
    ],
    readValue: (current) => ({ collapsedPanels: (current as Layout).collapsedPanels }),
    done: (v) => `${v.surface} ${v.collapsed ? "collapsed" : "expanded"}`,
  },
  // Settings → Automation's own changes (docs/automation.md, "One owner").
  // The words are the Scheduler's, and the trail is the dispatcher's.
  "automation-edit": {
    area: "automation",
    tier: "asked",
    change: "inf:automation:save",
    current: "inf:automation:list",
    value: z.strictObject({
      id: automationIdSchema,
      name: z.string().max(80).optional(),
      spec: automationSpecSchema.optional(),
      prompt: z.string().trim().min(1).optional(),
      projectId: z.string().min(1).nullable().optional(),
      enable: z.boolean().optional(),
    }),
    line: "Edit one automation by id when asked: its name, spec, prompt or projectId (null takes it off); what you leave out stays. enable true turns a draft or a paused one on.",
    toRequest: (v, current) => {
      const rule = automationRule(current, v.id);
      const projectId =
        v.projectId === undefined ? rule.projectId : ((v.projectId as string | null) ?? undefined);
      return [
        {
          id: rule.id,
          name: (v.name as string | undefined) ?? rule.name ?? "",
          spec: v.spec ?? rule.spec,
          prompt: (v.prompt as string | undefined) ?? rule.prompt,
          ...(projectId ? { projectId } : {}),
          ...(v.enable === true ? { enable: true } : {}),
        },
      ];
    },
    readValue: (current) => automationValue(current),
    done: (v) => String(v.text),
  },
  "automation-state": {
    area: "automation",
    tier: "judgment",
    change: "inf:automation:state",
    current: "inf:automation:list",
    value: z.strictObject({ id: automationIdSchema, change: z.enum(["pause", "resume"]) }),
    line: "Pause or resume one automation by id on your own judgment: a paused one sends nothing, and its unsent prompts are taken back. A draft turns on only through automation-edit.",
    toRequest: (v, current) => {
      const rule = automationRule(current, v.id);
      if (v.change === "resume" && rule.state === "draft")
        throw new Error(
          "This automation is a draft: turn it on with automation-edit, enable true.",
        );
      return [rule.id, v.change];
    },
    readValue: (current) => automationValue(current, true),
    done: (v) => String(v.text),
  },
  "automation-pause-all": {
    area: "automation",
    tier: "judgment",
    change: "inf:automation:pause-all",
    current: "inf:automation:list",
    value: z.strictObject({}),
    line: "Pause every running automation at once on your own judgment; drafts and paused ones stay as they are.",
    toRequest: () => [],
    readValue: (current) => automationValue(current, true),
    done: (v) => String(v.text),
  },
  "automation-delete": {
    area: "automation",
    tier: "judgment",
    change: "inf:automation:delete",
    current: "inf:automation:list",
    value: z.strictObject({ id: automationIdSchema }),
    line: "Delete one automation and its run history by id on your own judgment, as cancel_schedule does.",
    toRequest: (v, current) => [automationRule(current, v.id).id],
    readValue: (current) => automationValue(current, true),
    done: (v) => String(v.text),
  },
} as const satisfies Record<string, ActionLine>;
export type ActionName = keyof typeof actionLines;
/** The value an action accepts, as its line's schema reads it (unknown where a line is built generically). */
export type ActionValue<A extends ActionName> = z.input<(typeof actionLines)[A]["value"]>;
export const ACTIONS: Record<ActionName, ActionLine> = actionLines;
export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[];
export type ActionActor =
  | {
      kind: "captain";
      projectBefore?: unknown;
      /** The paired view (a phone, or a Mac that controls this one) that asked, by its device id. */
      view?: string;
      /** The contract changes that paired view's hello listed, as its connection heard them. */
      viewChanges?: readonly string[];
    }
  | {
      kind: "firstmate";
      wake: "captain" | "captain-choice" | "scheduled" | "other";
      action?: ActionName;
      evidence?: string;
      projectWords?: boolean;
      /**
       * The panel a `panel` action names, as the first mate wrote it, so a
       * move that reads two ways is told the way it was asked (INF-2344).
       */
      target?: string;
    };
/** Settings and Firstmate share this project-change path. */
export function isProjectChange(action: ActionName): boolean {
  return action === "project-settings" || action === "project-runs-on";
}
export function actionRefusal(line: ActionLine, actor: ActionActor): string | null {
  if (actor.kind === "captain") return null;
  if (actor.action && isProjectChange(actor.action) && actor.projectWords !== true)
    return "Propose the project change through app_change, or declare the exact captain words with on_words true.";
  if (actor.action && isProjectChange(actor.action) && actor.wake === "captain-choice")
    return "Only the app’s exact-change card applies a project change from a click.";
  // A judgment line is the first mate's to run at any wake; its evidence is
  // the reason the record keeps.
  if (line.tier === "judgment")
    return actor.evidence?.trim() ? null : "Give the reason for this change.";
  if (line.tier === "hands" || line.tier === "yours")
    return "This action stays with the captain in Settings.";
  // Whatever began the turn: his choice relayed in a crewmate's report, or a
  // message he sent while the turn ran, reaches the first mate there too.
  if (!actor.evidence?.trim())
    return "Give the captain's words, choice or schedule that asked for this change.";
  return null;
}

/**
 * Static capability flags; a wake's permission is separately exposed as
 * allowedNow. A line that proposes is the Firstmate's to propose at any wake.
 */
export function actionActors(line: ActionLine): {
  captainAllowed: true;
  firstmateAllowed: boolean;
} {
  return {
    captainAllowed: true,
    firstmateAllowed:
      line.tier === "asked" ||
      line.tier === "own-words" ||
      line.tier === "judgment" ||
      line.proposes === true,
  };
}

/** Tool guidance follows the same permission lines as dispatch. */
export const OWN_WORDS_ACTIONS = ACTION_NAMES.filter((name) => ACTIONS[name].tier === "own-words");
