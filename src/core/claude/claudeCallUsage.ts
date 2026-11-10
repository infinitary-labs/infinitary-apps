import type { FmEvent, FmModelUsage, FmUsage } from "@shared/events";

/** The only fields kept from a local Claude cost report; no content or identity metadata. */
export type ClaudeCallCost = {
  requestId: string;
  model: string;
  cost: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

const COUNTS = ["input", "output", "cacheRead", "cacheWrite", "cost", "reasoning"] as const;

/**
 * Approved local-cost direction: a provider request ID joins the client's
 * streamed call to its price. A result settles that turn's IDs, so late
 * exports cannot charge the result again. Unidentified calls keep the
 * existing result-only accounting rather than being matched by amounts,
 * timestamps, model-name guesses or the order batches happen to arrive.
 */
export class ClaudeCallUsage {
  private readonly requests = new Map<string, string>();
  private readonly waiting = new Map<string, ClaudeCallCost>();
  private readonly charged = new Set<string>();
  private readonly live = new Map<string, FmModelUsage>();
  private readonly queued: FmModelUsage[] = [];
  private readonly streams = new Map<
    string,
    {
      id: string;
      model: string;
      requestId?: string;
      unsupported: boolean;
    }
  >();

  constructor(
    private readonly emit: (usage: FmUsage) => void,
    private readonly modelId: (model: string) => string = (model) => model,
  ) {}

  /** Join only completed streamed calls; auxiliary calls without an ID stay result-only. */
  observe(message: unknown, mainModel: string | undefined): void {
    const row = message as {
      type?: string;
      error?: unknown;
      request_id?: unknown;
      parent_tool_use_id?: unknown;
      message?: { id?: unknown; model?: unknown };
      event?: {
        type?: string;
        message?: { id?: unknown; model?: unknown };
        usage?: { iterations?: unknown };
      };
    } | null;
    if (!row) return;
    const scope = typeof row.parent_tool_use_id === "string" ? row.parent_tool_use_id : "";
    if (row.type === "stream_event" && row.event?.type === "message_start") {
      // A price is not a turn boundary. Only the next main request can
      // flush its predecessor without cutting live text or open tools.
      if (scope === "") for (const usage of this.drain()) this.emit(usage);
      const body = row.event.message;
      if (typeof body?.id === "string" && typeof body.model === "string")
        this.streams.set(scope, {
          id: body.id,
          model: this.modelId(body.model),
          unsupported: false,
        });
    }
    const stream = this.streams.get(scope);
    if (!stream) return;
    if (row.type === "assistant" && row.message?.id === stream.id) {
      if (row.error) stream.unsupported = true;
      if (typeof row.request_id === "string") stream.requestId = row.request_id;
    }
    // Advisor iterations have their own model shares in final modelUsage;
    // a request's single exported price cannot split those shares safely.
    if (
      row.event?.type === "message_delta" &&
      Array.isArray(row.event.usage?.iterations) &&
      row.event.usage.iterations.length > 0
    )
      stream.unsupported = true;
    if (row.type === "stream_event" && row.event?.type === "message_stop") {
      this.streams.delete(scope);
      if (
        !stream.unsupported &&
        stream.requestId &&
        (scope !== "" || mainModel === undefined || stream.model === this.modelId(mainModel))
      )
        this.request(stream.requestId, stream.model);
    }
  }

  request(requestId: string, model: string): void {
    if (this.charged.has(requestId)) return;
    this.requests.set(requestId, model);
    const report = this.waiting.get(requestId);
    if (report) this.report(report);
  }

  report(report: ClaudeCallCost): void {
    if (this.charged.has(report.requestId)) return;
    const model = this.requests.get(report.requestId);
    if (!model) {
      this.waiting.set(report.requestId, report);
      return;
    }
    if (model !== report.model) return;
    this.waiting.delete(report.requestId);
    this.charged.add(report.requestId);
    const part: FmModelUsage = { model, costSource: "claude" };
    for (const field of COUNTS) {
      const value = report[field];
      if (value !== undefined) part[field] = value;
    }
    this.queued.push(part);
  }

  private drain(): FmUsage[] {
    return this.queued.splice(0).map((part) => {
      const sum = this.live.get(part.model) ?? { model: part.model, costSource: "claude" };
      for (const field of COUNTS) {
        if (part[field] !== undefined) sum[field] = (sum[field] ?? 0) + part[field];
      }
      this.live.set(part.model, sum);
      const { model: _model, ...counts } = part;
      return { ...counts, models: [part] };
    });
  }

  /** Consume the ordinary turn delta, charging only what local reports did not already record. */
  settle(events: FmEvent[], cumulative?: ReadonlyMap<string, { costUsd?: number }>): FmEvent[] {
    const end = events.find((event) => event.type === "turn_end");
    // Return result-boundary charges to the caller, rather than emitting
    // them during normalization: a failed result must announce its failure
    // before any turn_end reaches the first mate's runaway guard.
    const queued: FmEvent[] = end
      ? this.drain().map((usage) => ({ type: "turn_end", taskId: end.taskId, usage }))
      : [];
    const settled = events.map((event): FmEvent => {
      if (event.type !== "turn_end" || !event.usage?.models || this.live.size === 0) return event;
      const parts = event.usage.models
        .map((part) => {
          const live = this.live.get(this.modelId(part.model));
          if (!live) return part;
          const remainder = { ...part };
          for (const field of COUNTS) {
            if (part[field] === undefined) continue;
            const consumed = Math.min(part[field], live[field] ?? 0);
            const difference = part[field] - consumed;
            const scale = Math.max(
              1,
              Math.abs(part[field]),
              Math.abs(live[field] ?? 0),
              field === "cost" ? Math.abs(cumulative?.get(part.model)?.costUsd ?? 0) : 0,
            );
            live[field] = (live[field] ?? 0) - consumed;
            // A result delta subtracts two cumulative client counters. Its
            // cancellation error is scaled to those counters and the number
            // of matched additions, not just this call's small delta.
            remainder[field] =
              Math.abs(difference) <= Number.EPSILON * scale * (this.charged.size + 1)
                ? 0
                : Math.max(0, difference);
          }
          return remainder;
        })
        .filter((part) => COUNTS.some((field) => (part[field] ?? 0) > 0));
      const { usage: _usage, ...end } = event;
      if (parts.length === 0) return end;
      const usage: FmUsage = { models: parts };
      for (const part of parts)
        for (const field of COUNTS) {
          if (part[field] !== undefined) usage[field] = (usage[field] ?? 0) + part[field];
        }
      if (usage.cost !== undefined) usage.costSource = "claude";
      return { ...end, usage };
    });
    this.streams.clear();
    this.requests.clear();
    this.waiting.clear();
    this.charged.clear();
    this.live.clear();
    this.queued.length = 0;
    return [...queued, ...settled];
  }
}
