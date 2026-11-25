import { createServer, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import {
  customChatCall,
  customChatText,
  customResponsesCall,
  customResponsesText,
  sendCustomStream,
} from "../helpers/customApiDialect";

/** Scripted synthetic checks and the existing truthful model fixture, behind
 * one selected destination. Only this test server translates dialects; the
 * product never proxies, probes or falls back between them. `list` is the
 * server's own model list; without one, listing answers 404. */
export async function startCustomApiFixture(
  mockPort: number,
  tls?: { key: string; cert: string },
  list?: unknown,
  usageMode?: "silent" | "requested",
  readsPictures = false,
) {
  const requests: {
    path: string;
    authorization: boolean;
    /** The Authorization scheme word only, and the person's extra `X-Org-Id` header. */
    scheme?: string;
    /** The key after the scheme word, so a journey can tell which computer's synthetic key asked. */
    key?: string;
    org?: string;
    body: Record<string, unknown>;
  }[] = [];
  let status = 200;
  const handler: RequestListener = async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    requests.push({
      path: req.url ?? "",
      authorization: Boolean(req.headers.authorization),
      scheme: req.headers.authorization?.split(" ")[0],
      key: req.headers.authorization?.split(" ")[1],
      org: req.headers["x-org-id"] as string | undefined,
      body,
    });
    if (status !== 200) {
      res.writeHead(status);
      res.end(
        JSON.stringify({
          error: {
            message: `${req.headers.authorization ?? ""} https://refused.invalid/?key=echo`,
          },
        }),
      );
      return;
    }
    if (req.method === "GET") {
      if (list && req.url?.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
        return;
      }
      res.writeHead(404);
      res.end("manual names only");
      return;
    }
    const responses = req.url?.endsWith("/responses");
    const transcript = JSON.stringify(body);
    if (transcript.includes("synthetic API connection check")) {
      if (transcript.includes("data:image/png;base64,")) {
        sendCustomStream(
          res,
          (responses ? customResponsesText : customChatText)(readsPictures ? "47" : "unknown"),
        );
        return;
      }
      const result =
        transcript.includes('"role":"tool"') ||
        transcript.includes('"type":"function_call_output"');
      sendCustomStream(
        res,
        result
          ? (responses ? customResponsesText : customChatText)("FIRSTMATE_CUSTOM_API_OK")
          : (responses ? customResponsesCall : customChatCall)(
              "firstmate_echo",
              '{"text":"FIRSTMATE_CUSTOM_API_OK"}',
            ),
      );
      return;
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const chat = responses ? responsesAsChat(body) : body;
      const upstream = await fetch(`http://127.0.0.1:${mockPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chat),
        signal: abort.signal,
      });
      let frames = await upstream.text();
      if (usageMode) {
        frames = frames
          .split(/\r?\n\r?\n/)
          .flatMap((frame) => {
            if (!frame.startsWith("data: {")) return [frame];
            const chunk = JSON.parse(frame.slice(6));
            delete chunk.usage;
            return chunk.choices?.length ? [`data: ${JSON.stringify(chunk)}`] : [];
          })
          .join("\n\n");
        if (
          usageMode === "requested" &&
          (body.stream_options as { include_usage?: boolean })?.include_usage
        ) {
          frames = frames.replace(
            "data: [DONE]",
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 80 } })}\n\ndata: [DONE]`,
          );
        }
      }
      if (responses) sendCustomStream(res, chatAsResponses(frames));
      else {
        res.writeHead(upstream.status, { "Content-Type": "text/event-stream" });
        res.end(frames);
      }
    } catch {
      if (!res.destroyed) {
        res.writeHead(503);
        res.end("fixture stopped");
      }
    }
  };
  const server = tls ? createTlsServer(tls, handler) : createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return {
    baseUrl: `${tls ? "https://gateway.example.test" : "http://127.0.0.1"}:${address.port}/operator/path`,
    requests,
    refuse: (next: number) => {
      status = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
function responsesAsChat(body: Record<string, unknown>) {
  const messages: Record<string, unknown>[] = [];
  for (const item of body.input as Record<string, unknown>[]) {
    if (item.type === "function_call") {
      let previous = messages.at(-1);
      if (previous?.role !== "assistant" || !previous.tool_calls) {
        previous = { role: "assistant", content: "", tool_calls: [] };
        messages.push(previous);
      }
      (previous.tool_calls as unknown[]).push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item.type === "function_call_output")
      messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output });
    else messages.push(item);
  }
  return {
    model: body.model,
    messages,
    stream: true,
    max_tokens: body.max_output_tokens,
    ...(body.tools
      ? {
          tools: (body.tools as Record<string, unknown>[]).map(({ type, ...fn }) => ({
            type,
            function: fn,
          })),
        }
      : {}),
  };
}
function chatAsResponses(raw: string): string {
  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    const chunk = JSON.parse(data) as {
      choices?: {
        delta?: {
          content?: string;
          tool_calls?: {
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
    };
    const delta = chunk.choices?.[0]?.delta;
    text += delta?.content ?? "";
    for (const part of delta?.tool_calls ?? []) {
      const call = calls.get(part.index) ?? { id: "", name: "", args: "" };
      call.id ||= part.id ?? "";
      call.name += part.function?.name ?? "";
      call.args += part.function?.arguments ?? "";
      calls.set(part.index, call);
    }
  }
  if (calls.size === 0) return customResponsesText(text);
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const output = [...calls.values()].map((call, index) => ({
    type: "function_call",
    id: `item_${index}`,
    call_id: call.id,
    name: call.name,
    arguments: call.args,
    status: "completed",
  }));
  const frames = [
    event({
      type: "response.created",
      response: { id: "fixture-response", status: "in_progress" },
    }),
  ];
  output.forEach((item, index) => {
    frames.push(
      event({
        type: "response.output_item.added",
        output_index: index,
        item: { ...item, arguments: "", status: "in_progress" },
      }),
    );
    frames.push(
      event({
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: index,
        delta: item.arguments,
      }),
    );
    frames.push(event({ type: "response.output_item.done", output_index: index, item }));
  });
  frames.push(
    event({
      type: "response.completed",
      response: { id: "fixture-response", status: "completed", output },
    }),
  );
  return frames.join("");
}
