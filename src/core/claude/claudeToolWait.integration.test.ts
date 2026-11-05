import { mkdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  type StubApi,
  type StubRequest,
  startStubApi,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "../../../tests/helpers/anthropicDialect";
import { manualClock } from "../../../tests/helpers/manualClock";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PLACED_CLAUDE_ENV } from "../helper/conversations";
import { LOCAL_MACHINE_ID, type SessionSpec } from "../session/session";
import { boundTool } from "../session/tools";
import { CLAUDE_MODEL_PROVIDER } from "./claudeQueryCore";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { claudeToolOf } from "./claudeTaskTools";
import { createClaudeSessionFactory } from "./session";

/**
 * How long the Claude client lets one of the app's own tools wait, on the
 * SDK's own client, boxed (`tests/e2e/mockClaudeClient.ts` turn mode)
 * against a local stub API: the check piece 8 of multi-machine support
 * starts with. A crewmate whose conversation runs on a computer that runs
 * work waits in a tool for its home, which may be out of reach for a long
 * time (docs/helper.md, "Holding a conversation").
 *
 * The client gives a tool its server's own timeout when one is set, then
 * `MCP_TOOL_TIMEOUT`, then its default of 1e8 ms (about 28 hours, read from
 * the 2.1.234 client's code); the app's in-process tool server has no
 * timeout of its own. A wait of days needs longer, so a computer that runs
 * work sets `MCP_TOOL_TIMEOUT` to the longest a timer holds
 * (`PLACED_CLAUDE_ENV`). These cases show the variable governs the app's
 * tools - a short one cuts a slow tool - and that the long one is taken as
 * a wait, not overflowed into an instant timeout.
 */

// Each case is one client start, one tool that waits and one answer.
// Measured 2026-10-03 on the Mac mini, three runs: the slower case's
// fastest run took 3.2 s; five times it, rounded up to a whole 5 s.
vi.setConfig({ testTimeout: 20_000 });

const MODEL = "claude-haiku-4-5";
const TOOL = "wait_for_home";
const WAIT_MS = 3_000;
const ANSWERED = "The home answered.";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  resetStoreLeasesForTest();
  await api.close();
});

/**
 * The model calls the waiting tool once, then answers with what it got -
 * once `beforeAnswer`, when given, has settled.
 */
function callTheToolOnce(beforeAnswer?: Promise<void>): void {
  api.answer((request: StubRequest, res: ServerResponse) => {
    if (!request.raw.includes('"tool_result"')) {
      beginAnthropicStream(res, 50, request.n);
      const name =
        request.body.tools?.find((tool) => tool.name === TOOL || tool.name.endsWith(`__${TOOL}`))
          ?.name ?? TOOL;
      writeAnthropicToolUse(res, 0, { id: `toolu_wait_${request.n}`, name, args: {} });
      finishAnthropicStream(res, "tool_use", 5);
      return;
    }
    void (beforeAnswer ?? Promise.resolve()).then(() => {
      beginAnthropicStream(res, 50, request.n);
      writeAnthropicText(res, 0, "Done.");
      finishAnthropicStream(res, "end_turn", 2);
    });
  });
}

/** One turn on the boxed client whose one tool waits, with `env` laid over the box's. */
async function waitInATool(
  env: Record<string, string>,
  onSignal?: (signal?: AbortSignal) => void,
  stopTurn = false,
  beforeAnswer?: Promise<void>,
): Promise<string> {
  const home = scratchDir("infinitary-claude-tool-wait-");
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, credential: "subscription", maxRetries: 0 },
  });
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const clock = manualClock();
  const factory = createClaudeSessionFactory({
    configDir: join(home, ".claude"),
    env: () => ({ PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub, ...env }),
    clock,
  });
  let started!: () => void;
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const spec: SessionSpec = {
    machine: LOCAL_MACHINE_ID,
    owner: "task-wait",
    cwd,
    binding: { backend: "claude", accountId: "acct_claude" },
    model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
    thinking: { level: "off" },
    instructions: { base: `Call ${TOOL} once, then say what it answered.` },
    builtins: "none",
    tools: [
      boundTool({
        name: TOOL,
        label: "Wait for the home",
        description: "Waits for the home to answer.",
        parameters: Type.Object({}),
        run: async (_params, signal) => {
          onSignal?.(signal);
          started();
          await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
          return { text: ANSWERED };
        },
      }),
    ],
    shape: { turns: "one" },
  };
  const first = api.requests.length;
  callTheToolOnce(beforeAnswer);
  const session = await factory.open(spec);
  try {
    const turn = session.prompt("Wait for the home.");
    if (stopTurn) {
      await toolStarted;
      await session.abort();
    }
    await turn;
  } finally {
    session.dispose();
    await session.closed();
  }
  const answered = api.requests.slice(first).find((request) => request.raw.includes("tool_result"));
  if (!answered && stopTurn) return "";
  if (!answered) throw new Error("The model never got the tool's result.");
  return answered.raw;
}

describe("how long the Claude client lets an app tool wait", () => {
  it("cuts a tool that outlasts a short MCP_TOOL_TIMEOUT: the variable governs the app's own tools", async () => {
    const result = await waitInATool({ MCP_TOOL_TIMEOUT: "1000" });
    expect(result).not.toContain(ANSWERED);
    expect(result).toContain(`tool \\"${TOOL}\\" timed out after 1s`);
    expect(result).toMatch(/"is_error":\s*true/);
  });

  // Intent: the captain's F2 backstop must hear Claude give up, including when our timer cannot run during sleep.
  it("passes Claude's give-up signal to the bound tool (INF-312 F2)", async () => {
    let received: AbortSignal | undefined;
    // Claude answers the tool's error only once the bound tool has heard it
    // give up, so the turn cannot end, and the session cannot close, before
    // the cancel arrives (INF-821). A lost cancel holds the answer until the
    // test times out.
    let gaveUp!: () => void;
    const heard = new Promise<void>((resolve) => {
      gaveUp = resolve;
    });
    await waitInATool(
      { MCP_TOOL_TIMEOUT: "1000" },
      (signal) => {
        received = signal;
        if (signal?.aborted) gaveUp();
        else signal?.addEventListener("abort", () => gaveUp(), { once: true });
      },
      false,
      heard,
    );
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(true);
  });

  // Intent: the captain narrowed F3 to Claude giving up, excluding an ordinary home stop.
  it.each([
    new Error("The home stopped the turn"),
    String(new McpError(ErrorCode.ConnectionClosed, "The turn was stopped")),
  ])(
    "keeps the real answer on non-timeout Claude cancellation: %s (INF-312 scope)",
    async (reason) => {
      const stop = new AbortController();
      let finish!: () => void;
      let received: AbortSignal | undefined;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const tool = claudeToolOf(
        boundTool({
          name: "finish_change",
          label: "Finish",
          description: "Return the real answer.",
          parameters: Type.Object({}),
          run: async (_params, signal) => {
            received = signal;
            await waiting;
            return { text: "The real change answer." };
          },
        }),
      );
      const result = tool.handler({}, { signal: stop.signal });
      stop.abort(reason);
      expect(received?.aborted).toBe(false);
      finish();
      expect(await result).toMatchObject({
        content: [{ type: "text", text: "The real change answer." }],
      });
    },
  );

  it("does not withdraw a request when the home interrupts the real Claude client (INF-312 scope)", async () => {
    let received: AbortSignal | undefined;
    await waitInATool(
      PLACED_CLAUDE_ENV,
      (signal) => {
        received = signal;
      },
      true,
    );
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
  });

  it("waits for the tool under the wait a computer that runs work sets", async () => {
    expect(Number(PLACED_CLAUDE_ENV.MCP_TOOL_TIMEOUT)).toBeGreaterThan(1e8);
    const result = await waitInATool(PLACED_CLAUDE_ENV);
    expect(result).toContain(ANSWERED);
    expect(result).not.toMatch(/"is_error":\s*true/);
  });
});
