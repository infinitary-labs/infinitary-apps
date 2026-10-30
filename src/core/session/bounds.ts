import { isProgressTool } from "@shared/events";
import type { Reasoning } from "@shared/reasoning";
import type { ServedInstructions, ServedState } from "../orchestrator/seat";
import { TICK_PERIOD_MS, type Ticker } from "../orchestrator/ticker";
import type {
  ControlProfile,
  ModelSession,
  SessionBounds,
  SessionEvent,
  SessionFactory,
  SessionImage,
  SessionRenewal,
  SessionResume,
  ThinkingLevel,
} from "./session";

/**
 * The watched bounds (`SessionBounds.watched`) on the host's one clock: one
 * neutral watcher for every backend, so a Pi session and a Claude session
 * are held to the same time bounds by the same arithmetic, and no session
 * owns a timer. The watcher reads only the contract - the prompt's own
 * boundaries and the session's events - and cuts a turn past a bound with
 * `abort(failure)`, which the backend reports as that turn's `turn_failed`
 * with the bound's sentence.
 *
 * Two clocks run while a prompt is open:
 * - the per-inference clock restarts when a model request starts
 *   (`request_started`) and when the last tool in flight ends, and stops
 *   while any tool runs. A backend's own housekeeping shown as a tool
 *   (`isProgressTool`: a compaction, a retry's wait) is model work, not a
 *   tool the model called, so it does not stop the clock;
 * - the whole-turn backstop runs from the prompt's start, tools or not.
 *
 * Both are checked on the ticker, so a bound fires at the first tick after
 * it is due (a 300-second bound between 300 and 360 seconds in). Once a
 * bound has cut a turn, nothing more is checked until that turn closes; a
 * prompt that goes on after it (a steer the backend still held, answered in
 * a turn of its own) starts both clocks again. What happens to a backend
 * that does not answer the cut is the backend's own hygiene.
 */

/** The host's one clock, as the watcher and a backend's own upkeep ride it (the ticker, or a test's). */
export type SessionClock = Pick<Ticker, "now" | "register">;

/** The failure line a turn reports when the per-inference bound cut it. */
export function requestTimeoutErrorMessage(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  if (seconds >= 1 && Number.isInteger(seconds)) {
    return `Request timed out after ${seconds} seconds`;
  }
  return `Request timed out after ${timeoutMs}ms`;
}

/** The failure line a turn reports when the whole-turn backstop cut it. */
export function turnTimeoutErrorMessage(timeoutMs: number): string {
  const minutes = timeoutMs / 60_000;
  if (minutes >= 1 && Number.isInteger(minutes)) {
    return `Turn timed out after ${minutes} minutes`;
  }
  return `Turn timed out after ${timeoutMs}ms`;
}

/**
 * The failure line a turn reports when a backend that counts its own model
 * requests stopped it at the spec's `maxModelTurns` (Pi; Claude's client
 * stops at `maxTurns` in its own words).
 */
export function modelTurnsErrorMessage(maxModelTurns: number): string {
  return `Turn stopped after ${maxModelTurns} model requests`;
}

/**
 * The failure line a turn reports when the model's answer kept running past
 * the spec's `maxOutputTokens` (Claude, whose client asks the model to carry
 * on three times before it gives the turn up).
 */
export function outputCapErrorMessage(maxOutputTokens: number): string {
  return `Answer kept running past the ${maxOutputTokens}-token limit`;
}

type WatchedBounds = NonNullable<SessionBounds["watched"]>;

/** What one watched session's two clocks read. */
class Watch {
  private promptOpen = false;
  private promptStartedAt = 0;
  private requestStartedAt = 0;
  private toolsInFlight = 0;
  /** A bound cut the running turn; nothing is checked until it closes. */
  private cut = false;

  constructor(
    private readonly session: ModelSession,
    private readonly bounds: WatchedBounds,
    private readonly clock: SessionClock,
  ) {}

  promptStarted(): void {
    const now = this.clock.now();
    this.promptOpen = true;
    this.cut = false;
    this.toolsInFlight = 0;
    this.promptStartedAt = now;
    this.requestStartedAt = now;
  }

  promptEnded(): void {
    this.promptOpen = false;
  }

  observe(event: SessionEvent): void {
    if (!this.promptOpen) return;
    switch (event.type) {
      case "request_started":
        this.requestStartedAt = this.clock.now();
        return;
      case "tool_start":
        if (!isProgressTool(event.toolName)) this.toolsInFlight += 1;
        return;
      case "tool_end":
        if (isProgressTool(event.toolName)) return;
        this.toolsInFlight = Math.max(0, this.toolsInFlight - 1);
        if (this.toolsInFlight === 0) this.requestStartedAt = this.clock.now();
        return;
      case "turn_closed":
        // The cut turn closed and the prompt goes on: its next turn runs
        // under bounds of its own.
        if (this.cut) this.promptStarted();
        return;
      default:
        return;
    }
  }

  check(now: number): void {
    if (!this.promptOpen || this.cut) return;
    const { requestTimeoutMs = 0, turnTimeoutMs = 0 } = this.bounds;
    if (turnTimeoutMs > 0 && now - this.promptStartedAt >= turnTimeoutMs) {
      this.cutWith(turnTimeoutErrorMessage(turnTimeoutMs));
    } else if (
      requestTimeoutMs > 0 &&
      this.toolsInFlight === 0 &&
      now - this.requestStartedAt >= requestTimeoutMs
    ) {
      this.cutWith(requestTimeoutErrorMessage(requestTimeoutMs));
    }
  }

  private cutWith(failure: string): void {
    this.cut = true;
    void this.session.abort(failure);
  }
}

/**
 * A session held to its watched bounds: the owner's session, unchanged but
 * for a prompt's boundaries, which start and stop its clocks.
 */
class WatchedSession implements ModelSession {
  constructor(
    private readonly inner: ModelSession,
    private readonly watch: Watch,
  ) {}

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get controlProfile(): ControlProfile {
    return this.inner.controlProfile;
  }

  async prompt(text: string, images?: SessionImage[], order?: string): Promise<void> {
    // A prompt the session refuses (one is already running) moves no clock.
    if (this.inner.isStreaming()) return this.inner.prompt(text, images, order);
    this.watch.promptStarted();
    try {
      await this.inner.prompt(text, images, order);
    } finally {
      this.watch.promptEnded();
    }
  }

  resume(): SessionResume | undefined {
    return this.inner.resume();
  }

  recordPath(options?: Parameters<ModelSession["recordPath"]>[0]): string | undefined {
    return this.inner.recordPath(options);
  }

  modelRef(): { provider: string; id: string } | undefined {
    return this.inner.modelRef();
  }

  modelLabel(): string | undefined {
    return this.inner.modelLabel();
  }

  isStreaming(): boolean {
    return this.inner.isStreaming();
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    return this.inner.subscribe(listener);
  }

  steer(text: string, images?: SessionImage[], order?: string): Promise<void> {
    return this.inner.steer(text, images, order);
  }

  steerFirst(text: string, images?: SessionImage[]): Promise<void> {
    return this.inner.steerFirst
      ? this.inner.steerFirst(text, images)
      : this.inner.steer(text, images);
  }

  takeUndeliveredSteers(): string[] {
    return this.inner.takeUndeliveredSteers();
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.inner.setThinkingLevel(level);
  }

  reasoning(): Reasoning | undefined {
    return this.inner.reasoning();
  }

  serveInstructions(instructions: ServedInstructions): void {
    this.inner.serveInstructions(instructions);
  }

  takeRenewal(): SessionRenewal | undefined {
    return this.inner.takeRenewal();
  }

  servedState(): ServedState | undefined {
    return this.inner.servedState();
  }

  abort(failure?: string): Promise<void> {
    return this.inner.abort(failure);
  }

  detach(): Promise<void> {
    return this.inner.detach();
  }

  dispose(): void {
    this.inner.dispose();
  }

  closed(): Promise<void> {
    return this.inner.closed();
  }
}

/**
 * The one watcher on the host's clock. `factory` wraps a backend's session
 * factory so every session whose spec carries watched bounds is held to
 * them; a session with none is handed back as its backend opened it. One
 * registration on the clock serves every watched session of every backend,
 * from the first one opened until the last one is closed.
 */
export class BoundsWatcher {
  private readonly live = new Set<Watch>();
  private unregister: (() => void) | undefined;

  constructor(private readonly clock: SessionClock) {}

  factory(inner: SessionFactory): SessionFactory {
    return {
      backend: inner.backend,
      controlProfile: inner.controlProfile,
      open: async (spec) => {
        const session = await inner.open(spec);
        const bounds = spec.bounds?.watched;
        return bounds ? this.watch(session, bounds) : session;
      },
    };
  }

  private watch(session: ModelSession, bounds: WatchedBounds): ModelSession {
    const watch = new Watch(session, bounds, this.clock);
    const unsubscribe = session.subscribe((event) => watch.observe(event));
    this.live.add(watch);
    this.unregister ??= this.clock.register("session-bounds", TICK_PERIOD_MS, (now) => {
      for (const watched of this.live) watched.check(now);
    });
    void session.closed().then(() => {
      unsubscribe();
      this.live.delete(watch);
      if (this.live.size === 0) {
        this.unregister?.();
        this.unregister = undefined;
      }
    });
    return new WatchedSession(session, watch);
  }
}
