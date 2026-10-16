import { mkdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
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
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { CLAUDE_MODEL_PROVIDER, createClaudeSessionFactory } from "./session";

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

/** The model calls the waiting tool once, then answers with what it got. */
function callTheToolOnce(): void {
  api.answer((request: StubRequest, res: ServerResponse) => {
    beginAnthropicStream(res, 50, request.n);
    if (!request.raw.includes('"tool_result"')) {
      const name =
        request.body.tools?.find((tool) => tool.name === TOOL || tool.name.endsWith(`__${TOOL}`))
          ?.name ?? TOOL;
      writeAnthropicToolUse(res, 0, { id: `toolu_wait_${request.n}`, name, args: {} });
      finishAnthropicStream(res, "tool_use", 5);
      return;
    }
    writeAnthropicText(res, 0, "Done.");
    finishAnthropicStream(res, "end_turn", 2);
  });
}

/** One turn on the boxed client whose one tool waits, with `env` laid over the box's. */
async function waitInATool(env: Record<string, string>): Promise<string> {
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
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
          return { text: ANSWERED };
        },
      }),
    ],
    shape: { turns: "one" },
  };
  const first = api.requests.length;
  callTheToolOnce();
  const session = await factory.open(spec);
  try {
    await session.prompt("Wait for the home.");
  } finally {
    session.dispose();
    await session.closed();
  }
  const answered = api.requests.slice(first).find((request) => request.raw.includes("tool_result"));
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

  it("waits for the tool under the wait a computer that runs work sets", async () => {
    expect(Number(PLACED_CLAUDE_ENV.MCP_TOOL_TIMEOUT)).toBeGreaterThan(1e8);
    const result = await waitInATool(PLACED_CLAUDE_ENV);
    expect(result).toContain(ANSWERED);
    expect(result).not.toMatch(/"is_error":\s*true/);
  });
});
