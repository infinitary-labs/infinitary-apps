import { join } from "node:path";
import type { Card } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { devicePlace } from "@shared/signIns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startStubApi } from "../../../tests/helpers/anthropicDialect";
import { freePort } from "../../../tests/helpers/connectionClient";
import { manualClock } from "../../../tests/helpers/manualClock";
import { piStubRuntime } from "../../../tests/helpers/piStubRuntime";
import { homeWorkspace } from "../../../tests/helpers/placedHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  type SDKUserMessage,
  scriptedClaudeQuery,
} from "../../../tests/helpers/scriptedClaudeQuery";
import {
  HOME_CAPABILITIES,
  type InvokeRequest,
  isWorkInvokeChannel,
  PROTOCOL_VERSION,
  parseInvokeRequest,
} from "../../shared/ipc";
import { type AccountBackend, statusFromHealth } from "../accounts/accountBackend";
import { CredentialHealthService } from "../accounts/credentialHealthService";
import { CLAUDE_MODELS, claudeAvailableModels } from "../claude/claudeModels";
import { resetStoreLeasesForTest } from "../claude/claudeStoreLease";
import { CLAUDE_CONTROL_PROFILE, createClaudeSessionFactory } from "../claude/session";
import { type HomeConnection, startConnection } from "../connection/connection";
import { DeviceSignIns } from "../devices/deviceSignIns";
import { DevicePairing } from "../devices/pairing";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import type { ComputerAccounts } from "../helper/accounts";
import { bindHere, ownAccounts } from "../helper/conversations";
import { joinHome } from "../helper/join";
import { PlacedTasks } from "../helper/placedTasks";
import { type HelperRun, startHelper } from "../helper/run";
import { SessionHost } from "../helper/sessionHost";
import { startSignIns } from "../helper/signIns";
import { WorkingCopies } from "../helper/workingCopies";
import { jobExitWake } from "../jobs/jobManager";
import { createAccountStore } from "../models/accountStore";
import { CrewSupervisor } from "../orchestrator/crewSupervisor";
import type { TypedWake } from "../orchestrator/wakes";
import { appPathsFor } from "../paths";
import { AccountVault } from "../pi/accountVault";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import type { ModelRuntime } from "../pi/types";
import { buildModelsCatalog } from "../quota/catalog";
import type { QuotaService } from "../quota/quotaService";
import { AccountSelector } from "../routing/accountRouter";
import { Router } from "../routing/router";
import { SessionBinder } from "../session/binding";
import { CardStore } from "../storage/cardStore";
import { openDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { SettingsStore } from "../storage/settingsStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { WorkspaceService } from "../workspace/workspaceService";
import { PlacedSessions } from "./placedSessions";
import { WorkDevices } from "./workDevices";

/**
 * A task on a computer that runs work while that computer's own sign-in is
 * cut off waits there as a task on a cut-off account here waits
 * (docs/helper.md, "Its own sign-ins"; the captain's pick on FI3-1001): the
 * sign-in is skipped, the task is held - one sign-in card, no turn tried,
 * nothing set aside - and once that computer serves again its kept work goes
 * on by itself, with a task that waited for it starting there.
 *
 * The real placed path, as `createServices` composes it: at the home a real
 * `Router` routing a task there among that computer's own sign-ins, the
 * supervisor, `PlacedSessions`, `DeviceSignIns`, the connection and the
 * pairing; on the computer the real helper joined through the real pairing,
 * its `SessionHost` and `SignInHost` over a vault of its own, and a real
 * Claude session on a scripted client, whose own classifier makes the
 * cut-off. One manual clock runs both sides, ticked as the watchdog ticks.
 */

// Integration (docs/test-cohorts.md): real git makes each side's workspace,
// and every turn crosses the connection. The slowest case took 1.7 s at its
// fastest of three runs on an Apple silicon Mac, so the file keeps 10 s; a
// poll waits up to 4 s for work that crosses the connection.
vi.setConfig({ testTimeout: 10_000, expect: { poll: { timeout: 4_000 } } });

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

const MINUTE = 60_000;

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  resetStoreLeasesForTest();
});

/** One clock for the home's supervisor, record and inbox, and the computer's vault. */
function sharedClock() {
  let t = Math.floor(Date.now() / 1000) * 1000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}
type Clock = ReturnType<typeof sharedClock>;

/**
 * A Claude credential that reads healthy, with no keychain. Signing in
 * again there writes the credential anew, which its next read sees.
 */
function claudeCredential(login: string) {
  let written = 1;
  const backend: AccountBackend = {
    id: "claude",
    authTypes: () => ["oauth"],
    login: async () => {},
    logout: async () => undefined,
    health: async () => ({
      state: "healthy",
      authType: "oauth",
      stamp: { login, written: `file:${written}`, client: "2.1.234" },
    }),
    renew: async () => ({ outcome: "renewed" }),
    status: async () => statusFromHealth({ state: "healthy", authType: "oauth" }),
    binding: () => ({ via: "default-login" }),
  };
  return {
    backend,
    signInAgain: () => {
      written += 1;
    },
  };
}

const bridge = { prompt: async () => "answer", notify: () => {}, openExternal: async () => {} };

type Play = { kind: "ok" } | { kind: "signed_out" } | { kind: "no_headroom"; resetsAtMs: number };

/** The Claude client there, whose play is read per turn; every turn that reaches it is counted. */
function scriptedClaude() {
  let play: () => Play = () => ({ kind: "ok" });
  const turns: { kind: Play["kind"]; text: string }[] = [];
  const result = (text: string, failed = false) => ({
    type: "result",
    subtype: "success",
    is_error: failed,
    result: text,
    total_cost_usd: 0.001,
    modelUsage: {
      "claude-haiku-4-5": {
        inputTokens: 300,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  });
  const started = (emit: (message: unknown) => void) =>
    emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { usage: { input_tokens: 300 } } },
    });
  const { factory, attachments } = scriptedClaudeQuery({
    onInput: (message: SDKUserMessage, emit) => {
      const attachment = attachments.find((entry) => entry.emit === emit);
      const rolling = attachment?.options.extraArgs?.["replay-user-messages"] === null;
      if (rolling) {
        emit({ type: "system", subtype: "session_state_changed", state: "running" });
        emit({
          type: "user",
          isReplay: true,
          uuid: message.uuid,
          message: message.message,
          parent_tool_use_id: null,
        });
      }
      const playing = play();
      const content = (message.message as { content?: unknown }).content;
      turns.push({
        kind: playing.kind,
        text: typeof content === "string" ? content : JSON.stringify(content ?? ""),
      });
      void Promise.resolve().then(() => {
        if (playing.kind === "signed_out") {
          emit({ type: "assistant", message: { content: [] }, error: "authentication_failed" });
          emit(result("Invalid API key - Please run /login", true));
        } else if (playing.kind === "no_headroom") {
          started(emit);
          emit({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              resetsAt: Math.floor(playing.resetsAtMs / 1000),
              rateLimitType: "five_hour",
            },
          });
          emit({ type: "assistant", message: { content: [] }, error: "rate_limit" });
          emit(result("Claude usage limit reached.", true));
        } else {
          started(emit);
          emit(result("All done."));
        }
        if (rolling) emit({ type: "system", subtype: "session_state_changed", state: "idle" });
      });
    },
  });
  return {
    query: factory,
    turns,
    play: (next: Play | (() => Play)) => {
      play = typeof next === "function" ? next : () => next;
    },
  };
}

/** The Claude models this build's provider-wide catalog lists, as `createServices` hands `catalogModels`. */
const CLAUDE_CATALOG = CLAUDE_MODELS.map((model) => ({
  provider: CLAUDE_PROVIDER_ID,
  id: model.id,
  name: model.name,
}));

/** This Mac, as `createServices` composes the crew for a computer that runs work. */
function startHome(options: {
  userData: string;
  port: number;
  pairing: () => DevicePairing;
  clock: Clock;
  piRuntime: ModelRuntime;
}) {
  const now = options.clock.now;
  const db = openDatabase(options.userData);
  const paths = appPathsFor(options.userData);
  const tasks = new TaskService({ db, now });
  const inbox = new InboxStore(db, { now });
  const repos = new RepoRegistry(db, paths.fleetDir);
  const devices = new WorkDevices();
  // This Mac's own Claude sign-in, which serves its Firstmate and crew here.
  const vault = AccountVault.create(paths, {
    backends: [claudeCredential("this-mac-login").backend],
    modelsForAccount: ({ providerId }) =>
      providerId === CLAUDE_PROVIDER_ID ? claudeAvailableModels() : [],
  });
  const decisions = new DecisionStore(db);
  const selector = new AccountSelector({
    pool: vault,
    quota: { latest: () => undefined },
    flagshipAccountId: () => null,
    decisions,
  });
  const binder = new SessionBinder({
    runtimeFor: (accountId) => vault.runtimeFor(accountId),
    baseRuntime: options.piRuntime,
  });
  const events: FmEvent[] = [];
  const wakes: TypedWake[] = [];
  let cards: Card[] = [];
  const noteCutOff = vi.fn((accountId: string, cutOff: Parameters<AccountVault["noteCutOff"]>[1]) =>
    vault.noteCutOff(accountId, cutOff),
  );
  let signInsChanged: () => void = () => {};
  const signIns = new DeviceSignIns({
    devices: () => options.pairing().list(),
    work: devices,
    emit: () => {},
    broadcastEvent: (event) => events.push(event),
    changed: () => signInsChanged(),
  });
  const placed = new PlacedSessions({
    tasks,
    paths,
    devices,
    profiles: { pi: PI_CONTROL_PROFILE, claude: CLAUDE_CONTROL_PROFILE },
    deviceName: () => "Mac mini",
    devicePlace: (deviceId) => devicePlace(options.pairing().list(), deviceId),
    projectName: (repoId) => repos.get(repoId)?.name,
    homeRepo: async (repoId) =>
      repoId
        ? repos.get(repoId)?.path
        : await new WorkspaceService(paths, { pool: false }).ensureDefaultRepo(),
    projects: () => repos.list().map((repo) => repo.id),
    signIns: (deviceId) => signIns.signInsOf(deviceId),
    saidSignIns: (deviceId) => signIns.lastSaid(deviceId),
    refreshSignIns: (deviceId) => signIns.refresh(deviceId),
    catalogModels: () => CLAUDE_CATALOG,
    broadcastEvent: (event) => events.push(event),
    now,
    log: () => {},
  });
  // This Mac's own models, with its allowance unread, as its quota catalog lists them.
  const router = new Router({
    quota: {
      latestModels: () => ({
        generatedAt: new Date(now()).toISOString(),
        models: buildModelsCatalog(
          CLAUDE_CATALOG.filter((model) =>
            vault
              .availableModels()
              .some((entry) => entry.provider === model.provider && entry.id === model.id),
          ),
          [],
          new Date(now()).toISOString(),
          now(),
        ).models,
      }),
    } as unknown as QuotaService,
    settings: new SettingsStore(db),
    decisions,
    availableModels: () => vault.availableModels(),
  });
  const nothingHere = {
    open: async () => {
      throw new Error("Nothing runs on this Mac here.");
    },
  };
  const supervisor = new CrewSupervisor({
    sessions: {
      pi: { ...nothingHere, backend: "pi", controlProfile: PI_CONTROL_PROFILE },
      claude: { ...nothingHere, backend: "claude", controlProfile: CLAUDE_CONTROL_PROFILE },
    },
    machines: placed,
    bind: async (accountId, providerId) =>
      accountId
        ? binder.bindAccount(accountId, providerId ?? vault.get(accountId)?.providerId)
        : binder.base(),
    workspace: homeWorkspace(paths),
    repos,
    tasks,
    cardStore: new CardStore(db),
    inbox,
    router,
    accounts: selector,
    noteCutOff,
    serveability: {
      cutOff: (accountId) => vault.cutOff(accountId),
      providerName: () => "Claude",
    },
    paths,
    now,
    broadcastEvent: (event) => events.push(event),
    broadcastCards: (snapshot) => {
      cards = snapshot;
    },
  });
  signInsChanged = () => supervisor.reconcileCutOffs();
  // The Firstmate's own notifyOp: a wake rides the durable inbox, where a
  // `once` name and the content dedupe drop a repeat.
  supervisor.setFirstmateHooks({
    notifyOp: (wake, origin, ref) => {
      if (typeof wake === "string") return;
      if (inbox.enqueueWake(FIRSTMATE_RECIPIENT, wake, origin, ref) !== null) wakes.push(wake);
    },
    retryConverse: () => {},
  });
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
    if (channel === "inf:work:sign-in")
      return signIns.step(actor.deviceId, request as InvokeRequest<"inf:work:sign-in">[0]);
    if (channel === "inf:work:sign-ins")
      return signIns.changed(actor.deviceId, request as InvokeRequest<"inf:work:sign-ins">[0]);
    return placed.answer(actor.deviceId, channel, request as InvokeRequest<typeof channel>[0]);
  }) as CoreDispatch;
  let connection: HomeConnection | undefined;
  return {
    tasks,
    inbox,
    supervisor,
    vault,
    selector,
    noteCutOff,
    events,
    wakes,
    cards: () => cards,
    /** The Firstmate's turn consumed its lane, as its turn's end does. */
    drainFirstmate: () => inbox.ack(inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.id)),
    ready: (deviceId: string) => placed.ready(deviceId, "none"),
    listen: async () => {
      connection = startConnection({
        dispatch,
        events: new CoreEventBus(),
        devices: options.pairing(),
        port: options.port,
        name: () => "MacBook Pro",
      });
      devices.attach(connection);
      await connection.settled();
    },
    settled: async () => connection?.settled(),
    quit: async () => {
      await supervisor.disposeAll();
      signIns.dispose();
      await connection?.close();
      db.close();
    },
  };
}

/** This Mac and the Mac mini joined to it, the Mac mini signed in to its own Claude. */
async function world() {
  const clock = sharedClock();
  const claude = scriptedClaude();
  const api = await startStubApi(() => true);
  stops.push(() => api.close());
  const piRuntime = await piStubRuntime(api.url, { provider: "fm-placed", id: "stub-1" });
  const userData = scratchDir("infinitary-placed-cutoff-home-");
  let pairing: DevicePairing | undefined;
  const pairingNow = () => {
    pairing ??= new DevicePairing({
      dir: join(userData, "devices"),
      onProblem: () => {},
      interfaces: () => ({}),
      ownUid: 501,
    });
    return pairing;
  };
  stops.push(() => pairing?.dispose());
  const port = await freePort();
  let home = startHome({ userData, port, pairing: pairingNow, clock, piRuntime });
  stops.push(() => home.quit());
  await home.listen();
  // Another Mac, as a Mac added by its address is found to be.
  const { link } = pairingNow().invite(
    { kind: "work", at: `127.0.0.1:${port}` },
    { locality: "elsewhere" },
  );
  await home.settled();
  const dataDir = scratchDir("infinitary-placed-cutoff-computer-");
  const joined = await joinHome({
    text: link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: { name: "kun", uid: 502 } },
    timeoutMs: 2_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const deviceId = joined.grant.deviceId;
  // The Mac mini's own Claude sign-in, on the shared clock, before its helper
  // starts, in the store `startComputerAccounts` builds: until its Claude
  // Code's list is read, the account serves Claude's shipped list.
  const credential = claudeCredential("mac-mini-login");
  const { vault: computerVault } = createAccountStore(
    { accountsDir: join(dataDir, "accounts") },
    {
      backends: [credential.backend],
      now: clock.now,
      packaged: false,
      claudeConfigDir: () => join(dataDir, "claude-config"),
      rail: "home",
    },
  );
  const account = await computerVault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
  await computerVault.status(account.id, { refresh: true });
  const computerAccounts: ComputerAccounts = {
    vault: computerVault,
    providers: () => [],
    allowance: () => null,
    readAllowance: async () => null,
    close: () => {},
  };
  // Its minute's health read, as `startComputerAccounts` composes it.
  const computerHealth = new CredentialHealthService({
    host: {
      listEnabled: () => computerVault.list().map((entry) => ({ accountId: entry.id })),
      health: (accountId) => computerVault.health(accountId, { refresh: true }),
      renew: (accountId, reason) => computerVault.renew(accountId, reason),
    },
    now: clock.now,
  });
  const own = { vault: computerVault };
  // What it tells the home of its sign-ins unasked can come late - its
  // Claude Code's own status read is slow - so a test can hold it back.
  let late: Promise<void> | undefined;
  let run: HelperRun | undefined;
  const started = startHelper({
    dataDir,
    say: () => {},
    retryMs: [20],
    // Its real SignInHost answers the home from this vault.
    signIns: (start) =>
      startSignIns({
        ...start,
        tell: async (channel, args) => {
          if (channel === "inf:work:sign-ins") await late;
          return start.tell(channel, args);
        },
        accounts: async () => computerAccounts,
        forges: () => ({
          view: () => ({ signIns: [], hosts: [] }),
          start: async () => {},
          cancel: () => {},
          signOut: () => {},
          checkHealth: async () => {},
          close: () => {},
        }),
      }),
    conversations: async ({ dataDir: dir, ask }) => {
      const copies = new WorkingCopies(dir, { pool: false });
      const host = new SessionHost({
        tasks: new PlacedTasks(dir, copies.worktreesDir),
        copies,
        ask,
        factories: {
          claude: createClaudeSessionFactory({
            configDir: join(dir, "claude-config"),
            env: () => ({ PATH: "/usr/bin", HOME: dir }),
            checkClient: async () => ({ state: "ready", executable: "/usr/local/bin/claude" }),
            query: claude.query,
            clock: manualClock(),
          }),
        },
        bind: (binding) => bindHere(binding, own),
        accounts: ownAccounts(
          async () => own,
          () => {},
        ),
        log: () => {},
      });
      return { host, close: () => host.close() };
    },
  });
  if (!started.ok) throw new Error(started.reason);
  run = started.run;
  stops.push(() => run?.stop());
  await expect.poll(() => home.ready(deviceId)).toBe(true);
  // This Mac's own Claude sign-in.
  const here = await home.vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
  await home.vault.status(here.id, { refresh: true });

  /**
   * Waits for every turn in flight to end, after a turn may have started.
   * A task a start claimed reads "starting" until its first turn begins,
   * which waits for the Mac mini's answer to installing its working copy
   * (`prepareFirstTurn`), so that turn is in flight too: on a slow runner
   * that answer comes later than any fixed wait (INF-696).
   */
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    await expect
      .poll(() =>
        home.tasks
          .listActive()
          .every((record) => record.activity !== "starting" && record.activity !== "running"),
      )
      .toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  /** One watchdog tick at the clock's new time, as `startWatchdog` registers them. */
  const tick = async (ms: number) => {
    clock.advance(ms);
    const now = clock.now();
    home.supervisor.checkQuietTasks(now);
    home.supervisor.reconcileIdle(now);
    await home.supervisor.sweepGates(now);
    await home.supervisor.sweepInbox(now);
    await settle();
    home.drainFirstmate();
  };
  return {
    get home() {
      return home;
    },
    /**
     * Firstmate here quits and starts again over the same folder: its boot
     * hears the cut-offs first (`reconcileCutOffs`), before the Mac mini is
     * back in reach.
     */
    restartHome: async () => {
      await home.quit();
      pairing?.dispose();
      pairing = undefined;
      home = startHome({ userData, port, pairing: pairingNow, clock, piRuntime });
      home.supervisor.reconcileCutOffs();
      await home.listen();
    },
    clock,
    claude,
    deviceId,
    computerVault,
    computerAccount: account.id,
    thisMacAccount: here.id,
    settle,
    tick,
    /** Ticks every `step` for `total`. */
    ticks: async (total: number, step = MINUTE) => {
      for (let elapsed = 0; elapsed < total; elapsed += step) await tick(step);
    },
    /** A queued task for the Mac mini, dispatched now. */
    dispatch: async (id: string, title: string, prompt: string) => {
      seedTask(home.tasks, { id, title, prompt, status: "queued", deviceId });
      await home.supervisor.dispatchQueuedTask(id);
      await settle();
    },
    /** Holds back what the Mac mini tells unasked of its sign-ins until the returned call. */
    reportsLate: () => {
      let release = () => {};
      late = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        late = undefined;
      };
    },
    /** Claude Code on the Mac mini is signed in again, and that Mac's minute read sees it. */
    signInThere: async () => {
      credential.signInAgain();
      await computerHealth.tick();
    },
  };
}

type World = Awaited<ReturnType<typeof world>>;

function kinds(at: World): string[] {
  return at.home.wakes.map((wake) => (wake.facts as { kind: string }).kind);
}

function feed(at: World): string[] {
  return at.home.events.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : []));
}

function signInCards(at: World): string[] {
  return at.home
    .cards()
    .filter((card) => card.id.startsWith("card-auth-"))
    .map((card) => card.id);
}

/** Which task's work each answered turn there carried, in order: the footer's or the header's. */
function answered(at: World): string[] {
  return at.claude.turns
    .filter((turn) => turn.kind === "ok")
    .map((turn) => (turn.text.includes("Fix the footer.") ? "Fix the footer." : "Fix the header."));
}

function postureOf(at: World, taskId: string) {
  const record = at.home.tasks.get(taskId);
  if (!record) throw new Error(`No record for ${taskId}.`);
  return at.home.supervisor.workPosture(record);
}

/** What this Mac's own Claude account serves for its Firstmate and crew. */
function servingHere(at: World) {
  return {
    cutOff: at.home.vault.cutOff(at.thisMacAccount)?.class ?? null,
    serves: at.home.vault.servesSync(at.thisMacAccount),
    selected: at.home.selector.selectForSpawn("t-local-probe", CLAUDE_PROVIDER_ID),
  };
}

describe("a task on another Mac while that Mac's own sign-in is cut off", () => {
  it("signed out there: held with one card, a second task waits, and both go on by themselves once signed in there", async () => {
    const at = await world();
    const { home } = at;
    const before = servingHere(at);

    // The first task's turn meets the lost sign-in there, and what the Mac
    // mini tells unasked of it comes late: the home asks it before the turn ends.
    const onTime = at.reportsLate();
    at.claude.play({ kind: "signed_out" });
    await at.dispatch("t1", "website footer", "Fix the footer.");
    expect(at.claude.turns).toHaveLength(1);
    await expect.poll(() => home.tasks.get("t1")?.activity).toBe("idle");
    const t1 = home.tasks.get("t1");
    if (!t1) throw new Error("The task has no record.");
    // It is held on the Mac mini's own Claude, and the waiting line says where.
    expect(home.supervisor.workPosture(t1)).toEqual({
      state: "paused",
      reason: "access",
      hold: { class: "signed_out", provider: "Claude", where: "on Mac mini" },
    });
    // One sign-in card, and the Firstmate hears the cut-off once, for the account.
    await expect.poll(() => signInCards(at)).toEqual(["card-auth-t1"]);
    expect(kinds(at)).toEqual(["queued-started", "provider-cut-off"]);
    expect(home.wakes.at(-1)?.facts).toMatchObject({
      kind: "provider-cut-off",
      provider: "Claude on Mac mini",
      class: "signed_out",
      tasks: [{ id: "t1", title: "website footer" }],
    });

    // A second task for the Mac mini waits for that sign-in and tries nothing there.
    await at.dispatch("t2", "website header", "Fix the header.");
    expect(home.tasks.get("t2")?.status).toBe("open");
    expect(at.claude.turns).toHaveLength(1);
    expect(signInCards(at)).toEqual(["card-auth-t1"]);
    expect(feed(at)).toContain(
      "website header's next task waits for Mac mini's own Claude sign-in.",
    );
    expect(await home.supervisor.startQueuedNow("t2")).toContain(
      "waits for Mac mini's own Claude sign-in",
    );

    // Two hours with the card up, the card closed, two hours more: nothing is
    // tried, nothing is set aside, and the closed card does not come back.
    await at.ticks(120 * MINUTE, 5 * MINUTE);
    home.supervisor.close("card-auth-t1");
    await at.settle();
    await at.ticks(120 * MINUTE, 5 * MINUTE);
    expect(at.claude.turns).toHaveLength(1);
    await expect.poll(() => signInCards(at)).toEqual([]);
    expect(kinds(at)).toEqual(["queued-started", "provider-cut-off"]);
    expect(home.tasks.get("t2")?.status).toBe("open");
    // The captain's word meanwhile is kept for it.
    expect(await home.supervisor.steerCrewmate("t1", "Also fix the header.", "captain")).toBe(
      "recorded-held",
    );
    expect(at.claude.turns).toHaveLength(1);

    // Signed in again on the Mac mini: its kept work goes on by itself as one
    // turn, and the task that waited starts there.
    at.claude.play({ kind: "ok" });
    onTime();
    await at.signInThere();
    await expect.poll(() => answered(at)).toEqual(["Fix the footer."]);
    // The task that waited starts at the next tick's ready sweep.
    await at.tick(MINUTE);
    await expect.poll(() => answered(at)).toEqual(["Fix the footer.", "Fix the header."]);
    await at.settle();
    expect(postureOf(at, "t1").state).not.toBe("paused");
    expect(kinds(at)).toContain("provider-back");
    expect(home.wakes.find((wake) => wake.facts.kind === "provider-back")?.facts).toMatchObject({
      provider: "Claude on Mac mini",
      tasks: [{ id: "t1", title: "website footer" }],
    });
    const resumed = at.claude.turns.slice(1).filter((turn) => turn.text.includes("Fix the footer"));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.text).toContain("Also fix the header.");
    expect(at.claude.turns.filter((turn) => turn.text.includes("Fix the header."))).toHaveLength(1);
    expect(feed(at)).toContain("website header's next task started on Mac mini.");
    expect(home.tasks.get("t2")?.deviceId).toBe(at.deviceId);

    // This Mac's own Claude served throughout, and holds nothing of it.
    expect(servingHere(at)).toEqual(before);
    expect(home.noteCutOff).not.toHaveBeenCalled();
  });

  it("Firstmate here restarts: the task stays held, nothing is called over before the Mac mini says so, and it goes on once signed in there", async () => {
    const at = await world();
    at.claude.play({ kind: "signed_out" });
    await at.dispatch("t1", "website footer", "Fix the footer.");
    await expect.poll(() => postureOf(at, "t1").state).toBe("paused");

    // What the Mac mini tells unasked as it comes back comes late: the home
    // asks it before the held lane could go on there.
    const onTime = at.reportsLate();
    await at.restartHome();
    // Its boot heard nothing over: the Mac mini had said nothing yet.
    expect(kinds(at)).toEqual([]);
    await expect.poll(() => at.home.ready(at.deviceId)).toBe(true);
    await at.ticks(30 * MINUTE, 5 * MINUTE);
    expect(at.claude.turns).toHaveLength(1);
    expect(postureOf(at, "t1")).toMatchObject({
      state: "paused",
      hold: { class: "signed_out", where: "on Mac mini" },
    });
    // Told once, before the restart, and not again; its one card still up.
    expect(kinds(at)).toEqual([]);
    await expect.poll(() => signInCards(at)).toEqual(["card-auth-t1"]);
    // A task for it now waits for that sign-in too.
    await at.dispatch("t2", "website header", "Fix the header.");
    expect(at.home.tasks.get("t2")?.status).toBe("open");
    expect(at.claude.turns).toHaveLength(1);

    at.claude.play({ kind: "ok" });
    onTime();
    await at.signInThere();
    await expect.poll(() => answered(at)).toEqual(["Fix the footer."]);
    await at.tick(MINUTE);
    await expect.poll(() => answered(at)).toEqual(["Fix the footer.", "Fix the header."]);
    expect(kinds(at)).toContain("provider-back");
    // Nothing is left to sign in to, so its sign-in card is gone.
    await expect.poll(() => signInCards(at)).toEqual([]);
  });

  it("out of allowance there: held until its reset, and then goes on by itself with the task that waited", async () => {
    const at = await world();
    const { home } = at;
    const resetsAtMs = at.clock.now() + 60 * MINUTE;
    at.claude.play(() =>
      at.clock.now() < resetsAtMs ? { kind: "no_headroom", resetsAtMs } : { kind: "ok" },
    );
    await at.dispatch("t1", "website footer", "Fix the footer.");
    await expect.poll(() => home.tasks.get("t1")?.activity).toBe("idle");
    const t1 = home.tasks.get("t1");
    if (!t1) throw new Error("The task has no record.");
    expect(home.supervisor.workPosture(t1).hold).toEqual({
      class: "no_headroom",
      provider: "Claude",
      resetsAt: resetsAtMs,
      where: "on Mac mini",
    });
    await at.dispatch("t2", "website header", "Fix the header.");
    expect(home.tasks.get("t2")?.status).toBe("open");
    expect(feed(at).join("\n")).toContain("Mac mini's Claude plan's allowance");
    expect(feed(at).join("\n")).not.toContain("own Claude sign-in");
    expect(await home.supervisor.startQueuedNow("t2")).toContain("plan's allowance");

    // Nothing goes there before the reset; at it, both go on by themselves.
    await at.ticks(55 * MINUTE, 5 * MINUTE);
    await at.ticks(4 * MINUTE);
    expect(at.claude.turns).toHaveLength(1);
    expect(home.tasks.get("t2")?.status).toBe("open");
    await at.ticks(2 * MINUTE);
    await expect.poll(() => answered(at)).toEqual(["Fix the footer.", "Fix the header."]);
    await at.settle();
    expect(postureOf(at, "t1").state).not.toBe("paused");
    expect(kinds(at).filter((kind) => kind.startsWith("provider-"))).toEqual([
      "provider-cut-off",
      "provider-back",
    ]);
    expect(home.noteCutOff).not.toHaveBeenCalled();
  });
});
