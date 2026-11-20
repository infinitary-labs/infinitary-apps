import { type ClaudeSignal, type CutOff, classifyClaudeSignal } from "@shared/authFailure";
import type { FmEvent, FmModelUsage, FmUsage } from "@shared/events";
import type { ClientBackgroundTask } from "../session/session";

/**
 * Normalizes Claude's session messages into the FmEvent union, the same job
 * piEvents.ts does for Pi and under the same rule: the input is `unknown`,
 * anything unrecognized maps to no events, and only FmEvent ever crosses the
 * placement seam. No Claude vocabulary reaches the orchestrator.
 */

/**
 * Cost and tokens arrive CUMULATIVE, model by model - each result carries
 * the running totals (`modelUsage`), not that turn's spend - and a client
 * that resumes a session starts from the totals it restored, not from
 * zero. The ledger stores per-turn rows, so a result's own share is the
 * client's statement of it where it gives one (`model_usage_since_last_result`,
 * the calls counted since its previous result), and otherwise each model's
 * totals less the previous ones. Getting this wrong would over-count every
 * turn after the first, and the first after every resume. A field the
 * client did not report for a model stays absent, never zero.
 */
export type ClaudeTurnTotals = {
  costUsd?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** The running totals of a result that names no model (no `modelUsage`). */
const UNNAMED = "";

export type ClaudeNormalizerState = {
  /**
   * Running totals last reported, per model, to turn cumulative counters
   * into deltas.
   */
  totals: Map<string, ClaudeTurnTotals>;
  /** Tool calls seen this session, so tool_end can name its tool. */
  toolNames: Map<string, string>;
  /**
   * The typed signals seen since the last result - an assistant message's
   * `error`, the latest pushed rate-limit reading - which that turn's result
   * is classified with, then cleared.
   */
  turnSignal: Pick<
    ClaudeSignal,
    "assistantError" | "rateLimitStatus" | "resetsAt" | "overageStatus"
  >;
};

export function createNormalizerState(): ClaudeNormalizerState {
  return { totals: new Map(), toolNames: new Map(), turnSignal: {} };
}

export type ClaudeRateLimit = {
  status: "allowed" | "allowed_warning" | "rejected";
  utilization?: number;
  /** Epoch ms (the session pushes epoch seconds; the normalizer converts). */
  resetsAt?: number;
  windowId?: string;
  /** Whether extra usage would answer past the plan window, as the session said it. */
  overageStatus?: "allowed" | "allowed_warning" | "rejected";
  /** Why extra usage cannot answer (`out_of_credits`, `org_level_disabled`, ...), the client's own code. */
  overageDisabledReason?: string;
  /** The session says it is answering on extra usage right now. */
  usingOverage?: boolean;
};

/**
 * A turn the session reported as failed, classified from its typed fields
 * (`classifyClaudeSignal`). `error` is the session's own words, kept for
 * the record and the failure line; nothing classifies it. `outputCapped`
 * says, from the turn's typed error, that the answer kept running past the
 * output cap: the one failure whose line a session words itself, since it
 * set the cap.
 */
export type ClaudeTurnFailure = {
  error: string;
  cutOff?: CutOff;
  outputCapped?: true;
  contextOverflow?: true;
};

/**
 * Claude Code's refusal fallback (`model_refusal_fallback`): the model the
 * session asked for ended a reply with a refusal, and the client answered on
 * `to` instead. `scope` is the client's: `session` swaps the session's model
 * for the rest of the session (an older client that names no scope means
 * it), `local` only a subagent's or side question's answer. `category` is
 * the provider's open-ended refusal category (`cyber`), when it named one.
 */
export type ClaudeModelFallback = {
  from: string;
  to: string;
  scope: "session" | "local";
  category?: string;
};

export type ClaudeNormalizeResult = {
  events: FmEvent[];
  backgroundJobs?: number;
  /**
   * With `backgroundJobs`, the client's background tasks that end with it
   * (`background_tasks_changed`, measured on 2.1.234): each by the id the
   * model was given, with the description the model gave it.
   */
  backgroundTasks?: ClientBackgroundTask[];
  /** A plan-window reading the session pushed, for the quota surface. */
  rateLimit?: ClaudeRateLimit;
  /** The turn's final assistant text, for the task-result card body. */
  finalText?: string;
  /** The turn failed: why, typed, with the session's own words beside it. */
  failure?: ClaudeTurnFailure;
  /** The client moved off the model it was asked for. */
  fallback?: ClaudeModelFallback;
};

const EMPTY: ClaudeNormalizeResult = { events: [] };

export function fmEventsFromClaudeMessage(
  message: unknown,
  taskId: string,
  state: ClaudeNormalizerState,
): ClaudeNormalizeResult {
  if (!isRecord(message) || typeof message.type !== "string") return EMPTY;
  switch (message.type) {
    case "system":
      if (
        message.subtype === "background_tasks_changed" &&
        Array.isArray(message.tasks) &&
        message.tasks.every(
          (task) =>
            isRecord(task) &&
            typeof task.task_id === "string" &&
            typeof task.task_type === "string",
        )
      ) {
        const tasks = message.tasks as {
          task_id: string;
          task_type: string;
          description?: unknown;
        }[];
        return {
          events: [],
          backgroundJobs: tasks.length,
          // A remote task runs where the client started it, so the client's
          // end is not its end; every other one runs inside the client.
          backgroundTasks: tasks.flatMap((task) =>
            task.task_type.startsWith("remote_")
              ? []
              : [
                  {
                    id: task.task_id,
                    description:
                      typeof task.description === "string" && task.description.trim()
                        ? task.description.trim()
                        : task.task_type,
                  },
                ],
          ),
        };
      }
      if (
        message.subtype === "model_refusal_fallback" &&
        typeof message.original_model === "string" &&
        typeof message.fallback_model === "string"
      ) {
        const category = message.api_refusal_category;
        return {
          events: [],
          fallback: {
            from: message.original_model,
            to: message.fallback_model,
            scope: message.scope === "local" ? "local" : "session",
            ...(typeof category === "string" && category ? { category } : {}),
          },
        };
      }
      return EMPTY;
    case "stream_event":
      return { events: deltaEvents(message.event, taskId) };
    case "assistant": {
      // The typed `SDKAssistantMessageError` an API failure carries - the
      // turn's own only: a subagent's message (`parent_tool_use_id` set) can
      // carry an error the main agent recovered from.
      const mainThread =
        message.parent_tool_use_id === null || message.parent_tool_use_id === undefined;
      if (mainThread && typeof message.error === "string") {
        state.turnSignal.assistantError = message.error;
      }
      return { events: toolStartEvents(message.message, taskId, state) };
    }
    case "user":
      return { events: toolEndEvents(message.message, taskId, state) };
    case "rate_limit_event": {
      const rateLimit = readRateLimit(message.rate_limit_info);
      if (!rateLimit) return EMPTY;
      state.turnSignal.rateLimitStatus = rateLimit.status;
      if (rateLimit.resetsAt !== undefined) state.turnSignal.resetsAt = rateLimit.resetsAt;
      else delete state.turnSignal.resetsAt;
      if (rateLimit.overageStatus !== undefined)
        state.turnSignal.overageStatus = rateLimit.overageStatus;
      else delete state.turnSignal.overageStatus;
      return { events: [], rateLimit };
    }
    case "result": {
      const usage = turnUsage(message, state);
      const finalText = typeof message.result === "string" ? message.result : undefined;
      const failure = turnFailure(message, state);
      return {
        events: [{ type: "turn_end", taskId, ...(usage ? { usage } : {}) }],
        ...(finalText ? { finalText } : {}),
        ...(failure ? { failure } : {}),
      };
    }
    default:
      return EMPTY;
  }
}

/** The host's words for a failed turn the session gave no words of its own. */
export const STOPPED_EARLY_TEXT = "The turn stopped before it finished.";

/**
 * Classify a result with the turn's typed signals, then clear them for the
 * next turn. The words are the session's own: an API error's result text,
 * else the `errors` an `error_*` result lists.
 */
function turnFailure(
  message: Record<string, unknown>,
  state: ClaudeNormalizerState,
): ClaudeTurnFailure | undefined {
  const outputCapped = state.turnSignal.assistantError === "max_output_tokens";
  const outcome = classifyClaudeSignal({
    ...state.turnSignal,
    ...(typeof message.subtype === "string" ? { resultSubtype: message.subtype } : {}),
    isError: message.is_error === true,
    ...(typeof message.api_error_status === "number"
      ? { apiErrorStatus: message.api_error_status }
      : {}),
    ...(typeof message.terminal_reason === "string"
      ? { terminalReason: message.terminal_reason }
      : {}),
  });
  state.turnSignal = {};
  if (outcome.kind === "ok") return undefined;
  const errors = Array.isArray(message.errors)
    ? message.errors.filter(
        (line): line is string => typeof line === "string" && line.trim() !== "",
      )
    : [];
  const result = typeof message.result === "string" ? message.result.trim() : "";
  const subtype = typeof message.subtype === "string" ? message.subtype : undefined;
  const error =
    result ||
    errors.join("\n") ||
    (subtype && subtype !== "success"
      ? `The turn stopped before it finished (${subtype}).`
      : STOPPED_EARLY_TEXT);
  if (outcome.kind === "cut-off") return { error, cutOff: outcome.cutOff };
  if (message.terminal_reason === "prompt_too_long") return { error, contextOverflow: true };
  return outputCapped ? { error, outputCapped: true } : { error };
}

/** Text and thinking deltas, from the Messages API streaming events. */
function deltaEvents(event: unknown, taskId: string): FmEvent[] {
  if (!isRecord(event) || event.type !== "content_block_delta") return [];
  const delta = event.delta;
  if (!isRecord(delta)) return [];
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return [{ type: "assistant_delta", taskId, text: delta.text }];
  }
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    return [{ type: "thinking_delta", taskId, text: delta.thinking }];
  }
  return [];
}

function toolStartEvents(
  message: unknown,
  taskId: string,
  state: ClaudeNormalizerState,
): FmEvent[] {
  const events: FmEvent[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type !== "tool_use") continue;
    const callId = typeof block.id === "string" ? block.id : undefined;
    const toolName = typeof block.name === "string" ? block.name : undefined;
    if (!callId || !toolName) continue;
    state.toolNames.set(callId, toolName);
    events.push({ type: "tool_start", taskId, callId, toolName });
  }
  return events;
}

/** Tool results come back as user-role blocks answering each tool_use. */
function toolEndEvents(message: unknown, taskId: string, state: ClaudeNormalizerState): FmEvent[] {
  const events: FmEvent[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type !== "tool_result") continue;
    const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!callId) continue;
    const toolName = state.toolNames.get(callId);
    if (!toolName) continue;
    state.toolNames.delete(callId);
    events.push({ type: "tool_end", taskId, callId, toolName, isError: block.is_error === true });
  }
  return events;
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** Each token field of a model's totals, and the usage field it becomes. */
const TOKEN_FIELDS = [
  ["input", "input"],
  ["output", "output"],
  ["cacheRead", "cacheRead"],
  ["cacheWrite", "cacheWrite"],
] as const satisfies readonly (readonly [keyof ClaudeTurnTotals, keyof FmModelUsage])[];

type TurnPart = Omit<FmModelUsage, "model"> & { model: string };

/**
 * What this turn actually spent, model by model. The client's own statement
 * of the calls since its previous result is that share whole (`{}` says
 * nothing was counted), whatever its totals restored on a resume. A result
 * without one (an older client) gives the delta since the last result: a
 * total below the last one means the client started counting over (a new
 * client, a reset), so that figure is the turn's own; a result reported
 * twice spends nothing the second time. The totals are followed either way,
 * so a result without a statement after one with it subtracts from the
 * right baseline.
 */
function turnUsage(
  message: Record<string, unknown>,
  state: ClaudeNormalizerState,
): FmUsage | undefined {
  const stated = readModels(message.model_usage_since_last_result);
  const parts: TurnPart[] = [];
  for (const [model, spent] of stated ?? []) {
    const part = spentPart(model, (field) => spent[field]);
    if (part) parts.push(part);
  }
  for (const [model, next] of readTotals(message)) {
    const last = state.totals.get(model) ?? {};
    const fields = [...TOKEN_FIELDS.map(([from]) => from), "costUsd"] as const;
    const restarted = fields.some(
      (field) =>
        next[field] !== undefined && last[field] !== undefined && next[field] < last[field],
    );
    // Omission says nothing about a counter: keep its baseline, but emit no
    // value for it. A proven restart discards the old model's whole baseline.
    state.totals.set(model, restarted ? next : { ...last, ...next });
    if (stated) continue;
    const part = spentPart(model, (field) => {
      const value = next[field];
      if (value === undefined) return undefined;
      return restarted ? value : value - (last[field] ?? 0);
    });
    if (part) parts.push(part);
  }
  if (parts.length === 0) return undefined;
  const usage: FmUsage = {};
  for (const part of parts) {
    for (const [, into] of TOKEN_FIELDS) {
      const value = part[into];
      if (value !== undefined) usage[into] = (usage[into] ?? 0) + value;
    }
    if (part.cost !== undefined) {
      usage.cost = (usage.cost ?? 0) + part.cost;
      usage.costSource = "claude";
    }
  }
  const named = parts.filter((part) => part.model !== UNNAMED);
  return named.length > 0 ? { ...usage, models: named } : usage;
}

/** One model's spend as a turn part, or nothing when it spent nothing. */
function spentPart(
  model: string,
  value: (field: keyof ClaudeTurnTotals) => number | undefined,
): TurnPart | undefined {
  const part: TurnPart = { model };
  let spent = false;
  for (const [from, into] of TOKEN_FIELDS) {
    const tokens = value(from);
    if (tokens === undefined) continue;
    part[into] = tokens;
    if (tokens > 0) spent = true;
  }
  const cost = value("costUsd");
  if (cost !== undefined && cost > 0) {
    part.cost = cost;
    part.costSource = "claude";
    spent = true;
  }
  return spent ? part : undefined;
}

/** One model's counters as the client writes them, either spelling. */
function readCounters(row: Record<string, unknown>, cost: number | undefined): ClaudeTurnTotals {
  const fields: ClaudeTurnTotals = {
    input: num(row.inputTokens) ?? num(row.input_tokens),
    output: num(row.outputTokens) ?? num(row.output_tokens),
    cacheRead: num(row.cacheReadInputTokens) ?? num(row.cache_read_input_tokens),
    cacheWrite: num(row.cacheCreationInputTokens) ?? num(row.cache_creation_input_tokens),
    costUsd: cost,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as ClaudeTurnTotals;
}

/**
 * A map of model name to counters (`modelUsage`, or the calls since the
 * previous result), or nothing when the result does not carry one.
 */
function readModels(field: unknown): Map<string, ClaudeTurnTotals> | undefined {
  if (!isRecord(field)) return undefined;
  const models = new Map<string, ClaudeTurnTotals>();
  for (const [model, row] of Object.entries(field)) {
    if (model && isRecord(row)) models.set(model, readCounters(row, num(row.costUSD)));
  }
  return models;
}

/**
 * Each model's running totals, from modelUsage - the field that covers
 * every model call the turn made, including subagents and compaction, not
 * just the main loop - else the main loop's usage under no name.
 */
function readTotals(message: Record<string, unknown>): Map<string, ClaudeTurnTotals> {
  const named = readModels(message.modelUsage);
  if (named && Object.keys(message.modelUsage as object).length > 0) return named;
  const totals = new Map<string, ClaudeTurnTotals>();
  if (isRecord(message.usage)) {
    totals.set(UNNAMED, readCounters(message.usage, num(message.total_cost_usd)));
  }
  return totals;
}

/**
 * The plan-window reading Claude pushes mid-session - the one quota source
 * no HTTP sensor can reach, because it is a property of the live session.
 */
function readRateLimit(info: unknown): ClaudeRateLimit | undefined {
  if (!isRecord(info)) return undefined;
  const status = info.status;
  if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") {
    return undefined;
  }
  const utilization = num(info.utilization);
  // The session pushes the reset as epoch SECONDS (the API's
  // `anthropic-ratelimit-unified-*-reset`); everything past this seam is ms.
  const resetsAtSeconds = num(info.resetsAt);
  const resetsAt = resetsAtSeconds !== undefined ? resetsAtSeconds * 1000 : undefined;
  const windowId = typeof info.rateLimitType === "string" ? info.rateLimitType : undefined;
  const overage = info.overageStatus;
  const overageStatus =
    overage === "allowed" || overage === "allowed_warning" || overage === "rejected"
      ? overage
      : undefined;
  const overageDisabledReason =
    typeof info.overageDisabledReason === "string" && info.overageDisabledReason !== ""
      ? info.overageDisabledReason
      : undefined;
  // `isUsingOverage` is the field the client documents; `overageInUse` is
  // its other spelling of the same fact.
  const using =
    typeof info.isUsingOverage === "boolean"
      ? info.isUsingOverage
      : typeof info.overageInUse === "boolean"
        ? info.overageInUse
        : undefined;
  return {
    status,
    ...(utilization !== undefined ? { utilization } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowId ? { windowId } : {}),
    ...(overageStatus ? { overageStatus } : {}),
    ...(overageDisabledReason ? { overageDisabledReason } : {}),
    ...(using !== undefined ? { usingOverage: using } : {}),
  };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
