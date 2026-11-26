import { randomBytes } from "node:crypto";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import type { UsageWorkKind } from "@shared/usage";
import type { UsageRow } from "../storage/usageStore";
import type { TurnWords, WordsMessage } from "./sessionWords";

/**
 * The two formats a usage destination reads (docs/usage-report.md): Claude
 * Code's own names, for a company whose panels already read them, or
 * OpenTelemetry's conventions for AI calls. A destination has exactly one.
 */
export type UsageReportFormat = "claude-code" | "standard";

export type OtlpSignal = "metrics" | "logs" | "traces";

/** Who a row's work was for, as the report groups it. */
export type UsageRole = "firstmate" | "crewmate" | "other";

/** A ledger row with the grouping the report adds; never a title, project or words. */
export type ReportedRow = UsageRow & {
  role: UsageRole;
  workKind: UsageWorkKind | null;
  /** The turn span this call belongs to, when a session's turn was heard. */
  parent?: { traceId: string; spanId: string; since: number };
};

export type ReportedSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "internal" | "client";
  start: number;
  end: number;
  failed: boolean;
  attributes: Record<string, string | number>;
};

/** One batch, already projected for one destination: each signal's OTLP/HTTP JSON body. */
export type OtlpBodies = Partial<Record<OtlpSignal, unknown>>;

/**
 * The OpenTelemetry semantic conventions version the standard format's names
 * follow. The AI-call names are still marked in development, so the report
 * pins the version it was written against and says so on every scope.
 */
export const GEN_AI_SCHEMA_URL = "https://opentelemetry.io/schemas/1.37.0";

const SCOPE = { name: "infinitary.usage-report", version: "1" };

/** gen_ai.client.token.usage's advised bucket boundaries, from the conventions. */
const TOKEN_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
];

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number };
type KeyValue = { key: string; value: AnyValue };

function anyValue(value: string | number): AnyValue {
  if (typeof value === "string") return { stringValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function attributes(record: Record<string, string | number | null | undefined>): KeyValue[] {
  return Object.entries(record).flatMap(([key, value]) =>
    value === null || value === undefined ? [] : [{ key, value: anyValue(value) }],
  );
}

function nanos(ms: number): string {
  return `${BigInt(Math.round(ms)) * 1_000_000n}`;
}

function resource(destination: Record<string, string>): { attributes: KeyValue[] } {
  return { attributes: attributes({ "service.name": "infinitary", ...destination }) };
}

/** Claude's own client reports Claude work (piece 1 passes its records on), so Claude Code's format never repeats it. */
function isClaudeClientRow(row: UsageRow): boolean {
  return row.provider === CLAUDE_PROVIDER_ID;
}

/** The rows a destination Claude's own client already reports to still needs. */
export function withoutClaudeClient<Row extends UsageRow>(rows: readonly Row[]): Row[] {
  return rows.filter((row) => !isClaudeClientRow(row));
}

/** The spans such a destination still needs: every turn, and each call but Claude's own client's. */
export function withoutClaudeCalls(spans: readonly ReportedSpan[]): ReportedSpan[] {
  return spans.filter((span) => span.attributes["gen_ai.provider.name"] !== CLAUDE_PROVIDER_ID);
}

function grouping(of: {
  role: UsageRole;
  workKind: UsageWorkKind | null;
}): Record<string, string | null> {
  return { "infinitary.role": of.role, "infinitary.work_kind": of.workKind };
}

/**
 * A turn's words for a destination whose switch is on (docs/usage-report.md,
 * "Prompts and replies"), with the grouping its turn has and each tool run
 * the turn heard, by call id.
 */
export type ReportedWords = {
  words: TurnWords;
  role: UsageRole;
  workKind: UsageWorkKind | null;
  runs: ReadonlyMap<string, { failed: boolean; ms: number }>;
};

/**
 * One messages attribute's bound as JSON. Each part already has its own
 * bound; a long turn's many messages would still make one span too large
 * for a collector, so the prompts keep their first messages and the
 * replies their last.
 */
export const WORDS_ATTRIBUTE_MAX = 32_000;

/**
 * A turn's words as its span's attributes, under the conventions' names for
 * the version the format pins: the prompts it was sent as
 * gen_ai.input.messages and its replies, tool calls and their arguments as
 * gen_ai.output.messages, each a JSON string as the conventions allow on a
 * span.
 */
export function wordsAttributes(words: TurnWords): Record<string, string> {
  const input = words.messages
    .filter((message) => message.role === "user")
    .map((message) => ({ role: "user", parts: message.parts }));
  const output = words.messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      role: "assistant",
      parts: message.parts,
      finish_reason: message.finishReason ?? "stop",
    }));
  const first = boundedJson(input, "first");
  const last = boundedJson(output, "last");
  return {
    ...(first ? { "gen_ai.input.messages": first } : {}),
    ...(last ? { "gen_ai.output.messages": last } : {}),
  };
}

/**
 * The messages as JSON within the bound, keeping whole messages from one
 * end, else one message's first parts. Each message and part is serialized
 * once: a crewmate's turn runs from its start to idle and holds hundreds of
 * messages, read on the main process at each turn's end.
 */
function boundedJson(
  messages: readonly { role: string; parts: WordsMessage["parts"] }[],
  keep: "first" | "last",
): string | null {
  const ordered = keep === "first" ? messages : [...messages].reverse();
  const each = ordered.map((message) => JSON.stringify(message));
  // An array's JSON is its elements' JSON between brackets, joined by commas.
  const kept = each.slice(0, fittingCount(each, WORDS_ATTRIBUTE_MAX - 2));
  if (kept.length > 0) return `[${(keep === "first" ? kept : kept.reverse()).join(",")}]`;
  const only = ordered[0];
  if (!only) return null;
  const shell = JSON.stringify([{ ...only, parts: [] }]);
  const parts = only.parts.slice(
    0,
    fittingCount(
      only.parts.map((part) => JSON.stringify(part)),
      WORDS_ATTRIBUTE_MAX - shell.length,
    ),
  );
  return parts.length > 0 ? JSON.stringify([{ ...only, parts }]) : null;
}

/** How many of the JSON texts, from the first, fit within `room` characters joined by commas. */
function fittingCount(texts: readonly string[], room: number): number {
  let used = -1;
  let count = 0;
  for (const text of texts) {
    used += text.length + 1;
    if (used > room) break;
    count += 1;
  }
  return count;
}

type SumPoint = { attributes: Record<string, string | null>; value: number; at: number };

/** Delta sums keyed by their attribute set, so a batch sends one point per set. */
function sumPoints(points: readonly SumPoint[], since: number, asDouble: boolean) {
  const sums = new Map<string, SumPoint>();
  for (const point of points) {
    const key = JSON.stringify(point.attributes);
    const held = sums.get(key);
    if (held) {
      held.value += point.value;
      held.at = Math.max(held.at, point.at);
    } else sums.set(key, { ...point });
  }
  return [...sums.values()].map((point) => ({
    attributes: attributes(point.attributes),
    startTimeUnixNano: nanos(since),
    timeUnixNano: nanos(point.at),
    ...(asDouble ? { asDouble: point.value } : { asInt: String(Math.round(point.value)) }),
  }));
}

function sumMetric(name: string, unit: string, description: string, dataPoints: unknown[]) {
  return {
    name,
    unit,
    description,
    // 1 is AGGREGATION_TEMPORALITY_DELTA: each batch says only what it adds.
    sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints },
  };
}

const CLAUDE_CODE_TOKEN_TYPES = [
  ["input", "input"],
  ["output", "output"],
  ["cacheRead", "cacheRead"],
  ["cacheCreation", "cacheWrite"],
] as const;

/**
 * Claude Code's format: every provider but Claude's own client, under the
 * names Claude Code reports (claude_code.cost.usage, claude_code.token.usage
 * by type, the api_request event), each with a provider attribute so a
 * panel that checks spend against Anthropic's bill can filter. With
 * `withClaude`, Claude's own client's rows too, for a destination Claude's
 * client never reports to. `words` adds each turn's prompts, replies and
 * tool calls as the events Claude Code reports them under, a turn read
 * from Claude's own client's transcript only with `withClaude`.
 */
export function claudeCodeBodies(
  rows: readonly ReportedRow[],
  destination: Record<string, string>,
  since: number,
  person: Record<string, string> = {},
  withClaude = false,
  words: readonly ReportedWords[] = [],
): OtlpBodies {
  const reported = withClaude ? [...rows] : rows.filter((row) => !isClaudeClientRow(row));
  const wordsRecords = claudeCodeWordsRecords(
    withClaude ? words : words.filter((turn) => !turn.words.claude),
    person,
  );
  if (reported.length === 0 && wordsRecords.length === 0) return {};
  const labels = (row: ReportedRow) => ({
    ...person,
    model: row.model ?? "unknown",
    provider: row.provider ?? "unknown",
    ...grouping(row),
  });
  const cost = reported.flatMap((row) =>
    row.cost === null ? [] : [{ attributes: labels(row), value: row.cost, at: row.at }],
  );
  const tokens = reported.flatMap((row) =>
    CLAUDE_CODE_TOKEN_TYPES.flatMap(([type, field]) => {
      const value = row[field];
      return value === null ? [] : [{ attributes: { type, ...labels(row) }, value, at: row.at }];
    }),
  );
  const metrics = [
    ...(cost.length
      ? [
          sumMetric(
            "claude_code.cost.usage",
            "USD",
            // i18n-exempt: Claude Code's own metric description, stored by a collector
            "Cost of the session",
            sumPoints(cost, since, true),
          ),
        ]
      : []),
    ...(tokens.length
      ? [
          sumMetric(
            "claude_code.token.usage",
            "tokens",
            // i18n-exempt: Claude Code's own metric description, stored by a collector
            "Number of tokens used",
            sumPoints(tokens, since, false),
          ),
        ]
      : []),
  ];
  const logRecords = reported.map((row) => ({
    timeUnixNano: nanos(row.at),
    observedTimeUnixNano: nanos(row.at),
    body: { stringValue: "claude_code.api_request" },
    attributes: attributes({
      ...person,
      "event.name": "api_request",
      "event.timestamp": new Date(row.at).toISOString(),
      model: row.model ?? "unknown",
      provider: row.provider ?? "unknown",
      cost_usd: row.cost,
      input_tokens: row.input,
      output_tokens: row.output,
      cache_read_tokens: row.cacheRead,
      cache_creation_tokens: row.cacheWrite,
      ...grouping(row),
    }),
  }));
  const scope = { scope: SCOPE };
  return {
    ...(metrics.length
      ? {
          metrics: {
            resourceMetrics: [
              { resource: resource(destination), scopeMetrics: [{ ...scope, metrics }] },
            ],
          },
        }
      : {}),
    logs: {
      resourceLogs: [
        {
          resource: resource(destination),
          scopeLogs: [{ ...scope, logRecords: [...logRecords, ...wordsRecords] }],
        },
      ],
    },
  };
}

/** One event under Claude Code's own name for it, as its client reports one. */
function claudeCodeEvent(
  name: string,
  at: number,
  record: Record<string, string | number | null | undefined>,
) {
  return {
    timeUnixNano: nanos(at),
    observedTimeUnixNano: nanos(at),
    body: { stringValue: `claude_code.${name}` },
    attributes: attributes({
      "event.name": name,
      "event.timestamp": new Date(at).toISOString(),
      ...record,
    }),
  };
}

/**
 * A turn's words as Claude Code's own content events: user_prompt with
 * `prompt`, assistant_response with `response`, and a tool_result per call
 * with `tool_input`, and `success` and `duration_ms` when the turn heard
 * that call run.
 */
function claudeCodeWordsRecords(turns: readonly ReportedWords[], person: Record<string, string>) {
  return turns.flatMap((turn) =>
    turn.words.messages.flatMap((message) => {
      const labels = { ...person, ...grouping(turn) };
      const text = message.parts
        .flatMap((part) => (part.type === "text" ? [part.content] : []))
        .join("\n\n");
      if (message.role === "user")
        return [
          claudeCodeEvent("user_prompt", message.at, {
            ...labels,
            prompt_length: text.length,
            prompt: text,
          }),
        ];
      return [
        ...(text
          ? [
              claudeCodeEvent("assistant_response", message.at, {
                ...labels,
                response_length: text.length,
                response: text,
              }),
            ]
          : []),
        ...message.parts.flatMap((part) => {
          if (part.type !== "tool_call") return [];
          const run = turn.runs.get(part.id);
          return [
            claudeCodeEvent("tool_result", message.at, {
              ...labels,
              tool_name: part.name,
              tool_use_id: part.id,
              tool_input:
                typeof part.arguments === "string"
                  ? part.arguments
                  : JSON.stringify(part.arguments),
              ...(run ? { success: run.failed ? "false" : "true", duration_ms: run.ms } : {}),
            }),
          ];
        }),
      ];
    }),
  );
}

/**
 * gen_ai.token.type for each ledger token kind. The conventions name only
 * input and output; cache reads and writes get their own types rather than
 * folding into input, because a provider's input count may or may not
 * include them and the ledger keeps them apart.
 */
const GEN_AI_TOKEN_TYPES = [
  ["input", "input"],
  ["output", "output"],
  ["cache_read", "cacheRead"],
  ["cache_creation", "cacheWrite"],
] as const;

function genAiModel(row: ReportedRow): Record<string, string | null> {
  return row.modelSource === "served"
    ? { "gen_ai.response.model": row.model }
    : { "gen_ai.request.model": row.model };
}

function histogramPoints(points: readonly SumPoint[], since: number) {
  const groups = new Map<
    string,
    { attributes: SumPoint["attributes"]; values: number[]; at: number }
  >();
  for (const point of points) {
    const key = JSON.stringify(point.attributes);
    const held = groups.get(key);
    if (held) {
      held.values.push(point.value);
      held.at = Math.max(held.at, point.at);
    } else groups.set(key, { attributes: point.attributes, values: [point.value], at: point.at });
  }
  return [...groups.values()].map((group) => {
    const bucketCounts = new Array<number>(TOKEN_BUCKETS.length + 1).fill(0);
    for (const value of group.values) {
      const index = TOKEN_BUCKETS.findIndex((bound) => value <= bound);
      const bucket = index === -1 ? TOKEN_BUCKETS.length : index;
      bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
    }
    return {
      attributes: attributes(group.attributes),
      startTimeUnixNano: nanos(since),
      timeUnixNano: nanos(group.at),
      count: String(group.values.length),
      sum: group.values.reduce((total, value) => total + value, 0),
      min: Math.min(...group.values),
      max: Math.max(...group.values),
      bucketCounts: bucketCounts.map(String),
      explicitBounds: TOKEN_BUCKETS,
    };
  });
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** A model call's span, child of its turn when the turn was heard. */
export function callSpan(row: ReportedRow): ReportedSpan {
  const parent = row.parent;
  return {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    name: `chat ${row.model ?? "unknown"}`,
    kind: "client",
    // The ledger has no call timing: a call spans from the turn's previous
    // boundary to the moment it was recorded.
    start: Math.min(parent?.since ?? row.at, row.at),
    end: row.at,
    failed: false,
    attributes: Object.fromEntries(
      Object.entries({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": row.provider ?? "unknown",
        ...genAiModel(row),
        "gen_ai.usage.input_tokens": row.input,
        "gen_ai.usage.output_tokens": row.output,
        "gen_ai.usage.cache_read.input_tokens": row.cacheRead,
        "gen_ai.usage.cache_creation.input_tokens": row.cacheWrite,
        "infinitary.cost.usd": row.cost,
        ...grouping(row),
      }).filter((entry): entry is [string, string | number] => entry[1] !== null),
    ),
  };
}

/**
 * The standard format: all work, Claude included, under OpenTelemetry's
 * conventions for AI calls, plus infinitary.cost.usage in estimated US
 * dollars (the conventions define no cost), and the turns' spans.
 */
export function standardBodies(
  rows: readonly ReportedRow[],
  spans: readonly ReportedSpan[],
  destination: Record<string, string>,
  since: number,
  person: Record<string, string> = {},
): OtlpBodies {
  const labels = (row: ReportedRow) => ({
    ...person,
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": row.provider ?? "unknown",
    ...genAiModel(row),
    ...grouping(row),
  });
  const cost = rows.flatMap((row) =>
    row.cost === null ? [] : [{ attributes: labels(row), value: row.cost, at: row.at }],
  );
  const tokens = rows.flatMap((row) =>
    GEN_AI_TOKEN_TYPES.flatMap(([type, field]) => {
      const value = row[field];
      return value === null
        ? []
        : [{ attributes: { ...labels(row), "gen_ai.token.type": type }, value, at: row.at }];
    }),
  );
  const metrics = [
    ...(tokens.length
      ? [
          {
            name: "gen_ai.client.token.usage",
            unit: "{token}",
            // i18n-exempt: the conventions' metric description, stored by a collector
            description: "Number of input and output tokens used.",
            histogram: { aggregationTemporality: 1, dataPoints: histogramPoints(tokens, since) },
          },
        ]
      : []),
    ...(cost.length
      ? [
          sumMetric(
            "infinitary.cost.usage",
            "USD",
            // i18n-exempt: a metric description stored by a collector, never shown in the app
            "Estimated cost of model calls in US dollars.",
            sumPoints(cost, since, true),
          ),
        ]
      : []),
  ];
  const scope = { scope: SCOPE, schemaUrl: GEN_AI_SCHEMA_URL };
  return {
    ...(metrics.length
      ? {
          metrics: {
            resourceMetrics: [
              {
                resource: resource(destination),
                schemaUrl: GEN_AI_SCHEMA_URL,
                scopeMetrics: [{ ...scope, metrics }],
              },
            ],
          },
        }
      : {}),
    ...(spans.length
      ? {
          traces: {
            resourceSpans: [
              {
                resource: resource(destination),
                schemaUrl: GEN_AI_SCHEMA_URL,
                scopeSpans: [
                  {
                    ...scope,
                    spans: spans.map((span) =>
                      otlpSpan({ ...span, attributes: { ...person, ...span.attributes } }),
                    ),
                  },
                ],
              },
            ],
          },
        }
      : {}),
  };
}

function otlpSpan(span: ReportedSpan) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    // 1 is SPAN_KIND_INTERNAL, 3 SPAN_KIND_CLIENT.
    kind: span.kind === "client" ? 3 : 1,
    startTimeUnixNano: nanos(span.start),
    endTimeUnixNano: nanos(Math.max(span.start, span.end)),
    attributes: attributes(span.attributes),
    // 2 is STATUS_CODE_ERROR; an unset status says nothing failed.
    status: span.failed ? { code: 2 } : {},
  };
}
