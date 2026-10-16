import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { FmEvent } from "@shared/events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sdkBundledClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  answerText,
  beginAnthropicStream,
  finishAnthropicStream,
  type Reply,
  type StubApi,
  type StubRequest,
  startStubApi,
  writeAnthropicError,
  writeAnthropicText,
} from "../../../tests/helpers/anthropicDialect";
import {
  afterLastToolCall,
  answersTool,
  answerTool,
  type ClaudeSeatBox,
  claudeSeatBox,
  clientRecords,
  enqueued,
  seatBoxesFlushed,
} from "../../../tests/helpers/claudeSeatHarness";
import { firstmateTools } from "../../../tests/helpers/firstmateTools";
import {
  type SeatTestSpec,
  seatSpec as seatSessionSpecOf,
} from "../../../tests/helpers/seatSession";
import { FIRSTMATE_MAX_OUTPUT_TOKENS } from "../orchestrator/seat";
import { buildFirstmateSystemPrompt } from "../pi/piResources";
import { outputCapErrorMessage } from "../session/bounds";
import type { ModelSession, SessionEvent } from "../session/session";
import { type BoundTool, FIRSTMATE_TOOLS } from "../session/tools";
import { resolveClaudeExecutable } from "./claudeCli";
import type { ClaudeRateLimit } from "./claudeEvents";
import { MessageQueue, userMessage } from "./claudeQueryCore";
import { hasActiveSession, resetStoreLeasesForTest } from "./claudeStoreLease";
import { CLAUDE_STEER_PRIORITY, claudeSessionOptions } from "./session";

/**
 * The Claude seat against the REAL client (W1 S6), hermetically, on the
 * seat's harness (`tests/helpers/claudeSeatHarness.ts`): the SDK's own
 * co-released client, boxed by the e2e stub and pointed at a local stub of
 * the Anthropic API that speaks the mock provider's dialect. No credential is read, no sign-in starts, nothing is
 * billed, and nothing reaches the network. The seat runs with the real
 * Firstmate prompt and the Firstmate's 27 real tools, read off a live agent.
 *
 * What it settles that no scripted test can: the steer priority (measured
 * here, then pinned), that the seat settles once per prompt on the client's
 * own idle signal, that interrupt and resume work on the real protocol, that
 * a per-turn effort change reaches the request, that the client's own
 * transcript lands in the app's copy and a fresh start follows its loss, and
 * how a 429 on a spent plan carries its reset. The shared real-client seat
 * contract covers 401/403 refusals (claudeSession.contract.integration.test.ts).
 * The cases on changed instructions run the client the product would run
 * (the installed one, else the SDK's own), which resumes a session on the
 * system prompt it recorded at its start: the seat starts a new one instead.
 */

// Eight-worker Mac remeasurement (docs/test-cohorts.md): slowest test
// 2.174 s at its fastest of three runs, 2.844 s worst; five times, rounded
// up to 5 s. Priorities still use one rolling client rather than redundant starts.
vi.setConfig({ testTimeout: 15_000 });

const MODEL = "claude-opus-5-5";
const ACCOUNT = "acct_claude";

/** Opt-in, credential-free protocol evidence from the actual client and app session. */
function evidence(journey: string, observed: unknown): void {
  if (process.env.INFINITARY_CLAUDE_SEAT_EVIDENCE === "1") {
    console.info("claude-seat-evidence", JSON.stringify({ journey, observed }));
  }
}

/** A tool that waits at a gate: the turn is provably mid-tool while it holds. */
function gated(
  box: ClaudeSeatBox,
  tool: BoundTool,
): { tool: BoundTool; entered: Promise<void>; open: () => void } {
  let entered!: () => void;
  let open!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  box.onCleanup(open);
  return {
    tool: {
      ...tool,
      run: async (params) => {
        entered();
        await gate;
        return tool.run(params);
      },
    },
    entered: enteredPromise,
    open,
  };
}

let api: StubApi;
let tools: BoundTool[];

beforeAll(async () => {
  tools = await firstmateTools();
});

beforeEach(async () => {
  // A seat turn is identified by its prompt even when it needs no tools;
  // the client's own housekeeping does not carry the app's prompt.
  const prompt = buildFirstmateSystemPrompt();
  api = await startStubApi((body) =>
    (body.system ?? []).some((block) => block.text?.includes(prompt)),
  );
});

afterEach(async () => {
  try {
    await seatBoxesFlushed();
  } finally {
    await api.close();
  }
  expect(api.openRequests()).toBe(0);
  resetStoreLeasesForTest();
});

function seatSpec(b: ClaudeSeatBox, overrides: Partial<SeatTestSpec> = {}): SeatTestSpec {
  return {
    cwd: b.cwd,
    sessionsDir: join(b.home, "firstmate", "sessions"),
    binding: { backend: "claude", accountId: ACCOUNT },
    model: { provider: "anthropic-claude", id: MODEL },
    tools,
    instructions: { text: "Answer in one line.", sha: "sha-instructions" },
    ...overrides,
  };
}

function recorder(session: ModelSession): SessionEvent[] {
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

const crewStatus = (): BoundTool => {
  const found = tools.find((tool) => tool.name === "crew_status");
  if (!found) throw new Error("the Firstmate has no crew_status tool");
  return found;
};

describe("the Claude seat on the real client", () => {
  it("answers a captain turn through a typed tool, on the real prompt and the complete tool set", async () => {
    const b = claudeSeatBox(api);
    api.answer((request, res) =>
      answersTool(request)
        ? answerText(request, res, "The crew is idle.")
        : answerTool(request, res, "crew_status", {}),
    );
    const session = await b.factory(seatSpec(b));
    const events = recorder(session);
    const first = api.requests.length;
    await session.prompt("how is the crew?");

    const served = api.requests[first];
    expect(served?.body.tools?.map((tool) => tool.name).sort()).toEqual(
      tools.map((tool) => `mcp__infinitary__${tool.name}`).sort(),
    );
    expect(tools).toHaveLength(FIRSTMATE_TOOLS.length + 1);
    const system = (served?.body.system ?? []).map((block) => block.text ?? "").join("\n");
    expect(system).toContain(buildFirstmateSystemPrompt());
    expect(system).toContain("Answer in one line.");
    // The seat's operational effort, until a captain turn raises it.
    expect(served?.body.output_config?.effort).toBe("low");
    // The tool ran for real and its answer reached the model.
    expect(afterLastToolCall(api.requests[first + 1] as StubRequest)).toContain(
      '"tool_use_id":"toolu_',
    );
    // The client names its model and acknowledges the exact input before
    // starting inference; then each request restarts the watched clock.
    expect(events).toEqual([
      { type: "model_served", model: { provider: "anthropic-claude", id: MODEL } },
      {
        type: "input_read",
        textSha256: createHash("sha256").update("how is the crew?").digest("hex"),
      },
      { type: "request_started" },
      { type: "tool_start", taskId: "firstmate", callId: "toolu_1", toolName: "crew_status" },
      {
        type: "tool_end",
        taskId: "firstmate",
        callId: "toolu_1",
        toolName: "crew_status",
        isError: false,
      },
      { type: "request_started" },
      { type: "assistant_delta", taskId: "firstmate", text: "The crew is idle." },
      { type: "turn_end", taskId: "firstmate", usage: expect.any(Object) },
      { type: "turn_closed", text: "The crew is idle." },
    ]);

    // The client writes its transcript on its own schedule and the last of
    // it as it exits; once it has, the app's copy holds the whole turn, and
    // the prompt is located in it under the uuid the seat gave it.
    session.dispose();
    await session.closed();
    const recorded = b.store.entries(session.sessionId);
    expect(recorded.some((entry) => entry.type === "assistant")).toBe(true);
    const state = session.servedState?.();
    expect(state?.sessionFile).toBe(b.store.transcriptPath(session.sessionId));
    expect(state?.prompt?.prefix).not.toBeNull();
    expect(recorded.find((entry) => entry.uuid === state?.prompt?.entryId)).toMatchObject({
      type: "user",
      message: { content: "how is the crew?" },
    });
  });

  it("raises its effort for a captain turn from the very next request", async () => {
    const b = claudeSeatBox(api);
    api.answer((request, res) => answerText(request, res, "Aye."));
    const session = await b.factory(seatSpec(b));
    await session.prompt("an op");
    session.setThinkingLevel?.("medium");
    const first = api.requests.length;
    await session.prompt("the captain asks");
    expect(api.requests[first - 1]?.body.output_config?.effort).toBe("low");
    expect(api.requests[first]?.body.output_config?.effort).toBe("medium");
    session.dispose();
    await session.closed();
  });

  it("serves changed instructions in a new session after an instructions reopen, counting its usage", async () => {
    // The client the product would run: the installed one resumes a session
    // on the system prompt it recorded at its start, whatever it is handed.
    const b = claudeSeatBox(api, resolveClaudeExecutable() ?? sdkBundledClaudeClient());
    api.answer((request, res) => answerText(request, res, "Aye."));
    const session = await b.factory(seatSpec(b));
    const events = recorder(session);
    await session.prompt("remember the word cobalt");
    const first = session.sessionId;
    expect(session.takeRenewal()).toBeUndefined();
    session.serveInstructions?.({ text: "Answer in two lines.", sha: "sha-2" });
    expect(session.takeRenewal()).toEqual({ from: first, changed: ["instructions"] });
    expect(session.sessionId).not.toBe(first);
    const at = api.requests.length;
    await session.prompt("two");
    // The reopen really started a new client, serving the new instructions.
    const system = (api.requests[at]?.body.system ?? [])
      .map((block) => block.text ?? "")
      .join("\n");
    expect(system).toContain("Answer in two lines.");
    expect(system).not.toContain("Answer in one line.");
    // A new conversation: the old one's words ride the owner's digest, not the request.
    expect(JSON.stringify(api.requests[at]?.body.messages ?? [])).not.toContain("cobalt");
    const usages = events.flatMap((event) =>
      event.type === "turn_end" ? [event.usage?.input ?? 0] : [],
    );
    expect(usages).toHaveLength(2);
    expect(usages.every((input) => input > 0)).toBe(true);
    session.dispose();
    await session.closed();
    // The app's copy of the old session stays, beside the new one's.
    expect(JSON.stringify(b.store.entries(first))).toContain("remember the word cobalt");
    expect(JSON.stringify(b.store.entries(session.sessionId))).toContain('"two"');
  });

  it("resumes the same session when the instructions it reattaches with are unchanged", async () => {
    const b = claudeSeatBox(api, resolveClaudeExecutable() ?? sdkBundledClaudeClient());
    api.answer((request, res) => answerText(request, res, "Noted."));
    const first = await b.factory(seatSpec(b));
    await first.prompt("remember the word cobalt");
    const sessionId = first.sessionId;
    first.serveInstructions?.({ text: "Answer in one line.", sha: "sha-instructions" });
    expect(first.takeRenewal()).toBeUndefined();
    first.dispose();
    await first.closed();
    const second = await b.factory(seatSpec(b, { resume: { backend: "claude", sessionId } }));
    expect(second.sessionId).toBe(sessionId);
    expect(second.takeRenewal()).toBeUndefined();
    const at = api.requests.length;
    await second.prompt("which word?");
    expect(JSON.stringify(api.requests[at]?.body.messages ?? [])).toContain(
      "remember the word cobalt",
    );
    second.dispose();
    await second.closed();
  });

  it("starts a new session at open when the instructions changed since it started, keeping the app's copy", async () => {
    const b = claudeSeatBox(api, resolveClaudeExecutable() ?? sdkBundledClaudeClient());
    api.answer((request, res) => answerText(request, res, "Noted."));
    const first = await b.factory(seatSpec(b));
    await first.prompt("remember the word cobalt");
    const stale = first.sessionId;
    first.dispose();
    await first.closed();
    const second = await b.factory(
      seatSpec(b, {
        resume: { backend: "claude", sessionId: stale },
        instructions: { text: "Answer in two lines.", sha: "sha-2" },
      }),
    );
    expect(second.sessionId).not.toBe(stale);
    expect(second.takeRenewal()).toEqual({ from: stale, changed: ["instructions"] });
    const at = api.requests.length;
    await second.prompt("hello again");
    const system = (api.requests[at]?.body.system ?? [])
      .map((block) => block.text ?? "")
      .join("\n");
    expect(system).toContain("Answer in two lines.");
    second.dispose();
    await second.closed();
    expect(JSON.stringify(b.store.entries(stale))).toContain("remember the word cobalt");
    expect(b.logs.join("\n")).toContain(`the instructions changed since session ${stale} started`);
  });

  it("starts a new session at open when an update reworded a tool it had, serving the new words", async () => {
    const b = claudeSeatBox(api, resolveClaudeExecutable() ?? sdkBundledClaudeClient());
    api.answer((request, res) => answerText(request, res, "Noted."));
    const first = await b.factory(seatSpec(b));
    await first.prompt("remember the word cobalt");
    const stale = first.sessionId;
    first.dispose();
    await first.closed();
    // The next build reworded emit_card, whose description carries the card mechanics.
    const reworded = "This build reworded the card tool.";
    const next = tools.map((tool) =>
      tool.name === "emit_card"
        ? { ...tool, description: `${tool.description} ${reworded}` }
        : tool,
    );
    const second = await b.factory(
      seatSpec(b, { resume: { backend: "claude", sessionId: stale }, tools: next }),
    );
    const renewal = second.takeRenewal();
    const at = api.requests.length;
    await second.prompt("hello again");
    const request = api.requests[at];
    evidence("tool reworded", {
      resumed: second.sessionId === stale,
      renewal,
      newWords: request?.raw.includes(reworded),
      history: JSON.stringify(request?.body.messages ?? []).includes("cobalt"),
    });
    expect(second.sessionId).not.toBe(stale);
    expect(renewal).toEqual({ from: stale, changed: ["prompt"] });
    expect(request?.raw).toContain(reworded);
    expect(JSON.stringify(request?.body.messages ?? [])).not.toContain("cobalt");
    second.dispose();
    await second.closed();
    expect(JSON.stringify(b.store.entries(stale))).toContain("remember the word cobalt");
  });

  it("serves its output cap as each request's limit, thinking inside it, and fails an answer that keeps running past it in its own words", async () => {
    // Measured (decision D5): the client serves the cap as `max_tokens` with
    // the model's adaptive thinking under it, and asks a cut answer to carry
    // on three times before it gives the turn up.
    const b = claudeSeatBox(api);
    api.answer((request, res) => {
      beginAnthropicStream(res, 42, request.n);
      writeAnthropicText(res, 0, "A long answer that");
      finishAnthropicStream(res, "max_tokens", FIRSTMATE_MAX_OUTPUT_TOKENS);
    });
    const session = await b.factory(seatSpec(b));
    const events = recorder(session);
    const first = api.requests.length;
    await session.prompt("how is the crew?");
    const served = api.requests.slice(first);
    expect(served.map((request) => request.body.max_tokens)).toEqual(
      Array(4).fill(FIRSTMATE_MAX_OUTPUT_TOKENS),
    );
    expect(served[0]?.body.thinking).toEqual({ type: "adaptive" });
    expect(served[0]?.body.output_config?.effort).toBe("low");
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([
      {
        type: "turn_failed",
        taskId: "firstmate",
        error: outputCapErrorMessage(FIRSTMATE_MAX_OUTPUT_TOKENS),
      },
    ]);
    evidence("output cap", {
      requests: served.map((request) => ({
        maxTokens: request.body.max_tokens,
        thinking: request.body.thinking,
        effort: request.body.output_config?.effort,
      })),
      failures: events.filter((event) => event.type === "turn_failed"),
    });
    session.dispose();
    await session.closed();
  });

  it("interrupts a turn mid-inference and stays usable; an idle abort is nothing", async () => {
    const b = claudeSeatBox(api);
    const session = await b.factory(seatSpec(b));
    const events = recorder(session);
    await session.abort();
    // The first request is held open: the model is "thinking" when the interrupt lands.
    api.answer(() => {});
    const arrived = api.nextRequest();
    const prompt = session.prompt("think for a long time");
    await arrived;
    await session.abort();
    await prompt;
    // A plain interrupt is not a failure.
    expect(events.some((event) => event.type === "turn_failed")).toBe(false);
    api.answer((request, res) => answerText(request, res, "Back."));
    await session.prompt("are you there?");
    expect(events.at(-1)).toEqual({ type: "turn_closed", text: "Back." });
    session.dispose();
    await session.closed();
  });

  it("starts fresh when the client's own transcript is gone, keeping the app's copy", async () => {
    const b = claudeSeatBox(api);
    api.answer((request, res) => answerText(request, res, "Noted."));
    const first = await b.factory(seatSpec(b));
    await first.prompt("remember the word cobalt");
    const stale = first.sessionId;
    first.dispose();
    await first.closed();
    // The client swept its transcripts (its 30-day default, say).
    rmSync(join(b.configDir, "projects"), { recursive: true, force: true });
    const fresh = await b.factory(seatSpec(b, { resume: { backend: "claude", sessionId: stale } }));
    expect(fresh.sessionId).not.toBe(stale);
    await fresh.prompt("hello again");
    fresh.dispose();
    await fresh.closed();
    expect(fresh.servedState?.()?.prompt?.entryId).toBeTruthy();
    expect(JSON.stringify(b.store.entries(stale))).toContain("remember the word cobalt");
    expect(b.logs.join("\n")).toContain(`no transcript for session ${stale}`);
  });
});

describe("the steer priority, measured on the real client", () => {
  type Measured = {
    /** Where the steer was answered: inside the running turn, or in a turn of its own. */
    answered: "in the running turn" | "in a turn of its own";
    /** Whether the tool in flight when it landed still delivered its result. */
    toolResult: "kept" | "lost";
  };

  it("folds a `next` steer into the running turn, keeps the tool's result, and answers once", async () => {
    const b = claudeSeatBox(api);
    const input = new MessageQueue();
    const sessionId = randomUUID();
    let gate = gated(b, crewStatus());
    const run = query({
      prompt: input,
      options: claudeSessionOptions({
        spec: seatSessionSpecOf({
          ...seatSpec(b, {
            tools: tools.map((tool) =>
              tool.name === "crew_status"
                ? { ...tool, run: (params) => gate.tool.run(params) }
                : tool,
            ),
          }),
          instructions: undefined,
        }),
        env: b.env,
        attachment: { model: MODEL, session: { sessionId } },
        executable: b.stub,
        stderr: () => {},
      }),
    });
    let results = 0;
    let settled: { at: number; resolve: () => void; reject: (error: Error) => void } | undefined;
    // One consumer, kept alive across all three turns. A for-await break
    // is not a turn boundary: it can return/close the query's iterator.
    const pump = (async () => {
      try {
        for await (const message of run) {
          const record = message as { type: string; subtype?: string; state?: string };
          if (record.type === "result") results += 1;
          if (
            record.subtype === "session_state_changed" &&
            record.state === "idle" &&
            settled &&
            results > settled.at
          ) {
            settled.resolve();
          }
        }
      } finally {
        settled?.reject(new Error("The measurement client stopped before becoming idle."));
      }
    })();
    b.onCleanup(() => {
      input.close();
      run.close();
    });
    b.drained(pump.catch(() => {}));

    async function measure(priority: "now" | "next" | "later"): Promise<Measured> {
      const steerText = `steer at ${priority}`;
      gate = gated(b, crewStatus());
      api.answer((request, res) =>
        answersTool(request) || request.raw.includes(steerText)
          ? answerText(request, res, `answer ${request.n}`)
          : answerTool(request, res, "crew_status", {}),
      );
      const first = api.requests.length;
      const at = results;
      const idle = new Promise<void>((resolve, reject) => {
        settled = { at, resolve, reject };
      });
      input.push(userMessage("how is the crew?", undefined, undefined, randomUUID()));
      await gate.entered;
      const queued = clientRecords(b, sessionId, enqueued(steerText));
      input.push(userMessage(steerText, priority, undefined, randomUUID()) as SDKUserMessage);
      await queued;
      gate.open();
      await idle;
      settled = undefined;
      const afterTool = api.requests.slice(first).find(answersTool) as StubRequest;
      return {
        answered: results - at === 1 ? "in the running turn" : "in a turn of its own",
        toolResult: afterLastToolCall(afterTool).includes('"is_error":true') ? "lost" : "kept",
      };
    }

    const measured = {
      now: await measure("now"),
      next: await measure("next"),
      later: await measure("later"),
    };
    input.close();
    await pump;
    evidence("steer priorities on one rolling client", measured);
    // What the pinned client does with each (docs/claude-client.md):
    expect(measured).toEqual({
      // Aborts the tool in flight - the model reads an error for it - and
      // the steer is answered in a second turn.
      now: { answered: "in a turn of its own", toolResult: "lost" },
      // Pi's steer: into the running turn after the tool's result, one answer.
      next: { answered: "in the running turn", toolResult: "kept" },
      // Waits for the running turn to end, then a turn of its own.
      later: { answered: "in a turn of its own", toolResult: "kept" },
    });
    // The seat steers at the one priority with Pi's shape.
    expect(CLAUDE_STEER_PRIORITY).toBe("next");
  });

  it("delivers the seat's own steer into the running turn and settles the prompt once", async () => {
    const b = claudeSeatBox(api);
    const gate = gated(b, crewStatus());
    const steerText = "and look at the queue too";
    api.answer((request, res) =>
      answersTool(request)
        ? answerText(request, res, "Crew idle; queue empty.")
        : answerTool(request, res, "crew_status", {}),
    );
    const session = await b.factory(
      seatSpec(b, { tools: tools.map((tool) => (tool.name === "crew_status" ? gate.tool : tool)) }),
    );
    const events = recorder(session);
    const first = api.requests.length;
    const prompt = session.prompt("how is the crew?");
    await gate.entered;
    const queued = clientRecords(b, session.sessionId, enqueued(steerText));
    await session.steer(steerText);
    await queued;
    gate.open();
    await prompt;
    expect(afterLastToolCall(api.requests[first + 1] as StubRequest)).toContain(steerText);
    expect(events.filter((event): event is FmEvent => event.type === "turn_end")).toHaveLength(1);
    expect(session.takeUndeliveredSteers?.()).toEqual([]);
    // The steer is located in the record: the client files a folded
    // message as an attachment naming the uuid the seat gave it.
    session.dispose();
    await session.closed();
    const state = session.servedState?.();
    expect(state?.steers).toHaveLength(1);
    const steerEntry = b.store
      .entries(session.sessionId)
      .find((entry) => entry.uuid === state?.steers[0]?.entryId);
    expect(steerEntry).toMatchObject({
      type: "attachment",
      attachment: { type: "queued_command", prompt: steerText },
    });
    evidence("seat steer", {
      afterTool: JSON.parse(afterLastToolCall(api.requests[first + 1] as StubRequest)),
      turnEnds: events.filter((event) => event.type === "turn_end").length,
      recordedSteer: steerEntry,
    });
  });

  it("drains abandoned requests and held tools before removing their scratch homes", async () => {
    for (const interruptedAt of ["request", "tool"] as const) {
      const b = claudeSeatBox(api);
      const gate = gated(b, crewStatus());
      api.answer((request, res) => {
        if (interruptedAt === "tool") answerTool(request, res, "crew_status", {});
        // Otherwise leave the inference unanswered, as a timed-out case does.
      });
      const session = await b.factory(seatSpec(b, { tools: [gate.tool] }));
      const arrived = api.nextRequest();
      // Cleanup is allowed to reject a stranded prompt. Observe it now,
      // not after an unhandled rejection could escape into the next case.
      const prompt = session.prompt("a case that exits before finishing").catch(() => {});
      await arrived;
      if (interruptedAt === "tool") await gate.entered;
      else expect(api.openRequests()).toBe(1);
      // Deliberately never open the gate or dispose the session ourselves.
      // This is the same fixture boundary a failed assertion/timeout takes.
      void clientRecords(b, session.sessionId, () => false);
      await seatBoxesFlushed();
      await prompt;
      expect(hasActiveSession(b.configDir)).toBe(false);
      expect(api.openRequests()).toBe(0);
      await b.store.flushed();
      expect(existsSync(b.home)).toBe(false);
      await expect(b.factory(seatSpec(b))).rejects.toThrow("box has closed");
      evidence("abandoned case cleanup", {
        interruptedAt,
        activeLease: hasActiveSession(b.configDir),
        openRequests: api.openRequests(),
        scratchHomeExists: existsSync(b.home),
      });
    }
  });
});

describe("typed failures from the real client", () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;

  async function failedTurn(
    reply: Reply,
  ): Promise<{ failed: SessionEvent[]; readings: ClaudeRateLimit[] }> {
    const b = claudeSeatBox(api);
    api.answer(reply);
    const session = await b.factory(seatSpec(b));
    const events = recorder(session);
    await session.prompt("hello");
    session.dispose();
    await session.closed();
    return { failed: events.filter((event) => event.type === "turn_failed"), readings: b.readings };
  }

  it("classifies a 429 on a spent plan as no headroom, with the reset it named", async () => {
    const { failed, readings } = await failedTurn((_request, res) =>
      writeAnthropicError(
        res,
        429,
        { type: "rate_limit_error", message: "rate limited" },
        {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-reset": String(reset),
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": String(reset),
          "anthropic-ratelimit-unified-5h-utilization": "1.0",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        },
      ),
    );
    // The client pushes its `rejected` reading before it reports the error.
    expect(readings).toContainEqual(
      expect.objectContaining({ status: "rejected", resetsAt: reset * 1000 }),
    );
    expect(failed).toEqual([
      expect.objectContaining({
        type: "turn_failed",
        cutOff: { class: "no_headroom", resetsAt: reset * 1000 },
      }),
    ]);
  });
});
