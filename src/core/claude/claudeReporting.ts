import { exec } from "node:child_process";
import { connect } from "node:http2";
import type { ResolvedSettings } from "@anthropic-ai/claude-agent-sdk";
import { loginPathCapture } from "../hostEnv";
import { type ResolveClaudeSettings, resolveSettings } from "./claudeAccess";
import type { ClaudeReportForward } from "./claudeCostReports";

/**
 * A company's Claude Code reporting setup kept where Claude Code's guide puts
 * it for each developer: the `env` block of the person's own
 * `~/.claude/settings.json`, their login shell, or the app's launch
 * environment (`docs/usage.md`, "A company's Claude Code setup").
 *
 * Claude's client never sends to it directly. It keeps reporting only to the
 * app's local receiver (`ClaudeCostReports`), which prices each call for the
 * ledger and passes each batch on unchanged to the collector this setup
 * names. An administrator's managed setup is not read here: it reaches the
 * client itself, and the receiver then stays off (`claudeCostPolicy.ts`).
 */

export type ReportingSignal = "logs" | "metrics";
export type ReportingProtocol = "http/json" | "http/protobuf" | "grpc";

/** Where one signal goes, in the protocol the setup asks for. */
export type CompanyDestination = {
  /** The full per-signal address for OTLP over HTTP; the collector's origin for gRPC. */
  endpoint: string;
  protocol: ReportingProtocol;
  /** The setup's static headers. Values often hold a company token: never logged. */
  headers: Record<string, string>;
  timeoutMs: number;
};

export type ClaudeCompanyReporting = {
  /** The collector's host, for the line in Settings → Usage. */
  host: string;
  signals: Partial<Record<ReportingSignal, CompanyDestination>>;
  /** The settings file's `otelHeadersHelper`, a command printing a JSON object of headers. */
  headersHelper?: string;
  /**
   * The setup's other keys, such as `OTEL_RESOURCE_ATTRIBUTES` or an export
   * interval, handed to the client unchanged so its records are the ones it
   * would have sent.
   */
  clientEnv: Record<string, string>;
};

/** The keys a setup is made of, wherever they are kept. */
export function isReportingKey(key: string): boolean {
  return key.startsWith("OTEL_") || key === "CLAUDE_CODE_ENABLE_TELEMETRY";
}

/** The launch environment without the setup's keys: the client gets the receiver's instead. */
export function withoutReportingKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isReportingKey(key)));
}

/** The keys that say where and how to send; the receiver sets these for the client. */
const TRANSPORT_KEY =
  /^OTEL_(?:(?:LOGS|METRICS|TRACES)_EXPORTER|EXPORTER_OTLP_(?:(?:LOGS|METRICS|TRACES)_)?(?:ENDPOINT|PROTOCOL|HEADERS|COMPRESSION|TIMEOUT|CERTIFICATE|CLIENT_KEY|CLIENT_CERTIFICATE|INSECURE))$/;

const PROTOCOLS: readonly ReportingProtocol[] = ["http/json", "http/protobuf", "grpc"];

/** OTLP's default when the setup names no protocol (OpenTelemetry's exporter specification). */
const DEFAULT_PROTOCOL: ReportingProtocol = "http/protobuf";
const DEFAULT_TIMEOUT_MS = 10_000;

function truthy(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/i.test((value ?? "").trim());
}

/** OTLP's header list: `name=value` pairs joined by commas, values percent-encoded. */
export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (value ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    let text = pair.slice(at + 1).trim();
    try {
      text = decodeURIComponent(text);
    } catch {
      // A stray percent sign is the value itself.
    }
    if (name) headers[name] = text;
  }
  return headers;
}

function destination(
  keys: Record<string, string>,
  signal: ReportingSignal,
): CompanyDestination | undefined {
  const upper = signal.toUpperCase();
  const exporters = (keys[`OTEL_${upper}_EXPORTER`] ?? "").split(",").map((name) => name.trim());
  if (!exporters.includes("otlp")) return undefined;
  const protocol = (keys[`OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`] ??
    keys.OTEL_EXPORTER_OTLP_PROTOCOL ??
    DEFAULT_PROTOCOL) as ReportingProtocol;
  if (!PROTOCOLS.includes(protocol)) return undefined;
  const own = keys[`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`]?.trim();
  const base =
    keys.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    (protocol === "grpc" ? "http://localhost:4317" : "http://localhost:4318");
  let url: URL;
  try {
    url = new URL(own || base);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const endpoint =
    protocol === "grpc"
      ? url.origin
      : own
        ? url.href
        : `${url.href.replace(/\/+$/, "")}/v1/${signal}`;
  const timeout = Number(
    keys[`OTEL_EXPORTER_OTLP_${upper}_TIMEOUT`] ?? keys.OTEL_EXPORTER_OTLP_TIMEOUT,
  );
  return {
    endpoint,
    protocol,
    headers: {
      ...parseOtlpHeaders(keys.OTEL_EXPORTER_OTLP_HEADERS),
      ...parseOtlpHeaders(keys[`OTEL_EXPORTER_OTLP_${upper}_HEADERS`]),
    },
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * The setup these keys make, or nothing when telemetry is off or no signal
 * is exported over OTLP. Traces stay with the client's own choice of none:
 * the receiver passes on logs and metrics.
 */
export function companyReportingFrom(
  keys: Record<string, string>,
  headersHelper?: string,
): ClaudeCompanyReporting | undefined {
  if (!truthy(keys.CLAUDE_CODE_ENABLE_TELEMETRY)) return undefined;
  const signals: ClaudeCompanyReporting["signals"] = {};
  for (const signal of ["logs", "metrics"] as const) {
    const found = destination(keys, signal);
    if (found) signals[signal] = found;
  }
  const first = signals.logs ?? signals.metrics;
  if (!first) return undefined;
  const clientEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(keys))
    if (key !== "CLAUDE_CODE_ENABLE_TELEMETRY" && !TRANSPORT_KEY.test(key)) clientEnv[key] = value;
  return {
    host: new URL(first.endpoint).host,
    signals,
    ...(headersHelper ? { headersHelper } : {}),
    clientEnv,
  };
}

function settingsKeys(resolved: ResolvedSettings): {
  keys: Record<string, string>;
  helper?: string;
} {
  const keys: Record<string, string> = {};
  let helper: string | undefined;
  for (const tier of resolved.sources) {
    if (tier.source !== "user") continue;
    const settings = tier.settings as { env?: unknown; otelHeadersHelper?: unknown };
    const env = settings.env && typeof settings.env === "object" ? settings.env : {};
    for (const [key, value] of Object.entries(env as Record<string, unknown>))
      if (isReportingKey(key) && (typeof value === "string" || typeof value === "number"))
        keys[key] = String(value);
    if (typeof settings.otelHeadersHelper === "string" && settings.otelHeadersHelper.trim())
      helper = settings.otelHeadersHelper.trim();
  }
  return { keys, ...(helper ? { helper } : {}) };
}

/**
 * The setup from the launch environment, the login shell's keys and the
 * person's settings file, later ones winning, as Claude Code lays its
 * settings file's `env` over the environment it started in. A settings read
 * that fails reads as no settings keys.
 */
export async function readClaudeCompanyReporting(
  launch: NodeJS.ProcessEnv,
  options: {
    resolve?: ResolveClaudeSettings;
    shell?: () => Readonly<Record<string, string>> | undefined;
  } = {},
): Promise<ClaudeCompanyReporting | undefined> {
  const keys: Record<string, string> = {};
  for (const [key, value] of Object.entries(launch))
    if (isReportingKey(key) && value !== undefined) keys[key] = value;
  Object.assign(keys, (options.shell ?? (() => loginPathCapture()?.reporting))() ?? {});
  let fromSettings: ReturnType<typeof settingsKeys> = { keys: {} };
  try {
    fromSettings = settingsKeys(
      await (options.resolve ?? resolveSettings)({ settingSources: ["user"] }),
    );
  } catch {
    // No settings keys; the environment's still count.
  }
  Object.assign(keys, fromSettings.keys);
  return companyReportingFrom(keys, fromSettings.helper);
}

/** Claude Code's own refresh period for `otelHeadersHelper`: 29 minutes. */
export const HEADERS_HELPER_REFRESH_MS = 29 * 60 * 1000;
const HEADERS_HELPER_TIMEOUT_MS = 10_000;

const helperRuns = new Map<string, { at: number; headers: Promise<Record<string, string>> }>();

/**
 * The setup's headers for one signal: its static ones and what its header
 * command prints, run as Claude's client would run it, at most once per
 * refresh period per command. A command that fails or prints something else
 * than a JSON object adds nothing, and its output never reaches a log.
 */
export async function companyHeaders(
  setup: ClaudeCompanyReporting,
  signal: ReportingSignal,
  env: NodeJS.ProcessEnv,
  now: () => number = Date.now,
  note: (line: string) => void = () => {},
): Promise<Record<string, string>> {
  const fixed = setup.signals[signal]?.headers ?? {};
  const command = setup.headersHelper;
  if (!command) return fixed;
  let run = helperRuns.get(command);
  if (!run || now() - run.at >= HEADERS_HELPER_REFRESH_MS) {
    run = { at: now(), headers: runHeadersHelper(command, env, note) };
    helperRuns.set(command, run);
  }
  return { ...fixed, ...(await run.headers) };
}

function runHeadersHelper(
  command: string,
  env: NodeJS.ProcessEnv,
  note: (line: string) => void,
): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    exec(
      command,
      { env, timeout: HEADERS_HELPER_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        try {
          if (error) throw error;
          const parsed: unknown = JSON.parse(stdout);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          resolve(
            Object.fromEntries(
              Object.entries(parsed).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
          );
        } catch {
          // i18n-exempt: a log line, never shown to a person
          note("the reporting header command did not print headers; sending without them");
          resolve({});
        }
      },
    );
  });
}

export function resetHeadersHelperForTests(): void {
  helperRuns.clear();
}

/** What the collector answered, as the client's exporter reads it back. */
export type ForwardAnswer = { status: number; contentType?: string; body: Buffer };

const GRPC_SERVICE: Record<ReportingSignal, string> = {
  logs: "/opentelemetry.proto.collector.logs.v1.LogsService/Export",
  metrics: "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export",
};

/** gRPC codes OTLP names retryable: the client then sends the batch again. */
const GRPC_RETRYABLE = new Set([1, 4, 8, 10, 11, 14, 15]);

/**
 * Send one batch, exactly the bytes Claude's client produced, to the
 * company's collector. OTLP over HTTP posts them as they are; gRPC frames
 * the same protobuf message as one unary call. Redirects are refused: the
 * headers may hold a company token.
 */
export async function postCompany(
  to: CompanyDestination,
  signal: ReportingSignal,
  body: Buffer,
  contentType: string,
  headers: Record<string, string>,
): Promise<ForwardAnswer> {
  if (to.protocol === "grpc") return postGrpc(to, signal, body, headers);
  try {
    const response = await fetch(to.endpoint, {
      method: "POST",
      headers: { ...headers, "content-type": contentType },
      body: new Uint8Array(body),
      redirect: "error",
      signal: AbortSignal.timeout(to.timeoutMs),
    });
    const type = response.headers.get("content-type");
    return {
      status: response.status,
      ...(type ? { contentType: type } : {}),
      body: Buffer.from(await response.arrayBuffer()),
    };
  } catch {
    return { status: 503, body: Buffer.alloc(0) };
  }
}

function postGrpc(
  to: CompanyDestination,
  signal: ReportingSignal,
  body: Buffer,
  headers: Record<string, string>,
): Promise<ForwardAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    let status: number | undefined;
    const finish = (code: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.close();
      resolve(
        code === 0
          ? { status: 200, contentType: "application/x-protobuf", body: Buffer.alloc(0) }
          : {
              status: code === undefined || GRPC_RETRYABLE.has(code) ? 503 : 400,
              body: Buffer.alloc(0),
            },
      );
    };
    const session = connect(to.endpoint);
    const timer = setTimeout(() => {
      session.destroy();
      finish(undefined);
    }, to.timeoutMs);
    session.on("error", () => finish(undefined));
    const lower = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    let request: ReturnType<typeof session.request>;
    try {
      request = session.request({
        ...lower,
        ":method": "POST",
        ":path": GRPC_SERVICE[signal],
        "content-type": "application/grpc",
        te: "trailers",
      });
    } catch {
      finish(undefined);
      return;
    }
    const read = (fields: Record<string, unknown>) => {
      const value = fields["grpc-status"];
      if (value !== undefined) status = Number(value);
    };
    request.on("response", (fields) => read(fields));
    request.on("trailers", (fields) => read(fields));
    request.on("error", () => finish(undefined));
    request.on("data", () => {});
    request.on("end", () => finish(status ?? 2));
    const frame = Buffer.alloc(5);
    frame.writeUInt32BE(body.length, 1);
    request.end(Buffer.concat([frame, body]));
  });
}

/** The receiver's onward leg for one attachment, under this setup. */
export function companyForward(
  setup: ClaudeCompanyReporting,
  env: NodeJS.ProcessEnv,
  note: (line: string) => void,
): ClaudeReportForward {
  const signals: ClaudeReportForward["signals"] = {};
  for (const signal of ["logs", "metrics"] as const) {
    const to = setup.signals[signal];
    if (to) signals[signal] = { protocol: to.protocol };
  }
  return {
    signals,
    clientEnv: setup.clientEnv,
    send: async (signal, body, contentType) => {
      const to = setup.signals[signal];
      if (!to) return { status: 404, body: Buffer.alloc(0) };
      const headers = await companyHeaders(setup, signal, env, Date.now, note);
      return postCompany(to, signal, body, contentType, headers);
    },
  };
}
