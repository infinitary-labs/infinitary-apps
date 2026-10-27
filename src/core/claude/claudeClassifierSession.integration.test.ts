import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_DECISIONS } from "@shared/decisions";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  writeAnthropicEvent,
  writeAnthropicText,
} from "../../../tests/helpers/anthropicDialect";
import { startClassifierTestClock } from "../../../tests/helpers/classifierClock";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { AdaptedDecisionModel, DecisionModels } from "../decisions/decisionModel";
import { questionSessionSpec } from "../decisions/questionSession";
import { CLASSIFIER_MAX_OUTPUT_TOKENS } from "../orchestrator/seat";
import { buildKindClassifierInstruction } from "../pi/piResources";
import { buildClassifierPrompt, DecisionKindClassifier } from "../routing/decisionKindClassifier";
import { KIND_SOURCE, type KindVerdict } from "../routing/kindClassifier";
import type { SessionEvent } from "../session/session";
import { hasActiveSession, resetStoreLeasesForTest } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

/**
 * The kind classifier on Claude (W1 S10) against the REAL client,
 * hermetically: the SDK's own co-released client, boxed by the e2e stub
 * (`tests/e2e/mockClaudeClient.ts` turn mode: a throwaway config dir, a
 * dummy subscription token, a Keychain shim) and pointed at a local stub of
 * the Anthropic API. No credential is read, no sign-in starts, nothing is
 * billed, and nothing reaches the network.
 *
 * What it settles that no scripted test can: a cold client spawn plus one
 * turn returns the scripted kind, the served request carries the question's
 * instruction and no tools, that hidden thinking has room before the
 * one-word answer (INF-1451),
 * that an answer the cap cut short is read and the client's own re-asking
 * stopped, and that the call leaves no transcript. A cancel and a 401 or
 * 403 refusal on this same client are the session contract's question cases
 * (`claudeSession.contract.integration.test.ts`); how a cut-off reaches the
 * account is `decisionKindClassifier.test.ts`'s.
 */

// Measured 2026-09-26 on the Mac mini, six runs (docs/test-cohorts.md): the
// slowest tests (a cut-short answer and a cancel, each ending with the
// SDK's roughly 2 s close of a stopped client) took 2.6 s in their fastest
// run and 2.7 s at worst; five times, rounded up to a whole 5 s. A cold classifier call - the client's spawn plus one turn - took 0.6
// to 1.4 s. INF-1614: ordinary runs now count the existing load clock in
// both the adapter and scorer deadlines; only performance runs grade those
// 15 seconds on the wall clock. Pi SDK imports stay refused in the scorer.
vi.setConfig({ testTimeout: 15_000 });

const MODEL = "claude-haiku-4-5";
const ACCOUNT = "acct_claude";
const REPO_ROOT = resolve(__dirname, "../../..");
const INSTRUCTION = buildKindClassifierInstruction();

type StubRequest = {
  n: number;
  raw: string;
  body: {
    tools?: unknown[];
    system?: unknown;
    model?: string;
    max_tokens?: number;
    thinking?: unknown;
    output_config?: { effort?: string };
  };
};
type Reply = (request: StubRequest, res: ServerResponse) => void;

/** A local Anthropic API; only the classifier's own requests are scripted and kept. */
type StubApi = {
  url: string;
  requests: StubRequest[];
  answer: (reply: Reply) => void;
  close: () => Promise<void>;
};

async function startStubApi(): Promise<StubApi> {
  const requests: StubRequest[] = [];
  let reply: Reply = (request, res) => answerText(request, res, "chore");
  const open = new Set<ServerResponse>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: StubRequest["body"] = {};
      try {
        body = JSON.parse(raw) as StubRequest["body"];
      } catch {
        // Not a messages request.
      }
      // The classifier's request is the one serving the kind instruction;
      // anything else is the client's own housekeeping.
      if (!req.url?.includes("/messages") || !JSON.stringify(body.system ?? "").includes("kinds")) {
        answerText({ n: 0 }, res, "ok");
        return;
      }
      const request: StubRequest = { n: requests.length + 1, raw, body };
      requests.push(request);
      open.add(res);
      res.on("close", () => open.delete(res));
      reply(request, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    answer: (next) => {
      reply = next;
    },
    close: () =>
      new Promise((done) => {
        for (const res of open) res.destroy();
        server.close(() => done());
      }),
  };
}

function answerText(request: { n: number }, res: ServerResponse, text: string): void {
  beginAnthropicStream(res, 420, request.n);
  writeAnthropicText(res, 0, text);
  finishAnthropicStream(res, "end_turn", 1);
}

let api: StubApi;
let stopClock: () => void;

beforeAll(async () => {
  stopClock = startClassifierTestClock();
  api = await startStubApi();
});

afterAll(async () => {
  try {
    await api.close();
  } finally {
    stopClock();
  }
});

afterEach(() => {
  resetStoreLeasesForTest();
});

type Box = { home: string; cwd: string; configDir: string; stub: string; env: NodeJS.ProcessEnv };

/** One throwaway HOME with the boxed client in it. */
function box(): Box {
  const home = scratchDir("infinitary-claude-classifier-home-");
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, credential: "subscription", maxRetries: 0 },
  });
  const cwd = join(home, "firstmate", "home");
  mkdirSync(cwd, { recursive: true });
  return {
    home,
    cwd,
    // The boxed client keeps its config (and would keep its transcripts) in HOME/.claude.
    configDir: join(home, ".claude"),
    stub,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      INFINITARY_CLAUDE_CLI: stub,
      PI_OFFLINE: "1",
      // The child keeps the same clock mode as this run.
      INFINITARY_PERF_BUDGETS: process.env.INFINITARY_PERF_BUDGETS,
    },
  };
}

/** The app's classifier path, from the kind question down, with only Claude to answer. */
function classifierOn(b: Box, model = MODEL, maxOutputTokens?: number) {
  const claude = createClaudeSessionFactory({ configDir: b.configDir, env: () => b.env });
  const open = claude.open;
  if (maxOutputTokens !== undefined) {
    // Explicit bounds still belong to the session contract; the classifier
    // preset no longer supplies one to Claude (INF-1451).
    claude.open = (spec) =>
      open({
        ...spec,
        bounds: { request: { ...spec.bounds?.request, maxOutputTokens } },
      });
  }
  const adapted = new AdaptedDecisionModel({
    homeDir: b.cwd,
    availableModels: () => [{ provider: "anthropic-claude", id: model, slot: "low" }],
    quotaModels: () => undefined,
    selectAccount: () => ACCOUNT,
    flagshipAccountId: () => null,
    runtimeFor: async () => {
      throw new Error("only Claude is signed in");
    },
    sessions: { claude },
  });
  return new DecisionKindClassifier(
    new DecisionModels({
      settings: { getDecisions: () => DEFAULT_DECISIONS, setDecisions: () => {} },
      adapted,
    }),
  );
}

const WORK = {
  taskId: "task-1",
  title: "Bump the linter",
  goal: "Update the linter to the current minor.",
  userWords: "can you bump the linter please",
  deliverable: "change" as const,
};

function classify(b: Box, model?: string, maxOutputTokens?: number) {
  return classifierOn(b, model, maxOutputTokens).classify(WORK, new AbortController().signal);
}

/** Every transcript the client wrote under the box's config dir. */
function transcripts(b: Box): string[] {
  try {
    return readdirSync(join(b.configDir, "projects"), { recursive: true, encoding: "utf8" }).filter(
      (name) => name.endsWith(".jsonl"),
    );
  } catch {
    return [];
  }
}

describe("the kind classifier on the real Claude client", () => {
  it("answers one kind question from a cold client, leaving no transcript", async () => {
    const b = box();
    api.answer((request, res) => answerText(request, res, "chore"));
    const first = api.requests.length;
    const verdict: KindVerdict = await classify(b);
    expect(verdict).toMatchObject({
      kind: "chore",
      source: `${KIND_SOURCE.classified}anthropic-claude/${MODEL}`,
    });
    const served = api.requests.slice(first);
    expect(served).toHaveLength(1);
    // The question's own instruction is the system prompt, and no tool is served.
    expect(JSON.stringify(served[0]?.body.system)).toContain(
      JSON.stringify(INSTRUCTION).slice(1, -1),
    );
    expect(served[0]?.body.tools ?? []).toEqual([]);
    // The answered client exits on its own and hands the store back; what it
    // left behind is final from then on.
    await vi.waitFor(() => expect(hasActiveSession(b.configDir)).toBe(false));
    expect(transcripts(b)).toEqual([]);
  });

  // Explicit session caps remain supported; INF-1451 removes only the
  // question preset's cap on Claude, not the factory's request-bound seam.
  it.each([MODEL, "claude-sonnet-5", "claude-opus-5-5"])(
    "honors an explicit output cap on %s",
    async (model) => {
      const b = box();
      api.answer((request, res) => answerText(request, res, "chore"));
      const first = api.requests.length;
      const verdict = await classify(b, model, CLASSIFIER_MAX_OUTPUT_TOKENS);
      expect(verdict.kind).toBe("chore");
      const served = api.requests.slice(first);
      expect(served.map((request) => request.body)).toEqual([
        expect.objectContaining({
          model,
          max_tokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
          thinking: { type: "disabled" },
        }),
      ]);
    },
  );

  it("honors an explicit Haiku 5.5 output cap without a thinking budget", async () => {
    const b = box();
    api.answer((request, res) => answerText(request, res, "chore"));
    const first = api.requests.length;
    const verdict = await classify(b, "claude-haiku-5-5", CLASSIFIER_MAX_OUTPUT_TOKENS);
    expect(verdict.kind).toBe("chore");
    const served = api.requests.slice(first);
    expect(served).toHaveLength(1);
    expect(served[0]?.body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      output_config: { effort: "low" },
    });
    // The client omits thinking instead of sending {type: disabled} for the new model.
    expect(served[0]?.body.thinking).toBeUndefined();
  });

  it("lets Sonnet finish hidden thinking before reading its one-word kind (INF-1451)", async () => {
    const b = box();
    const first = api.requests.length;
    // Captured Sonnet reply, INF-1451: 121 hidden thinking tokens and the
    // one-word answer used 124 output tokens. With max_tokens 64, the same
    // request ended with 64 thinking tokens and no text. No thinking text
    // or signature from the live account is kept in this boxed fixture.
    const output = 124;
    api.answer((request, res) => {
      beginAnthropicStream(res, 2, request.n);
      writeAnthropicEvent(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      writeAnthropicEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "boxed-thinking-signature" },
      });
      writeAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      const allowance = request.body.max_tokens ?? 0;
      if (allowance < output) {
        finishAnthropicStream(res, "max_tokens", allowance);
      } else {
        writeAnthropicText(res, 1, "research");
        finishAnthropicStream(res, "end_turn", output);
      }
    });
    const capturedWork = readFileSync(
      join(REPO_ROOT, "tests/fixtures/kind-classifier/answer-lanes.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("//"))
      .map((line) => JSON.parse(line))
      .find((row) => row.title === "Research: crewmate refused to run gh on the user's request");
    expect(capturedWork).toBeDefined();
    // The session transport owns this fact. The adapter's existing cold
    // classifier case above owns its wall clock; this regression does not
    // couple the captured output to how long a local client takes to boot.
    const session = await createClaudeSessionFactory({
      configDir: b.configDir,
      env: () => b.env,
    }).open(
      questionSessionSpec({
        homeDir: b.cwd,
        binding: { backend: "claude", accountId: ACCOUNT },
        model: { provider: "anthropic-claude", id: "claude-sonnet-5-5" },
        instruction: INSTRUCTION,
      }),
    );
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    onTestFinished(async () => {
      session.dispose();
      await session.closed();
    });
    await session.prompt(
      buildClassifierPrompt({
        ...capturedWork,
        taskId: "thinking-only-cutoff",
        deliverable: "answer",
      }),
    );
    expect(events.filter((event) => event.type === "turn_closed")).toEqual([
      { type: "turn_closed", text: "research" },
    ]);
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    session.dispose();
    await session.closed();
    const served = api.requests.slice(first);
    expect(served).toHaveLength(1);
    expect(served[0]?.body.output_config).toMatchObject({ effort: "low" });
    expect(served[0]?.body.tools ?? []).toEqual([]);
    await vi.waitFor(() => expect(hasActiveSession(b.configDir)).toBe(false));
    expect(transcripts(b)).toEqual([]);
  });

  it("reads an answer the output cap cut short, and stops the client asking again", async () => {
    const b = box();
    // A model that explains itself past the cap. The client's own recovery
    // re-asks at once - within milliseconds, so before any stop can reach it
    // - and would ask up to three times, losing the word it already had. The
    // re-ask is held open here, the way a real API is still generating while
    // the client is stopped.
    const first = api.requests.length;
    let reasks = 0;
    let dropped!: () => void;
    const reaskDropped = new Promise<void>((resolve) => {
      dropped = resolve;
    });
    api.answer((request, res) => {
      if (request.n > first + 1) {
        reasks += 1;
        res.on("close", () => dropped());
        return;
      }
      beginAnthropicStream(res, 420, request.n);
      writeAnthropicText(res, 0, "chore - this is a dependency bump with no design in it, so");
      finishAnthropicStream(res, "max_tokens", 64);
    });
    const verdict = await classify(b, MODEL, CLASSIFIER_MAX_OUTPUT_TOKENS);
    // Read as Pi reads it: the one option word in the text it got.
    expect(verdict).toMatchObject({
      kind: "chore",
      source: `${KIND_SOURCE.classified}anthropic-claude/${MODEL}`,
    });
    // The client is stopped: the one re-ask it had sent is dropped
    // unanswered, it asks nothing more, and the store comes back.
    await reaskDropped;
    await vi.waitFor(() => expect(hasActiveSession(b.configDir)).toBe(false));
    expect(reasks).toBe(1);
  });
});

describe("the kind scorer with a Claude binding", () => {
  it("scores the corpus on the machine's Claude client, no models.json needed", async () => {
    const b = box();
    api.answer((request, res) => answerText(request, res, "fix"));
    const fixtures = join(b.home, "fixtures");
    const sessions = join(fixtures, "evening-real", "firstmate", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "s.jsonl"),
      `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "spawn_crewmate",
              arguments: {
                title: "Fix the meter",
                goal: "The meter test passes again",
                user_words: "the meter test is red, fix it",
              },
            },
          ],
        },
      })}\n`,
    );
    // Exercise the actual startup boundary: importing a shared tool spec
    // must not initialize Pi's generator in a Claude-only scoring process.
    const noPi = join(b.home, "no-pi.mjs");
    writeFileSync(
      noPi,
      `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent" || specifier.includes("/@earendil-works/pi-coding-agent/")) {
      throw new Error("Claude scoring must not load the Pi SDK.");
    }
    return nextResolve(specifier, context);
  },
});
`,
    );
    const out = join(b.home, "report.json");
    // Retire the scorer even when the test's existing budget cuts it short.
    const cancel = new AbortController();
    const first = api.requests.length;
    const scoring = promisify(execFile)(
      process.execPath,
      [
        "--import",
        join(REPO_ROOT, "tests", "helpers", "classifierClock.preload.ts"),
        "--import",
        noPi,
        join(REPO_ROOT, "scripts", "score-kind-classifier.ts"),
        "--provider",
        "anthropic-claude",
        "--model",
        MODEL,
        "--fixtures",
        fixtures,
        "--labels",
        join(b.home, "no-labels.jsonl"),
        "--out",
        out,
      ],
      { cwd: REPO_ROOT, env: b.env, signal: cancel.signal },
    );
    onTestFinished(async () => {
      cancel.abort();
      await scoring.catch(() => {});
    });
    const { stdout, stderr } = await scoring;
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      rows: { kind: string; source: string }[];
    };
    const served = api.requests.slice(first);
    // Keep the real response and request even when an assertion diagnoses a failure.
    const evidence = process.env.INFINITARY_CLASSIFIER_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(join(evidence, "report.json"), readFileSync(out));
      writeFileSync(join(evidence, "scorer.log"), `${stderr}\n${stdout}`);
      writeFileSync(join(evidence, "requests.json"), `${JSON.stringify(served, null, 2)}\n`);
    }
    expect(report.rows).toEqual([
      expect.objectContaining({
        kind: "fix",
        source: `${KIND_SOURCE.classified}anthropic-claude/${MODEL}`,
      }),
    ]);
    expect(JSON.parse(stdout)).toMatchObject({ spawns: 1, kinds: { fix: 1 }, failure_rate: 0 });
    expect(stderr).toContain("Fix the meter");
    expect(served).toHaveLength(1);
    expect(served[0]?.body).toMatchObject({ model: MODEL });
    expect(served[0]?.body.max_tokens).toBeGreaterThan(CLASSIFIER_MAX_OUTPUT_TOKENS);
    expect(served[0]?.body.tools ?? []).toEqual([]);
    expect(transcripts(b)).toEqual([]);
  });
});
