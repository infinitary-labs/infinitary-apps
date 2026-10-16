import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import type { StubApi } from "../../../tests/helpers/anthropicDialect";
import { clientRecords, enqueued } from "../../../tests/helpers/claudeSeatHarness";
import { manualClock } from "../../../tests/helpers/manualClock";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  describeSessionContract,
  servedByStub,
  startContractApi,
  stubReply,
} from "../../../tests/helpers/sessionContract";
import type { ModelRuntime } from "../pi/types";
import { BoundsWatcher } from "../session/bounds";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { hasActiveSession, resetStoreLeasesForTest } from "./claudeStoreLease";
import { CLAUDE_MODEL_PROVIDER, createClaudeSessionFactory } from "./session";

/**
 * Claude's real-client harness for the session contract
 * (`tests/helpers/sessionContract.ts`), hermetically: the SDK's own
 * co-released client, boxed by the e2e stub (`tests/e2e/mockClaudeClient.ts`
 * turn mode: a throwaway config dir, a dummy subscription token, a Keychain
 * shim) and pointed at the same local stub API, with the same replies, that
 * Pi's harness answers with. No credential is read, no sign-in starts,
 * nothing is billed, and nothing reaches the network. What was served is
 * read off the requests the client really made.
 */

// Measured 2026-09-27 on the Mac mini, six runs (docs/test-cohorts.md): the
// slowest tests (the two aborts, each ending with the SDK's roughly 2 s close
// of a stopped client) took 2.7 s in their fastest run and 2.8 s at worst;
// five times, rounded up to a whole 5 s.
vi.setConfig({ testTimeout: 15_000 });

const MODEL = "claude-haiku-4-5";

let api: StubApi;

beforeAll(async () => {
  api = await startContractApi();
});

afterAll(async () => {
  await api.close();
});

/** Every transcript the client wrote under its config dir. */
function transcripts(configDir: string): string[] {
  try {
    return readdirSync(join(configDir, "projects"), { recursive: true, encoding: "utf8" }).filter(
      (name) => name.endsWith(".jsonl"),
    );
  } catch {
    return [];
  }
}

/** The contract stamps in every sidecar under the app's record dir, in the record's own words. */
function sidecarStamps(dir: string): Record<string, unknown>[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".served.jsonl"));
  } catch {
    return [];
  }
  return names
    .flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.kind === "contract")
    .map(({ kind: _kind, at: _at, ...stamp }) => stamp);
}

/** Every record store a world made: their stamps land before its directories go. */
const stores: SessionRecordStore[] = [];

describeSessionContract({
  name: "Claude, the real client, boxed against a stub API",
  backend: "claude",
  world: async () => {
    const home = scratchDir("infinitary-claude-contract-home-");
    const stub = writeMockClaudeClient(home, {
      turns: { baseUrl: api.url, credential: "subscription", maxRetries: 0 },
    });
    const homeDir = join(home, "firstmate", "home");
    mkdirSync(homeDir, { recursive: true });
    const claudeDir = join(home, "firstmate", "claude");
    // The boxed client keeps its config (and would keep its transcripts) in HOME/.claude.
    const configDir = join(home, ".claude");
    const env = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
    const first = api.requests.length;
    // One store per record dir, as production keeps: the seat's, and a crewmate's.
    const records = new Map<string, SessionRecordStore>();
    const recordsIn = (dir: string): SessionRecordStore => {
      let kept = records.get(dir);
      if (!kept) {
        kept = new SessionRecordStore(dir);
        records.set(dir, kept);
        stores.push(kept);
      }
      return kept;
    };
    const store = recordsIn(claudeDir);
    const clock = manualClock();
    return {
      factory: new BoundsWatcher(clock).factory(
        createClaudeSessionFactory({ configDir, env: () => env, clock, records: recordsIn }),
      ),
      advance: clock.advance,
      binding: { backend: "claude", accountId: "acct_claude" },
      foreignBinding: { backend: "pi", runtime: {} as unknown as ModelRuntime },
      model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
      homeDir,
      paths: {
        firstmateHomeDir: homeDir,
        firstmateSessionsDir: join(home, "firstmate", "sessions"),
        firstmateClaudeDir: claudeDir,
      },
      answer: (reply) => api.answer(stubReply(reply)),
      reached: async () => {
        if (api.requests.length === first) await api.nextRequest();
      },
      // The client writes the steer into its own transcript as it queues it:
      // an order the client itself keeps, never a clock.
      holds: (session, text) =>
        clientRecords({ configDir, cwd: homeDir }, session.sessionId, enqueued(text)),
      served: () => api.requests.slice(first).map(servedByStub),
      records: () => transcripts(configDir),
      stamps: async () => {
        await store.flushed();
        return sidecarStamps(claudeDir);
      },
      released: () => !hasActiveSession(configDir) && api.openRequests() === 0,
    };
  },
  cleanup: async () => {
    resetStoreLeasesForTest();
    await Promise.all(stores.splice(0).map((store) => store.flushed()));
  },
});
