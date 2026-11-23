import { z } from "zod";
import { cardDraftSchema } from "./cardDrafts";
import { cardsSnapshotSchema, cardThreadSchema } from "./cards";
import { activityChannels } from "./channels/activity";
import { cardChannels } from "./channels/cards";
import { type ChannelDeclaration, okSchema } from "./channels/common";
import { deviceChannels } from "./channels/devices";
import { knowledgeChannels } from "./channels/knowledge";
import { modelChannels } from "./channels/models";
import { ownWindowChannels, ownWindowPushes } from "./channels/ownWindow";
import { panelChannels } from "./channels/panels";
import { secretsChannels } from "./channels/secrets";
import { settingsChannels } from "./channels/settings";
import {
  presenceSchema,
  shellChannels,
  windowFenceSchema,
  windowStateSchema,
} from "./channels/shell";
import { signInChannels } from "./channels/signIns";
import { talkChannels } from "./channels/talk";
import { taskChannels } from "./channels/tasks";
import { upkeepChannels } from "./channels/upkeep";
import { workChannels } from "./channels/work";
import {
  computerPresenceSchema,
  deviceAddressesSchema,
  deviceViewSchema,
  thisMacSchema,
} from "./devices";
import { dictationSettingsSchema } from "./dictation";
import { fmEventSchema } from "./events";
import { forgesViewSchema } from "./forges";
import { homeMoveProgressSchema } from "./homeMove";
import { integrationsViewSchema } from "./integrations";
import {
  isPanelCommandId,
  MOVE_KEY_NAMES,
  type MoveKey,
  type PanelCommandId,
  SHELL_COMMAND_IDS,
  type ShellCommandId,
} from "./keyboard";
import { keymapSnapshotSchema, nextKeysSchema } from "./keymap";
import { keyRemindersSchema } from "./keyReminders";
import { nearbyMacsViewSchema } from "./nearbyMacs";
import { appPanelsSchema } from "./personal/appPanels";
import { personalSnapshotSchema, personalStoreChangeSchema } from "./personal/manifest";
import { shellPreferencesSchema } from "./preferences";
import { authNoticeSchema, authPromptSchema } from "./providers";
import { quotaSnapshotViewSchema } from "./quota";
import { releaseNotesViewSchema } from "./releaseTracking";
import { computerResourcesSchema } from "./resources";
import { sharingViewSchema } from "./sharing";
import { deviceSignInEventSchema, deviceSignInsSchema } from "./signIns";
import { standbyViewsSchema } from "./standby";
import { taskBrowserFrameSchema } from "./taskBrowser";
import { taskBoardDeltaSchema, taskBoardSchema } from "./tasks";
import { voiceDownloadProgressSchema } from "./voice";

/**
 * The typed IPC contract. Every invoke channel is declared here, in a group
 * of channels under ./channels/ that `invokeContract` spreads in, with zod
 * schemas for both directions: main validates the request args before the
 * handler runs, the preload validates the response before handing it to the
 * renderer. Raw Pi events never appear here - main normalizes them to the
 * FmEvent union first (docs/architecture.md section 4).
 *
 * Each channel also declares the SURFACE it belongs to (daemon study D0,
 * data/fm3000-daemon-process-study-s1 section 4.5):
 *
 * - "core" channels are served by the application core, which knows nothing
 *   about the desktop shell. They are the protocol proper.
 * - "host" channels are the desktop shell's own surface - the window, the
 *   frames it serves to the renderer, the browser it opens links in,
 *   the folder picker and microphone priming. A host other than Electron would answer these
 *   itself rather than asking the core.
 *
 * Both surfaces ride the Electron IPC transport inside the app. The core
 * surface also rides the connection a paired device uses (docs/connection.md),
 * so every core channel declares its REACH as well:
 *
 * - "views" channels may also be asked by a paired view - the app on another
 *   Mac showing this one: talking, cards and their threads, task records and
 *   their bar, and the reads that draw them.
 * - "home" channels are answered only for this Mac's own window: settings,
 *   sign-ins and accounts, project setup, voice, added panels, Observe, SQL,
 *   and anything that acts on this Mac's own screen. The connection refuses
 *   them, whatever the asker says.
 * - "work" channels are asked only by a computer that runs work, about a
 *   crewmate's conversation it holds for this home (src/shared/work.ts):
 *   the window and a view are refused them.
 */

/**
 * The version of THIS contract - the channel set, their schemas, the surface
 * split, and the connection's envelope around them (src/shared/connection.ts).
 * Only a major change edits this line, for anything a client compiled
 * against an older contract could not survive: its major is the number of
 * the one `major-<N>.md` in `src/shared/contract-changes/`. An additive
 * change (a new channel, a new optional field) adds a file of its own there
 * and moves no number, and a feature that needs the other side to have it
 * waits for its name (docs/contract.md, "The version rule";
 * `src/core/connection/contractChanges.ts`, whose test holds this line to
 * the folder). Reported by `inf:app:healthcheck` and the connection's
 * welcome, and published with every core shape in docs/contract.json, so a
 * client can refuse or degrade on a mismatch instead of failing one call at
 * a time.
 */
export const PROTOCOL_VERSION = "16.0.0";

/**
 * The version rule's window for a computer that runs work (docs/contract.md):
 * a home answers every request of such a computer only on its own major (the
 * previous-major allowance is zero), because the home updates it over the
 * connection from the same release. One of any other major, older or newer,
 * is answered its reads only until it is updated.
 */
export const PROTOCOL_MAJORS_BEHIND = 0;

/**
 * The view floor (docs/contract.md, "The version rule"; INF-1649): the oldest
 * major a view - a phone, or a computer with Infinitary open that controls
 * this home - may still change things from. A view updates on its own
 * schedule, a phone through TestFlight or App Review, so a home keeps
 * answering every request of a view from the floor up to its own major.
 * Only a major that breaks what views send or read moves it, to that major;
 * the major's file says which it did (`Views: keep` or `Views: break`,
 * src/shared/contract-changes/README.md), and
 * `src/core/connection/contractChanges.test.ts` holds this line to it.
 * A view says its own floor in its hello (`viewFloor`), so a newer view
 * keeps changing things on an older home its floor reaches.
 */
export const VIEW_FLOOR = 15;

/**
 * What this home serves beyond its channel set, by name, so a client hides
 * what a home lacks instead of reasoning about version numbers. A client
 * ignores a name it does not know. `connection`: paired devices reach this
 * home over the connection, with numbered pushes and catch-up after a drop
 * (docs/connection.md).
 */
export const HOME_CAPABILITIES = ["connection"] as const;

const appInfoSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  platform: z.string(),
  /** The contract version this app speaks; see PROTOCOL_VERSION. */
  protocolVersion: z.string(),
  /** See HOME_CAPABILITIES; open names, so a newer home's list still parses. */
  capabilities: z.array(z.string().min(1).max(64)).max(64),
  /** Named additive changes, as advertised by the connection welcome. */
  changes: z.array(z.string()).optional(),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

export const invokeContract = {
  "inf:app:healthcheck": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: appInfoSchema,
  },
  ...talkChannels,
  ...deviceChannels,
  ...cardChannels,
  ...signInChannels,
  ...modelChannels,
  ...upkeepChannels,
  ...knowledgeChannels,
  ...taskChannels,
  ...settingsChannels,
  ...secretsChannels,
  ...shellChannels,
  ...activityChannels,
  ...panelChannels,
  ...ownWindowChannels,
  ...workChannels,
} as const satisfies Record<string, ChannelDeclaration>;

export type InvokeChannel = keyof typeof invokeContract;
export type InvokeRequest<C extends InvokeChannel> = z.infer<(typeof invokeContract)[C]["request"]>;
export type InvokeResponse<C extends InvokeChannel> = z.infer<
  (typeof invokeContract)[C]["response"]
>;

/** Invoke channels the core answers - the protocol proper. */
export type CoreInvokeChannel = {
  [C in InvokeChannel]: (typeof invokeContract)[C]["surface"] extends "core" ? C : never;
}[InvokeChannel];

/** Invoke channels the desktop shell answers for itself. */
type HostInvokeChannel = Exclude<InvokeChannel, CoreInvokeChannel>;

export const INVOKE_CHANNELS = Object.keys(invokeContract) as InvokeChannel[];

function isCoreInvokeChannel(channel: InvokeChannel): channel is CoreInvokeChannel {
  return invokeContract[channel].surface === "core";
}

export const CORE_INVOKE_CHANNELS = INVOKE_CHANNELS.filter(isCoreInvokeChannel);
export const HOST_INVOKE_CHANNELS = INVOKE_CHANNELS.filter(
  (channel): channel is HostInvokeChannel => !isCoreInvokeChannel(channel),
);

/**
 * Core channels a paired view may ask as well as this computer (see
 * ChannelReach): one rule for every view, whatever started its first mate
 * (docs/connection.md, "Requests").
 */
type ViewInvokeChannel = {
  [C in CoreInvokeChannel]: (typeof invokeContract)[C]["reach"] extends "views" ? C : never;
}[CoreInvokeChannel];

export function isViewInvokeChannel(channel: CoreInvokeChannel): channel is ViewInvokeChannel {
  return invokeContract[channel].reach === "views";
}

export const VIEW_INVOKE_CHANNELS = CORE_INVOKE_CHANNELS.filter(isViewInvokeChannel);

/** Core channels only a computer that runs work asks (see ChannelReach). */
export type WorkInvokeChannel = {
  [C in CoreInvokeChannel]: (typeof invokeContract)[C]["reach"] extends "work" ? C : never;
}[CoreInvokeChannel];

export function isWorkInvokeChannel(channel: CoreInvokeChannel): channel is WorkInvokeChannel {
  return invokeContract[channel].reach === "work";
}

export const WORK_INVOKE_CHANNELS = CORE_INVOKE_CHANNELS.filter(isWorkInvokeChannel);

/**
 * Core channels only the window's own program asks, never its page nor the
 * captain's command: Join by its address's link, which stays in the main
 * process (docs/view.md, "Joining by its address"), and a reset's undoing
 * and a reset asked by a computer that controls this one, which each only
 * follow the system's own confirmation (docs/reset.md). The desktop adapter
 * serves the page none of them (`src/main/ipc/index.ts`), and
 * `infinitary-axi` reaches none (`commandReaches`).
 */
export const PROGRAM_ONLY_CHANNELS: ReadonlySet<CoreInvokeChannel> = new Set<CoreInvokeChannel>([
  "inf:devices:link-at",
  "inf:app:reset-prepare",
  "inf:home-reset:start",
]);

/**
 * Zod-parses one invoke request against the contract. The single place a
 * request is admitted, so every transport validates identically rather than
 * each adapter re-deciding.
 */
export function parseInvokeRequest<C extends InvokeChannel>(
  channel: C,
  rawArgs: unknown,
): InvokeRequest<C> {
  const parsed = invokeContract[channel].request.safeParse(rawArgs);
  if (!parsed.success) {
    throw new Error(`Rejected ${channel}: malformed request`);
  }
  return parsed.data as InvokeRequest<C>;
}

/**
 * A window command the shell page runs (docs/keyboard.md): the main process
 * heard its key before any frame and names the command alone.
 */
const shellCommandSchema = z.object({
  command: z.union([
    z.enum(SHELL_COMMAND_IDS as [ShellCommandId, ...ShellCommandId[]]),
    // A panel's command, by its id alone (docs/keyboard.md, "A panel's commands").
    z
      .string()
      .max(64)
      .refine(isPanelCommandId, "a panel command's id")
      .transform((id) => id as PanelCommandId),
  ]),
});

/** A movement command's key, for the frame that holds focus (docs/keyboard.md). */
const moveKeySchema = z.object({
  key: z.enum(MOVE_KEY_NAMES as [MoveKey, ...MoveKey[]]),
  frame: z.uuid(),
});

/** A key Keyboard settings recorded, as the main process heard it (docs/keyboard.md). */
const recordedKeySchema = z.object({
  key: z.string().min(1).max(32),
  code: z.string().max(32),
  meta: z.boolean(),
  ctrl: z.boolean(),
  alt: z.boolean(),
  shift: z.boolean(),
});
export type RecordedKey = z.infer<typeof recordedKeySchema>;

/** A page to open in a browser, by its address (`inf:app:open-page`). */
export const openPageSchema = z.object({ url: z.string().min(1).max(4096) }).strict();

/** A return's id, as the first mate's computer names a waiting sign-in's (src/core/signInReturns.ts). */
export const signInReturnIdSchema = z.string().min(1).max(64);

/**
 * A sign-in page whose browser comes back to the first mate's computer's
 * loopback address at `port`, and the return's id
 * (`inf:app:sign-in-page`, src/core/signInReturns.ts).
 */
export const signInPageSchema = z
  .object({
    url: z.string().min(1).max(4096),
    id: signInReturnIdSchema,
    port: z.number().int().min(1).max(65_535),
  })
  .strict();

/** The sign-in a return waited for stopped waiting (`inf:app:sign-in-ended`). */
export const signInEndedSchema = z.object({ id: signInReturnIdSchema }).strict();

/** Push channels (main to renderer). Payloads are validated in the preload. */
export const pushContract = {
  "inf:secrets:changed": { payload: z.object({}), surface: "core" },
  "inf:event": { payload: fmEventSchema, surface: "core" },
  // Desktop transport only: the core and paired computers keep individual events.
  "inf:events": { payload: z.array(fmEventSchema), surface: "host" },
  "inf:cards": { payload: cardsSnapshotSchema, surface: "core" },
  // One card's thread, whole, after any message lands on it.
  "inf:cards:thread": { payload: cardThreadSchema, surface: "core" },
  // One open card's draft, whole, after a window changed it: a `live`
  // frame to each view whose hello lists `card-drafts`, never numbered or
  // kept (docs/connection.md, "Live pushes").
  "inf:cards:draft": { payload: cardDraftSchema, surface: "core" },
  // The captain clicked a card's notification: the window takes which card
  // (`inf:cards:take-notified`) and brings it to the front (src/main/notifiedCard.ts).
  "inf:cards:notified": { payload: z.object({}), surface: "host" },
  "inf:auth:prompt": { payload: authPromptSchema, surface: "core" },
  "inf:auth:notice": { payload: authNoticeSchema, surface: "core" },
  "inf:quota": { payload: quotaSnapshotViewSchema, surface: "core" },
  "inf:models:changed": { payload: okSchema, surface: "core" },
  // The live board, whole, rebuilt from SQLite after each commit and
  // coalesced like inf:cards; `seq` orders pushes (task-system P3).
  "inf:tasks": { payload: taskBoardSchema, surface: "core" },
  // Above the measured trigger (task-system P5, design section 9.1) the
  // board rides as deltas on the same seq: what changed since the last
  // push, applied by the client, resynced from inf:tasks:board on a gap.
  "inf:tasks:delta": { payload: taskBoardDeltaSchema, surface: "core" },
  // Personal extensions: the whole snapshot on any change (a file saved, a
  // presence key written, a task on an extension starting or ending), and
  // one notice per store write so a panel re-reads only its own keys.
  "inf:plugins:personal": { payload: personalSnapshotSchema, surface: "core" },
  "inf:plugins:db": { payload: personalStoreChangeSchema, surface: "core" },
  // The app's own panels a view may draw, whole, when the set whose gate is open changes.
  "inf:plugins:app-panels": { payload: appPanelsSchema, surface: "core" },
  // Dictation is changed only in Settings; every renderer reads the saved choice.
  "inf:settings:dictation": { payload: dictationSettingsSchema, surface: "core" },
  // The captain's preferences, whole, after every write: the value of the
  // `shell.preferences` read, so the window applies a change the Firstmate
  // made the moment it lands (talk-to-personalize Step 1).
  "inf:shell:preferences": { payload: shellPreferencesSchema, surface: "core" },
  // The two switches, whole, after every write (roadmap 1.4).
  "inf:sharing": { payload: sharingViewSchema, surface: "core" },
  // The release notes the app showed, whole, after a new one is shown.
  "inf:release-notes": { payload: releaseNotesViewSchema, surface: "core" },
  // The sign-ins where projects live, whole, after every change (PR 1.2).
  "inf:forges": { payload: forgesViewSchema, surface: "core" },
  // The integrations, whole, after every change to one or to a sign-in it reads.
  "inf:integrations": { payload: integrationsViewSchema, surface: "core" },
  // The whisper model download the renderer drives; the shell serves it.
  "inf:voice:progress": { payload: voiceDownloadProgressSchema, surface: "core" },
  // Your devices, whole, after any change to the list or to what the home
  // reads of a computer that runs work (docs/devices.md, "Your devices").
  "inf:computers:presence": { payload: z.array(computerPresenceSchema), surface: "core" },
  "inf:devices": { payload: z.array(deviceViewSchema), surface: "core" },
  "inf:computers:resources": { payload: computerResourcesSchema, surface: "core" },
  // Where devices find this Mac, whole, after it reads differently - the
  // captain's choice, or this Mac's network moving (docs/devices.md).
  "inf:devices:addresses": { payload: deviceAddressesSchema, surface: "core" },
  // Where moving the first mate to another computer stands, whole, at each
  // change (docs/devices.md, "Moving the first mate").
  "inf:home-move:progress": { payload: homeMoveProgressSchema, surface: "core" },
  "inf:standby:views": { payload: standbyViewsSchema, surface: "core" },
  // Macs nearby, whole, whenever the list reads differently while it is looked for.
  "inf:devices:nearby": { payload: nearbyMacsViewSchema, surface: "core" },
  // Each computer that runs work and what it is signed in to, whole, after
  // every change; and one step of a sign-in running on one of them.
  "inf:devices:sign-ins": { payload: z.array(deviceSignInsSchema), surface: "core" },
  "inf:devices:sign-in": { payload: deviceSignInEventSchema, surface: "core" },
  // What this app is on its Mac, whole, after every change (docs/view.md).
  "inf:devices:this-mac": { payload: thisMacSchema, surface: "host" },
  // A key this window heard for one of the shell's commands, by the command's id.
  "inf:keyboard:command": { payload: shellCommandSchema, surface: "host" },
  // A movement command's key for the frame holding focus, named by the
  // frame the main process saw holding it (docs/keyboard.md, "Moving by a key of your own").
  "inf:keyboard:move": { payload: moveKeySchema, surface: "host" },
  // The window took a key for itself, which the page heard nothing of, nor any
  // key's release after it until the next goes down; which key stays unsaid.
  "inf:keyboard:taken": { payload: z.object({}), surface: "host" },
  // The window's keys, whole, after every install.
  "inf:keyboard:keymap": { payload: keymapSnapshotSchema, surface: "host" },
  // A key pressed while Keyboard settings records one.
  "inf:keyboard:recorded": { payload: recordedKeySchema, surface: "host" },
  // The key reminder's switch and the keys pressed, whole, after every change
  // (docs/keyboard.md, "The key reminder").
  "inf:keyboard:reminders": { payload: keyRemindersSchema, surface: "host" },
  // The window took a two-key shortcut's first key and waits for the second:
  // each pair that may follow, for the next-keys hint, or null once it stopped.
  "inf:keyboard:next": { payload: nextKeysSchema, surface: "host" },
  // The window filled the screen or stopped filling it.
  "inf:window:state": { payload: windowStateSchema, surface: "host" },
  // Someone came back to this computer or left it (src/main/presence.ts).
  "inf:window:presence": { payload: presenceSchema, surface: "host" },
  // The fence the window asked for, behind every push it was sent before it.
  "inf:window:fence": { payload: windowFenceSchema, surface: "host" },
  // One picture of a watched task's page, to whoever watches it alone: a
  // window here, or a connection as a `live` frame, never numbered or kept
  // (docs/task-browser.md, "The view"; docs/connection.md, "Live pushes").
  "inf:browser:frame": { payload: taskBrowserFrameSchema, surface: "core" },
  // A page the first mate would open in a browser for a view's request,
  // such as a sign-in's, or any page when a command started it and nobody
  // sits at its computer: each computer that controls it opens the page
  // instead (docs/view.md, "Pages it would open").
  "inf:app:open-page": { payload: openPageSchema, surface: "core" },
  // A sign-in page whose browser comes back to the first mate's own loopback
  // address, for each computer that controls it to open and catch its return
  // at that port, until the sign-in ends (docs/view.md, "A sign-in that
  // returns to the first mate's computer").
  "inf:app:sign-in-page": { payload: signInPageSchema, surface: "core" },
  "inf:app:sign-in-ended": { payload: signInEndedSchema, surface: "core" },
  ...ownWindowPushes,
} as const;

export type PushChannel = keyof typeof pushContract;
export type PushPayload<C extends PushChannel> = z.infer<(typeof pushContract)[C]["payload"]>;

/** Push channels the core emits; a second client would subscribe to these. */
export type CorePushChannel = {
  [C in PushChannel]: (typeof pushContract)[C]["surface"] extends "core" ? C : never;
}[PushChannel];

export const PUSH_CHANNELS = Object.keys(pushContract) as PushChannel[];

function isCorePushChannel(channel: PushChannel): channel is CorePushChannel {
  return pushContract[channel].surface === "core";
}

export const CORE_PUSH_CHANNELS = PUSH_CHANNELS.filter(isCorePushChannel);
