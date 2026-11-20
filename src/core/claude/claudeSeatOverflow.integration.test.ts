import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sdkBundledClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  type StubApi,
  type StubRequest,
  writeAnthropicError,
  writeAnthropicText,
} from "../../../tests/helpers/anthropicDialect";
import { claudeSeatBox, seatBoxesFlushed } from "../../../tests/helpers/claudeSeatHarness";
import { firstmateTools } from "../../../tests/helpers/firstmateTools";
import { buildFirstmateSystemPrompt } from "../pi/piResources";
import type { SessionEvent } from "../session/session";
import { resolveClaudeExecutable } from "./claudeCli";
import { resetStoreLeasesForTest } from "./claudeStoreLease";

/**
 * INF-447 regression: reproduce "Prompt is too long" on a short
 * captain message on the Claude seat, against a stub Messages API that
 * enforces a context window the way the real service refuses
 * ("prompt is too long: N tokens > maximum").
 */

// Real client, many 22k-context turns: measured locally below 5 s; allow concurrent CI work.
vi.setConfig({ testTimeout: 15_000 });

const WINDOW = 1_000_000;
const CHARS_PER_TOKEN = 4;

type Kind = "seat" | "compact" | "count" | "other";
type Logged = { n: number; kind: Kind; tokens: number; status: number; note?: string };

type OverflowApi = StubApi & { log: Logged[] };

function tokensOf(body: StubRequest["body"]): number {
  const text = JSON.stringify({ system: body.system, tools: body.tools, messages: body.messages });
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function kindOf(url: string, body: StubRequest["body"], prompt: string): Kind {
  if (url.includes("count_tokens")) return "count";
  const system = (body.system ?? []).map((b) => b.text ?? "").join("\n");
  if (system.includes("summarizing conversations")) return "compact";
  const msgs = body.messages ?? [];
  const last = JSON.stringify(msgs[msgs.length - 1]?.content ?? "");
  if (last.includes("create a detailed summary") || last.includes("<summary>")) return "compact";
  if (system.includes(prompt)) return "seat";
  return "other";
}

/** A Messages API with a hard context window, answering the seat with a scripted reply. */
async function startOverflowApi(
  seatReply: (request: StubRequest, res: ServerResponse, tokens: number) => void,
): Promise<OverflowApi> {
  const prompt = buildFirstmateSystemPrompt("claude");
  const requests: StubRequest[] = [];
  const log: Logged[] = [];
  const open = new Set<ServerResponse>();
  let n = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: StubRequest["body"] = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      const url = req.url ?? "";
      if (!url.includes("/messages")) {
        res.writeHead(404);
        res.end();
        return;
      }
      n += 1;
      const kind = kindOf(url, body, prompt);
      const tokens = tokensOf(body);
      const lastMsg = JSON.stringify(
        (body.messages ?? [])[(body.messages ?? []).length - 1]?.content ?? "",
      );
      const note = `model=${body.model} max_tokens=${body.max_tokens} thinking=${JSON.stringify(body.thinking ?? null)} msgs=${(body.messages ?? []).length} last=${lastMsg.length}ch ${lastMsg.slice(0, 160).replace(/\s+/g, " ")}`;
      if (kind === "count") {
        log.push({ n, kind, tokens, status: 200, note });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: tokens }));
        return;
      }
      if (tokens > WINDOW) {
        log.push({ n, kind, tokens, status: 400, note });
        writeAnthropicError(res, 400, {
          type: "invalid_request_error",
          message: `prompt is too long: ${tokens} tokens > ${WINDOW} maximum`,
        });
        return;
      }
      log.push({ n, kind, tokens, status: 200, note });
      if (kind === "compact") {
        beginAnthropicStream(res, tokens, n);
        writeAnthropicText(
          res,
          0,
          "<analysis>ok</analysis>\n<summary>1. The captain and the first mate talked about the crew.</summary>",
        );
        finishAnthropicStream(res, "end_turn", 30);
        return;
      }
      if (kind === "other") {
        beginAnthropicStream(res, tokens, n);
        writeAnthropicText(res, 0, "ok");
        finishAnthropicStream(res, "end_turn", 2);
        return;
      }
      const request: StubRequest = { n, body, raw };
      requests.push(request);
      open.add(res);
      res.on("close", () => open.delete(res));
      seatReply(request, res, tokens);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    log,
    answer: () => {
      throw new Error("scripted at start");
    },
    nextRequest: () => new Promise(() => {}),
    openRequests: () => open.size,
    close: () =>
      new Promise((resolve) => {
        for (const res of open) res.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

let api: OverflowApi;
afterEach(async () => {
  try {
    await seatBoxesFlushed();
  } finally {
    await api?.close();
  }
  resetStoreLeasesForTest();
});

it.each([
  ["claude-opus-5-5", 300_000],
  ["claude-haiku-4-5", 200_000],
])(
  "INF-447: %s compacts before its app/model limit despite ambient opt-outs",
  async (model, ceiling) => {
    api = await startOverflowApi((request, res, tokens) => {
      beginAnthropicStream(res, tokens, request.n);
      writeAnthropicText(res, 0, "Aye.");
      finishAnthropicStream(res, "end_turn", 5);
    });
    const b = claudeSeatBox(api, resolveClaudeExecutable() ?? sdkBundledClaudeClient());
    mkdirSync(b.configDir, { recursive: true });
    writeFileSync(join(b.configDir, ".claude.json"), JSON.stringify({ autoCompactEnabled: false }));
    b.env.DISABLE_AUTO_COMPACT = "1";
    b.env.DISABLE_COMPACT = "1";
    b.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "1000000";
    const session = await b.factory({
      cwd: b.cwd,
      sessionsDir: join(b.home, "firstmate", "sessions"),
      binding: { backend: "claude", accountId: "acct_claude" },
      model: { provider: "anthropic-claude", id: model },
      tools: await firstmateTools(),
      instructions: { text: "Answer in one line.", sha: "sha-instructions" },
      requestTimeoutMs: 0,
      turnTimeoutMs: 0,
    });
    const events: SessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    // The real seat's growing host context; usage is read off the API requests, not a mocked counter.
    const context = "context ".repeat(11_000);
    for (let turn = 0; turn < 14; turn += 1) {
      await session.prompt(`[fm-op] context (not the user)\n${context}\nturn ${turn}`);
    }
    await session.prompt("hello");
    console.info(
      "overflow-evidence",
      JSON.stringify({
        model,
        ceiling,
        requests: api.log,
        failures: events.filter((e) => e.type === "turn_failed"),
      }),
    );
    const summary = api.log.findIndex((row) => row.kind === "compact");
    expect(summary).toBeGreaterThan(0);
    // One turn can cross the trigger, but the next request is a summary, not another seat inference.
    const before = api.log.slice(0, summary).filter((row) => row.kind === "seat");
    expect(Math.max(...before.map((row) => row.tokens))).toBeLessThan(ceiling);
    expect(api.log.filter((row) => row.status === 400)).toEqual([]);
    expect(events.filter((e) => e.type === "turn_failed")).toEqual([]);
    expect(api.log.at(-1)?.tokens).toBeLessThan(ceiling);
  },
);
