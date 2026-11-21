import type { MoveAsk } from "./crewRuntime";

export type TurnPause = {
  computer?: string;
  row?: number;
  unstarted?: true;
  cost?: true;
  /** The computer must be updated before it takes the turn (`waitForUpdateThere`). */
  behind?: true;
  /**
   * Its conversation did not open there again (`NotOpenThere`): no update
   * paused it, and the let-go or the wait for a model says why.
   */
  notOpen?: true;
};
type End =
  | { kind: "stop"; pause?: TurnPause }
  | { kind: "cancel" | "settle" }
  | { kind: "pause"; pause: TurnPause };
type Batch = { ids: number[]; steers: number[][] };
type Phase =
  | { kind: "idle" | "stopped" }
  | {
      kind: "opening" | "preparing" | "prompt" | "continuation";
      batch: Batch;
      end?: End;
      move?: MoveAsk;
    };

function isRest(phase: Phase): phase is Extract<Phase, { kind: "idle" | "stopped" }> {
  return phase.kind === "idle" || phase.kind === "stopped";
}

/** One owner for a runtime's phase and the durable rows its current work carries. */
export class CrewTurn {
  private phase: Phase;

  constructor(kind: "opening" | "idle") {
    this.phase = kind === "idle" ? { kind } : { kind, batch: { ids: [], steers: [] } };
  }

  get stage(): Phase["kind"] {
    return this.phase.kind;
  }

  get busy(): boolean {
    return !isRest(this.phase);
  }

  get running(): boolean {
    return this.phase.kind === "prompt" || this.phase.kind === "continuation";
  }

  get end(): End["kind"] | undefined {
    return isRest(this.phase) ? undefined : this.phase.end?.kind;
  }

  get closing(): boolean {
    return this.end === "cancel" || this.end === "settle";
  }

  get pause(): Readonly<TurnPause> | undefined {
    return !isRest(this.phase) &&
      (this.phase.end?.kind === "pause" || this.phase.end?.kind === "stop")
      ? this.phase.end.pause
      : undefined;
  }

  get rows(): readonly number[] {
    return isRest(this.phase) ? [] : this.phase.batch.ids;
  }

  prepare(ids: number[]): void {
    if (isRest(this.phase)) return;
    this.phase = { ...this.phase, kind: "preparing", batch: { ids, steers: [] } };
  }

  begin(ids: number[], continuation = false): void {
    // Preparation owns the brief already; it transfers that ownership, not
    // a second copy of it, to the first real prompt. Steers stay on the lane.
    this.phase = {
      kind: continuation ? "continuation" : "prompt",
      batch: { ids, steers: [] },
      ...(isRest(this.phase) ? {} : { end: this.phase.end, move: this.phase.move }),
    };
  }

  /** Undo only this request if abort fails, never an end requested later. */
  request(kind: "stop" | "cancel" | "settle"): () => void {
    const phase = this.phase;
    if (isRest(phase)) {
      if (kind !== "settle" && kind !== "cancel") return () => {};
      this.phase = { kind: "opening", batch: { ids: [], steers: [] }, end: { kind } };
      const requested = this.phase;
      return () => {
        if (this.phase === requested) this.phase = phase;
      };
    }
    if (phase.end?.kind === "settle" || (phase.end?.kind === "cancel" && kind === "stop"))
      return () => {};
    const before = phase.end;
    const end: End = kind === "stop" ? { kind, pause: this.pause } : { kind };
    phase.end = end;
    return () => {
      if (phase.end === end) phase.end = before;
    };
  }

  takeStop(): boolean {
    if (isRest(this.phase) || this.phase.end?.kind !== "stop") return false;
    this.phase.end = this.phase.end.pause
      ? { kind: "pause", pause: this.phase.end.pause }
      : undefined;
    return true;
  }

  hold(pause: TurnPause): void {
    if (!isRest(this.phase) && !this.closing)
      this.phase.end = this.end === "stop" ? { kind: "stop", pause } : { kind: "pause", pause };
  }

  takePause(): TurnPause | undefined {
    const pause = this.pause;
    if (pause && !isRest(this.phase))
      this.phase.end = this.end === "stop" ? { kind: "stop" } : undefined;
    return pause;
  }

  queueMove(move: MoveAsk): void {
    if (!isRest(this.phase)) this.phase.move = move;
  }

  /** A steer belongs to this exact batch even if its rejection arrives late. */
  carrySteer(ids: number[]): () => void {
    if (!this.running || isRest(this.phase)) throw new Error("No running turn to steer");
    const batch = this.phase.batch;
    batch.ids.push(...ids);
    batch.steers.push(ids);
    return () => {
      batch.ids = batch.ids.filter((id) => !ids.includes(id));
      batch.steers = batch.steers.filter((steer) => steer !== ids);
    };
  }

  takeUnheard(count: number): number[] {
    if (isRest(this.phase)) return [];
    const steers = this.phase.batch.steers;
    this.phase.batch.steers = [];
    return count === 0 ? [] : steers.slice(-count).flat();
  }

  /** Every exit takes the carried batch once, before releasing or acknowledging it. */
  takeRows(): number[] {
    if (isRest(this.phase)) return [];
    const ids = this.phase.batch.ids;
    this.phase.batch.ids = [];
    return ids;
  }

  rest(kind: "idle" | "stopped" = "idle"): MoveAsk | undefined {
    if (this.rows.length) throw new Error("A turn must release its rows before resting");
    const move = isRest(this.phase) ? undefined : this.phase.move;
    this.phase = { kind };
    return move;
  }
}
