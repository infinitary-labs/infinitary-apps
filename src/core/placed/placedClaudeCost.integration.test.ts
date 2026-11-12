import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  type StubRequest,
  startStubApi,
  writeAnthropicEvent,
  writeAnthropicToolUse,
} from "../../../tests/helpers/anthropicDialect";
import {
  placedContractCleanup,
  placedContractWorld,
} from "../../../tests/helpers/placedContractWorld";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CREWMATE_TASK } from "../../../tests/helpers/sessionContract";
import type { FmEvent } from "../../shared/events";
import { ClaudeCostReports } from "../claude/claudeCostReports";
import { CLAUDE_CONTROL_PROFILE, CLAUDE_MODEL_PROVIDER } from "../claude/claudeQueryCore";
import { createClaudeSessionFactory } from "../claude/session";
import { startConversations } from "../helper/conversations";
import { configureSettingsPath, resetLoginPathForTests } from "../hostEnv";
import { ObserveLiveBuffer } from "../observe/liveBuffer";
import { createCrewmateTranscriptResolver } from "../observe/transcriptSource";
import { CrewSupervisor } from "../orchestrator/crewSupervisor";
import { crewmateSessionsDir } from "../paths";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import type { Router } from "../routing/router";
import { CardStore } from "../storage/cardStore";
import { CostLimitStore } from "../storage/costLimitStore";
import { InboxStore } from "../storage/inboxStore";
import { UsageStore } from "../storage/usageStore";
import { CrewTranscripts } from "../tasks/crewTranscript";
import { RepoRegistry } from "../workspace/repoRegistry";
import { WorkspaceService } from "../workspace/workspaceService";

// Intent: placed Claude spending uses the real helper composition, paired transport,
// home supervisor/ledger and native Claude client. Only the organization's
// policy answer and model replies are stood in; no real policy or login is read.
const permission = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../claude/claudeCostPolicy", () => ({ claudeCostReportingAllowed: permission }));
vi.mock("../claude/claudeAccess", async (original) => ({
  ...(await original<typeof import("../claude/claudeAccess")>()),
  readClaudeAccess: async () => ({}),
}));

// Includes real pairing/worktree setup and the client's unchanged five-second batch.
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => {
  await placedContractCleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLoginPathForTests();
});

it("holds a placed Claude crewmate at the next model boundary without losing its running tool", async () => {
  const model = { provider: CLAUDE_MODEL_PROVIDER, id: "claude-haiku-4-5" };
  const home = scratchDir("infinitary-placed-cost-client-");
  const api = await startStubApi();
  const executable = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, credential: "subscription", maxRetries: 0 },
  });
  mkdirSync(join(home, ".claude"), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("CFFIXED_USER_HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  vi.stubEnv("INFINITARY_CLAUDE_CLI", executable);
  for (const key of Object.keys(process.env))
    if (
      key.startsWith("OTEL_") ||
      key.startsWith("ANT_OTEL_") ||
      [
        "CLAUDE_CODE_ENABLE_TELEMETRY",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "BETA_TRACING_ENDPOINT",
        "ENABLE_BETA_TRACING_DETAILED",
        "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
        "CLAUDE_CODE_BYOC_ENABLE_DATADOG",
      ].includes(key)
    )
      vi.stubEnv(key, undefined);
  configureSettingsPath([]);

  let priced = false;
  const subscribe = ClaudeCostReports.prototype.subscribe;
  vi.spyOn(ClaudeCostReports.prototype, "subscribe").mockImplementation(function (
    this: ClaudeCostReports,
    id,
    report,
  ) {
    return subscribe.call(this, id, (cost) => {
      report(cost);
      priced = true;
    });
  });
  // The factory supplies protocol metadata to the shared paired fixture;
  // actual sessions below are built by production startConversations.
  const metadata = createClaudeSessionFactory({ configDir: join(home, ".claude") });
  let supervisor: CrewSupervisor | undefined;
  let workDir: string | undefined;
  try {
    const world = await placedContractWorld(
      { factory: metadata, binding: { backend: "claude" as const, accountId: "dummy" } },
      {
        conversations: (options) => startConversations({ ...options, log: () => {} }),
      },
    );
    const { db, tasks, paths, devices, placed } = world.placement;
    const prepared = (await devices.ask(world.machine, "inf:working-copy:prepare", [
      { orderId: "prepare-cost", task: CREWMATE_TASK },
    ])) as { dir: string };
    workDir = prepared.dir;
    expect(typeof workDir).toBe("string");
    // The running tool's command ends once this mark holds anything; it is made
    // empty before the command starts, and the test appends to it to release it.
    const release = join(workDir, "release-cost");
    writeFileSync(release, "", { flag: "wx" });
    const usage = new UsageStore(db);
    const limits = new CostLimitStore(db);
    const events: FmEvent[] = [];
    const live = new ObserveLiveBuffer();
    const nothingHere = {
      open: async () => {
        throw new Error("This fixture runs only on its work computer");
      },
    };
    supervisor = new CrewSupervisor({
      sessions: {
        pi: { ...nothingHere, backend: "pi", controlProfile: PI_CONTROL_PROFILE },
        claude: { ...nothingHere, backend: "claude", controlProfile: CLAUDE_CONTROL_PROFILE },
      },
      machines: placed,
      bind: async () => ({ backend: "claude", accountId: "dummy" }),
      tasks,
      paths,
      repos: new RepoRegistry(db, paths.fleetDir),
      workspace: new WorkspaceService(paths, { pool: false }),
      cardStore: new CardStore(db),
      inbox: new InboxStore(db),
      router: {
        servedChoice: () => ({ model, slot: "high" }),
        reasoningChoice: () => "medium",
        servedProvider: () => model.provider,
        modelLabel: (ref: { id: string }) => ref.id,
      } as unknown as Router,
      costLimits: { store: limits, appLimit: () => ({ usd: 0.00005 }) },
      recordUsage: (input) => usage.record({ ...input, at: Date.now() }),
      broadcastEvent: (event) => {
        events.push(event);
        live.apply(event);
      },
      broadcastCards: () => {},
    });
    const recordDirOf = (id: string) => crewmateSessionsDir(paths, id);
    const resolve = createCrewmateTranscriptResolver({
      recordDirOf,
      backendOf: () => undefined,
      configDirOf: () => undefined,
    });
    const reader = new CrewTranscripts({
      recordDirOf,
      currentSession: (task) => resolve(task).path,
    });
    const toolLines = () => {
      const task = tasks.get(CREWMATE_TASK);
      if (!task) throw new Error("the placed task is missing");
      return reader.of(task, tasks.timeline(CREWMATE_TASK), false).lines;
    };
    const owner = supervisor;
    placed.serve({
      adopt: (id) => owner.adoptPlaced(id),
      caughtUp: (ids) => owner.placedCaughtUp(ids),
      jobExit: () => {},
      reopened: (id) => owner.placedReopened(id),
    });
    let next: { request: StubRequest; res: ServerResponse } | undefined;
    api.answer((request, res) => {
      if (request.n !== 1) {
        next = { request, res };
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_placed_cost" });
      writeAnthropicEvent(res, "message_start", {
        type: "message_start",
        message: {
          id: "msg_placed_cost",
          type: "message",
          role: "assistant",
          model: model.id,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 42, output_tokens: 0 },
        },
      });
      // The command watches release-cost itself as reachMark does, reading it once
      // the watch is in place, never through the folder: on macOS a folder's watch is
      // FSEvents, which held or dropped the release's event past the wait below
      // while other work churned the disk, so the command never ended and the
      // next inference never came (INF-2578).
      const command = `node -e 'const fs=require("fs");const w=fs.watch("release-cost");const look=()=>{if(fs.readFileSync("release-cost","utf8")!=="")w.close()};w.on("change",look);setImmediate(()=>setImmediate(look));fs.writeFileSync("cost-tool-ready","ready")'`;
      writeAnthropicToolUse(res, 0, {
        id: "toolu_placed_cost",
        name: "Bash",
        args: { command, description: "Wait for the cost report" },
      });
      finishAnthropicStream(res, "tool_use", 7);
    });
    await supervisor.adoptPlaced(CREWMATE_TASK);
    await supervisor.steer.steerCrewmate(CREWMATE_TASK, "Count the rivets.", "captain");
    await vi.waitFor(
      () => expect(existsSync(join(workDir as string, "cost-tool-ready"))).toBe(true),
      { timeout: 5_000 },
    );
    await vi.waitFor(() => expect(priced).toBe(true), { timeout: 10_000 });
    expect(permission).toHaveBeenCalled();
    expect(events.filter((e) => e.type === "turn_end")).toEqual([]);
    expect(limits.familySpend(CREWMATE_TASK).usd).toBe(0);
    expect(live.read(CREWMATE_TASK).tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callId: "toolu_placed_cost", toolName: "Bash" }),
      ]),
    );
    expect(
      live.read(CREWMATE_TASK).tools.find((t) => t.callId === "toolu_placed_cost")?.isError,
    ).toBeUndefined();
    await vi.waitFor(() =>
      expect(toolLines().some((line) => line.kind === "tool" && line.result === null)).toBe(true),
    );
    appendFileSync(release, "go");
    await vi.waitFor(() => expect(next).toBeDefined(), { timeout: 5_000 });
    if (!next) throw new Error("the next placed inference did not arrive");
    await vi.waitFor(() =>
      expect(toolLines().some((line) => line.kind === "tool" && line.result !== null)).toBe(true),
    );
    beginAnthropicStream(next.res, 42, next.request.n);
    await vi.waitFor(() => expect(limits.hold(CREWMATE_TASK)).toBeDefined(), { timeout: 5_000 });
    const rows = () =>
      db
        .prepare("SELECT input, output, cost FROM usage_events WHERE task_id = ?")
        .all(CREWMATE_TASK);
    const before = rows();
    expect(before).toEqual([{ input: 42, output: 7, cost: expect.any(Number) }]);
    await supervisor.disposeAll();
    supervisor = undefined;
    expect(rows()).toEqual(before);
    console.log(
      "Placed Claude boundary diagnostic",
      JSON.stringify({
        before,
        after: rows(),
        held: limits.hold(CREWMATE_TASK) !== undefined,
        receivedDefaultBatchedPrice: true,
      }),
    );
  } finally {
    if (workDir) appendFileSync(join(workDir, "release-cost"), "go");
    await supervisor?.disposeAll();
    await api.close();
  }
});
