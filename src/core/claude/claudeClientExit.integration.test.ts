import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { type StubApi, startStubApi } from "../../../tests/helpers/anthropicDialect";
import { boxedClaudeClientPid, processRunning } from "../../../tests/helpers/boxedClaudeClient";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { manualClock } from "../../../tests/helpers/manualClock";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { TICK_PERIOD_MS } from "../orchestrator/ticker";
import { LOCAL_MACHINE_ID, type SessionSpec } from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { CLAUDE_MODEL_PROVIDER } from "./claudeQueryCore";
import { hasActiveSession, resetStoreLeasesForTest } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

/**
 * Intent: the session contract's `closed()` ("Resolves once the backend's
 * client is gone and its store is free", src/core/session/session.ts) and
 * docs/claude-client.md's lease, handed back when the client has exited, for
 * a Claude session stopped outright (INF-3500).
 *
 * The SDK's close ends the client's input, sends SIGTERM 2 s on and SIGKILL
 * 5 s after that, but ends its message stream after at most 2 s, whether the
 * client has gone or not. A client slower than that still ran, holding the
 * account's store and able to send a model request, after its session said
 * it was closed.
 *
 * The real path: Claude's session factory, the SDK and the SDK's own client
 * boxed in a throwaway HOME (`mockClaudeClient` turn mode), against a local
 * stub of the model's API. SIGSTOP stands in for whatever keeps a client
 * from exiting: a stopped client holds the SDK's SIGTERM, so it is gone only
 * at the SDK's SIGKILL.
 */
vi.setConfig({ testTimeout: 30_000 });

const MODEL = "claude-haiku-4-5";
const INSTRUCTION = "You are checking how a stopped Claude client leaves.";

/** Each case's own stub of the model's API, so no client reaches another case's (INF-3499). */
const apis: StubApi[] = [];

afterAll(async () => {
  await Promise.all(apis.map((api) => api.close()));
});

/** Processes a case stopped: none outlives it. */
const stopped: number[] = [];
const stores: SessionRecordStore[] = [];

afterEach(async () => {
  for (const pid of stopped.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

/**
 * A throwaway HOME with the boxed client, its own stub API, and Claude's
 * factory over it on a clock moved by hand.
 */
async function boxedClaude() {
  const api = await startStubApi((body) => JSON.stringify(body.system ?? "").includes(INSTRUCTION));
  apis.push(api);
  const home = scratchDir("infinitary-claude-client-exit-");
  const executable = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, credential: "subscription", maxRetries: 0 },
  });
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const configDir = join(home, ".claude");
  const clock = manualClock();
  const factory = createClaudeSessionFactory({
    configDir,
    env: () => ({ PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: executable }),
    clock,
    records: (dir) => {
      const store = new SessionRecordStore(dir);
      stores.push(store);
      return store;
    },
  });
  return { api, cwd, configDir, clock, factory };
}

/** Stops the boxed client where it is; the case's end kills it if the session did not. */
function stopTheClient(): number {
  const client = boxedClaudeClientPid();
  stopped.push(client);
  process.kill(client, "SIGSTOP");
  return client;
}

/** The run log's trace of one close: how long after the stop it came, and whether the client still ran. */
function traceClose(name: string, client: number, stoppedAt: number): void {
  console.info(
    JSON.stringify({
      case: name,
      closedAfterStopMs: Math.round(performance.now() - stoppedAt),
      clientRunningAtClose: processRunning(client),
    }),
  );
}

describe("a Claude session stopped outright, with a client slow to leave", () => {
  it("closes a question given up on only once its client has exited, and frees the store then", async () => {
    const at = await boxedClaude();
    const spec: SessionSpec = {
      machine: LOCAL_MACHINE_ID,
      owner: "question",
      cwd: at.cwd,
      binding: { backend: "claude", accountId: "acct_claude" },
      model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
      thinking: { level: "off" },
      instructions: { base: INSTRUCTION },
      builtins: "none",
      tools: [],
      shape: { turns: "one" },
    };
    // The model never answers: the question is still out when it is given up on.
    at.api.answer(() => {});
    const asked = at.api.nextRequest();
    const session = await at.factory.open(spec);
    const question = session.prompt("Which kind is this?");
    await asked;
    const client = stopTheClient();

    const stoppedAt = performance.now();
    await session.abort();
    await question;
    await session.closed();
    traceClose("question", client, stoppedAt);

    expect(processRunning(client)).toBe(false);
    expect(hasActiveSession(at.configDir)).toBe(false);
  });

  it("closes a crewmate's session stopped a tick after its input ended only once its client has exited", async () => {
    const at = await boxedClaude();
    const session = await at.factory.open(
      codingSpec({
        binding: { backend: "claude", accountId: "acct_claude" },
        cwd: at.cwd,
        instructions: INSTRUCTION,
        model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
      }),
    );
    // One turn answered (the stub's own "Aye."), so the client stays
    // attached at an idle boundary.
    await session.prompt("Start.");
    const client = stopTheClient();

    // The dispose ends the client's input; a client still running a tick
    // later is stopped outright.
    const stoppedAt = performance.now();
    session.dispose();
    at.clock.advance(TICK_PERIOD_MS);
    await session.closed();
    traceClose("crewmate", client, stoppedAt);

    expect(processRunning(client)).toBe(false);
    expect(hasActiveSession(at.configDir)).toBe(false);
  });
});
