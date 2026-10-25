import { mkdir, readdir } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { CutOff } from "@shared/authFailure";
import { RELEASE_NOTES_PICTURE_OWNER } from "@shared/cardPictures";
import { CONNECTION_PORT } from "@shared/connection";
import {
  accountIdFromNeedsReauthCard,
  needsReauthCopy,
  REFRESH_TOKEN_LAPSED,
} from "@shared/credentialHealth";
import { emptyTranscript } from "@shared/crewTranscript";
import { isCustomApiProvider } from "@shared/customApi";
import { COMPUTER, HERE } from "@shared/deviceNames";
import {
  type DeviceChip,
  type DeviceInvite,
  type DeviceInviteRequest,
  type DeviceSystem,
  type DeviceView,
  DOWNLOAD_COMMAND_LINK_TTL_MS,
  deviceLabel,
  deviceRunsWork,
  reachFrom,
} from "@shared/devices";
import { settingFrom } from "@shared/envSettings";
import type { FmEvent } from "@shared/events";
import { feedLineFrom, feedRunOf } from "@shared/feed";
import { GITHUB_COM, type KnownForgeHost, kindOfHost } from "@shared/forge";
import { type ForgeChangeRow, type ForgeChangesView, forgeSignInCardId } from "@shared/forges";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { modelNames } from "@shared/modelDisplayName";
import { offeringKey, parseOfferingKey, providerLabel } from "@shared/modelSlots";
import { desktopConventions } from "@shared/platform";
import {
  backendForProvider,
  CLAUDE_PROVIDER_ID,
  catalogEntry,
  type ProviderView,
} from "@shared/providers";
import { type QuotaSnapshotView, servedProviderOf } from "@shared/quota";
import { devicePlace } from "@shared/signIns";
import { runsForAnotherFirstmate } from "@shared/sshConnection";
import { BUILTIN_SURFACES } from "@shared/surfaces";
import type { TaskBrowserFact } from "@shared/taskBrowser";
import type { TaskRunsOn } from "@shared/taskPolicies";
import { BOARD_DELTA_TRIGGER, type TaskActionLine, type TaskPlace } from "@shared/tasks";
import type { UsageQuery, UsageSummary, UsageTasks, UsageTasksQuery } from "@shared/usage";
import { WELCOME_NOTE } from "@shared/welcome";
import type { WorkPosture } from "@shared/workPosture";
import type { AccountBackend } from "./accounts/accountBackend";
import { CredentialHealthService } from "./accounts/credentialHealthService";
import { buildProviderViews } from "./accounts/providerViews";
import { initAttachmentsDir } from "./attachments";
import { AxiChannel } from "./axi/channel";
import { browserLookup } from "./browser/connectionGuard";
import { TaskBrowsers } from "./browser/taskBrowsers";
import { WebSignIns } from "./browser/webSignIns";
import { ClaudeAuthBackend } from "./claude/claudeAuth";
import { primeClaudeExecutable } from "./claude/claudeCli";
import type { ClaudeRateLimit } from "./claude/claudeEvents";
import { CLAUDE_MODELS } from "./claude/claudeModels";
import { defaultClaudeConfigDir, resolveClaudeQuotaAuthResult } from "./claude/claudeQuota";
import { claudeReasoningCapabilities } from "./claude/reasoning";
import { createClaudeSessionFactory } from "./claude/session";
import { interfacesFromAddresses } from "./connection/addresses";
import { AdaptedDecisionModel, DecisionModels } from "./decisions/decisionModel";
// The composition root is the ONE place a native decision model's client
// and key store are constructed (Biome fences every other file in
// src/core/ out of `decisions/jev/`), the way it is the one place the Pi
// and Claude seams are assembled.
import { JevDecisionModel } from "./decisions/jev/jevClient";
import { DecisionKeyStore } from "./decisions/jev/jevKeyStore";
import { OpenRouterDecisionModel } from "./decisions/openRouterDecisionModel";
import { dnsSdAnnounceArgs, HomeAnnouncement } from "./devices/announce";
import { avahiAnnounceArgs } from "./devices/avahi";
import { ownComputerName, ownNetworkNames } from "./devices/computerName";
import { Computers } from "./devices/computers";
import { DeviceSetup } from "./devices/deviceSetup";
import { DeviceSignIns } from "./devices/deviceSignIns";
import { DeviceUpdateNudge } from "./devices/deviceUpdateNudge";
import { runDnsSd, runDnsSdHeld, SYSTEM_DNS_SD } from "./devices/dnsSd";
import { type FarBuild, FarBuilds } from "./devices/farBuilds";
import { farSystemNamed } from "./devices/farSystems";
import { firewallKeepsOut } from "./devices/firewall";
import { appBundleOf, joinCommand } from "./devices/joinCommand";
import { NearbyMacs } from "./devices/nearby";
import { DevicePairing } from "./devices/pairing";
import { PhoneDoor } from "./devices/phoneDoor";
import { PublishedBuilds, standInTapFetch } from "./devices/publishedBuilds";
import { RemoteLogin } from "./devices/remoteLogin";
import { systemSsh } from "./devices/ssh";
import { SshConnections } from "./devices/sshConnections";
import type { CoreEventSink } from "./events";
import { FirstRunService, finishedCrewmates, hasFinishedTask, hasPriorActivity } from "./firstRun";
import {
  createForgeResolver,
  type Forge,
  type ForgeBindings,
  type ForgeHealthChange,
  type ForgeLocation,
  ForgeSignInStore,
  ForgeSignIns,
  forgeSignInProviders,
  forgeSignInServers,
  isSignInForgeFailure,
  remoteProjectsText,
} from "./forge";
import { readOpenChanges } from "./forge/providers/github/changes";
import { GitHubForge, githubApiBaseFor } from "./forge/providers/github/githubForge";
import { readGitLabOpenChanges } from "./forge/providers/gitlab/changes";
import { gitlabApiBaseFor } from "./forge/providers/gitlab/client";
import { GitLabForge } from "./forge/providers/gitlab/gitlabForge";
import { appLauncher } from "./helper/launcher";
import { bootedAt } from "./helper/lock";
import type { HostCapabilities } from "./host";
import { captureLoginPath, configureGitSignIn, hostEnv } from "./hostEnv";
import {
  FIRSTMATE_READER,
  FileIntegrationSecrets,
  forgeHostIntegration,
  githubIntegration,
  googleIntegration,
  googleSetup,
  IntegrationSettingsStore,
  IntegrationsService,
  mcpIntegration,
  OutsideReads,
  SavedOutsideData,
  standInIntegration,
} from "./integrations";
import { type JobExit, JobManager, jobExitWake } from "./jobs/jobManager";
import { workingCopyFacts } from "./knowledge/gitFacts";
import { KnowledgeService } from "./knowledge/knowledgeService";
import { createAccountStore } from "./models/accountStore";
import type { ServedModels } from "./models/servedModels";
import { CardNotifier } from "./notifications";
import { isObserveEnabled } from "./observe/gate";
import { ObserveService } from "./observe/observeService";
import { createCrewmateTranscriptResolver } from "./observe/transcriptSource";
import { isAllowedOpenExternalUrl } from "./openExternal";
import { ChangePresentations } from "./orchestrator/changePresentations";
import { CrewSupervisor, type PersonalLiveDelegate } from "./orchestrator/crewSupervisor";
import { FirstmateAgent } from "./orchestrator/firstmateAgent";
import { firstmateCanServe } from "./orchestrator/firstmateAvailability";
import { Flagship } from "./orchestrator/flagship";
import { GithubGatewayService } from "./orchestrator/githubGateway";
import { LocalOrchestratorService } from "./orchestrator/localOrchestrator";
import { PrCiService } from "./orchestrator/prCi";
import { Scheduler } from "./orchestrator/scheduler";
import { TICK_PERIOD_MS, Ticker, tickPeriodFor } from "./orchestrator/ticker";
import type { TypedWake } from "./orchestrator/wakes";
import { WorkflowEvidenceService } from "./orchestrator/workflowEvidence";
import { initOverflowDir } from "./overflow";
import {
  type AppPaths,
  appPathsFor,
  crewmateCardPicturesDir,
  crewmateEvidenceDir,
  crewmateSessionsDir,
} from "./paths";
import { carryPanelInstructions } from "./personal/panelInstructions";
import { PANELS_SAFE_MODE_NOTE } from "./personal/panelLines";
import { PanelMountsHolder } from "./personal/panelMounts";
import { PersonalExtensions } from "./personal/personalExtensions";
import { PersonalStore } from "./personal/personalStore";
import { LaunchWatch } from "./personal/safeMode";
import type { AccountVault } from "./pi/accountVault";
import { keepPictureFile } from "./pi/cardImages";
import { CREWMATE_TOOLS } from "./pi/crewmateTaskTools";
import { openRouterDecisionModels } from "./pi/decisionModels";
import { createModelCapabilityLookup } from "./pi/modelCapability";
import { PiAccountBackend } from "./pi/piAccountBackend";
import { PiAuthService } from "./pi/piAuth";
import { piReasoningCapabilities } from "./pi/reasoning";
import { createPiSessionFactory } from "./pi/sessionFactory";
import { readKeptValidationEvidence } from "./pi/validationEvidence";
import { AutomaticPlacement } from "./placed/automaticPlacement";
import { ComputerResourceFeed } from "./placed/computerResourceFeed";
import { ComputerResources } from "./placed/computerResources";
import { HomeBrowsers, PlacedBrowsers } from "./placed/placedBrowsers";
import { PlacedSessions } from "./placed/placedSessions";
import type { PlacedWork } from "./placed/placedWork";
import { ResourceSampler } from "./placed/resourceSampler";
import { WorkDevices } from "./placed/workDevices";
import { hostPlatform, thisDeviceSystem } from "./platform";
import { createMediatedFetch, type MediatedFetch, noNetGrants } from "./plugins/mediatedFetch";
import { PluginInstaller } from "./plugins/pluginInstaller";
import { PluginRecords } from "./plugins/pluginRecords";
import { ShellPreferencesService } from "./preferences/shellPreferences";
import {
  AppDataWatch,
  runPrivacyLog,
  SYSTEM_LOG,
  systemProcessReader,
  taskOfProcess,
} from "./privacy/appDataWatch";
import { quotaEntryForPiProvider } from "./quota/auth";
import { buildModelsCatalog, effectiveFromProvider } from "./quota/catalog";
import { managedFromClaudeAuthResult } from "./quota/claudeAuthResolve";
import { createQuotaFetcher } from "./quota/fetchQuota";
import { createFixtureRefresh } from "./quota/fixture";
import { createQuotaHttp } from "./quota/http";
import { needsReauthTargets } from "./quota/needsReauth";
import type { ProviderOutcome } from "./quota/outcome";
import { PushedQuotaStore, pushedProviderViews, withRejectedReadings } from "./quota/pushedQuota";
import { type QuotaRefresh, QuotaService } from "./quota/quotaService";
import { lowestLeft, recordCutOff } from "./quota/spentAllowance";
import { releaseNotesView } from "./releaseNotes/shown";
import { loadCatalog, ReleaseNotesService } from "./releaseNotes/startup";
import { bundledSource, recordLaunch } from "./releaseTracking";
import { AccountSelector } from "./routing/accountRouter";
import { computerBoardModels } from "./routing/computerPool";
import { DecisionKindClassifier } from "./routing/decisionKindClassifier";
import { modelAddedNote, modelGoneNote } from "./routing/modelNews";
import { modelReasonOf } from "./routing/modelReason";
import { ModelSlots } from "./routing/modelSlots";
import { PlacedWorkScores } from "./routing/placedWork";
import { quotaGateCleared, quotaGateRefValid } from "./routing/quotaGate";
import { Router, servedSlots } from "./routing/router";
import { resolveSelfSourceDir } from "./selfSource/resolve";
import { SessionBinder } from "./session/binding";
import { BoundsWatcher } from "./session/bounds";
import type { SessionFactories } from "./session/session";
import { crewMilestoneFor, SharingService } from "./sharing/sharingService";
import { SqlService } from "./sql/sqlService";
import { ActivityStore } from "./storage/activityStore";
import { type CardResolution, CardStore } from "./storage/cardStore";
import { assertSavedDataCompatible, openDatabase } from "./storage/db";
import { DecisionStore } from "./storage/decisionStore";
import { FIRSTMATE_RECIPIENT, InboxStore, SUPERVISION_RECIPIENT } from "./storage/inboxStore";
import { ScheduleStore } from "./storage/scheduleStore";
import { SettingsStore } from "./storage/settingsStore";
import type { TaskRecord } from "./storage/taskStore";
import { type UsageInput, UsageStore } from "./storage/usageStore";
import { ClosedTaskFiles } from "./tasks/closedTaskFiles";
import { CrewActions } from "./tasks/crewActions";
import { CrewLiveText, CrewTranscripts } from "./tasks/crewTranscript";
import { TaskProtocol } from "./tasks/taskProtocol";
import { TaskService } from "./tasks/taskService";
import { TaskTempFiles } from "./tasks/taskTemp";
import { WorkPresentation } from "./tasks/workPresentation";
import { createAppTelemetry } from "./telemetry";
import { readLinuxInstallation } from "./update/linuxInstall";
import { createInstalledUpdateChecker, type UpdateChecker } from "./update/updateChecker";
import { findOnPath } from "./userBin";
import { atUtilityQos } from "./utilityQos";
import { adoptBundledGit } from "./workspace/bundledGit";
import { ProjectChanges } from "./workspace/projectChanges";
import { ProjectSetups } from "./workspace/projectSetups";
import { RepoRegistry } from "./workspace/repoRegistry";
import { WorkspaceService } from "./workspace/workspaceService";

/**
 * The core composition root (daemon study D1,
 * data/fm3000-daemon-process-study-s1 section 4.5).
 *
 * Everything the app actually IS - the Firstmate agent, the supervisor and
 * the supervision session, the model sessions, the durable inbox, jobs, the
 * scheduler, quota, the account vault, routing, workspaces, the stores - is
 * built here, in plain Node. The only way out to the desktop shell is
 * `host` (src/core/host.ts); the only way back to a client is `emit`. That
 * is the whole reason src/core/ is import-fenced against Electron.
 */

/** Everything a client-facing dispatcher can reach. */
export type CoreServices = {
  paths: AppPaths;
  auth: PiAuthService;
  vault: AccountVault;
  flagship: Flagship;
  scheduler: Scheduler;
  /** The host's one clock and interval (P5); stopped at dispose. */
  ticker: Ticker;
  jobs: JobManager;
  /** Provider rows across every registered backend, for the Subscriptions tab. */
  providerViews: () => ProviderView[];
  /** The pooled availability: vault accounts plus base-runtime customs. */
  availableModels: () => { provider: string; id: string }[];
  /**
   * The decision-model seam (S7): any module may ask it a typed, bounded
   * question, and Settings reads and writes its one row through it.
   */
  decisions: DecisionModels;
  /** The install's model-slot record behind Settings -> Subscriptions. */
  slots: ModelSlots;
  /** The runtime catalog reads (docs/model-lists.md); never awaited on a user path. */
  servedModels: ServedModels;
  stopLivenessSweep: () => void;
  supervisor: CrewSupervisor;
  /** The one task writer (task-system P0/P1); the record every surface reads. */
  tasks: TaskService;
  /** The task protocol's reads and emitter (P3): board, detail, projects, feed. */
  taskProtocol: TaskProtocol;
  firstmate: FirstmateAgent;
  /** The first launch: the gate on the stage and the once-only welcome (docs/first-launch.md). */
  firstRun: FirstRunService;
  /** The dev-only local seat (roadmap 1.7): boot, Settings reads and writes; refused packaged. */
  localOrchestrator: LocalOrchestratorService;
  observe: ObserveService;
  /** What each crewmate is writing in its running turn, for its Crewmate tab. */
  crewLive: CrewLiveText;
  /** Settings → Usage (docs/usage.md): the ledger summed by period, work, day, model and place, and its recent tasks. */
  usage: {
    summary: (query: UsageQuery) => UsageSummary;
    tasks: (query: UsageTasksQuery) => UsageTasks;
  };
  /** The mediated fetch seam for plugin frames; serves no grant yet (D6). */
  pluginFetch: MediatedFetch;
  /** The `sql` read's engine: the query process over the published views. */
  sql: SqlService;
  /** Personal extensions (talk-to-personalize Step 2): the seeded workspace, compiled and served. */
  personal: PersonalExtensions;
  /** What the window did with each panel, as it last said (`inf:plugins:personal:mounts`). */
  panelMounts: PanelMountsHolder;
  /**
   * Each task's own browser (docs/task-browser.md): this Mac's, and a task's
   * on another computer as the captain reads and drives it from here.
   * Absent on a host with none.
   */
  browsers?: HomeBrowsers;
  /** The task channel its crewmate's commands reach it by (docs/axi-commands.md); absent with no browser. */
  taskCommands?: AxiChannel;
  /** The launch marker safe mode reads (Step 5); a clean quit settles it. */
  launchWatch: LaunchWatch;
  repos: RepoRegistry;
  /** The setup card: the Firstmate's proposal and the captain's click on it (docs/fleet.md). */
  projectSetups: ProjectSetups;
  projectChanges: ProjectChanges;
  /** Worktree pool and background trash cleanup (also awaited by core integration tests). */
  workspace: WorkspaceService;
  /**
   * The app's own sign-ins where projects live (git integration PR 1.2):
   * optional, one per host, read by the forge and the app's git helper.
   */
  forges: ForgeSignIns;
  /** Integrations (docs/integrations.md): the one writer over userData/integrations/. */
  integrations: IntegrationsService;
  /** Words from outside in saved conversations: their sweep and the captain's delete. */
  savedOutsideData: SavedOutsideData;
  /**
   * Pairing (docs/devices.md): the one writer over userData/devices, and the
   * connection's pairing seam. Nothing is on disk until the first link.
   */
  devices: DevicePairing;
  /**
   * Your devices as Settings -> Devices lists them, and Remove for a
   * computer that runs work, which brings its unmerged work here first
   * (src/core/devices/computers.ts).
   */
  computers: Computers;
  /**
   * Makes a link for a device, wrapped in the command for one when asked
   * (docs/devices.md, "Joining by a command"): for this Mac's own window.
   */
  inviteDevice: (request: DeviceInviteRequest) => Promise<DeviceInvite>;
  /**
   * The app a command on another Mac gets from this one, or null when this
   * copy cannot send itself (docs/devices.md, "Getting Infinitary from this Mac").
   */
  appBundle: () => string | null;
  /**
   * The Firstmate a computer that names its system and chip gets from this
   * one (docs/devices.md, "Infinitary for another system"), or null when there
   * is none to send.
   */
  farBuild: (
    system: DeviceSystem | undefined,
    chip: DeviceChip | undefined,
  ) => Promise<FarBuild | null>;
  /**
   * Adding a Mac by its address over Remote Login, and updating Firstmate
   * there (docs/devices.md, "Adding a computer by its address"): the captain's
   * own click in Settings -> Devices runs each.
   */
  remoteLogin: RemoteLogin;
  /**
   * Macs nearby with Remote Login on, listed while "By its address" is open
   * (docs/devices.md, "Macs nearby"): Settings -> Devices asks, and it stops
   * a minute after the last ask.
   */
  nearbyMacs: NearbyMacs;
  /** This computer's Bonjour announcement to a phone on its list; stopped at dispose. */
  homeAnnouncement: HomeAnnouncement;
  /** The door a phone signed in over SSH asks for a link at; closed at dispose. */
  phoneDoor?: PhoneDoor;
  /**
   * The privacy watch on macOS (docs/macos-privacy.md): each "data from
   * other apps" question a crewmate's search raises, on its task's
   * timeline; null where there is no privacy log to read.
   */
  privacyWatch: AppDataWatch | null;
  /**
   * This Mac's own SSH connection to each computer it added by its address
   * (docs/devices.md, "Through the home's SSH"): the shell starts it once it
   * attached the paired connection, and stops it before it closes that
   * connection.
   */
  sshConnections: SshConnections;
  /**
   * The home's side of a crewmate's conversation held on a computer that
   * runs work (src/core/placed/placedSessions.ts): the work requests such a
   * computer asks, answered for the task its record names on it.
   */
  placed: PlacedWork;
  /**
   * The core's way to the computers that run work (src/core/placed/workDevices.ts):
   * the shell attaches the connection once it listens.
   */
  workDevices: WorkDevices;
  /** Demand-only resource facts; does not choose or move a task. */
  computerResources: ComputerResources;
  computerResourceFeed: ComputerResourceFeed;
  automaticPlacement: AutomaticPlacement;
  /**
   * Each computer that runs work signing in to its own subscriptions, as
   * Settings -> Intelligence draws it (docs/helper.md, "Its own sign-ins").
   */
  deviceSignIns: DeviceSignIns;
  /** The person's open proposed changes where their projects live: the `forge.changes` read. */
  forgeChanges: () => Promise<ForgeChangesView>;
  forgeProjects: (host: string) => Promise<import("@shared/forges").ForgeProject[]>;
  /** The one event seam: feed, Observe, and the renderer. */
  broadcastEvent: (event: FmEvent) => void;
  /**
   * The captain's settled run whose line is Activity's newest, by id, or
   * null when the newest line is any other (docs/orchestrator-contract.md,
   * "Settled runs"): only that run's next step rewrites its line in place.
   */
  activityRun: () => string | null;
  quota: QuotaService;
  settings: SettingsStore;
  /** The one writer of the captain's presentation preferences; pushes every write. */
  preferences: ShellPreferencesService;
  /** The two switches (roadmap 1.4): the one writer of `sharing` and the gate on what leaves for us. */
  sharing: SharingService;
  activity: ActivityStore;
  /** Knowledge (docs/knowledge.md); present in every home, absent only in a helper or test. */
  knowledge?: KnowledgeService;
  updateChecker: UpdateChecker;
};

export async function createServices(
  host: HostCapabilities,
  emit: CoreEventSink,
): Promise<CoreServices> {
  const paths = appPathsFor(host.app.userDataDir);
  // Refuse before account warming, shell probes, counters or any service writes.
  assertSavedDataCompatible(paths.userData);
  // A message-length cap that truncates spills its full text here (2026-09-04
  // captain decision) rather than just dropping it - wire the app-scoped dir
  // before anything can call capWithOverflow.
  initOverflowDir(paths.overflowDir);
  initAttachmentsDir(paths.attachmentsDir);
  // Ask the person's shell for its search path once, alongside the rest of
  // boot: every child the core starts (crew shells, installs, git, Claude's
  // client) runs on it (hostEnv.ts). Awaited below, before
  // anything that can dispatch work.
  const loginPath = captureLoginPath();
  // The app's own git (git integration phase 2): every host git runs it and
  // a crewmate's shell finds it first, before anything below runs git.
  adoptBundledGit(host.app);
  const auth = await PiAuthService.create(paths);
  // The registered account backends (broker phase 7). Pi serves everything
  // it can reach; a subscription it cannot reach gets its own first-party
  // client, and the vault owns the store matrix over both.
  // Every account runtime reads the app's one models.json (custom providers
  // and per-provider overrides), keeping its own pi.dev overlay store.
  const piBackend = new PiAccountBackend({ modelsPath: paths.modelsPath });
  // Learn where the machine's Claude Code is before anything asks (F14),
  // on the person's own search path once it is known, so the Claude chip
  // and the first health read never wait on it.
  void loginPath.then(() => primeClaudeExecutable());
  const claudeBackend = new ClaudeAuthBackend({ keychain: host.keychain });
  // A sign-in or sign-out first holds the Firstmate's seat off the account
  // it rewrites (W1 S9); late-bound because the agent is built below.
  let holdSeat: ((accountId: string) => Promise<() => void>) | undefined;
  // Settled reads move the lists and the news; wired once the feed exists.
  let onCatalogSettled: () => void = () => {};
  // The store and the runtime catalog reads (docs/model-lists.md), built as
  // every computer that runs work builds its own. The rail protects the
  // slot record's starter and kept ids, read once a read lands, long after
  // the record exists below.
  const { vault, served } = createAccountStore(paths, {
    pi: piBackend,
    backends: [claudeBackend],
    holdSeat: async (accountId) => (await holdSeat?.(accountId)) ?? (() => {}),
    packaged: host.app.packaged,
    claudeConfigDir: () => defaultClaudeConfigDir(),
    rail: { protectedIds: (providerId) => slots.protectedIds(providerId) },
    onSettled: () => onCatalogSettled(),
    log: (line) => console.warn(`[models] ${line}`),
    info: (line) => console.info(`[models] ${line}`),
  });
  await vault.warm();
  await loginPath;
  const db = openDatabase(paths.userData);
  // The one decision ledger (P6): routing, account and whose-turn sort rows,
  // one writer.
  const ledger = new DecisionStore(db);
  // The `sql` read (plugin data surface, Phase B): a process of its own with
  // its own read-only connection, started on the first query. The database
  // path goes to it and to no plugin.
  const sql = new SqlService({
    spawner: host.sqlProcess,
    databasePath: join(paths.userData, "firstmate.db"),
    log: (message) => console.warn(`[infinitary] sql: ${message}`),
  });
  // The hosts on the person's own server the app knows (a GitHub Enterprise
  // host), read from the sign-in service built below.
  let knownForgeHosts: () => KnownForgeHost[] = () => [];
  const workspace = new WorkspaceService(paths, { knownHosts: () => knownForgeHosts() });
  const settings = new SettingsStore(db, desktopConventions(host.app.platform).dictationKey);
  const repos = new RepoRegistry(db, paths.fleetDir, {
    settings,
    appDataDir: paths.userData,
    knownHosts: () => knownForgeHosts(),
  });
  // The app's own sign-ins where projects live (git integration PR 1.2,
  // docs/forge.md): GitHub's device flow into userData/forges/<host>/, the
  // only GitHub sign-in the app ever reads, and a key the person makes on
  // each host on their own server (GitHub Enterprise; "Hosts on your own
  // server"). Optional by the captain's standing constraint - nothing asks
  // for one until a listing, a private clone or a proposed change needs
  // it. The dev/e2e endpoint overrides are read only by an unpackaged app.
  const forgeEndpoints = { packaged: host.app.packaged };
  let onForgeHealth: (change: ForgeHealthChange) => void = () => {};
  // The integrations read the github.com sign-in: each change to it is one of theirs.
  let integrationsChanged: () => void = () => {};
  let onForgeRenewed: (forgeHost: string) => void = () => {};
  const forgeSignIns = new ForgeSignIns({
    store: new ForgeSignInStore(paths.forgesDir),
    providers: forgeSignInProviders(forgeEndpoints),
    servers: forgeSignInServers(forgeEndpoints),
    projectHosts: () =>
      repos
        .list()
        .flatMap((repo) =>
          repo.host?.name && repo.host.kind !== "git"
            ? [{ host: repo.host.name, kind: repo.host.kind }]
            : [],
        ),
    // A host now known: its projects stamped plain Git hosts are its kind's.
    onSignedIn: (known) => repos.stampKnownHosts([known]),
    projectsOn: (forgeHost) => repos.list().filter((repo) => repo.host?.name === forgeHost).length,
    push: (view) => {
      emit("inf:forges", view);
      integrationsChanged();
    },
    onHealthChange: (change) => onForgeHealth(change),
    onRenewed: (forgeHost) => onForgeRenewed(forgeHost),
    log: (message) => console.info(message),
  });
  knownForgeHosts = () => forgeSignIns.knownHosts();
  // A host known by a sign-in on file, or a `.ghe.com` host by its name,
  // whose projects an earlier run stamped plain Git hosts.
  repos.stampKnownHosts(forgeSignIns.knownHosts());
  const githubForge = (location: ForgeLocation) => {
    const forgeHost = location.host ?? GITHUB_COM;
    return new GitHubForge(location, {
      token: () => forgeSignIns.token(forgeHost),
      apiBaseUrl: githubApiBaseFor(forgeHost, forgeEndpoints),
      onSignInRejected: () => forgeSignIns.rejected(forgeHost),
    });
  };
  const gitlabForge = (location: ForgeLocation) => {
    const forgeHost = location.host ?? "gitlab.com";
    return new GitLabForge(location, {
      token: () => forgeSignIns.token(forgeHost),
      apiBaseUrl: gitlabApiBaseFor(forgeHost, forgeEndpoints),
      onSignInRejected: () => forgeSignIns.rejected(forgeHost),
    });
  };
  // Which forge serves each kind of host: GitHub's and GitLab's, each on its
  // public host and on the person's own server. A kind with none here is a
  // plain Git host.
  const forgeBindings: ForgeBindings = { github: githubForge, gitlab: gitlabForge };
  const forgeFor = createForgeResolver(forgeBindings);
  /** The forge of a host itself, with no project: listing, lookups and account reads. */
  const forgeOnHost = (
    forgeHost: string,
  ):
    | (Pick<Forge, "listProjects" | "listProjectsPaged" | "findProject"> & {
        nestedNamespace?: boolean;
      })
    | undefined => {
    const kind = kindOfHost(forgeHost, forgeSignIns.knownHosts());
    return forgeBindings[kind]?.({ kind, host: forgeHost, dir: "" });
  };
  // What the Firstmate's own tools ask of where projects live (PR 1.2):
  // locate_project's listing, and the refusal a clone gets from a host
  // whose sign-in the app lacks.
  const forgeAccess = {
    remoteProjects: (name: string, foundLocally: boolean) =>
      remoteProjectsText({
        name,
        foundLocally,
        hosts: forgeSignIns.view().hosts.flatMap((entry) => {
          const forge = forgeOnHost(entry.host);
          if (!forge) return [];
          return [
            {
              host: entry.host,
              name: entry.name,
              signedIn: forgeSignIns.isSignedIn(entry.host),
              login: forgeSignIns.loginOf(entry.host),
              list: async () =>
                forge.listProjectsPaged
                  ? forge.listProjectsPaged()
                  : { projects: await forge.listProjects(), complete: true },
              ...(forge.findProject ? { find: forge.findProject.bind(forge) } : {}),
              ...(forge.nestedNamespace ? { nestedNamespace: true } : {}),
            },
          ];
        }),
      }),
    signInOn: (forgeHost: string) => forgeSignIns.signInOn(forgeHost),
  };
  // The `forge.changes` panel read: every GitHub and GitLab host with a
  // sign-in, read with it - github.com, each GitHub Enterprise host,
  // gitlab.com and each GitLab server - newest first across them. A host
  // that cannot be read this time answers nothing, never a guess.
  const forgeChanges = async (): Promise<ForgeChangesView> => {
    const hosts = forgeSignIns.view().signIns.flatMap((row) => {
      const kind = kindOfHost(row.host, forgeSignIns.knownHosts());
      return kind === "github" || kind === "gitlab" ? [{ host: row.host, kind }] : [];
    });
    if (hosts.length === 0) return { signedIn: false, reachable: true, changes: [] };
    let reachable = true;
    const changes: ForgeChangeRow[] = [];
    for (const { host: forgeHost, kind } of hosts) {
      const token = await forgeSignIns.token(forgeHost);
      if (!token) continue;
      try {
        changes.push(
          ...(kind === "gitlab"
            ? await readGitLabOpenChanges({
                host: forgeHost,
                token: async () => token,
                apiBaseUrl: gitlabApiBaseFor(forgeHost, forgeEndpoints),
                onSignInRejected: () => forgeSignIns.rejected(forgeHost),
              })
            : await readOpenChanges({
                host: forgeHost,
                token,
                apiBaseUrl: githubApiBaseFor(forgeHost, forgeEndpoints),
              })),
        );
      } catch (caught) {
        reachable = false;
        if (kind === "github" && isSignInForgeFailure(caught)) forgeSignIns.rejected(forgeHost);
      }
    }
    changes.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return { signedIn: true, reachable, changes };
  };
  // Git that never prompts, and answers GitHub only with that sign-in:
  // every child the core starts carries the app's helper (hostEnv.ts). The
  // hosts are read at each spawn, so a GitHub Enterprise sign-in made since
  // is answered by the app's alone too.
  configureGitSignIn({
    askpass: host.app.packaged
      ? join(host.app.resourcesDir, "git-askpass")
      : join(host.app.appDir, "resources", "git-askpass"),
    signInDir: paths.forgesDir,
    hosts: () => forgeSignIns.gitHosts(),
  });
  // The host's one clock and one interval (P5, docs/architecture.md §17):
  // the watchdog, the idle ladder, the sweeps and the schedules register
  // on it, and the stores they compare against read its clock. Dev/e2e may
  // shorten its period, so a journey waiting on a pass need not wait out
  // the minute; a packaged build always ticks at the design's.
  const ticker = new Ticker({ periodMs: tickPeriodFor(host.app.packaged, process.env) });
  // The one task writer (task-system P0): records, keys, timeline. The
  // dev boot assertion is strict off a packaged build.
  const tasks = new TaskService({ db, repos, strict: !host.app.packaged, now: ticker.now });
  const cardStore = new CardStore(db);
  const preferences = new ShellPreferencesService(settings, emit);
  // The two switches (roadmap 1.4, docs/sharing.md): the wire is built here
  // from the build-time ids and handed to the sharing service, the one
  // caller of it. Diagnostics - the allowlisted events of
  // src/shared/diagnostics.ts with the anonymous install ID - is on by
  // default, goes once the person has been told, and stops with the switch.
  const appTelemetry = createAppTelemetry({ version: host.app.version });
  const sharing = new SharingService({
    settings,
    emit,
    raw: appTelemetry.client,
    telemetryConfig: appTelemetry.body,
    destination: appTelemetry.destination,
    decisions: {
      list: (since, limit) => tasks.decisionBacklog(since, limit),
      count: (since) => tasks.decisionBacklogCount(since),
    },
  });
  // The launch event, and whatever an earlier run left unsent.
  sharing.start();
  // Safe-mode boot (talk-to-personalize Step 5): before anything a personal
  // panel could reach, decide whether the last two launches survived. Two
  // that did not come up with the captain's own panels off, with the reason
  // recorded so the app can say why rather than losing them silently.
  //
  // Dev/e2e may widen the window a launch has to survive, so the crash-loop
  // fixture kills the app on a signal rather than racing a slow boot; a
  // packaged build always uses the design's.
  const earlyLaunchMs = host.app.packaged
    ? Number.NaN
    : Number.parseInt(settingFrom(process.env, "EARLY_LAUNCH_MS") ?? "", 10);
  const launchWatch = new LaunchWatch({
    read: () => settings.getLaunchRecord(),
    write: (record) => settings.setLaunchRecord(record),
    ...(Number.isFinite(earlyLaunchMs) && earlyLaunchMs > 0 ? { earlyLaunchMs } : {}),
  });
  const launch = launchWatch.begin();
  const enteredSafeMode = launch.safeMode && preferences.get().panels.enabled;
  if (enteredSafeMode) preferences.setPersonalPanels(false, "safe-mode");
  const personalPanelsEnabled = preferences.get().panels.enabled;
  const activity = new ActivityStore(db);
  let closingResolutionOf: (taskId: string) => CardResolution | undefined = () => undefined;
  const knowledge = new KnowledgeService({
    dir: paths.knowledgeDir,
    projects: {
      get: (id) => repos.get(id),
      list: () => repos.list(),
    },
    tasks: {
      resolve: (ref) => {
        const record = tasks.resolve(ref);
        return record ? { id: record.id, key: record.key, repoId: record.repoId } : undefined;
      },
      reports: (taskId) =>
        tasks
          .timeline(taskId)
          .filter((event) => event.kind === "report")
          .map((event) => ({ id: event.id, text: event.text })),
    },
    approvals: {
      of: (ref) => {
        const record = tasks.resolve(ref);
        const resolution = record && closingResolutionOf(record.id);
        return record && resolution
          ? {
              key: record.key,
              title: resolution.card.title,
              body: resolution.card.body,
              action: resolution.action,
              resolvedAt: resolution.resolvedAt,
            }
          : undefined;
      },
    },
    announce: (text) => broadcastEvent({ type: "firstmate_note", text }),
    gitFacts: workingCopyFacts,
    now: ticker.now,
    // The browser reads again after a write commits and after the purge.
    changed: () => broadcastEvent({ type: "knowledge_changed" }),
  });
  // Startup stops if any active direction cannot be carried; no old runtime fallback.
  knowledge.carryDirections(db);
  // The durable inbox (design A): rows a dead process left in-flight go
  // back to pending before anything can drain - the boot half of
  // ack-after-handling (at-least-once; a rare duplicate over a silent loss).
  // Dev/e2e may shorten the grace between delivery attempts, so a journey
  // that quits mid-turn sees its redelivery without waiting it out; a
  // packaged build always uses the design's.
  const inboxGraceMs = host.app.packaged
    ? Number.NaN
    : Number.parseInt(settingFrom(process.env, "INBOX_GRACE_MS") ?? "", 10);
  const inbox = new InboxStore(db, {
    now: ticker.now,
    ...(Number.isFinite(inboxGraceMs) && inboxGraceMs > 0 ? { graceMs: inboxGraceMs } : {}),
  });
  // A lane whose turn runs on a computer that runs work stays in flight:
  // that turn went on without this process (docs/helper.md).
  inbox.resetInFlight(
    tasks
      .listActive()
      .filter((record) => record.deviceId)
      .map((record) => record.id),
  );
  // Retire only the obsolete typed composition request, not prose or other work.
  inbox.retireTypedWakes(FIRSTMATE_RECIPIENT, ["welcome"]);
  // Every event broadcast passes one seam: feed-worthy lines are persisted
  // (P10) so the feed survives restarts, then the event reaches the renderer.
  // Observe's live buffer rides the same seam, so a session's in-flight turn
  // is readable by any client without a second stream (late-bound: the
  // service is built after the agents it observes).
  let observeEvent: (event: FmEvent) => void = () => {};
  let browserFactOf: (taskId: string) => TaskBrowserFact | undefined = () => undefined;
  let crewActionsOf: (record: TaskRecord) => readonly TaskActionLine[] = () => [];
  let crewSaidOf: (record: TaskRecord) => TaskActionLine | null = () => null;
  // The Crewmate tab's transcripts, read from the same files (late-bound
  // too), and what each crewmate is writing now, fed from the seam below.
  let crewTranscripts: CrewTranscripts | undefined;
  const crewLive = new CrewLiveText();
  let runsOnOf: (record: TaskRecord) => TaskRunsOn | undefined = () => undefined;
  let placeOf: (record: TaskRecord) => TaskPlace | undefined = () => undefined;
  let scheduleWorkPresentation = () => {};
  let hearPresentation: (event: FmEvent) => void = () => {};
  let readWorkPosture: ((record: TaskRecord) => WorkPosture) | undefined;
  // The run whose line is Activity's newest, with that line's row
  // (`feedRunOf`): the captain's settled run on one setting
  // (docs/orchestrator-contract.md, "Settled runs"), or a copy's count of
  // what it sent so far (docs/devices.md, "How far the copy has gone"). Any
  // other line ends it, so a later step of the run rewrites its line in
  // place only while nothing else has entered Activity since.
  let runLine: { id: string; row: number } | null = null;
  const broadcastEvent = (event: FmEvent) => {
    // A feed line about a task is a row on that task's record (FI3-1189's
    // rule 1): written there as news, and the feed reads it back as the
    // task's own line (docs/task-record.md, "What Activity holds").
    if (event.type === "firstmate_note" && event.taskId && tasks.get(event.taskId)) {
      tasks.note(event.taskId, event.text, { news: true, feed: true, data: { feedLine: true } });
      return;
    }
    // Crew changes only; streaming deltas must not scan the task table, and
    // a task write asks through its own change (`WorkPresentation`).
    hearPresentation(event);
    const line = feedLineFrom(event);
    const run = feedRunOf(event);
    if (run && runLine?.id === run.id) {
      if (run.withdrawn) {
        activity.withdraw(runLine.row);
        runLine = null;
      } else if (line) activity.rewrite(runLine.row, line);
    } else if (line) {
      // A task's own line already lives in task_events (P3: the feed is a
      // view over both tables); persisting it again would show it twice.
      const row = event.type === "task_event" ? null : activity.record(line);
      runLine = run && row !== null ? { id: run.id, row } : null;
    }
    // The crew half of the first-run funnel (docs/sharing.md): kept once each.
    const milestone = crewMilestoneFor(event);
    if (milestone) sharing.record(milestone);
    observeEvent(event);
    crewLive.apply(event);
    emit("inf:event", event);
  };
  // The task protocol's emitter (P3): every committed TaskService write
  // becomes task_changed / task_event FmEvents through the seam above and
  // one coalesced inf:tasks board push, rebuilt from SQLite after the commit.
  // Dev/e2e may lower the delta trigger (P5) to drive the delta carrier on
  // a small fleet; a packaged build always measures against the design's.
  const deltaRows = host.app.packaged
    ? undefined
    : Number.parseInt(settingFrom(process.env, "TASK_DELTA_ROWS") ?? "", 10);
  // Task readers can run during async boot, before the supervisor restores the stack.
  let cardStack:
    | Pick<CrewSupervisor, "cardsSnapshot" | "flushCards" | "browserReturned">
    | undefined;
  const taskProtocol = new TaskProtocol({
    tasks,
    validationEvidence: (taskId, evidence) =>
      readKeptValidationEvidence(evidence, crewmateCardPicturesDir(paths, taskId), taskId),
    repos,
    cards: {
      listOpen: () => cardStore.listOpen(),
      snapshot: () => cardStack?.cardsSnapshot() ?? [],
      forTask: (taskId, extraIds) => cardStore.forTask(taskId, extraIds),
    },
    beforePush: () => cardStack?.flushCards(),
    workPosture: (record) =>
      readWorkPosture?.(record) ?? { state: "unknown", reason: "unobserved" },
    // Late-bound: each task's own browser is built below, on a host with one.
    browser: (taskId) => browserFactOf(taskId),
    // Late-bound too: what a crewmate did, from its kept session, read below.
    actions: (record) => crewActionsOf(record),
    said: (record) => crewSaidOf(record),
    transcript: {
      of: (record, events, closed) =>
        crewTranscripts?.of(record, events, closed) ?? emptyTranscript(record.id),
      result: (record, ref) => crewTranscripts?.result(record, ref) ?? null,
      picture: (record, ref) => crewTranscripts?.picture(record, ref) ?? null,
    },
    // And where a task runs, which the crew supervisor below decides.
    runsOn: (record) => runsOnOf(record),
    place: (record) => placeOf(record),
    startAttempt: (taskId) => tasks.startAttemptOf(taskId),
    // The crewmate's solid on the orbit: the slot its newest routing chose.
    tiers: (taskIds) => servedSlots(ledger, taskIds),
    // The summary's line under the model: the same decision, its typed columns.
    modelReason: (record) =>
      modelReasonOf(record, {
        decisions: ledger,
        pins: () => settings.getRoutingSettings().pins,
        keyOf: (ref) => tasks.resolve(ref)?.key || undefined,
      }),
    // Read at a detail read, long after the slot record below is built:
    // the one model-name lookup the renderer applies too (FI3-565 piece 2).
    modelLabel: (model) => slots.nameOf(parseOfferingKey(model)),
    broadcastEvent,
    emit,
    ...(deltaRows !== undefined && Number.isFinite(deltaRows) && deltaRows >= 0
      ? { deltaTrigger: { rows: deltaRows, bytes: BOARD_DELTA_TRIGGER.bytes } }
      : {}),
  });
  // Background jobs (R2): the exit is the wake. Routing is late-bound
  // because the agent and supervisor are built below.
  let routeJobExit: (exit: JobExit) => void = () => {};
  const jobs = new JobManager({
    db,
    onExit: (exit) => routeJobExit(exit),
    now: ticker.now,
    onChange: () => scheduleWorkPresentation(),
  });
  const pushedQuota = new PushedQuotaStore(db);
  /**
   * The machine's default Claude config root when this account is Claude,
   * or nothing. Locations only - never a credential. CD-1=B: not the vault
   * account directory, which is bookkeeping only.
   */
  const claudeStoreDir = (accountId: string): string | undefined => {
    const account = vault.list().find((row) => row.id === accountId);
    if (!account || quotaEntryForPiProvider(account.providerId)?.quotaId !== "claude") {
      return undefined;
    }
    return defaultClaudeConfigDir();
  };
  // A crewmate's transcript is its task's record: Pi's is the session file
  // itself, Claude's the app's copy under the session id the row holds,
  // else the client's own file in the account's store.
  const crewmateTranscript = createCrewmateTranscriptResolver({
    recordDirOf: (taskId) => crewmateSessionsDir(paths, taskId),
    backendOf: (accountId) => vault.backendIdOf(accountId),
    configDirOf: (accountId) => {
      try {
        return claudeStoreDir(accountId);
      } catch {
        return undefined;
      }
    },
  });
  // The record's Activity reads what each crewmate did from the same files.
  const crewActions = new CrewActions({
    recordDirOf: (taskId) => crewmateSessionsDir(paths, taskId),
    currentSession: (record) => crewmateTranscript(record).path,
    appTools: new Set(CREWMATE_TOOLS.map((tool) => tool.name)),
  });
  crewActionsOf = (record) => crewActions.of(record);
  crewSaidOf = (record) => crewActions.said(record);
  crewTranscripts = new CrewTranscripts({
    recordDirOf: (taskId) => crewmateSessionsDir(paths, taskId),
    currentSession: (record) => crewmateTranscript(record).path,
  });
  const quotaUnresolved = new Map<string, ProviderOutcome>();
  /**
   * The quota catalog's rows for a client-served provider: the shipped list
   * plus whatever a successful read added, named as the shipped list names
   * them where it does. The catalog is provider-wide on purpose - it is
   * what routing walks, so every served id must have a row.
   */
  const servedCatalogModels = (
    providerId: string,
    shipped: ReadonlyArray<{ id: string; name: string }>,
  ): { provider: string; id: string; name: string }[] => {
    const byId = new Map(shipped.map((model) => [model.id, model.name]));
    for (const account of vault.list()) {
      if (account.providerId !== providerId || !account.enabled) continue;
      for (const model of served.read(account.id)?.models ?? []) {
        if (!byId.has(model.id)) byId.set(model.id, model.name ?? model.id);
      }
    }
    return [...byId.entries()].map(([id, name]) => ({ provider: providerId, id, name }));
  };
  /** Every model the quota catalog carries: provider-wide, served-aware. */
  const quotaCatalogModels = () => [
    ...auth.catalogModels(vault.piModelRuntimes()),
    ...servedCatalogModels(CLAUDE_PROVIDER_ID, CLAUDE_MODELS),
  ];
  const resolveQuotaAuth = async (accountId: string, options?: { allowPrompt?: boolean }) => {
    // A Claude account's usage credential is the machine's default
    // login (bare Keychain item / ~/.claude). Every other sensed account
    // resolves through its Pi runtime. Infinitary never mints Anthropic OAuth.
    const claudeDir = claudeStoreDir(accountId);
    if (claudeDir !== undefined) {
      const mapped = managedFromClaudeAuthResult(
        await resolveClaudeQuotaAuthResult(claudeDir, {
          keychain: host.keychain,
          allowPrompt: options?.allowPrompt,
        }),
      );
      if (mapped.unresolved) quotaUnresolved.set(accountId, mapped.unresolved);
      else quotaUnresolved.delete(accountId);
      return mapped.managed;
    }
    return vault.resolveForQuota(accountId);
  };
  // Dev/e2e can point the quota sensor at fixture files instead of live APIs.
  const fixtureDir = host.app.packaged
    ? undefined
    : settingFrom(process.env, "QUOTA_FIXTURE_DIR")?.trim();
  const quotaRefresh: QuotaRefresh = fixtureDir
    ? createFixtureRefresh(fixtureDir)
    : createQuotaFetcher({
        // One sensor call per enabled account, resolved from that account's
        // own store (broker phase 2).
        auth: {
          accounts: () =>
            vault.list().flatMap((account) => {
              if (!account.enabled) return [];
              const entry = quotaEntryForPiProvider(account.providerId);
              if (!entry?.sensed) return [];
              return [
                {
                  accountId: account.id,
                  accountLabel: account.label,
                  quotaId: entry.quotaId,
                  piId: entry.piId,
                  providerLabel: entry.label,
                },
              ];
            }),
          resolve: resolveQuotaAuth,
          // A Pi account whose refresh token the provider refused is the
          // lapsed-sign-in proof: the row says sign in again.
          unresolved: (accountId) =>
            quotaUnresolved.get(accountId) ??
            (vault.refreshLapsed(accountId)
              ? { status: "auth_required", windows: [], reason: REFRESH_TOKEN_LAPSED }
              : undefined),
          /**
           * One caller of AccountBackend.renew (spec §11.2.5): the reactive
           * 401 path. Proactive renew at expiresAt-lead rides the supervisor
           * tick. Neither path returns a secret; we re-resolve after a
           * successful rotation.
           */
          renew: async (accountId) => {
            const outcome = await vault.renew(accountId, "vendor_rejected");
            if (outcome.outcome !== "renewed") return { outcome: outcome.outcome };
            const managed = await resolveQuotaAuth(accountId);
            return managed
              ? { outcome: "renewed" as const, auth: managed }
              : { outcome: "unreadable" as const };
          },
        },
        http: createQuotaHttp(),
        // Dev/e2e only, exactly like the fixture seam above: a packaged app
        // never reads it, so the real endpoints cannot be redirected in a
        // build anyone runs.
        ...(host.app.packaged
          ? {}
          : {
              endpoints: {
                ...(settingFrom(process.env, "CLAUDE_USAGE_URL")?.trim()
                  ? { claudeUsageUrl: settingFrom(process.env, "CLAUDE_USAGE_URL")?.trim() }
                  : {}),
                ...(settingFrom(process.env, "GROK_USAGE_URL")?.trim()
                  ? { grokUsageUrl: settingFrom(process.env, "GROK_USAGE_URL")?.trim() }
                  : {}),
                ...(settingFrom(process.env, "GROK_KEY_URL")?.trim()
                  ? { grokKeyUrl: settingFrom(process.env, "GROK_KEY_URL")?.trim() }
                  : {}),
                ...(settingFrom(process.env, "KIMI_USAGE_URL")?.trim()
                  ? { kimiUsageUrl: settingFrom(process.env, "KIMI_USAGE_URL")?.trim() }
                  : {}),
                ...(settingFrom(process.env, "COPILOT_USAGE_URL")?.trim()
                  ? { copilotUsageUrl: settingFrom(process.env, "COPILOT_USAGE_URL")?.trim() }
                  : {}),
              },
            }),
        models: () => quotaCatalogModels(),
        loginOf: (accountId) => vault.loginSync(accountId),
        // A session's refusal is a zero window until its reset, even on a
        // sensed row: the vendor said no, and the sensor lags behind it.
        onAccepted: (accountId, windows) => {
          vault.noteAccepted(accountId);
          // More left than when the allowance was refused: credits were
          // added, so the hold and its refused reading end now.
          const left = lowestLeft(windows);
          if (left !== undefined && vault.noteReading(accountId, left))
            endRefusedReadings(accountId);
        },
        overlay: (view, now) =>
          view.accountId
            ? withRejectedReadings(view, pushedQuota.windowsFor(view.accountId), now)
            : view,
        // Session-pushed readings still merge for any provider the HTTP
        // sensor does not cover.
        pushed: (now) =>
          pushedProviderViews(
            vault.list().flatMap((account) => {
              const entry = quotaEntryForPiProvider(account.providerId);
              if (!entry || entry.sensed) return [];
              return [
                {
                  accountId: account.id,
                  accountLabel: account.label,
                  quotaId: entry.quotaId,
                  providerLabel: entry.label,
                },
              ];
            }),
            (accountId) => pushedQuota.windowsFor(accountId),
            now,
          ),
      });
  // A refresh can un-bench a quota-benched Firstmate; wired after creation.
  let onQuotaRefreshed: () => void = () => {};
  let reconcileFirstRun: () => void = () => {};
  let onCardsChanged: () => void = () => {};
  let onCaptainTurnAccepted: () => void = () => {};
  const placedWork = new PlacedWorkScores(db, settings);
  const quota = new QuotaService({
    refresh: quotaRefresh,
    db,
    // The fixture seam (dev/e2e) supplies its own catalog; only the real
    // fetcher's catalog is rebuilt when a read lands.
    ...(fixtureDir
      ? {}
      : {
          catalogFor: (snapshot: QuotaSnapshotView) =>
            buildModelsCatalog(quotaCatalogModels(), snapshot.providers, snapshot.generatedAt),
        }),
    broadcast: (snapshot) => {
      placedWork.observe("home", snapshot);
      onQuotaRefreshed();
      reconcileFirstRun();
      emit("inf:quota", snapshot);
    },
  });
  const savedQuota = quota.latest();
  if (savedQuota) placedWork.observe("home", savedQuota);
  // The routing pool: account-served models plus base-runtime custom
  // providers (models.json). Provider credentials live only in the vault.
  const availableModels = () => {
    const seen = new Set<string>();
    const models: { provider: string; id: string }[] = [];
    for (const model of [...vault.availableModels(), ...auth.customProviderModels()]) {
      const key = `${model.provider}/${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(model);
    }
    return models;
  };
  // Capability at routing time (redesign stage 1): a candidate's def is
  // resolved from the same runtimes the session will use, so a model that
  // cannot carry the turn is skipped BEFORE it is chosen rather than 400ing
  // mid-turn. withHonestReasoning has already corrected these defs.
  const capabilityFor = createModelCapabilityLookup(() => [
    ...vault.piModelRuntimes(),
    auth.modelRuntime,
  ]);
  // The slot record: which of the user's models Firstmate may spend on its
  // own, and as what. Seeded from the starter map per offering; live-catalog
  // newcomers arrive off unless the map names them.
  // Filled once device sign-ins exist. The board reads it when it draws, not now.
  const computerSignIns: { view?: () => ReturnType<DeviceSignIns["view"]> } = {};
  const slots = new ModelSlots({
    settings,
    speeds: () => {
      // Each computer's word is read, and narrowed, once for the whole board.
      const now = Date.now();
      const servedThere = (computerSignIns.view?.() ?? [])
        .filter(
          (device) =>
            device.reach === "in-reach" &&
            device.asOf !== undefined &&
            now - device.asOf < 24 * 60 * 60 * 1000,
        )
        .flatMap(
          (device) =>
            device.signIns?.served?.flatMap((row) =>
              device.signIns?.accounts.some(
                (account) => account.id === row.accountId && account.enabled && account.connected,
              )
                ? row.models
                : [],
            ) ?? [],
        );
      return (accountId, ref) => {
        const here = served.speeds(accountId, ref.id);
        const there = servedThere
          .filter(
            (model) =>
              model.provider === ref.provider &&
              model.id === ref.id &&
              model.speedsUntil !== undefined &&
              model.speedsUntil > now,
          )
          .flatMap((model) => model.speeds ?? []);
        return here || there.length ? [...new Set([...(here ?? []), ...there])] : undefined;
      };
    },
    reasoningCapabilities: (ref) => {
      if (ref.provider === CLAUDE_PROVIDER_ID) return claudeReasoningCapabilities(ref.id);
      for (const runtime of [...vault.piModelRuntimes(), auth.modelRuntime]) {
        const capabilities = piReasoningCapabilities(runtime.getModel(ref.provider, ref.id));
        if (capabilities) return capabilities;
      }
      return undefined;
    },
    accounts: () => {
      const home = vault.availableModelsByAccount().map((row) => ({
        accountId: row.accountId,
        accountLabel: row.accountLabel,
        providerId: row.providerId,
        models: row.models,
      }));
      const catalogProviders = new Set(
        (quota.latestModels()?.models ?? []).map((model) => servedProviderOf(model.provider)),
      );
      return [...home, ...computerBoardModels(computerSignIns.view?.() ?? [], catalogProviders)];
    },
    quotaModels: () => quota.latestModels(),
    // Pins and the Firstmate model keep a model listed like a slot does.
    kept: () => {
      const refs = settings.getRoutingSettings().pins.map((pin) => ({
        provider: servedProviderOf(pin.provider),
        id: pin.id,
      }));
      const firstmateModel = settings.getFirstmateModel();
      return firstmateModel ? [...refs, firstmateModel] : refs;
    },
    // A client-served account announces arrivals only from a successful
    // read; a Pi account's catalog is always Pi's own answer.
    canAnnounce: (accountId) => {
      const account = vault.get(accountId);
      if (!account || backendForProvider(account.providerId) === "pi") return true;
      return served.read(accountId) !== undefined;
    },
    now: ticker.now,
  });
  /**
   * The routing boundary: the sign-in gate, then the slot record, with the
   * starter-map fallback behind it. Every automatic selection reads THIS;
   * `availableModels` stays the raw pool for pins, names, and the quota
   * gate, and a picker reads its listed part (`slots.listedOf`).
   */
  const routableModels = () => slots.routable(availableModels()).models;
  /**
   * The decision-model pool (W1 S10): every routable model a classifier
   * session can be created on - Pi-served in process, Claude-served on the
   * machine's own client - in one low-first walk (the owner's Q3 a). An
   * account a cut-off withholds, or one with no client, has no models in
   * the routable pool, so it is out of this one too.
   */
  const decisionServedModels = () =>
    routableModels().filter((model) => model.provider !== "anthropic");
  /**
   * What a named decision offering may bind: the whole signed-in pool pins
   * read, slot or no slot - a model that is not in use is still available,
   * and naming it is its own placement - which is the pool the picker lists.
   */
  const decisionNamedModels = () =>
    availableModels().filter((model) => model.provider !== "anthropic");
  const router = new Router({
    quota,
    placedWork,
    settings,
    decisions: ledger,
    availableModels,
    slots,
    capabilityFor,
    withheldModels: () => vault.withheldModels(),
  });
  const accounts = new AccountSelector({
    pool: vault,
    placedWork,
    quota,
    flagshipAccountId: () => settings.getFirstmateAccount(),
    decisions: ledger,
  });
  /**
   * A plan-window reading a Claude client pushed - a crewmate's, the
   * classifier's or the seat's - recorded for the account's quota.
   */
  const recordClaudeRateLimit = (accountId: string, reading: ClaudeRateLimit) => {
    if (!reading.windowId) return;
    const refusedBefore = pushedQuota
      .windowsFor(accountId)
      .some((window) => window.windowId === reading.windowId && window.status === "rejected");
    pushedQuota.record(accountId, {
      windowId: reading.windowId,
      status: reading.status,
      ...(reading.utilization !== undefined ? { utilization: reading.utilization } : {}),
      ...(reading.resetsAt !== undefined ? { resetsAt: reading.resetsAt } : {}),
      at: Date.now(),
    });
    // A window that just said no, or just stopped saying it, moves the
    // account's headroom now rather than at the next sensor pass.
    if ((reading.status === "rejected") !== refusedBefore) void quota.refresh("pushed");
  };
  /** A typed cut-off a session observed, recorded on its account (`recordCutOff`). */
  const noteCutOff = (accountId: string, cutOff: CutOff) =>
    recordCutOff(
      {
        providerOf: (id) => vault.get(id)?.providerId,
        latest: () => quota.latest(),
        hold: (id, held, seen) => vault.noteCutOff(id, held, seen),
        holding: (id) => vault.cutOff(id)?.class === "no_headroom",
        refuse: (id, refused) =>
          pushedQuota.record(id, {
            windowId: refused.windowId,
            status: "rejected",
            resetsAt: refused.resetsAt,
            at: refused.at,
          }),
        refresh: () => void quota.refresh("pushed"),
      },
      accountId,
      cutOff,
      Date.now(),
    );
  const endRefusedReadings = (accountId: string) => {
    for (const window of pushedQuota.windowsFor(accountId)) {
      if (window.status === "rejected") {
        pushedQuota.record(accountId, { ...window, status: "allowed", at: Date.now() });
      }
    }
  };
  /**
   * Every model session the app opens comes from one factory per backend
   * (the session contract): a crewmate's, the question's one-shots and the
   * Firstmate seat's rolling session alike, each its role's preset. Pi's in
   * process, a crewmate's bash the host's own event-driven one (R2); Claude's
   * on the machine's own client and default login, a rolling session's record
   * in the app's own store. One watcher holds every session of both to its
   * spec's time bounds on the one clock (`session/bounds.ts`). The admission
   * gate is each factory's: a role states the steer it needs, and a backend
   * that cannot honestly deliver it refuses the session rather than degrade
   * into it.
   */
  const bounds = new BoundsWatcher(ticker);
  const sessionFactories: SessionFactories = {
    pi: bounds.factory(
      createPiSessionFactory({
        agentDir: paths.piAgentDir,
        runBash: (input) => jobs.run(input),
        speedCapabilities: (accountId, id) =>
          accountId ? served.speeds(accountId, id) : undefined,
      }),
    ),
    claude: bounds.factory(
      createClaudeSessionFactory({
        configDir: defaultClaudeConfigDir(),
        clock: ticker,
        onRateLimit: (accountId, reading) => recordClaudeRateLimit(accountId, reading),
        onServed: (accountId) => vault.noteAccepted(accountId),
        log: (line) => console.warn(`[claude-session] ${line}`),
      }),
    ),
  };
  /**
   * A crewmate's account to its binding: the account's own Pi runtime, or
   * the machine's Claude login, by the account's provider. Direct injection
   * (broker phase 4): exactly one store in reach.
   */
  /**
   * The computers that run work for this home (docs/helper.md, "Holding a
   * conversation"): the connection reaches them once the shell attaches it,
   * and a task whose record names one opens its conversation there.
   */
  const workDevices = new WorkDevices();
  const computerResources = new ComputerResources({
    work: workDevices,
    local: new ResourceSampler({ memory: host.resourceMemory }),
  });
  // Leave from a Mac that runs work is Remove's, which brings its work here
  // first; bound once Your devices exists (docs/devices.md, "Leave").
  let leaveWithWork: (device: DeviceView) => boolean = () => false;
  const loopbackPort = host.app.packaged
    ? Number.NaN
    : Number.parseInt(settingFrom(process.env, "CONNECTION_LOOPBACK_PORT") ?? "", 10);
  const devices = new DevicePairing({
    dir: paths.devicesDir,
    // Dev/e2e may keep the connection to loopback at a port of its own
    // (tests/e2e/launch.ts): with no private address in view, a link names
    // 127.0.0.1 at that port, so a test never listens on this Mac's network,
    // where a firewall can drop the dial, or on the port a real app holds.
    ...(loopbackPort > 0 && loopbackPort < 65_536
      ? {
          port: loopbackPort,
          interfaces: () => standInInterfaces(host.app.packaged) ?? {},
        }
      : standInInterfaces(host.app.packaged)
        ? { interfaces: () => standInInterfaces(host.app.packaged) ?? {} }
        : {}),
    // Dev/e2e may stand in another Mac for every device that joins, so two
    // apps on one Mac read as two Macs; an installed app never does.
    ...(!host.app.packaged && settingFrom(process.env, "JOINS_FROM_ANOTHER_MAC") === "1"
      ? { joinsFromAnotherMac: true }
      : {}),
    leaveWithWork: (device) => leaveWithWork(device),
    // A Linux home says when its own firewall may keep devices out
    // (docs/devices.md, "A Linux home's firewall"); a Mac's asks its person.
    ...(hostPlatform() === "linux"
      ? { firewall: () => firewallKeepsOut({ port: CONNECTION_PORT }) }
      : {}),
    // One feed line when a device joins, or finds this Mac again; it names
    // the device, never the link. A computer that runs work then gets its
    // setup card (docs/devices.md, "Finishing its setup").
    onJoined: (device, found, again) => {
      broadcastEvent({
        type: "device_joined",
        deviceId: device.id,
        name: device.name,
        kind: device.kind,
        ...(device.user ? { user: device.user } : {}),
        ...(device.onThisMac !== undefined ? { onThisMac: device.onThisMac } : {}),
        ...(found ? { found } : {}),
        ...(again ? { again } : {}),
        ...(device.reachedOn ? { reachedOn: device.reachedOn } : {}),
      });
      deviceSetup?.joined(device, found, again);
    },
    onLeft: (device) =>
      broadcastEvent({
        type: "device_left",
        deviceId: device.id,
        name: device.name,
        kind: device.kind,
      }),
  });
  const computerResourceFeed = new ComputerResourceFeed({
    resources: computerResources,
    computers: () => [
      { computerId: null, label: HERE.This },
      ...devices
        .list()
        .filter((device) => deviceRunsWork(device.kind))
        .map((device) => ({
          computerId: device.id,
          label: deviceLabel(device),
        })),
    ],
    onComputers: (listener) => devices.subscribe(listener),
    onContact: (listener) => workDevices.onWorkDevice(listener),
    emit: (view) => emit("inf:computers:resources", view),
  });
  const networkStandIn = host.app.packaged
    ? undefined
    : settingFrom(process.env, "STAND_IN_NETWORK_NAME")?.trim();
  if (networkStandIn) {
    devices.noteNetworkName(networkStandIn);
  } else {
    void ownNetworkNames().then((names) => {
      const local = names.filter((name) => name.endsWith(".local"));
      devices.noteNetworkName(local.at(-1) ?? null);
    });
  }
  // The app a command on another Mac gets from this one, and how another
  // user on this Mac starts this one (docs/devices.md, "Joining by a command").
  const appBundle = appBundleOf({
    packaged: host.app.packaged,
    executable: process.execPath,
    env: process.env,
    // An installed Linux app sends itself whole only as the AppImage it runs from.
    appImage:
      host.app.packaged && hostPlatform() === "linux"
        ? (readLinuxInstallation({
            chip: process.arch,
            resourcesDir: host.app.resourcesDir,
            execPath: process.execPath,
            env: process.env,
          }).appImage ?? null)
        : null,
  });
  // The Firstmate a computer of another system gets from this one
  // (docs/devices.md, "Infinitary for another system"): this app's own when it
  // suits, else the one published for that system at this version. Only an
  // installed release reads the public tap; a development run reads a
  // stand-in tap a test names, or none, and so keeps link pairing.
  const tapStandIn = host.app.packaged
    ? undefined
    : settingFrom(process.env, "PUBLISHED_TAP")?.trim();
  const releaseFlavor = (host.app.flavor ?? (host.app.packaged ? "release" : "dev")) === "release";
  const farBuilds = new FarBuilds({
    own: () => appBundle,
    published:
      (host.app.packaged && releaseFlavor) || tapStandIn
        ? new PublishedBuilds({
            version: host.app.version,
            dir: join(paths.devicesDir, "builds"),
            ...(tapStandIn ? { fetchImpl: standInTapFetch(tapStandIn) } : {}),
          })
        : null,
    chip: thisDeviceSystem().chip ?? null,
  });
  /** The Firstmate for a computer of `system` on `chip`, or null when there is none to send. */
  const farBuild = async (system: DeviceSystem | undefined, chip: DeviceChip | undefined) => {
    const far = farSystemNamed(system);
    const on = far ? (chip ?? Object.values(far.chips)[0]) : undefined;
    if (!far || !on || !Object.values(far.chips).includes(on)) return null;
    const build = await farBuilds.for(far, on);
    return "refusal" in build ? null : build;
  };
  const launcher = appLauncher({
    packaged: host.app.packaged,
    platform: hostPlatform(),
    execPath: process.execPath,
    appDir: host.app.appDir,
    resourcesDir: host.app.resourcesDir,
    env: process.env,
  });
  const inviteDevice = async (request: DeviceInviteRequest): Promise<DeviceInvite> => {
    // Every Mac added now can both control and run work, so no new link
    // makes one that only controls (docs/devices.md, "The link").
    if (request.kind === "view")
      throw new Error(
        `A new link adds a ${COMPUTER.one} that can control your first mate and run work.`,
      );
    // A command for another Mac adds a Mac; one for another user here a
    // computer that only runs work.
    if (request.command && (request.command === "another-user") !== (request.kind === "work"))
      throw new Error(
        `Only the command for another user on ${HERE.this} adds one that only runs work.`,
      );
    if (request.command === "another-mac" && !farBuilds.canSendAny())
      throw new Error(
        host.app.packaged && host.app.platform !== "darwin"
          ? `This copy of Infinitary cannot send itself to another ${COMPUTER.one}: the command adds a Mac. Paste a link into Infinitary on the other ${COMPUTER.one} instead.`
          : `This copy of Infinitary cannot send itself to another ${COMPUTER.one}; only an installed one can.`,
      );
    // A command for another Mac downloads this computer's published version
    // there first, looked up without downloading it here, and its link lasts
    // long enough for that download and the copy from here it falls back to
    // (docs/devices.md, "Joining by a command"); a development or
    // unpublished one gets it from here, with a link of the usual lifetime.
    const mac = farSystemNamed("macos");
    const download =
      request.command === "another-mac" && mac
        ? await farBuilds.downloadFor(mac, Object.values(mac.chips)[0] ?? "arm64")
        : null;
    const invite = devices.invite(
      request,
      download ? { lastsMs: DOWNLOAD_COMMAND_LINK_TTL_MS } : {},
    );
    if (!request.command) return invite;
    return {
      ...invite,
      command: {
        for: request.command,
        text: joinCommand({
          for: request.command,
          link: invite.link,
          homeName: await ownComputerName({ packaged: host.app.packaged, env: process.env }),
          launcher,
          ...(download ? { download: { ...download, expiresAt: invite.expiresAt } } : {}),
        }),
      },
    };
  };
  // The captain's own SSH, or a development run's stand-in for it, so a test
  // never reaches a real Mac (docs/devices.md, "Adding a computer by its address").
  const sshStandIn = host.app.packaged ? undefined : settingFrom(process.env, "SSH")?.trim();
  const ssh = sshStandIn ? { program: sshStandIn, args: [] } : systemSsh();
  const flavor = host.app.flavor ?? (host.app.packaged ? "release" : "dev");
  // Devices reads each connection's state; the list is made further on.
  let devicesChanged = () => {};
  // Nothing here starts it: the shell does, once it attached the paired
  // connection.
  const sshConnections: SshConnections = new SshConnections({
    pairing: devices,
    ssh,
    flavor,
    listening: () => workDevices.listening(),
    settled: () => workDevices.settled(),
    // Welcomed on any version: connected, though it may take no new work.
    welcomed: (deviceId) =>
      workDevices.inReach(deviceId) || workDevices.version(deviceId) !== undefined,
    onWorkDevice: (listener) => workDevices.onWorkDevice(listener),
    cleanUpThere: (cleanup) => remoteLogin.cleanUpThere(cleanup),
    emit: (event) => broadcastEvent(event),
    changed: () => devicesChanged(),
  });
  // One reach value, worked out once and handed to every reader.
  const reachOf = (deviceId: string) =>
    reachFrom({
      inReach: workDevices.inReach(deviceId),
      ssh: sshConnections.state(deviceId),
    });
  const remoteLogin: RemoteLogin = new RemoteLogin({
    pairing: devices,
    ssh,
    flavor,
    appBundle: () => appBundle,
    builds: farBuilds,
    version: host.app.version,
    listening: () => workDevices.settled(),
    inReach: (deviceId) => workDevices.inReach(deviceId),
    connections: sshConnections,
    emit: (event) => broadcastEvent(event),
  });
  const thisUser = () => {
    try {
      return userInfo().username;
    } catch {
      return "";
    }
  };
  // Macs nearby: macOS's own dns-sd, or a development run's stand-in for
  // it, so a test never listens on the Mac's own network (docs/devices.md,
  // "Macs nearby"). Linux looks with Avahi's avahi-browse where it has one.
  const dnsSdStandIn = host.app.packaged ? undefined : settingFrom(process.env, "DNS_SD")?.trim();
  const dnsSd = dnsSdStandIn || (hostPlatform() === "darwin" ? SYSTEM_DNS_SD : undefined);
  const avahiBrowse =
    !dnsSd && hostPlatform() === "linux" ? findOnPath("avahi-browse", hostEnv()) : undefined;
  const nearbyMacs = new NearbyMacs({
    run: dnsSd ? runDnsSd(dnsSd) : null,
    avahi: avahiBrowse ? runDnsSd(avahiBrowse) : null,
    ownNames: () => ownNetworkNames(),
    user: thisUser(),
    changed: (view) => emit("inf:devices:nearby", view),
  });
  // While a phone is on the list this computer announces itself over Bonjour
  // so the phone can find it again (docs/devices.md, "Announcing to a
  // phone"): with dns-sd, or on Linux with Avahi's avahi-publish where it has one.
  const avahiPublish =
    !dnsSd && hostPlatform() === "linux" ? findOnPath("avahi-publish", hostEnv()) : undefined;
  const announcer = dnsSd || avahiPublish;
  const homeAnnouncement = new HomeAnnouncement({
    run: announcer ? runDnsSdHeld(announcer) : null,
    args: dnsSd ? dnsSdAnnounceArgs : avahiAnnounceArgs,
    name: () => ownComputerName({ packaged: host.app.packaged, env: process.env }),
    port: devices.port,
  });
  homeAnnouncement.devicesChanged(devices.list(), devices.phoneMayJoin());
  devices.subscribe(() => homeAnnouncement.devicesChanged(devices.list(), devices.phoneMayJoin()));
  // A phone signed in to this computer over SSH asks the open app for a
  // one-use phone link at its door (docs/devices.md, "A phone that joins by
  // its address"); with no door, the phone says so and nothing joins.
  const phoneDoor = await PhoneDoor.open({
    dir: paths.phoneDoorDir,
    invite: () => devices.invite({ kind: "mac", phone: true }).link,
  }).catch((error: unknown) => {
    console.warn(
      `[devices] no phone door, so a phone cannot join by its address: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  });
  // The privacy watch: macOS's own log reader, or a development run's
  // stand-in for it, so a test never reads this Mac's own privacy log
  // (docs/macos-privacy.md). It finds a task by the working copy its
  // process works in, among the live tasks this Mac runs.
  const privacyLogStandIn = host.app.packaged
    ? undefined
    : settingFrom(process.env, "PRIVACY_LOG")?.trim();
  const privacyLog = privacyLogStandIn || (hostPlatform() === "darwin" ? SYSTEM_LOG : undefined);
  const privacyWatch = privacyLog
    ? new AppDataWatch({
        run: runPrivacyLog(privacyLog),
        self: process.pid,
        findTask: (pid) =>
          taskOfProcess(pid, {
            reader: systemProcessReader,
            self: process.pid,
            places: tasks
              .list()
              .filter(
                (record) =>
                  record.status === "active" &&
                  !record.deviceId &&
                  record.workspaceState === "present" &&
                  Boolean(record.worktreeDir),
              )
              .map((record) => ({ taskId: record.id, dir: record.worktreeDir })),
          }),
        note: (taskId, text, facts) => tasks.noteProgress(taskId, text, "host", undefined, facts),
      })
    : null;
  privacyWatch?.start();
  // Each computer that runs work signing in to its own subscriptions: what
  // Settings -> Intelligence draws, and what a task there is routed among.
  // A computer's word on its sign-ins reaches the crew once it exists: a
  // cut-off it names holds its tasks there, and its end lets them go on.
  let onDeviceSignIns: (deviceId: string) => void = () => {};
  const deviceSignIns = new DeviceSignIns({
    devices: () => devices.list(),
    work: workDevices,
    emit,
    broadcastEvent,
    changed: (deviceId) => onDeviceSignIns(deviceId),
    // A computer's Codex and Grok lists are judged by this Mac's rail.
    protectedIds: (providerId) => slots.protectedIds(providerId),
    reachOf,
  });
  computerSignIns.view = () => deviceSignIns.view();
  // Each computer's setup card, made once the supervisor holds the stack.
  let deviceSetup: DeviceSetup | undefined;
  // The browsers of tasks there, composed below with this Mac's own.
  let browsersThere: PlacedBrowsers | undefined;
  const placed = new PlacedSessions({
    tasks,
    paths,
    devices: workDevices,
    browsers: () => browsersThere,
    profiles: {
      pi: sessionFactories.pi.controlProfile,
      ...(sessionFactories.claude ? { claude: sessionFactories.claude.controlProfile } : {}),
    },
    deviceName: (deviceId) => devices.list().find((device) => device.id === deviceId)?.name,
    computers: () =>
      devices
        .list()
        .filter((device) => deviceRunsWork(device.kind))
        .map((device) => device.id),
    devicePlace: (deviceId) => devicePlace(devices.list(), deviceId),
    projectName: (repoId) => repos.get(repoId)?.name,
    // A placed task's branch and kept work come into its project's own
    // repository here, or this Mac's local workspace for a task with none.
    homeRepo: async (repoId) =>
      repoId ? repos.get(repoId)?.path : await workspace.ensureDefaultRepo(),
    // A branch never comes into a missing folder: the refusal names it and
    // the repair that brings it back (INF-572). Late-bound: the crew is set up below.
    folderMissing: (repoId, taskId): string =>
      supervisor.folderMissing(repoId, "branch-home", tasks.get(taskId)),
    projectOrigin: (repoId) => repos.get(repoId)?.origin,
    projects: () => repos.list().map((repo) => repo.id),
    // A task there is routed among that computer's own sign-ins, with the
    // models they say they serve, as this Mac's catalog describes them.
    signIns: (deviceId) => deviceSignIns.signInsOf(deviceId),
    // A cut-off that computer names on a task's account there holds the
    // task, as one on this Mac's own holds a task here.
    saidSignIns: (deviceId) => deviceSignIns.lastSaid(deviceId),
    refreshSignIns: (deviceId) => deviceSignIns.refresh(deviceId),
    catalogModels: quotaCatalogModels,
    runsForAnotherFirstmate: (deviceId) => runsForAnotherFirstmate(sshConnections.state(deviceId)),
    reachOf,
    // Late-bound: the board's presentation refresh is set up with the crew below.
    reachMoved: () => scheduleWorkPresentation(),
    broadcastEvent: (event) => broadcastEvent(event),
    now: ticker.now,
  });
  const crewBinder = new SessionBinder({
    runtimeFor: (accountId) => vault.runtimeFor(accountId),
    baseRuntime: auth.modelRuntime,
  });
  // The per-account usage ledger (broker phase 2): cost comes from session
  // turn_end and model-powered tool_end usage (Pi's listed prices, Claude's
  // own estimate) - never a proxy - keyed by the serving account and model.
  const usageStore = new UsageStore(db);
  const recordUsage = (input: Omit<UsageInput, "at">) => {
    usageStore.record({ ...input, at: Date.now() });
  };
  // Card-worthy moments reach Notification Center while the window is not
  // front (P2); the card/feed split is the noise filter, so feed lines never
  // notify. E2E windows stay hidden and unfocused, so the isolated-userData
  // runs keep notifications off to avoid pinging the desktop.
  const notifier = new CardNotifier({
    enabled: () => host.notifications.supported() && settings.getNotificationsEnabled(),
    focused: () => host.notifications.focused(),
    show: (notification) => host.notifications.show(notification),
  });
  const selfSourceDir = resolveSelfSourceDir({
    isPackaged: host.app.packaged,
    resourcesPath: host.app.resourcesDir,
    appPath: host.app.appDir,
  });
  // check_pr_ci's host side: typed CI status per task and the fresh-green
  // record used by the emit_card land gate. The CI cap (delivery rigor
  // phase 3) reaches the supervisor, constructed below, through a closure
  // that only ever runs on a later reading - never during construction.
  const workflowEvidence = new WorkflowEvidenceService({
    tasks,
    repos,
    forgeFor,
    writeElsewhere: (taskId, deviceId, artifact) =>
      placed.copies.writeArtifact(taskId, deviceId, artifact),
  });
  const presentations: ChangePresentations = new ChangePresentations({
    tasks,
    mediaDir: (taskId) => crewmateCardPicturesDir(paths, taskId),
    head: (taskId) => prCi.presentationHead(taskId),
  });
  const prCi: PrCiService = new PrCiService({
    tasks,
    repos,
    presentations,
    // The forge seam (git integration PR 1.1): GitHub is the REST forge with
    // the app's own GitHub sign-in (PR 1.2), read at each request. A 401
    // asks the sign-in service to look again; its health read is the proof.
    forgeFor,
    onCap: (taskId, facts) => supervisor.holdForCiCap(taskId, facts),
    onNote: (text, taskId) => broadcastEvent({ type: "firstmate_note", text, taskId }),
    bringBranchHome: (taskId, strict) => placed.bringBranchHome(taskId, strict),
    verifyValidationEvidence: (taskId): void => supervisor.verifyValidationEvidence(taskId),
    now: ticker.now,
  });
  const githubGateway = new GithubGatewayService({
    tasks,
    repos,
    forgeFor,
    accountForge: (host = GITHUB_COM) => {
      const kind =
        host === "gitlab.com"
          ? "gitlab"
          : (forgeSignIns.knownHosts().find((entry) => entry.host === host)?.kind ?? "github");
      return kind === "gitlab"
        ? gitlabForge({ kind, host, dir: "" })
        : githubForge({ kind: "github", host, dir: "" });
    },
    readChecks: (taskId) => prCi.checkForCrew(taskId),
    beforeValidationWrite: (taskId, request, write): Promise<void> =>
      supervisor.consumeValidationEffect(taskId, request, write),
    watchRun: (taskId, runId) => workflowEvidence.watchStarted(taskId, runId),
    now: ticker.now,
  });
  // Integrations (docs/integrations.md): GitHub over the forge's own sign-in
  // and the gateway's calls through it, Google over its own sign-in in the
  // person's browser, and the MCP servers the person adds,
  // each program a child with the host's environment, below the UI. A new
  // kind is one more binding here. An unpackaged run that names a folder
  // connects the stand-in, which tells an event for each line added there
  // (docs/automation.md, "Events").
  const standInIntegrationDir = host.app.packaged
    ? undefined
    : settingFrom(process.env, "STAND_IN_INTEGRATION")?.trim();
  // Google only where the run has a client: a packaged build has none until
  // Infinitary registers its own (`GOOGLE_OAUTH_CLIENT`), so it offers no
  // Google row until then.
  const google = googleSetup({ packaged: host.app.packaged });
  const integrationSecrets = new FileIntegrationSecrets(join(paths.integrationsDir, "secrets"));
  // Which conversations received fenced words, and when, so they go when due.
  const outsideReads = new OutsideReads(paths.integrationsDir);
  const integrations = new IntegrationsService({
    bindings: [
      githubIntegration({
        signIns: forgeSignIns,
        gateway: {
          read: (taskId, input, through) => githubGateway.read(taskId, input, through),
          write: (taskId, input, through) => githubGateway.write(taskId, input, through, true),
          readAsSeat: (input) => githubGateway.readAsSeat(input),
          writeAsSeat: (input) => githubGateway.writeAsSeat(input),
        },
      }),
      ...(["gitlab", "github-enterprise"] as const).map((kind) =>
        forgeHostIntegration(kind, {
          signIns: forgeSignIns,
          gateway: (host) => ({
            read: (taskId, input) => githubGateway.read(taskId, input, { host }),
            write: (taskId, input) => githubGateway.write(taskId, input, { host }, true),
            readAsSeat: (input) => githubGateway.readAsSeat(input, host),
            writeAsSeat: (input) => githubGateway.writeAsSeat(input, host),
          }),
        }),
      ),
      ...(google
        ? [
            googleIntegration({
              root: paths.integrationsDir,
              secrets: integrationSecrets,
              ...google,
              open: async (url) => {
                if (!isAllowedOpenExternalUrl(url))
                  throw new Error("The Google sign-in page's address was refused.");
                await host.openExternal(url);
              },
              now: ticker.now,
              changed: () => integrationsChanged(),
            }),
          ]
        : []),
      mcpIntegration({
        root: paths.integrationsDir,
        env: () => hostEnv(),
        belowUi: (file, args) => atUtilityQos(file, args),
        cwd: () => hostEnv().HOME ?? homedir(),
        version: host.app.version,
        changed: () => integrationsChanged(),
      }),
      ...(standInIntegrationDir ? [standInIntegration({ dir: standInIntegrationDir })] : []),
    ],
    store: new IntegrationSettingsStore(paths.integrationsDir),
    // The bridge until the secret manager takes the keys over (INF-775, q3).
    secrets: integrationSecrets,
    asks: {
      keep: (taskId, ask) => tasks.keepWriteAsk(taskId, ask),
      present: (taskId, ask) => supervisor.askIntegration(taskId, ask),
      keepForFirstmate: (ask) => supervisor.askIntegrationForFirstmate(ask),
      take: (taskId, askId) => tasks.takeWriteAsk(taskId, askId),
      record: (taskId, askId, outcome) => tasks.recordWriteAskOutcome(taskId, askId, outcome),
    },
    reads: outsideReads,
    now: ticker.now,
    push: (view) => emit("inf:integrations", view),
  });
  integrationsChanged = () => integrations.changed();
  // Personal extensions: seed the workspace, compile what is there, watch it.
  // Presence and the running dot derive from the store and the task record,
  // so the service subscribes to both. Started before the supervisor because
  // the live build loop (Step 4) is the supervisor's delegate.
  // The installed plugins (one plugin vehicle, Phase A): the record of what
  // the captain added and agreed to. The plugin host serves a panel from
  // its second root only what this record says he consented to.
  const pluginRecords = new PluginRecords(db);
  const personalStore = new PersonalStore(db);
  const panelMounts = new PanelMountsHolder();
  // The personal workspace is a project from the first start, so a panel
  // instruction can be a direction scoped to it before any panel exists;
  // what an older build kept in the workspace's captain skill is carried
  // there once, before the seeder or any agent touches the workspace.
  await carryPanelInstructions({
    workspaceDir: paths.personalWorkspaceDir,
    scope: repos.ensurePersonal(paths.personalWorkspaceDir).id,
    knowledge,
    log: (message) => console.warn(`[infinitary] ${message}`),
  });
  const personal = await PersonalExtensions.start({
    workspaceDir: paths.personalWorkspaceDir,
    // The app's own design skill and the authoring skills are seeded from
    // the same tree the Firstmate reads itself from (Step 3).
    skillsSourceDir: selfSourceDir,
    cacheRoot: paths.personalCacheDir,
    // The host-owned switch (Step 5): off, the service never seeds, scans,
    // compiles, or loads a server module.
    enabled: personalPanelsEnabled,
    store: personalStore,
    tasks: { get: (id) => tasks.get(id), onChange: (listener) => tasks.onChange(listener) },
    emit,
    log: (message) => console.warn(`[infinitary] ${message}`),
    ...(host.capture ? { capture: host.capture } : {}),
    captureDirFor: (taskId) => join(paths.crewmatesDir, taskId, "captures"),
    mounts: panelMounts,
    sql: (request) => sql.query(request),
    installed: {
      dir: paths.pluginsDir,
      cacheRoot: paths.installedCacheDir,
      list: () =>
        pluginRecords
          .installed()
          .flatMap((record) =>
            record.name && record.capabilities
              ? [{ id: record.id, name: record.name, capabilities: record.capabilities }]
              : [],
          ),
    },
  });
  // The switch has one follower in the core (Step 5): every write of the
  // `panels` row reaches the host, which unmounts or remounts in one tick.
  preferences.subscribe((value) => {
    void personal.setEnabled(value.panels.enabled);
  });
  // The live build loop's seam (Step 4): the personal workspace as a repo
  // registered on first need, the surfaces for the brief and the context
  // block, and the commit, lint and capture the supervisor runs for a
  // crewmate on the personal workspace.
  const personalSurfaces = () => {
    const { extensions, drafts = [] } = personal.snapshot();
    // A new panel still being built is on no rail yet, but its directory
    // is taken: the next crewmate changes it rather than starting another.
    const building = drafts.filter((draft) => !extensions.some((e) => e.id === draft.id));
    return [
      ...extensions,
      ...building.map((draft) => ({ ...draft, present: false, running: true })),
    ].map((extension) => ({
      id: extension.id,
      title: extension.title,
      placement: extension.placement,
      present: extension.present,
      running: extension.running,
      reads: extension.reads,
      error: extension.error?.message ?? null,
    }));
  };
  const personalLive: PersonalLiveDelegate = {
    workspaceDir: paths.personalWorkspaceDir,
    repo: () => repos.ensurePersonal(paths.personalWorkspaceDir),
    surfaces: personalSurfaces,
    beginLiveTask: (taskId) => personal.beginLiveTask(taskId),
    endLiveTask: (taskId) => personal.endLiveTask(taskId),
    commitTurn: (taskId, message) => personal.commitTurn(taskId, message),
    lint: (input) => personal.lint(input.id),
    place: (input) => personal.place(input.taskId, input.id),
    capture: (input) => personal.capture(input.id, input.taskId),
  };
  const credentialHealth = new CredentialHealthService({
    host: {
      listEnabled: () =>
        vault.list().flatMap((account) => (account.enabled ? [{ accountId: account.id }] : [])),
      health: (accountId) => vault.health(accountId, { refresh: true }),
      renew: (accountId, reason) => vault.renew(accountId, reason),
    },
  });
  // The decision-model class (S7): one core-wide service any module may
  // ask a typed, bounded question of. Its default answerer is the ADAPTER -
  // one bounded call on the cheapest slotted model, with the same
  // non-flagship-first account walk S3 shipped - served by Pi in process or,
  // since W1 S10, by the machine's own Claude client on its default login.
  const adaptedDecisionModel = new AdaptedDecisionModel({
    homeDir: paths.firstmateHomeDir,
    availableModels: () => decisionServedModels(),
    namedModels: () => decisionNamedModels(),
    capabilityFor,
    quotaModels: () => quota.latestModels(),
    selectAccount: (taskId, piProviderId) => accounts.selectForSpawn(taskId, piProviderId),
    flagshipAccountId: () => settings.getFirstmateAccount(),
    runtimeFor: (accountId) => vault.runtimeFor(accountId),
    baseRuntime: auth.modelRuntime,
    offering: () => {
      const answerer = settings.getDecisions().answerer;
      return answerer.kind === "adapted" ? answerer.offering : "auto";
    },
    sessions: sessionFactories,
    // Whoever observes a typed cut-off records it on the account.
    noteCutOff,
    prepareHome: async () => {
      await mkdir(paths.firstmateHomeDir, { recursive: true });
    },
  });
  // The native option (S7b): OFF by default and off by construction. The
  // factory is what a decision would need to reach a second endpoint, and
  // it only ever builds a client from the user's OWN key, stored in its own
  // 0700 directory - never from an environment variable, never from any
  // ambient config, the same rule that keeps the app out of ~/.pi.
  const decisionKeys = new DecisionKeyStore(paths.userData);
  const jevUrl = host.app.packaged ? undefined : settingFrom(process.env, "JEV_URL")?.trim();
  const decisions = new DecisionModels({
    settings,
    keys: decisionKeys,
    adapted: adaptedDecisionModel,
    pinState: (offering) => adaptedDecisionModel.pinState(offering),
    openrouter: {
      signedIn: () =>
        vault
          .list("openrouter")
          .some((account) => account.enabled && vault.connectedSync(account.id) === true),
      models: () => [
        ...new Map(
          [auth.modelRuntime, ...vault.piModelRuntimes()]
            .flatMap((runtime) => openRouterDecisionModels(runtime))
            .map((model) => [model.id, model]),
        ).values(),
      ],
      create: (model) =>
        new OpenRouterDecisionModel({
          model,
          selectAccount: (taskId) => accounts.selectForSpawn(taskId, "openrouter"),
          runtimeFor: (accountId) => vault.runtimeFor(accountId),
          onUnauthorized: (accountId) => vault.renew(accountId, "vendor_rejected"),
          ...(!host.app.packaged &&
          settingFrom(process.env, "OPENROUTER_DECISIONS_BASE_URL")?.trim()
            ? { baseUrl: settingFrom(process.env, "OPENROUTER_DECISIONS_BASE_URL")?.trim() }
            : {}),
        }),
    },
    createNative: (row, key) =>
      new JevDecisionModel({
        row,
        key: () => key,
        // Dev/e2e only, exactly like the quota sensor's overrides: a
        // packaged app never reads it, so the real endpoint cannot be
        // redirected in a build anyone runs.
        ...(jevUrl ? { endpoint: jevUrl } : {}),
      }),
    recordUsage,
    onNote: (text) => broadcastEvent({ type: "firstmate_note", text }),
  });
  // The class's first consumer (S7a): what a spawn IS, so the captain's
  // table can route it. The seam and the call site are unchanged.
  const classifier = new DecisionKindClassifier(decisions);
  // Each task's own browser (docs/task-browser.md), on a host that has one.
  // A task's browser goes when the task closes; the app's quit stops them all.
  const webSignIns = new WebSignIns(paths.webSignInsDir);
  const localBrowsers = host.browser
    ? new TaskBrowsers({
        host: host.browser,
        ...browserLookup(host.app.packaged),
        evidenceDir: (taskId) => crewmateEvidenceDir(paths, taskId),
        // What happens to a task's browser is news on its record.
        note: (taskId, text) => tasks.note(taskId, text, { news: true }),
        // The record's Browser line and the view re-read the task's detail.
        onChange: (taskId) => broadcastEvent({ type: "task_browser", taskId }),
        // The captain's Return control is its crewmate's one wake, through
        // the task's durable lane (docs/task-browser.md, "Taking control").
        onReturned: (taskId, returned) => cardStack?.browserReturned(taskId, returned),
        // Website sign-ins the captain saves on this Mac (docs/task-browser.md, "Saved sign-ins").
        signIns: webSignIns,
      })
    : undefined;
  // A task on another computer has its browser there, beside its shell; the
  // captain reads and drives it from here (docs/task-browser.md, "On another
  // computer"), wherever this Mac keeps task browsers of its own.
  const browsers = localBrowsers
    ? new HomeBrowsers(
        localBrowsers,
        new PlacedBrowsers({
          devices: workDevices,
          deviceOf: (taskId) => tasks.get(taskId)?.deviceId,
          nameOf: (deviceId) =>
            devices.list().find((device) => device.id === deviceId)?.name ?? "That computer",
          signIns: webSignIns,
          note: (taskId, text) => tasks.note(taskId, text, { news: true }),
          onChange: (taskId) => broadcastEvent({ type: "task_browser", taskId }),
          onReturned: (taskId, returned) => cardStack?.browserReturned(taskId, returned),
        }),
      )
    : undefined;
  browsersThere = browsers?.there;
  // The task channel (docs/axi-commands.md): a crewmate reaches its task's
  // browser through `infinitary-browser-axi` in its shell, each command in a process
  // of its own. With no such process, or no browser, no crewmate has one.
  const taskCommands = host.axiProcess
    ? await AxiChannel.open({
        spawner: host.axiProcess,
        binDir: host.app.packaged
          ? join(host.app.resourcesDir, "axi-bin")
          : join(host.app.appDir, "resources", "axi-bin"),
        version: host.app.version,
        keysDir: paths.taskChannelDir,
        // A command that reached the app keeps Pi's shell waiting for its answer.
        answering: (shell) => jobs.answering(shell),
      }).catch((error: unknown) => {
        console.warn(
          `[task-commands] no task channel, so no crewmate has a browser or integrations: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      })
    : undefined;
  if (browsers || taskCommands) {
    if (browsers) browserFactOf = (taskId) => browsers.fact(taskId);
    tasks.onChange((change) => {
      for (const taskId of change.removed) {
        browsers?.closeTask(taskId, { gone: true });
        taskCommands?.revoke(taskId);
      }
      for (const taskId of change.taskIds) {
        if (!browsers?.isOpen(taskId) && !taskCommands?.granted(taskId)) continue;
        const status = tasks.get(taskId)?.status;
        if (status !== "done" && status !== "dropped") continue;
        // A closed task's key answers nothing more, whatever its browser did.
        taskCommands?.revoke(taskId);
        if (browsers?.isOpen(taskId)) browsers.closeTask(taskId);
      }
    });
  }
  // A computer connected on an older Firstmate takes no new work: answered
  // by the devices list, which is made after the supervisor.
  const takesNoWorkUntilUpdated = (deviceId: string): boolean =>
    olderComputers?.takesNoWorkUntilUpdated(deviceId) === true;
  let olderComputers: Computers | undefined;
  const automaticPlacement: AutomaticPlacement = new AutomaticPlacement({
    takesNoWorkUntilUpdated,
    reachOf,
    tasks,
    resources: computerResourceFeed,
    work: workDevices,
    devices: () => devices.list(),
    router,
    repo: (id) => repos.get(id),
    catalog: quotaCatalogModels,
    protectedIds: (providerId) => slots.protectedIds(providerId),
    running: (record): boolean => supervisor.placementRunning(record),
    eligible: (record): boolean => supervisor.automaticFor(record),
  });
  const supervisor = new CrewSupervisor({
    automaticPlacement,
    // A program's script runs in a process of its own; its ask() is one typed read.
    ...(host.programProcess ? { programProcess: host.programProcess } : {}),
    answerJson: (caller, instruction, text, signal) =>
      decisions.answerJson(caller, instruction, text, signal),
    crewSpeed: (model) => slots.speed(model),
    modelName: (model) => slots.nameOf(model),
    personalResourcesEnabled: () => settings.getPersonalResourcesEnabled(),
    build: host.app.version,
    sessions: sessionFactories,
    machines: placed,
    takesNoWorkUntilUpdated,
    reachOf,
    // A task began waiting for an update: its card comes back, even after Not now.
    recallUpdateCard: (deviceId) => updateNudge?.refresh(deviceId, true),
    bind: async (accountId, providerId) => {
      if (accountId)
        return crewBinder.bindAccount(accountId, providerId ?? vault.get(accountId)?.providerId);
      if (providerId && isCustomApiProvider(providerId))
        throw new Error(
          "This custom model needs its checked connection; it cannot use another account.",
        );
      return crewBinder.base();
    },
    classifier,
    workspace,
    repos,
    tasks,
    cardStore,
    ...(knowledge ? { knowledge } : {}),
    inbox,
    router,
    accounts,
    // Whoever observes a typed cut-off records it on the account.
    noteCutOff,
    // Crew delivery reads that fact: a lane is held while a cut-off stands
    // on its account, and the Firstmate hears the cut-off and its end.
    serveability: {
      cutOff: (accountId) => vault.cutOff(accountId),
      providerName: (accountId) => {
        const providerId = vault.get(accountId)?.providerId;
        return (providerId && catalogEntry(providerId)?.name) || providerId || "the provider";
      },
    },
    recordUsage,
    paths,
    now: ticker.now,
    onWatchdogTick: (now) => {
      void credentialHealth.tick(now);
      // The sign-ins where projects live, on the same tick (PR 1.2).
      void forgeSignIns.checkHealth();
    },
    hasRunningJobs: (taskId) => jobs.hasRunningJobs(taskId),
    oldestRunningJob: (taskId) => jobs.oldestRunningJob(taskId),
    // Every whose-turn sort is one `sort` row in the decision ledger, with
    // its rule and the wake's typed facts (S7c, R4.4; P6). The wake rides
    // the store's transaction, so a decision and its effect still commit
    // together - the promise the store was built on.
    recordSort: ({ taskId, wake, facts, verdict, summary, rule, wakeKind, effect }) => {
      ledger.transaction(() => {
        ledger.recordSort({ taskId, wake, facts, verdict, summary, rule, wakeKind });
        effect?.();
      });
    },
    mergePullRequest: (taskId, guard, beforeDispatch) => prCi.merge(taskId, guard, beforeDispatch),
    mergeReview: (taskId, reviewId) => prCi.mergeReview(taskId, reviewId),
    // An integration's ask runs through its binding; every other is a forge write.
    sendWriteAsk: (taskId, askId, choice) =>
      tasks.get(taskId)?.delivery?.writeAsks?.find((ask) => ask.id === askId)?.kind ===
      "integration"
        ? integrations.sendAsk(taskId, askId, choice)
        : githubGateway.sendAsk(taskId, askId),
    sendTakenIntegrationAsk: (rowId, taken, choice) => integrations.sendTaken(rowId, taken, choice),
    reviewGate: (taskId, reviewId) => prCi.reviewGate(taskId, reviewId),
    readPull: (taskId, prNumber) => prCi.pullState(taskId, prNumber),
    closePullRequest: (taskId) => prCi.close(taskId),
    checkCi: (taskId) => prCi.checkOverall(taskId),
    prepareChange: (taskId, input) => prCi.preparePresentation(taskId, input),
    openChange: (taskId, input) => prCi.open(taskId, input),
    completionPresentation: (taskId, revision) => prCi.completionPresentation(taskId, revision),
    checkChange: (taskId, input) => prCi.checkForCrew(taskId, input),
    readWorkflow: (taskId, input) => workflowEvidence.read(taskId, input),
    downloadArtifact: (taskId, input) => workflowEvidence.download(taskId, input),
    githubRead: (taskId, input) => githubGateway.read(taskId, input),
    githubWrite: (taskId, input) => githubGateway.write(taskId, input),
    readCheckWatch: (taskId) => prCi.readWatched(taskId),
    readMainChecks: (repoId) => prCi.readDefaultBranchChecks(repoId),
    readRunWatch: (taskId, runId) => workflowEvidence.readWatched(taskId, runId),
    killJobs: (taskId) => jobs.killForOwner(taskId),
    personal: personalLive,
    ...(host.mediaProbe ? { probeMedia: host.mediaProbe } : {}),
    ...(host.typefaceProbe ? { probeTypeface: host.typefaceProbe } : {}),
    ...(browsers ? { browsers } : {}),
    ...(taskCommands ? { taskCommands } : {}),
    integrations,
    quotaGateRefValid,
    quotaGateCleared: (ref) =>
      quotaGateCleared(ref, { availableModels, slotsOf: (model) => slots.slotsOf(model), quota }),
    broadcastEvent,
    presentationChanged: () => tasks.invalidatePresentation(),
    broadcastCards: (cards) => {
      scheduleWorkPresentation();
      notifier.observe(cards);
      emit("inf:cards", cards);
      onCardsChanged();
    },
    // One card's thread, whole, after any message lands on it (cards-as-
    // threads phase 1). A thread never notifies natively and never pings:
    // the captain is looking at the card he typed under.
    broadcastThread: (thread) => {
      scheduleWorkPresentation();
      emit("inf:cards:thread", thread);
    },
  });
  runsOnOf = (record) => supervisor.runsOnFact(record);
  placeOf = (record) => supervisor.taskPlace(record);
  closingResolutionOf = (taskId) => supervisor.newestCardResolution(taskId);
  cardStack = supervisor;
  readWorkPosture = (record) => supervisor.workPosture(record);
  const workPresentation = new WorkPresentation({
    tasks,
    protocol: taskProtocol,
    broadcastEvent: (event) => broadcastEvent(event),
  });
  hearPresentation = (event) => workPresentation.heard(event);
  scheduleWorkPresentation = () => workPresentation.schedule();
  inbox.onChange(scheduleWorkPresentation);
  // Holds may change without a task write. Reconcile on the existing host clock too.
  ticker.register("work-presentation", TICK_PERIOD_MS, scheduleWorkPresentation);
  scheduleWorkPresentation();

  // The microphone note an earlier version raised on the first hold to talk
  // is a line under the input now (docs/composer.md, "Voice"); one still on
  // the stack comes down.
  supervisor.withdrawHostCard("card-voice-mic-primer", "microphone line under the input");
  // Seed the notifier with the restored stack: cards surviving a restart are
  // old news, and only cards born after this moment ping.
  notifier.observe(supervisor.cardsSnapshot());
  // Install by talking (Phase A, A2a): the installer stages a plugin and
  // asks on the host's consent card; the supervisor routes the captain's
  // click on it (a host effect only his click on the card's controls runs).
  const pluginInstaller = new PluginInstaller({
    records: pluginRecords,
    pluginsDir: paths.pluginsDir,
    stagingDir: paths.pluginsStagingDir,
    checkCacheDir: join(paths.pluginsStagingDir, ".check"),
    store: personalStore,
    cards: {
      raise: (card) => supervisor.raiseHostCard(card),
      withdraw: (id, reason) => supervisor.withdrawHostCard(id, reason),
      has: (id) => supervisor.hasCard(id),
    },
    broadcast: (event) => broadcastEvent(event),
    refresh: () => personal.refresh(),
    // An added plugin may not take the id of an app panel or of one of the
    // captain's own, whether or not the switch has them mounted right now.
    reservedIds: async () => [
      ...BUILTIN_SURFACES.map((surface) => surface.id),
      ...(await readdir(paths.personalWorkspaceDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    ],
    panelsOn: () => preferences.get().panels.enabled,
    log: (message) => console.warn(`[infinitary] ${message}`),
  });
  supervisor.setPluginConsent({
    add: (id) => {
      void pluginInstaller.add(id).catch((error: unknown) => {
        broadcastEvent({
          type: "firstmate_note",
          text: `Could not add the panel "${id}": ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    },
    decline: (id) => void pluginInstaller.decline(id),
  });
  await pluginInstaller.reconcile();
  // The setup card (docs/fleet.md, "Asking the first mate to add a project"):
  // the Firstmate proposes, the host checks and writes the card, and only
  // the captain's click on it sets the project up; the Firstmate, built
  // below, hears once how he answered.
  const projectSetups = new ProjectSetups({
    repos,
    devices: () => devices.list(),
    raiseCard: (card) => supervisor.raiseHostCard(card),
    tell: (facts) => firstmateForSeat?.notifyOp({ facts }, "agent"),
    broadcast: (event) => broadcastEvent(event),
  });
  supervisor.setProjectSetup({
    add: (offer, answers) => {
      void projectSetups.add(offer, answers).catch((error: unknown) => {
        broadcastEvent({
          type: "firstmate_note",
          text: `Could not add the project: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    },
    decline: (offer) => projectSetups.decline(offer),
  });
  const projectChanges = new ProjectChanges({
    repos,
    devices: () => devices.list(),
    raiseCard: (card) => supervisor.raiseHostCard(card),
    tell: (facts) => firstmateForSeat?.notifyOp({ facts }, "agent"),
  });
  supervisor.setProjectChange({
    apply: (arg) => {
      void projectChanges.apply(arg);
    },
    decline: (arg) => projectChanges.decline(arg),
    inspect: (repoId) => projectChanges.inspect(repoId),
  });
  // A sign-in where projects live, as the captain meets it (PR 1.2): the one
  // host card when the host refused it - "sign in again", gone the moment
  // the host answers again - and a feed line when the host cannot be
  // reached. Nothing at all while nothing is signed in.
  onForgeHealth = (change) => {
    const cardId = forgeSignInCardId(change.host);
    if (change.to === "needs_reauth") {
      supervisor.addForgeSignInCard(
        cardId,
        change.host,
        change.name,
        waitingChangesOn(change.host),
      );
    } else if (change.to === "ok" || change.to === "none") {
      supervisor.clearAuthDecisionCard(cardId);
      if (change.to === "ok") void supervisor.resumeForgeSignInTasks(change.host);
    }
    if (change.to === "unavailable" && change.from !== "unavailable") {
      broadcastEvent({
        type: "firstmate_note",
        text: `Could not reach ${change.name} - trying again.`,
      });
    }
  };
  // A short-lived sign-in renewed itself (health stays ok, so no change
  // above fires): a card a git refusal raised for the ended one comes down,
  // and the work it held goes again.
  onForgeRenewed = (forgeHost) => {
    supervisor.clearAuthDecisionCard(forgeSignInCardId(forgeHost));
    void supervisor.resumeForgeSignInTasks(forgeHost);
  };
  // How many proposed changes wait on a host: live tasks there with one open.
  const waitingChangesOn = (forgeHost: string): number => {
    const onHost = new Set(
      repos
        .list()
        .filter((repo) => repo.host?.name === forgeHost)
        .map((repo) => repo.id),
    );
    return tasks
      .listLive()
      .filter(
        (task) =>
          task.status === "active" &&
          task.repoId !== null &&
          onHost.has(task.repoId) &&
          (task.delivery?.changeLabel !== undefined || task.delivery?.prNumber !== undefined),
      ).length;
  };
  // The first read of every sign-in, at boot, below the UI - after the
  // health log dates this start and the sign-in on file.
  forgeSignIns.recordApp("start");
  void forgeSignIns.checkHealth();
  // The quiet-crewmate watchdog (P4): a stalled turn surfaces instead of
  // spinning forever; escalation only, never an automatic interrupt.
  supervisor.startWatchdog(ticker);
  placed.serve({
    adopt: (taskId) => supervisor.adoptPlaced(taskId),
    caughtUp: (taskIds) => supervisor.placedCaughtUp(taskIds),
    jobExit: (taskId, exit) => supervisor.deliverJobResult(taskId, jobExitWake(exit, "crewmate")),
    reopened: (taskId) => supervisor.placedReopened(taskId),
    toolsNow: (taskId) => supervisor.toolsNow(taskId),
  });
  // A computer with work out of reach for a minute is said once in the feed.
  ticker.register("placed-reach", TICK_PERIOD_MS, (now) => placed.tick(now));
  // The card that nudges the captain to update a computer on an older
  // Firstmate (docs/devices.md, "Another version, and updating"); it reads
  // the list below, so it is set once that exists.
  let updateNudge: DeviceUpdateNudge | undefined;
  // Your devices, and Remove for a computer that runs work (docs/devices.md).
  const computers = new Computers({
    pairing: devices,
    work: workDevices,
    tasks,
    repos,
    stopTasks: (deviceId) => supervisor.stopTasksOn(deviceId),
    bringHome: (deviceId) => placed.bringHome(deviceId),
    // Its crew pauses for its update and carries on after (docs/helper.md, "Updated by its home").
    pauseTasks: (deviceId) => supervisor.pauseForUpdate(deviceId),
    resumeTasks: (deviceId) => supervisor.resumeAfterUpdate(deviceId),
    removeThere: (device) => remoteLogin.removeThere(device),
    // Update: a computer's version against this Mac's, over Remote Login or
    // the connection (docs/devices.md, "Updating").
    home: { app: host.app.version, contract: PROTOCOL_VERSION },
    updateOverRemoteLogin: (deviceId, options) => remoteLogin.update(deviceId, options),
    // Whether this computer has a Firstmate for that computer's system, and
    // that one got and checked before it is asked to update.
    canSend: (device) => {
      const far = farSystemNamed(device.system);
      const chip = far ? (device.chip ?? Object.values(far.chips)[0]) : undefined;
      return far !== null && chip !== undefined && farBuilds.canSend(far, chip);
    },
    prepare: async (device) => {
      const far = farSystemNamed(device.system);
      const chip = far ? (device.chip ?? Object.values(far.chips)[0]) : undefined;
      if (!far || !chip || !farBuilds.fetches(far, chip)) return null;
      const build = await farBuilds.for(far, chip);
      return "refusal" in build ? build.refusal : null;
    },
    // Where a Mac updated over the connection downloads this computer's
    // version itself, looked up without downloading it here
    // (docs/devices.md, "Downloading over the connection").
    download: async (device) => {
      const far = farSystemNamed(device.system);
      const chip = far ? (device.chip ?? Object.values(far.chips)[0]) : undefined;
      return far && chip ? farBuilds.downloadFor(far, chip) : null;
    },
    emitUpdate: (event) => {
      broadcastEvent(event);
      updateNudge?.updateSaid(event);
    },
    ssh: (deviceId) => sshConnections.state(deviceId),
    reachOf,
    emit: (list) => emit("inf:devices", list),
    onProblem: (text) => broadcastEvent({ type: "firstmate_note", text }),
    now: ticker.now,
    bootedAt,
  });
  olderComputers = computers;
  devicesChanged = () => {
    // Task rows say connecting by the same reach: they follow it at once.
    scheduleWorkPresentation();
    computers.refresh();
    deviceSignIns.pushView();
  };
  // The connecting limit is read when reach is read. The host clock asks
  // whether that read moved, and pushes only then.
  ticker.register("device-reach", TICK_PERIOD_MS, () => {
    if (sshConnections.due()) devicesChanged();
  });
  // Its work comes here first, or once it is back, as Remove's would.
  leaveWithWork = (device) => {
    computers.remove(device.id, "when-back").catch((error: unknown) =>
      broadcastEvent({
        type: "firstmate_note",
        text: `${device.name} left, and its removal could not finish: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
    return true;
  };
  // Finishing a computer's setup (docs/devices.md, "Finishing its setup"):
  // the host's own card at join, from typed facts, and the GitHub card a
  // project raises when it runs on a computer with no GitHub sign-in.
  deviceSetup = new DeviceSetup({
    devices: () => devices.list(),
    repos,
    signIns: {
      lastSaid: (deviceId) => deviceSignIns.lastSaid(deviceId),
      signInsOf: (deviceId) => deviceSignIns.signInsOf(deviceId),
    },
    cards: {
      raise: (card) => supervisor.raiseHostCard(card),
      withdraw: (id, reason) => supervisor.withdrawHostCard(id, reason),
      has: (id) => supervisor.hasCard(id),
      stored: (id) => supervisor.cardStored(id),
      chosenAction: (id) => supervisor.cardChosenAction(id),
    },
    broadcastEvent,
    forgeNeeded: (deviceId, host, repo) =>
      supervisor.projectForgeSignInNeeded(deviceId, host, repo),
    forgeReady: (deviceId, host) => void supervisor.resumeDeviceForgeSignInTasks(deviceId, host),
  });
  const setupCards = deviceSetup;
  repos.onRunsOn((repo) => setupCards.runsOnChanged(repo));
  workDevices.onWorkDevice((contact) => setupCards.contact(contact));
  const nudge = new DeviceUpdateNudge({
    devices: () => computers.list(),
    homeApp: () => host.app.version,
    cards: {
      raise: (card) => supervisor.raiseHostCard(card),
      withdraw: (id, reason) => supervisor.withdrawHostCard(id, reason),
      has: (id) => supervisor.hasCard(id),
      chosenAction: (id) => supervisor.cardChosenAction(id),
    },
    broadcastEvent,
  });
  updateNudge = nudge;
  workDevices.onVersion((deviceId, version) => {
    if (version) supervisor.observeRequiredActionDevice(deviceId, version);
    nudge.refresh(deviceId);
  });
  devices.subscribe(() => {
    setupCards.devicesChanged();
    nudge.devicesChanged();
  });
  // Where devices find this Mac, whole, whenever it reads differently - the
  // captain's choice, or this Mac's network while pairing follows it - so
  // Settings -> Devices says where this Mac is now with the tab open.
  let addressesSaid = JSON.stringify(devices.addresses());
  devices.subscribe(() => {
    const addresses = devices.addresses();
    const said = JSON.stringify(addresses);
    if (said === addressesSaid) return;
    addressesSaid = said;
    emit("inf:devices:addresses", addresses);
  });
  // The boot sweep (R1): overdue parked decisions return, and time gates
  // that passed while the app was closed dispatch once, now.
  void supervisor.sweepGates(ticker.now());
  // Fleet hygiene (interaction P0, WI-7): closed rows still holding a
  // worktree, and worktree directories no record explains, retire it with
  // their unlanded work saved first; leftover task branches are reported
  // as one feed line - never deleted.
  void supervisor.reconcileFleetHygiene().catch((caught) => {
    console.warn("[fleet] reconciliation failed:", caught);
  });
  // Warm pool: returns a quit interrupted finish, and idle trees past the
  // pool's budget or age are retired (into the trash swept next).
  workspace.sweepPool();
  // Retired worktrees a quit left half-deleted finish deleting, below the UI.
  workspace.sweepTrash();
  // A closed task's leftover files go a week after its close, unless a live
  // task builds on it, was filed from it or waits on it
  // (docs/task-retention.md): pass now, at each close or renewed contact,
  // and hourly so a running app crosses the week without another close.
  const closedTaskFiles = new ClosedTaskFiles({
    paths,
    tasks,
    removePlaced: (record) => placed.removeClosedTaskFiles(record),
    deleteInBackground: (dir) => workspace.deleteInBackground(dir),
    now: ticker.now,
  });
  closedTaskFiles.watch();
  void closedTaskFiles.sweep();
  workDevices.onWorkDevice((contact) => {
    if (contact.contact === "in-reach") void closedTaskFiles.sweep();
  });
  ticker.register("closed-task-files", 60 * 60 * 1000, () => void closedTaskFiles.sweep());
  // A provisioned temporary folder goes at the close, not after a week, and
  // a removal that could not finish is tried again on the same clocks.
  const taskTempFiles = new TaskTempFiles({
    paths,
    tasks,
    removePlaced: async (record) => {
      const result = await placed.removeClosedTaskTemp(record);
      if (result.status === "removed") return { status: "removed", bytes: result.bytes };
      if (result.status === "pending") {
        return {
          status: "pending",
          bytes: 0,
          reason: result.reason ?? "safe removal is uncertain",
        };
      }
      return { status: "absent", bytes: 0 };
    },
    deleteInBackground: (dir) => workspace.deleteInBackground(dir),
    now: ticker.now,
  });
  taskTempFiles.watch();
  void taskTempFiles.sweep();
  workDevices.onWorkDevice((contact) => {
    if (contact.contact === "in-reach") void taskTempFiles.sweep();
  });
  ticker.register("task-temp-files", 60 * 60 * 1000, () => void taskTempFiles.sweep());
  const flagship = new Flagship({
    vault,
    settings,
    quota,
    baseRuntime: auth.modelRuntime,
    // Every seat-binding decision is an account row on the one ledger.
    decisions: ledger,
  });
  // The dev-only local seat (roadmap 1.7, docs/local-orchestrator.md): an
  // unpackaged checkout may point the Firstmate - only the Firstmate - at a
  // local OpenAI-compatible endpoint. The resolver answers nothing for a
  // packaged build whatever the environment says, so the release carries
  // no way to re-point its orchestrator.
  // The row (Settings -> General, dev only) and the environment make the
  // same choice; a later write hands the Firstmate its new seat, and it
  // binds at an idle boundary like an explicit pin.
  let firstmateForSeat: FirstmateAgent | undefined;
  const localOrchestrator = new LocalOrchestratorService({
    isPackaged: host.app.packaged,
    env: process.env,
    paths,
    settings,
    broadcastEvent,
    onSeat: (seat) => firstmateForSeat?.setLocalOrchestrator(seat),
  });
  const localSeat = await localOrchestrator.boot();
  // Persistent cron prompts (R3): due schedules wake the Firstmate agent
  // through the durable inbox; late-bound because the agent is built below.
  // The scheduler follows each delivery's row there (docs/automation.md).
  let notifyFirstmate: (wake: TypedWake, origin: "scheduled") => number | null = () => null;
  const scheduleStore = new ScheduleStore(db);
  const scheduler = new Scheduler({
    store: scheduleStore,
    notify: (wake, origin) => notifyFirstmate(wake, origin),
    inbox,
    broadcastEvent,
    now: ticker.now,
    // An event rule looks through the integrations (docs/automation.md, "Events").
    events: {
      find: (integration, event) => integrations.listenable(integration, event),
      look: (integration, event, cursor, filter, connection) =>
        integrations.look(integration, event, cursor, filter, connection),
    },
    // A rule's project is named in its prompt while it is live (docs/automation.md).
    projectOf: (id) => {
      const project = tasks.projects.get(id);
      return project && project.archivedAt === null
        ? { key: project.key, name: project.name }
        : undefined;
    },
  });
  const firstmate = new FirstmateAgent({
    paths,
    platform: host.app.platform,
    inbox,
    now: ticker.now,
    settings,
    onCaptainTurnAccepted: () => onCaptainTurnAccepted(),
    forges: forgeAccess,
    integrations,
    // Diagnostics' turn events: who the turn answered and, failed, its kind.
    onTurnSettled: (outcome) =>
      sharing.record(
        outcome.failed
          ? {
              name: "main_agent_turn_failed",
              data: { trigger: outcome.trigger, reason: outcome.reason },
            }
          : { name: "main_agent_turn_end", data: { trigger: outcome.trigger } },
      ),
    modelRuntime: auth.modelRuntime,
    flagship,
    // The captain's recheck reads the login first, so a switched one's
    // reading is the one taken.
    recheckAllowance: async () => {
      await vault.checkLogins();
      return quota.refresh("demand");
    },
    // Each backend's seat (W1): the seat preset, opened by the one factory
    // per backend.
    seats: sessionFactories,
    ...(localSeat ? { localOrchestrator: localSeat } : {}),
    availableModels,
    listedModels: () => slots.listedOf(availableModels()),
    slotsOf: (ref) => slots.slotsOf(ref),
    quotaModels: () => quota.latestModels(),
    quotaLine: () => quotaContextLine(quota.latest()),
    repos,
    supervisor,
    tasks,
    ...(knowledge ? { knowledge } : {}),
    scheduler,
    broadcastEvent,
    selfSourceDir,
    noteCutOff,
    // The orchestrator's own burn is tracked under the conversation surface.
    recordUsage: ({ accountId, model, usage }) =>
      recordUsage({
        taskId: "firstmate",
        ...(accountId ? { accountId } : {}),
        ...(model ? { model } : {}),
        usage,
      }),
    supervisionLog: (limit) => ledger.recent(limit),
    flagMissedEscalation: (input) => ledger.flagMissedEscalation(input),
    flagDuplicate: (input) => supervisor.flagDuplicate(input),
    // Talk-to-personalize Step 1: the preferences writer and the personal
    // surfaces behind `personalize` and the "your surfaces" section.
    personalize: {
      preferences,
      personal: () => personal.snapshot(),
      removePersonal: (id) => personal.remove(id),
      uninstallPlugin: (id) => pluginInstaller.uninstall(id),
      personalWorkspaceDir: paths.personalWorkspaceDir,
      // The Knowledge panel is a surface only while there is knowledge to show (docs/knowledge.md),
      // and the Automation panel while a rule is saved (docs/automation.md).
      gates: () => ({
        knowledge: knowledge?.held() ?? false,
        automation: scheduler.rules().length > 0,
      }),
      mounts: () => panelMounts.current(),
    },
    installPlugin: (request) => pluginInstaller.install(request),
    proposeProject: (value) => projectSetups.propose(value),
    changeProject: (action, value, actor) => projectChanges.request(action, value, actor),
  });
  firstmateForSeat = firstmate;
  notifyFirstmate = (wake, origin) => firstmate.notifyOp(wake, origin);
  holdSeat = (accountId) => firstmate.holdSeatFor(accountId);
  scheduler.start(ticker);
  // Words from outside go from saved conversations once past their days,
  // or now on the captain's delete (docs/task-retention.md, "Words from
  // outside"). A conversation is written again only between its turns.
  const savedOutsideData = new SavedOutsideData({
    paths,
    reads: outsideReads,
    task: (id) => tasks.get(id),
    tasks: () => tasks.list(),
    kept: () => integrations.kept(),
    legacy: () => integrations.legacyCalls(),
    claudeConfigDir: () => defaultClaudeConfigDir(),
    firstmateClaudeSessions: () => {
      const current = settings.getFirstmateClaudeSession();
      return current ? [current] : [];
    },
    conversations: {
      busy: (reader) =>
        reader === FIRSTMATE_READER
          ? firstmate.conversationBusy()
          : supervisor.conversationBusy(reader),
      release: (reader) =>
        reader === FIRSTMATE_READER
          ? firstmate.releaseConversation()
          : supervisor.releaseConversation(reader),
      held: (reader) =>
        reader === FIRSTMATE_READER
          ? firstmate.conversationHeld()
          : supervisor.conversationHeld(reader),
    },
    // A crewmate on a computer that runs work: replaced there, by that computer.
    placed: (record, due) => placed.deleteOutside(record, due),
    runs: { rewrite: (scrub) => scheduleStore.rewriteRuns(scrub) },
    inbox: { rewrite: (scrub) => inbox.rewritePending(scrub) },
    now: ticker.now,
    log: (line) => console.warn(`[infinitary] ${line}`),
  });
  ticker.register("outside-data", TICK_PERIOD_MS, () => void savedOutsideData.sweep());
  ticker.start();
  // R2 wakes: a job exit reaches its owner - the agent through the durable
  // inbox, a crewmate as its next turn. Jobs interrupted by the last quit
  // are reported honestly, once.
  routeJobExit = (exit) => {
    if (exit.ownerId === "firstmate") {
      // The `[fm-op]` label stays: it is the wording the Firstmate's prompt
      // names for host operations and only the model is served it (Observe,
      // a dev-only surface, is the one place a person can read it). Origin
      // is the `agent` stamp, never the label.
      firstmate.notifyOp(jobExitWake(exit, "firstmate"), "agent");
    } else {
      supervisor.deliverJobResult(exit.ownerId, jobExitWake(exit, "crewmate"));
    }
  };
  if (enteredSafeMode) {
    // Safe mode is a fact the captain has to be told, not a silent loss:
    // one feed line that says what happened and where the switch is.
    broadcastEvent({ type: "firstmate_note", text: PANELS_SAFE_MODE_NOTE });
  }
  for (const interrupted of jobs.reportInterrupted()) {
    // A job the last quit or crash stranded is status, not a decision: one
    // feed line, never a wake (WI-13). The captain sees it in the feed;
    // nothing is owed. It says only what the app knows: its quit stopped a
    // marked job, and an unmarked one may have run on without it.
    const owner =
      interrupted.ownerId === "firstmate"
        ? "Your first mate's"
        : `"${tasks.get(interrupted.ownerId)?.title ?? interrupted.ownerId}"'s`;
    const job = `${owner} background job "${interrupted.command.slice(0, 80)}"`;
    broadcastEvent({
      type: "firstmate_note",
      text: interrupted.stoppedByQuit
        ? `${job} was stopped when the app quit.`
        : `${job} was running when the app quit unexpectedly. It may have kept running, even to the end.`,
      ...(interrupted.ownerId === "firstmate" ? {} : { taskId: interrupted.ownerId }),
    });
  }
  // A cut-off that ended while the app was closed is heard first (its
  // `provider-back` makes the held lanes' rows due at once), so the boot
  // sweep delivers each lane's kept guidance as one turn.
  supervisor.reconcileCutOffs();
  // The inbox boot sweep (design A): task-lane rows the quit stranded are
  // re-delivered (resuming their idle tasks) or reported as orphaned, and
  // the firstmate and supervision lanes each get one explicit drain instead
  // of waiting for an incidental trigger.
  void supervisor.sweepInbox(ticker.now());
  // The idle reconciler's boot sweep (docs/report-sort.md): a record the
  // ladder should already have acted on while the app was closed acts now,
  // from its saved clock and rung - once, never a storm, and its wakes
  // coalesce into one Firstmate turn.
  supervisor.reconcileIdle(ticker.now());
  // A cut-off recorded or cleared is heard now, not at the next tick: a
  // held lane goes on the moment its account serves again, and so does a
  // paused seat.
  vault.onCutOffChange(() => {
    scheduleWorkPresentation();
    supervisor.reconcileCutOffs();
    firstmate.onCutOffChanged();
  });
  // A changed login (the machine's Claude login switched, say): what the old
  // login was refused or read is not this account's any more, so its saved
  // refusals and last reading go and a new reading is taken now
  // (docs/quota.md "A changed login"). Read once at start, then on the
  // account check's tick, window focus and wake.
  vault.onLoginChange((accountId) => {
    pushedQuota.forget(accountId);
    quota.forgetAccount(accountId);
    void quota.refresh("account-changed");
  });
  void vault.checkLogins();
  // So is one a computer that runs work names on its own sign-ins; its
  // setup card reads them too, and a task waiting for a sign-in there
  // starts now rather than at the next tick.
  onDeviceSignIns = (deviceId) => {
    const reading = deviceSignIns.lastSaid(deviceId)?.quota;
    if (reading) placedWork.observe(deviceId, reading);
    scheduleWorkPresentation();
    supervisor.reconcileCutOffs();
    deviceSetup?.signInsChanged(deviceId);
    supervisor.deviceSignInsChanged(deviceId);
  };
  // Wakes a previous version parked on the retired supervision lane still
  // name real work: hand them to the Firstmate rather than leaving them to
  // rot on a lane with no reader (S7c).
  const stranded = inbox.allFor(SUPERVISION_RECIPIENT);
  if (stranded.length > 0) {
    inbox.reassign(
      stranded.map((row) => row.id),
      FIRSTMATE_RECIPIENT,
    );
  }
  firstmate.pokeInbox();
  /**
   * Seeds never-seen offerings from the starter map and reports live-catalog
   * newcomers - once each, as an ordinary feed line, because a model arriving
   * into a subscription is fleet news the captain should see without a card.
   * A first-time seed for a provider announces nothing. A later arrival is
   * placed when the map names it, otherwise off until the user slots it.
   *
   * It runs on the same beats the availability snapshot moves on: app start,
   * the daily liveness sweep, every quota refresh (which is also when a 4h
   * pi.dev catalog overlay has had a chance to land), and after an account
   * is added.
   */
  const reconcileActivation = () => {
    // Departures first, from successful reads only (docs/model-lists.md):
    // a client-served or Pi-filtered account counts only once its own read
    // has succeeded; an unfiltered Pi account's catalog is Pi's own answer.
    const snapshots = vault.availableModelsByAccount().flatMap((row) => {
      if (served.reads(row.providerId) && served.read(row.accountId) === undefined) return [];
      const ids = row.models
        .filter((model) => model.provider === row.providerId)
        .map((model) => model.id);
      return [{ accountId: row.accountId, providerId: row.providerId, ids }];
    });
    for (const notice of slots.departures(snapshots)) {
      const name = flagship.providerNameOf(notice.providerId);
      const label = slots.labelOf({ provider: notice.providerId, id: notice.id }) ?? notice.id;
      broadcastEvent({ type: "firstmate_note", text: modelGoneNote(name, label, notice.slots) });
    }
    for (const notice of slots.reconcile()) {
      const name = flagship.providerNameOf(notice.providerId);
      broadcastEvent({
        type: "firstmate_note",
        text: modelAddedNote(name, notice.id, notice.slots ?? []),
      });
    }
  };
  /**
   * CD-3=A: the terminal needs_reauth card is raised only from a quota row
   * that is already auth_required (proof-gated). Recovered rows drop the
   * matching singleton. A !connected sweep is not proof and must never
   * mint this card - first-run, unknown, and retryable misses stay quiet.
   */
  const syncNeedsReauthCards = (snapshot: QuotaSnapshotView) => {
    const accounts = vault.list();
    const wanted = new Set<string>();
    for (const target of needsReauthTargets(snapshot)) {
      wanted.add(target.cardId);
      const label =
        accounts.find((account) => account.id === target.accountId)?.label ?? target.accountLabel;
      supervisor.addAuthDecisionCard(
        target.cardId,
        target.providerName,
        needsReauthCopy(target.providerName, label),
        { restoreAccountId: target.accountId },
      );
    }
    for (const card of supervisor.cardsSnapshot()) {
      const accountId = accountIdFromNeedsReauthCard(card.id);
      if (accountId !== undefined && !wanted.has(card.id)) {
        supervisor.clearAuthDecisionCard(card.id);
      }
    }
  };
  onQuotaRefreshed = () => {
    const snapshot = quota.latest();
    if (snapshot) syncNeedsReauthCards(snapshot);
    firstmate.onQuotaRefreshed();
    // A refresh may clear a quota-reset gate (R1).
    void supervisor.sweepGates(ticker.now());
    reconcileActivation();
  };
  // The low-frequency liveness sweep (broker refresh posture): a
  // harness-owned auth status read per enabled account on app start and
  // daily - keeps idle Pi tokens warm. Cards for a dead credential come
  // from the quota snapshot's proof, not from !connected.
  const sweepAccountLiveness = async () => {
    await vault.sweepLiveness().catch(() => []);
  };
  reconcileActivation();
  // A settled read moved what an account serves: the catalog routing walks
  // is rebuilt over the last snapshot (no fetch), then the lists and news.
  onCatalogSettled = () => {
    quota.recatalog();
    reconcileActivation();
    reconcileFirstRun();
  };
  // The runtime catalog reads (docs/model-lists.md): started, never awaited,
  // and only once the sweep's own status reads are in - each account's
  // status is then fresh for a while, so a Claude read holding the store
  // lease cannot make a status probe step aside and read the store instead.
  void sweepAccountLiveness().then(() => {
    reconcileActivation();
    reconcileFirstRun();
    void served.refreshAll();
  });
  // The first launch (docs/first-launch.md): the gate is the Firstmate's
  // own pre-flight - no model that can answer it: its provider's role and
  // an account the seat can stand on (`Flagship.servesFirstmate`), exactly
  // what `FirstmateAgent.resolveModel` derives from - unless an account the
  // seat could stand on is only paused by a typed cut-off, when the pause
  // card speaks instead (`Flagship.standsOnCutOff`). Welcome eligibility is
  // separate: the selected serving model must not be paused, and the host
  // commits approved Firstmate copy before publishing a normal ready state.
  const firstmateServedModels = () =>
    [
      ...routableModels(),
      ...availableModels().filter(
        (model) =>
          isCustomApiProvider(model.provider) &&
          settings.getFirstmateModel()?.provider === model.provider &&
          settings.getFirstmateModel()?.id === model.id,
      ),
    ].filter((model) => model.provider !== "anthropic" && flagship.servesFirstmate(model.provider));
  const firstRun = new FirstRunService({
    settings,
    gateOpen: () =>
      firstmateServedModels().length === 0 &&
      !flagship.standsOnCutOff() &&
      !localOrchestrator.seat(),
    // A custom-only profile whose saved checks an earlier version made
    // (docs/saved-data-compatibility.md): the gate names the connection the
    // Firstmate was chosen on and asks for its one fresh check in place.
    freshCheck: () => {
      const chosen = settings.getFirstmateModel();
      if (!chosen || !isCustomApiProvider(chosen.provider)) return undefined;
      const account = vault.list(chosen.provider).find((entry) => entry.enabled);
      if (!account) return undefined;
      const models = vault.customUnchecked(account.id);
      return models.length > 0
        ? { accountId: account.id, label: account.label, models }
        : undefined;
    },
    usable: () =>
      firstmateCanServe({
        local: Boolean(localOrchestrator.seat()),
        model: firstmate.preflightModel(),
        available: availableModels(),
        custom: auth.customProviderModels(),
        accounts: vault.availableModelsByAccount(),
        flagship,
      }),
    hasActivity: () => hasPriorActivity({ tasks, cards: cardStore, repos }),
    hasCrewHistory: () => tasks.list().some((task) => task.kind === "work"),
    hasFinishedTask: () => hasFinishedTask(tasks),
    finishedCrewmates: () => finishedCrewmates(tasks),
    createWelcome: (consume) => {
      // The welcome takes no reply - the message box under it is where to
      // type - and is the regular card its picture was drawn for.
      supervisor.addRecordedFirstmateNote(WELCOME_NOTE, consume, {
        replies: false,
        width: "regular",
      });
    },
    now: ticker.now,
    onStep: (step) => sharing.record({ name: `ftue_${step}`, data: {} }),
  });
  // Release notes (docs/release-notes.md "The startup note"): a packaged
  // build reads the catalog it carries; a dev or e2e run reads one only from
  // INFINITARY_RELEASE_NOTES_DIR, like the update overrides below, and otherwise
  // just records its version. After first-run eligibility and before the
  // window's first card snapshot, a forward upgrade commits its note on top
  // of the stack with the new baseline. A failed write never holds startup;
  // the next launch retries. A first installation shows no note: its quiet
  // record waits on the welcome, so setup and card changes look again.
  const notesDir = host.app.packaged
    ? host.app.resourcesDir
    : settingFrom(process.env, "RELEASE_NOTES_DIR")?.trim() || null;
  const releaseNotes = notesDir
    ? new ReleaseNotesService(
        {
          settings,
          isOpen: (cardId) => supervisor.hasCard(cardId),
          catalog: () => loadCatalog(notesDir, host.app.version),
          createNote: (note, record) => {
            supervisor.addRecordedFirstmateNote(note, record, { onTop: true });
            // What's new can open it now: the window and the Help menu look again.
            emit(
              "inf:release-notes",
              releaseNotesView(settings.getReleaseTracking(), host.app.version),
            );
          },
          // Kept under a reserved owner where card pictures live, so the
          // note keeps its pictures after the next upgrade replaces this
          // build's files.
          keepPicture: (file) =>
            keepPictureFile(file, {
              dir: crewmateCardPicturesDir(paths, RELEASE_NOTES_PICTURE_OWNER),
              taskId: RELEASE_NOTES_PICTURE_OWNER,
            }),
          now: ticker.now,
        },
        { version: host.app.version, source: bundledSource(notesDir, host.app.version) },
      )
    : null;
  const reconcileReleaseNotes = () => {
    if (releaseNotes) {
      releaseNotes.reconcile();
      return;
    }
    try {
      recordLaunch(settings, { version: host.app.version, source: null }, ticker.now);
    } catch (error) {
      console.warn("[release-tracking] this launch could not be recorded:", error);
    }
  };
  reconcileFirstRun = () => {
    firstRun.reconcile();
    if (releaseNotes?.awaitingWelcome) releaseNotes.reconcile();
  };
  onCardsChanged = () => {
    if (releaseNotes?.awaitingWelcome) releaseNotes.reconcile();
  };
  onCaptainTurnAccepted = () => {
    firstRun.noteCaptainTurn();
  };
  firstRun.reconcile();
  reconcileReleaseNotes();
  const livenessInterval = setInterval(
    () => {
      void sweepAccountLiveness().then(() => {
        reconcileFirstRun();
        return served.refreshAll();
      });
    },
    24 * 60 * 60 * 1000,
  );
  const observe = new ObserveService({
    enabled: isObserveEnabled({
      packaged: host.app.packaged,
      version: host.app.version,
      env: process.env,
    }),
    db,
    tasks,
    settings,
    repos,
    liveStatus: () => ({
      firstmateBusy: firstmate.isBusy(),
      firstmateModel: firstmate.modelRef(),
      firstmateSessionFile: firstmate.sessionFile(),
    }),
    crewmateTranscript,
    cardThreads: (sessionId) => supervisor.observeThreads(sessionId),
  });
  observeEvent = (event) => observe.onEvent(event);
  quota.start();
  const updateChecker = createInstalledUpdateChecker({
    app: host.app,
    openExternal: (url) => host.openExternal(url),
    ...(host.relaunch ? { relaunch: host.relaunch } : {}),
  });
  return {
    paths,
    auth,
    vault,
    flagship,
    scheduler,
    ticker,
    jobs,
    providerViews: () =>
      buildProviderViews({
        piProviders: () => auth.providers(),
        backends: new Map<string, AccountBackend>([[claudeBackend.id, claudeBackend]]),
        accounts: () =>
          vault.list().map((account) => ({
            providerId: account.providerId,
            connected: vault.connectedSync(account.id),
          })),
      }),
    availableModels,
    slots,
    servedModels: served,
    decisions,
    stopLivenessSweep: () => clearInterval(livenessInterval),
    supervisor,
    tasks,
    taskProtocol,
    firstmate,
    firstRun,
    localOrchestrator,
    observe,
    crewLive,
    usage: {
      // Models and providers by the names Settings gives them, read once per summary.
      summary: (query) => {
        const view = slots.view();
        const rows = [...view.models, ...view.byName];
        const modelName = modelNames(rows);
        const providers = new Map(rows.map((row) => [row.provider, row.providerLabel]));
        return usageStore.summary(query, {
          now: Date.now(),
          names: {
            model: (ref) => modelName(offeringKey(ref)),
            // A custom API's own connection name while it is connected, else the
            // words General's model picker uses; never the raw provider id.
            provider: (provider) =>
              providers.get(provider) ??
              (isCustomApiProvider(provider) ? "Custom API" : providerLabel(provider)),
          },
        });
      },
      tasks: (query) => usageStore.tasks(query, { now: Date.now() }),
    },
    pluginFetch: createMediatedFetch({ grants: noNetGrants }),
    sql,
    personal,
    panelMounts,
    ...(browsers ? { browsers } : {}),
    ...(taskCommands ? { taskCommands } : {}),
    launchWatch,
    repos,
    projectSetups,
    projectChanges,
    workspace,
    forges: forgeSignIns,
    integrations,
    savedOutsideData,
    devices,
    computers,
    inviteDevice,
    appBundle: () => appBundle,
    farBuild,
    remoteLogin,
    nearbyMacs,
    homeAnnouncement,
    ...(phoneDoor ? { phoneDoor } : {}),
    privacyWatch,
    sshConnections,
    workDevices,
    computerResources,
    computerResourceFeed,
    automaticPlacement,
    placed,
    deviceSignIns,
    forgeChanges,
    forgeProjects: async (host) => {
      const forge = forgeSignIns.view().hosts.some((entry) => entry.host === host)
        ? forgeOnHost(host)
        : undefined;
      if (!forge)
        throw new Error(
          "This app does not know that project host yet. Ask your first mate to add it.",
        );
      return forge.listProjects();
    },
    broadcastEvent,
    activityRun: () => runLine?.id ?? null,
    quota,
    settings,
    preferences,
    sharing,
    activity,
    ...(knowledge ? { knowledge } : {}),
    updateChecker,
  };
}

/**
 * A compact one-line quota digest for the Firstmate context block: each
 * account's EFFECTIVE remaining (min across its bounding windows - never an
 * arbitrary window) plus its spend priority when measurable (quota-axi
 * semantics: higher = paid allowance on track to expire unused).
 */
/** A development picture's addresses. A packaged app never reads the variable. */
function standInInterfaces(packaged: boolean) {
  if (packaged) return null;
  const raw = settingFrom(process.env, "STAND_IN_ADDRESSES")?.trim();
  if (!raw) return null;
  const addresses = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return addresses.length > 0 ? interfacesFromAddresses(addresses) : null;
}

function quotaContextLine(snapshot: QuotaSnapshotView | undefined): string {
  if (!snapshot || snapshot.providers.length === 0) return "unknown";
  const now = Date.now();
  const parts = snapshot.providers
    .filter((provider) => provider.status === "ok")
    .flatMap((provider) => {
      const effective = effectiveFromProvider(provider, now);
      if (typeof effective.effectivePercentRemaining !== "number") return [];
      const subject = provider.accountLabel
        ? `${provider.provider}/${provider.accountLabel}`
        : provider.provider;
      const priority =
        typeof effective.spendPriority === "number"
          ? ` (spend priority ${effective.spendPriority.toFixed(2)})`
          : "";
      return [`${subject} ${Math.round(effective.effectivePercentRemaining)}%${priority}`];
    });
  return parts.length > 0 ? parts.join("; ") : "unknown";
}
