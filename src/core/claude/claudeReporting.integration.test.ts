import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createHttp2Server, type Http2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeMockClaudeClient } from "../../../tests/e2e/mockClaudeClient";
import {
  finishAnthropicStream,
  type StubApi,
  startStubApi,
  writeAnthropicEvent,
  writeAnthropicText,
} from "../../../tests/helpers/anthropicDialect";
import { crewmateToolDelegate } from "../../../tests/helpers/crewmateToolDelegate";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import { LOCAL_MACHINE_ID } from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import {
  accessFlagSettings,
  readClaudeAccess,
  resolvePlacedClaudePolicyFixture,
} from "./claudeAccess";
import type { ClaudeCallCost } from "./claudeCallUsage";
import { resolveClaudeExecutable } from "./claudeCli";
import { claudeCostReportingAllowed } from "./claudeCostPolicy";
import {
  ClaudeCostReports,
  type ClaudeCostSubscription,
  decodeLogsProtobuf,
} from "./claudeCostReports";
import { CLAUDE_MODEL_PROVIDER } from "./claudeQueryCore";
import { readClaudeCompanyReporting, resetHeadersHelperForTests } from "./claudeReporting";
import { resetStoreLeasesForTest } from "./claudeStoreLease";
import { createClaudeSessionFactory } from "./session";

// One boxed client turn per case, like the sibling real-client cases, which
// hold 15 s from the hosted Linux check machine's measure; the client's
// one-second export interval and its flush at exit add a few seconds.
vi.setConfig({ testTimeout: 30_000 });

/**
 * A company's Claude Code reporting setup in the person's own settings file
 * reaches the company's collector through Infinitary, never from Claude's
 * client directly: the collector gets the client's own batches unchanged,
 * as a terminal session's client would have sent them.
 *
 * The client is the real one, boxed by the e2e stub with its config in a
 * throwaway HOME and its model calls at a local stand-in of the Anthropic
 * API. The company's collector is a local stand-in too: one over OTLP/HTTP
 * and one over gRPC.
 */

const MODEL = "claude-haiku-4-5";
const COMPANY_TOKEN = "company-token-7f3a";
const HELPER_TOKEN = "helper-token-91c2";
const EMAIL = "dev@example.com";
const PROMPT = "Say aye.";

let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
  // Each answer carries the provider request id the client's api_request log names.
  api.answer((request, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "request-id": `req_company_${request.n}`,
    });
    writeAnthropicEvent(res, "message_start", {
      type: "message_start",
      message: {
        id: `msg_company_${request.n}`,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 42, output_tokens: 0 },
      },
    });
    writeAnthropicText(res, 0, "Aye.");
    finishAnthropicStream(res, "end_turn", 7);
  });
});

afterAll(async () => {
  await api.close();
});

const stores: SessionRecordStore[] = [];
const servers: (Server | Http2Server)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  resetHeadersHelperForTests();
  resetStoreLeasesForTest();
  await Promise.all(stores.splice(0).map((store) => store.flushed()));
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

type Received = { path: string; headers: IncomingHttpHeaders; body: Buffer };

async function httpCollector(): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

/** A gRPC collector: one unary Export per call, answered OK with an empty response. */
async function grpcCollector(): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createHttp2Server();
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const framed = Buffer.concat(chunks);
      received.push({
        path: String(headers[":path"]),
        headers: headers as IncomingHttpHeaders,
        body: framed.subarray(5, 5 + framed.readUInt32BE(1)),
      });
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(Buffer.from([0, 0, 0, 0, 0]));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

/**
 * An administrator's setup, as the client library's settings reader serves a
 * server-managed policy: the same reporting keys, company-wide.
 */
function managedPolicy(home: string, env: Record<string, string>): string {
  const path = join(home, "managed-policy.json");
  writeFileSync(path, JSON.stringify({ env }));
  return path;
}

/** A header command, as a company's setup names one, printing a JSON object. */
function headersHelper(home: string): string {
  const path = join(home, "otel-headers");
  writeFileSync(path, `#!/bin/sh\nprintf '{"X-Helper-Token":"${HELPER_TOKEN}"}'\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A recorder between Claude's client and the receiver: it keeps each batch
 * exactly as the client sent it, then hands it on and answers with the
 * receiver's answer, so a batch the receiver altered on its way to the
 * collector would differ from what is kept here.
 */
async function clientTap(kept: { signal: string; body: string }[]) {
  let receiverOrigin = "";
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      kept.push({ signal: (req.url ?? "").split("/").pop() ?? "", body: body.toString("base64") });
      const answer = await fetch(`${receiverOrigin}${req.url}`, {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        body,
      });
      res.writeHead(answer.status, {
        "content-type": answer.headers.get("content-type") ?? "application/json",
      });
      res.end(Buffer.from(await answer.arrayBuffer()));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    between: (subscription: ClaudeCostSubscription): ClaudeCostSubscription => {
      const env = { ...subscription.env };
      for (const key of [
        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      ]) {
        const endpoint = env[key];
        if (!endpoint) continue;
        const url = new URL(endpoint);
        receiverOrigin = url.origin;
        env[key] = `${origin}${url.pathname}`;
      }
      return { ...subscription, env };
    },
  };
}

/**
 * A crewmate in a throwaway HOME whose settings file holds `env` and, when
 * given, a header command; the session reads that file with the client
 * library's own settings reader, as production does.
 */
async function turnWithSettings(
  env: Record<string, string>,
  options: { helper?: boolean; managed?: boolean } = {},
) {
  const home = scratchDir("infinitary-claude-reporting-home-");
  const configDir = join(home, ".claude");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({ env, ...(options.helper ? { otelHeadersHelper: headersHelper(home) } : {}) }),
  );
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  const client = resolveClaudeExecutable();
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: api.url, ...(client ? { client } : {}) },
  });
  const notes: string[] = [];
  const priced: ClaudeCallCost[] = [];
  const fromClient: { signal: string; body: string }[] = [];
  const receiver = new ClaudeCostReports();
  const tap = await clientTap(fromClient);
  const launch = { PATH: process.env.PATH ?? "", HOME: home, INFINITARY_CLAUDE_CLI: stub };
  const factory = createClaudeSessionFactory({
    configDir,
    env: () => launch,
    clock: { now: () => Date.now(), register: () => () => {} },
    log: (line) => notes.push(line),
    records: (dir) => {
      const store = new SessionRecordStore(dir);
      stores.push(store);
      return store;
    },
    // The person's own Claude Code access keys, read from the same settings file as production does.
    accessSettings: async () =>
      accessFlagSettings(await readClaudeAccess(undefined, () => undefined)),
    costReportingAllowed: async () =>
      !options.managed ||
      claudeCostReportingAllowed(resolvePlacedClaudePolicyFixture(managedPolicy(home, env))),
    companyReporting: (launchEnv) => readClaudeCompanyReporting(launchEnv, { shell: () => ({}) }),
    costReports: {
      subscribe: async (id, report, forward) =>
        tap.between(
          await receiver.subscribe(
            id,
            (cost) => {
              priced.push(cost);
              report(cost);
            },
            forward,
          ),
        ),
    },
  });
  const spec = crewmateSessionSpec(
    appPathsFor(scratchDir("infinitary-claude-reporting-app-")),
    {
      ...crewmateToolDelegate(),
      machineId: LOCAL_MACHINE_ID,
      cwd: home,
      model: { provider: CLAUDE_MODEL_PROVIDER, id: MODEL },
    },
    { backend: "claude", accountId: "acct_claude_reporting" },
  );
  const session = await factory.open(spec);
  await session.prompt(PROMPT);
  // The client flushes its exporters as it exits.
  session.dispose();
  await session.closed();
  return { notes, priced, fromClient };
}

/** The company's setup as Claude Code's guide writes it, with fast exports for the case. */
function setup(protocol: string, endpoint: string): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${COMPANY_TOKEN}`,
    OTEL_METRIC_EXPORT_INTERVAL: "1000",
    OTEL_LOGS_EXPORT_INTERVAL: "1000",
    OTEL_RESOURCE_ATTRIBUTES: `department=engineering,user.email=${EMAIL}`,
  };
}

/** Each api_request record's request id, from OTLP JSON or protobuf logs. */
function requestIds(logs: unknown): string[] {
  const ids: string[] = [];
  const shaped = logs as {
    resourceLogs?: {
      scopeLogs?: {
        logRecords?: { attributes?: { key?: string; value?: { stringValue?: string } }[] }[];
      }[];
    }[];
  };
  for (const resource of shaped.resourceLogs ?? [])
    for (const scope of resource.scopeLogs ?? [])
      for (const log of scope.logRecords ?? []) {
        const name = log.attributes?.find((a) => a.key === "event.name")?.value?.stringValue;
        const id = log.attributes?.find((a) => a.key === "request_id")?.value?.stringValue;
        if (name === "api_request" && id) ids.push(id);
      }
  return ids;
}

describe("a company's Claude Code setup in the person's settings file", () => {
  it("receives Claude's own logs and metrics through Infinitary over OTLP/HTTP JSON, while each call is still priced live", async () => {
    const collector = await httpCollector();
    const from = api.requests.length;
    const { notes, priced, fromClient } = await turnWithSettings(
      {
        ...setup("http/json", collector.url),
        // The person's own choices: prompts in the records, and the gateway's custom header.
        OTEL_LOG_USER_PROMPTS: "1",
        ANTHROPIC_CUSTOM_HEADERS: "X-Team-Id: platform",
      },
      { helper: true },
    );
    const logs = collector.received.filter((r) => r.path === "/v1/logs");
    const metrics = collector.received.filter((r) => r.path === "/v1/metrics");
    expect(
      collector.received.map((r) => r.body.toString("base64")),
      "the collector got the client's own batches, byte for byte",
    ).toEqual(fromClient.map((sent) => sent.body));
    const metricText = metrics.map((r) => r.body.toString("utf8")).join("");
    expect(metricText, "the token counter reached the company").toContain(
      "claude_code.token.usage",
    );
    expect(metricText, "the cost counter reached the company").toContain("claude_code.cost.usage");
    for (const request of [...logs, ...metrics])
      expect(
        request.body.toString("utf8"),
        "the person's resource attributes ride every batch",
      ).toContain(EMAIL);
    expect(
      logs.map((r) => r.body.toString("utf8")).join(""),
      "the person's OTEL_LOG_USER_PROMPTS put the prompt in the records",
    ).toContain(PROMPT);
    const sent = api.requests.slice(from);
    expect(sent.length).toBeGreaterThan(0);
    expect(
      sent.map((request) => request.headers["x-team-id"]),
      "the gateway's custom header reached the model API",
    ).toEqual(sent.map(() => "platform"));
    const ids = logs.flatMap((r) => requestIds(JSON.parse(r.body.toString("utf8"))));
    expect(priced.length, "the local receiver priced the turn's call").toBeGreaterThan(0);
    expect(ids.sort(), "every priced call reached the company once").toEqual(
      priced.map((cost) => cost.requestId).sort(),
    );
    expect(metrics.length, "Claude's own metrics reached the company").toBeGreaterThan(0);
    expect(metrics.map((r) => r.body.toString("utf8")).join("")).toContain("claude_code.");
    for (const request of [...logs, ...metrics]) {
      expect(
        request.headers["user-agent"],
        "Infinitary sent it, not Claude's OpenTelemetry exporter",
      ).not.toMatch(/OTel|OpenTelemetry/i);
      expect(request.headers.authorization).toBe(`Bearer ${COMPANY_TOKEN}`);
      expect(request.headers["x-helper-token"]).toBe(HELPER_TOKEN);
    }
    expect(logs[0]?.body.toString("utf8")).toContain("department");
    console.log(
      "Company collector evidence",
      JSON.stringify({
        priced: priced.map((cost) => cost.requestId),
        received: collector.received.map((r) => ({
          path: r.path,
          contentType: r.headers["content-type"],
          bytes: r.body.length,
        })),
        requestIds: ids,
      }),
    );
    expect(
      notes.filter((line) => line.includes(COMPANY_TOKEN) || line.includes(HELPER_TOKEN)),
      "no header value reached the session's notes",
    ).toEqual([]);
  });

  it("receives the same records as protobuf over OTLP/HTTP", async () => {
    const collector = await httpCollector();
    const { priced, fromClient } = await turnWithSettings(setup("http/protobuf", collector.url));
    const logs = collector.received.filter((r) => r.path === "/v1/logs");
    expect(logs[0]?.headers["content-type"]).toBe("application/x-protobuf");
    expect(collector.received.map((r) => r.body.toString("base64"))).toEqual(
      fromClient.map((sent) => sent.body),
    );
    const decoded = JSON.stringify(logs.map((r) => decodeLogsProtobuf(r.body)));
    expect(decoded, "the email rides the protobuf logs too").toContain(EMAIL);
    expect(decoded, "with OTEL_LOG_USER_PROMPTS unset the prompt stays out").not.toContain(PROMPT);
    const ids = logs.flatMap((r) => requestIds(decodeLogsProtobuf(r.body)));
    expect(priced.length).toBeGreaterThan(0);
    expect(ids.sort()).toEqual(priced.map((cost) => cost.requestId).sort());
    expect(collector.received.some((r) => r.path === "/v1/metrics")).toBe(true);
  });

  it("receives the same records over gRPC", async () => {
    const collector = await grpcCollector();
    const { priced } = await turnWithSettings(setup("grpc", collector.url));
    const logs = collector.received.filter(
      (r) => r.path === "/opentelemetry.proto.collector.logs.v1.LogsService/Export",
    );
    const ids = logs.flatMap((r) => requestIds(decodeLogsProtobuf(r.body)));
    expect(priced.length).toBeGreaterThan(0);
    expect(ids.sort()).toEqual(priced.map((cost) => cost.requestId).sort());
    expect(logs[0]?.headers.authorization).toBe(`Bearer ${COMPANY_TOKEN}`);
    expect(
      collector.received.some(
        (r) => r.path === "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export",
      ),
    ).toBe(true);
  });

  it("gets nothing from Infinitary where an administrator's managed setup reports for Claude's client", async () => {
    const collector = await httpCollector();
    await turnWithSettings(setup("http/json", collector.url), { managed: true });
    expect(collector.received).toEqual([]);
  });
});
