import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { sdkBundledClaudeClient, writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import { answerText, type StubApi, startStubApi } from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateContractStamp, crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor, crewmateSessionsDir } from "../paths";
import { LOCAL_MACHINE_ID, type SessionResume, type SessionSpec } from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import { resolveClaudeExecutable } from "./claudeCli";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { CLAUDE_MODEL_PROVIDER, createClaudeSessionFactory } from "./session";

// Each case starts the boxed client three or four times in turn. Fastest
// of three Mac runs: 1.285 s on the SDK's own client, 1.192 s installed;
// the Linux checks start a client in about 2 s (claudeCrewAgents), so four
// starts there, five times, rounded up to 40 s.
vi.setConfig({ testTimeout: 40_000 });

/**
 * A Claude crewmate's conversation across an upgrade, on the client the
 * product would run (the installed one, else the SDK's own), boxed
 * (`tests/e2e/mockClaudeClient.ts` turn mode) against a local stub API and
 * opened through Claude's factory from the crewmate preset, the way the
 * supervisor opens it. The installed client resumes a conversation on the
 * system prompt and tool descriptions it recorded at its start (measured on
 * 2.1.295), and on the tool list too, offering a tool the task has lost
 * (measured on 2.1.306): reopened by a build whose crewmate instructions or
 * a tool it had changed, or with a tool its task lost, the crewmate starts
 * a new conversation that serves the build's own; reopened by the same
 * build, it resumes.
 */

const MODEL = "claude-haiku-4-5";
/** Every crewmate prompt opens with it; the client's own housekeeping does not. */
const CREWMATE = "You are a crewmate";
/** What an upgrade adds to the crewmate's prompt, and to one tool's description. */
const NEW_RULE = "A rule this build added for every crewmate.";
const REWORDED = "This build reworded the report tool.";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi((body) => JSON.stringify(body.system ?? "").includes(CREWMATE));
  api.answer((request, res) => answerText(request, res, "Noted."));
});

afterAll(async () => {
  await api.close();
});

const stores: SessionRecordStore[] = [];

afterEach(async () => {
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
});

/** Opt-in, credential-free evidence of what each request carried. */
function evidence(journey: string, observed: unknown): void {
  if (process.env.INFINITARY_CLAUDE_CREW_EVIDENCE === "1") {
    console.info("claude-crew-contract-evidence", JSON.stringify({ journey, observed }));
  }
}

/** A crewmate's box: a throwaway HOME with the client in it, a working copy, and its task's record. */
function crewmate() {
  const home = scratchDir("infinitary-claude-contract-home-");
  const installed = resolveClaudeExecutable();
  const client = installed ?? sdkBundledClaudeClient();
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, credential: "subscription", maxRetries: 0, client },
  });
  const cwd = join(home, "worktrees", "repo");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  const paths = appPathsFor(scratchDir("infinitary-claude-contract-app-"));
  const store = new SessionRecordStore(crewmateSessionsDir(paths, "task-1"));
  stores.push(store);
  const env = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
  const factory = createClaudeSessionFactory({
    configDir: join(home, ".claude"),
    env: () => env,
    clock: { now: () => Date.now(), register: () => () => {} },
    log: () => {},
    records: () => store,
  });
  const { calls: _calls, ...every } = crewmateToolDelegate();
  /** This build's crewmate, with the tools its task's callbacks bind. */
  const spec = (delegate: Partial<typeof every> = every) =>
    crewmateSessionSpec(
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
  /** One turn on the conversation `resume` names, then the client exits as at a quit. */
  const turn = async (opened: SessionSpec, text: string, resume?: string) => {
    if (opened.shape.turns !== "rolling") throw new Error("A crewmate's session is rolling.");
    const resumed: SessionResume | undefined = resume
      ? { backend: "claude", sessionId: resume }
      : undefined;
    const session = await factory.open({
      ...opened,
      shape: { ...opened.shape, record: { ...opened.shape.record, resume: resumed } },
    });
    const renewal = session.takeRenewal();
    const at = api.requests.length;
    await session.prompt(text);
    session.dispose();
    await session.closed();
    await store.flushed();
    const request = api.requests[at];
    return {
      id: session.sessionId,
      renewal,
      system: JSON.stringify(request?.body.system ?? []),
      messages: JSON.stringify(request?.body.messages ?? []),
      tools: (request?.body.tools ?? []).map((tool) => tool.name),
      raw: request?.raw ?? "",
    };
  };
  return { client, store, spec, turn };
}

/** The next build's spec: the crewmate preset's, with words it changed, stamped as the preset stamps it. */
function upgraded(spec: SessionSpec, change: { prompt?: string; report?: string }): SessionSpec {
  if (spec.shape.turns !== "rolling") throw new Error("A crewmate's session is rolling.");
  const instructions = change.prompt
    ? `${spec.instructions.base}\n\n${change.prompt}`
    : spec.instructions.base;
  const tools = spec.tools.map((tool) =>
    tool.name === "report" && change.report
      ? { ...tool, description: `${tool.description} ${change.report}` }
      : tool,
  );
  return {
    ...spec,
    instructions: { base: instructions },
    tools,
    shape: {
      ...spec.shape,
      record: { ...spec.shape.record, stamp: crewmateContractStamp(instructions, tools) },
    },
  };
}

it("starts a new conversation on the build's own instructions after an upgrade changed them, and resumes on the same build", async () => {
  const c = crewmate();
  const build = c.spec();
  const started = await c.turn(build, "Remember the word cobalt.");
  // The same build reopens the same conversation, its earlier turn in it.
  const same = await c.turn(build, "Which word?", started.id);
  expect(same.id).toBe(started.id);
  expect(same.renewal).toBeUndefined();
  expect(same.messages).toContain("cobalt");
  // The next build added a rule: a reopened conversation would serve the
  // prompt it started on, so the crewmate moves to a new one that serves it.
  const next = upgraded(build, { prompt: NEW_RULE });
  const after = await c.turn(next, "Carry on.", started.id);
  expect(after.renewal).toEqual({ from: started.id, changed: ["prompt"] });
  expect(after.id).not.toBe(started.id);
  expect(after.system).toContain(NEW_RULE);
  expect(after.messages).not.toContain("cobalt");
  // The earlier conversation's record stays.
  expect(JSON.stringify(c.store.entries(started.id))).toContain("Remember the word cobalt.");
  // The new conversation resumes on that build from here on.
  const again = await c.turn(next, "And again.", after.id);
  expect(again).toMatchObject({ id: after.id, renewal: undefined });
  expect(again.system).toContain(NEW_RULE);
  expect(again.messages).toContain("Carry on.");
  evidence("prompt-upgrade", {
    client: c.client,
    sameBuild: { resumed: same.id === started.id, history: same.messages.includes("cobalt") },
    upgraded: { renewal: after.renewal, newRule: after.system.includes(NEW_RULE) },
    nextOpen: { resumed: again.id === after.id },
  });
});

it("starts a new conversation when an upgrade reworded a tool it had, or its task lost one", async () => {
  const c = crewmate();
  const build = c.spec();
  const started = await c.turn(build, "Remember the word cobalt.");
  // The task lost a tool: a reopened conversation would still offer it
  // (INF-750), so the crewmate moves to a new one that serves the set it
  // is handed.
  const { onOpenChange: _openChange, calls: _calls, ...fewer } = crewmateToolDelegate();
  const lost = await c.turn(c.spec(fewer), "Which word?", started.id);
  expect(lost.renewal).toEqual({ from: started.id, changed: ["prompt"] });
  expect(lost.id).not.toBe(started.id);
  expect(lost.messages).not.toContain("cobalt");
  expect(lost.tools).not.toContain("mcp__infinitary__open_change");
  expect(lost.tools).toContain("mcp__infinitary__report");
  // The next build reworded the report tool: a reopened conversation would
  // describe it the old way, so the crewmate moves to a new one.
  const after = await c.turn(upgraded(build, { report: REWORDED }), "Carry on.", started.id);
  expect(after.renewal).toEqual({ from: started.id, changed: ["prompt"] });
  expect(after.id).not.toBe(started.id);
  expect(after.raw).toContain(REWORDED);
  evidence("tool-upgrade", {
    client: c.client,
    lostTool: { renewal: lost.renewal, offered: lost.tools.length },
    reworded: { renewal: after.renewal, described: after.raw.includes(REWORDED) },
  });
});
