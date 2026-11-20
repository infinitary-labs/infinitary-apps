import type { ServedInstructions, ServedState } from "../../src/core/orchestrator/seat";
import type { ModelRuntime } from "../../src/core/pi/types";
import type {
  ControlProfile,
  ModelSession,
  SessionBackend,
  SessionBinding,
  SessionEvent,
  SessionFactory,
  SessionImage,
  SessionRenewal,
  SessionResume,
  SessionSpec,
  ThinkingLevel,
} from "../../src/core/session/session";
import type { Reasoning } from "../../src/shared/reasoning";

/**
 * The profile a fake session declares unless a test names another: a
 * backend that steers natively and whose background work the host can see.
 */
export const FAKE_CONTROL_PROFILE: ControlProfile = {
  steer: "native",
  interruptGranularity: "turn",
  quotaEvents: false,
  backgroundWork: "host",
  failureSignals: "text",
};

export type FakeSessionOptions = {
  sessionId?: string;
  /** The id its events carry, as a spec's `owner`. */
  owner?: string;
  controlProfile?: ControlProfile;
  model?: { provider: string; id: string };
  modelLabel?: string;
  resume?: SessionResume;
  recordPath?: string;
  servedState?: ServedState;
  /** The reasoning the session says it opened at. */
  reasoning?: Reasoning;
  /** The session it started over from at open, taken once. */
  renewal?: SessionRenewal;
};

/** A complete `ModelSession` whose model the test plays, with what its owner sent. */
export type FakeSession = ModelSession & {
  prompts: { text: string; images?: SessionImage[] }[];
  steers: { text: string; images?: SessionImage[] }[];
  thinkingLevels: ThinkingLevel[];
  served: ServedInstructions[];
  /** Each abort, with the failure it carried. */
  aborts: (string | undefined)[];
  detaches: number;
  disposed: boolean;
  /** Any session event, to every subscriber. */
  emit(event: SessionEvent): void;
  /** Ends the running prompt. */
  settle(): void;
  /** The running prompt throws, as a backend's does when it breaks outright. */
  rejectPrompt(message: string): void;
  /**
   * From now on the run never reads a steer: each waits, as a real session's
   * does when it lands after the run's last look, and is taken idle.
   */
  holdSteers(): void;
};

/**
 * One fake behind every role's session: every member of the contract is
 * real, so an owner under test never meets a session that lacks one. A
 * prompt runs until the test settles it; an abort with a failure reports
 * `turn_failed` with it and ends the turn, the way a session's own bound
 * does; `closed()` resolves once the session is disposed.
 */
export function fakeSession(options: FakeSessionOptions = {}): FakeSession {
  const owner = options.owner ?? "firstmate";
  const listeners = new Set<(event: SessionEvent) => void>();
  let streaming = false;
  let holding = false;
  let queued: string[] = [];
  let running: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let renewal = options.renewal;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const end = (): typeof running => {
    const run = running;
    running = undefined;
    streaming = false;
    return run;
  };
  const session: FakeSession = {
    sessionId: options.sessionId ?? "fake-session",
    controlProfile: options.controlProfile ?? FAKE_CONTROL_PROFILE,
    prompts: [],
    steers: [],
    thinkingLevels: [],
    served: [],
    aborts: [],
    detaches: 0,
    disposed: false,
    resume: () => options.resume,
    recordPath: () => options.recordPath,
    modelRef: () => options.model,
    modelLabel: () => options.modelLabel ?? options.model?.id,
    reasoning: () => options.reasoning,
    isStreaming: () => streaming,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    prompt: (text, images) => {
      session.prompts.push({ text, ...(images ? { images } : {}) });
      streaming = true;
      return new Promise<void>((resolve, reject) => {
        running = { resolve, reject };
      });
    },
    steer: async (text, images) => {
      session.steers.push({ text, ...(images ? { images } : {}) });
      if (holding) queued.push(text);
    },
    takeUndeliveredSteers: () => {
      if (streaming) return [];
      const taken = queued;
      queued = [];
      return taken;
    },
    setThinkingLevel: (level) => {
      session.thinkingLevels.push(level);
    },
    serveInstructions: (instructions) => {
      session.served.push(instructions);
    },
    takeRenewal: () => {
      const taken = renewal;
      renewal = undefined;
      return taken;
    },
    servedState: () => options.servedState,
    abort: async (failure) => {
      session.aborts.push(failure);
      if (!streaming) return;
      if (failure !== undefined) {
        session.emit({ type: "turn_failed", taskId: owner, error: failure });
        session.emit({ type: "turn_end", taskId: owner });
        session.emit({ type: "turn_closed" });
      }
      session.settle();
    },
    detach: async () => {
      session.detaches += 1;
    },
    dispose: () => {
      session.disposed = true;
      markClosed();
    },
    closed: () => closed,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    settle: () => {
      end()?.resolve();
    },
    rejectPrompt: (message) => {
      end()?.reject(new Error(message));
    },
    holdSteers: () => {
      holding = true;
    },
  };
  return session;
}

/** A factory of fakes, with every spec it was opened with and every session it opened. */
export type FakeSessionFactory = SessionFactory & {
  specs: SessionSpec[];
  sessions: FakeSession[];
};

/** Opens a fake per spec, carrying the spec's owner and model. */
export function fakeSessionFactory(
  backend: SessionBackend = "pi",
  options: Omit<FakeSessionOptions, "owner" | "model"> = {},
): FakeSessionFactory {
  const controlProfile = options.controlProfile ?? FAKE_CONTROL_PROFILE;
  const factory: FakeSessionFactory = {
    backend,
    controlProfile,
    specs: [],
    sessions: [],
    open: async (spec) => {
      factory.specs.push(spec);
      const session = fakeSession({
        ...options,
        sessionId: options.sessionId ?? `fake-session-${factory.sessions.length + 1}`,
        controlProfile,
        owner: spec.owner,
        ...(spec.model ? { model: spec.model } : {}),
      });
      factory.sessions.push(session);
      return session;
    },
  };
  return factory;
}

/** A Pi binding over no runtime, for an owner whose fake factory never reads it. */
export function fakeBinding(accountId?: string): SessionBinding {
  return { backend: "pi", runtime: {} as ModelRuntime, ...(accountId ? { accountId } : {}) };
}
