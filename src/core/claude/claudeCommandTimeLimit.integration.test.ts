import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { type StubApi, startStubApi } from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { LOCAL_MACHINE_ID } from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { resolveClaudeExecutable } from "./claudeCli";
import { CLAUDE_MODEL_PROVIDER, type ClaudeQueryFactory } from "./claudeQueryCore";
import { CLAUDE_CODING_ENV, CLAUDE_COMMAND_TIME_CEILING_MS } from "./claudeSessionOptions";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

// Measured on the Mac with the installed 2.1.317: the one case's slowest of
// five runs 3.12 s for its two client starts; five times that, rounded up to
// a whole 5 s: 20 s.
vi.setConfig({ testTimeout: 20_000 });

/**
 * A Claude crewmate's commands may ask for a time limit of up to 3 days (the
 * captain, 2026-11-04, after INF-2490 and INF-2225 lost queued heavy runs to
 * the client's 2-hour background ceiling while still waiting in the
 * computer's line: "change highest to 3 days, not 24 which is too much").
 * Every coding session sets the client's `BASH_MAX_TIMEOUT_MS`
 * (`CLAUDE_CODING_ENV`), on the client the product would run - the override,
 * else the installed one, else the SDK's own copy - boxed by the e2e stub
 * (`tests/e2e/mockClaudeClient.ts` turn mode) and opened through Claude's
 * factory the way the supervisor opens it.
 *
 * The client tells the model the limits it enforces in its Bash tool: the
 * foreground ceiling on every version, and on a client that stops background
 * commands (the installed 2.1.317; the SDK's 2.1.234 has no such limit) the
 * background default and ceiling, the same figure that caps each background
 * command's own limit. The case reads that tool from the crewmate's request:
 * both ceilings are 3 days, and the background default is the client's own.
 * A control proves the case would see the client's defaults: with the setting
 * taken out, neither ceiling is 3 days.
 */

const MODEL = "claude-haiku-4-5";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  await api.close();
});

const stores: SessionRecordStore[] = [];

afterEach(async () => {
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

/** A crewmate in a box of its own, opened through a factory that runs the SDK's query (or the one handed in). */
function boxedCrewmate(sdkQuery?: ClaudeQueryFactory) {
  const home = scratchDir("infinitary-claude-time-limit-home-");
  const client = resolveClaudeExecutable();
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, maxRetries: 0, ...(client ? { client } : {}) },
  });
  const cwd = join(home, "worktrees", "repo");
  mkdirSync(cwd, { recursive: true });
  const env = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
  const factory = createClaudeSessionFactory({
    configDir: join(home, ".claude"),
    env: () => env,
    clock: { now: () => Date.now(), register: () => () => {} },
    log: () => {},
    records: (dir) => {
      const store = new SessionRecordStore(dir);
      stores.push(store);
      return store;
    },
    ...(sdkQuery ? { query: sdkQuery } : {}),
  });
  const spec = crewmateSessionSpec(
    appPathsFor(scratchDir("infinitary-claude-time-limit-app-")),
    {
      ...crewmateToolDelegate(),
      machineId: LOCAL_MACHINE_ID,
      cwd,
      model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
    },
    { backend: "claude", accountId: "acct_claude_time_limit" },
  );
  return { factory, spec };
}

type ServedTool = {
  name?: string;
  input_schema?: { properties?: Record<string, { description?: string }> };
};

/** The limits the client served the crewmate in its Bash tool, in milliseconds. */
type ServedLimits = {
  foregroundCeiling: number | undefined;
  background: { default: number; ceiling: number } | undefined;
};

/** Runs one turn of the crewmate and reads the limits its Bash tool was served with. */
async function servedLimits(crewmate: ReturnType<typeof boxedCrewmate>): Promise<ServedLimits> {
  const from = api.requests.length;
  const session = await crewmate.factory.open(crewmate.spec);
  await session.prompt("Run the build in the background.");
  session.dispose();
  await session.closed();
  const tools = api.requests
    .slice(from)
    .flatMap((request) => (request.body.tools ?? []) as ServedTool[]);
  const properties = tools.find((tool) => tool.name === "Bash")?.input_schema?.properties ?? {};
  const foreground = /Optional timeout in milliseconds \(max (\d+)/.exec(
    properties.timeout?.description ?? "",
  );
  const background = /\(default (\d+) ms, max (\d+) ms\)/.exec(
    properties.run_in_background?.description ?? "",
  );
  return {
    foregroundCeiling: foreground ? Number(foreground[1]) : undefined,
    background: background
      ? { default: Number(background[1]), ceiling: Number(background[2]) }
      : undefined,
  };
}

/** The SDK's query with the time limit setting taken out of the environment it is handed. */
const withClientDefault: ClaudeQueryFactory = ({ prompt, options }) => {
  const env = { ...options.env };
  for (const key of Object.keys(CLAUDE_CODING_ENV)) delete env[key];
  return query({ prompt, options: { ...options, env } });
};

describe("the longest time limit a Claude crewmate's command may ask for", () => {
  it("is 3 days in the foreground and the background, with the client's own background default", async () => {
    const raised = await servedLimits(boxedCrewmate());
    const own = await servedLimits(boxedCrewmate(withClientDefault));

    expect(raised.foregroundCeiling, "the client served the Bash tool's ceiling").toBe(
      CLAUDE_COMMAND_TIME_CEILING_MS,
    );
    expect(own.foregroundCeiling, "the control serves the client's own ceiling").toBeDefined();
    expect(own.foregroundCeiling).not.toBe(CLAUDE_COMMAND_TIME_CEILING_MS);
    // A client that stops background commands serves both figures; one that
    // has no background limit serves neither, with or without the setting.
    expect(raised.background === undefined, "both sessions ran the same client").toBe(
      own.background === undefined,
    );
    if (raised.background && own.background) {
      expect(raised.background.ceiling, "the background ceiling").toBe(
        CLAUDE_COMMAND_TIME_CEILING_MS,
      );
      expect(own.background.ceiling).not.toBe(CLAUDE_COMMAND_TIME_CEILING_MS);
      expect(raised.background.default, "the background default stays the client's own").toBe(
        own.background.default,
      );
    }
  });
});
