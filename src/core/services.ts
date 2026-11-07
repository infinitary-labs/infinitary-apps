import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { emptyTranscript } from "@shared/crewTranscript";
import { isCustomApiProvider } from "@shared/customApi";
import { deviceRunsWork } from "@shared/devices";
import type { KnownForgeHost } from "@shared/forge";
import { INBOX_WORDS } from "@shared/integrations";
import { modelNames } from "@shared/modelDisplayName";
import { offeringKey, parseOfferingKey, providerLabel } from "@shared/modelSlots";
import { desktopConventions } from "@shared/platform";
import { catalogEntry } from "@shared/providers";
import { hostRunsQueue } from "@shared/repos";
import { runsForAnotherFirstmate } from "@shared/sshConnection";
import { BUILTIN_SURFACES } from "@shared/surfaces";
import type { TaskBrowserFact } from "@shared/taskBrowser";
import type { TaskRunsOn } from "@shared/taskPolicies";
import {
  BOARD_DELTA_TRIGGER,
  type TaskActionLine,
  type TaskPlace,
  type TaskView,
} from "@shared/tasks";
import type { WorkPosture } from "@shared/workPosture";
import type { AccountBackend } from "./accounts/accountBackend";
import { CredentialHealthService } from "./accounts/credentialHealthService";
import { buildProviderViews } from "./accounts/providerViews";
import { initAttachmentsDir } from "./attachments";
import { recoverAtBoot } from "./bootRecovery";
import { openTaskChannel, startTaskBrowsers } from "./browser/homeTaskBrowsers";
import { ClaudeAuthBackend } from "./claude/claudeAuth";
import { primeClaudeExecutable } from "./claude/claudeCli";
import { defaultClaudeConfigDir } from "./claude/claudeQuota";
import { createClaudeSessionFactory } from "./claude/session";
import type { CoreServices } from "./coreServices";
import { startHomeDecisions } from "./decisions/homeDecisions";
import { ownComputerName } from "./devices/computerName";
import { startHomeDevices } from "./devices/homeDevices";
import { createEventSeam } from "./eventSeam";
import type { CoreEventSink } from "./events";
import { startHomeFiles } from "./files/homeFiles";
import { startFirstLaunch } from "./firstLaunch";
import { startHomeForges } from "./forge/homeForges";
import { FreezeRecorder, freezeWake, infinitaryProject } from "./freeze/freezeRecorder";
import { isFreezeRecorderEnabled } from "./freeze/watchdog";
import type { HostCapabilities } from "./host";
import { captureLoginPath } from "./hostEnv";
import { FIRSTMATE_READER, INBOX_EVENT, INBOX_ID, SavedOutsideData } from "./integrations";
import { startHomeIntegrations } from "./integrations/homeIntegrations";
import { type JobExit, JobManager, jobExitWake } from "./jobs/jobManager";
import { KnowledgeService } from "./knowledge/knowledgeService";
import { createAccountStore } from "./models/accountStore";
import { CardNotifier } from "./notifications";
import { isObserveEnabled } from "./observe/gate";
import { ObserveService } from "./observe/observeService";
import { createCrewmateTranscriptResolver } from "./observe/transcriptSource";
import { type ChangeDelivery, createChangeDelivery } from "./orchestrator/changeDelivery";
import { ChangePresentations } from "./orchestrator/changePresentations";
import { CrewSupervisor } from "./orchestrator/crewSupervisor";
import { FirstmateAgent, type RunningComputerVersion } from "./orchestrator/firstmateAgent";
import { Flagship } from "./orchestrator/flagship";
import { GithubGatewayService } from "./orchestrator/githubGateway";
import { LocalOrchestratorService } from "./orchestrator/localOrchestrator";
import { QueueChoice } from "./orchestrator/queueChoice";
import { QueuePauses } from "./orchestrator/queuePauses";
import { Scheduler } from "./orchestrator/scheduler";
import { TICK_PERIOD_MS, Ticker, tickPeriodFor } from "./orchestrator/ticker";
import type { TypedWake } from "./orchestrator/wakes";
import { WorkflowEvidenceService } from "./orchestrator/workflowEvidence";
import { initOverflowDir } from "./overflow";
import {
  appPathsFor,
  crewmateCardPicturesDir,
  crewmateEvidenceDir,
  crewmateSessionsDir,
  crewmateTempDir,
} from "./paths";
import { startHomePersonal } from "./personal/homePersonal";
import { PanelOutsideData } from "./personal/panelOutsideData";
import { PersonalStore } from "./personal/personalStore";
import { LaunchWatch } from "./personal/safeMode";
import { CREWMATE_TOOLS } from "./pi/crewmateTaskTools";
import { PiAccountBackend } from "./pi/piAccountBackend";
import { PiAuthService } from "./pi/piAuth";
import { createPiSessionFactory } from "./pi/sessionFactory";
import { readKeptValidationEvidence } from "./pi/validationEvidence";
import { AutomaticPlacement } from "./placed/automaticPlacement";
import type { PlacedBrowsers } from "./placed/placedBrowsers";
import { PlacedSessions } from "./placed/placedSessions";
import { ResourcePressure } from "./placed/resourcePressure";
import { createMediatedFetch } from "./plugins/mediatedFetch";
import { PluginInstaller } from "./plugins/pluginInstaller";
import { PluginRecords } from "./plugins/pluginRecords";
import { ShellPreferencesService } from "./preferences/shellPreferences";
import { claudeStoreDirOf, startHomeQuota } from "./quota/homeQuota";
import { DecisionKindClassifier } from "./routing/decisionKindClassifier";
import { startHomeRouting } from "./routing/homeRouting";
import { modelChoiceOf } from "./routing/modelChoice";
import { modelAddedNote, modelGoneNote } from "./routing/modelNews";
import { modelReasonOf } from "./routing/modelReason";
import { PlacedWorkScores } from "./routing/placedWork";
import { quotaGateCleared, quotaGateRefValid } from "./routing/quotaGate";
import { servedSlots } from "./routing/router";
import { Runbooks } from "./runbooks/runbooks";
import {
  readSelfSource,
  readSelfSourceAsync,
  resolveSelfSourceDir,
  sourceIdentity,
} from "./selfSource/resolve";
import { SessionBinder } from "./session/binding";
import { BoundsWatcher } from "./session/bounds";
import { LOCAL_MACHINE_ID, type SessionFactories } from "./session/session";
import { SharingService } from "./sharing/sharingService";
import { SqlService } from "./sql/sqlService";
import { readStandIns } from "./standIns";
import { ActivityStore } from "./storage/activityStore";
import { type CardResolution, CardStore } from "./storage/cardStore";
import { assertSavedDataCompatible, openDatabase } from "./storage/db";
import { DecisionStore } from "./storage/decisionStore";
import { FIRSTMATE_RECIPIENT, InboxStore } from "./storage/inboxStore";
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
import { TaskTimeline } from "./tasks/taskTimeline";
import { WorkPresentation } from "./tasks/workPresentation";
import { createAppTelemetry } from "./telemetry";
import { createInstalledUpdateChecker } from "./update/updateChecker";
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
  // Every development and end-to-end stand-in this run names, read once; a
  // packaged app reads none of them (standIns.ts).
  const standIns = readStandIns(host.app.packaged, process.env);
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
  const runbookSource = resolveSelfSourceDir({
    isPackaged: host.app.packaged,
    resourcesPath: host.app.resourcesDir,
    appPath: host.app.appDir,
  });
  const workspace = new WorkspaceService(paths, {
    namingRule: () => runbooks.naming(),
    knownHosts: () => knownForgeHosts(),
  });
  const settings = new SettingsStore(db, desktopConventions(host.app.platform).dictationKey);
  const pluginRecords = new PluginRecords(db);
  const runbooks = new Runbooks(
    join(runbookSource, "resources/runbooks"),
    settings,
    () =>
      pluginRecords
        .installed()
        .filter((record) => record.kind === "runbook")
        .map((record) => join(paths.pluginsDir, record.id)),
    join(paths.personalWorkspaceDir, "runbooks"),
  );
  const repos = new RepoRegistry(db, paths.fleetDir, {
    settings,
    appDataDir: paths.userData,
    knownHosts: () => knownForgeHosts(),
  });
  // The app's own sign-ins and forges where projects live (docs/forge.md).
  const forges = startHomeForges({
    host,
    paths,
    repos,
    namingRule: () => runbooks.naming(),
    push: (view) => emit("inf:forges", view),
  });
  const forgeSignIns = forges.signIns;
  const forgeFor = forges.forgeFor;
  knownForgeHosts = () => forgeSignIns.knownHosts();
  // The host's one clock and one interval (P5, docs/architecture.md §17):
  // the watchdog, the idle ladder, the sweeps and the schedules register
  // on it, and the stores they compare against read its clock. Dev/e2e may
  // shorten its period, so a journey waiting on a pass need not wait out
  // the minute; a packaged build always ticks at the design's.
  let holdUpdates = (): (() => void) => () => {};
  const measurePass = (name: string, durationMs: number) =>
    console.info(`[ticker] ${name}: ${durationMs.toFixed(3)} ms synchronous`);
  const ticker = new Ticker({
    periodMs: tickPeriodFor(host.app.packaged, process.env),
    betweenPasses: () => new Promise((resolve) => setImmediate(resolve)),
    sweep: () => holdUpdates(),
    measured: measurePass,
  });
  // The one task writer (task-system P0): records, keys, timeline. The
  // dev boot assertion is strict off a packaged build.
  let readTaskFacts = <T>(read: () => T): T =>
    settings.readProjection(() => repos.readProjection(read));
  const tasks = new TaskService({
    db,
    repos,
    strict: !host.app.packaged,
    now: ticker.now,
    readFacts: (read) => readTaskFacts(read),
  });
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
  const launchWatch = new LaunchWatch({
    read: () => settings.getLaunchRecord(),
    write: (record) => settings.setLaunchRecord(record),
    ...(standIns.earlyLaunchMs !== undefined ? { earlyLaunchMs: standIns.earlyLaunchMs } : {}),
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
    now: ticker.now,
    // The browser reads again after a write commits and after the purge.
    changed: () => broadcastEvent({ type: "knowledge_changed" }),
  });
  // Startup stops if any active direction cannot be carried; no old runtime fallback.
  knowledge.directions.carry(db);
  // The durable inbox (design A): rows a dead process left in-flight go
  // back to pending before anything can drain - the boot half of
  // ack-after-handling (at-least-once; a rare duplicate over a silent loss).
  // Dev/e2e may shorten the grace between delivery attempts, so a journey
  // that quits mid-turn sees its redelivery without waiting it out; a
  // packaged build always uses the design's.
  const inbox = new InboxStore(db, {
    now: ticker.now,
    ...(standIns.inboxGraceMs !== undefined ? { graceMs: standIns.inboxGraceMs } : {}),
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
  let browserFactOf: (taskId: string) => TaskBrowserFact | undefined = () => undefined;
  let crewActionsOf: (record: TaskRecord) => readonly TaskActionLine[] = () => [];
  let crewSaidOf: (record: TaskRecord) => TaskActionLine | null = () => null;
  // The Crewmate tab's transcripts, read from the same files (late-bound
  // too), and what each crewmate is writing now, fed from the seam below.
  let crewTranscripts: CrewTranscripts | undefined;
  const crewLive = new CrewLiveText();
  let runsOnOf: (record: TaskRecord) => TaskRunsOn | undefined = () => undefined;
  let placeOf: (record: TaskRecord) => TaskPlace | undefined = () => undefined;
  let computerMoveOf: (record: TaskRecord) => Pick<TaskView, "movable" | "computerMove"> =
    () => ({});
  let scheduleWorkPresentation = () => {};
  let readWorkWaitFacts:
    | ((record: TaskRecord) => import("./tasks/taskWaits").TaskWaitFacts)
    | undefined;
  let readWorkPosture: ((record: TaskRecord) => WorkPosture) | undefined;
  // Every event broadcast passes one seam (eventSeam.ts).
  const eventSeam = createEventSeam({ tasks, activity, sharing, crewLive, emit });
  const broadcastEvent = eventSeam.broadcastEvent;
  // The task protocol's emitter (P3): every committed TaskService write
  // becomes task_changed / task_event FmEvents through the seam above and
  // one coalesced inf:tasks board push, rebuilt from SQLite after the commit.
  // Dev/e2e may lower the delta trigger (P5) to drive the delta carrier on
  // a small fleet; a packaged build always measures against the design's.
  // Task readers can run during async boot, before the supervisor restores the stack.
  let cardStack: Pick<CrewSupervisor, "cards" | "cardActions"> | undefined;
  const taskProtocol = new TaskProtocol({
    tasks,
    timeline: { history: (id) => timeline.history(id) },
    validationEvidence: (taskId, evidence) =>
      readKeptValidationEvidence(evidence, crewmateCardPicturesDir(paths, taskId), taskId),
    repos,
    cards: {
      listOpen: () => (cardStack ? [...cardStack.cards.values()] : cardStore.listOpen()),
      answerNoteForTask: (taskId) => cardStack?.cards.answerNoteForTask(taskId),
      snapshot: () => cardStack?.cards.taskSnapshot() ?? [],
      forTask: (taskId, extraIds) => cardStore.forTask(taskId, extraIds),
    },
    beforePush: () => cardStack?.cards.flushBroadcast(),
    workPosture: (record) =>
      readWorkPosture?.(record) ?? { state: "unknown", reason: "unobserved" },
    waitFacts: (record) => readWorkWaitFacts?.(record) ?? { job: false, timerOwned: false },
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
    computerMove: (record) => computerMoveOf(record),
    startAttempt: (taskId) => tasks.starts.startAttemptOf(taskId),
    // The crewmate's solid on the orbit: the slot its newest routing chose.
    tiers: (taskIds) => servedSlots(ledger, taskIds),
    // The summary's line under the model: the same decision, its typed columns.
    modelReason: (record) =>
      modelReasonOf(record, {
        decisions: ledger,
        pins: () => settings.getRoutingSettings().pins,
        keyOf: (ref) => tasks.resolve(ref)?.key || undefined,
      }),
    // The record's Why this model: the comparison that same decision saved (INF-1714).
    modelChoice: (record) => modelChoiceOf(record, ledger),
    // Read at a detail read, long after the slot record below is built:
    // the one model-name lookup the renderer applies too (FI3-565 piece 2).
    modelLabel: (model) => slots.nameOf(parseOfferingKey(model)),
    broadcastEvent,
    emit,
    ...(standIns.taskDeltaRows !== undefined
      ? { deltaTrigger: { rows: standIns.taskDeltaRows, bytes: BOARD_DELTA_TRIGGER.bytes } }
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
  // A crewmate's transcript is its task's record: Pi's is the session file
  // itself, Claude's the app's copy under the session id the row holds,
  // else the client's own file in the account's store.
  const crewmateTranscript = createCrewmateTranscriptResolver({
    recordDirOf: (taskId) => crewmateSessionsDir(paths, taskId),
    backendOf: (accountId) => vault.backendIdOf(accountId),
    configDirOf: (accountId) => {
      try {
        return claudeStoreDirOf(vault, accountId);
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
  const timeline = new TaskTimeline({
    tasks,
    modelLabel: (model) => slots.nameOf(parseOfferingKey(model)),
    cards: cardStore,
    actions: (record) => crewActions.sourced(record),
  });
  crewSaidOf = (record) => crewActions.said(record);
  crewTranscripts = new CrewTranscripts({
    recordDirOf: (taskId) => crewmateSessionsDir(paths, taskId),
    currentSession: (record) => crewmateTranscript(record).path,
  });
  // A refresh can un-bench a quota-benched Firstmate; wired after creation.
  let onQuotaRefreshed: () => void = () => {};
  let reconcileFirstRun: () => void = () => {};
  let onCardsChanged: () => void = () => {};
  let onCaptainTurnAccepted: () => void = () => {};
  const placedWork = new PlacedWorkScores(db, settings);
  // The quota sensor, its catalog and the readings sessions push (docs/quota.md).
  const homeQuota = startHomeQuota({
    host,
    standIns,
    db,
    vault,
    served,
    auth,
    broadcast: (snapshot) => {
      placedWork.observe("home", snapshot);
      onQuotaRefreshed();
      reconcileFirstRun();
      emit("inf:quota", snapshot);
    },
  });
  const quota = homeQuota.quota;
  const quotaCatalogModels = homeQuota.catalogModels;
  const { recordClaudeRateLimit, noteCutOff } = homeQuota;
  const savedQuota = quota.latest();
  if (savedQuota) placedWork.observe("home", savedQuota);
  // The routing pool, the slot record and the router (routing/homeRouting.ts).
  const homeRouting = startHomeRouting({
    standIns,
    settings,
    vault,
    served,
    auth,
    quota,
    placedWork,
    ledger,
    ticker,
  });
  const {
    availableModels,
    capabilityFor,
    slots,
    routableModels,
    decisionServedModels,
    decisionNamedModels,
    accounts,
    router,
  } = homeRouting;
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
  // The home's devices (docs/devices.md): pairing, the computers that run
  // work and their load, Remote Login, Macs nearby, the phone's door, the
  // privacy watch and each computer's own sign-ins.
  const homeDevices = await startHomeDevices({
    host,
    paths,
    standIns,
    tasks,
    emit,
    broadcastEvent,
    // A computer's Codex and Grok lists are judged by this Mac's rail.
    protectedIds: (providerId) => slots.protectedIds(providerId),
    // Late-bound: the board's presentation refresh is set up with the crew below.
    scheduleWorkPresentation: () => scheduleWorkPresentation(),
  });
  const {
    work: workDevices,
    loadLine,
    computerResources,
    computerLoads,
    pairing: devices,
    computerResourceFeed,
    sshConnections,
    reachOf,
    remoteLogin,
    signIns: deviceSignIns,
  } = homeDevices;
  // A phone that left the list drops its Diagnostics install ID
  // (docs/sharing.md, "A phone's events"); an unreadable list drops none.
  const keepPhones = () => {
    if (devices.readable()) sharing.keepPhones((deviceId) => devices.holds(deviceId));
  };
  keepPhones();
  devices.subscribe(keepPhones);
  readTaskFacts = (read) =>
    settings.readProjection(() =>
      repos.readProjection(() =>
        devices.readProjection(() =>
          deviceSignIns.readProjection(() => computerLoads.readProjection(read)),
        ),
      ),
    );
  homeRouting.attachComputerSignIns(() => deviceSignIns.view());
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
    devicePlace: (deviceId) => devices.placeOf(deviceId),
    projectName: (repoId) => repos.get(repoId)?.name,
    // A placed task's branch and kept work come into its project's own
    // repository here, or this Mac's local workspace for a task with none.
    homeRepo: async (repoId) =>
      repoId ? repos.get(repoId)?.path : await workspace.ensureDefaultRepo(),
    // A branch never comes into a missing folder: the refusal names it and
    // the repair that brings it back (INF-572). Late-bound: the crew is set up below.
    folderMissing: (repoId, taskId): string =>
      supervisor.inPlaceWork.folderMissing(repoId, "branch-home", tasks.get(taskId)),
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
  /**
   * A crewmate's account to its binding: the account's own Pi runtime, or
   * the machine's Claude login, by the account's provider. Direct injection
   * (broker phase 4): exactly one store in reach.
   */
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
  const sourceComputer = await ownComputerName({ packaged: host.app.packaged, env: process.env });
  const sourceLocation = {
    isPackaged: host.app.packaged,
    resourcesPath: host.app.resourcesDir,
    appPath: host.app.appDir,
    version: host.app.version,
    computer: sourceComputer,
  };
  const source = () => readSelfSource(sourceLocation);
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
    partsElsewhere: (deviceId) => placed.copies.writesArtifactParts(deviceId),
    evidenceDir: (taskId) => crewmateEvidenceDir(paths, taskId),
    tempDir: (taskId) => crewmateTempDir(paths, taskId),
    filesElsewhere: (deviceId) => placed.copies.writesEvidenceFiles(deviceId),
    fileElsewhere: (taskId, deviceId, name, file) =>
      placed.copies.writeEvidenceFile(taskId, deviceId, name, file),
  });
  const presentations: ChangePresentations = new ChangePresentations({
    namingRule: () => runbooks.naming(),
    tasks,
    mediaDir: (taskId) => crewmateCardPicturesDir(paths, taskId),
    head: (taskId) => changeDelivery.publication.presentationHead(taskId),
    branch: (taskId) => changeDelivery.publication.presentationBranch(taskId),
  });
  const changeDelivery: ChangeDelivery = createChangeDelivery({
    namingRule: () => runbooks.naming(),
    tasks,
    repos,
    presentations,
    // The forge seam (git integration PR 1.1): GitHub is the REST forge with
    // the app's own GitHub sign-in (PR 1.2), read at each request. A 401
    // asks the sign-in service to look again; its health read is the proof.
    forgeFor,
    onNote: (text, taskId) => broadcastEvent({ type: "firstmate_note", text, taskId }),
    bringBranchHome: (taskId, strict, branch) => placed.bringBranchHome(taskId, strict, branch),
    checkedOut: (taskId) => placed.checkedOut(taskId),
    verifyValidationEvidence: (taskId): void =>
      supervisor.reportIntake.verifyValidationEvidence(taskId),
    now: ticker.now,
  });
  // A project's queue facts (docs/forge.md, "A project's queue"): choosing
  // the batched delivery, whoever chooses it, reads the workflows that
  // mention its status, and every change of those facts reaches Settings.
  repos.onQueueChosen((repo) => void changeDelivery.queue.readWorkflows(repo.id));
  repos.onQueue((repo) => broadcastEvent({ type: "repo_queue", repoId: repo.id }));
  const githubGateway = new GithubGatewayService({
    tasks,
    repos,
    forgeFor,
    accountForge: forges.accountForge,
    readChecks: (taskId) => changeDelivery.checkTool.checkForCrew(taskId),
    beforeValidationWrite: (taskId, request, write): Promise<void> =>
      supervisor.reportIntake.consumeValidationEffect(taskId, request, write),
    watchRun: (taskId, runId) => workflowEvidence.watchStarted(taskId, runId),
    now: ticker.now,
  });
  // The panels' own saved data (one plugin vehicle, Phase A), and how long
  // each panel holds words from outside.
  const personalStore = new PersonalStore(db);
  const panelOutside = new PanelOutsideData(paths.integrationsDir, personalStore);
  // The app's own task commands, the inbox's among them (docs/axi-commands.md).
  const axiBinDir = host.app.packaged
    ? join(host.app.resourcesDir, "axi-bin")
    : join(host.app.appDir, "resources", "axi-bin");
  // Integrations (docs/integrations.md): every binding, the inbox and the asks.
  const {
    integrations,
    inbox: integrationInbox,
    panelAsks,
    outsideReads,
  } = startHomeIntegrations({
    host,
    paths,
    standIns,
    axiBinDir,
    forgeSignIns,
    gateway: githubGateway,
    tasks,
    panelOutside,
    crew: () => supervisor,
    now: ticker.now,
    emit,
  });
  forges.attachIntegrations(() => integrations.changed());
  // Personal extensions: seed the workspace, compile what is there, watch it
  // (personal/homePersonal.ts); started before the supervisor because the
  // live build loop (Step 4) is the supervisor's delegate.
  const homePersonal = await startHomePersonal({
    host,
    paths,
    db,
    store: personalStore,
    repos,
    knowledge,
    skillsSourceDir: selfSourceDir,
    enabled: personalPanelsEnabled,
    tasks,
    preferences,
    sql,
    integrations,
    panelAsks,
    crew: () => supervisor,
    pluginRecords,
    now: ticker.now,
    emit,
  });
  const { personal, panelMounts } = homePersonal;
  const credentialHealth = new CredentialHealthService({
    host: {
      listEnabled: () =>
        vault.list().flatMap((account) => (account.enabled ? [{ accountId: account.id }] : [])),
      health: (accountId) => vault.health(accountId, { refresh: true }),
      renew: (accountId, reason) => vault.renew(accountId, reason),
    },
  });
  // The decision-model class (S7, decisions/homeDecisions.ts): one
  // core-wide service any module may ask a typed, bounded question of.
  const decisions = startHomeDecisions({
    paths,
    standIns,
    settings,
    vault,
    baseRuntime: auth.modelRuntime,
    adapted: {
      availableModels: () => decisionServedModels(),
      namedModels: () => decisionNamedModels(),
      capabilityFor,
      quotaModels: () => quota.latestModels(),
      sessions: sessionFactories,
      // Whoever observes a typed cut-off records it on the account.
      noteCutOff,
    },
    selectAccount: (taskId, piProviderId) => accounts.selectForSpawn(taskId, piProviderId),
    recordUsage,
    onNote: (text) => broadcastEvent({ type: "firstmate_note", text }),
  });
  // The class's first consumer (S7a): what a spawn IS, so the captain's
  // table can route it. The seam and the call site are unchanged.
  const classifier = new DecisionKindClassifier(decisions);
  // Each task's own browser and the task channel a crewmate reaches it
  // through (browser/homeTaskBrowsers.ts).
  const browsers = startTaskBrowsers({
    host,
    paths,
    tasks,
    workDevices,
    devices,
    cardStack: () => cardStack,
    broadcastEvent,
  });
  browsersThere = browsers?.there;
  const taskCommands = await openTaskChannel({
    host,
    paths,
    axiBinDir,
    tasks,
    jobs,
    inbox: integrationInbox,
    browsers,
  });
  if (browsers) browserFactOf = (taskId) => browsers.fact(taskId);
  // Files on the captain's other computers, for every crewmate (docs/files.md).
  const files = startHomeFiles({
    paths,
    homeName: sourceComputer,
    machines: placed,
    onThisMac: (deviceId) => devices.onThisMac(deviceId),
    work: workDevices,
    tasks,
    crew: () => supervisor,
  });
  // A computer connected on an older Firstmate takes no new work: answered
  // by the devices list, which is made after the supervisor.
  const { takesNoWorkUntilUpdated } = homeDevices;
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
    running: (record): boolean => supervisor.placement.placementRunning(record),
    eligible: (record): boolean => supervisor.placement.automaticFor(record),
    forgeSignIns: () => forgeSignIns.view().signIns,
    knownForgeHosts: () => forgeSignIns.knownHosts(),
  });
  const supervisor: CrewSupervisor = new CrewSupervisor({
    automaticPlacement,
    // A program's script runs in a process of its own; its ask() is one typed read.
    ...(host.programProcess ? { programProcess: host.programProcess } : {}),
    answerJson: (caller, instruction, text, signal) =>
      decisions.answerJson(caller, instruction, text, signal),
    crewSpeed: (model) => slots.speed(model),
    modelName: (model) => slots.nameOf(model),
    personalResourcesEnabled: () => settings.getPersonalResourcesEnabled(),
    runbooks,
    build: host.app.version,
    source: () => readSelfSourceAsync(sourceLocation),
    sessions: sessionFactories,
    machines: placed,
    takesNoWorkUntilUpdated,
    reachOf,
    // A task began waiting for an update: its card comes back, even after Not now.
    recallUpdateCard: homeDevices.recallUpdateCard,
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
    taskTimeline: timeline,
    cardStore,
    knowledge,
    inbox,
    router,
    accountlessServes: () => auth.servesAnyModel(),
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
    latestUsage: (taskId) => usageStore.latestForTask(taskId),
    paths,
    now: ticker.now,
    onWatchdogTick: (now) => {
      void credentialHealth.tick(now);
      // The sign-ins where projects live, on the same tick (PR 1.2).
      void forgeSignIns.checkHealth();
    },
    hasRunningJobs: (taskId) =>
      jobs.hasRunningJobs(taskId) ||
      computerLoads.hasTask(taskId, tasks.get(taskId)?.deviceId ?? null),
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
    mergePullRequest: (taskId, guard, beforeDispatch) =>
      changeDelivery.merges.merge(taskId, guard, beforeDispatch),
    mergeReview: (taskId, reviewId, guard) =>
      changeDelivery.reviews.mergeReview(taskId, reviewId, guard),
    // An integration's ask runs through its binding; every other is a forge write.
    sendWriteAsk: (taskId, askId, choice) =>
      tasks.get(taskId)?.delivery?.writeAsks?.find((ask) => ask.id === askId)?.kind ===
      "integration"
        ? integrations.sendAsk(taskId, askId, choice)
        : githubGateway.sendAsk(taskId, askId),
    sendTakenIntegrationAsk: (rowId, taken, choice) => integrations.sendTaken(rowId, taken, choice),
    panelAskAnswered: (askId, choice) => panelAsks.answered(askId, choice === "deny"),
    reviewGate: (taskId, reviewId) => changeDelivery.reviews.reviewGate(taskId, reviewId),
    readPull: (taskId, prNumber) => changeDelivery.merges.pullState(taskId, prNumber),
    closePullRequest: (taskId) => changeDelivery.merges.close(taskId),
    checkCi: (taskId) => changeDelivery.checks.readForOffer(taskId),
    prepareChange: (taskId, input) => changeDelivery.publication.preparePresentation(taskId, input),
    openChange: (taskId, input) => changeDelivery.publication.open(taskId, input),
    completionPresentation: (taskId, revision) =>
      changeDelivery.publication.completionPresentation(taskId, revision),
    validateLocalStory: (taskId) => changeDelivery.publication.validateLocalStory(taskId),
    checkChange: (taskId, input) => changeDelivery.checkTool.checkForCrew(taskId, input),
    readWorkflow: (taskId, input) => workflowEvidence.read(taskId, input),
    downloadArtifact: (taskId, input) => workflowEvidence.download(taskId, input),
    githubRead: (taskId, input) => githubGateway.read(taskId, input),
    githubWrite: (taskId, input) => githubGateway.write(taskId, input),
    readCheckWatch: (taskId) => changeDelivery.checks.readWatched(taskId),
    readMainChecks: (repoId) => changeDelivery.checks.readDefaultBranchChecks(repoId),
    readRunWatch: (taskId, runId) => workflowEvidence.readWatched(taskId, runId),
    killJobs: (taskId) => jobs.killForOwner(taskId),
    personal: homePersonal.live,
    ...(host.mediaProbe ? { probeMedia: host.mediaProbe } : {}),
    ...(host.typefaceProbe ? { probeTypeface: host.typefaceProbe } : {}),
    ...(browsers ? { browsers } : {}),
    ...(taskCommands
      ? {
          taskCommands,
          load: {
            forTask: (taskId: string) => loadLine.forTask(taskId),
            available: (machine: string) =>
              machine === LOCAL_MACHINE_ID ||
              (placed.keepsBrowsers(machine) && computerLoads.supports(machine)),
          },
        }
      : {}),
    integrations,
    files,
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
  runsOnOf = (record) => supervisor.placement.runsOnFact(record);
  placeOf = (record) => supervisor.placement.taskPlace(record);
  computerMoveOf = (record) => supervisor.moves.computerMoveFacts(record);
  closingResolutionOf = (taskId) => supervisor.cards.newestResolutionForTask(taskId);
  cardStack = supervisor;
  readWorkPosture = (record) => supervisor.postures.workPosture(record);
  readWorkWaitFacts = (record) => supervisor.postures.workWaitFacts(record);
  const workPresentation = new WorkPresentation({
    tasks,
    protocol: taskProtocol,
    broadcastEvent: (event) => broadcastEvent(event),
    measured: (durationMs) => measurePass("presentation-refresh", durationMs),
  });
  holdUpdates = () => {
    const presentation = workPresentation.hold();
    const board = taskProtocol.holdPushes();
    return () => {
      // The refresh's microtask runs before the board's coalescing timer,
      // so the board includes the sweep and its final derived posture.
      presentation();
      board();
    };
  };
  eventSeam.attachPresentation((event) => workPresentation.heard(event));
  scheduleWorkPresentation = () => workPresentation.schedule();
  inbox.onChange(scheduleWorkPresentation);
  // Holds may change without a task write. Reconcile on the existing host clock too.
  ticker.register("work-presentation", TICK_PERIOD_MS, scheduleWorkPresentation);
  scheduleWorkPresentation();

  // The microphone note an earlier version raised on the first hold to talk
  // is a line under the input now (docs/composer.md, "Voice"); one still on
  // the stack comes down.
  supervisor.cards.withdrawHostCard("card-voice-mic-primer", "microphone line under the input");
  // Seed the notifier with the restored stack: cards surviving a restart are
  // old news, and only cards born after this moment ping.
  notifier.observe(supervisor.cards.snapshot());
  // Install by talking (Phase A, A2a): the installer stages a plugin and
  // asks on the host's consent card; the supervisor routes the captain's
  // click on it (a host effect only his click on the card's controls runs).
  const pluginInstaller = new PluginInstaller({
    records: pluginRecords,
    runbooks,
    pluginsDir: paths.pluginsDir,
    stagingDir: paths.pluginsStagingDir,
    checkCacheDir: join(paths.pluginsStagingDir, ".check"),
    store: personalStore,
    cards: {
      raise: (card) => supervisor.cards.raiseHostCard(card),
      withdraw: (id, reason) => supervisor.cards.withdrawHostCard(id, reason),
      has: (id) => supervisor.cards.has(id),
    },
    broadcast: (event) => broadcastEvent(event),
    refresh: () => personal.refresh(),
    // An added plugin may not take the id of an app panel or of one of the
    // captain's own, whether or not the switch has them mounted right now.
    reservedIds: async () => [
      ...BUILTIN_SURFACES.map((surface) => surface.id),
      ...runbooks
        .list()
        .filter((book) => book.path)
        .map((book) => book.id),
      ...(await readdir(paths.personalWorkspaceDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    ],
    panelsOn: () => preferences.get().panels.enabled,
    log: (message) => console.warn(`[infinitary] ${message}`),
  });
  supervisor.hostOps.setPluginConsent({
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
    raiseCard: (card) => supervisor.cards.raiseHostCard(card),
    tell: (facts) => firstmateForSeat?.notifyOp({ facts }, "agent"),
    broadcast: (event) => broadcastEvent(event),
  });
  supervisor.hostOps.setProjectSetup({
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
    raiseCard: (card) => supervisor.cards.raiseHostCard(card),
    tell: (facts) => firstmateForSeat?.notifyOp({ facts }, "agent"),
  });
  // A batched choice before the project's queue exists (INF-2885 direction
  // B, docs/forge.md "Choosing batched pull requests before a queue
  // exists"): it waits with its card up, the first mate hears the card's
  // Ask, and a merge in the project reads its workflows again.
  const queueChoice = new QueueChoice({
    repos,
    queue: changeDelivery.queue,
    raiseCard: (card) => supervisor.cards.raiseHostCard(card),
    withdrawCard: (id, reason) => supervisor.cards.withdrawHostCard(id, reason),
    tell: (facts) => firstmateForSeat?.notifyOp({ facts }, "agent"),
    note: (text) => broadcastEvent({ type: "firstmate_note", text }),
    offers: {
      offered: (repoId) => repos.queueOffered(repoId),
      record: (repoId, version) => repos.recordQueueOffered(repoId, version),
    },
    now: ticker.now,
  });
  // Each new read of a project's queue is followed for every teammate: a
  // project that runs the shipped queue is batched here too, and an older
  // or a project's own queue is offered once (docs/forge.md, "The shipped queue").
  repos.onQueue((repo) => void queueChoice.follow(repo).catch(() => {}));
  // A paused batch of the shipped queue (docs/forge.md, "A paused batch"):
  // each task's queue reading may show it, Settings shows it with its
  // Resume, and the first mate hears it once to start the repair.
  const queuePauses = new QueuePauses({
    repos,
    forgeFor,
    tell: (facts) => firstmateForSeat?.notifyOp({ facts }, "agent"),
    note: (text) => broadcastEvent({ type: "firstmate_note", text }),
    taskNote: (taskId, text) => tasks.note(taskId, text, { news: true }),
    now: ticker.now,
  });
  changeDelivery.queue.onState((reading) => queuePauses.observed(reading));
  ticker.register("queue-pauses", TICK_PERIOD_MS, () => void queuePauses.sweep());
  supervisor.hostOps.setQueueChoice({
    plan: (repoId) => queueChoice.plan(repoId),
    keep: (repoId) => queueChoice.keep(repoId),
  });
  tasks.onChange((change) => {
    for (const event of change.events) {
      if (event.kind !== "merged" && event.kind !== "landed") continue;
      const repoId = tasks.get(event.taskId)?.repoId;
      const repo = repoId ? repos.get(repoId) : undefined;
      if (!repo) continue;
      if (repo.queuePendingAt !== undefined) void queueChoice.recheck(repo.id);
      // A merge may bring in the shipped queue, or a newer one: read again.
      else if (hostRunsQueue(repo.host))
        void changeDelivery.queue.readWorkflows(repo.id).catch(() => {});
    }
  });
  supervisor.hostOps.setProjectChange({
    apply: (arg) => {
      void projectChanges.apply(arg);
    },
    decline: (arg) => projectChanges.decline(arg),
    inspect: (repoId) => projectChanges.inspect(repoId),
  });
  // A sign-in where projects live, as the captain meets it (PR 1.2), and
  // the first read of every sign-in, below the UI.
  forges.attachCrew({ supervisor, tasks, broadcastEvent });
  // The quiet-crewmate watchdog (P4): a stalled turn surfaces instead of
  // spinning forever; escalation only, never an automatic interrupt.
  supervisor.watch.startWatchdog(ticker);
  placed.serve({
    adopt: (taskId) => supervisor.adoptPlaced(taskId),
    caughtUp: (taskIds) => supervisor.placedCaughtUp(taskIds),
    jobExit: (taskId, exit) =>
      supervisor.watch.deliverJobResult(taskId, jobExitWake(exit, "crewmate")),
    reopened: (taskId) => supervisor.placedReopened(taskId),
    toolsNow: (taskId) => supervisor.toolsNow(taskId),
  });
  // A computer with work out of reach for a minute is said once in the feed.
  ticker.register("placed-reach", TICK_PERIOD_MS, (now) => placed.tick(now));
  // Your devices, Remove and Update, and each computer's setup and update
  // cards (docs/devices.md), now that the supervisor holds the stack.
  const { computers, setup: deviceSetup } = homeDevices.attachCrew({
    supervisor,
    placed,
    repos,
    ticker,
  });
  // The boot sweep (R1): overdue parked decisions return, and time gates
  // that passed while the app was closed dispatch once, now.
  void supervisor.watch.sweepGates(ticker.now());
  // Fleet hygiene (interaction P0, WI-7): closed rows still holding a
  // worktree, and worktree directories no record explains, retire it with
  // their unlanded work saved first; leftover task branches are reported
  // as one feed line - never deleted.
  void supervisor.watch.reconcileFleetHygiene().catch((caught) => {
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
    // The inbox's receipts say an event was handled once its delivery was.
    handled: (integration, events, at) => {
      if (integration === INBOX_ID) integrationInbox.handled(events, at);
    },
    // A rule's project is named in its prompt while it is live (docs/automation.md).
    projectOf: (id) => {
      const project = tasks.projects.get(id);
      return project && project.archivedAt === null
        ? { key: project.key, name: project.name }
        : undefined;
    },
  });
  // A drop is looked at once, not at the next minute (docs/integrations.md, "The inbox").
  integrationInbox.wakeThrough({
    dropped: () => scheduler.lookNow(INBOX_ID),
    listening: () => scheduler.listeners(INBOX_ID),
    // The captain's word on INF-1214: adding the inbox turns its rule on
    // too. A rule kept from before it was last turned off listens to this
    // inbox again, its edits and its state kept.
    added: (say) => {
      const spec = { kind: "event", integration: INBOX_ID, event: INBOX_EVENT.name } as const;
      const current = integrations.listenable(INBOX_ID, INBOX_EVENT.name)?.connection;
      const kept = scheduler
        .rules()
        .filter((rule) => rule.spec.kind === "event" && rule.spec.integration === INBOX_ID);
      for (const rule of kept)
        if (rule.connection !== current) scheduler.update(rule.id, { reconnect: true }, { say });
      if (kept.length === 0)
        scheduler.create(spec, INBOX_WORDS.rulePrompt, true, INBOX_WORDS.ruleName, undefined, {
          ...(say ? { say } : {}),
        });
    },
  });
  const homeComputerName = await ownComputerName({ packaged: host.app.packaged, env: process.env });
  const firstmate = new FirstmateAgent({
    computerVersions: () => {
      const running = workDevices.runningVersions();
      return [
        {
          id: "this-mac",
          name: homeComputerName,
          role: "home",
          connected: true,
          version: host.app.version,
        },
        ...computers.list().flatMap((device): RunningComputerVersion[] => {
          const live = running.filter((row) => row.deviceId === device.id);
          return live.length > 0
            ? live.map((row) => ({
                id: device.id,
                name: device.name,
                role: row.role,
                connected: true,
                version: row.version,
              }))
            : [
                {
                  id: device.id,
                  name: device.name,
                  role: device.kind,
                  connected: false,
                  version: null,
                },
              ];
        }),
      ];
    },
    runbooks,
    paths,
    platform: host.app.platform,
    inbox,
    now: ticker.now,
    settings,
    onCaptainTurnAccepted: () => onCaptainTurnAccepted(),
    forges: forges.access,
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
    recheckAllowance: () => quota.refresh("demand"),
    // Each backend's seat (W1): the seat preset, opened by the one factory
    // per backend.
    seats: sessionFactories,
    ...(localSeat ? { localOrchestrator: localSeat } : {}),
    availableModels,
    listedModels: () => slots.listedOf(availableModels()),
    slotsOf: (ref) => slots.slotsOf(ref),
    quotaModels: () => quota.latestModels(),
    quotaLine: homeQuota.contextLine,
    repos,
    supervisor,
    tasks,
    knowledge,
    scheduler,
    broadcastEvent,
    selfSourceDir,
    selfSourceFacts: source,
    selfSourceFactsAsync: () => readSelfSourceAsync(sourceLocation),
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
        knowledge: knowledge.held(),
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
  homePersonal.attachFirstmate((wake) => {
    firstmate.notifyOp(wake, "agent");
  });
  const resourcePressure = new ResourcePressure({
    taskKey: (id) => tasks.resolve(id)?.key ?? id,
    notify: (wake) => notifyFirstmate(wake, "scheduled"),
    activity: (fact) => broadcastEvent({ type: "firstmate_note", text: fact.text, tone: "warn" }),
  });
  homeDevices.attachPressure((view) => resourcePressure.observe(view));
  resourcePressure.observe(computerResourceFeed.snapshot());
  // The freeze recorder (docs/freeze-recorder.md), in alpha builds only: each
  // main thread stall goes to its record, and a summary of this run's stalls
  // to the first mate only when the captain's projects hold Infinitary's own
  // source, where a fix goes.
  let freezeSummarized = false;
  const freezeRecorder = isFreezeRecorderEnabled({
    packaged: host.app.packaged,
    version: host.app.version,
    env: process.env,
  })
    ? new FreezeRecorder({
        recordPath: paths.freezeRecordPath,
        build: sourceIdentity(source()),
        memory: {
          recordPath: paths.memoryRecordPath,
          ...(host.processFootprint ? { footprint: host.processFootprint } : {}),
        },
        onFreeze: () => {},
        // One summary per installed version (the inbox's once-identity), with
        // the stalls since this run started rather than its first stall.
        onSummary: ({ example, ...rate }) => {
          if (freezeSummarized) return;
          const project = infinitaryProject(repos.list());
          if (!project) return;
          freezeSummarized = true;
          notifyFirstmate(freezeWake(example, project, host.app.version, rate), "scheduled");
        },
      })
    : null;
  freezeRecorder?.start();
  holdSeat = (accountId) => firstmate.holdSeatFor(accountId);
  scheduler.start(ticker);
  // Words from outside go from saved conversations once past their days,
  // or now on the captain's delete (docs/task-retention.md, "Words from
  // outside"). A conversation is written again only between its turns.
  const savedOutsideData = new SavedOutsideData({
    paths,
    reads: outsideReads,
    panels: panelOutside,
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
          : supervisor.sessions.conversationBusy(reader),
      release: (reader) =>
        reader === FIRSTMATE_READER
          ? firstmate.releaseConversation()
          : supervisor.sessions.releaseConversation(reader),
      held: (reader) =>
        reader === FIRSTMATE_READER
          ? firstmate.conversationHeld()
          : supervisor.sessions.conversationHeld(reader),
    },
    // A crewmate on a computer that runs work: replaced there, by that computer.
    placed: (record, due, files) => placed.deleteOutside(record, due, files),
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
      supervisor.watch.deliverJobResult(exit.ownerId, jobExitWake(exit, "crewmate"));
    }
  };
  // Boot recovery (bootRecovery.ts): safe mode and the jobs the last quit
  // stranded are said once each, then the cut-off, inbox and idle sweeps
  // run, and wakes parked on the retired supervision lane go to the first mate.
  recoverAtBoot({
    enteredSafeMode,
    jobs,
    tasks,
    supervisor,
    inbox,
    now: ticker.now,
    broadcastEvent,
  });
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
  // (docs/quota.md "A changed login"). Health and allowance share the
  // same store reader; there is no separate focus-time identity check.
  vault.onLoginChange((accountId) => homeQuota.forgetLogin(accountId));
  // So is one a computer that runs work names on its own sign-ins; its
  // setup card reads them too, and a task waiting for a sign-in there
  // starts now rather than at the next tick.
  homeDevices.attachSignIns((deviceId) => {
    const reading = deviceSignIns.lastSaid(deviceId)?.quota;
    if (reading) placedWork.observe(deviceId, reading);
    scheduleWorkPresentation();
    supervisor.reconcileCutOffs();
    deviceSetup.signInsChanged(deviceId);
    supervisor.placement.deviceSignInsChanged(deviceId);
  });
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
  onQuotaRefreshed = () => {
    const snapshot = quota.latest();
    // The terminal needs_reauth card, only from proof (homeQuota.ts).
    if (snapshot) homeQuota.syncNeedsReauthCards(snapshot, supervisor.cards);
    firstmate.onQuotaRefreshed();
    // A refresh may clear a quota-reset gate (R1).
    void supervisor.watch.sweepGates(ticker.now());
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
  // and only once the sweep has refreshed which accounts are connected.
  // Claude's catalog read takes the store slot; a rejected allowance read
  // during it defers until the next reading rather than queueing a refresh.
  void sweepAccountLiveness().then(() => {
    reconcileActivation();
    reconcileFirstRun();
    void served.refreshAll();
  });
  // The first launch and the startup note (firstLaunch.ts).
  const firstLaunch = startFirstLaunch({
    host,
    paths,
    standIns,
    settings,
    routing: { routableModels, availableModels },
    flagship,
    localOrchestrator,
    vault,
    auth,
    firstmate,
    tasks,
    cards: cardStore,
    repos,
    supervisor,
    sharing,
    now: ticker.now,
    emit,
  });
  const { firstRun } = firstLaunch;
  reconcileFirstRun = () => firstLaunch.reconcile();
  onCardsChanged = () => firstLaunch.cardsChanged();
  onCaptainTurnAccepted = () => firstLaunch.captainTurnAccepted();
  firstLaunch.begin();
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
    cardThreads: (sessionId) => supervisor.cards.observeThreads(sessionId),
  });
  eventSeam.attachObserve((event) => observe.onEvent(event));
  quota.start();
  const updateChecker = createInstalledUpdateChecker({
    app: host.app,
    ...(host.macUpdates ? { macDriver: host.macUpdates } : {}),
    openExternal: (url) => host.openExternal(url),
    ...(host.relaunch ? { relaunch: host.relaunch } : {}),
    // This computer's crew saves its running work before an update
    // replaces the copy (docs/alpha.md, "Saving work before an update").
    work: {
      save: (options) => supervisor.updates.saveForUpdate(options),
      release: () => supervisor.updates.releaseUpdate(),
      resuming: () => supervisor.updates.resumingAfterUpdate(),
    },
  });
  return {
    paths,
    timeline,
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
    pluginFetch: createMediatedFetch(),
    sql,
    personal,
    panelMounts,
    ...(browsers ? { browsers } : {}),
    ...(taskCommands ? { taskCommands } : {}),
    launchWatch,
    repos,
    projectSetups,
    projectChanges,
    queueChoice,
    queuePauses,
    workspace,
    forges: forgeSignIns,
    integrations,
    integrationInbox,
    savedOutsideData,
    devices,
    computers,
    inviteDevice: homeDevices.inviteDevice,
    appBundle: () => homeDevices.appBundle,
    farBuild: homeDevices.farBuild,
    remoteLogin,
    nearbyMacs: homeDevices.nearbyMacs,
    homeAnnouncement: homeDevices.homeAnnouncement,
    ...(homeDevices.phoneDoor ? { phoneDoor: homeDevices.phoneDoor } : {}),
    privacyWatch: homeDevices.privacyWatch,
    freezeRecorder,
    sshConnections,
    workDevices,
    computerResources,
    computerResourceFeed,
    loadLine,
    computerLoads,
    automaticPlacement,
    placed,
    deviceSignIns,
    forgeChanges: forges.changes,
    forgeProjects: forges.projects,
    broadcastEvent,
    activityRun: eventSeam.activityRun,
    quota,
    settings,
    runbooks,
    preferences,
    sharing,
    activity,
    knowledge,
    updateChecker,
  };
}
