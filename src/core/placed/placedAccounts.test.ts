import { join } from "node:path";
import type { CutOff } from "@shared/authFailure";
import type { Card } from "@shared/cards";
import type { FmEvent } from "@shared/events";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { type ComputerSignIns, devicePlace } from "@shared/signIns";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  startStubApi,
  writeAnthropicText,
} from "../../../tests/helpers/anthropicDialect";
import { claimedPort } from "../../../tests/helpers/claimedPort";
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
  isWorkInvokeChannel,
  PROTOCOL_VERSION,
  parseInvokeRequest,
} from "../../shared/ipc";
import { type AccountBackend, statusFromHealth } from "../accounts/accountBackend";
import { claudeAvailableModels } from "../claude/claudeModels";
import { CLAUDE_CONTROL_PROFILE } from "../claude/claudeQueryCore";
import { resetStoreLeasesForTest } from "../claude/claudeStoreLease";
import { createClaudeSessionFactory } from "../claude/session";
import { type HomeConnection, startConnection } from "../connection/connection";
import { DevicePairing } from "../devices/pairing";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { bindHere, ownAccounts } from "../helper/conversations";
import { joinHome } from "../helper/join";
import { PlacedTasks } from "../helper/placedTasks";
import { type HelperRun, startHelper } from "../helper/run";
import { SessionHost } from "../helper/sessionHost";
import { WorkingCopies } from "../helper/workingCopies";
import { jobExitWake } from "../jobs/jobManager";
import { CrewSupervisor } from "../orchestrator/crewSupervisor";
import type { AccountAttachment } from "../orchestrator/crewSupervisorOptions";
import { Flagship } from "../orchestrator/flagship";
import type { TypedWake } from "../orchestrator/wakes";
import { appPathsFor } from "../paths";
import { AccountVault } from "../pi/accountVault";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import { createPiSessionFactory } from "../pi/sessionFactory";
import type { ModelRuntime } from "../pi/types";
import { AccountSelector } from "../routing/accountRouter";
import type { Router } from "../routing/router";
import { SessionBinder } from "../session/binding";
import type { SessionBinding } from "../session/session";
import { CardStore } from "../storage/cardStore";
import { openDatabase } from "../storage/db";
import { DecisionStore } from "../storage/decisionStore";
import { InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { WorkspaceService } from "../workspace/workspaceService";
import { PlacedSessions } from "./placedSessions";
import { WorkDevices } from "./workDevices";

/**
 * A task on a computer that runs work meets a typed cut-off, or spends
 * tokens, on that computer's own sign-in, and the fact and the usage are
 * that computer's, never this Mac's (docs/helper.md, "Its own sign-ins"):
 * this Mac's Firstmate and crew keep serving from its own subscription.
 *
 * The real placed path: at the home, the supervisor, `PlacedSessions`, the
 * connection and the pairing as `createServices` composes them, with this
 * Mac's own account wiring - a real `AccountVault` on a stand-in Claude
 * credential (no keychain), the real `AccountSelector` and `SessionBinder`,
 * `noteCutOff` and serveability from the vault. Only the router is a stand-in.
 * On the computer, the real helper joined through the real pairing, its
 * `SessionHost` binding with the real `bindHere` and `ownAccounts` over a
 * vault of its own, and a real Claude session on a scripted client, whose own
 * classifier makes the cut-off that crosses the connection.
 */

// Integration (docs/test-cohorts.md): real git makes each side's workspace,
// and every turn crosses the connection. The slowest case took 0.34 s at its
// fastest of three runs on an Apple silicon Mac, so the file keeps vitest's
// 5 s default; a poll waits for work that crosses the connection for the
// rest of that budget (tests/helpers/waitWindow.ts).

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

const HAIKU = "claude-haiku-4-5";

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  resetStoreLeasesForTest();
});

/** A Claude credential that reads healthy, with its own login's stamp, and no keychain. */
function claudeCredential(login: string): AccountBackend {
  return {
    id: "claude",
    authTypes: () => ["oauth"],
    login: async () => {},
    logout: async () => undefined,
    health: async () => ({
      state: "healthy",
      authType: "oauth",
      stamp: { login, written: "file:1", client: "2.1.234" },
    }),
    renew: async () => ({ outcome: "renewed" }),
    status: async () => statusFromHealth({ state: "healthy", authType: "oauth" }),
    binding: () => ({ via: "default-login" }),
  };
}

const bridge = { prompt: async () => "answer", notify: () => {}, openExternal: async () => {} };

type Play = { kind: "ok" } | { kind: "signed_out" } | { kind: "no_headroom"; resetsAtMs: number };

/** The Claude client on the computer, scripted in the message shapes the real one sends. */
function scriptedClaude() {
  let play: Play = { kind: "ok" };
  const result = (text: string, failed = false) => ({
    type: "result",
    subtype: "success",
    is_error: failed,
    result: text,
    total_cost_usd: 0.001,
    modelUsage: {
      [HAIKU]: {
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
      const playing = play;
      void Promise.resolve().then(() => {
        if (playing.kind === "signed_out") {
          // The client's own typed refusal of a lapsed login.
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
    play: (next: Play) => {
      play = next;
    },
  };
}

/** This Mac, composed as `createServices` composes the crew, with its own account vault. */
function startHome(options: {
  userData: string;
  port: number;
  pairing: () => DevicePairing;
  routedTo: { provider: string; id: string };
  piRuntime: ModelRuntime;
  /** Absent: the real `AccountSelector` over this Mac's vault, and the real `SessionBinder`. */
  accounts?: AccountAttachment;
  bind?: (accountId: string | undefined, providerId?: string) => Promise<SessionBinding>;
  /** What the computer last said of its own sign-ins, as `DeviceSignIns` hears it. */
  signIns: (deviceId: string) => Promise<ComputerSignIns | null>;
}) {
  const now = () => Date.now();
  const db = openDatabase(options.userData);
  const paths = appPathsFor(options.userData);
  const tasks = new TaskService({ db, now });
  const inbox = new InboxStore(db, { now });
  const repos = new RepoRegistry(db, paths.fleetDir);
  const devices = new WorkDevices();
  const vault = AccountVault.create(paths, {
    backends: [claudeCredential("this-mac-login")],
    modelsForAccount: ({ providerId }) =>
      providerId === CLAUDE_PROVIDER_ID ? claudeAvailableModels() : [],
  });
  const selector = new AccountSelector({
    pool: vault,
    quota: { latest: () => undefined },
    flagshipAccountId: () => null,
    decisions: new DecisionStore(db),
  });
  const binder = new SessionBinder({
    runtimeFor: (accountId) => vault.runtimeFor(accountId),
    baseRuntime: options.piRuntime,
  });
  const events: FmEvent[] = [];
  const wakes: TypedWake[] = [];
  let cards: Card[] = [];
  const noteCutOff = vi.fn((accountId: string, cutOff: CutOff) =>
    vault.noteCutOff(accountId, cutOff),
  );
  const recordUsage = vi.fn();
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
    signIns: options.signIns,
    broadcastEvent: (event) => events.push(event),
    now,
    log: () => {},
  });
  const nothingHere = {
    open: async () => {
      throw new Error("Nothing runs on this Mac here.");
    },
  };
  const router = {
    decide: () => ({ choice: options.routedTo, bucket: "high" as const, rule: "R8" as const }),
    servedProvider: () => options.routedTo.provider,
    modelLabel: (ref: { provider: string; id: string }) => ref.id,
  } as unknown as Router;
  const supervisor = new CrewSupervisor({
    sessions: {
      pi: { ...nothingHere, backend: "pi", controlProfile: PI_CONTROL_PROFILE },
      claude: { ...nothingHere, backend: "claude", controlProfile: CLAUDE_CONTROL_PROFILE },
    },
    machines: placed,
    // The crew's bind as `createServices` writes it.
    bind:
      options.bind ??
      (async (accountId, providerId) =>
        accountId
          ? binder.bindAccount(accountId, providerId ?? vault.get(accountId)?.providerId)
          : binder.base()),
    workspace: homeWorkspace(paths),
    repos,
    tasks,
    cardStore: new CardStore(db),
    inbox,
    router,
    accounts: options.accounts ?? selector,
    noteCutOff,
    serveability: {
      cutOff: (accountId) => vault.cutOff(accountId),
      providerName: () => "Claude",
    },
    recordUsage,
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
  placed.serve({
    adopt: (taskId) => supervisor.adoptPlaced(taskId),
    caughtUp: (taskIds) => supervisor.placedCaughtUp(taskIds),
    jobExit: (taskId, exit) =>
      supervisor.watch.deliverJobResult(taskId, jobExitWake(exit, "crewmate")),
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
    return placed.answer(actor.deviceId, channel, request);
  }) as CoreDispatch;
  let connection: HomeConnection | undefined;
  return {
    tasks,
    placed,
    supervisor,
    vault,
    selector,
    noteCutOff,
    recordUsage,
    events,
    wakes,
    cards: () => cards,
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
      await connection?.close();
      db.close();
    },
  };
}

type ComputerVault = Parameters<typeof bindHere>[1];

/** This Mac and a computer joined to it, holding conversations with its own sign-ins. */
async function world(options: {
  routedTo: { provider: string; id: string };
  piRuntime: ModelRuntime;
  computerFactories: (dir: string) => ConstructorParameters<typeof SessionHost>[0]["factories"];
  /** The computer's own sign-ins, in its data folder once it joined. */
  computerVault: (dataDir: string) => Promise<NonNullable<ComputerVault>>;
  accounts?: AccountAttachment;
  bind?: (accountId: string | undefined, providerId?: string) => Promise<SessionBinding>;
}) {
  const userData = scratchDir("infinitary-placed-accounts-home-");
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
  const port = await claimedPort();
  let computer: NonNullable<ComputerVault> | undefined;
  const home = startHome({
    userData,
    port,
    pairing: pairingNow,
    routedTo: options.routedTo,
    piRuntime: options.piRuntime,
    // The computer's account rows, as it tells them home (`SignInHost`).
    signIns: async () =>
      computer ? { providers: [], accounts: await computer.vault.views(), quota: null } : null,
    ...(options.accounts ? { accounts: options.accounts } : {}),
    ...(options.bind ? { bind: options.bind } : {}),
  });
  stops.push(home.quit);
  await home.listen();
  const { link } = pairingNow().invite({ kind: "work", at: `127.0.0.1:${port}` });
  await home.settled();
  const dataDir = scratchDir("infinitary-placed-accounts-computer-");
  const joined = await joinHome({
    text: link,
    dataDir,
    io: { say: () => {}, ask: async () => "yes" },
    device: { name: "Mac mini", user: { name: "builder", uid: 502 } },
    timeoutMs: 2_000,
  });
  if (!joined.ok) throw new Error(joined.reason);
  const deviceId = joined.grant.deviceId;
  computer = await options.computerVault(dataDir);
  const own = computer;
  /** The account each binding there resolved to, with the one this Mac described. */
  const bound: { described?: string | undefined; resolved?: string | undefined }[] = [];
  let run: HelperRun | undefined;
  const started = startHelper({
    dataDir,
    say: () => {},
    retryMs: [20],
    conversations: async ({ dataDir: dir, ask }) => {
      const copies = new WorkingCopies(dir, { pool: false });
      const host = new SessionHost({
        tasks: new PlacedTasks(dir, copies.worktreesDir),
        copies,
        ask,
        factories: options.computerFactories(dir),
        bind: async (binding) => {
          const resolved = await bindHere(binding, own);
          bound.push({ described: binding.accountId, resolved: resolved.accountId });
          return resolved;
        },
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
  await expect.poll(() => home.placed.ready(deviceId, "none")).toBe(true);
  return {
    home,
    deviceId,
    bound,
    /** How this Mac's words place the computer: "on Mac mini", or "as Builder" for another user here. */
    where: () => devicePlace(pairingNow().list(), deviceId).where,
    /** A queued task placed on the computer, started now that it is in reach. */
    start: async (id: string) => {
      seedTask(home.tasks, {
        id,
        title: "website",
        prompt: "Fix the footer.",
        status: "queued",
        deviceId,
      });
      await home.supervisor.starts.dispatchQueuedTask(id);
      expect(home.tasks.get(id)?.status).toBe("active");
    },
  };
}

/** What this Mac's own Claude account serves for its Firstmate and crew. */
function servingHere(vault: AccountVault, accountId: string) {
  const flagship = new Flagship({
    vault,
    settings: { getFirstmateAccount: () => accountId, setFirstmateAccount: () => {} },
    quota: { latest: () => undefined },
    baseRuntime: {} as ModelRuntime,
  });
  return {
    cutOff: vault.cutOff(accountId)?.class ?? null,
    serves: vault.servesSync(accountId),
    claudeModels: vault.availableModels().filter((model) => model.provider === CLAUDE_PROVIDER_ID)
      .length,
    firstmateEligible: flagship.isEligible(accountId),
    firstmatePaused: flagship.pause(accountId) ?? null,
  };
}

describe("a task on another computer, on that computer's own sign-in", () => {
  async function claudeWorld() {
    const claude = scriptedClaude();
    // This Mac's Pi base runtime, which a Claude account never binds.
    const api = await startStubApi(() => true);
    stops.push(() => api.close());
    const piRuntime = await piStubRuntime(api.url, { provider: "fm-placed", id: "stub-1" });
    let computerAccountId = "";
    let computerVault: AccountVault | undefined;
    const at = await world({
      routedTo: { provider: CLAUDE_PROVIDER_ID, id: HAIKU },
      piRuntime,
      computerVault: async (dataDir) => {
        computerVault = AccountVault.create(
          { accountsDir: join(dataDir, "accounts") },
          { backends: [claudeCredential("mac-mini-login")] },
        );
        const account = await computerVault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
        await computerVault.status(account.id, { refresh: true });
        computerAccountId = account.id;
        return { vault: computerVault };
      },
      computerFactories: (dir) => ({
        claude: createClaudeSessionFactory({
          configDir: join(dir, "claude-config"),
          env: () => ({ PATH: "/usr/bin", HOME: dir }),
          checkClient: async () => ({ state: "ready", executable: "/usr/local/bin/claude" }),
          query: claude.query,
          clock: manualClock(),
        }),
      }),
    });
    // This Mac's own Claude sign-in.
    const account = await at.home.vault.add(CLAUDE_PROVIDER_ID, "oauth", bridge);
    await at.home.vault.status(account.id, { refresh: true });
    if (!computerVault) throw new Error("The computer kept no sign-ins.");
    return {
      ...at,
      claude,
      thisMacAccount: account.id,
      computerAccount: computerAccountId,
      computerVault,
    };
  }

  it("signed out there: that computer's Claude account holds it, and this Mac's still serves", async () => {
    const at = await claudeWorld();
    const { home } = at;
    const before = servingHere(home.vault, at.thisMacAccount);
    expect(before).toMatchObject({ cutOff: null, serves: true, firstmateEligible: true });
    expect(before.claudeModels).toBeGreaterThan(0);

    at.claude.play({ kind: "signed_out" });
    await at.start("t-signed-out");
    await expect.poll(() => home.events.some((event) => event.type === "turn_failed")).toBe(true);
    await expect.poll(() => home.tasks.get("t-signed-out")?.activity).toBe("idle");

    // This Mac named the computer's own Claude account, and the computer bound it.
    expect(at.bound).toEqual([{ described: at.computerAccount, resolved: at.computerAccount }]);
    // The fact is that computer's own account's, in its own store.
    await expect.poll(() => at.computerVault.cutOff(at.computerAccount)?.class).toBe("signed_out");
    expect(at.computerVault.servesSync(at.computerAccount)).toBe(false);
    // Nothing of it is this Mac's: its Firstmate and crew keep serving.
    expect(home.noteCutOff).not.toHaveBeenCalled();
    expect(servingHere(home.vault, at.thisMacAccount)).toEqual(before);
    expect(home.selector.selectForSpawn("t-next-here", CLAUDE_PROVIDER_ID)).toBe(at.thisMacAccount);
    // The turn's usage is booked on that computer's own account.
    expect(home.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t-signed-out", accountId: at.computerAccount }),
    );
    expect(home.recordUsage).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountId: at.thisMacAccount }),
    );
    // The way back is signing in again there, and the card says where.
    await expect
      .poll(() => home.cards().find((card) => card.id === "card-auth-t-signed-out")?.body)
      .toContain(`which needs you to sign in again ${at.where()}.`);
  });

  it("out of allowance there: the reset is that computer's account's, not this Mac's", async () => {
    const at = await claudeWorld();
    const { home } = at;
    const before = servingHere(home.vault, at.thisMacAccount);
    const resetsAtMs = (Math.floor(Date.now() / 1000) + 3600) * 1000;
    at.claude.play({ kind: "no_headroom", resetsAtMs });
    await at.start("t-no-headroom");
    await expect.poll(() => home.tasks.get("t-no-headroom")?.activity).toBe("idle");
    await expect
      .poll(() => at.computerVault.cutOff(at.computerAccount))
      .toMatchObject({ class: "no_headroom", resetsAt: resetsAtMs });
    expect(home.noteCutOff).not.toHaveBeenCalled();
    expect(servingHere(home.vault, at.thisMacAccount)).toEqual(before);
    expect(home.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t-no-headroom", accountId: at.computerAccount }),
    );
  });

  it("a cut-off on this Mac's own account never holds a task that runs there", async () => {
    const at = await claudeWorld();
    const { home } = at;
    await at.start("t-placed");
    await expect.poll(() => home.recordUsage.mock.calls.length).toBe(1);
    await expect.poll(() => home.tasks.get("t-placed")?.activity).toBe("idle");
    // A task an earlier build started there still names this Mac's account.
    home.tasks.placement.setAccountId("t-placed", at.thisMacAccount);
    // This Mac's own Claude is refused here, by work of its own.
    home.vault.noteCutOff(at.thisMacAccount, { class: "refused" });
    home.supervisor.reconcileCutOffs();
    expect(home.vault.servesSync(at.thisMacAccount)).toBe(false);
    // The task on Mac mini runs on Mac mini's sign-in: nothing pauses it,
    // and the captain's words go to it rather than wait on this Mac's account.
    const record = home.tasks.get("t-placed");
    if (!record) throw new Error("The task has no record.");
    expect(home.supervisor.postures.workPosture(record).state).not.toBe("paused");
    expect(
      await home.supervisor.steer.steerCrewmate("t-placed", "Also fix the header.", "captain"),
    ).not.toBe("recorded-held");
    // The Firstmate hears this Mac's cut-off for no task that runs there.
    expect(
      home.wakes.filter((wake) => JSON.stringify(wake).includes("t-placed")),
    ).not.toContainEqual(
      expect.objectContaining({ facts: expect.objectContaining({ kind: "provider-cut-off" }) }),
    );
  });

  it("Pi: the turn's usage is booked on the account that computer bound, never this Mac's", async () => {
    const api = await startStubApi(() => true);
    stops.push(() => api.close());
    api.answer((request, res) => {
      beginAnthropicStream(res, 100, request.n);
      writeAnthropicText(res, 0, "Done here.");
      finishAnthropicStream(res, "end_turn", 3);
    });
    const runtime = await piStubRuntime(api.url, { provider: "fm-placed", id: "stub-1" });
    const THIS_MAC = "acct_this_mac_pi";
    const MAC_MINI = "acct_mac_mini_pi";
    const at = await world({
      routedTo: { provider: "fm-placed", id: "stub-1" },
      piRuntime: runtime,
      // This Mac's selection would hand its own Pi account, and its binder bind it.
      accounts: {
        selectForSpawn: () => THIS_MAC,
        reselectForResume: (_task, accountId) => ({
          ...(accountId ? { accountId } : {}),
          changed: false,
        }),
        labelOf: () => "This Mac's Pi",
      },
      bind: async (accountId) => ({ backend: "pi", ...(accountId ? { accountId } : {}), runtime }),
      // Mac mini's own Pi sign-in for that provider.
      computerVault: async () =>
        ({
          vault: {
            get: (id: string) =>
              id === MAC_MINI ? { id, providerId: "fm-placed", enabled: true } : undefined,
            backendIdOf: (id: string) => (id === MAC_MINI ? "pi" : undefined),
            connectedSync: (id: string) => id === MAC_MINI,
            pinnedAccount: () => MAC_MINI,
            list: () => [{ id: MAC_MINI, providerId: "fm-placed", enabled: true }],
            runtimeFor: async () => runtime,
            noteCutOff: () => {},
            views: async () => [
              {
                id: MAC_MINI,
                providerId: "fm-placed",
                kind: "api_key",
                label: "Mac mini's Pi",
                enabled: true,
                connected: true,
                pinned: true,
                createdAt: 0,
              },
            ],
          },
        }) as unknown as NonNullable<ComputerVault>,
      computerFactories: (dir) => ({
        pi: createPiSessionFactory({ agentDir: join(dir, "pi-agent") }),
      }),
    });
    await at.start("t-pi");
    await expect.poll(() => at.home.tasks.get("t-pi")?.outcome).toBe("Done here.");
    await expect.poll(() => at.home.recordUsage.mock.calls.length).toBeGreaterThan(0);
    expect(at.bound).toEqual([{ described: MAC_MINI, resolved: MAC_MINI }]);
    expect(at.home.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t-pi", accountId: MAC_MINI }),
    );
    expect(at.home.recordUsage).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountId: THIS_MAC }),
    );
  });
});
