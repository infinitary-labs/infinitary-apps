import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  answerText,
  beginAnthropicStream,
  finishAnthropicStream,
  type StubApi,
  type StubRequest,
  startStubApi,
  writeAnthropicEvent,
  writeAnthropicToolUse,
} from "../../../tests/helpers/anthropicDialect";
import { clientRecords, enqueued } from "../../../tests/helpers/claudeSeatHarness";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { freshDatabase } from "../../../tests/helpers/database";
import { fakeSessionFactory } from "../../../tests/helpers/fakeSession";
import {
  orderPolicyOnlyRoute,
  preparePolicyOnlyRoute,
} from "../../../tests/helpers/policyOnlyRouting";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CrewSupervisor } from "../orchestrator/crewSupervisor";
import { appPathsFor } from "../paths";
import type { Router } from "../routing/router";
import type { ModelSession, SessionEvent, SessionFactory } from "../session/session";
import { CardStore } from "../storage/cardStore";
import { CostLimitStore } from "../storage/costLimitStore";
import { InboxStore } from "../storage/inboxStore";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { UsageStore } from "../storage/usageStore";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import type { WorkspaceService } from "../workspace/workspaceService";
import { ClaudeCostReports } from "./claudeCostReports";
import { createNormalizerState, fmEventsFromClaudeMessage } from "./claudeEvents";
import {
  CLAUDE_MODEL_PROVIDER,
  type ClaudeSessionDeps,
  MessageQueue,
  userMessage,
} from "./claudeQueryCore";
import { claudeSessionOptions } from "./claudeSessionOptions";
import { hasActiveSession, resetStoreLeasesForTest } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

/**
 * The crewmate's coding session against the REAL client, hermetically: the
 * SDK's own co-released client, boxed by the e2e stub
 * (`tests/e2e/mockClaudeClient.ts` turn mode: a throwaway config dir, a
 * dummy subscription token, a Keychain shim) and pointed at a local stub of
 * the Anthropic API. No credential is read, no sign-in starts, nothing is
 * billed, and nothing reaches the network; the one command the model runs
 * is a shell sleep in the box's own worktree.
 *
 * What it settles that no scripted test can: how the client tells a turn it
 * runs on its own. A command the model started in the background finishes
 * after the prompt's turn is over, and the client then runs a turn no
 * prompt asked for. Measured on the pinned client (2.1.234): it announces
 * the finished command (`task_notification`), says `running`, runs the
 * turn, and says `idle` - the same signals that bracket a prompt's turn, so
 * the session reports a continuation from them rather than guessing at
 * activity. The steer and settle rules the crewmate shares with the seat
 * run on this client in the session contract's suite
 * (`claudeSession.contract.integration.test.ts`).
 *
 * And, under a real supervisor, what a close or a quit owes a turn it cuts:
 * the client reports a turn's tokens and cost only in the result that
 * follows the interrupt, after the abort returned, and that turn still
 * reaches the usage ledger exactly once.
 */

// Eight-worker Mac remeasurement (docs/test-cohorts.md): continuation
// 2.155 s at its fastest of three runs, 6.693 s worst; five times, rounded up to 5 s.
vi.setConfig({ testTimeout: 15_000 });

const MODEL = "claude-haiku-4-5";

/** The crewmate's instruction; it also tells the app's requests from the client's own. */
const INSTRUCTION = "You are a crewmate counting rivets for the continuation measurement.";

/** What the model starts in the background: a short sleep in the worktree. */
const BACKGROUND_COUNT = { command: "sleep 1; echo forty", run_in_background: true };

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi((body) => JSON.stringify(body.system ?? "").includes(INSTRUCTION));
});

afterAll(async () => {
  await api.close();
});

/** Every record store a box opened: their stamps land before its directories go. */
const stores: SessionRecordStore[] = [];

afterEach(async () => {
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

/** One throwaway HOME with the boxed client in it, and Claude's factory over it. */
function box(
  stubApi: StubApi = api,
  reporting: Pick<ClaudeSessionDeps, "costReports" | "costReportingAllowed"> = {},
) {
  const home = scratchDir("infinitary-claude-coding-home-");
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: stubApi.url, credential: "subscription", maxRetries: 0 },
  });
  const cwd = join(home, "worktree");
  mkdirSync(cwd, { recursive: true });
  // The boxed client keeps its config (and so its transcripts) in HOME/.claude.
  const configDir = join(home, ".claude");
  const env = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
  const factory = createClaudeSessionFactory({
    configDir,
    ...reporting,
    env: () => env,
    clock: { now: () => Date.now(), register: () => () => {} },
    log: () => {},
    records: (dir) => {
      const store = new SessionRecordStore(dir);
      stores.push(store);
      return store;
    },
  });
  const spec = codingSpec({
    binding: { backend: "claude", accountId: "acct_claude" },
    cwd,
    instructions: INSTRUCTION,
    model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
  });
  return { cwd, configDir, env, stub, factory, spec };
}

/**
 * The model's side of a background count, from the next of the app's
 * requests on: it starts the count in the background with the client's own
 * shell, says so, and hands every later request - the turn the client runs
 * once the count is done - to `later`.
 */
function countsInTheBackground(later: (request: StubRequest, res: ServerResponse) => void): void {
  const first = api.requests.length;
  api.answer((request, res) => {
    const index = request.n - first - 1;
    if (index === 0) {
      beginAnthropicStream(res, 42, request.n);
      writeAnthropicToolUse(res, 0, {
        id: `toolu_${request.n}`,
        name: "Bash",
        args: { ...BACKGROUND_COUNT, description: "Count the rivets" },
      });
      finishAnthropicStream(res, "tool_use", 7);
      return;
    }
    if (index === 1) {
      answerText(request, res, "Counting in the background.");
      return;
    }
    later(request, res);
  });
}

/** Everything the app's request showed the model last, as one string. */
function latestUserTurn(request: StubRequest | undefined): string {
  const messages = request?.body.messages ?? [];
  return JSON.stringify(messages.filter((message) => message.role === "user").at(-1) ?? "");
}

describe("the client's own turns, measured on the real client", () => {
  it("keeps resumed client usage once when the default-batched reports arrive too late (approved fallback)", async () => {
    const b = box(api, { costReportingAllowed: async () => true });
    api.answer((request, res) => answerText(request, res, "Forty rivets."));
    const session = await b.factory.open(b.spec);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.prompt("Count the port hatch rivets.");
      await session.detach();
      await session.prompt("Count the starboard hatch rivets.");
      const usage = events.flatMap((event) =>
        event.type === "turn_end" && event.usage ? [event.usage] : [],
      );
      expect(usage).toHaveLength(2);
      expect(usage[0]).toMatchObject({ input: 42, output: 7, cost: expect.any(Number) });
      expect(usage[1]).toEqual(usage[0]);
    } finally {
      session.dispose();
      await session.closed();
    }
  });

  it.each([false, true])("serves Haiku 5.5 at medium, or low for Quick (%s)", async (quick) => {
    const b = box();
    const first = api.requests.length;
    api.answer((request, res) => answerText(request, res, "Ready."));
    const session = await b.factory.open({
      ...b.spec,
      model: { provider: CLAUDE_MODEL_PROVIDER, id: "claude-haiku-5-5" },
      thinking: { level: "medium", quick },
    });
    try {
      await session.prompt("Check the rivets.");
      expect(api.requests[first]?.body.model).toBe("claude-haiku-5-5");
      expect(api.requests[first]?.body.output_config?.effort).toBe(quick ? "low" : "medium");
    } finally {
      session.dispose();
      await session.closed();
    }
  });
  it("says running and idle around a turn it runs on its own once a background command finishes", async () => {
    const b = box();
    const first = api.requests.length;
    countsInTheBackground((request, res) => answerText(request, res, "Forty rivets."));
    const input = new MessageQueue();
    const run = query({
      prompt: input,
      options: claudeSessionOptions({
        spec: b.spec,
        env: b.env,
        executable: b.stub,
        stderr: () => {},
        attachment: { model: MODEL, session: { sessionId: randomUUID() } },
      }),
    });
    input.push(
      userMessage("Count the rivets in the background.", undefined, undefined, randomUUID()),
    );
    const said: string[] = [];
    const membership: number[] = [];
    const normalizer = createNormalizerState();
    for await (const message of run) {
      const normalized = fmEventsFromClaudeMessage(message, "boxed", normalizer);
      if (normalized.backgroundJobs !== undefined) membership.push(normalized.backgroundJobs);
      const record = message as { type?: string; subtype?: string; state?: string };
      if (record.type === "result") said.push("result");
      if (record.subtype === "task_notification") said.push("finished");
      if (record.subtype === "session_state_changed" && record.state) said.push(record.state);
      if (said.filter((word) => word === "idle").length === 2) break;
    }
    input.close();
    for await (const _message of run) {
      // Draining to the client's exit.
    }
    // The prompt's turn, then the command finishing, then a turn of the
    // client's own, bracketed exactly as the prompt's was.
    expect(membership).toEqual([1, 0]);
    const states = said.filter((word) => word !== "finished");
    expect(states).toEqual(["running", "result", "idle", "running", "result", "idle"]);
    expect(said.indexOf("finished")).toBeGreaterThan(said.indexOf("idle"));
    expect(said.indexOf("finished")).toBeLessThan(said.lastIndexOf("running"));
    // The turn the client ran on its own asked the model once, about the
    // finished command.
    expect(api.requests.length - first).toBe(3);
    expect(latestUserTurn(api.requests[first + 2])).toContain("background");
  });

  it("reports that turn as a continuation, which a steer joins", async () => {
    const b = box();
    const first = api.requests.length;
    const steer = "and count the starboard hatch too";
    let reached!: () => void;
    const continued = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let held: { request: StubRequest; res: ServerResponse } | undefined;
    countsInTheBackground((request, res) => {
      // The first request of the client's own turn waits on the model, so a
      // steer can land in it; every later one is answered at once.
      if (!held) {
        held = { request, res };
        reached();
        return;
      }
      answerText(request, res, "Forty on the port hatch, thirty-eight on the starboard one.");
    });
    const session = await b.factory.open(b.spec);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.prompt("Count the rivets in the background.");
    // The prompt settled on its own turn, the count still running.
    expect(events.map((event) => event.type)).not.toContain("continuation_started");
    await continued;
    expect(events.filter((event) => event.type === "continuation_started")).toHaveLength(1);
    expect(session.isStreaming()).toBe(true);
    // The client queues the steer into its own turn: an order it keeps.
    const queued = clientRecords(
      { configDir: b.configDir, cwd: b.cwd },
      session.sessionId,
      enqueued(steer),
    );
    await session.steer(steer);
    await queued;
    if (!held) throw new Error("the client's own turn never asked the model");
    answerText(held.request, held.res, "Forty rivets on the port hatch.");
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === "continuation_ended")).toEqual([
        { type: "continuation_ended" },
      ]),
    );
    // The steer reached the model inside the continuation - one continuation,
    // never a second turn of its own - and nothing is left over.
    expect(events.filter((event) => event.type === "continuation_started")).toHaveLength(1);
    expect(
      api.requests
        .slice(first + 3)
        .map(latestUserTurn)
        .join("\n"),
    ).toContain(steer);
    expect(session.takeUndeliveredSteers()).toEqual([]);
    expect(events.some((event) => event.type === "turn_failed")).toBe(false);
    expect(session.isStreaming()).toBe(false);
    session.dispose();
    await session.closed();
    expect(hasActiveSession(b.configDir)).toBe(false);
  });
});

/**
 * The host over the boxed client: a real supervisor whose crewmates run on
 * the box's Claude factory in the box's worktree, and the real usage ledger
 * in a fresh database. The workspace is faked; nothing here is about git.
 */
function crewOn(b: ReturnType<typeof box>, limit?: number, onUsage?: () => void) {
  const paths = appPathsFor(scratchDir("infinitary-claude-crew-"));
  const db = freshDatabase();
  const tasks = new TaskService({ db, strict: true });
  const usage = new UsageStore(db);
  /** Every session the crew opened on the box's client, so a case can wait for one to close. */
  const opened: ModelSession[] = [];
  const claude: SessionFactory = {
    ...b.factory,
    open: async (spec) => {
      const session = await b.factory.open(spec);
      opened.push(session);
      return session;
    },
  };
  let toolStarted!: () => void;
  /** The client announced the tool, before it necessarily finished reading its request. */
  const toolAnnounced = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  const workspace = {
    ensureDefaultRepo: async () => paths.defaultWorkspaceDir,
    createTaskWorktree: async (taskId: string) => ({
      taskId,
      cwd: b.cwd,
      branch: `fm/task-${taskId}`,
      repoDir: paths.defaultWorkspaceDir,
    }),
    installDependencies: async () => ({ outcome: "skipped" as const }),
    retireTaskWorktree: async () => ({ outcome: "removed" as const, kept: null }),
    removeTaskWorktree: async () => {},
    taskWorkStatus: async () => ({ dirty: false, unlandedCommits: 0 }),
  } as unknown as WorkspaceService;
  const supervisor = new CrewSupervisor({
    sessions: { pi: fakeSessionFactory("pi"), claude },
    bind: async () => ({ backend: "claude", accountId: "acct_claude" }),
    router: {
      prepare: preparePolicyOnlyRoute,
      inOrder: orderPolicyOnlyRoute,
      decide: () => ({
        choice: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
        bucket: "high",
        rule: "R8",
      }),
      servedProvider: () => CLAUDE_MODEL_PROVIDER,
      modelLabel: (ref: { id: string }) => ref.id,
    } as unknown as Router,
    workspace,
    repos: new RepoRegistry(db, paths.fleetDir),
    tasks,
    cardStore: new CardStore(db),
    inbox: new InboxStore(db),
    paths,
    ...(limit !== undefined
      ? { costLimits: { store: new CostLimitStore(db), appLimit: () => ({ usd: limit }) } }
      : {}),
    recordUsage: (input) => {
      usage.record({ ...input, at: Date.now() });
      onUsage?.();
    },
    broadcastEvent: (event) => {
      if (event.type === "tool_start") toolStarted();
    },
    broadcastCards: () => {},
  });
  const rows = (taskId: string) =>
    db
      .prepare("SELECT provider, model, input, output, cost FROM usage_events WHERE task_id = ?")
      .all(taskId) as {
      provider: string | null;
      model: string | null;
      input: number | null;
      output: number | null;
      cost: number | null;
    }[];
  return { supervisor, tasks, rows, toolAnnounced, opened };
}

describe("a crewmate's turn a close cuts, on the real client", () => {
  // The host's own crewmate prompt, told from the client's housekeeping by
  // the tools it carries.
  let crewApi: StubApi;

  beforeAll(async () => {
    crewApi = await startStubApi();
  });

  afterAll(async () => {
    await crewApi.close();
  });

  /** Every crew a case started: a failed case still lets its client go before its HOME does. */
  const crews: { crew: ReturnType<typeof crewOn>; configDir: string }[] = [];

  afterEach(async () => {
    for (const { crew, configDir } of crews.splice(0)) {
      await crew.supervisor.disposeAll();
      await vi.waitFor(() => expect(hasActiveSession(configDir)).toBe(false), {
        timeout: 5_000,
      });
    }
  });

  it("uses local reports to hold a real Claude turn before its result, with no second charge (approved local-cost direction)", async () => {
    const receiver = new ClaudeCostReports();
    let received!: () => void;
    const priceReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const b = box(crewApi, {
      costReportingAllowed: async () => true,
      costReports: {
        subscribe: (id, report) =>
          receiver.subscribe(id, (cost) => {
            report(cost);
            received();
          }),
      },
    });
    const first = crewApi.requests.length;
    let held: { request: StubRequest; res: ServerResponse } | undefined;
    crewApi.answer((request, res) => {
      if (request.n - first !== 1) {
        held = { request, res };
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "request-id": `req_cost_${request.n}`,
      });
      writeAnthropicEvent(res, "message_start", {
        type: "message_start",
        message: {
          id: `msg_cost_${request.n}`,
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 42, output_tokens: 0 },
        },
      });
      writeAnthropicToolUse(res, 0, {
        id: `toolu_cost_${request.n}`,
        name: "Bash",
        args: { command: "printf forty", description: "Count the rivets" },
      });
      finishAnthropicStream(res, "tool_use", 7);
    });
    const outstandingAtRecording: number[] = [];
    const crew = crewOn(b, 0.00005, () => outstandingAtRecording.push(crewApi.openRequests()));
    crews.push({ crew, configDir: b.configDir });
    const { taskId } = await crew.supervisor.intake.commission({
      title: "Count the rivets within the spending limit",
      intent: { goal: "Count the rivets on the hatch.", userWords: "count the rivets" },
    });
    await vi.waitFor(() => expect(held).toBeDefined(), { timeout: 5_000 });
    // A delivered price is queued, not a turn_end in the middle of work.
    await priceReceived;
    expect(crew.rows(taskId)).toEqual([]);
    expect(crew.supervisor.costLimits.heldBy(taskId)).toBeUndefined();
    if (!held) throw new Error("the next inference never arrived");
    beginAnthropicStream(held.res, 42, held.request.n);
    // The next main message_start flushes the predecessor's queued price.
    await vi.waitFor(() => expect(crew.supervisor.costLimits.heldBy(taskId)).toBeDefined(), {
      timeout: 10_000,
    });
    expect(outstandingAtRecording[0]).toBeGreaterThan(0);
    const before = crew.rows(taskId);
    expect(before).toEqual([
      {
        provider: CLAUDE_MODEL_PROVIDER,
        model: MODEL,
        input: 42,
        output: 7,
        cost: expect.any(Number),
      },
    ]);
    expect(crew.supervisor.costLimits.heldBy(taskId)?.spentUsd).toBe(before[0]?.cost);
    await crew.supervisor.disposeAll();
    await vi.waitFor(() => expect(hasActiveSession(b.configDir)).toBe(false));
    expect(crew.rows(taskId)).toEqual(before);
    console.log(
      "Local cost hold evidence",
      JSON.stringify({ before, after: crew.rows(taskId), outstandingAtRecording }),
    );
  });

  it("a failed local receiver leaves the real Claude prompt and its terminal usage working (approved fallback)", async () => {
    const b = box(crewApi, {
      costReportingAllowed: async () => true,
      costReports: {
        subscribe: async () => {
          throw new Error("receiver unavailable");
        },
      },
    });
    crewApi.answer((request, res) => answerText(request, res, "Forty rivets."));
    const session = await b.factory.open(b.spec);
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.prompt("Count the rivets.");
      expect(events.some((event) => event.type === "turn_failed")).toBe(false);
      const usage = events.flatMap((event) =>
        event.type === "turn_end" && event.usage ? [event.usage] : [],
      );
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ input: 42, output: 7, cost: expect.any(Number) });
    } finally {
      session.dispose();
      await session.closed();
    }
  });

  /**
   * A crewmate mid-turn: every request the model answers runs one long
   * command in the foreground, so what cuts the turn lands while it works.
   * A tool_start only announces the command: the client can emit it before
   * the request's trailing usage, and an interrupt then reports zero spend.
   * Hold that tail until the announcement so every run exercises this order,
   * then wait for the command's own marker before cutting it. By that point
   * the client has spent one request (42 in, 7 out), reported only in the
   * result that follows the interrupt.
   */
  async function midTurn() {
    const b = box(crewApi);
    const ready = "rivet-gauge-ready";
    let finishRequest!: () => void;
    crewApi.answer((request, res) => {
      beginAnthropicStream(res, 42, request.n);
      writeAnthropicToolUse(res, 0, {
        id: `toolu_${request.n}`,
        name: "Bash",
        args: {
          command: `printf ready > ${ready}; sleep 30`,
          description: "Wait on the rivet gauge",
        },
      });
      finishRequest = () => finishAnthropicStream(res, "tool_use", 7);
    });
    const crew = crewOn(b);
    crews.push({ crew, configDir: b.configDir });
    const { taskId } = await crew.supervisor.intake.commission({
      title: "Count the rivets",
      intent: { goal: "Count the rivets on the hatch.", userWords: "count the rivets" },
    });
    await crew.toolAnnounced;
    expect(existsSync(join(b.cwd, ready))).toBe(false);
    finishRequest();
    await vi.waitFor(() => expect(existsSync(join(b.cwd, ready))).toBe(true), {
      timeout: 5_000,
    });
    expect(crew.rows(taskId)).toEqual([]);
    return { b, crew, taskId };
  }

  /** The one row the cut turn is owed: the stub's usage, priced by the client. */
  const cutTurnRow = {
    provider: CLAUDE_MODEL_PROVIDER,
    model: MODEL,
    input: 42,
    output: 7,
    cost: expect.any(Number),
  };

  it("still reaches the usage ledger, exactly once, after the close returned", async () => {
    const { b, crew, taskId } = await midTurn();

    // The settle path an answered card, a discard or a parent's close takes.
    await crew.supervisor.settling.closing.closeTask(taskId, {
      status: "done",
      reason: "answered",
      actor: "captain",
    });
    expect(crew.tasks.get(taskId)?.status).toBe("done");

    // The session is gone once the cut turn settled and the client exited.
    await vi.waitFor(() => expect(hasActiveSession(b.configDir)).toBe(false), {
      timeout: 5_000,
    });
    const rows = crew.rows(taskId);
    expect(rows).toEqual([cutTurnRow]);
    expect(rows[0]?.cost).toBeGreaterThan(0);
  });

  it("is kept by a quit, which waits for the cut turn and leaves the task to resume", async () => {
    const { b, crew, taskId } = await midTurn();

    await crew.supervisor.disposeAll();
    const rows = crew.rows(taskId);
    expect(rows).toEqual([cutTurnRow]);
    expect(rows[0]?.cost).toBeGreaterThan(0);
    expect(crew.tasks.get(taskId)?.status).toBe("active");

    // The quit waits for the cut turn's result, which carries its usage, but
    // for the session's close only up to its bound (`QUIT_SETTLE_MS`): the
    // client exits after its input closes, and on a loaded machine that exit
    // can come after the quit returned. The store is free once the session
    // the quit let go of has closed.
    expect(crew.opened).toHaveLength(1);
    await crew.opened[0]?.closed();
    expect(hasActiveSession(b.configDir)).toBe(false);
  });
});
