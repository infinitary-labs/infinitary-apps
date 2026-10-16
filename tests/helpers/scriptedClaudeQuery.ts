import type { ClaudeQueryFactory } from "../../src/core/claude/session";
import { type ClaudeSessionDeps, createClaudeSessionFactory } from "../../src/core/claude/session";
import type { SessionFactory } from "../../src/core/session/session";
import { SessionRecordStore } from "../../src/core/storage/sessionRecordStore";

/** The SDK's own types, read off the session's factory (the SDK stays behind its seam). */
type Options = Parameters<ClaudeQueryFactory>[0]["options"];
type Query = ReturnType<ClaudeQueryFactory>;
export type SDKUserMessage =
  Parameters<ClaudeQueryFactory>[0]["prompt"] extends AsyncIterable<infer M> ? M : never;

/**
 * A scripted stand-in for the SDK's `query()`, for the Claude sessions' unit
 * tests: it hands the session's input to a script, and emits whatever
 * message shapes the test (or the script) chooses - shapes captured from
 * the real client, so the sessions are driven by what the client really
 * says. Every attachment is kept, in order, so a test can see a session
 * reopen.
 */

export type ClaudeScript = {
  /** Called with each user message the session pushes. */
  onInput: (message: SDKUserMessage, emit: (message: unknown) => void) => void;
  onInterrupt?: (emit: (message: unknown) => void) => void;
  /** A client that keeps running after its input ends (one that stopped answering). */
  ignoresEndOfInput?: boolean;
};

export type ScriptedAttachment = {
  query: Query;
  options: Options;
  inputs: SDKUserMessage[];
  emit: (message: unknown) => void;
  /** End the stream the way a client exit does. */
  end: () => void;
  /** End the stream with an error, the way a crashed client does. */
  fail: (error: Error) => void;
  closed: () => boolean;
  interrupts: () => number;
  /** Every `applyFlagSettings` call, in order. */
  flagSettings: unknown[];
};

export function scriptedClaudeQuery(script: ClaudeScript): {
  factory: ClaudeQueryFactory;
  /** The latest attachment. */
  harness: () => ScriptedAttachment;
  attachments: ScriptedAttachment[];
} {
  const attachments: ScriptedAttachment[] = [];
  const factory: ClaudeQueryFactory = ({ prompt, options }) => {
    const inputs: SDKUserMessage[] = [];
    const pending: unknown[] = [];
    let deliver: ((value: IteratorResult<unknown>) => void) | undefined;
    let failWith: ((error: Error) => void) | undefined;
    let closed = false;
    let failure: Error | undefined;
    let interrupts = 0;
    const flagSettings: unknown[] = [];
    const emit = (message: unknown) => {
      if (deliver) {
        const resolve = deliver;
        deliver = undefined;
        failWith = undefined;
        resolve({ value: message, done: false });
        return;
      }
      pending.push(message);
    };
    const end = () => {
      closed = true;
      if (deliver) {
        const resolve = deliver;
        deliver = undefined;
        failWith = undefined;
        resolve({ value: undefined, done: true });
      }
    };
    const fail = (error: Error) => {
      failure = error;
      closed = true;
      if (failWith) {
        const reject = failWith;
        deliver = undefined;
        failWith = undefined;
        reject(error);
      }
    };
    // Drain the session's input stream in the background, as the client
    // does - and, as the client does, exit once that input ends.
    void (async () => {
      for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
        inputs.push(message);
        script.onInput(message, emit);
      }
      if (!script.ignoresEndOfInput) end();
    })();
    const query = {
      next: () => {
        const buffered = pending.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (failure) return Promise.reject(failure);
        if (closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<unknown>>((resolve, reject) => {
          deliver = resolve;
          failWith = reject;
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      interrupt: async () => {
        interrupts += 1;
        script.onInterrupt?.(emit);
        return undefined;
      },
      applyFlagSettings: async (settings: unknown) => {
        flagSettings.push(settings);
      },
      close: end,
    } as unknown as Query;
    const attachment: ScriptedAttachment = {
      query,
      options,
      inputs,
      emit,
      end,
      fail,
      closed: () => closed,
      interrupts: () => interrupts,
      flagSettings,
    };
    attachments.push(attachment);
    return query;
  };
  return {
    factory,
    harness: () => {
      const latest = attachments.at(-1);
      if (!latest) throw new Error("no session attached");
      return latest;
    },
    attachments,
  };
}

/** Every record store a scripted factory opened, until its stamps have landed. */
const scriptedStores: SessionRecordStore[] = [];

/** Every record a scripted factory's sessions stamped has landed: before a case's directories go. */
export async function scriptedRecordsFlushed(): Promise<void> {
  await Promise.all(scriptedStores.splice(0).map((store) => store.flushed()));
}

/**
 * Claude's session factory over a scripted client, with a client that is
 * there, a host environment of the test's own and a clock that never ticks
 * unless the test brings one: nothing reaches the machine's real client.
 * Each record dir gets one store, as production keeps, and every stamp it
 * writes lands before `scriptedRecordsFlushed` resolves.
 */
export function scriptedClaudeFactory(
  deps: Pick<ClaudeSessionDeps, "configDir" | "query"> & Partial<ClaudeSessionDeps>,
): SessionFactory {
  const stores = new Map<string, SessionRecordStore>();
  return createClaudeSessionFactory({
    env: () => ({ PATH: "/usr/bin", HOME: deps.configDir }),
    checkClient: async () => ({ state: "ready", executable: "/usr/local/bin/claude" }),
    clock: { now: () => Date.now(), register: () => () => {} },
    records: (dir) => {
      let store = stores.get(dir);
      if (!store) {
        store = new SessionRecordStore(dir);
        stores.set(dir, store);
        scriptedStores.push(store);
      }
      return store;
    },
    ...deps,
  });
}
