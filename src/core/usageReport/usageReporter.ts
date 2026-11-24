import type { FmEvent } from "@shared/events";
import { isProgressTool } from "@shared/events";
import type { UsageWorkKind } from "@shared/usage";
import type { UsageRow } from "../storage/usageStore";
import {
  callSpan,
  claudeCodeBodies,
  newSpanId,
  newTraceId,
  type OtlpBodies,
  type OtlpSignal,
  type ReportedRow,
  type ReportedSpan,
  standardBodies,
  type UsageReportFormat,
  type UsageRole,
} from "./usageReportFormats";

/**
 * One place usage is reported to, in exactly one format. Its sources (a
 * company's Claude Code setup, a connection the person adds) own where it
 * comes from; the reporter only sends.
 */
export type UsageReportDestination = {
  /** Stable while the destination is unchanged; names it in log lines with its host. */
  id: string;
  format: UsageReportFormat;
  /** Full OTLP/HTTP URL per signal; a signal without one is not sent there. */
  endpoints: Partial<Record<OtlpSignal, string>>;
  /** Asked per batch; values often hold a token, so they are never logged. */
  headers(signal: OtlpSignal): Promise<Record<string, string>>;
  /** The destination's own resource attributes, such as who and which team. */
  resource: Record<string, string>;
};

export type UsageReporterOptions = {
  destinations(): readonly UsageReportDestination[];
  /** The saved work kind of a task, for grouping; never its title or project. */
  workKind(taskId: string): UsageWorkKind | null;
  /** Whether a task id is a task on the record (otherwise its work is `other`). */
  isTask(taskId: string): boolean;
  firstmateTaskId: string;
};

/** A batch goes this long after its first row or span, as Claude's client batches its own reports. */
const BATCH_MS = 5_000;

/** A turn heard but never ended, such as a session that crashed, is forgotten after this long. */
const TURN_FORGET_MS = 6 * 60 * 60 * 1000;

const POST_TIMEOUT_MS = 10_000;

type Turn = {
  traceId: string;
  spanId: string;
  start: number;
  /** The last call's moment, where the next call's span starts. */
  since: number;
  open: boolean;
  tools: Map<string, { name: string; start: number }>;
};

/**
 * Infinitary's own usage report (docs/usage-report.md): every ledger row and
 * every heard turn, batched, projected per destination into its one format
 * and posted as OTLP/HTTP JSON. Reporting never blocks a turn: a refused or
 * unreachable destination drops its batch with one log line.
 */
export class UsageReporter {
  private rows: ReportedRow[] = [];
  private spans: ReportedSpan[] = [];
  private batchSince: number;
  private readonly turns = new Map<string, Turn>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: UsageReporterOptions) {
    this.batchSince = Date.now();
  }

  /** Sends what is waiting, once, as the app stops. */
  async stop(): Promise<void> {
    await this.flush();
  }

  /** A batch goes a while after its first row or span; nothing waits while nothing is queued. */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), BATCH_MS);
    this.timer.unref?.();
  }

  private active(): boolean {
    if (this.options.destinations().length > 0) return true;
    this.rows = [];
    this.spans = [];
    this.turns.clear();
    return false;
  }

  /** The rows `UsageStore.record` just wrote. */
  recorded(rows: readonly UsageRow[]): void {
    if (rows.length === 0 || !this.active()) return;
    for (const row of rows) {
      const turn = this.turns.get(row.taskId);
      const reported: ReportedRow = {
        ...row,
        role: this.roleOf(row.taskId),
        workKind: this.options.workKind(row.taskId),
        ...(turn
          ? { parent: { traceId: turn.traceId, spanId: turn.spanId, since: turn.since } }
          : {}),
      };
      if (turn) turn.since = row.at;
      this.rows.push(reported);
      this.spans.push(callSpan(reported));
    }
    this.schedule();
  }

  /** Every broadcast event; only a session's turn and tool events are read. */
  heard(event: FmEvent): void {
    if (
      event.type !== "assistant_delta" &&
      event.type !== "tool_start" &&
      event.type !== "tool_end" &&
      event.type !== "turn_end" &&
      event.type !== "turn_failed" &&
      event.type !== "task_finished"
    ) {
      return;
    }
    if (!this.active()) return;
    const at = Date.now();
    if (event.type === "task_finished") {
      const turn = this.turns.get(event.taskId);
      if (turn?.open) this.endTurn(event.taskId, turn, at, event.status !== "completed");
      this.turns.delete(event.taskId);
      this.schedule();
      return;
    }
    const turn = this.openTurn(event.taskId, at);
    if (event.type === "tool_start" && !isProgressTool(event.toolName)) {
      turn.tools.set(event.callId, { name: event.toolName, start: at });
    } else if (event.type === "tool_end") {
      const tool = turn.tools.get(event.callId);
      if (tool) {
        turn.tools.delete(event.callId);
        this.spans.push({
          traceId: turn.traceId,
          spanId: newSpanId(),
          parentSpanId: turn.spanId,
          name: `execute_tool ${tool.name}`,
          kind: "internal",
          start: tool.start,
          end: at,
          failed: event.isError,
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": tool.name,
            "gen_ai.tool.call.id": event.callId,
          },
        });
      }
    } else if (event.type === "turn_end" || event.type === "turn_failed") {
      this.endTurn(event.taskId, turn, at, event.type === "turn_failed");
    }
    this.schedule();
  }

  private roleOf(taskId: string): UsageRole {
    if (taskId === this.options.firstmateTaskId) return "firstmate";
    return this.options.isTask(taskId) ? "crewmate" : "other";
  }

  /** The task's open turn, or a new one; a closed turn stays as the parent of calls recorded just after it ended. */
  private openTurn(taskId: string, at: number): Turn {
    const held = this.turns.get(taskId);
    if (held?.open) return held;
    for (const [id, turn] of this.turns) {
      if (at - turn.start > TURN_FORGET_MS) this.turns.delete(id);
    }
    const turn: Turn = {
      traceId: newTraceId(),
      spanId: newSpanId(),
      start: at,
      since: at,
      open: true,
      tools: new Map(),
    };
    this.turns.set(taskId, turn);
    return turn;
  }

  private endTurn(taskId: string, turn: Turn, at: number, failed: boolean): void {
    turn.open = false;
    const role = this.roleOf(taskId);
    const workKind = this.options.workKind(taskId);
    this.spans.push({
      traceId: turn.traceId,
      spanId: turn.spanId,
      name: `invoke_agent ${role}`,
      kind: "internal",
      start: turn.start,
      end: at,
      failed,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": role,
        "infinitary.role": role,
        ...(workKind ? { "infinitary.work_kind": workKind } : {}),
      },
    });
  }

  /** Sends what is waiting to every destination, each in its own format. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const rows = this.rows;
    const spans = this.spans;
    const since = this.batchSince;
    this.rows = [];
    this.spans = [];
    this.batchSince = Date.now();
    if (rows.length === 0 && spans.length === 0) return;
    await Promise.all(
      this.options.destinations().map(async (destination) => {
        const bodies: OtlpBodies =
          destination.format === "claude-code"
            ? claudeCodeBodies(rows, destination.resource, since)
            : standardBodies(rows, spans, destination.resource, since);
        await Promise.all(
          (Object.keys(bodies) as OtlpSignal[]).map((signal) =>
            this.send(destination, signal, bodies[signal]),
          ),
        );
      }),
    );
  }

  private async send(
    destination: UsageReportDestination,
    signal: OtlpSignal,
    body: unknown,
  ): Promise<void> {
    const url = destination.endpoints[signal];
    if (!url) return;
    try {
      const status = await postOtlpJson(url, await destination.headers(signal), body);
      if (status < 200 || status >= 300) {
        console.warn(
          `[usage report] ${hostOf(url)} refused a ${signal} batch (HTTP ${status}); dropped`,
        );
      }
    } catch (caught) {
      const reason = caught instanceof Error ? caught.name : "error";
      console.warn(
        `[usage report] ${hostOf(url)} unreachable for a ${signal} batch (${reason}); dropped`,
      );
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unreadable";
  }
}

/** One OTLP/HTTP JSON export; answers the HTTP status. Redirects are refused, never followed. */
export async function postOtlpJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response.status;
}
