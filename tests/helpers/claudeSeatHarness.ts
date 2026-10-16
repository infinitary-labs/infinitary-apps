import { mkdirSync, readFileSync, rmSync, watch } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import type { ClaudeRateLimit } from "../../src/core/claude/claudeEvents";
import { locateClaudeTranscript } from "../../src/core/claude/claudeTranscript";
import { createClaudeSessionFactory } from "../../src/core/claude/session";
import { TICK_PERIOD_MS } from "../../src/core/orchestrator/ticker";
import { appPathsFor } from "../../src/core/paths";
import type { ModelSession, SessionFactory } from "../../src/core/session/session";
import { SessionRecordStore } from "../../src/core/storage/sessionRecordStore";
import { writeMockClaudeClient } from "../e2e/mockClaudeClient";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  type StubApi,
  type StubRequest,
  writeAnthropicToolUse,
} from "./anthropicDialect";
import { scratchDir } from "./scratchDirs";
import type { ScriptedArgs, ScriptedCall } from "./scriptedCalls";
import { type SeatTestSpec, seatSpec } from "./seatSession";

/**
 * The Claude seat's hermetic harness (W1 S6), shared by the seat's
 * integration test and the recording of the Claude-served replay fixture
 * (W1 S11): the SDK's own co-released client, boxed by the e2e stub
 * (`tests/e2e/mockClaudeClient.ts` turn mode: a throwaway config dir, a
 * dummy subscription token, a Keychain shim), pointed at a local stub of the
 * Anthropic API whose answers each caller scripts. No credential is read, no
 * sign-in starts, nothing is billed, and nothing reaches the network.
 */

export function answerTool<N extends ScriptedCall["name"]>(
  request: StubRequest,
  res: ServerResponse,
  name: N,
  args: ScriptedArgs<N>,
): void {
  beginAnthropicStream(res, 42, request.n);
  writeAnthropicToolUse(res, 0, {
    id: `toolu_${request.n}`,
    name: `mcp__infinitary__${name}`,
    args,
  });
  finishAnthropicStream(res, "tool_use", 7);
}

/** The newest message is the client's answer to a tool call. */
export function answersTool(request: StubRequest): boolean {
  const last = [...(request.body.messages ?? [])].reverse().find((m) => m.role === "user");
  return JSON.stringify(last?.content ?? "").includes('"tool_result"');
}

/** Everything the model is shown after the assistant's last tool call, as one string. */
export function afterLastToolCall(request: StubRequest): string {
  const messages = request.body.messages ?? [];
  const at = messages
    .map((m) => JSON.stringify(m.content))
    .findLastIndex((c) => c.includes('"tool_use"'));
  return JSON.stringify(messages.slice(at + 1));
}

/**
 * Resolves once the client's own transcript of a session carries a line the
 * predicate accepts: an order the client itself writes, never a clock.
 */
export function clientRecords(
  b: Pick<ClaudeSeatBox, "configDir" | "cwd"> & Partial<Pick<ClaudeSeatBox, "onCleanup">>,
  sessionId: string,
  match: (entry: Record<string, unknown>) => boolean,
): Promise<void> {
  const projects = join(b.configDir, "projects");
  mkdirSync(projects, { recursive: true });
  return new Promise((resolve) => {
    const found = () => {
      const file = locateClaudeTranscript({ configDir: b.configDir, cwd: b.cwd, sessionId });
      if (!file) return false;
      return readFileSync(file, "utf8")
        .split("\n")
        .some((line) => {
          try {
            return match(JSON.parse(line) as Record<string, unknown>);
          } catch {
            return false;
          }
        });
    };
    const watcher = watch(projects, { recursive: true }, () => {
      if (!found()) return;
      watcher.close();
      resolve();
    });
    b.onCleanup?.(() => watcher.close());
    if (found()) {
      watcher.close();
      resolve();
    }
  });
}

/** The client queued this text: the order that proves a steer is in its hands. */
export function enqueued(text: string): (entry: Record<string, unknown>) => boolean {
  return (entry) =>
    entry.type === "queue-operation" && entry.operation === "enqueue" && entry.content === text;
}

export type ClaudeSeatBox = {
  home: string;
  cwd: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  store: SessionRecordStore;
  logs: string[];
  /** Claude's session factory over the box, as the agent holds it. */
  sessions: SessionFactory;
  /** Opens the seat preset through it, its record in the box's store. */
  factory: (spec: SeatTestSpec) => Promise<ModelSession>;
  readings: ClaudeRateLimit[];
  stub: string;
  /** Release a tool gate or watcher even when its test fails before releasing it. */
  onCleanup: (release: () => void) => void;
  /** Drain a raw protocol consumer before the box's directories can be removed. */
  drained: (work: Promise<void>) => void;
};

/** Every box's writers, until `seatBoxesFlushed` stops them and sees their stamps land. */
const boxedCleanups: (() => Promise<void>)[] = [];

/**
 * Stops all boxed clients (including ones a failed test stranded), drains
 * their consumers, then flushes sidecars and removes scratch homes and clients.
 */
export async function seatBoxesFlushed(): Promise<void> {
  await Promise.all(boxedCleanups.splice(0).map((cleanup) => cleanup()));
}

/**
 * One throwaway HOME with the boxed client in it, and a seat factory over
 * it. The HOME doubles as the app's userData: the seat's record lands in
 * `appPathsFor(home).firstmateClaudeDir`. The boxed client is the SDK's own
 * unless `client` names another, such as the one the machine has installed.
 */
export function claudeSeatBox(api: StubApi, client?: string): ClaudeSeatBox {
  const home = scratchDir("infinitary-claude-seat-home-");
  const stub = writeMockClaudeClient(home, {
    turns: {
      baseUrl: api.url,
      credential: "subscription",
      maxRetries: 0,
      ...(client ? { client } : {}),
    },
  });
  const cwd = join(home, "firstmate", "home");
  mkdirSync(cwd, { recursive: true });
  // What the app would read from the host, boxed: its HOME and the client.
  const env = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
  const claudeDir = appPathsFor(home).firstmateClaudeDir;
  const store = new SessionRecordStore(claudeDir);
  const opened = new Set<ModelSession>();
  const opening = new Set<Promise<ModelSession>>();
  const upkeep = new Set<(now: number) => void>();
  const releases: (() => void)[] = [];
  const drains: Promise<void>[] = [];
  let cleaning = false;
  boxedCleanups.push(async () => {
    cleaning = true;
    for (const release of releases) release();
    await Promise.allSettled(opening);
    // Abort releases even an unanswered inference. The host clock's own
    // hygiene then stops any attachment still alive after its input ends.
    await Promise.all([...opened].map((session) => session.abort("The seat test has ended.")));
    for (const session of opened) session.dispose();
    for (const tick of upkeep) tick(Date.now() + TICK_PERIOD_MS);
    await Promise.all([...opened].map((session) => session.closed()));
    await Promise.all(drains);
    await store.flushed();
    rmSync(home, { recursive: true, force: true });
  });
  const readings: ClaudeRateLimit[] = [];
  const logs: string[] = [];
  // The boxed client keeps its config (and so its transcripts) in HOME/.claude.
  const configDir = join(home, ".claude");
  const rawSessions = createClaudeSessionFactory({
    configDir,
    records: (recordDir) => {
      if (recordDir !== claudeDir) throw new Error(`the seat's record is not in ${recordDir}`);
      return store;
    },
    clock: {
      now: () => Date.now(),
      register: (_name, _period, tick) => {
        upkeep.add(tick);
        return () => upkeep.delete(tick);
      },
    },
    onRateLimit: (_accountId, reading) => readings.push(reading),
    log: (line) => logs.push(line),
    env: () => env,
  });
  const sessions: SessionFactory = {
    backend: rawSessions.backend,
    controlProfile: rawSessions.controlProfile,
    open: async (spec) => {
      if (cleaning) throw new Error("The Claude seat box has closed.");
      const pending = rawSessions.open(spec);
      opening.add(pending);
      let session: ModelSession;
      try {
        session = await pending;
      } finally {
        opening.delete(pending);
      }
      opened.add(session);
      if (cleaning) {
        session.dispose();
        await session.closed();
        throw new Error("The Claude seat box has closed.");
      }
      return session;
    },
  };
  const factory = (spec: SeatTestSpec) => sessions.open(seatSpec({ ...spec, claudeDir }));
  return {
    home,
    cwd,
    configDir,
    env,
    store,
    logs,
    sessions,
    factory,
    readings,
    stub,
    onCleanup: (release) => {
      if (cleaning) release();
      else releases.push(release);
    },
    drained: (work) => drains.push(work),
  };
}
