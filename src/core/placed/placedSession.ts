import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HERE } from "@shared/deviceNames";
import type { Reasoning } from "@shared/reasoning";
import type {
  PlacedEvent,
  PlacedRosterTask,
  PlacedState,
  WorkOrderChannel,
  WorkOrderResponse,
} from "@shared/work";
import { DeviceOutOfReachError } from "../connection/connection";
import { crewmateResume } from "../orchestrator/crewSession";
import type { ServedInstructions, ServedState } from "../orchestrator/seat";
import type {
  ControlProfile,
  ModelSession,
  SessionBackend,
  SessionEvent,
  SessionImage,
  SessionRenewal,
  SessionResume,
  ThinkingLevel,
} from "../session/session";
import type { CrewmateToolDelegate } from "../session/tools";

/**
 * The home's stand-in for a crewmate's conversation held on a computer that
 * runs work (docs/helper.md, "Holding a conversation"): a `ModelSession`
 * whose every control is an order to that computer (src/shared/work.ts) and
 * whose events are the ones the computer numbered and sent. What a session
 * answers at once - streaming, its model, its record - it answers from the
 * state the computer last sent.
 *
 * A prompt resolves when its turn ends there and that turn's record is
 * copied home; it rejects only for a failure the computer reports, never
 * for lost contact, which only makes it wait. A turn the computer runs that
 * this session did not start here - one a restart of this Mac left running,
 * or one that ended while it was away - is said as a continuation, with the
 * order it delivers. Disposing lets go here only: the conversation, and a
 * turn it is running, go on there.
 */

/** What the session asks of the home's side of its task (`PlacedSessions`). */
export type PlacedSessionLink = {
  readonly task: string;
  readonly backend: SessionBackend;
  /** The home's copy of the conversation's record. */
  readonly recordDir: string;
  readonly callbacks: CrewmateToolDelegate | undefined;
  /** Asks the computer one order; refused with `DeviceOutOfReachError` while it is out of reach. */
  order<C extends WorkOrderChannel>(channel: C, args: unknown): Promise<WorkOrderResponse<C>>;
  /** The computer is in reach now. */
  inReach(): boolean;
  /** Brings the record's copy home up to the computer's. */
  copy(state: PlacedState): Promise<void>;
  /** What a turn the computer quit in the middle of failed with, in the person's words. */
  interrupted(): string;
  /** The session let go here. */
  released(session: PlacedSession): void;
};

type Asked = {
  orderId: string;
  turn: number | undefined;
  resolve: () => void;
  reject: (error: Error) => void;
};

type Waiting = {
  channel: WorkOrderChannel;
  args: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const ENDED_TEXT = `This conversation was let go on ${HERE.this}.`;

export class PlacedSession implements ModelSession {
  readonly sessionId: string;
  private state: PlacedState;
  private renewal: SessionRenewal | undefined;
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  /** What it said before anyone listened, said to the first listener. */
  private unheard: SessionEvent[] = [];
  private disposed = false;
  private readonly retired: Promise<void>;
  private retire!: () => void;
  /** Prompts asked here whose turn has not ended, by order id. */
  private readonly prompts = new Map<string, Asked>();
  /** The turn the computer runs now, and whether this session started it. */
  private running: { turn: number; orderId: string; adopted: boolean } | undefined;
  /** The newest turn that ended there. */
  private lastEnded = 0;
  private undelivered: string[] = [];
  /** Orders the computer could not be reached for, asked again in order once it is back. */
  private waiting: Waiting[] = [];
  /** What runs once its first listener heard what it said before. */
  private afterHeard: (() => void)[] = [];
  /** Steers asked and not answered yet: a turn's end waits for them. */
  private readonly steering = new Set<Promise<unknown>>();

  constructor(
    private readonly link: PlacedSessionLink,
    readonly controlProfile: ControlProfile,
    opened: PlacedState,
  ) {
    this.state = opened;
    this.sessionId = opened.sessionId;
    this.renewal = opened.renewal;
    this.retired = new Promise((resolve) => {
      this.retire = resolve;
    });
  }

  get callbacks(): CrewmateToolDelegate | undefined {
    return this.link.callbacks;
  }

  get letGo(): boolean {
    return this.disposed;
  }

  resume(): SessionResume | undefined {
    return crewmateResume(this.state.resume, this.link.backend);
  }

  recordPath(): string | undefined {
    return this.state.record
      ? join(this.link.recordDir, ...this.state.record.split("/"))
      : undefined;
  }

  modelRef(): { provider: string; id: string } | undefined {
    return this.state.model;
  }

  modelLabel(): string | undefined {
    return this.state.modelLabel;
  }

  reasoning(): Reasoning | undefined {
    return this.state.reasoning;
  }

  /** The computer's own account the conversation is bound to there, as it last said; never this Mac's. */
  servingAccount(): string | undefined {
    return this.state.accountId;
  }

  isStreaming(): boolean {
    return this.running !== undefined || this.prompts.size > 0;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    const unheard = this.unheard;
    this.unheard = [];
    for (const event of unheard) listener(event);
    const after = this.afterHeard.splice(0);
    for (const run of after) run();
    return () => {
      this.listeners.delete(listener);
    };
  }

  prompt(text: string, images?: SessionImage[], order?: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error(ENDED_TEXT));
    const orderId = order ?? `prompt:${randomUUID()}`;
    return new Promise<void>((resolve, reject) => {
      const asked: Asked = { orderId, turn: undefined, resolve, reject };
      this.prompts.set(orderId, asked);
      this.send("inf:session:prompt", [
        { orderId, task: this.link.task, text, ...(images?.length ? { images } : {}) },
      ]).then(
        ({ turn }) => {
          if (this.prompts.get(orderId) !== asked) return;
          asked.turn = turn;
          // The turn ended before this answer came: asked again after a drop,
          // the computer answered it as it was.
          if (turn <= this.lastEnded && this.running?.turn !== turn) {
            this.prompts.delete(orderId);
            resolve();
            return;
          }
          if (!this.running) this.running = { turn, orderId, adopted: false };
        },
        (error: unknown) => {
          if (this.prompts.get(orderId) !== asked) return;
          this.prompts.delete(orderId);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async steer(text: string, images?: SessionImage[], order?: string): Promise<void> {
    if (this.disposed) throw new Error(ENDED_TEXT);
    const asked = this.send("inf:session:steer", [
      {
        orderId: order ?? `steer:${randomUUID()}`,
        task: this.link.task,
        text,
        ...(images?.length ? { images } : {}),
      },
    ]).then(({ delivered }) => {
      // No turn ran there to take them: the words are left over, newest
      // last, and the turn's end here gives them back.
      if (!delivered) this.undelivered.push(text);
    });
    this.steering.add(asked);
    try {
      await asked;
    } finally {
      this.steering.delete(asked);
    }
  }

  takeUndeliveredSteers(): string[] {
    const left = this.undelivered;
    this.undelivered = [];
    return left;
  }

  setThinkingLevel(_level: ThinkingLevel): void {}

  serveInstructions(_instructions: ServedInstructions): void {}

  takeRenewal(): SessionRenewal | undefined {
    const renewal = this.renewal;
    this.renewal = undefined;
    return renewal;
  }

  servedState(): ServedState | undefined {
    return undefined;
  }

  async abort(failure?: string): Promise<void> {
    if (this.disposed) return;
    const asked = this.send("inf:session:abort", [
      { orderId: `abort:${randomUUID()}`, task: this.link.task, ...(failure ? { failure } : {}) },
    ]);
    // Out of reach, it goes once the computer is back; nothing here waits for that.
    if (!this.link.inReach()) {
      void asked.catch(() => undefined);
      return;
    }
    await asked;
  }

  async detach(): Promise<void> {
    if (this.disposed || !this.link.inReach()) return;
    await this.link
      .order("inf:session:detach", [{ orderId: `detach:${randomUUID()}`, task: this.link.task }])
      .catch(() => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.unheard = [];
    this.link.released(this);
    // Whoever waits on a turn here stops waiting; the turn goes on there.
    for (const asked of this.prompts.values()) asked.resolve();
    this.prompts.clear();
    for (const waiting of this.waiting.splice(0)) waiting.reject(new Error(ENDED_TEXT));
    // Idle there, its client lets go too, and the record's copy takes its
    // last words; a running turn is never stopped.
    const running = this.running !== undefined;
    void (running ? Promise.resolve() : this.detachThere())
      .then(() => (this.link.inReach() ? this.link.copy(this.state) : undefined))
      .catch(() => undefined)
      .finally(() => this.retire());
  }

  closed(): Promise<void> {
    return this.retired;
  }

  /**
   * One event the computer numbered, in order. A turn's end resolves once
   * its record is copied home, so the next event waits for it.
   */
  async take(event: PlacedEvent): Promise<void> {
    switch (event.type) {
      case "turn_started":
        this.started(event.turn, event.orderId);
        return;
      case "turn_ended":
        await this.ended(event);
        return;
      case "background_work_changed":
        this.emit({ type: "background_work_changed", count: event.count });
        return;
      default:
        this.emit(event as SessionEvent);
    }
  }

  /** Where it resumes from there, as the computer named it. */
  resumeToken(): string | undefined {
    return this.state.resume;
  }

  /**
   * Opened there again after that computer restarted: its state now, and
   * the session it started over from when that open renewed it, taken as
   * an open's is (`takeRenewal`).
   */
  reopened(state: PlacedState): void {
    this.state = state;
    this.renewal = state.renewal;
  }

  /** Runs once someone listens and has heard what it said before: now, if someone does. */
  onceHeard(run: () => void): void {
    if (this.listeners.size > 0) run();
    else this.afterHeard.push(run);
  }

  /** The computer's roster: a turn running there that this session does not follow yet is followed now. */
  adopt(entry: PlacedRosterTask): void {
    if (entry.state) this.state = entry.state;
    const running = entry.running;
    if (!running || running.turn <= this.lastEnded || this.running?.turn === running.turn) return;
    this.started(running.turn, running.orderId);
  }

  /** The computer is back: what it could not be asked goes now, in order. */
  reached(): void {
    const waiting = this.waiting.splice(0);
    for (const order of waiting) {
      this.link.order(order.channel, order.args).then(order.resolve, (error: unknown) => {
        if (error instanceof DeviceOutOfReachError && !this.disposed) this.waiting.push(order);
        else order.reject(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }

  private started(turn: number, orderId: string): void {
    if (this.running?.turn === turn || turn <= this.lastEnded) return;
    const asked = this.prompts.get(orderId);
    if (asked) {
      asked.turn = turn;
      this.running = { turn, orderId, adopted: false };
      return;
    }
    this.running = { turn, orderId, adopted: true };
    this.emit({ type: "continuation_started", order: orderId });
  }

  private async ended(event: Extract<PlacedEvent, { type: "turn_ended" }>): Promise<void> {
    if (event.state) this.state = event.state;
    // What the turn there never took in, then the steers that came after it ended.
    this.undelivered = [...event.undelivered, ...this.undelivered];
    this.lastEnded = Math.max(this.lastEnded, event.turn);
    await this.link.copy(this.state).catch(() => undefined);
    // A steer still on its way is answered first, so its words are not lost to this end.
    while (this.steering.size > 0) await Promise.allSettled([...this.steering]);
    const running = this.running?.turn === event.turn ? this.running : undefined;
    if (running) this.running = undefined;
    const asked =
      (running && !running.adopted ? this.prompts.get(running.orderId) : undefined) ??
      [...this.prompts.values()].find((prompt) => prompt.turn === event.turn);
    const error =
      event.outcome === "interrupted"
        ? this.link.interrupted()
        : event.outcome === "failed"
          ? (event.error ?? "The turn failed there.")
          : undefined;
    if (asked) {
      this.prompts.delete(asked.orderId);
      if (event.outcome === "failed") {
        asked.reject(new Error(error));
        return;
      }
      // A turn cut off by a quit there is its task's failed turn, whose words go again.
      if (event.outcome === "interrupted")
        this.emit({ type: "turn_failed", taskId: this.link.task, error: error as string });
      asked.resolve();
      return;
    }
    if (running?.adopted)
      this.emit({ type: "continuation_ended", ...(error !== undefined ? { error } : {}) });
  }

  private emit(event: SessionEvent): void {
    if (this.disposed) return;
    if (this.listeners.size === 0) {
      this.unheard.push(event);
      return;
    }
    for (const listener of [...this.listeners]) listener(event);
  }

  /** One order, which waits for the computer to be back when it is out of reach. */
  private send<C extends WorkOrderChannel>(
    channel: C,
    args: unknown,
  ): Promise<WorkOrderResponse<C>> {
    return this.link.order(channel, args).catch((error: unknown) => {
      if (!(error instanceof DeviceOutOfReachError) || this.disposed) throw error;
      return new Promise<WorkOrderResponse<C>>((resolve, reject) => {
        this.waiting.push({
          channel,
          args,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
    });
  }

  private detachThere(): Promise<void> {
    if (!this.link.inReach()) return Promise.resolve();
    return this.link
      .order("inf:session:detach", [{ orderId: `detach:${randomUUID()}`, task: this.link.task }])
      .then(
        () => undefined,
        () => undefined,
      );
  }
}
