import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The Anthropic Messages dialect a stub API speaks: the server-sent events
 * of one streamed reply, as the e2e mock provider (`tests/e2e/mockProvider.ts`)
 * and the Claude seat's integration test (`claudeFirstmateSession.integration.test.ts`)
 * both answer Claude's client with them, and the local stub API that speaks
 * it to a Claude client or to Pi (`startStubApi`).
 */

export function writeAnthropicEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Each response carries its own message id and tool-use ids: Claude's client
 * keeps the whole conversation and takes a repeated id for the same call, so
 * a second `toolu_1` never reaches its history (Pi does not mind either way).
 */
export function beginAnthropicStream(
  res: ServerResponse,
  inputTokens: number,
  request: number,
  headers: Record<string, string> = {},
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...headers,
  });
  writeAnthropicEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_mock_${request}`,
      type: "message",
      role: "assistant",
      model: "mock-1",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  });
}

export function finishAnthropicStream(
  res: ServerResponse,
  stopReason: "end_turn" | "tool_use" | "max_tokens",
  outputTokens: number,
): void {
  writeAnthropicEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  writeAnthropicEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

export function writeAnthropicText(res: ServerResponse, index: number, text: string): void {
  writeAnthropicEvent(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
  writeAnthropicEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
  writeAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index });
}

/** A tool_use block's events, at `index`, under the name the request served the tool as. */
export function writeAnthropicToolUse(
  res: ServerResponse,
  index: number,
  call: { id: string; name: string; args: unknown },
): void {
  writeAnthropicEvent(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
  });
  writeAnthropicEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) },
  });
  writeAnthropicEvent(res, "content_block_stop", { type: "content_block_stop", index });
}

export function writeAnthropicError(
  res: ServerResponse,
  status: number,
  error: { type: string; message: string },
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ type: "error", error }));
}

export type StubRequest = {
  n: number;
  body: {
    model?: string;
    tools?: { name: string }[];
    system?: { text?: string }[];
    messages?: { role: string; content: unknown }[];
    output_config?: { effort?: string };
    max_tokens?: number;
    thinking?: { type?: string };
  };
  raw: string;
  /** What the request signed in with: its `x-api-key`, or its bearer token. */
  credential?: string;
};

export type Reply = (request: StubRequest, res: ServerResponse) => void;

/** A local Anthropic API whose answers each test scripts; every request is kept. */
export type StubApi = {
  url: string;
  requests: StubRequest[];
  answer: (reply: Reply) => void;
  /** The next of the app's requests, once it arrives. */
  nextRequest: () => Promise<StubRequest>;
  /** The app's requests still waiting on an answer. */
  openRequests: () => number;
  close: () => Promise<void>;
};

/** The app's request carries the app's tools; the client's own housekeeping carries none. */
function carriesAppTools(body: StubRequest["body"]): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

/**
 * A local Anthropic API. `isApp` tells the app's own requests - kept and
 * answered by the test's script - from a client's housekeeping, which is
 * answered at once and kept nowhere.
 */
export async function startStubApi(
  isApp: (body: StubRequest["body"]) => boolean = carriesAppTools,
): Promise<StubApi> {
  const requests: StubRequest[] = [];
  let reply: Reply = (request, res) => answerText(request, res, "Aye.");
  let waiting: ((request: StubRequest) => void)[] = [];
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
      if (!req.url?.includes("/messages") || !isApp(body)) {
        answerText({ n: 0 }, res, "ok");
        return;
      }
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const key = req.headers["x-api-key"];
      const credential = typeof key === "string" ? key : bearer;
      const request: StubRequest = {
        n: requests.length + 1,
        body,
        raw,
        ...(credential ? { credential } : {}),
      };
      requests.push(request);
      open.add(res);
      res.on("close", () => open.delete(res));
      reply(request, res);
      const resolve = waiting;
      waiting = [];
      for (const notify of resolve) notify(request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    answer: (next) => {
      reply = next;
    },
    nextRequest: () => new Promise((resolve) => waiting.push(resolve)),
    openRequests: () => open.size,
    close: () =>
      new Promise((resolve) => {
        for (const res of open) res.destroy();
        server.close(() => resolve());
        // A request whose body has not arrived is not in `open` yet. Stop those too,
        // after closing the listener so no new connection can race the shutdown.
        server.closeAllConnections();
      }),
  };
}

export function answerText(request: { n: number }, res: ServerResponse, text: string): void {
  beginAnthropicStream(res, 42, request.n);
  writeAnthropicText(res, 0, text);
  finishAnthropicStream(res, "end_turn", 7);
}
