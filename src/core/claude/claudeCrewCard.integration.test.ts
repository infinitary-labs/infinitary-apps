import { mkdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  answerText,
  beginAnthropicStream,
  finishAnthropicStream,
  type StubApi,
  type StubRequest,
  startStubApi,
  writeAnthropicToolUse,
} from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { manualClock } from "../../../tests/helpers/manualClock";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import { LOCAL_MACHINE_ID, type SessionSpec } from "../session/session";
import { bindTools } from "../session/tools";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { CLAUDE_MODEL_PROVIDER, createClaudeSessionFactory } from "./session";

/**
 * A Claude crewmate's completion decision through the real client (FI3-249):
 * the SDK's own client, boxed (`tests/e2e/mockClaudeClient.ts` turn mode),
 * against a local stub API, with the crewmate's own tools as the app binds
 * them. The crewmate is told the host attaches the completion buttons and
 * to declare no labels (`CREWMATE_CARD_ADDENDUM`), so the call the model
 * makes declares the merge alone. The client checks that call against the
 * schema it was served, and the app's tool server checks it again; the
 * card must reach the host, which words the buttons
 * (`CrewSupervisor.withCompletionActions`, held in its own tests).
 */

// One client start, one tool call and one answer. Measured 2026-10-04 on
// the Mac: 0.65 s at its fastest of three runs; five times it is 3.3 s,
// under the 5 s default, so the file carries no budget of its own.

const MODEL = "claude-haiku-4-5";

/** The risk a completion decision declares (FI3-1128): every dimension rated. */
const RISK = {
  blast: { level: "low", why: "Two files in the meter" },
  behavior: { level: "low", why: "Corrects the unit" },
  undo: { level: "low", why: "A revert restores the old meter" },
  evidence: { level: "medium", why: "The meter test" },
  sensitivity: { level: "low", why: "No sign-in, data or release code" },
  novelty: { level: "low", why: "Edits the existing reading" },
  deps: { level: "low", why: "Nothing added" },
};

/** The completion decision as the crewmate's instructions ask for it: the merge, unlabeled, and its risk. */
const COMPLETION = {
  title: "The meter reads true",
  body: "<h3>Why</h3><p>The meter read low.</p>",
  actions: [{ id: "merge", default: true, effect: { kind: "settle", mode: "merge" } }],
  risk: RISK,
};

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  resetStoreLeasesForTest();
  await api.close();
});

/** The model emits the completion decision once, then ends its turn. */
function emitsTheCompletionDecision(): void {
  api.answer((request: StubRequest, res: ServerResponse) => {
    if (request.raw.includes('"tool_result"')) {
      answerText(request, res, "The completion decision is up.");
      return;
    }
    const name =
      request.body.tools?.find((tool) => tool.name.endsWith("__emit_card"))?.name ?? "emit_card";
    beginAnthropicStream(res, 50, request.n);
    writeAnthropicToolUse(res, 0, { id: `toolu_card_${request.n}`, name, args: COMPLETION });
    finishAnthropicStream(res, "tool_use", 5);
  });
}

describe("a Claude crewmate's completion decision, on the real client", () => {
  it("reaches the host with the merge declared alone, no label, and its risk whole", async () => {
    const home = scratchDir("infinitary-claude-crew-card-");
    const stub = writeMockClaudeClient(home, {
      turns: { baseUrl: api.url, credential: "subscription", maxRetries: 0 },
    });
    const cwd = join(home, "work");
    mkdirSync(cwd, { recursive: true });
    const factory = createClaudeSessionFactory({
      configDir: join(home, ".claude"),
      env: () => ({ PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub }),
      clock: manualClock(),
    });
    const delegate = crewmateToolDelegate();
    const spec: SessionSpec = {
      machine: LOCAL_MACHINE_ID,
      owner: delegate.taskId,
      cwd,
      binding: { backend: "claude", accountId: "acct_claude" },
      model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
      thinking: { level: "off" },
      instructions: { base: "Emit the completion decision." },
      builtins: "none",
      tools: bindTools(CREWMATE_TOOLS, delegate),
      shape: { turns: "one" },
    };
    const first = api.requests.length;
    emitsTheCompletionDecision();
    const session = await factory.open(spec);
    try {
      await session.prompt("The checks passed.");
    } finally {
      session.dispose();
      await session.closed();
    }

    // The client handed the call on and the app's tool showed the card.
    const answered = api.requests
      .slice(first)
      .find((request) => request.raw.includes("tool_result"));
    expect(answered?.raw).toContain("Card shown: The meter reads true");
    expect(answered?.raw).not.toMatch(/"is_error":\s*true/);
    await vi.waitFor(() =>
      expect(delegate.calls).toEqual([
        {
          callback: "onCard",
          input: expect.objectContaining({
            title: COMPLETION.title,
            actions: [{ id: "merge", default: true, effect: { kind: "settle", mode: "merge" } }],
            riskDeclaration: RISK,
          }),
        },
      ]),
    );
  });
});
