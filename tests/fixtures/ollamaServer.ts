import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type NativeRequest = {
  model: string;
  messages: Array<{
    role: string;
    content: string;
    tool_calls?: unknown[];
    tool_name?: string;
    tool_call_id?: string;
    images?: string[];
  }>;
  tools?: Array<{ function: { name: string } }>;
  truncate?: boolean;
  shift?: boolean;
  options?: { num_predict?: number; num_ctx?: number };
};
export type NativeResponse = {
  content?: string;
  thinking?: string;
  tool_calls?: unknown[];
  reason?: string;
  error?: string;
  input?: number;
  unfinished?: boolean;
};

/** Native HTTP fixture, not a fake Pi session. Requests pass through the real runtime/adapter. */
export async function startOllamaFixture(
  answer: (request: NativeRequest) => NativeResponse | Promise<NativeResponse>,
) {
  const requests: NativeRequest[] = [];
  const aliases = new Map<string, number>();
  /** Every alias the app asked to create, in order, refused ones included. */
  const asked: string[] = [];
  let denyCreate = false;
  let allocated = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader("Content-Type", "application/json");
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    switch (req.url) {
      case "/api/version":
        return send({ version: "0.34.2" });
      case "/api/tags":
        return send({ models: [{ name: "fixture:latest", digest: "fixture-weights" }] });
      case "/api/show": {
        const context =
          body.model === "fixture" || body.model === "fixture:latest"
            ? 4096
            : aliases.get(body.model);
        return context
          ? send({
              parameters: `temperature 0.7\nnum_ctx ${context}\nnum_predict -1`,
              modelfile: "FROM /fixture/sha256-weights\nPARAMETER temperature 0.7",
              model_info: { "general.architecture": "qwen35", "qwen35.context_length": 65536 },
              capabilities: ["tools", "thinking", "vision"],
            })
          : send({ error: "missing model" }, 404);
      }
      case "/api/create": {
        asked.push(body.model);
        if (denyCreate) return send({ error: "creation forbidden" }, 403);
        aliases.set(body.model, body.parameters.num_ctx);
        return send({ status: "success" });
      }
      case "/api/ps":
        return send({
          models: [
            { name: allocated, context_length: aliases.get(allocated), size: 100, size_vram: 100 },
          ],
        });
      case "/api/chat": {
        if (body.messages.length === 0) {
          allocated = body.model;
          return send({ done: true, done_reason: "load" });
        }
        requests.push(body);
        const next = await answer(body);
        if (next.error) return send({ error: next.error }, 400);
        res.setHeader("Content-Type", "application/x-ndjson");
        res.write(
          `${JSON.stringify({ message: { role: "assistant", content: next.content ?? "", thinking: next.thinking, tool_calls: next.tool_calls }, done: false })}\n`,
        );
        if (!next.unfinished)
          res.write(
            `${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: next.reason ?? "stop", prompt_eval_count: next.input ?? 12000, eval_count: 50 })}\n`,
          );
        return res.end();
      }
      default:
        return send({ error: "not found" }, 404);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    aliases,
    asked,
    denyCreate: () => {
      denyCreate = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
