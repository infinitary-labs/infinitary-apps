import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FmEvent } from "@shared/events";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type NativeResponse, startOllamaFixture } from "../../../tests/fixtures/ollamaServer";
import { manualClock } from "../../../tests/helpers/manualClock";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seatSpec } from "../../../tests/helpers/seatSession";
import { createLocalOrchestratorSeat } from "../orchestrator/localOrchestrator";
import { BoundsWatcher } from "../session/bounds";
import type { ModelSession } from "../session/session";
import { boundTool } from "../session/tools";
import { catalogRefreshesSettled } from "./modelRuntime";
import { createPiSessionFactory } from "./session";

/** 1×1 PNG. Pi's prompt path resizes real images and omits anything else. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  await catalogRefreshesSettled();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(answer: Parameters<typeof startOllamaFixture>[0]) {
  const server = await startOllamaFixture(answer);
  cleanup.push(server.close);
  const root = scratchDir("fm-ollama-session-");
  cleanup.push(() => rmSync(root, { force: true, recursive: true }));
  const cwd = join(root, "home");
  const sessionsDir = join(root, "sessions");
  mkdirSync(cwd);
  mkdirSync(sessionsDir);
  const seat = await createLocalOrchestratorSeat(
    {
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      model: "fixture",
      apiKey: "fixture",
      host: "127.0.0.1",
      source: "setting",
    },
    { userData: root },
  );
  await seat.prepare?.();
  const cards: string[] = [];
  // The seat's watched bounds ride a clock the test moves (the one watcher).
  const clock = manualClock();
  const sessions = new BoundsWatcher(clock).factory(
    createPiSessionFactory({ agentDir: join(root, "pi") }),
  );
  const create = async (
    sessionFile?: string,
    toolResult = "Card accepted",
    requestTimeoutMs?: number,
  ) => {
    const session = await sessions.open(
      seatSpec({
        cwd,
        sessionsDir,
        binding: { backend: "pi", runtime: seat.runtime, local: true },
        model: seat.model,
        ...(sessionFile ? { resume: { backend: "pi" as const, sessionFile } } : {}),
        ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
        tools: [
          boundTool({
            name: "emit_card",
            label: "Card",
            description: "Show a card",
            parameters: Type.Object({ body: Type.String() }),
            run: async (args) => {
              cards.push(args.body);
              return { text: toolResult };
            },
          }),
        ],
      }),
    );
    cleanup.push(() => session.dispose());
    return session;
  };
  return { server, root, cwd, sessionsDir, seat, cards, create, clock };
}

const cardAnswer = {
  tool_calls: [
    { id: "answer-1", function: { name: "emit_card", arguments: { body: "<p>4</p>" } } },
  ],
};
const finish = { content: "Answered." };

describe("Ollama through real Pi sessions", () => {
  it("keeps the user's model identity, sends only the private alias, handles tools/results/images and never enables truncation", async () => {
    const f = await setup((request) =>
      request.messages.at(-1)?.role === "tool" ? finish : cardAnswer,
    );
    expect(f.seat.model.id).toBe("fixture");
    expect(f.seat.runtime.getModel("local", "fixture")?.contextWindow).toBe(65536);
    const session = await f.create();
    // Pi 0.87 resizes prompt images and drops bytes that are not a real
    // picture, so the attachment has to be a PNG, not an arbitrary payload.
    await session.prompt("what is 2 + 2?", [{ data: TINY_PNG, mimeType: "image/png" }]);
    expect(f.cards).toEqual(["<p>4</p>"]);
    expect(session.modelRef()).toEqual({ provider: "local", id: "fixture" });
    expect(f.server.requests).toHaveLength(2);
    for (const request of f.server.requests) {
      expect(f.server.aliases.has(request.model)).toBe(true);
      expect(request.truncate).toBe(false);
      expect(request.shift).toBe(false);
      expect(request.options).toEqual({ num_ctx: 65536, num_predict: 8192 });
    }
    const sentImage = f.server.requests[0]?.messages.at(-1)?.images?.[0];
    expect(sentImage).toBeTruthy();
    expect(
      Buffer.from(sentImage ?? "", "base64")
        .subarray(0, 4)
        .toString("hex"),
    ).toBe("89504e47");
    expect(f.server.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      tool_name: "emit_card",
      tool_call_id: "answer-1",
      content: "Card accepted",
    });
  });

  it("sends a short follow-up on a session Pi still considers too small to compact", async () => {
    let answer = false;
    const f = await setup((request) => {
      if (request.messages.at(-1)?.role === "tool") return finish;
      return answer ? cardAnswer : { content: "4." };
    });
    const session = await f.create();
    await session.prompt("what is 2 + 2?");
    answer = true;
    await session.prompt("what is 2 + 2?");
    expect(f.cards).toEqual(["<p>4</p>"]);
    expect(
      f.server.requests.filter((request) => (request.tools?.length ?? 0) > 0).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("compacts a resumed long conversation before sending the new ask, then keeps tools and the new ask intact", async () => {
    const f = await setup((request) =>
      !request.tools?.length
        ? { content: "## Goal\nAnswer the captain.\n## Key context\nThe remembered port is 7443." }
        : request.messages.at(-1)?.role === "tool"
          ? finish
          : cardAnswer,
    );
    const history = SessionManager.create(f.cwd, f.sessionsDir);
    // ~53k history tokens: too large beside the real Firstmate prompt, but
    // the summarizer (without Firstmate's tools/prompt) can safely consume it.
    for (let i = 0; i < 80; i++) {
      history.appendMessage({
        role: "user",
        content: `Archived note ${i}: the remembered port is 7443. ${"ordinary history ".repeat(140)}`,
        timestamp: Date.now() + i,
      });
      history.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "Recorded." }],
        api: "ollama-chat",
        provider: "local",
        model: "fixture",
        stopReason: "stop",
        timestamp: Date.now() + i,
        usage: {
          input: 100,
          output: 10,
          totalTokens: 110,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
    }
    const file = history.getSessionFile();
    const session = await f.create(file);
    const completions: Extract<FmEvent, { type: "tool_end" }>[] = [];
    session.subscribe((event) => {
      if (event.type === "tool_end" && event.usage) completions.push(event);
    });
    await session.prompt("Newest captain ask: what is 2 + 2?");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.usage).toEqual({
      input: 12000,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(f.server.requests[0]?.tools?.length ?? 0).toBe(0);
    expect(f.cards).toEqual(["<p>4</p>"]);
    const entries = readFileSync(session.recordPath() as string, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      entries.some((entry) => entry.type === "compaction" && entry.summary.includes("7443")),
    ).toBe(true);
    const request = f.server.requests.find((r) => r.tools?.length);
    expect(request?.messages.some((m) => m.content.includes("Newest captain ask"))).toBe(true);
    expect(request?.messages.some((m) => m.content.includes("7443"))).toBe(true);
    expect(JSON.stringify(request).length).toBeLessThan(55000);
  });

  it("refuses an uncompactionable new input before ANY model inference", async () => {
    const f = await setup(() => finish);
    const session = await f.create();
    await expect(session.prompt("oversized new input ".repeat(14000))).rejects.toThrow(
      "could not shorten",
    );
    expect(f.server.requests).toHaveLength(0);
  });

  it("does not send an oversized tool result, and fails loudly if its compaction cannot fit either", async () => {
    const f = await setup((request) =>
      request.tools?.length
        ? cardAnswer
        : { error: "context_length_exceeded: cannot summarize this result" },
    );
    const session = await f.create(undefined, "large result ".repeat(30000));
    await expect(session.prompt("show an answer")).rejects.toThrow("could not shorten");
    // Pi may serialize a bounded excerpt for its summarizer, but the full
    // tool result must never reach an ordinary inference.
    expect(f.server.requests.filter((request) => request.tools?.length)).toHaveLength(1);
    expect(f.cards).toEqual(["<p>4</p>"]);
  });

  it("cancels a timed-out manual compaction and never sends the waiting captain prompt afterward", async () => {
    let entered = () => {};
    let release = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await setup(async () => {
      entered();
      await delayed;
      return { content: "A delayed summary." };
    });
    const history = SessionManager.create(f.cwd, f.sessionsDir);
    for (let i = 0; i < 80; i++) {
      history.appendMessage({
        role: "user",
        content: `Observation ${i}: ${"old ordinary history ".repeat(120)}`,
        timestamp: Date.now(),
      });
    }
    history.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Recorded." }],
      api: "ollama-chat",
      provider: "local",
      model: "fixture",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 100,
        output: 10,
        totalTokens: 110,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const session = await f.create(history.getSessionFile(), "Card accepted", 35);
    try {
      const failed = session.prompt("new captain question").then(
        () => undefined,
        (error: unknown) => error,
      );
      // Advance the deadline only AFTER the real server has the summarizer:
      // the bound fires on the tick that follows, never on a busy worker's clock.
      await started;
      f.clock.advance(35);
      // A compaction that never cancels leaves this pending, and the test's
      // own budget reports it.
      const error = await failed;
      expect(error).toMatchObject({ message: expect.stringContaining("timed out") });
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.server.requests).toHaveLength(1);
      expect(f.server.requests[0]?.tools?.length ?? 0).toBe(0);
      expect(f.cards).toEqual([]);
      const saved = SessionManager.open(session.recordPath() as string);
      expect(saved.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
      expect(
        saved
          .buildSessionContext()
          .messages.some(
            (message) => message.role === "user" && message.content === "new captain question",
          ),
      ).toBe(false);
    } finally {
      release();
    }
  });

  it.each([
    ["truncated output", { thinking: "unfinished", reason: "length" }, "ran out of room"],
    ["broken stream", { content: "partial", unfinished: true }, "before its answer was complete"],
    [
      "unrecoverable overflow",
      {
        error:
          '{"error":{"code":400,"message":"request (70010 tokens) exceeds the available context size (65536 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":70010,"n_ctx":65536}}',
      },
      "could not shorten",
    ],
    ["provider error", { error: "model load failed" }, "model load failed"],
  ] as Array<[string, NativeResponse, string]>)(
    "reports %s through the throwing channel rather than resolving silently",
    async (_name, response, expected) => {
      const f = await setup(() => response);
      const session: ModelSession = await f.create();
      await expect(session.prompt("captain asks")).rejects.toThrow(expected);
    },
  );
});
