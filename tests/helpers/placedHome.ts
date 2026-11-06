import { join } from "node:path";
import type { ComputerReach } from "@shared/devices";
import { devicePlace } from "@shared/signIns";
import { type HomeConnection, startConnection } from "../../src/core/connection/connection";
import { DeviceSetup } from "../../src/core/devices/deviceSetup";
import { DeviceSignIns } from "../../src/core/devices/deviceSignIns";
import type { DevicePairing } from "../../src/core/devices/pairing";
import type { CoreDispatch } from "../../src/core/dispatcher";
import { CoreEventBus } from "../../src/core/events";
import type {
  DownloadArtifactInput,
  Forge,
  ForgeRepo,
  ReadWorkflowInput,
} from "../../src/core/forge";
import { GitHubForge } from "../../src/core/forge/providers/github/githubForge";
import {
  FIRSTMATE_READER,
  FileIntegrationSecrets,
  githubIntegration,
  googleIntegration,
  googleSetup,
  IntegrationSettingsStore,
  IntegrationsService,
  OutsideReads,
  SavedOutsideData,
} from "../../src/core/integrations";
import { jobExitWake } from "../../src/core/jobs/jobManager";
import {
  type ChangeDelivery,
  createChangeDelivery,
} from "../../src/core/orchestrator/changeDelivery";
import { ChangePresentations } from "../../src/core/orchestrator/changePresentations";
import { CrewSupervisor } from "../../src/core/orchestrator/crewSupervisor";
import { GithubGatewayService } from "../../src/core/orchestrator/githubGateway";
import type { TypedWake } from "../../src/core/orchestrator/wakes";
import { WorkflowEvidenceService } from "../../src/core/orchestrator/workflowEvidence";
import { type AppPaths, appPathsFor, crewmateCardPicturesDir } from "../../src/core/paths";
import type { PlacedBrowserSink } from "../../src/core/placed/crewMachines";
import { PlacedSessions } from "../../src/core/placed/placedSessions";
import { WorkDevices } from "../../src/core/placed/workDevices";
import type { QuotaCatalogModel } from "../../src/core/quota/auth";
import type { QuotaService } from "../../src/core/quota/quotaService";
import { computerBoardModels } from "../../src/core/routing/computerPool";
import { type AccountModels, ModelSlots } from "../../src/core/routing/modelSlots";
import { Router } from "../../src/core/routing/router";
import type { PiModelRef } from "../../src/core/routing/routingEngine";
import type {
  ControlProfile,
  SessionBinding,
  SessionFactory,
} from "../../src/core/session/session";
import { CardStore } from "../../src/core/storage/cardStore";
import { type AppDatabase, openDatabase } from "../../src/core/storage/db";
import { DecisionStore } from "../../src/core/storage/decisionStore";
import { InboxStore } from "../../src/core/storage/inboxStore";
import { SettingsStore } from "../../src/core/storage/settingsStore";
import { TaskService } from "../../src/core/tasks/taskService";
import { TaskTimeline } from "../../src/core/tasks/taskTimeline";
import { RepoRegistry } from "../../src/core/workspace/repoRegistry";
import { WorkspaceService } from "../../src/core/workspace/workspaceService";
import type { Card } from "../../src/shared/cards";
import type { FmEvent } from "../../src/shared/events";
import type { InvokeRequest } from "../../src/shared/ipc";
import {
  HOME_CAPABILITIES,
  isWorkInvokeChannel,
  PROTOCOL_VERSION,
  parseInvokeRequest,
} from "../../src/shared/ipc";
import { type CatalogModelView, servedProviderOf } from "../../src/shared/quota";
import { STAND_IN_CLIENT_ID, STAND_IN_CLIENT_SECRET } from "./googleStandIn";

/**
 * A home whose crew runs on a computer that runs work (docs/helper.md,
 * "Holding a conversation"), composed from the home's own parts as
 * `createServices` composes them: the task record, the durable inbox and
 * the card stack over a real database in `userData`, the crew supervisor,
 * `PlacedSessions` as its computers, and the real connection on `port`
 * answering what a computer asks, with each computer's own sign-ins as
 * `DeviceSignIns` hears them. No Firstmate: a test places and starts each
 * task itself, and every task runs on a computer. Routing only when a test
 * names this Mac's own subscriptions, over the slot record as
 * `createServices` keeps it; otherwise every task binds `binding`.
 * Given a forge, the crew's open_change, check_change, read_workflow and
 * download_artifact, and the run watch, are the home's own (`createChangeDelivery`,
 * `WorkflowEvidenceService`), composed as `createServices` composes them.
 * Given a github.com sign-in, the integrations are the home's own too, and
 * a crewmate's integrations command there is answered by them here; given
 * Google's stand-in, Google is one of them, with the pass that deletes its
 * words from saved conversations (`SavedOutsideData`).
 * A restart is a new one over the same folder and port.
 */

export type PlacedHome = {
  tasks: TaskService;
  repos: RepoRegistry;
  inbox: InboxStore;
  supervisor: CrewSupervisor;
  integrations?: IntegrationsService;
  placed: PlacedSessions;
  devices: WorkDevices;
  /** What each computer said of its own sign-ins. */
  signIns: DeviceSignIns;
  /** Each computer's setup card, and the GitHub card its project raises. */
  setup: DeviceSetup;
  /** The routing ledger; empty unless the home routes. */
  decisions: DecisionStore;
  /** The database beneath, for reading what the ledger keeps to itself (a decision's reasons). */
  db: AppDatabase;
  /** Every event the home broadcast, oldest first. */
  events: FmEvent[];
  /** Every wake the Firstmate was sent, oldest first. */
  wakes: TypedWake[];
  /** The card stack, as last broadcast. */
  cards: () => Card[];
  paths: AppPaths;
  /** Firstmate quits on the home: the crew lets go, the connection closes, the folder stays. */
  quit: () => Promise<void>;
  /** Only the connection drops; the home keeps running. */
  drop: () => Promise<void>;
  /** The connection listens again, on the same port. */
  listen: () => Promise<void>;
  /** Resolves once the connection listens for what is paired now. */
  settled: () => Promise<void>;
  /** The pass that deletes Google's words from saved conversations, given Google's stand-in. */
  outsideData: SavedOutsideData | undefined;
};

/**
 * A workspace that is asked for nothing but this Mac's default workspace,
 * where a task with no project merges, and a merge of a branch brought
 * here: a placed task keeps no working copy here.
 */
export function homeWorkspace(paths: AppPaths): WorkspaceService {
  const real = new WorkspaceService(paths, { pool: false });
  return new Proxy({} as WorkspaceService, {
    get: (_target, name) =>
      name === "ensureDefaultRepo" || name === "landTaskWork"
        ? real[name].bind(real)
        : () => {
            throw new Error(`A placed task asked this Mac's workspace for ${String(name)}.`);
          },
  });
}

export function startPlacedHome(options: {
  userData: string;
  port: number;
  /** The pairing the connection follows; a restart gets a new one over the same folder. */
  pairing: () => DevicePairing;
  now: () => number;
  /** The live-copy clock's cancellable scheduler, for deterministic lifecycle checks. */
  scheduleCopy?: (ms: number, run: () => void) => () => void;
  /** What every task's account binds to here; the computer binds its own. */
  binding: SessionBinding;
  /** The backends' control planes, as this Mac's factories declare them. */
  profiles: { pi: ControlProfile; claude?: ControlProfile };
  /** Where each project lives, for the crew's change and artifact tools. */
  forgeFor?: (repo: ForgeRepo | undefined, fallbackDir?: string) => Forge;
  /**
   * This Mac's github.com sign-in, signed in as `login` with `token`, at a
   * stand-in GitHub API: its integrations are composed as `createServices`
   * composes them, GitHub over the gateway's calls through that sign-in
   * (docs/integrations.md). Absent, the crew has no integrations.
   */
  github?: { apiBaseUrl: string; token: string; login: string };
  /**
   * Google's stand-in (`tests/helpers/googleStandIn.ts`) at `base`: Google
   * is composed as `createServices` composes it, signed out until a test
   * signs in, and the pass over saved conversations with it.
   */
  google?: { base: string };
  /**
   * This Mac's own subscriptions, for a home that routes as `createServices`
   * composes it: the models its own sign-ins serve, their allowance as read
   * here, and its provider-wide catalog, which a computer's pool is cut from.
   */
  routing?: {
    available: PiModelRef[];
    catalog: CatalogModelView[];
    catalogModels: QuotaCatalogModel[];
  };
  /** Whether Firstmate on a computer runs work for another Firstmate now, as this Mac's own SSH connection found. */
  runsForAnotherFirstmate?: (deviceId: string) => boolean;
  /** The one reach value. Absent, out of reach. */
  reachOf?: (deviceId: string) => ComputerReach;
  /**
   * What a task's conversation runs on here, for a task that moves home,
   * which keeps its working copy in this Mac's real workspace; absent,
   * nothing runs here.
   */
  here?: SessionFactory;
  /** Where a computer's task browsers report here; absent, nothing hears them. */
  browsers?: () => PlacedBrowserSink | undefined;
  log?: (line: string) => void;
}): PlacedHome {
  const { now } = options;
  const db: AppDatabase = openDatabase(options.userData);
  const paths = appPathsFor(options.userData);
  // The task service reads each task's policies through the same projects
  // the crew does, as the app wires them.
  const repos = new RepoRegistry(db, paths.fleetDir);
  const tasks = new TaskService({ db, repos, now });
  const cardStore = new CardStore(db);
  const inbox = new InboxStore(db, { now });
  inbox.resetInFlight(
    tasks
      .listActive()
      .filter((record) => record.deviceId)
      .map((record) => record.id),
  );
  const events: FmEvent[] = [];
  const wakes: TypedWake[] = [];
  let cards: Card[] = [];
  const devices = new WorkDevices();
  // What a computer says of its sign-ins reaches the crew once it exists.
  let signInsChanged: (deviceId: string) => void = () => {};
  const signIns = new DeviceSignIns({
    devices: () => options.pairing().list(),
    work: devices,
    emit: () => {},
    broadcastEvent: (event) => events.push(event),
    changed: (deviceId) => signInsChanged(deviceId),
  });
  const decisions = new DecisionStore(db);
  const routing = options.routing;
  const settings = new SettingsStore(db);
  const latestModels = () =>
    routing && { generatedAt: new Date(now()).toISOString(), models: routing.catalog };
  // The slot record over this Mac's own models and each computer's models
  // this Mac's catalog does not list, as `createServices` keeps it.
  const slots = routing
    ? new ModelSlots({
        settings,
        accounts: () => [
          ...homeAccounts(routing.available),
          ...computerBoardModels(
            signIns.view(),
            new Set(routing.catalog.map((model) => servedProviderOf(model.provider))),
          ),
        ],
        quotaModels: latestModels,
      })
    : undefined;
  const router = routing
    ? new Router({
        quota: { latestModels } as unknown as QuotaService,
        settings,
        decisions,
        availableModels: () => routing.available,
        slots,
      })
    : undefined;
  // A task that moves home keeps its working copy here, in the real workspace.
  const workspace = options.here
    ? new WorkspaceService(paths, { pool: false })
    : homeWorkspace(paths);
  const placed = new PlacedSessions({
    tasks,
    paths,
    devices,
    profiles: options.profiles,
    deviceName: () => "Mac mini",
    computers: () =>
      options
        .pairing()
        .list()
        .filter((device) => device.kind === "work")
        .map((device) => device.id),
    // How the home's words place it, from the real pairing's entry.
    devicePlace: (deviceId) => devicePlace(options.pairing().list(), deviceId),
    projectName: (repoId) => repos.get(repoId)?.name,
    // A placed task's branch and kept work come into its project here, or
    // into this Mac's own local workspace for a task with none.
    homeRepo: async (repoId) =>
      repoId ? repos.get(repoId)?.path : await workspace.ensureDefaultRepo(),
    // A branch never comes into a missing folder: the refusal names it and
    // the repair that brings it back (INF-572). Late-bound: the crew is set up below.
    folderMissing: (repoId, taskId): string =>
      supervisor.folderMissing(repoId, "branch-home", tasks.get(taskId)),
    projectOrigin: (repoId) => repos.get(repoId)?.origin,
    projects: () => repos.list().map((repo) => repo.id),
    signIns: (deviceId) => signIns.signInsOf(deviceId),
    saidSignIns: (deviceId) => signIns.lastSaid(deviceId),
    refreshSignIns: (deviceId) => signIns.refresh(deviceId),
    catalogModels: () => routing?.catalogModels ?? [],
    ...(options.runsForAnotherFirstmate
      ? { runsForAnotherFirstmate: options.runsForAnotherFirstmate }
      : {}),
    ...(options.reachOf ? { reachOf: options.reachOf } : {}),
    ...(options.browsers ? { browsers: options.browsers } : {}),
    broadcastEvent: (event) => events.push(event),
    now,
    schedule: options.scheduleCopy,
    log: options.log ?? (() => {}),
  });
  const backend = options.binding.backend;
  const profile = options.profiles[backend];
  if (!profile) throw new Error(`No ${backend} control plane was named.`);
  const nothingHere = {
    backend,
    controlProfile: profile,
    open: async () => {
      throw new Error("Nothing runs on this Mac here.");
    },
  };
  const forgeFor = options.forgeFor;
  const delivery: ChangeDelivery | undefined = forgeFor
    ? createChangeDelivery({
        tasks,
        repos,
        forgeFor,
        bringBranchHome: (taskId, strict, branch) => placed.bringBranchHome(taskId, strict, branch),
        checkedOut: (taskId) => placed.checkedOut(taskId),
        presentations: new ChangePresentations({
          tasks,
          mediaDir: (taskId) => crewmateCardPicturesDir(paths, taskId),
          head: (taskId) => {
            if (!delivery) throw new Error("No delivery service");
            return delivery.publication.presentationHead(taskId);
          },
          branch: (taskId) => {
            if (!delivery) throw new Error("No delivery service");
            return delivery.publication.presentationBranch(taskId);
          },
        }),
        now,
      })
    : undefined;
  const evidence = forgeFor
    ? new WorkflowEvidenceService({
        tasks,
        repos,
        forgeFor,
        writeElsewhere: (taskId, deviceId, artifact) =>
          placed.copies.writeArtifact(taskId, deviceId, artifact),
        partsElsewhere: (deviceId) => placed.copies.writesArtifactParts(deviceId),
        now,
      })
    : undefined;
  // This Mac's integrations, as `createServices` composes them.
  const github = options.github;
  const accountForge = github
    ? () =>
        new GitHubForge(
          { kind: "github", host: "github.com", dir: "" },
          { apiBaseUrl: github.apiBaseUrl, token: async () => github.token },
        )
    : undefined;
  const integrationGateway = accountForge
    ? new GithubGatewayService({
        tasks,
        repos,
        forgeFor: forgeFor ?? accountForge,
        accountForge,
        readChecks: async (taskId) => delivery?.checkTool.checkForCrew(taskId) ?? "No checks here.",
        now,
      })
    : undefined;
  const google = options.google
    ? googleSetup({
        packaged: false,
        env: {
          INFINITARY_GOOGLE_CLIENT_ID: STAND_IN_CLIENT_ID,
          INFINITARY_GOOGLE_CLIENT_SECRET: STAND_IN_CLIENT_SECRET,
          INFINITARY_GOOGLE_URL: options.google.base,
        },
      })
    : undefined;
  const secrets = new FileIntegrationSecrets(join(paths.integrationsDir, "secrets"));
  const outsideReads = new OutsideReads(paths.integrationsDir);
  let integrations: IntegrationsService | undefined;
  integrations =
    (github && accountForge) || google
      ? new IntegrationsService({
          bindings: [
            ...(github && accountForge
              ? [
                  githubIntegration({
                    signIns: {
                      stateOf: () => "ok",
                      loginOf: () => github.login,
                      checkNow: async () => {},
                      signOut: () => {},
                    },
                    gateway: {
                      read: (taskId, input, through) =>
                        integrationGateway!.read(taskId, input, through),
                      write: (taskId, input, through) =>
                        integrationGateway!.write(taskId, input, through, true),
                      readAsSeat: (input) => integrationGateway!.readAsSeat(input),
                      writeAsSeat: (input) => integrationGateway!.writeAsSeat(input),
                    },
                  }),
                ]
              : []),
            ...(google
              ? [
                  googleIntegration({
                    root: paths.integrationsDir,
                    secrets,
                    ...google,
                    // The stand-in's sign-in page answers at once: nothing reaches a browser.
                    open: async (url) => {
                      await (await fetch(url)).text();
                    },
                    now,
                    changed: () => integrations?.changed(),
                  }),
                ]
              : []),
          ],
          store: new IntegrationSettingsStore(paths.integrationsDir),
          secrets,
          asks: {
            keep: (taskId, ask) => tasks.delivery.keepWriteAsk(taskId, ask),
            present: (taskId, ask) => supervisor.askIntegration(taskId, ask),
            take: (taskId, askId) => tasks.delivery.takeWriteAsk(taskId, askId),
            record: (taskId, askId, outcome) =>
              tasks.delivery.recordWriteAskOutcome(taskId, askId, outcome),
          },
          reads: outsideReads,
          files: {
            refusal: (taskId): string | undefined => supervisor.outsideFileRefusal(taskId),
            save: (taskId, name, bytes): Promise<{ file: string; path: string }> =>
              supervisor.saveOutsideFile(taskId, name, bytes),
          },
          now,
        })
      : undefined;
  const composed = integrations;
  const supervisor = new CrewSupervisor({
    personalResourcesEnabled: () => settings.getPersonalResourcesEnabled(),
    sessions: {
      pi: options.here ?? { ...nothingHere, backend: "pi" },
      claude: { ...nothingHere, backend: "claude" },
    },
    machines: placed,
    ...(options.reachOf ? { reachOf: options.reachOf } : {}),
    ...(composed
      ? {
          integrations: composed,
          sendWriteAsk: (taskId, askId, choice) => composed.sendAsk(taskId, askId, choice),
        }
      : {}),
    bind: async () => options.binding,
    ...(router ? { router } : {}),
    workspace,
    repos,
    ...(delivery
      ? {
          prepareChange: (
            taskId: string,
            input: import("@shared/changePresentation").StagedChangePresentation,
          ) => delivery.publication.preparePresentation(taskId, input),
          completionPresentation: (taskId: string, revision: number) =>
            delivery.publication.completionPresentation(taskId, revision),
          openChange: (
            taskId: string,
            input: import("@shared/changePresentation").OpenChangeInput,
          ) => delivery.publication.open(taskId, input),
          checkChange: (taskId: string) => delivery.checkTool.checkForCrew(taskId),
        }
      : {}),
    ...(evidence
      ? {
          readWorkflow: (taskId: string, input: ReadWorkflowInput) => evidence.read(taskId, input),
          downloadArtifact: (taskId: string, input: DownloadArtifactInput) =>
            evidence.download(taskId, input),
          readRunWatch: (taskId: string, runId: number) => evidence.readWatched(taskId, runId),
        }
      : {}),
    tasks,
    cardStore,
    taskTimeline: new TaskTimeline({ tasks, cards: cardStore }),
    inbox,
    paths,
    now,
    broadcastEvent: (event) => events.push(event),
    broadcastCards: (snapshot) => {
      cards = snapshot;
    },
  });
  supervisor.setFirstmateHooks({
    notifyOp: (wake) => {
      if (typeof wake !== "string") wakes.push(wake);
    },
    retryConverse: () => {},
  });
  // The pass over saved conversations, as `createServices` composes it; no
  // first mate runs here, so its own conversation is never busy.
  const outsideData =
    google && composed
      ? new SavedOutsideData({
          paths,
          reads: outsideReads,
          task: (id) => tasks.get(id),
          tasks: () => tasks.list(),
          kept: () => composed.kept(),
          legacy: () => composed.legacyCalls(),
          claudeConfigDir: () => join(options.userData, "claude"),
          firstmateClaudeSessions: () => [],
          conversations: {
            busy: (reader) => reader !== FIRSTMATE_READER && supervisor.conversationBusy(reader),
            release: async (reader) =>
              reader === FIRSTMATE_READER || supervisor.releaseConversation(reader),
            held: (reader) => reader !== FIRSTMATE_READER && supervisor.conversationHeld(reader),
          },
          placed: (record, due, files) => placed.deleteOutside(record, due, files),
          runs: { rewrite: () => 0 },
          inbox: { rewrite: (scrub) => inbox.rewritePending(scrub) },
          now,
          log: options.log ?? (() => {}),
        })
      : undefined;
  // Each computer's setup card and GitHub card, as `createServices` wires them.
  const setup = new DeviceSetup({
    devices: () => options.pairing().list(),
    repos,
    signIns: {
      lastSaid: (deviceId) => signIns.lastSaid(deviceId),
      signInsOf: (deviceId) => signIns.signInsOf(deviceId),
    },
    cards: {
      raise: (card) => supervisor.cards.raiseHostCard(card),
      withdraw: (id, reason) => supervisor.cards.withdrawHostCard(id, reason),
      has: (id) => supervisor.cards.has(id),
      stored: (id) => supervisor.cards.stored(id) !== undefined,
      chosenAction: (id) => supervisor.cards.chosenAction(id),
    },
    broadcastEvent: (event) => events.push(event),
    forgeNeeded: (deviceId, host, repo) =>
      supervisor.placement.projectForgeSignInNeeded(deviceId, host, repo),
    forgeReady: (deviceId, host) =>
      void supervisor.placement.resumeDeviceForgeSignInTasks(deviceId, host),
  });
  repos.onRunsOn((repo) => setup.runsOnChanged(repo));
  devices.onWorkDevice((contact) => setup.contact(contact));
  signInsChanged = (deviceId) => {
    supervisor.reconcileCutOffs();
    setup.signInsChanged(deviceId);
    // A task waiting for a sign-in there starts now, not at the next tick.
    supervisor.placement.deviceSignInsChanged(deviceId);
  };
  placed.serve({
    adopt: (taskId) => supervisor.adoptPlaced(taskId),
    caughtUp: (taskIds) => supervisor.placedCaughtUp(taskIds),
    jobExit: (taskId, exit) => supervisor.deliverJobResult(taskId, jobExitWake(exit, "crewmate")),
    reopened: (taskId) => supervisor.placedReopened(taskId),
    toolsNow: (taskId) => supervisor.toolsNow(taskId),
  });
  const dispatch = (async (channel, rawArgs, actor) => {
    if (channel === "inf:app:healthcheck")
      return {
        ok: true,
        version: "9.9.9",
        platform: "test-os",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...HOME_CAPABILITIES],
      };
    if (actor?.kind !== "device" || !isWorkInvokeChannel(channel))
      throw new Error(`Rejected ${channel}`);
    const [request] = parseInvokeRequest(channel, rawArgs);
    // What a computer says of its own sign-ins is not about a task it holds.
    if (channel === "inf:work:sign-in")
      return signIns.step(actor.deviceId, request as InvokeRequest<"inf:work:sign-in">[0]);
    if (channel === "inf:work:sign-ins")
      return signIns.changed(actor.deviceId, request as InvokeRequest<"inf:work:sign-ins">[0]);
    return placed.answer(actor.deviceId, channel, request as InvokeRequest<typeof channel>[0]);
  }) as CoreDispatch;
  let connection: HomeConnection | undefined;
  const listen = async () => {
    connection = startConnection({
      dispatch,
      events: new CoreEventBus(),
      devices: options.pairing(),
      port: options.port,
      name: () => "MacBook Pro",
    });
    devices.attach(connection);
    await connection.settled();
  };
  const drop = async () => {
    const closing = connection;
    connection = undefined;
    await closing?.close();
  };
  let quitted = false;
  const quit = async () => {
    if (quitted) return;
    quitted = true;
    await supervisor.disposeAll();
    signIns.dispose();
    await integrations?.dispose();
    await drop();
    db.close();
  };
  return {
    tasks,
    repos,
    inbox,
    supervisor,
    placed,
    devices,
    signIns,
    setup,
    decisions,
    db,
    events,
    wakes,
    cards: () => cards,
    ...(integrations ? { integrations } : {}),
    paths,
    quit,
    drop,
    listen,
    settled: async () => {
      await connection?.settled();
    },
    outsideData,
  };
}

/** This Mac's own models as its accounts list them, one account per provider. */
function homeAccounts(available: readonly PiModelRef[]): AccountModels[] {
  const byProvider = new Map<string, PiModelRef[]>();
  for (const model of available)
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  return [...byProvider].map(([providerId, models]) => ({
    accountId: `acct_here_${providerId}`,
    accountLabel: providerId,
    providerId,
    models,
  }));
}
