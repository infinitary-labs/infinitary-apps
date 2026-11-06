import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { sdkBundledClaudeClient, writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
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
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor, crewmateSessionsDir } from "../paths";
import { LOCAL_MACHINE_ID } from "../session/session";
import { CLAUDE_SEAT_TOOL_PREFIX } from "../storage/sessionReader";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { resolveClaudeExecutable } from "./claudeCli";
import { CLAUDE_MODEL_PROVIDER } from "./claudeQueryCore";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { claudeFullToolNameLine } from "./claudeTaskTools";
import { createClaudeSessionFactory } from "./session";

/**
 * A Claude crewmate that calls one of the app's tools by the name its
 * instructions use, on the client the product would run (the installed one,
 * else the SDK's own), boxed (`tests/e2e/mockClaudeClient.ts` turn mode)
 * against a local stub API and opened from the crewmate preset with a
 * project skill staged, as a crewmate in a working copy with skills is:
 * staging sets the client's `disableAllHooks`.
 *
 * INF-2835: across one day's sessions, ten calls of `note_progress`,
 * `report`, `tasks` and `read_workflow` came back as the client's bare "No
 * such tool available", and half of those crewmates moved on without the
 * call. The client serves each app tool as `mcp__infinitary__<name>`, so the
 * refusal must carry that full name for the next call to be the right one.
 */

// One client start with a staged skill and three answers: the Mac's fastest
// of three runs is 0.418 s. On the hosted Linux check machine the same shape
// (claudeAttribution's crewmate with a staged skill) measured 2.919 s at its
// slowest per case; five times that, rounded up to a whole 5 s: 15 s.
vi.setConfig({ testTimeout: 15_000 });

const MODEL = "claude-haiku-4-5";
/** The progress line the crewmate meant to note, in the words a crewmate used. */
const PROGRESS = "Found where the refusal comes from; reading the code path next";

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

/** The tool result the client sent back for a call, as the model reads it. */
function resultFor(request: StubRequest | undefined, callId: string): string {
  for (const message of request?.body.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as { type?: string; tool_use_id?: string }[]) {
      if (block.type === "tool_result" && block.tool_use_id === callId) {
        return JSON.stringify(block);
      }
    }
  }
  return "";
}

/**
 * The model's side: note progress by the bare name, then, if the refusal
 * named the full one, call that, then end the turn.
 */
function notesProgressByItsOwnName(callId: string): void {
  const first = api.requests.length;
  api.answer((request: StubRequest, res: ServerResponse) => {
    const index = request.n - first - 1;
    if (
      index === 0 ||
      (index === 1 && resultFor(request, callId).includes(CLAUDE_SEAT_TOOL_PREFIX))
    ) {
      beginAnthropicStream(res, 42, request.n);
      writeAnthropicToolUse(res, 0, {
        id: index === 0 ? callId : `${callId}_again`,
        name: index === 0 ? "note_progress" : `${CLAUDE_SEAT_TOOL_PREFIX}note_progress`,
        args: { text: PROGRESS },
      });
      finishAnthropicStream(res, "tool_use", 7);
      return;
    }
    answerText(request, res, "Noted.");
  });
}

it("answers a call of an app tool by its own name with the full name, and the next call reaches the tool", async () => {
  const home = scratchDir("infinitary-claude-tool-names-home-");
  const stub = writeMockClaudeClient(home, {
    turns: {
      baseUrl: api.url,
      credential: "subscription",
      maxRetries: 0,
      client: resolveClaudeExecutable() ?? sdkBundledClaudeClient(),
    },
  });
  const cwd = join(home, "worktrees", "repo");
  mkdirSync(join(cwd, ".claude", "skills", "release-notes"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "skills", "release-notes", "SKILL.md"),
    "---\nname: release-notes\ndescription: How a change adds its release note.\n---\nAdd one note per change.\n",
  );
  execFileSync("git", ["init", "-q", cwd]);
  const paths = appPathsFor(scratchDir("infinitary-claude-tool-names-app-"));
  const store = new SessionRecordStore(crewmateSessionsDir(paths, "task-1"));
  stores.push(store);
  const factory = createClaudeSessionFactory({
    configDir: join(home, ".claude"),
    env: () => ({ PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub }),
    clock: { now: () => Date.now(), register: () => () => {} },
    log: () => {},
    records: () => store,
  });
  const delegate = crewmateToolDelegate();
  const spec = crewmateSessionSpec(
    paths,
    {
      ...delegate,
      machineId: LOCAL_MACHINE_ID,
      taskId: "task-1",
      cwd,
      model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
    },
    { backend: "claude", accountId: "acct_claude" },
  );
  const first = api.requests.length;
  notesProgressByItsOwnName("toolu_progress");
  const session = await factory.open(spec);
  try {
    await session.prompt("Record where the work stands.");
  } finally {
    session.dispose();
    await session.closed();
  }
  const requests = api.requests.slice(first);
  // The skill is staged, so the client runs with `disableAllHooks`.
  expect(requests[0]?.raw).toContain("project:release-notes");
  // The client serves the app's tools under the full name only, and none of
  // its own under an app tool's bare name, so a bare call is always refused.
  const served = (requests[0]?.body.tools ?? []).map((tool) => tool.name);
  expect(served).toContain(`${CLAUDE_SEAT_TOOL_PREFIX}note_progress`);
  expect(served.filter((name) => spec.tools.some((tool) => tool.name === name))).toEqual([]);
  // The client's refusal comes back with the full name in the same result.
  const refused = resultFor(requests[1], "toolu_progress");
  expect(refused).toContain("No such tool available: note_progress");
  expect(refused).toContain(claudeFullToolNameLine("note_progress"));
  // The next call, by that name, reaches the app's tool: the note is taken.
  expect(delegate.calls).toEqual([{ callback: "onProgress", input: PROGRESS }]);
  // A call that reached its tool carries no such line.
  expect(resultFor(requests[2], "toolu_progress_again")).not.toContain(
    claudeFullToolNameLine("note_progress"),
  );
});
