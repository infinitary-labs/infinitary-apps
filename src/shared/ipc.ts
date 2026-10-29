import { z } from "zod";
import { ACCOUNT_LABEL_MAX, type AccountView, accountViewSchema } from "./accounts";
import {
  CHOSEN_FILES_MAX,
  type ChosenFile,
  chosenFileSchema,
  type DroppedPath,
  droppedPathSchema,
} from "./attachments";
import {
  type AutomationList,
  type AutomationRule,
  type AutomationSave,
  type AutomationSpec,
  automationListSchema,
  automationPreviewSchema,
  automationRuleSchema,
  automationRunSchema,
  automationSaveSchema,
  automationSpecSchema,
} from "./automation";
import { CARD_MEDIA_PIECE_BYTES, CARD_MEDIA_TYPES, CARD_TYPEFACE_TYPES } from "./cardPictures";
import {
  CARD_REPLY_MAX_CHARS,
  type Card,
  type CardActionSource,
  type CardAnswer,
  type CardSubmission,
  type CardThread,
  CONVERSE_TEXT_MAX_CHARS,
  cardActionSourceSchema,
  cardAnswersSchema,
  cardSchema,
  cardsSnapshotSchema,
  cardThreadSchema,
  type DropTaskReview,
  dropTaskReviewSchema,
  type PastCard,
  pastCardSchema,
  shellEffectSchema,
  type TaskLifecycleOp,
  type TaskMoveFrom,
  TURN_IMAGES_MAX,
  taskLifecycleOpSchema,
  taskMoveFromSchema,
  turnImageSchema,
} from "./cards";
import { PASTE_FILE_MAX_BYTES, PASTE_FILES_MAX } from "./composer";
import { type CrewSpeed, crewSpeedSchema } from "./crewSpeed";
import {
  type CrewPicture,
  type CrewResultText,
  type CrewSendResult,
  crewLiveSchema,
  crewPictureSchema,
  crewResultTextSchema,
  crewSendResultSchema,
  crewTranscriptSchema,
} from "./crewTranscript";
import {
  type CustomApiAddress,
  type CustomApiConnectInput,
  type CustomApiConnectResult,
  type CustomApiInput,
  type CustomApiReview,
  type CustomApiView,
  type CustomCapabilityProfile,
  type CustomListedModel,
  type CustomNetworkMode,
  customApiAddressSchema,
  customApiConnectInputSchema,
  customApiConnectResultSchema,
  customApiInputSchema,
  customApiReviewSchema,
  customApiViewSchema,
  customCapabilityProfileSchema,
  customListedModelSchema,
  customNetworkModeSchema,
} from "./customApi";
import {
  type DecisionModelId,
  type DecisionsSettings,
  type DecisionsView,
  decisionModelIdSchema,
  decisionsSettingsSchema,
  decisionsViewSchema,
} from "./decisions";
import {
  computerPresenceSchema,
  type DeviceAddresses,
  type DeviceInvite,
  type DeviceInviteRequest,
  type DeviceRemoveWhen,
  type DeviceView,
  deviceAddressesSchema,
  deviceInviteRequestSchema,
  deviceInviteSchema,
  deviceRemoveWhenSchema,
  deviceViewSchema,
  type JoinOutcome,
  joinOutcomeSchema,
  type ThisMac,
  thisMacSchema,
} from "./devices";
import { type DictationSettings, dictationSettingsSchema } from "./dictation";
import { type CrewCounts, crewCountsSchema, type FmEvent, fmEventSchema } from "./events";
import { type FeedLine, feedLineSchema } from "./feed";
import { type CrewWord, crewWordSchema, type FirstRunView, firstRunViewSchema } from "./firstRun";
import {
  type ForgeBrowserSignIn,
  type ForgeChangesView,
  type ForgeCliSignInResult,
  type ForgeKeySignIn,
  type ForgeKeySignInResult,
  type ForgeProject,
  type ForgeSignInFlow,
  type ForgesView,
  forgeBrowserSignInSchema,
  forgeChangesViewSchema,
  forgeCliSignInResultSchema,
  forgeKeySignInResultSchema,
  forgeKeySignInSchema,
  forgeProjectSchema,
  forgeSignInFlowSchema,
  forgesViewSchema,
} from "./forges";
import {
  type IntegrationKind,
  type IntegrationMcpAdd,
  type IntegrationSettingsPatch,
  type IntegrationSignInConsent,
  type IntegrationsView,
  integrationActionNameSchema,
  integrationIdSchema,
  integrationKindSchema,
  integrationMcpAddSchema,
  integrationSecretNameSchema,
  integrationSecretValueSchema,
  integrationSettingsPatchSchema,
  integrationSignInConsentSchema,
  integrationsViewSchema,
} from "./integrations";
import {
  isPanelCommandId,
  MAIN_COMMAND_IDS,
  type MainCommandId,
  type PanelCommand,
  type PanelCommandId,
  SHELL_COMMAND_IDS,
  type ShellCommandId,
} from "./keyboard";
import {
  type KeymapSnapshot,
  keymapSnapshotSchema,
  panelCommandsSchema,
  type SavedKeymap,
  savedKeymapSchema,
} from "./keymap";
import {
  knowledgeCollectionsSchema,
  knowledgeConceptsArgsSchema,
  knowledgeConceptsSchema,
  knowledgeDirectionArgsSchema,
  knowledgeDirectionChangedSchema,
  knowledgeDirectionChangeSchema,
  knowledgeDirectionReadSchema,
  knowledgeDirectionsArgsSchema,
  knowledgeDirectionsSchema,
  knowledgeEntryArgsSchema,
  knowledgeEntryReadSchema,
  knowledgeFindingsArgsSchema,
  knowledgeFindingsSchema,
  knowledgeGraphArgsSchema,
  knowledgeGraphSchema,
  knowledgeRefsArgsSchema,
  knowledgeRefsSchema,
  knowledgeUsesArgsSchema,
  knowledgeUsesSchema,
} from "./knowledge";
import { type LastTurn, lastTurnSchema } from "./lastTurn";
import {
  type LocalOrchestratorSetting,
  type LocalOrchestratorView,
  localOrchestratorSettingSchema,
  localOrchestratorViewSchema,
} from "./localOrchestrator";
import {
  type ModelSlotsView,
  modelSlotsViewSchema,
  type ReasoningChoice,
  reasoningChoiceSchema,
  type Slot,
  slotSchema,
} from "./modelSlots";
import { type NearbyMacsView, nearbyMacsViewSchema } from "./nearbyMacs";
import {
  type ObserveSessionDetail,
  type ObserveSessionSummary,
  observeLiveSchema,
  observeSessionDetailSchema,
  observeSessionSummarySchema,
} from "./observe";
import {
  type PersonalInvokeOptions,
  type PersonalInvokeResult,
  type PersonalSnapshot,
  type PersonalStoreChange,
  type PersonalStoreRequest,
  type PersonalStoreResponse,
  personalIdSchema,
  personalInvokeOptionsSchema,
  personalInvokeResultSchema,
  personalSnapshotSchema,
  personalStoreChangeSchema,
  personalStoreRequestSchema,
  personalStoreResponseSchema,
} from "./personal/manifest";
import { type PanelMounts, panelMountsSchema } from "./personal/mounts";
import {
  type MediatedFetchCall,
  type MediatedFetchResult,
  mediatedFetchCallSchema,
  mediatedFetchResultSchema,
} from "./plugins/fetch";
import {
  type FrameMount,
  type FrameMountRequest,
  frameMountRequestSchema,
  frameMountSchema,
} from "./plugins/frameDocument";
import {
  type Appearance,
  appearanceSchema,
  type Layout,
  layoutSchema,
  type PersonalPanels,
  personalPanelsSchema,
  type ShellPreferences,
  shellPreferencesSchema,
} from "./preferences";
import {
  type AuthNotice,
  type AuthPromptView,
  authNoticeSchema,
  authPromptSchema,
  type ProviderView,
  providerViewSchema,
} from "./providers";
import {
  type ModelsCatalogView,
  modelsCatalogViewSchema,
  type PiModelRefView,
  piModelRefViewSchema,
  type QuotaSnapshotView,
  quotaSnapshotViewSchema,
  type RoutingSettings,
  routingSettingsSchema,
} from "./quota";
import type { ReadArgs, ReadGrant, ReadName, ReadResult } from "./reads";
import {
  type ReleaseNotesView,
  releaseNotesViewSchema,
  type ShownReleaseNote,
  shownReleaseNoteSchema,
} from "./releaseTracking";
import {
  type RemoteLoginAddAnswer,
  type RemoteLoginAddOptions,
  type RemoteLoginPasswordQuestion,
  type RemoteLoginRefusedAnswer,
  remoteLoginAddAnswerSchema,
  remoteLoginAddOptionsSchema,
  remoteLoginAddressSchema,
  remoteLoginPasswordQuestionSchema,
  remoteLoginRefusedAnswerSchema,
} from "./remoteLogin";
import {
  type ProjectsFolderView,
  projectsFolderViewSchema,
  type RepoPolicyPatch,
  type RepoRemoval,
  type RepoSetupResult,
  type RepoSetupSpec,
  type RepoView,
  repoPolicyPatchSchema,
  repoRemovalSchema,
  repoSetupResultSchema,
  repoSetupSpecSchema,
  repoViewSchema,
} from "./repos";
import {
  type ComputerResourcesView,
  computerResourcesSchema,
  RESOURCE_OBSERVATIONS_SINCE,
} from "./resources";
import { type RunbookView, runbookViewSchema } from "./runbooks";
import {
  type KeptOutsideData,
  keptOutsideDataSchema,
  type OutsideDataDeleted,
  outsideDataDeletedSchema,
} from "./savedOutsideData";
import {
  type SharingAskAnswer,
  type SharingChannel,
  type SharingPreview,
  type SharingView,
  sharingAskAnswerSchema,
  sharingChannelSchema,
  sharingPreviewSchema,
  sharingViewSchema,
} from "./sharing";
import {
  type DeviceSignInEvent,
  type DeviceSignIns,
  deviceSignInEventSchema,
  deviceSignInsSchema,
  forgeHostSchema,
  SIGN_IN_ANSWER_MAX_CHARS,
  signInIdSchema,
  signInWorkRequests,
} from "./signIns";
import { sqlAnswerSchema, sqlRequestSchema } from "./sql";
import {
  type SavedSignInsView,
  savedSignInsViewSchema,
  type TaskBrowserCommandResult,
  type TaskBrowserFrame,
  type TaskBrowserHandle,
  type TaskBrowserInput,
  type TaskBrowserReturn,
  type TaskBrowserSize,
  taskBrowserCommandResultSchema,
  taskBrowserFrameSchema,
  taskBrowserHandleSchema,
  taskBrowserInputSchema,
  taskBrowserReturnSchema,
  taskBrowserSizeSchema,
} from "./taskBrowser";
import {
  type ProjectView,
  projectViewSchema,
  type TaskBoard,
  type TaskBoardDelta,
  type TaskDetail,
  taskBoardDeltaSchema,
  taskBoardSchema,
  taskDetailSchema,
  taskViewSchema,
} from "./tasks";
import {
  type PresenceSettings,
  presenceSettingsSchema,
  type UpdateChannel,
  type UpdateInstallResult,
  type UpdateStatus,
  updateChannelSchema,
  updateInstallResultSchema,
  updateStatusSchema,
} from "./update";
import {
  usageQuerySchema,
  usageSummarySchema,
  usageTasksQuerySchema,
  usageTasksSchema,
} from "./usage";
import {
  type MicAccess,
  micAccessSchema,
  type RecognizerPlace,
  recognizerPlaceSchema,
  type VoiceDownloadProgress,
  type VoiceStatus,
  voiceClipSchema,
  voiceDownloadProgressSchema,
  voiceStatusSchema,
} from "./voice";
import { workRequests, workRequestWire } from "./work";

/**
 * The typed IPC contract. Every invoke channel is declared here with zod
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
export const PROTOCOL_VERSION = "12.0.0";

/**
 * The version rule's window (docs/contract.md): a home answers every request
 * of a client whose major is its own (the previous-major allowance is zero). A client
 * of any other major, older or newer, is answered its reads only until it is
 * updated.
 */
export const PROTOCOL_MAJORS_BEHIND = 0;

/** What a client may ask of a home under the version rule: everything, or the reads alone. */
export type ContractAccess = "full" | "read";

/**
 * The version rule, as the home applies it to a client's hello. Only the
 * majors count: a minor is additive, so a client on an older or newer minor
 * of an answered major keeps everything it knows. A version that does not
 * read as `major.minor.patch` is answered its reads only.
 */
export function contractAccess(
  clientVersion: string,
  homeVersion: string = PROTOCOL_VERSION,
): ContractAccess {
  const behind = majorOf(homeVersion) - majorOf(clientVersion);
  return behind >= 0 && behind <= PROTOCOL_MAJORS_BEHIND ? "full" : "read";
}

/**
 * The first contract a computer that runs work can hold a crewmate's
 * conversation on, in a working copy of its own (src/shared/work.ts): it
 * answers the home's orders, the working copy's among them, and asks the
 * work requests. One that speaks an older one joins and stays in reach,
 * and takes no work.
 */
export const PLACED_WORK_SINCE = "1.64.0";

/**
 * The first contract a computer that runs work signs in to its own
 * subscriptions on (src/shared/signIns.ts): it answers the home's sign-in
 * orders and asks the sign-in work requests. One that speaks an older one
 * runs work with what it is already signed in to.
 */
export const SIGN_INS_SINCE = "1.62.0";

/**
 * The first contract a computer that runs work signs in where projects live
 * on (`inf:sign-ins:forge`, src/shared/signIns.ts), for its own clones and
 * pushes, and signs in to Claude with a code pasted back from its home. One
 * that speaks an older one says no forges with its sign-ins, so the home
 * offers it no such sign-in.
 */
export const FORGE_SIGN_INS_SINCE = "1.63.0";

/**
 * The first contract a computer that runs work adds a custom API connection
 * on (`inf:sign-ins:custom-*`, src/shared/signIns.ts), and says which models
 * its own sign-ins serve. One that speaks an older one has no such chip.
 */
export const CUSTOM_API_SIGN_INS_SINCE = "2.6.0";

/**
 * The first contract a computer that runs work takes a task with no project
 * (`inf:working-copy:seed`, src/shared/work.ts): the home sends its default
 * workspace first, and the working copy there starts from it. One that
 * speaks an older one takes such a task only once it is updated.
 */
export const PLACED_SEED_SINCE = "3.1.0";

/**
 * The first contract a computer that runs work keeps its tasks' own
 * browsers on (`browserOrders`, src/shared/work.ts; docs/task-browser.md,
 * "On another computer"): its roster says so, its crewmates are given
 * `infinitary-browser-axi`, and it answers the captain's side of each browser. One
 * that speaks an older one gives its tasks no browser.
 */
export const TASK_BROWSERS_THERE_SINCE = "4.1.0";

/**
 * The first contract a computer that runs work gives its crewmates the
 * home's knowledge on (`inf:work:knowledge`, `inf:work:record-knowledge`,
 * src/shared/work.ts; docs/knowledge.md, "Who has it"): the home names the
 * pair among a task's tools and writes its knowledge lines into the brief.
 * One that speaks an older one gives its tasks no knowledge.
 */
export const KNOWLEDGE_THERE_SINCE = "5.5.0";

/** Work computers stage saved change stories and pass their revision on completion cards. */
export const CHANGE_PRESENTATIONS_SINCE = "8.13.0";
export function speaksChangePresentations(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, CHANGE_PRESENTATIONS_SINCE);
}

/**
 * The first contract a computer that runs work is updated on over the
 * connection (docs/devices.md, "Updating over the connection"): its hello
 * says the version of Firstmate it runs, it takes the update order
 * (`fm:firstmate:update`, src/shared/work.ts) whatever its major, and it
 * gets Firstmate from its home with its own key. One that speaks an older
 * one is updated by a new command run there instead.
 */
export const WORK_UPDATE_SINCE = "1.76.0";

/**
 * Whether a computer that runs work takes the update order: on any major,
 * from `WORK_UPDATE_SINCE` on, because that order and the way the computer
 * gets Firstmate from its home never change across majors. A version that
 * does not read as `major.minor.patch` takes none.
 */
export function takesUpdate(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, WORK_UPDATE_SINCE);
}

/**
 * The first contract a computer that runs work downloads its own update on
 * (docs/devices.md, "Downloading over the connection"): it takes the
 * download order (`fm:firstmate:update-download`, src/shared/work.ts)
 * whatever its major, gets the home's published version itself and checks
 * it, and answers how far it got (`fm:firstmate:update-progress`). One that
 * speaks an older one is updated with the update order alone.
 */
export const WORK_DOWNLOAD_SINCE = "8.15.0";

/**
 * Whether a computer that runs work takes the download order: on any major,
 * from `WORK_DOWNLOAD_SINCE` on, because that order's name and shape never
 * change across majors either.
 */
export function takesDownload(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, WORK_DOWNLOAD_SINCE);
}

/**
 * The first contract whose home reads the asking computer's `system` and
 * `chip` where it gets Firstmate (`fetchAppRequestSchema`, src/shared/connection.ts):
 * it answers the Firstmate published for them. An older home refuses them as
 * `malformed`, so a computer names them only to a home on this contract or later.
 */
export const FETCH_APP_SYSTEM_SINCE = "5.1.0";

/** Whether a home reads the asking computer's system where it gets Firstmate (`FETCH_APP_SYSTEM_SINCE`). */
export function readsFetchAppSystem(homeVersion: string): boolean {
  return speaksSince(homeVersion, FETCH_APP_SYSTEM_SINCE);
}

/**
 * The first contract whose home answers the native scene's reads,
 * `inf:conversation:state` and `inf:computers:presence`, without naming
 * `native-scene-observations`: major 12 folded that name in. A phone asks an
 * older home for them only when its welcome names the change (docs/ios.md).
 */
export const SCENE_OBSERVATIONS_SINCE = "12.0.0";

/** Whether a computer takes a task with no project (`PLACED_SEED_SINCE`). */
export function speaksSeed(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, PLACED_SEED_SINCE);
}

/** Whether a computer gives its crewmates the home's knowledge (`KNOWLEDGE_THERE_SINCE`). */
export function speaksKnowledge(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, KNOWLEDGE_THERE_SINCE);
}

/** Whether a computer speaks the custom API sign-in orders. */
export function speaksCustomApi(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, CUSTOM_API_SIGN_INS_SINCE);
}

/** Whether a work computer answers bounded, read-only resource observations. */
export function speaksResources(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, RESOURCE_OBSERVATIONS_SINCE);
}

/**
 * The first contract a computer that runs work knows the code names of the
 * Infinitary rename on (step 8 of FI3-1780's plan): a task's starting work
 * fetched into `refs/infinitary/sources/`, from a kept ref under
 * `refs/infinitary/kept/` (`inf:working-copy:source-ref`, src/shared/work.ts).
 * One that speaks an older one knows only Firstmate 3000's names (`refs/fm3000/`),
 * so the home names those to it. The browser command is not
 * swapped: `fm-browser-axi`, Firstmate 3000's command, stays an alias of
 * `infinitary-browser-axi` (src/core/axi/names.ts).
 */
export const INFINITARY_NAMES_SINCE = "8.4.0";

/** A copy order may refresh the executing computer's client-owned session tail first. */
export const SESSION_RECORD_REFRESH_SINCE = "8.15.0";

export function speaksRecordRefresh(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, SESSION_RECORD_REFRESH_SINCE);
}

/** Whether a computer knows the Infinitary rename's code names (`INFINITARY_NAMES_SINCE`). */
export function speaksInfinitaryNames(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, INFINITARY_NAMES_SINCE);
}

/**
 * The first contract whose home keeps a preview's project fonts
 * (`inf:work:typeface`, src/shared/work.ts; docs/card-authoring.md "Fonts by
 * reference") and serves them to its views (`inf:cards:typeface`). A computer
 * that runs work sends a card naming one only to a home on this contract or
 * later, and refuses it in words to an older one.
 */
export const CARD_TYPEFACES_SINCE = "8.9.0";

/** Whether a home keeps a preview's project fonts (`CARD_TYPEFACES_SINCE`). */
export function keepsCardTypefaces(homeVersion: string): boolean {
  return speaksSince(homeVersion, CARD_TYPEFACES_SINCE);
}

/**
 * The first contract whose home changes the words around a published story
 * (`open_change`'s optional `around`, docs/forge.md "Saved change stories").
 * An older home drops the field and would answer as if nothing was asked, so
 * a computer that runs work refuses it in words to that home instead.
 */
export const STORY_AROUND_SINCE = "10.1.0";

/** Whether a home changes the words around a published story (`STORY_AROUND_SINCE`). */
export function changesStoryAround(homeVersion: string): boolean {
  return speaksSince(homeVersion, STORY_AROUND_SINCE);
}

/**
 * The first contract whose home hears a background job's end as `client`
 * (`inf:work:job-exit`, src/shared/work.ts): a Claude client that ended
 * while the computer running it ran on took the task with it. A computer
 * says so only to a home it does not know is older, which reads the
 * request strictly; to that one it says the end without why.
 */
export const CLIENT_JOB_ENDS_SINCE = "9.2.0";

/** Whether a home hears a job's end as its Claude client's (`CLIENT_JOB_ENDS_SINCE`). */
export function hearsClientJobEnds(homeVersion: string): boolean {
  return speaksSince(homeVersion, CLIENT_JOB_ENDS_SINCE);
}

/**
 * The first contract whose work computer removes a closed task's temporary
 * folder on `inf:session:clean-temp`. An older computer is not reported as
 * cleaned; the home retries after it is updated.
 */
export const TEMP_CLEANUP_SINCE = "7.1.0";

/** Whether a work computer removes a closed task's temporary folder. */
export function speaksTempCleanup(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, TEMP_CLEANUP_SINCE);
}

export function speaksSince(deviceVersion: string, sinceVersion: string): boolean {
  const device = versionOf(deviceVersion);
  const since = versionOf(sinceVersion);
  if (!device || !since) return false;
  return (
    device.major > since.major || (device.major === since.major && device.minor >= since.minor)
  );
}

/**
 * Whether a computer that runs work may take new work from its home
 * (docs/helper.md): only on the home's own major, and only when it speaks
 * `PLACED_WORK_SINCE` or later, so it can hold the work it is sent. The home
 * sends it the work itself, so the version rule's wider window for a client
 * does not apply; a computer on another major takes no new work until it is
 * replaced with the home's version. A version that does not read as
 * `major.minor.patch` takes none.
 */
export function takesWork(deviceVersion: string, homeVersion: string = PROTOCOL_VERSION): boolean {
  const device = versionOf(deviceVersion);
  const since = versionOf(PLACED_WORK_SINCE);
  if (!device || !since) return false;
  return (
    device.major === majorOf(homeVersion) &&
    (device.major > since.major || (device.major === since.major && device.minor >= since.minor))
  );
}

function majorOf(version: string): number {
  return versionOf(version)?.major ?? Number.NaN;
}

function versionOf(version: string): { major: number; minor: number } | undefined {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

/** Which side of the core/host line a channel belongs to. */
export type ChannelSurface = "core" | "host";

/**
 * Who may ask a core channel: a paired view as well as this Mac, this Mac
 * alone, or a computer that runs work alone.
 */
export type ChannelReach = "views" | "home" | "work";

/**
 * The window's own buttons where the app draws them (design skill readme,
 * "Linux desktop conventions"): minimize, maximize or restore, and close.
 */
/** `front` brings the window ahead of other apps, as when a sign-in in the browser finishes (INF-838). */
export const windowControlSchema = z.enum(["minimize", "maximize", "close", "front"]);
export type WindowControl = z.infer<typeof windowControlSchema>;

/** Whether the window fills the screen, so its middle button reads Restore. */
export const windowStateSchema = z.strictObject({ maximized: z.boolean() });
export type WindowState = z.infer<typeof windowStateSchema>;

/**
 * What this home serves beyond its channel set, by name, so a client hides
 * what a home lacks instead of reasoning about version numbers. A client
 * ignores a name it does not know. `connection`: paired devices reach this
 * home over the connection, with numbered pushes and catch-up after a drop
 * (docs/connection.md).
 */
export const HOME_CAPABILITIES = ["connection"] as const;

export const appInfoSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  platform: z.string(),
  /** The contract version this app speaks; see PROTOCOL_VERSION. */
  protocolVersion: z.string(),
  /** See HOME_CAPABILITIES; open names, so a newer home's list still parses. */
  capabilities: z.array(z.string().min(1).max(64)).max(64),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

type ChannelDeclaration = {
  effect: "read" | "change";
  request: z.ZodType;
  response: z.ZodType;
} & ({ surface: "core"; reach: ChannelReach } | { surface: "host"; reach?: never });

const pastedFilesSchema = z
  .array(
    z.object({
      /** The file's display name when the text came from a dropped or chosen file. */
      name: z.string().max(120).optional(),
      text: z
        .string()
        .refine((text) => new TextEncoder().encode(text).length <= PASTE_FILE_MAX_BYTES),
    }),
  )
  .max(PASTE_FILES_MAX);

const okSchema = z.object({ ok: z.literal(true) });

export const invokeContract = {
  "inf:app:healthcheck": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: appInfoSchema,
  },
  "inf:converse": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.union([
        z.string().min(1).max(CONVERSE_TEXT_MAX_CHARS),
        z.object({
          text: z.string().min(0).max(CONVERSE_TEXT_MAX_CHARS).optional(),
          files: pastedFilesSchema.optional(),
          images: z
            .array(
              z.object({
                mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
                // Base64 without the data: prefix; the cap mirrors the 5MB
                // paste limit in VoiceInput (5MB binary ~ 6.9MB base64).
                data: z.string().min(1).max(7_500_000),
                name: z.string().max(120).optional(),
              }),
            )
            .max(TURN_IMAGES_MAX)
            .optional(),
          /** The card currently on screen, if any. A hint, not the topic. */
          visibleCardId: z.string().min(1).max(128).optional(),
          /**
           * The task the open record card points at (task-system P1/P4): the
           * same kind of hint as the card, filled by the renderer the way
           * visibleCardId is. Never the topic by itself.
           */
          taskId: z.string().min(1).max(64).optional(),
          /**
           * The past card shown on the stage (FI3-579): a closed card read
           * as history. A hint like the card, never the topic by itself.
           */
          pastCardId: z.string().min(1).max(128).optional(),
          /**
           * The project the window is focused on (the top bar's project
           * pill, docs/project-focus.md): a hint below a shown record.
           */
          focusedProjectId: z.string().min(1).max(64).optional(),
        }),
      ]),
    ]),
    response: okSchema,
  },
  // The conversation owner's current busy state, before the view hears live state changes.
  "inf:conversation:state": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.object({ busy: z.boolean() }),
  },
  // The last turn above the input (docs/composer.md "The last turn"): the
  // captain's newest message and the Firstmate's reply line kept beside it,
  // with the round before it (`previous`), read once as the window opens; `user_turn` and `firstmate_reply` carry
  // it after that.
  "inf:conversation:last-turn": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: lastTurnSchema.nullable(),
  },
  "inf:task:abort": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: okSchema,
  },
  "inf:task:delete": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: okSchema,
  },
  // The Crewmate tab's composer (docs/task-card-tabs.md, "Typing"): a line
  // the captain typed is his steer on the crewmate's own lane, and ⌃C or
  // Stop is his interrupt of its running turn. A refusal comes back as
  // text and writes nothing.
  "inf:task:steer": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(CARD_REPLY_MAX_CHARS)]),
    response: crewSendResultSchema,
  },
  "inf:task:interrupt": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: crewSendResultSchema,
  },
  // The task record's footer and the task board: start, stop, continue, or
  // drop never-started work, and the board's queue and unqueue of it. Drop
  // sends the effects the captain reviewed; a refusal of drop, queue or
  // unqueue comes back as text and writes nothing. A start refused at once
  // comes back as text and a feed line; stop and continue refuse as a feed
  // line. A move a panel made on the captain's click names that panel, so
  // the task's record says where it came from (docs/ui-plugins.md).
  "inf:task:run": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string().min(1).max(64),
      taskLifecycleOpSchema,
      dropTaskReviewSchema.optional(),
      taskMoveFromSchema.optional(),
    ]),
    response: z.discriminatedUnion("ok", [
      okSchema,
      z.object({ ok: z.literal(false), text: z.string().min(1) }),
    ]),
  },
  // Setup, policy and removal share the action catalog with Settings.
  "inf:repos:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(repoViewSchema),
  },
  "inf:repos:setup": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([repoSetupSpecSchema]),
    response: repoSetupResultSchema,
  },
  // Tasks still on a project: the one guard behind removal, read up front.
  "inf:repos:removal": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1)]),
    response: repoRemovalSchema,
  },
  "inf:repos:remove": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1)]),
    response: z.object({ id: z.string(), name: z.string() }),
  },
  "inf:repos:configure": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1), repoPolicyPatchSchema]),
    response: repoViewSchema,
  },
  // Where new projects go (Settings -> Projects): the folder clone and init
  // create their directories in. Null puts it back to the app's own fleet
  // root; projects already set up never move.
  "inf:repos:folder": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: projectsFolderViewSchema,
  },
  "inf:repos:folder:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(4096).nullable()]),
    response: projectsFolderViewSchema,
  },
  // Shared live observations carry no sign-in or device-management authority.
  "inf:computers:presence": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(computerPresenceSchema),
  },
  "inf:computers:resources": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: computerResourcesSchema,
  },
  // Devices and pairing (docs/devices.md). Home only: a paired view cannot
  // list, invite or remove, so a lost Mac cannot add another. The invite's
  // answer carries the link, for this Mac's own window alone.
  "inf:devices:list": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.array(deviceViewSchema),
  },
  "inf:devices:invite": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([deviceInviteRequestSchema]),
    response: deviceInviteSchema,
  },
  // Adding a Mac by its address over Remote Login (docs/devices.md, "Adding
  // a computer by its address"): the captain's own click in Settings -> Devices,
  // never the Firstmate's, which only offers the card whose button does it.
  // It answers once the Mac joined, or rejects with the refusal's words; each
  // step is a `device_setup` feed line. A Mac this Mac has not checked answers
  // the check line first, and nothing is sent until the captain says this is
  // the Mac (`confirm`). A Mac whose user runs another Firstmate's work answers
  // the question asked once, with nothing sent there; `leave` is the captain's
  // yes to it ("Another first mate's Mac"). A Mac that did not let the captain's
  // key in answers the password question, and `password`, typed once, lets
  // Firstmate's own key in there; it is never kept ("The password, once").
  "inf:devices:add": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([remoteLoginAddressSchema, remoteLoginAddOptionsSchema.optional()]),
    response: remoteLoginAddAnswerSchema,
  },
  // Macs nearby (docs/devices.md, "Macs nearby"): while "By its address"
  // is open, this Mac listens for Remote Login's Bonjour announcement and
  // lists each Mac that answers, never trying an address. `true` looks, or
  // keeps looking for another minute; `false` stops. The whole list comes
  // again on `inf:devices:nearby` whenever it reads differently.
  "inf:devices:nearby": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.boolean()]),
    response: nearbyMacsViewSchema,
  },
  // Updates Firstmate on a computer that runs work to this Mac's version
  // (docs/devices.md, "Updating"): over Remote Login for one added by its
  // address, otherwise over the connection; each step is a feed line.
  "inf:devices:update": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([
      z.string().min(1).max(64),
      z
        .strictObject({
          password: z.string().min(1).max(1024).optional(),
        })
        .optional(),
    ]),
    response: z.union([
      deviceViewSchema,
      remoteLoginPasswordQuestionSchema,
      remoteLoginRefusedAnswerSchema,
    ]),
  },
  // A computer that runs work out of reach is removed when it is back, or
  // now, as the captain chose; with neither it is refused, so he is asked
  // (docs/devices.md, "Remove"). Keep it takes a wait for its return back.
  "inf:devices:remove": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), deviceRemoveWhenSchema.optional()]),
    response: deviceViewSchema,
  },
  "inf:devices:keep": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64)]),
    response: deviceViewSchema,
  },
  // Try again (docs/devices.md, "Through the home's SSH"): this Mac tries
  // its own SSH connection to a computer once now, or to every one it
  // stopped trying when none is named; answers how many it tried.
  "inf:devices:try-again": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64).optional()]),
    response: z.strictObject({ tried: z.number().int().nonnegative() }),
  },
  // Change address (docs/devices.md, "Changing its address"): the captain's
  // own click reaches a computer this Mac reaches over its own SSH at
  // another address, once a look there finds that same computer.
  "inf:devices:change-address": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), remoteLoginAddressSchema]),
    response: z.union([deviceViewSchema, remoteLoginRefusedAnswerSchema]),
  },
  // Every build offers Devices, including a phone, on the home computer.
  "inf:devices:shown": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.object({ shown: z.boolean() }),
  },
  // Stop it: closes an open link by its handle before it expires.
  "inf:devices:stop": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64)]),
    response: okSchema,
  },
  // Where devices find this Mac: its own private addresses and the one a
  // link sends a device to. Choosing one is the captain's, in Settings.
  "inf:devices:addresses": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: deviceAddressesSchema,
  },
  "inf:devices:address:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64).nullable()]),
    response: deviceAddressesSchema,
  },
  // Where a project's next task starts (docs/helper.md, "Runs on"): a paired
  // computer that runs work by its id, or null for this Mac. Home only, and
  // refused where this build offers no devices (docs/devices.md); a task
  // already started finishes where it started.
  "inf:devices:runs-on": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1), z.string().min(1).max(64).nullable()]),
    response: repoViewSchema,
  },
  // A computer that runs work signs in to its own subscriptions (docs/helper.md,
  // "Its own sign-ins"): Settings -> Intelligence starts the sign-in there and
  // draws it here. Home only, like every sign-in. The answer to a prompt is
  // what the captain typed; it goes to that computer once and is kept
  // nowhere here.
  "inf:devices:sign-ins": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.array(deviceSignInsSchema),
  },
  "inf:devices:sign-in": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([
      z.string().min(1).max(64),
      z.string().min(1).max(256),
      z.enum(["oauth", "api_key"]),
      z.string().min(1).max(256).optional(),
    ]),
    response: z.object({ signInId: signInIdSchema }),
  },
  "inf:devices:sign-in:answer": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([
      signInIdSchema,
      z.string().min(1).max(128),
      z.string().max(SIGN_IN_ANSWER_MAX_CHARS).nullable(),
    ]),
    response: okSchema,
  },
  "inf:devices:sign-in:cancel": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([signInIdSchema]),
    response: okSchema,
  },
  "inf:devices:sign-out": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(256)]),
    response: okSchema,
  },
  // Its own sign-in where projects live, for its clones and pushes
  // (docs/forge.md, "A computer's own sign-in"): Settings -> Projects starts
  // GitHub's device flow there, its code to read rides `inf:devices:sign-in`,
  // and `inf:devices:sign-in:cancel` stops it. Nothing is typed.
  "inf:devices:forge-sign-in": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), forgeHostSchema]),
    response: z.object({ signInId: signInIdSchema }),
  },
  "inf:devices:forge-sign-out": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), forgeHostSchema]),
    response: okSchema,
  },
  // A custom API connection on a computer that runs work. The form is drawn
  // here; that computer reads the address, checks each model and keeps the
  // key. The key and headers ride once inside connect and are kept nowhere
  // here. A computer older than CUSTOM_API_SIGN_INS_SINCE refuses them.
  "inf:devices:custom:address": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), z.string().max(4096)]),
    response: customApiAddressSchema,
  },
  "inf:devices:custom:profiles": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64)]),
    response: z.array(customCapabilityProfileSchema),
  },
  "inf:devices:custom:review": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([
      z.string().min(1).max(64),
      z.string().max(4096),
      customNetworkModeSchema,
      z.string().max(65536).optional(),
    ]),
    response: customApiReviewSchema,
  },
  "inf:devices:custom:connect": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), customApiConnectInputSchema]),
    response: customApiConnectResultSchema,
  },
  "inf:devices:custom:check": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([
      z.string().min(1).max(64),
      z.string().min(1).max(128),
      z.string().min(1).max(256),
    ]),
    response: customApiViewSchema,
  },
  "inf:devices:custom:discover": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(128)]),
    response: z.array(customListedModelSchema),
  },
  "inf:devices:custom:cancel": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(128)]),
    response: okSchema,
  },
  "inf:devices:custom:save": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(128), z.boolean()]),
    response: customApiViewSchema,
  },
  "inf:devices:custom:recheck": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(256)]),
    response: customApiViewSchema,
  },
  // What this app is on its Mac (docs/view.md): the Mac that holds Firstmate,
  // or the app controlling Firstmate on another Mac and how well it hears
  // it. The shell answers it, and pushes it whole on every change.
  "inf:devices:this-mac": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: thisMacSchema,
  },
  // Joins Firstmate on another Mac with a link its person pasted at this
  // app's first launch, after they confirmed it. On success the shell stops
  // this Mac's own Firstmate and the window starts over as the other Mac's.
  "inf:devices:join": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(1024)]),
    response: joinOutcomeSchema,
  },
  // Leave: this Mac stops controlling the other one and returns to its own
  // first launch, telling that Mac first when it is in reach.
  "inf:devices:leave": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: okSchema,
  },
  "inf:cards:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: cardsSnapshotSchema,
  },
  // The last argument of act, close and reply is the shell's submission
  // metadata (`CardSubmission`): the gesture's id and the offer it had
  // mounted. The core reads it leniently and only records it
  // (docs/card-evidence.md), so metadata it cannot read never refuses a
  // choice; the wire takes it as it comes.
  "inf:cards:act": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string(),
      z.string(),
      cardActionSourceSchema,
      z.unknown().optional(),
      z.unknown().optional(),
    ]),
    response: z.object({ effect: shellEffectSchema.optional(), refusal: z.string().optional() }),
  },
  "inf:cards:minimize": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.boolean()]),
    response: okSchema,
  },
  "inf:cards:show": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: z.union([cardSchema, pastCardSchema]),
  },
  "inf:cards:close": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string(), z.unknown().optional()]),
    response: okSchema,
  },
  // The stage showed the captain this version of the card - shown, the
  // window visible and focused (1.48.0). The core records it once and
  // compares the card's next revision with it (`Card.changes`); a version
  // the stage no longer shows is ignored.
  "inf:cards:seen": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().max(256), z.string().max(64)]),
    response: okSchema,
  },
  // The card's thread (cards-as-threads phase 1): read it once when the
  // card comes up, then follow the `inf:cards:thread` push.
  "inf:cards:thread": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: cardThreadSchema,
  },
  // A card picture's bytes by its file name (docs/view.md): how a view shows
  // the home's own copy of a picture a card names, which its frame asks of
  // the view's own shell. The name is the one the home minted
  // (`@shared/cardPictures`); anything else is refused.
  "inf:cards:picture": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(128)]),
    response: z.object({
      contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      /** The file, base64. */
      data: z.string(),
    }),
  },
  // A project font's bytes by its file name (docs/view.md): how a view draws
  // a preview in the home's own copy of a font its `@font-face` names, which
  // its frame asks of the view's own shell. Only a minted font name
  // (`@shared/cardPictures`); anything else is refused.
  "inf:cards:typeface": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(128)]),
    response: z.object({
      contentType: z.enum([
        CARD_TYPEFACE_TYPES.woff2,
        CARD_TYPEFACE_TYPES.woff,
        CARD_TYPEFACE_TYPES.ttf,
        CARD_TYPEFACE_TYPES.otf,
      ]),
      /** The file, base64. */
      data: z.string(),
    }),
  },
  // A piece of a card's demo recording by its file name (docs/view.md): how
  // a view plays the home's own copy, a range at a time, in its picture
  // viewer. Only a minted recording name, at most `CARD_MEDIA_PIECE_BYTES`
  // from an offset; the answer says the whole file's size. An empty piece
  // asks for the size alone.
  "inf:cards:media": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string().min(1).max(128),
      z.number().int().nonnegative(),
      z.number().int().nonnegative().max(CARD_MEDIA_PIECE_BYTES),
    ]),
    response: z.object({
      contentType: z.enum([CARD_MEDIA_TYPES.mp4, CARD_MEDIA_TYPES.gif]),
      /** The whole file's size in bytes. */
      size: z.number().int().nonnegative(),
      /** The piece, base64. */
      data: z.string(),
    }),
  },
  // A closed card as the captain last saw it (FI3-579 piece 2): a pure
  // read, null for a card that is open or unknown.
  "inf:cards:past": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string()]),
    response: pastCardSchema.nullable(),
  },
  // Bring a closed card forward as the read-only past card on every window's
  // stage (FI3-579 piece 4). The one door the Cards row, the filter and the
  // Firstmate (catalog action show-card) share: it saves nothing, raises no
  // card and runs no effect; an open or unknown card is refused in words.
  "inf:cards:show-past": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(128)]),
    response: pastCardSchema,
  },
  // The captain's click on a card's page from its task's project
  // (docs/task-browser.md, "A page from the project"): the core reads the
  // path off the card's own attachment, checks the file inside the project
  // folder again and opens it in the task's own browser with the captain in
  // control, answering which browser for the view. It never answers the
  // card. The project folder is this Mac's, so a view is refused.
  "inf:cards:open-page": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(128)]),
    response: z.object({
      refusal: z.string().optional(),
      browser: taskBrowserHandleSchema.optional(),
    }),
  },
  // The captain's reply, verbatim. The core decides where it goes - a
  // crewmate card's reply is a captain steer to that crewmate, a Firstmate
  // card's is a captain turn about that card - and returns the thread as it
  // now stands, so the sent message paints without a race. Images ride as
  // they do on converse (1.19.0).
  "inf:cards:reply": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([
      z.string(),
      z.union([
        z.string(),
        z.object({
          text: z.string().max(CARD_REPLY_MAX_CHARS).optional(),
          files: pastedFilesSchema.optional(),
          images: z.array(turnImageSchema).max(TURN_IMAGES_MAX).optional(),
          answers: cardAnswersSchema.optional(),
        }),
      ]),
      z.unknown().optional(),
      // Read no more: a reply never moves its card. Kept so an older view's call still parses.
      z.boolean().optional(),
    ]),
    response: cardThreadSchema,
  },
  "inf:auth:providers": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.array(providerViewSchema),
  },
  "inf:auth:prompt-reply": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), z.string().nullable()]),
    response: okSchema,
  },
  // Stops every sign-in this Mac's window started and is still waiting on,
  // wherever it waits: a prompt, a browser, or a code being polled. The
  // stopped add or sign-in rejects, and nothing is added (INF-838).
  "inf:auth:cancel": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: okSchema,
  },
  // The account broker: N accounts per provider, each an isolated store.
  // Built-in sign-in runs the provider's own flow. Custom preparation sends
  // an opaque key once to its owner; no response schema returns credentials.
  "inf:accounts:custom:profiles": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.array(customCapabilityProfileSchema),
  },
  "inf:accounts:custom:review": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), customNetworkModeSchema, z.string().optional()]),
    response: customApiReviewSchema,
  },
  // The address's canonical form and the network its name points to now; DNS only.
  "inf:accounts:custom:address": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().max(4096)]),
    response: customApiAddressSchema,
  },
  // Save's and Fetch's one step: the network read, a draft and the server's
  // model list, with each failure as a category rather than thrown text.
  "inf:accounts:custom:connect": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([customApiConnectInputSchema]),
    response: customApiConnectResultSchema,
  },
  "inf:accounts:custom:prepare": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([customApiInputSchema]),
    response: customApiViewSchema,
  },
  "inf:accounts:custom:check": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), z.string()]),
    response: customApiViewSchema,
  },
  "inf:accounts:custom:discover": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: z.array(customListedModelSchema),
  },
  "inf:accounts:custom:cancel": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: okSchema,
  },
  "inf:accounts:custom:save": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), z.boolean()]),
    response: customApiViewSchema,
  },
  // A saved connection's one fresh check, once its saved checks no longer
  // count (an earlier version's): the first-launch gate asks for it in place.
  "inf:accounts:custom:recheck": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: customApiViewSchema,
  },
  "inf:accounts:custom:list": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.array(customApiViewSchema),
  },
  "inf:accounts:list": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.array(accountViewSchema),
  },
  // The third part is the GitHub Enterprise host a Copilot sign-in goes to,
  // as typed; absent is github.com (INF-838).
  "inf:accounts:add": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([
      z.string(),
      z.enum(["oauth", "api_key"]),
      z.strictObject({ enterpriseHost: z.string().min(1).max(253) }).optional(),
    ]),
    response: accountViewSchema,
  },
  "inf:accounts:sign-in": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: accountViewSchema,
  },
  "inf:accounts:remove": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: okSchema,
  },
  "inf:accounts:rename": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), z.string().min(1).max(ACCOUNT_LABEL_MAX)]),
    response: okSchema,
  },
  "inf:accounts:set-enabled": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), z.boolean()]),
    response: okSchema,
  },
  "inf:accounts:pin": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), z.string().nullable()]),
    response: okSchema,
  },
  // The app's own sign-ins where projects live (git integration PR 1.2,
  // docs/forge.md): optional, one per host. Sign-in starts the host's
  // device flow and answers with the code; how it ends rides `inf:forges`.
  // No schema here carries a secret.
  "inf:forges:list": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: forgesViewSchema,
  },
  "inf:forges:projects": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(253)]),
    response: z.array(forgeProjectSchema),
  },
  "inf:forges:sign-in": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(253)]),
    response: forgeSignInFlowSchema,
  },
  // A public application registered on the chosen host; no application secret.
  "inf:forges:sign-in-browser": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([forgeBrowserSignInSchema]),
    response: forgeSignInFlowSchema,
  },
  // A host on the person's own server (GitHub Enterprise) signs in with a
  // key the person made there: this request hands it to the core once,
  // which checks it with the host before keeping it. The one request here
  // that carries a secret; nothing hands it back.
  "inf:forges:sign-in-key": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([forgeKeySignInSchema]),
    response: forgeKeySignInResultSchema,
  },
  // A GitHub host signed in through the person's own GitHub CLI: the core
  // asks GitHub CLI for its sign-in and the host who that is, and keeps
  // only the way and the program's path (docs/forge.md, "GitHub CLI's
  // sign-in"). The address is github.com or a GitHub Enterprise host's.
  "inf:forges:sign-in-cli": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(2000)]),
    response: forgeCliSignInResultSchema,
  },
  "inf:forges:cancel": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: forgesViewSchema,
  },
  "inf:forges:sign-out": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(253)]),
    response: forgesViewSchema,
  },
  // The person's open proposed changes where their projects live, read
  // with the app's sign-in: the `forge.changes` panel read.
  "inf:forges:changes": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: forgeChangesViewSchema,
  },
  // Integrations (docs/integrations.md): connections outside the person's
  // projects the first mate and the crew reach. A connection is made by
  // its kind's own sign-in (GitHub's is `inf:forges:sign-in`, Google's
  // `inf:integrations:sign-in`), or added from the person's words (an MCP
  // server, `inf:integrations:add`); these
  // change its settings, forget it, or check it. Only `secret` carries a
  // value, the captain's own entry, and nothing hands it back.
  "inf:integrations:list": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: integrationsViewSchema,
  },
  "inf:integrations:configure": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([integrationIdSchema, integrationSettingsPatchSchema]),
    response: integrationsViewSchema,
  },
  "inf:integrations:rule": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([integrationIdSchema, integrationActionNameSchema, z.boolean()]),
    response: integrationsViewSchema,
  },
  "inf:integrations:remove": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([integrationIdSchema]),
    response: integrationsViewSchema,
  },
  "inf:integrations:check": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([integrationIdSchema]),
    response: integrationsViewSchema,
  },
  // A key the captain enters for one slot (docs/integrations.md, "Keys"),
  // or null to forget it. The answer says only whether each slot is kept.
  "inf:integrations:secret": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([
      integrationIdSchema,
      integrationSecretNameSchema,
      integrationSecretValueSchema.nullable(),
    ]),
    response: integrationsViewSchema,
  },
  "inf:integrations:add": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([integrationMcpAddSchema]),
    response: z.object({ id: integrationIdSchema, view: integrationsViewSchema }).strict(),
  },
  // Sign in to a kind that signs in in the person's browser (Google): the
  // answer comes once the browser is back, and the cancel ends the wait.
  // A kind with a notice needs its accept (INF-949), or nothing opens.
  "inf:integrations:sign-in": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([integrationKindSchema, integrationSignInConsentSchema.optional()]),
    response: z.object({ id: integrationIdSchema, view: integrationsViewSchema }).strict(),
  },
  "inf:integrations:sign-in-cancel": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: integrationsViewSchema,
  },
  // The inbox's one-click link of its command into /usr/local/bin
  // (docs/integrations.md, "The inbox"), only where that path is free and
  // the folder writable without an administrator.
  "inf:integrations:inbox-link": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: integrationsViewSchema,
  },
  "inf:settings:firstmate-account:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.string().nullable(),
  },
  "inf:settings:firstmate-account:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().nullable()]),
    response: z.string().nullable(),
  },
  "inf:quota:snapshot": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: quotaSnapshotViewSchema.nullable(),
  },
  "inf:quota:refresh": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: quotaSnapshotViewSchema.nullable(),
  },
  "inf:quota:models": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: modelsCatalogViewSchema.nullable(),
  },
  "inf:settings:routing:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: routingSettingsSchema,
  },
  "inf:settings:routing:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([routingSettingsSchema]),
    response: routingSettingsSchema,
  },
  "inf:settings:firstmate-model:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: piModelRefViewSchema.nullable(),
  },
  "inf:settings:firstmate-model:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([piModelRefViewSchema.nullable()]),
    response: piModelRefViewSchema.nullable(),
  },
  // The dev-only local seat (roadmap 1.7): a packaged build answers
  // `available: false` and refuses the write; docs/local-orchestrator.md.
  "inf:settings:local-orchestrator:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: localOrchestratorViewSchema,
  },
  "inf:settings:local-orchestrator:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([localOrchestratorSettingSchema]),
    response: localOrchestratorViewSchema,
  },
  "inf:models:available": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.array(piModelRefViewSchema),
  },
  "inf:models:slots": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: modelSlotsViewSchema,
  },
  "inf:models:slots:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    /** key, slot, on - adds or removes one slot from an offering's membership. */
    request: z.tuple([z.string(), slotSchema, z.boolean()]),
    response: modelSlotsViewSchema,
  },
  "inf:models:speed:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), crewSpeedSchema]),
    response: modelSlotsViewSchema,
  },
  "inf:models:reasoning:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), slotSchema, reasoningChoiceSchema.nullable()]),
    response: modelSlotsViewSchema,
  },
  "inf:models:slots:reset": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.union([z.tuple([]), z.tuple([z.string()])]),
    response: modelSlotsViewSchema,
  },
  // Decision models (S7b, design section 5.3). Four channels, and the
  // split between them is the point: the ROW travels on the first pair and
  // carries no secret, so it can be read, logged and pushed; the KEY has
  // its own write-only call and is never returned by any of them.
  "inf:settings:decisions": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: decisionsViewSchema,
  },
  "inf:settings:decisions:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([decisionsSettingsSchema]),
    response: decisionsViewSchema,
  },
  "inf:decisions:key:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    /** The user's own key, write-only: the response is the row's new state. */
    request: z.tuple([decisionModelIdSchema, z.string().min(1)]),
    response: decisionsViewSchema,
  },
  "inf:decisions:key:remove": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([decisionModelIdSchema]),
    response: decisionsViewSchema,
  },
  "inf:update:status": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: updateStatusSchema,
  },
  "inf:update:channel": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([updateChannelSchema]),
    response: updateStatusSchema,
  },
  "inf:update:open-release": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: okSchema,
  },
  // Installs the offered version where the app installs its own updates (a
  // deb, an rpm or an AppImage on Linux), then starts it; answers only when
  // it could not (docs/alpha.md "Updates on Linux"). An app controlling
  // another computer installs its own, never the other's.
  "inf:update:install": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: updateInstallResultSchema,
  },
  // The release notes the app showed, newest first, with the version running
  // now (docs/release-notes.md "Reading a note again"): what Settings lists
  // and what tells the window and the Help menu whether What's new can open one.
  // The home's own: a view runs a version of its own, so it asks neither.
  "inf:release-notes:list": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: releaseNotesViewSchema,
  },
  // What's new: brings a shown release note forward, the one for a named
  // version or else the newest that listed changes. An open note comes to the
  // front of the stack, a closed one comes back read-only as a past card; it
  // saves nothing and raises no card. No note yet is refused in words. The one
  // door the Help menu, command search, Settings and Firstmate share.
  "inf:release-notes:show": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64).nullable()]),
    response: shownReleaseNoteSchema.extend({ open: z.boolean() }),
  },
  "inf:presence:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: presenceSettingsSchema,
  },
  "inf:presence:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([presenceSettingsSchema]),
    response: presenceSettingsSchema,
  },
  "inf:retention:purge": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.object({ purgedTasks: z.number() }),
  },
  /**
   * What a purge clears beyond tasks: knowledge, where this build has it
   * (docs/knowledge.md); and the words from outside this build keeps for a
   * while, which Settings → General can delete on their own
   * (docs/task-retention.md, "Words from outside").
   */
  "inf:retention:scope": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.object({
      knowledge: z.boolean(),
      kept: z.array(keptOutsideDataSchema).optional(),
    }),
  },
  /**
   * Delete the words from outside every saved conversation on this
   * computer holds, now: a note takes their place, and a conversation
   * still working follows once it pauses (docs/task-retention.md, "Words
   * from outside").
   */
  "inf:retention:delete-outside": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: outsideDataDeletedSchema,
  },
  // Knowledge (docs/knowledge.md, "The browser"): whether this build keeps
  // it and whether there is any to show (`held`: an entry, or a collection
  // that cannot be read), which the window asks before it registers the
  // Knowledge panel, and the browser's reads, scoped as Firstmate's are.
  // Every build answers them (`knowledgeEnabled`,
  // src/core/knowledge/availability.ts). This Mac's own window only: a view
  // of another Mac reads none.
  "inf:knowledge:enabled": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.object({ enabled: z.boolean(), held: z.boolean() }),
  },
  "inf:knowledge:collections": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: knowledgeCollectionsSchema,
  },
  "inf:knowledge:graph": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeGraphArgsSchema]),
    response: knowledgeGraphSchema,
  },
  "inf:knowledge:concepts": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeConceptsArgsSchema]),
    response: knowledgeConceptsSchema,
  },
  "inf:knowledge:findings": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeFindingsArgsSchema]),
    response: knowledgeFindingsSchema,
  },
  "inf:knowledge:entry": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeEntryArgsSchema]),
    response: knowledgeEntryReadSchema,
  },
  // With no arguments, every scope's first page: the catalog's `direction`
  // line reads its current value so.
  "inf:knowledge:directions": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeDirectionsArgsSchema.optional()]),
    response: knowledgeDirectionsSchema,
  },
  "inf:knowledge:direction": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeDirectionArgsSchema]),
    response: knowledgeDirectionReadSchema,
  },
  // One change to a standing direction, the app action catalog's
  // `direction` line (src/shared/actions.ts): the captain's window and the
  // first mate's app_change ask it alike (docs/knowledge.md, "Directions are
  // the first mate's to keep").
  "inf:knowledge:direction:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeDirectionChangeSchema]),
    response: knowledgeDirectionChangedSchema,
  },

  // The entries a card body names, for its references, and what one task's
  // work declared it used, for its record (docs/knowledge.md, "References in
  // an answer" and "Knowledge used on a task"): scoped and refused as the
  // browser's reads are.
  "inf:knowledge:refs": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeRefsArgsSchema]),
    response: knowledgeRefsSchema,
  },
  "inf:knowledge:uses": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([knowledgeUsesArgsSchema]),
    response: knowledgeUsesSchema,
  },
  "inf:feed:recent": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(feedLineSchema),
  },
  "inf:crew:counts": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: crewCountsSchema,
  },
  // The task protocol (task-system P3, design section 9): the board a
  // late-attaching client resyncs from (live pushes ride inf:tasks), one
  // record in full, and the project index. Reads, plus opening a filing,
  // which clears its new mark. The record's lifecycle toggles ride
  // `inf:task:run`; every other write to a task happens by talking to the
  // Firstmate.
  "inf:tasks:board": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: taskBoardSchema,
  },
  "inf:tasks:detail": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: taskDetailSchema,
  },
  // The task card's Crewmate tab (docs/task-card-tabs.md, "The Crewmate
  // tab"): the crewmate's sessions read as a transcript, its running turn's
  // words that its session does not hold yet, and one call's whole result
  // or one picture it holds, read when the tab opens or shows it.
  "inf:tasks:crewmate": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: crewTranscriptSchema,
  },
  "inf:tasks:crewmate:live": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: crewLiveSchema,
  },
  "inf:tasks:crewmate:result": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(512)]),
    response: crewResultTextSchema.nullable(),
  },
  "inf:tasks:crewmate:picture": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64), z.string().min(1).max(512)]),
    response: crewPictureSchema.nullable(),
  },
  // Closed work the board no longer lists, found by typed text (FI3-579
  // piece 3): the Tasks filter's "earlier" group. Empty text finds nothing.
  "inf:tasks:search": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().max(200)]),
    response: z.array(taskViewSchema),
  },
  // Opening a filing clears its new mark (quiet ledger). Not a verdict.
  "inf:tasks:opened": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1).max(64)]),
    response: z.object({ opened: z.boolean() }),
  },
  // A task's own browser, from the captain's view of it (docs/task-browser.md,
  // "The view"): Stop browser, and Open again on a stopped one. The browser
  // is this Mac's, so no paired device asks; refused in words when it cannot.
  "inf:browser:stop": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64)]),
    response: taskBrowserCommandResultSchema,
  },
  "inf:browser:reopen": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64)]),
    response: taskBrowserCommandResultSchema,
  },
  // The captain's Take control and Return control (docs/task-browser.md,
  // "Taking control"), naming the browser his view shows; this Mac's window
  // alone may ask, as with Stop browser.
  "inf:browser:take": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(64), taskBrowserHandleSchema]),
    response: taskBrowserCommandResultSchema,
  },
  "inf:browser:return": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([
      z.string().min(1).max(64),
      taskBrowserHandleSchema,
      taskBrowserReturnSchema.optional(),
    ]),
    response: taskBrowserCommandResultSchema,
  },
  // The website sign-ins saved on this Mac for task browsers, and the
  // captain's Remove in Settings (docs/task-browser.md, "Saved sign-ins").
  // They are this Mac's own, so no paired device asks.
  "inf:browser:sign-ins": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: savedSignInsViewSchema,
  },
  "inf:browser:sign-ins:automatic": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(260), z.string().min(1), z.boolean()]),
    response: taskBrowserCommandResultSchema,
  },
  "inf:browser:sign-ins:remove": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string().min(1).max(260)]),
    response: taskBrowserCommandResultSchema,
  },
  "inf:projects:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.array(projectViewSchema),
  },
  // The captain's presentation choices, held by the core so a fresh window
  // profile cannot forget them (src/shared/preferences.ts).
  "inf:settings:appearance:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: appearanceSchema,
  },
  "inf:settings:appearance:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([appearanceSchema]),
    response: appearanceSchema,
  },
  "inf:settings:layout:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: layoutSchema,
  },
  "inf:settings:layout:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([layoutSchema]),
    response: layoutSchema,
  },
  // The host-owned switch over the captain's own panels (talk-to-personalize
  // Step 5). Only the window writes it, and only `enabled`: the reason is
  // the core's - `captain` here, `safe-mode` when a boot decides it.
  "inf:settings:panels:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.boolean()]),
    response: personalPanelsSchema,
  },
  // Every preference as ONE value, the `shell.preferences` read
  // (talk-to-personalize Step 1): what the host applies to the window on
  // the captain's behalf, pushed whole on every write, whoever wrote it.
  "inf:shell:preferences": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: shellPreferencesSchema,
  },
  // The two switches (roadmap 1.4, `src/shared/sharing.ts`): what may leave
  // this machine for us. The window sets a switch, says the payload was
  // viewed, reads the payload, and answers the one-time ask; every write
  // pushes the whole view as `inf:sharing`.
  "inf:settings:sharing:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: sharingViewSchema,
  },
  "inf:settings:sharing:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([sharingChannelSchema, z.boolean()]),
    response: sharingViewSchema,
  },
  "inf:settings:sharing:viewed": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([sharingChannelSchema]),
    response: sharingViewSchema,
  },
  "inf:settings:sharing:preview": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: sharingPreviewSchema,
  },
  "inf:settings:sharing:ask": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([sharingAskAnswerSchema]),
    response: sharingViewSchema,
  },
  "inf:settings:dictation:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: dictationSettingsSchema,
  },
  "inf:settings:dictation:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([dictationSettingsSchema]),
    response: dictationSettingsSchema,
  },
  "inf:settings:runbooks:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.array(runbookViewSchema),
  },
  "inf:settings:runbooks:copy": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), z.string(), z.string().min(1)]),
    response: z.array(runbookViewSchema),
  },
  "inf:settings:runbooks:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string(), z.boolean()]),
    response: z.array(runbookViewSchema),
  },
  "inf:settings:personal-resources:get": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.boolean(),
  },
  "inf:settings:personal-resources:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.boolean()]),
    response: z.boolean(),
  },
  // A view of this Mac follows the switch for its own notifications (docs/view.md).
  "inf:settings:notifications:get": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.boolean(),
  },
  "inf:settings:notifications:set": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([z.boolean()]),
    response: z.boolean(),
  },
  // The first launch (docs/first-launch.md): whether the stage carries the
  // gate, and the two once-only moments the input's hint follows.
  "inf:app:first-run": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: firstRunViewSchema,
  },
  // A crewmate state word was shown in full (docs/first-launch.md "The
  // crewmate's state words"): written once, never overwritten.
  "inf:app:first-run:crew-word": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([crewWordSchema]),
    response: firstRunViewSchema,
  },
  // Card-body links and similar: https anywhere, http loopback only.
  // Does not widen the window-open github allowlist.
  "inf:app:open-external": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(4096)]),
    response: okSchema,
  },
  // A window command the main process runs (the size keys), chosen by name
  // in command search (docs/keyboard.md): the same handler its key runs.
  "inf:keyboard:run": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.enum(MAIN_COMMAND_IDS as [MainCommandId, ...MainCommandId[]])]),
    response: okSchema,
  },
  // The keys the window has installed, and what of them a person changed
  // (docs/keyboard.md). They are this Mac's own, so no paired device asks.
  "inf:keyboard:keymap": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: keymapSnapshotSchema,
  },
  // Saves the keys a person changed and installs them, whole, or refuses
  // with the reason and installs nothing.
  "inf:keyboard:save": {
    effect: "change",
    surface: "host",
    request: z.tuple([savedKeymapSchema]),
    response: keymapSnapshotSchema,
  },
  // The panels' commands the window has now (docs/keyboard.md, "A panel's
  // commands"): installed with the catalog's, each suggested key given only
  // where nothing else uses it. Answers the installed keys.
  "inf:keyboard:panels": {
    effect: "change",
    surface: "host",
    request: z.tuple([panelCommandsSchema]),
    response: keymapSnapshotSchema,
  },
  // Keyboard settings records a key: while on, the window's keys run
  // nothing and each key pressed comes back as `inf:keyboard:recorded`.
  "inf:keyboard:record": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.boolean()]),
    response: okSchema,
  },
  // The window's own buttons where the app draws them (design skill readme,
  // "Linux desktop conventions"): minimize, maximize or restore - one button
  // that toggles - and close. Answers the asking window's state after it.
  "inf:window:control": {
    effect: "change",
    surface: "host",
    request: z.tuple([windowControlSchema]),
    response: windowStateSchema,
  },
  "inf:window:state": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: windowStateSchema,
  },
  // The system's folder picker, opened at a starting folder when given:
  // the chosen folder's path, or null when the person cancels. Choosing
  // writes nothing; the caller saves the pick through its own channel.
  "inf:app:choose-folder": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(4096).optional()]),
    response: z.string().nullable(),
  },
  // A File the captain dropped on an input: where it lives on disk, read by
  // the shell's own `webUtils.getPathForFile` in the preload (never a path
  // the page names), and whether it is a regular file. Nothing is read.
  "inf:files:inspect": {
    effect: "read",
    surface: "host",
    request: z.tuple([z.string().max(4096)]),
    response: droppedPathSchema,
  },
  // The system's file picker (any file, several at once): each choice comes
  // back read as far as its class allows - a supported picture or text file
  // with its bytes, an unsupported format as its path only. null when the
  // person cancels, which changes nothing.
  "inf:files:choose": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: z.array(chosenFileSchema).max(CHOSEN_FILES_MAX).nullable(),
  },
  "inf:voice:status": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: voiceStatusSchema,
  },
  "inf:voice:ensure-model": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: okSchema,
  },
  // Whether macOS lets this app use the microphone, for the line under the
  // input (docs/composer.md, "Voice"), and its System Settings pane. This
  // Mac's microphone, so the shell answers. The first ask with dictation on
  // records the first hold to talk (`firstUse`).
  "inf:voice:mic-access": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: z.object({ access: micAccessSchema }),
  },
  "inf:voice:open-mic-settings": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: okSchema,
  },
  // Where this Mac transcribes (docs/architecture.md section 8): in the voice
  // helper, a process of its own, or in a worker in the window. On this
  // Mac's own model and microphone, so the shell answers.
  "inf:voice:recognizer": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: z.object({ where: recognizerPlaceSchema }),
  },
  // The voice helper's model, loaded and primed while the captain talks.
  "inf:voice:warm-up": {
    effect: "change",
    surface: "host",
    request: z.tuple([]),
    response: okSchema,
  },
  // One recording as 16 kHz mono PCM, held in memory only (D-13), and its words.
  "inf:voice:transcribe": {
    effect: "change",
    surface: "host",
    request: z.tuple([voiceClipSchema]),
    response: z.object({ text: z.string() }),
  },
  // The captain's view watches a task's browser (docs/task-browser.md, "The
  // view"): pictures of its page come to this window on `inf:browser:frame`
  // until it unwatches, reloads or closes. Pixels of this Mac's page for
  // this Mac's window, so the shell answers; false when there is none.
  "inf:browser:watch": {
    effect: "read",
    surface: "host",
    request: z.tuple([z.string().min(1).max(64)]),
    response: z.object({ watching: z.boolean() }),
  },
  "inf:browser:unwatch": {
    effect: "read",
    surface: "host",
    request: z.tuple([z.string().min(1).max(64)]),
    response: okSchema,
  },
  // The room this window's maximized view gives the task's page, or none
  // once it is restored (docs/task-browser.md, "The view"): the page lays
  // out at it while this window watches. Asked of a watch this window holds.
  "inf:browser:size": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(64), taskBrowserSizeSchema.nullable()]),
    response: okSchema,
  },
  // The captain's own input to a task's page while he has control
  // (docs/task-browser.md, "Taking control"): this window's pointer and keys
  // to this Mac's page, so the shell answers; the core refuses it unless he
  // holds the browser, and nothing records it.
  "inf:browser:input": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(64), taskBrowserInputSchema]),
    response: taskBrowserCommandResultSchema,
  },
  "inf:observe:enabled": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.object({ enabled: z.boolean() }),
  },
  "inf:observe:sessions": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: z.array(observeSessionSummarySchema),
  },
  "inf:observe:detail": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: observeSessionDetailSchema,
  },
  "inf:observe:live": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([z.string()]),
    response: observeLiveSchema,
  },
  // Settings → Automation (docs/automation.md): the schedules as rules.
  // They run only where Firstmate lives; a Mac that controls it reads and
  // changes the same rules, so each reaches views.
  "inf:automation:list": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: automationListSchema,
  },
  "inf:automation:history": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1)]),
    response: z.array(automationRunSchema),
  },
  // The next dates a schedule would run; it sends nothing and changes nothing.
  "inf:automation:preview": {
    effect: "read",
    surface: "core",
    reach: "views",
    request: z.tuple([automationSpecSchema]),
    response: automationPreviewSchema,
  },
  "inf:automation:save": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([automationSaveSchema]),
    response: automationRuleSchema,
  },
  "inf:automation:state": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1), z.enum(["pause", "resume"])]),
    response: automationRuleSchema,
  },
  "inf:automation:pause-all": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([]),
    response: z.object({ paused: z.number().int() }),
  },
  "inf:automation:delete": {
    effect: "change",
    surface: "core",
    reach: "views",
    request: z.tuple([z.string().min(1)]),
    response: z.object({ id: z.string() }),
  },
  // Settings → Usage (docs/usage.md): the usage ledger over a period and a
  // kind of work, in tokens and in estimated dollars at once. This Mac's
  // own: a Mac that controls it has no Usage tab.
  "inf:usage:summary": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([usageQuerySchema]),
    response: usageSummarySchema,
  },
  // Usage's recent tasks: the newest tasks with recorded usage in a period
  // and kind of work, as many as asked, and how many there are.
  "inf:usage:tasks": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([usageTasksQuerySchema]),
    response: usageTasksSchema,
  },
  // The mediated fetch verb (D6). Born in the core beside quota/http.ts so
  // the trust boundary never moves; until a grant is served (phase 3) every
  // call is refused, and the refusal is the protocol's answer, not a
  // renderer shortcut.
  "inf:plugins:fetch": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([mediatedFetchCallSchema]),
    response: mediatedFetchResultSchema,
  },
  // The record, through SQL (plugin data surface, Phase B; src/shared/sql.ts):
  // one read-only query over the published views the asking plugin was
  // granted. The host adds the grant (`views`); the core's query process
  // runs it under the caps and answers rows or a refusal code.
  "inf:sql:query": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([sqlRequestSchema]),
    response: sqlAnswerSchema,
  },
  // Personal extensions (talk-to-personalize Step 2, docs/ui-plugins.md
  // "Personal extensions"): the snapshot the renderer mounts from, one
  // action call into an extension's `server.ts`, and the extension store's
  // four operations on one channel.
  "inf:plugins:personal:list": {
    effect: "read",
    surface: "core",
    reach: "home",
    request: z.tuple([]),
    response: personalSnapshotSchema,
  },
  // What the window did with each panel (docs/personal-panels.md, "Placed
  // on the rail"): drawn, refused and why, sent whenever it changes.
  "inf:plugins:personal:mounts": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([panelMountsSchema]),
    response: okSchema,
  },
  "inf:plugins:invoke": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([
      personalIdSchema,
      z.string().min(1).max(64),
      z.unknown().optional(),
      personalInvokeOptionsSchema.optional(),
    ]),
    response: personalInvokeResultSchema,
  },
  "inf:plugins:db": {
    effect: "change",
    surface: "core",
    reach: "home",
    request: z.tuple([personalStoreRequestSchema]),
    response: personalStoreResponseSchema,
  },
  // The frame vehicle (phase 1): the shell serves a template document over
  // its own scheme and hands back where the iframe loads it from. A host
  // without a desktop frame would answer with its own vehicle.
  "inf:frames:mount": {
    effect: "change",
    surface: "host",
    request: z.tuple([frameMountRequestSchema]),
    response: frameMountSchema,
  },
  "inf:frames:unmount": {
    effect: "change",
    surface: "host",
    request: z.tuple([z.string().min(1).max(64)]),
    response: okSchema,
  },
  // The frame watchdog's question to the main process, which every message
  // between the window and a frame passes through: an answer that changes
  // nothing says the main process is running (INF-935).
  "inf:frames:alive": {
    effect: "read",
    surface: "host",
    request: z.tuple([]),
    response: okSchema,
  },
  // A crewmate's conversation held on a computer that runs work: what that
  // computer asks its home, with the shapes in src/shared/work.ts
  // (docs/helper.md, "Holding a conversation").
  "inf:work:card": { ...workRequests["inf:work:card"], surface: "core", reach: "work" },
  "inf:work:card-refused": {
    ...workRequests["inf:work:card-refused"],
    surface: "core",
    reach: "work",
  },
  "inf:work:close-card": { ...workRequests["inf:work:close-card"], surface: "core", reach: "work" },
  "inf:work:followup": { ...workRequests["inf:work:followup"], surface: "core", reach: "work" },
  "inf:work:progress": { ...workRequests["inf:work:progress"], surface: "core", reach: "work" },
  "inf:work:report": { ...workRequests["inf:work:report"], surface: "core", reach: "work" },
  "inf:work:reply": { ...workRequests["inf:work:reply"], surface: "core", reach: "work" },
  "inf:work:speed-note": { ...workRequests["inf:work:speed-note"], surface: "core", reach: "work" },
  "inf:work:speed": { ...workRequests["inf:work:speed"], surface: "core", reach: "work" },
  "inf:work:tasks": { ...workRequests["inf:work:tasks"], surface: "core", reach: "work" },
  "inf:work:read-workflow": {
    ...workRequests["inf:work:read-workflow"],
    surface: "core",
    reach: "work",
  },
  "inf:work:github-read": {
    ...workRequests["inf:work:github-read"],
    surface: "core",
    reach: "work",
  },
  "inf:work:github-write": {
    ...workRequests["inf:work:github-write"],
    surface: "core",
    reach: "work",
  },
  "inf:work:prepare-change": {
    ...workRequests["inf:work:prepare-change"],
    surface: "core",
    reach: "work",
  },
  "inf:work:open-change": {
    ...workRequests["inf:work:open-change"],
    surface: "core",
    reach: "work",
  },
  "inf:work:check-change": {
    ...workRequests["inf:work:check-change"],
    surface: "core",
    reach: "work",
  },
  "inf:work:download-artifact": {
    ...workRequests["inf:work:download-artifact"],
    surface: "core",
    reach: "work",
  },
  // The home's knowledge (docs/knowledge.md, "Who has it").
  "inf:work:knowledge": { ...workRequests["inf:work:knowledge"], surface: "core", reach: "work" },
  "inf:work:record-knowledge": {
    ...workRequestWire("inf:work:record-knowledge"),
    surface: "core",
    reach: "work",
  },
  // The home's integrations (docs/integrations.md, "On a computer that runs work").
  "inf:work:integrations": {
    ...workRequests["inf:work:integrations"],
    surface: "core",
    reach: "work",
  },
  "inf:work:use-integration": {
    ...workRequests["inf:work:use-integration"],
    surface: "core",
    reach: "work",
  },
  "inf:work:picture": {
    ...workRequestWire("inf:work:picture"),
    surface: "core",
    reach: "work",
  },
  "inf:work:media": { ...workRequestWire("inf:work:media"), surface: "core", reach: "work" },
  "inf:work:handover-file": {
    ...workRequestWire("inf:work:handover-file"),
    surface: "core",
    reach: "work",
  },
  "inf:work:typeface": {
    ...workRequestWire("inf:work:typeface"),
    surface: "core",
    reach: "work",
  },
  "inf:work:job-exit": { ...workRequests["inf:work:job-exit"], surface: "core", reach: "work" },
  "inf:work:events": { ...workRequests["inf:work:events"], surface: "core", reach: "work" },
  // A task's browser on that computer (docs/task-browser.md, "On another computer").
  "inf:work:browser": { ...workRequests["inf:work:browser"], surface: "core", reach: "work" },
  "inf:work:browser-sign-in": {
    ...workRequests["inf:work:browser-sign-in"],
    surface: "core",
    reach: "work",
  },
  "inf:work:browser-frame": {
    ...workRequests["inf:work:browser-frame"],
    surface: "core",
    reach: "work",
  },
  "inf:work:browser-event": {
    ...workRequests["inf:work:browser-event"],
    surface: "core",
    reach: "work",
  },
  // What a computer that runs work tells its home about its own sign-ins,
  // with the shapes in src/shared/signIns.ts (docs/helper.md, "Its own sign-ins").
  "inf:work:sign-in": { ...signInWorkRequests["inf:work:sign-in"], surface: "core", reach: "work" },
  "inf:work:sign-ins": {
    ...signInWorkRequests["inf:work:sign-ins"],
    surface: "core",
    reach: "work",
  },
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
export type HostInvokeChannel = Exclude<InvokeChannel, CoreInvokeChannel>;

export const INVOKE_CHANNELS = Object.keys(invokeContract) as InvokeChannel[];

export function isCoreInvokeChannel(channel: InvokeChannel): channel is CoreInvokeChannel {
  return invokeContract[channel].surface === "core";
}

export const CORE_INVOKE_CHANNELS = INVOKE_CHANNELS.filter(isCoreInvokeChannel);
export const HOST_INVOKE_CHANNELS = INVOKE_CHANNELS.filter(
  (channel): channel is HostInvokeChannel => !isCoreInvokeChannel(channel),
);

/** Core channels a paired view may ask as well as this Mac (see ChannelReach). */
export type ViewInvokeChannel = {
  [C in CoreInvokeChannel]: (typeof invokeContract)[C]["reach"] extends "views" ? C : never;
}[CoreInvokeChannel];

export function isViewInvokeChannel(channel: CoreInvokeChannel): channel is ViewInvokeChannel {
  return invokeContract[channel].reach === "views";
}

export const VIEW_INVOKE_CHANNELS = CORE_INVOKE_CHANNELS.filter(isViewInvokeChannel);

/**
 * The `home` channels a paired view still may not ask when the first mate
 * was started by a command (docs/run.md, "Control from another computer").
 * Nobody sits at that computer, so a view asks every other one its window
 * would. These stay there: its computers and phones and the address they
 * find it at, a task's browser and a page from a task's project, and what
 * is only ever that computer's own - its look, voice, panels and their
 * extensions, Knowledge, Observe, release notes, Dock and update.
 */
export const RUN_HOME_ONLY_CHANNELS: ReadonlySet<CoreInvokeChannel> = new Set<CoreInvokeChannel>([
  "inf:devices:list",
  "inf:devices:invite",
  "inf:devices:add",
  "inf:devices:nearby",
  "inf:devices:update",
  "inf:devices:remove",
  "inf:devices:keep",
  "inf:devices:try-again",
  "inf:devices:change-address",
  "inf:devices:shown",
  "inf:devices:stop",
  "inf:devices:addresses",
  "inf:devices:address:set",
  "inf:cards:open-page",
  "inf:browser:stop",
  "inf:browser:reopen",
  "inf:browser:take",
  "inf:browser:return",
  "inf:settings:appearance:set",
  "inf:settings:layout:set",
  "inf:settings:panels:set",
  "inf:settings:dictation:get",
  "inf:settings:dictation:set",
  "inf:voice:status",
  "inf:voice:ensure-model",
  "inf:plugins:fetch",
  "inf:plugins:personal:list",
  "inf:plugins:personal:mounts",
  "inf:plugins:invoke",
  "inf:plugins:db",
  "inf:sql:query",
  "inf:knowledge:enabled",
  "inf:knowledge:collections",
  "inf:knowledge:graph",
  "inf:knowledge:concepts",
  "inf:knowledge:findings",
  "inf:knowledge:entry",
  "inf:knowledge:directions",
  "inf:knowledge:direction",
  "inf:knowledge:direction:set",
  "inf:knowledge:refs",
  "inf:knowledge:uses",
  "inf:observe:enabled",
  "inf:observe:sessions",
  "inf:observe:detail",
  "inf:observe:live",
  "inf:release-notes:list",
  "inf:release-notes:show",
  "inf:presence:get",
  "inf:presence:set",
  "inf:update:status",
  "inf:update:channel",
  "inf:update:open-release",
  "inf:update:install",
]);

/**
 * Whether a paired view may ask a core channel of a first mate started by
 * a command: a `views` channel, or a `home` one outside
 * `RUN_HOME_ONLY_CHANNELS`.
 */
export function isRunViewInvokeChannel(channel: CoreInvokeChannel): boolean {
  const { reach } = invokeContract[channel];
  return reach === "views" || (reach === "home" && !RUN_HOME_ONLY_CHANNELS.has(channel));
}

/** Core channels only a computer that runs work asks (see ChannelReach). */
export type WorkInvokeChannel = {
  [C in CoreInvokeChannel]: (typeof invokeContract)[C]["reach"] extends "work" ? C : never;
}[CoreInvokeChannel];

export function isWorkInvokeChannel(channel: CoreInvokeChannel): channel is WorkInvokeChannel {
  return invokeContract[channel].reach === "work";
}

export const WORK_INVOKE_CHANNELS = CORE_INVOKE_CHANNELS.filter(isWorkInvokeChannel);

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
export type OpenPage = z.infer<typeof openPageSchema>;

/** Push channels (main to renderer). Payloads are validated in the preload. */
export const pushContract = {
  "inf:event": { payload: fmEventSchema, surface: "core" },
  // Desktop transport only: the core and paired computers keep individual events.
  "inf:events": { payload: z.array(fmEventSchema), surface: "host" },
  "inf:cards": { payload: cardsSnapshotSchema, surface: "core" },
  // One card's thread, whole, after any message lands on it.
  "inf:cards:thread": { payload: cardThreadSchema, surface: "core" },
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
  // The window took a key for itself, which the page heard nothing of, nor any
  // key's release after it until the next goes down; which key stays unsaid.
  "inf:keyboard:taken": { payload: z.object({}), surface: "host" },
  // The window's keys, whole, after every install.
  "inf:keyboard:keymap": { payload: keymapSnapshotSchema, surface: "host" },
  // A key pressed while Keyboard settings records one.
  "inf:keyboard:recorded": { payload: recordedKeySchema, surface: "host" },
  // The window filled the screen or stopped filling it.
  "inf:window:state": { payload: windowStateSchema, surface: "host" },
  // One picture of a watched task's page, to the window that watches it.
  "inf:browser:frame": { payload: taskBrowserFrameSchema, surface: "host" },
  // A page a first mate started by a command would open in a browser, such
  // as a sign-in's: nobody sits at that computer, so each computer that
  // controls it opens the page instead (docs/run.md, "Control from another
  // computer"). Only such a first mate sends it.
  "inf:app:open-page": { payload: openPageSchema, surface: "core" },
} as const;

export type PushChannel = keyof typeof pushContract;
export type PushPayload<C extends PushChannel> = z.infer<(typeof pushContract)[C]["payload"]>;

/** Push channels the core emits; a second client would subscribe to these. */
export type CorePushChannel = {
  [C in PushChannel]: (typeof pushContract)[C]["surface"] extends "core" ? C : never;
}[PushChannel];

export const PUSH_CHANNELS = Object.keys(pushContract) as PushChannel[];

export function isCorePushChannel(channel: PushChannel): channel is CorePushChannel {
  return pushContract[channel].surface === "core";
}

export const CORE_PUSH_CHANNELS = PUSH_CHANNELS.filter(isCorePushChannel);

/** The one frozen API surface the preload exposes as `window.infinitary`. */
export type FirstmateApi = {
  /**
   * Files the captain gives the composer (docs/composer.md, "Files"). Only a
   * real File object the captain dropped, or the system picker's own
   * answer, reaches the host - never a path the page writes.
   */
  files: {
    /** Where a dropped File lives on disk, and whether it is a regular file. */
    dropped: (file: File) => Promise<DroppedPath>;
    /** The system file picker; null when cancelled. */
    choose: () => Promise<ChosenFile[] | null>;
  };
  app: {
    healthcheck: () => Promise<AppInfo>;
    /** The first-launch state: the gate, the welcome, the first turn. */
    firstRun: () => Promise<FirstRunView>;
    /** A crewmate state word was shown in full; the core records it once. */
    noteCrewWord: (word: CrewWord) => Promise<FirstRunView>;
    /** Open an https (or http loopback) URL in the system browser. */
    openExternal: (url: string) => Promise<{ ok: true }>;
    /** The system's folder picker: the chosen folder, or null when cancelled. */
    chooseFolder: (startAt?: string) => Promise<string | null>;
    /** One of the window's own buttons where the app draws them; answers the window's state after it. */
    controlWindow: (control: WindowControl) => Promise<WindowState>;
    windowState: () => Promise<WindowState>;
    onWindowState: (listener: (state: WindowState) => void) => () => void;
  };
  conversation: {
    /** Send one user turn to the Firstmate agent (the orchestrator). Accepts string for backward compat or {text?, images?, visibleCardId?, taskId?} for attachments, the on-screen card, and the task it points at. */
    send: (
      textOrTurn:
        | string
        | {
            text?: string;
            files?: Array<{ text: string }>;
            images?: Array<{
              mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
              data: string;
            }>;
            visibleCardId?: string;
            taskId?: string;
            pastCardId?: string;
            focusedProjectId?: string;
          },
    ) => Promise<{ ok: true }>;
    /** The captain's newest message and the Firstmate's reply line beside it, or null before the first. */
    lastTurn: () => Promise<LastTurn | null>;
  };
  task: {
    abort: (taskId: string) => Promise<{ ok: true }>;
    delete: (taskId: string) => Promise<{ ok: true }>;
    /**
     * A lifecycle toggle from the task record's footer or the task board:
     * start, stop, continue, drop, queue or unqueue.
     */
    run: (
      taskId: string,
      op: TaskLifecycleOp,
      review?: DropTaskReview,
      /** The panel whose page the captain moved it from, by its title. */
      from?: TaskMoveFrom,
    ) => Promise<{ ok: true } | { ok: false; text: string }>;
    /** A line the captain typed in the Crewmate tab: his steer on the crewmate's lane. */
    steer: (taskId: string, text: string) => Promise<CrewSendResult>;
    /** ⌃C or Stop in the Crewmate tab: his interrupt of the crewmate's running turn. */
    interrupt: (taskId: string) => Promise<CrewSendResult>;
  };
  automation: {
    list: () => Promise<AutomationList>;
    /** The next dates a schedule would run; nothing is sent or changed. */
    preview: (spec: AutomationSpec) => Promise<{ dates: number[] }>;
    /** Save a new rule (no id) or an edit; refused with a readable reason. */
    save: (rule: AutomationSave) => Promise<AutomationRule>;
    /** Pause, or resume at the next future occurrence. */
    setState: (id: string, change: "pause" | "resume") => Promise<AutomationRule>;
    pauseAll: () => Promise<{ paused: number }>;
    delete: (id: string) => Promise<{ id: string }>;
  };
  repos: {
    setup: (spec: RepoSetupSpec) => Promise<RepoSetupResult>;
    /** The tasks still on a project; any of them blocks `remove`. */
    removal: (repoId: string) => Promise<RepoRemoval>;
    /** Takes the project off the list; its folder stays. Refused while tasks are on it. */
    remove: (repoId: string) => Promise<{ id: string; name: string }>;
    /** Reflection of the managed fleet. */
    list: () => Promise<RepoView[]>;
    /** Delivery, autonomy, and standing rigor. */
    configure: (repoId: string, changes: RepoPolicyPatch) => Promise<RepoView>;
    /** Where new projects go. */
    folder: () => Promise<ProjectsFolderView>;
    /** A folder the person chose, or null for the default; refused with a readable reason. */
    setFolder: (path: string | null) => Promise<ProjectsFolderView>;
  };
  /** The window's keys (docs/keyboard.md). */
  keyboard: {
    /**
     * A window command the page runs, heard by the main process wherever
     * focus is: the catalog's, or a panel's by its id.
     */
    onCommand: (
      listener: (heard: { command: ShellCommandId | PanelCommandId }) => void,
    ) => () => void;
    /** The window took a key before the page, which the dictation key counts as one pressed with it. */
    onTaken: (listener: () => void) => () => void;
    /** Runs a window command the main process owns, chosen in command search. */
    run: (command: MainCommandId) => Promise<{ ok: true }>;
    /** The keys the window has installed, and what a person changed. */
    keymap: () => Promise<KeymapSnapshot>;
    onKeymap: (listener: (snapshot: KeymapSnapshot) => void) => () => void;
    /** Saves and installs a change whole, or rejects with the reason. */
    save: (keymap: SavedKeymap) => Promise<KeymapSnapshot>;
    /** Installs the panels' commands the window has now, with the catalog's. */
    setPanels: (panels: PanelCommand[]) => Promise<KeymapSnapshot>;
    /** Records keys in Keyboard settings: the window's keys pass to it until it stops. */
    record: (recording: boolean) => Promise<{ ok: true }>;
    onRecorded: (listener: (key: RecordedKey) => void) => () => void;
  };
  /** Settings -> Devices (docs/devices.md): the captain's own, on this Mac's window. */
  devices: {
    /**
     * Whether this computer offers the Devices tab and device cards.
     */
    shown: () => Promise<{ shown: boolean }>;
    list: () => Promise<DeviceView[]>;
    /** A one-use ten-minute link, for this window alone. */
    invite: (request: DeviceInviteRequest) => Promise<DeviceInvite>;
    /** Closes an open link before it expires. */
    stop: (linkId: string) => Promise<{ ok: true }>;
    /**
     * Adds the Mac at an address over Remote Login, with the captain's own
     * SSH key; answers it once it joined, or rejects with what happened and
     * what to do. A Mac whose user runs another Firstmate's work answers the
     * question asked once; `{ leave: true }` is the captain's yes to it. A
     * Mac that did not let that key in answers the password question;
     * `{ password }`, typed once, lets Firstmate's own key in there.
     */
    add: (address: string, options?: RemoteLoginAddOptions) => Promise<RemoteLoginAddAnswer>;
    /**
     * Updates Firstmate on a computer added by its address to this Mac's version.
     * An Ubuntu package asks for that account's password once, in the same aside.
     */
    update: (
      deviceId: string,
      options?: { password?: string },
    ) => Promise<DeviceView | RemoteLoginPasswordQuestion | RemoteLoginRefusedAnswer>;
    /**
     * Takes a device off the list; it is cut off before this answers. A
     * computer that runs work has its unmerged work brought here first; one
     * out of reach is removed `when-back` or `now`, as the captain chose.
     */
    remove: (deviceId: string, when?: DeviceRemoveWhen) => Promise<DeviceView>;
    /** Keep it: a computer waiting to be removed once it is back stays. */
    keep: (deviceId: string) => Promise<DeviceView>;
    /**
     * Try again: this Mac's own SSH connection to the computer, or to every
     * one it stopped trying when none is named, is tried once now.
     */
    tryAgain: (deviceId?: string) => Promise<{ tried: number }>;
    /** Change address: this Mac reaches a computer it added by its address at another one. */
    changeAddress: (
      deviceId: string,
      address: string,
    ) => Promise<DeviceView | RemoteLoginRefusedAnswer>;
    /** Your devices, whole, after any change. */
    onDevices: (listener: (devices: DeviceView[]) => void) => () => void;
    onResources: (listener: (resources: ComputerResourcesView) => void) => () => void;
    /** Macs nearby with Remote Login on: `true` looks for another minute, `false` stops. */
    nearby: (watching: boolean) => Promise<NearbyMacsView>;
    /** Macs nearby, whole, whenever the list reads differently. */
    onNearby: (listener: (nearby: NearbyMacsView) => void) => () => void;
    /** Where devices find this Mac. */
    addresses: () => Promise<DeviceAddresses>;
    /** Where devices find this Mac, whole, after it reads differently: a choice, or this Mac's network moving. */
    onAddresses: (listener: (addresses: DeviceAddresses) => void) => () => void;
    /** One of this Mac's own private addresses, or null to take the first. */
    setAddress: (address: string | null) => Promise<DeviceAddresses>;
    /** Where a project's next task starts: a computer that runs work by its id, or null for this Mac. */
    runsOn: (repoId: string, deviceId: string | null) => Promise<RepoView>;
    /** What this app is on its Mac: the one holding Firstmate, or controlling another. */
    thisMac: () => Promise<ThisMac>;
    onThisMac: (listener: (thisMac: ThisMac) => void) => () => void;
    /** Joins Firstmate on another Mac with a pasted link; on success the window starts over. */
    join: (link: string) => Promise<JoinOutcome>;
    /** Stops controlling the other Mac and returns this app to its own first launch. */
    leave: () => Promise<{ ok: true }>;
    /** Each computer that runs work, with what it last said of its own sign-ins. */
    signIns: () => Promise<DeviceSignIns[]>;
    onSignIns: (listener: (devices: DeviceSignIns[]) => void) => () => void;
    /** Starts a sign-in on that computer, or signs one of its accounts in again; its steps arrive on `onSignIn`. */
    signIn: (
      deviceId: string,
      providerId: string,
      type: "oauth" | "api_key",
      accountId?: string,
    ) => Promise<{ signInId: string }>;
    /** What the captain typed or chose, sent to that computer once and kept nowhere here; null stops it. */
    answerSignIn: (
      signInId: string,
      promptId: string,
      value: string | null,
    ) => Promise<{ ok: true }>;
    cancelSignIn: (signInId: string) => Promise<{ ok: true }>;
    onSignIn: (listener: (event: DeviceSignInEvent) => void) => () => void;
    /** Signs that computer out of one of its own accounts. */
    signOut: (deviceId: string, accountId: string) => Promise<{ ok: true }>;
    /** Starts that computer's own sign-in where projects live; its code to read arrives on `onSignIn`. */
    forgeSignIn: (deviceId: string, host: string) => Promise<{ signInId: string }>;
    /** Signs that computer out where projects live. */
    forgeSignOut: (deviceId: string, host: string) => Promise<{ ok: true }>;
    /**
     * A custom API connection on that computer. The key rides connect once
     * and is kept nowhere here.
     */
    custom: {
      profiles: (deviceId: string) => Promise<CustomCapabilityProfile[]>;
      address: (deviceId: string, baseUrl: string) => Promise<CustomApiAddress>;
      review: (
        deviceId: string,
        baseUrl: string,
        mode: CustomNetworkMode,
        pem?: string,
      ) => Promise<CustomApiReview>;
      connect: (deviceId: string, input: CustomApiConnectInput) => Promise<CustomApiConnectResult>;
      check: (deviceId: string, draftId: string, modelId: string) => Promise<CustomApiView>;
      discover: (deviceId: string, draftId: string) => Promise<CustomListedModel[]>;
      cancel: (deviceId: string, draftId: string) => Promise<{ ok: true }>;
      save: (deviceId: string, draftId: string, paused: boolean) => Promise<CustomApiView>;
      recheck: (deviceId: string, accountId: string) => Promise<CustomApiView>;
    };
  };
  cards: {
    list: () => Promise<Card[]>;
    act: (
      cardId: string,
      actionId: string,
      source: CardActionSource,
      value?: unknown,
      submission?: CardSubmission,
    ) => Promise<InvokeResponse<"inf:cards:act">>;
    minimize: (cardId: string, minimized: boolean) => Promise<{ ok: true }>;
    close: (cardId: string, submission?: CardSubmission) => Promise<{ ok: true }>;
    onCards: (listener: (cards: Card[]) => void) => () => void;
    /** The stage showed the captain this version (offer) of the card. */
    seen: (cardId: string, offerId: string) => Promise<{ ok: true }>;
    /** The card's thread (cards-as-threads phase 1), oldest message first. */
    thread: (cardId: string) => Promise<CardThread>;
    /** A closed card as the captain last saw it; null while it is open or unknown. */
    past: (cardId: string) => Promise<PastCard | null>;
    /** Bring a closed card forward as the read-only past card (the shared show-card door). */
    showPast: (cardId: string) => Promise<PastCard>;
    /**
     * Open the page a card's live attachment names from its task's project
     * in that task's own browser, on the captain's click: the browser it
     * opened in, or a refusal in words.
     */
    openPage: (cardId: string) => Promise<{ refusal?: string; browser?: TaskBrowserHandle }>;
    /** The captain's reply, verbatim; the core routes it to the card's author. */
    reply: (
      cardId: string,
      payload:
        | string
        | {
            text?: string;
            files?: Array<{ text: string }>;
            answers?: CardAnswer[];
            images?: Array<{
              mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
              data: string;
            }>;
          },
      submission?: CardSubmission,
    ) => Promise<CardThread>;
    onThread: (listener: (thread: CardThread) => void) => () => void;
  };
  events: {
    on: (listener: (event: FmEvent) => void) => () => void;
  };
  feed: {
    /** The persisted recent activity lines, oldest first (P10). */
    recent: () => Promise<FeedLine[]>;
  };
  crew: {
    /** Live strip counts; live updates ride inf:event crew_counts. */
    counts: () => Promise<CrewCounts>;
  };
  /**
   * The task protocol (task-system P3): reads. The record's lifecycle
   * toggles are `task.run`; every other write is a conversation.
   */
  tasks: {
    /** The live board a client resyncs from; live updates ride onBoard. */
    board: () => Promise<TaskBoard>;
    /** One record in full: view, intent, brief, outcome, timeline, asks. */
    detail: (taskId: string) => Promise<TaskDetail>;
    /** The captain opened a filing's record. Clears its new mark. */
    opened: (taskId: string) => Promise<{ opened: boolean }>;
    /** One call's whole result in the Crewmate tab, by the ref its line carries. */
    crewmateResult: (taskId: string, ref: string) => Promise<CrewResultText | null>;
    /** One picture a call's result holds in the Crewmate tab, by its ref. */
    crewmatePicture: (taskId: string, ref: string) => Promise<CrewPicture | null>;
    onBoard: (listener: (board: TaskBoard) => void) => () => void;
    /**
     * The same validated board as `onBoard`, as its JSON text. A string
     * crosses the preload bridge as one value, where a board object is
     * copied value by value on the renderer's main thread - the app's read
     * executor takes this one, parses it once and shares it.
     */
    onBoardJson: (listener: (board: string) => void) => () => void;
    /** Deltas above the measured trigger; `applyTaskBoardDelta` folds one onto a board. */
    onBoardDelta: (listener: (delta: TaskBoardDelta) => void) => () => void;
  };
  /**
   * A task's own browser, as the captain watches it (docs/task-browser.md,
   * "The view"). Its fact rides `tasks.detail`.
   */
  browser: {
    /** Pictures of the task's page start coming to `onFrame`; false when it has no browser here. */
    watch: (taskId: string) => Promise<{ watching: boolean }>;
    unwatch: (taskId: string) => Promise<{ ok: true }>;
    onFrame: (listener: (frame: TaskBrowserFrame) => void) => () => void;
    /** Stop browser: its pages, history and site data go. */
    stop: (taskId: string) => Promise<TaskBrowserCommandResult>;
    /** Open again: a fresh browser at the stopped one's last page, nothing signed in. */
    reopen: (taskId: string) => Promise<TaskBrowserCommandResult>;
    /** Take control of the browser the view shows, once the crewmate's command finishes. */
    take: (taskId: string, handle: TaskBrowserHandle) => Promise<TaskBrowserCommandResult>;
    /** Return control: the crewmate is woken once to take a fresh look; `remember` saves the site's sign-in. */
    return: (
      taskId: string,
      handle: TaskBrowserHandle,
      options?: TaskBrowserReturn,
    ) => Promise<TaskBrowserCommandResult>;
    /** The website sign-ins saved on this Mac, for Settings; `available` false where there are no task browsers. */
    signIns: () => Promise<SavedSignInsView>;
    /** Separately allow or revoke future tasks using the shown saved site. */
    allowAutomaticSignIn: (
      site: string,
      id: string,
      automatic: boolean,
    ) => Promise<TaskBrowserCommandResult>;
    /** Remove a site's saved sign-in, signing out every browser using it. */
    removeSignIn: (site: string) => Promise<TaskBrowserCommandResult>;
    /** The captain's own pointer, keys and pasted text, while he has control; recorded nowhere. */
    input: (taskId: string, input: TaskBrowserInput) => Promise<TaskBrowserCommandResult>;
    /** The room the maximized view gives the watched page, or null to give it back its own size. */
    size: (taskId: string, size: TaskBrowserSize | null) => Promise<{ ok: true }>;
  };
  projects: {
    /** Scratch plus one per managed repo, with live counts. */
    list: () => Promise<ProjectView[]>;
  };
  quota: {
    snapshot: () => Promise<QuotaSnapshotView | null>;
    refresh: () => Promise<QuotaSnapshotView | null>;
    models: () => Promise<ModelsCatalogView | null>;
    onSnapshot: (listener: (snapshot: QuotaSnapshotView) => void) => () => void;
  };
  settings: {
    getRouting: () => Promise<RoutingSettings>;
    setRouting: (settings: RoutingSettings) => Promise<RoutingSettings>;
    getFirstmateModel: () => Promise<PiModelRefView | null>;
    setFirstmateModel: (model: PiModelRefView | null) => Promise<PiModelRefView | null>;
    getFirstmateAccount: () => Promise<string | null>;
    setFirstmateAccount: (accountId: string | null) => Promise<string | null>;
    /**
     * The dev-only local seat (roadmap 1.7): the same choice the environment
     * variables make, from Settings. A packaged build answers
     * `available: false` (no section renders) and refuses the write.
     */
    getLocalOrchestrator: () => Promise<LocalOrchestratorView>;
    setLocalOrchestrator: (setting: LocalOrchestratorSetting) => Promise<LocalOrchestratorView>;
    onDictation: (listener: (setting: DictationSettings) => void) => () => void;
    getDictation: () => Promise<DictationSettings>;
    setDictation: (setting: DictationSettings) => Promise<DictationSettings>;
    getRunbooks: () => Promise<RunbookView[]>;
    setRunbook: (id: string, enabled: boolean) => Promise<RunbookView[]>;
    getPersonalResources: () => Promise<boolean>;
    setPersonalResources: (enabled: boolean) => Promise<boolean>;
    getNotifications: () => Promise<boolean>;
    setNotifications: (enabled: boolean) => Promise<boolean>;
    /** Theme and the rest of how the app looks. */
    getAppearance: () => Promise<Appearance>;
    setAppearance: (appearance: Appearance) => Promise<Appearance>;
    /** How the app is arranged: today, which rail panels are collapsed. */
    getLayout: () => Promise<Layout>;
    setLayout: (layout: Layout) => Promise<Layout>;
    /**
     * The host-owned switch over the captain's own panels (Step 5). Off
     * unmounts every one of them and stops their server modules; the
     * reason the app gives for them being off is the core's, so only
     * `enabled` crosses.
     */
    setPanels: (enabled: boolean) => Promise<PersonalPanels>;
    /** All of it, as the one value the host applies; pushed on every write. */
    getPreferences: () => Promise<ShellPreferences>;
    onPreferences: (listener: (preferences: ShellPreferences) => void) => () => void;
    /**
     * The two switches (roadmap 1.4): what may leave this machine for us.
     * Diagnostics - the allowlisted anonymous events with an anonymous
     * install ID (`src/shared/diagnostics.ts`) - is on by default and sends
     * nothing until the person has been shown it once (the first-launch
     * notice or the viewer); contribution is off. The preview is that
     * payload, before and after a send; the ask is the one-time question
     * at local-model enablement, answered once.
     */
    getSharing: () => Promise<SharingView>;
    setSharing: (channel: SharingChannel, enabled: boolean) => Promise<SharingView>;
    markSharingViewed: (channel: SharingChannel) => Promise<SharingView>;
    sharingPreview: () => Promise<SharingPreview>;
    answerSharingAsk: (answer: SharingAskAnswer) => Promise<SharingView>;
    onSharing: (listener: (view: SharingView) => void) => () => void;
  };
  models: {
    /** Re-read model/use/readiness state after any confirmed model mutation. */
    onChanged: (listener: () => void) => () => void;
    available: () => Promise<PiModelRefView[]>;
    /** The slot-first Settings board. */
    slots: () => Promise<ModelSlotsView>;
    /** Adds or removes one slot from an offering's membership; returns the refreshed view. */
    setSlotMembership: (key: string, slot: Slot, on: boolean) => Promise<ModelSlotsView>;
    setSpeed: (key: string, speed: CrewSpeed) => Promise<ModelSlotsView>;
    setReasoning: (
      key: string,
      slot: Slot,
      level: ReasoningChoice | null,
    ) => Promise<ModelSlotsView>;
    /** Reset offerings to the starter map; omit providerId for every provider. */
    resetSlots: (providerId?: string) => Promise<ModelSlotsView>;
    /**
     * The Decisions group (S7b): which model answers typed decisions, and
     * each native option's state. Never a key - it has its own write-only
     * call, and no call here returns one.
     */
    decisions: () => Promise<DecisionsView>;
    setDecisions: (decisions: DecisionsSettings) => Promise<DecisionsView>;
    setDecisionKey: (id: DecisionModelId, key: string) => Promise<DecisionsView>;
    removeDecisionKey: (id: DecisionModelId) => Promise<DecisionsView>;
  };
  update: {
    status: () => Promise<UpdateStatus>;
    setChannel: (channel: UpdateChannel) => Promise<UpdateStatus>;
    openReleasePage: () => Promise<{ ok: true }>;
    install: () => Promise<UpdateInstallResult>;
  };
  /** The release notes the app showed (docs/release-notes.md "Reading a note again"). */
  releaseNotes: {
    list: () => Promise<ReleaseNotesView>;
    /** Brings a shown note forward: the one for `version`, or else the newest that listed changes. */
    show: (version: string | null) => Promise<ShownReleaseNote & { open: boolean }>;
    onChange: (listener: (view: ReleaseNotesView) => void) => () => void;
  };
  presence: {
    get: () => Promise<PresenceSettings>;
    set: (settings: PresenceSettings) => Promise<PresenceSettings>;
  };
  retention: {
    purge: () => Promise<{ purgedTasks: number }>;
    /**
     * Whether a purge also clears knowledge, which only an alpha or
     * development build keeps; and the words from outside this build keeps
     * for a while, which `deleteOutside` deletes on their own.
     */
    scope: () => Promise<{ knowledge: boolean; kept?: KeptOutsideData[] }>;
    /** Replace the Gmail and Calendar content every saved conversation holds with a note (INF-952). */
    deleteOutside: () => Promise<OutsideDataDeleted>;
  };
  knowledge: {
    /**
     * Whether this build keeps knowledge - an alpha or development build - and
     * whether there is any to show (docs/knowledge.md, "The browser").
     */
    enabled: () => Promise<{ enabled: boolean; held: boolean }>;
  };
  voice: {
    status: () => Promise<VoiceStatus>;
    ensureModel: () => Promise<{ ok: true }>;
    micAccess: () => Promise<{ access: MicAccess }>;
    openMicSettings: () => Promise<{ ok: true }>;
    recognizer: () => Promise<{ where: RecognizerPlace }>;
    warmUp: () => Promise<{ ok: true }>;
    transcribe: (audio: Float32Array) => Promise<{ text: string }>;
    onProgress: (listener: (progress: VoiceDownloadProgress) => void) => () => void;
  };
  auth: {
    providers: () => Promise<ProviderView[]>;
    replyPrompt: (promptId: string, value: string | null) => Promise<{ ok: true }>;
    cancel: () => Promise<{ ok: true }>;
    onPrompt: (listener: (prompt: AuthPromptView) => void) => () => void;
    onNotice: (listener: (notice: AuthNotice) => void) => () => void;
  };
  accounts: {
    custom: {
      profiles: () => Promise<CustomCapabilityProfile[]>;
      review: (
        baseUrl: string,
        mode: CustomApiInput["mode"],
        pem?: string,
      ) => Promise<CustomApiReview>;
      address: (baseUrl: string) => Promise<CustomApiAddress>;
      connect: (input: CustomApiConnectInput) => Promise<CustomApiConnectResult>;
      prepare: (input: CustomApiInput) => Promise<CustomApiView>;
      check: (draftId: string, modelId: string) => Promise<CustomApiView>;
      discover: (draftId: string) => Promise<CustomListedModel[]>;
      cancel: (draftId: string) => Promise<{ ok: true }>;
      save: (draftId: string, paused: boolean) => Promise<CustomApiView>;
      /** A saved connection's one fresh check; a failure comes back on its model. */
      recheck: (accountId: string) => Promise<CustomApiView>;
      list: () => Promise<CustomApiView[]>;
    };
    list: () => Promise<AccountView[]>;
    /** Add an account: runs the provider's own sign-in into a fresh store. */
    add: (
      providerId: string,
      type: "oauth" | "api_key",
      options?: { enterpriseHost: string },
    ) => Promise<AccountView>;
    /** Sign an existing account in again, into its own store; nothing else moves. */
    signIn: (accountId: string) => Promise<AccountView>;
    remove: (accountId: string) => Promise<{ ok: true }>;
    rename: (accountId: string, label: string) => Promise<{ ok: true }>;
    setEnabled: (accountId: string, enabled: boolean) => Promise<{ ok: true }>;
    pin: (providerId: string, accountId: string | null) => Promise<{ ok: true }>;
  };
  /**
   * The app's own sign-ins where projects live (git integration PR 1.2):
   * optional - a project kept on this Mac never needs one. `signIn` starts
   * the host's device flow and answers with the code to enter on the
   * host's page; how it ends arrives on `onChange`. `signInWithKey` signs
   * in to a host on the person's own server with a key made there, and
   * answers whether it was kept. `signInWithCli` signs a GitHub host in
   * through the person's own GitHub CLI, and answers whether it was kept.
   */
  forges: {
    projects: (host: string) => Promise<ForgeProject[]>;
    list: () => Promise<ForgesView>;
    signIn: (host: string) => Promise<ForgeSignInFlow>;
    signInWithBrowser: (input: ForgeBrowserSignIn) => Promise<ForgeSignInFlow>;
    signInWithKey: (input: ForgeKeySignIn) => Promise<ForgeKeySignInResult>;
    signInWithCli: (address: string) => Promise<ForgeCliSignInResult>;
    cancel: () => Promise<ForgesView>;
    signOut: (host: string) => Promise<ForgesView>;
    /** The person's open proposed changes there, newest first (the `forge.changes` read). */
    changes: () => Promise<ForgeChangesView>;
    onChange: (listener: (view: ForgesView) => void) => () => void;
  };
  /**
   * Integrations (docs/integrations.md): the rows Settings -> Integrations
   * draws, and the changes it makes through the same catalog lines the
   * first mate's `app_change` uses. A connection is made by its kind's own
   * sign-in (GitHub's is `forges.signIn`, Google's `signIn`), or added from
   * the person's words (an MCP server, `addMcp`).
   */
  integrations: {
    list: () => Promise<IntegrationsView>;
    addMcp: (server: IntegrationMcpAdd) => Promise<{ id: string; view: IntegrationsView }>;
    /**
     * Sign in to a kind that signs in in the person's browser (Google): it
     * opens the page there and answers once the browser comes back. A kind
     * with a notice (`INTEGRATION_NOTICES`) needs the person's accept of it.
     */
    signIn: (
      kind: IntegrationKind,
      consent?: IntegrationSignInConsent,
    ) => Promise<{ id: string; view: IntegrationsView }>;
    /** End the sign-in waiting for the browser. */
    cancelSignIn: () => Promise<IntegrationsView>;
    /** Link the inbox's command into /usr/local/bin, where that is free and writable. */
    linkInbox: () => Promise<IntegrationsView>;
    configure: (id: string, patch: IntegrationSettingsPatch) => Promise<IntegrationsView>;
    rule: (id: string, action: string, allowed: boolean) => Promise<IntegrationsView>;
    remove: (id: string) => Promise<IntegrationsView>;
    check: (id: string) => Promise<IntegrationsView>;
    /** Keep the captain's key for one slot, or forget it with null; nothing hands it back. */
    secret: (id: string, slot: string, value: string | null) => Promise<IntegrationsView>;
    onChange: (listener: (view: IntegrationsView) => void) => () => void;
  };
  observe: {
    enabled: () => Promise<{ enabled: boolean }>;
    sessions: () => Promise<ObserveSessionSummary[]>;
    detail: (sessionId: string) => Promise<ObserveSessionDetail>;
  };
  /** The plugin host's own needs: the frame vehicle, the read catalog, the fetch seam. */
  plugins: {
    mountFrame: (request: FrameMountRequest) => Promise<FrameMount>;
    unmountFrame: (mountId: string) => Promise<{ ok: true }>;
    /** Answers once the main process runs; the frame watchdog asks it each tick. */
    mainAlive: () => Promise<{ ok: true }>;
    /**
     * Executes one read-catalog entry (src/shared/reads.ts) by name. `grant`
     * is what the plugin host adds from the plugin's manifest (the views a
     * `sql` read may reach); a read without one reaches nothing it grants.
     */
    read: <N extends ReadName>(
      name: N,
      args: ReadArgs<N>,
      grant?: ReadGrant,
    ) => Promise<ReadResult<N>>;
    fetch: (call: MediatedFetchCall) => Promise<MediatedFetchResult>;
    /**
     * Personal extensions (talk-to-personalize Step 2): the snapshot the
     * renderer mounts from, an action call into an extension's `server.ts`,
     * and the extension store. `db` is namespaced by extension id on every
     * call; a panel gets it pre-bound to its own id in its props.
     */
    personal: {
      list: () => Promise<PersonalSnapshot>;
      onSnapshot: (listener: (snapshot: PersonalSnapshot) => void) => () => void;
      /** What the window did with each panel, for `place_panel` and the surfaces list. */
      reportMounts: (mounts: PanelMounts) => Promise<{ ok: true }>;
    };
    invoke: (
      extensionId: string,
      action: string,
      input?: unknown,
      options?: PersonalInvokeOptions,
    ) => Promise<PersonalInvokeResult>;
    db: {
      request: (request: PersonalStoreRequest) => Promise<PersonalStoreResponse>;
      onChange: (listener: (change: PersonalStoreChange) => void) => () => void;
    };
  };
};
