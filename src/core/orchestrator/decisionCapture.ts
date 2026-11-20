import { createHash, randomUUID } from "node:crypto";
import { isProgressTool } from "@shared/events";
import {
  DECISION_RECORD_SCHEMA,
  type DecisionRecord,
  type ServedMessageRecord,
  type ServedSegmentRecord,
} from "@shared/provenance";
import { type FramedInput, SERVED_FRAME_VERSION } from "@shared/servedFrame";
import { redactObserveText } from "../observe/redact";
import type { SessionEvent } from "../session/session";
import type { TaskService } from "../tasks/taskService";
import type { ServedMessage, ServedState } from "./seat";

/**
 * Prospective provenance at a policy-step decision (R2): one owner per
 * decision-making agent (the Firstmate, the supervision session) opens a
 * decision when it serves a model an input and finishes it when the turn's
 * effects are known. Finishing writes ONE `decided` record through the one
 * task writer onto every task the decision touched - nothing is written on
 * a watchdog tick, a poll, or a drain that served nothing, because only
 * `begin` opens a decision and only a served input calls it.
 *
 * The record copies no served text. The exact input stays in the producer's
 * own session; the record carries the frame's typed segments (so a wake
 * and the captain's words are told apart structurally), where the input
 * landed in the session tree, the live prefix it extended, the contract and
 * producer in force, and the ids of what the decision led to.
 */

type OpenDecision = {
  id: string;
  startedAt: number;
  producer: DecisionRecord["producer"];
  contract: DecisionRecord["contract"];
  prompt: { frame: string | null; textSha256: string; segments: ServedSegmentRecord[] };
  steers: Array<{ frame: string | null; textSha256: string; segments: ServedSegmentRecord[] }>;
  tasks: Set<string>;
  cards: Set<string>;
  toolCalls: Map<string, { id: string; name: string; isError: boolean }>;
};

/** A served input's segments, with the inbox row each came from when known. */
export type ServedInput = {
  framed: FramedInput;
  /** Per segment, in order: the durable row it was delivered from. */
  rows?: Array<{ id: number; ref: string | null } | undefined>;
};

export type BeginDecision = {
  /** A short producer tag for the id (`fm`, `sv`). */
  tag: string;
  producer: DecisionRecord["producer"];
  contract: DecisionRecord["contract"];
  input: ServedInput | null;
  at?: number;
};

export type FinishDecision = {
  served: ServedState | undefined;
  outcome: DecisionRecord["disposition"]["outcome"];
  error?: string | undefined;
  inbox: DecisionRecord["disposition"]["inbox"];
  asks?: DecisionRecord["disposition"]["asks"];
  verdict?: DecisionRecord["disposition"]["verdict"];
  outcomeId?: number | null;
  handoffInboxId?: number | null;
  at?: number;
};

export function segmentsOf(input: ServedInput): ServedSegmentRecord[] {
  return input.framed.segments.map((segment, index) => {
    const row = input.rows?.[index];
    return {
      kind: segment.kind,
      ...(segment.origin ? { origin: segment.origin } : {}),
      length: segment.end - segment.start,
      ...(row ? { inboxId: row.id } : {}),
      ...(row?.ref ? { ref: row.ref } : {}),
    };
  });
}

function triggerOf(segments: ServedSegmentRecord[]): DecisionRecord["trigger"] {
  const user = segments.some((segment) => segment.kind === "user");
  const wake = segments.some((segment) => segment.kind === "wake");
  if (user && wake) return "mixed";
  return user ? "captain" : "wake";
}

export class DecisionCapture {
  private open: OpenDecision | undefined;

  constructor(private readonly tasks: TaskService) {}

  /** The decision in flight, if any: the id a control it issues carries. */
  current(): string | undefined {
    return this.open?.id;
  }

  begin(input: BeginDecision): string {
    const id = `${input.tag}-${randomUUID()}`;
    const segments = input.input ? segmentsOf(input.input) : [];
    this.open = {
      id,
      startedAt: input.at ?? Date.now(),
      producer: input.producer,
      contract: input.contract,
      prompt: {
        frame: input.input ? SERVED_FRAME_VERSION : null,
        textSha256: input.input ? sha256(input.input.framed.text) : "",
        segments,
      },
      steers: [],
      tasks: new Set(),
      cards: new Set(),
      toolCalls: new Map(),
    };
    for (const row of input.input?.rows ?? []) {
      if (row?.ref) this.noteTask(row.ref);
    }
    return id;
  }

  /** The decision acted on, or was about, a task. Unknown ids are not tasks. */
  noteTask(taskId: string): void {
    if (!this.open || !this.tasks.get(taskId)) return;
    this.open.tasks.add(taskId);
  }

  noteCard(cardId: string): void {
    this.open?.cards.add(cardId);
  }

  /** Captain words steered into the running turn. */
  noteSteer(input: ServedInput): void {
    this.open?.steers.push({
      frame: SERVED_FRAME_VERSION,
      textSha256: sha256(input.framed.text),
      segments: segmentsOf(input),
    });
  }

  /**
   * The producer seat's events: tool calls are joined by the backend's own
   * call id. A progress pseudo-tool (compaction, a retry) is not a call the
   * model made.
   */
  noteSessionEvent(event: SessionEvent): void {
    if (!this.open) return;
    if (event.type !== "tool_end" && event.type !== "tool_start") return;
    if (isProgressTool(event.toolName)) return;
    const id = event.callId;
    if (!id) return;
    const known = this.open.toolCalls.get(id);
    this.open.toolCalls.set(id, {
      id,
      name: event.toolName || known?.name || "",
      isError: event.type === "tool_end" ? event.isError : false,
    });
  }

  /**
   * The decision's effects are known: write its record on every natural
   * durable task it touched, and close it. A taskless operational wake stays
   * self-describing in the Pi session; structured capture is deferred to the
   * supervision-coverage board outcome rather than inventing an anchor.
   * Never throws - provenance must not take a turn down with it.
   */
  finish(input: FinishDecision): DecisionRecord | undefined {
    const open = this.open;
    this.open = undefined;
    if (!open) return undefined;
    for (const ask of input.asks ?? []) {
      if (ask.taskId) open.tasks.add(ask.taskId);
    }
    const record: DecisionRecord = {
      schema: DECISION_RECORD_SCHEMA,
      decision: open.id,
      startedAt: open.startedAt,
      endedAt: input.at ?? Date.now(),
      producer: open.producer,
      contract: open.contract,
      trigger: triggerOf(open.prompt.segments),
      served: open.prompt.frame === null ? null : servedRecord(open, input.served),
      disposition: {
        outcome: input.outcome,
        error: input.error ? redactObserveText(input.error) : null,
        inbox: input.inbox,
        asks: input.asks ?? [],
        toolCalls: [...open.toolCalls.values()],
        cards: [...open.cards],
        tasks: [...open.tasks].filter((taskId) => this.tasks.get(taskId)),
        verdict: input.verdict ?? null,
        outcomeId: input.outcomeId ?? null,
        handoffInboxId: input.handoffInboxId ?? null,
      },
    };
    try {
      this.tasks.turns.recordDecision(record);
    } catch (caught) {
      console.warn("[provenance] decision capture failed:", caught);
    }
    return record;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Where each served input landed, matched by the fingerprint of the exact
 * text the host sent - an input the session never recorded (a turn that
 * failed before the model saw it) keeps null locations, never a guess.
 */
function servedRecord(
  open: OpenDecision,
  state: ServedState | undefined,
): DecisionRecord["served"] {
  const promptAt =
    state?.prompt && state.prompt.textSha256 === open.prompt.textSha256 ? state.prompt : undefined;
  const unclaimed = [...(state?.steers ?? [])];
  const located = (textSha256: string): Pick<ServedMessage, "entryId" | "parentEntryId"> => {
    const at = unclaimed.findIndex((message) => message.textSha256 === textSha256);
    const [message] = at >= 0 ? unclaimed.splice(at, 1) : [];
    return { entryId: message?.entryId ?? null, parentEntryId: message?.parentEntryId ?? null };
  };
  const steers: ServedMessageRecord[] = open.steers.map((steer) => ({
    textSha256: steer.textSha256,
    ...located(steer.textSha256),
    frame: steer.frame,
    segments: steer.segments,
  }));
  return {
    sessionFile: state?.sessionFile ?? null,
    prompt: {
      textSha256: open.prompt.textSha256,
      entryId: promptAt?.entryId ?? null,
      parentEntryId: promptAt?.parentEntryId ?? null,
      frame: open.prompt.frame,
      segments: open.prompt.segments,
      prefix: promptAt?.prefix ?? null,
    },
    steers,
  };
}
