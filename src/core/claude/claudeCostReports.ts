import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ClaudeCallCost } from "./claudeCallUsage";

/** Bound transient local log bodies; an oversized export retains result-only accounting. */
export const CLAUDE_COST_REPORT_BODY_MAX = 1024 * 1024;

export type ClaudeCostSubscription = {
  env: NodeJS.ProcessEnv;
  redact(text: string): string;
  close(): void;
};

type Recipient = { sessionId: string; report: (cost: ClaudeCallCost) => void };

/** Any pre-existing reporting choice belongs to the person or organization, not this receiver. */
export function hasClaudeReporting(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some(
    (key) =>
      env[key] !== undefined &&
      (key.startsWith("OTEL_") ||
        key.startsWith("ANT_OTEL_") ||
        key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
        key === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" ||
        key === "BETA_TRACING_ENDPOINT" ||
        key === "ENABLE_BETA_TRACING_DETAILED" ||
        key === "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA" ||
        key === "CLAUDE_CODE_BYOC_ENABLE_DATADOG"),
  );
}

/**
 * One lazy loopback receiver per Claude factory on the computer running
 * work. An unguessable attachment path selects one recipient. Only priced
 * request fields are projected out of the OTLP body; raw logs, prompts,
 * resource attributes, email and account identifiers are never retained.
 */
export class ClaudeCostReports {
  private server: Server | undefined;
  private opening: Promise<Server> | undefined;
  private readonly recipients = new Map<string, Recipient>();

  async subscribe(sessionId: string, report: Recipient["report"]): Promise<ClaudeCostSubscription> {
    const token = randomUUID();
    this.recipients.set(token, { sessionId, report });
    try {
      const server = await this.listen();
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("local receiver unavailable");
      let closed = false;
      return {
        redact: (text) => text.replaceAll(token, "[local cost report]"),
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_LOGS_EXPORTER: "otlp",
          OTEL_METRICS_EXPORTER: "none",
          OTEL_TRACES_EXPORTER: "none",
          OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${address.port}/${token}`,
          OTEL_EXPORTER_OTLP_LOGS_HEADERS: "",
          OTEL_EXPORTER_OTLP_HEADERS: "",
          OTEL_EXPORTER_OTLP_LOGS_COMPRESSION: "none",
          OTEL_LOG_USER_PROMPTS: "0",
          OTEL_LOG_ASSISTANT_RESPONSES: "0",
          OTEL_LOG_TOOL_CONTENT: "0",
          OTEL_LOG_TOOL_DETAILS: "0",
          OTEL_LOG_RAW_API_BODIES: "0",
          // OTEL_LOGS_EXPORT_INTERVAL stays unset: keep the client's five-second default.
        },
        close: () => {
          if (closed) return;
          closed = true;
          this.remove(token);
        },
      };
    } catch (caught) {
      this.remove(token);
      throw caught;
    }
  }

  private remove(token: string): void {
    this.recipients.delete(token);
    if (this.recipients.size !== 0 || !this.server) return;
    const server = this.server;
    this.server = undefined;
    server.close();
    server.closeAllConnections();
  }

  private listen(): Promise<Server> {
    if (this.server) return Promise.resolve(this.server);
    if (this.opening) return this.opening;
    const server = createServer((req, res) => void this.receive(req, res));
    this.opening = new Promise<Server>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        // A later socket failure affects only reporting, never the model session.
        server.on("error", () => {});
        this.server = server;
        resolve(server);
      });
    }).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = req.url?.slice(1);
    const recipient = token ? this.recipients.get(token) : undefined;
    if (req.method !== "POST" || !recipient) {
      res.writeHead(404).end();
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > CLAUDE_COST_REPORT_BODY_MAX) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // A subscription may have ended while its final export was in flight.
      if (this.recipients.get(token as string) === recipient)
        for (const cost of callCosts(body, recipient.sessionId)) recipient.report(cost);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    } catch {
      // Neither a malformed body nor a listener fault can escape into Claude's pump.
      if (!res.headersSent) res.writeHead(400).end();
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function rows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function count(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Decode only the standard OTLP attribute value shapes needed by request accounting. */
export function callCosts(body: unknown, sessionId: string): ClaudeCallCost[] {
  const costs: ClaudeCallCost[] = [];
  for (const resource of rows(record(body)?.resourceLogs))
    for (const scope of rows(record(resource)?.scopeLogs))
      for (const log of rows(record(scope)?.logRecords)) {
        const fields: Record<string, unknown> = {};
        for (const attribute of rows(record(log)?.attributes)) {
          const row = record(attribute);
          if (typeof row?.key !== "string") continue;
          // Drop every other attribute before keeping any value.
          if (
            ![
              "event.name",
              "session.id",
              "request_id",
              "model",
              "cost_usd",
              "input_tokens",
              "output_tokens",
              "cache_read_tokens",
              "cache_creation_tokens",
            ].includes(row.key)
          )
            continue;
          const value = record(row.value);
          fields[row.key] = value?.stringValue ?? value?.doubleValue ?? value?.intValue;
        }
        const cost = count(fields.cost_usd);
        if (
          fields["event.name"] !== "api_request" ||
          fields["session.id"] !== sessionId ||
          typeof fields.request_id !== "string" ||
          !fields.request_id ||
          typeof fields.model !== "string" ||
          !fields.model ||
          cost === undefined ||
          cost <= 0
        )
          continue;
        costs.push({
          requestId: fields.request_id,
          model: fields.model,
          cost,
          ...(count(fields.input_tokens) !== undefined
            ? { input: count(fields.input_tokens) }
            : {}),
          ...(count(fields.output_tokens) !== undefined
            ? { output: count(fields.output_tokens) }
            : {}),
          ...(count(fields.cache_read_tokens) !== undefined
            ? { cacheRead: count(fields.cache_read_tokens) }
            : {}),
          ...(count(fields.cache_creation_tokens) !== undefined
            ? { cacheWrite: count(fields.cache_creation_tokens) }
            : {}),
        });
      }
  return costs;
}
