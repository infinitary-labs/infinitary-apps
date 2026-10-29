import type { FmEvent } from "@shared/events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { COALESCE_MS, type ReadApi, ReadExecutor, ReadSubscriptionError } from "./executor";

/**
 * The executor against a fake api: one read per subscription up front,
 * then one per invalidation the catalog entry declares, coalesced.
 */

function api() {
  const eventListeners = new Set<(event: FmEvent) => void>();
  const pushListeners = new Map<string, Set<(payload: unknown) => void>>();
  let value: unknown = "v1";
  const read = vi.fn(async () => value);
  const fake: ReadApi = {
    read,
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onPush: (channel, listener) => {
      const set = pushListeners.get(channel) ?? new Set();
      pushListeners.set(channel, set);
      set.add(listener);
      return () => set.delete(listener);
    },
  };
  return {
    fake,
    read,
    set: (next: unknown) => {
      value = next;
    },
    emit: (event: FmEvent) => {
      for (const listener of eventListeners) listener(event);
    },
    push: (channel: string, payload?: unknown) => {
      for (const listener of pushListeners.get(channel) ?? []) listener(payload);
    },
    listeners: () => ({ events: eventListeners.size, pushes: pushListeners }),
  };
}

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("ReadExecutor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs the sql read with the host's grant, again after any event, and skips an answer that says nothing new", async () => {
    const { fake, read, set, emit } = api();
    const rowsOf = (n: number, elapsedMs: number) => ({
      columns: ["n"],
      rows: [{ n }],
      truncated: false,
      elapsedMs,
    });
    set(rowsOf(1, 3));
    const values: unknown[] = [];
    const stop = new ReadExecutor(fake).subscribe(
      "sql",
      { sql: "SELECT COUNT(*) AS n FROM v_usage_v1" },
      { onValue: (v) => values.push(v), onError: () => {} },
      { sql: ["v_usage_v1"] },
    );
    await flush();
    expect(read).toHaveBeenLastCalledWith(
      "sql",
      { sql: "SELECT COUNT(*) AS n FROM v_usage_v1" },
      { sql: ["v_usage_v1"] },
    );
    // Any event re-runs it; the same rows, found in a different time, are not news.
    set(rowsOf(1, 7));
    emit({ type: "firstmate_note", text: "hi" });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(values).toEqual([rowsOf(1, 3)]);
    // New rows are.
    set(rowsOf(2, 4));
    emit({ type: "turn_end", taskId: "firstmate" });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(values).toEqual([rowsOf(1, 3), rowsOf(2, 4)]);
    // The subscriber never writes the grant: its args are strict.
    expect(() =>
      new ReadExecutor(fake).subscribe(
        "sql",
        { sql: "SELECT 1", views: ["v_tasks_v1"] },
        { onValue: () => {}, onError: () => {} },
      ),
    ).toThrow(ReadSubscriptionError);
    stop();
  });

  it("reads once on subscribe and again, coalesced, on matching events", async () => {
    const { fake, read, set, emit } = api();
    const values: unknown[] = [];
    const stop = new ReadExecutor(fake).subscribe(
      "crew.counts",
      {},
      { onValue: (v) => values.push(v), onError: () => {} },
    );
    await flush();
    expect(values).toEqual(["v1"]);
    set("v2");
    // An unrelated event is not an invalidation.
    emit({ type: "firstmate_note", text: "hi" });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
    // A burst of matching events is one read.
    for (let i = 0; i < 5; i++) {
      emit({ type: "crew_counts", working: i, idle: 0, queued: 0 });
    }
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(values).toEqual(["v1", "v2"]);
    stop();
    emit({ type: "crew_counts", working: 9, idle: 0, queued: 0 });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("scopes an event predicate to the subscription's args", async () => {
    const { fake, read, emit } = api();
    const executor = new ReadExecutor(fake);
    executor.subscribe("observe.live", { id: "task-1" }, { onValue: () => {}, onError: () => {} });
    await flush();
    emit({ type: "assistant_delta", taskId: "task-2", text: "x" });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
    emit({ type: "assistant_delta", taskId: "task-1", text: "x" });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith("observe.live", { id: "task-1" }, {});
  });

  it("re-reads on a declared push and on the poll interval", async () => {
    const { fake, read, push } = api();
    const executor = new ReadExecutor(fake);
    executor.subscribe("quota.snapshot", {}, { onValue: () => {}, onError: () => {} });
    executor.subscribe("observe.sessions", {}, { onValue: () => {}, onError: () => {} });
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    push("inf:quota");
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000 + COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(4);
    expect(read).toHaveBeenLastCalledWith("observe.sessions", {}, {});
  });

  it("takes a push declared as the value without a window or a read, and drops a stale read", async () => {
    const { fake, push } = api();
    let resolveRead: (value: unknown) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const values: unknown[] = [];
    const stop = new ReadExecutor({ ...fake, read }).subscribe(
      "tasks.board",
      {},
      { onValue: (v) => values.push(v), onError: () => {} },
    );
    // The initial read is in flight when the first push lands: the push is
    // delivered at once, and the read's older snapshot is dropped when it
    // finally resolves rather than overwriting the newer board.
    expect(read).toHaveBeenCalledTimes(1);
    push("inf:tasks", { seq: 2 });
    expect(values).toEqual([{ seq: 2 }]);
    resolveRead({ seq: 1 });
    await flush();
    expect(values).toEqual([{ seq: 2 }]);
    // Every later push is a value, synchronously, with no read behind it.
    push("inf:tasks", { seq: 3 });
    push("inf:tasks", { seq: 4 });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(values).toEqual([{ seq: 2 }, { seq: 3 }, { seq: 4 }]);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    push("inf:tasks", { seq: 5 });
    expect(values).toHaveLength(3);
  });

  it("repaints a held value on a presentation change without reading it again", async () => {
    const { fake, read, set, push } = api();
    const presentation = new Set<() => void>();
    let shown = "a";
    set({ seq: 1 });
    const values: unknown[] = [];
    const subscriber = { onValue: (v: unknown) => values.push(v), onError: () => {} };
    const executor = new ReadExecutor({
      ...fake,
      present: (_name, value) => ({ ...(value as object), shown }),
      onPresentation: (listener) => {
        presentation.add(listener);
        return () => presentation.delete(listener);
      },
    });
    // Several panels hold the board, as the app's do.
    const stops = [
      executor.subscribe("tasks.board", {}, subscriber),
      executor.subscribe("tasks.board", {}, subscriber),
    ];
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    shown = "b";
    for (const listener of presentation) listener();
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 4);
    expect(values.slice(-2)).toEqual([
      { seq: 1, shown: "b" },
      { seq: 1, shown: "b" },
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    // What the core derives from the stack still arrives on its own push.
    push("inf:tasks", { seq: 2 });
    expect(values.slice(-2)).toEqual([
      { seq: 2, shown: "b" },
      { seq: 2, shown: "b" },
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    for (const stop of stops) stop();
  });

  // INF-1860: a hover summary that opens on every row, and a Tasks panel
  // remounted on the way back from Settings, each asked the core to rebuild
  // the whole board while the app already held it.
  it("shares one read of the board among its readers and hands a later reader the held value", async () => {
    const { fake, read, set, push, listeners } = api();
    set({ seq: 1 });
    const executor = new ReadExecutor(fake);
    const held: unknown[] = [];
    const stopHeld = executor.subscribe(
      "tasks.board",
      {},
      { onValue: (v) => held.push(v), onError: () => {} },
    );
    await flush();
    expect(held).toEqual([{ seq: 1 }]);
    push("inf:tasks", { seq: 2 });
    // A summary opens and closes on each row the pointer crosses.
    for (let row = 0; row < 5; row++) {
      const seen: unknown[] = [];
      const stop = executor.subscribe(
        "tasks.board",
        {},
        { onValue: (v) => seen.push(v), onError: () => {} },
      );
      await flush();
      expect(seen).toEqual([{ seq: 2 }]);
      stop();
    }
    expect(read).toHaveBeenCalledTimes(1);
    // The one push reaches each reader once, and leaving keeps the rest attached.
    expect(listeners().pushes.get("inf:tasks")?.size).toBe(1);
    push("inf:tasks", { seq: 3 });
    expect(held).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    // With no reader left nothing holds the board, so the next reader reads it.
    stopHeld();
    expect(listeners().pushes.get("inf:tasks")?.size).toBe(0);
    executor.subscribe("tasks.board", {}, { onValue: () => {}, onError: () => {} });
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("joins a reader that arrives mid-read to that read, and retries one that follows a failure", async () => {
    const { fake } = api();
    let settle: { resolve: (v: unknown) => void; reject: (e: Error) => void } | undefined;
    const read = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          settle = { resolve, reject };
        }),
    );
    const executor = new ReadExecutor({ ...fake, read });
    const errors: unknown[] = [];
    const values: unknown[] = [];
    executor.subscribe("tasks.board", {}, { onValue: () => {}, onError: (e) => errors.push(e) });
    executor.subscribe("tasks.board", {}, { onValue: () => {}, onError: (e) => errors.push(e) });
    expect(read).toHaveBeenCalledTimes(1);
    settle?.reject(new Error("core away"));
    await flush();
    expect(errors).toHaveLength(2);
    // Nothing is held after the failure, so a new reader asks again.
    executor.subscribe("tasks.board", {}, { onValue: (v) => values.push(v), onError: () => {} });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(2);
    settle?.resolve({ seq: 1 });
    await flush();
    expect(values).toEqual([{ seq: 1 }]);
  });

  it("honours an invalidation that lands mid-read with exactly one follow-up", async () => {
    const { fake, emit } = api();
    let resolveRead: (value: unknown) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const values: unknown[] = [];
    new ReadExecutor({ ...fake, read }).subscribe(
      "crew.counts",
      {},
      { onValue: (v) => values.push(v), onError: () => {} },
    );
    expect(read).toHaveBeenCalledTimes(1);
    emit({ type: "crew_counts", working: 1, idle: 0, queued: 0 });
    emit({ type: "crew_counts", working: 2, idle: 0, queued: 0 });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
    resolveRead("first");
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(2);
    resolveRead("second");
    await flush();
    expect(values).toEqual(["first", "second"]);
  });

  it("reports a failed read to the listener and keeps going", async () => {
    const { fake, emit } = api();
    const read = vi.fn().mockRejectedValueOnce(new Error("gate closed")).mockResolvedValue("ok");
    const errors: unknown[] = [];
    const values: unknown[] = [];
    new ReadExecutor({ ...fake, read }).subscribe(
      "crew.counts",
      {},
      { onValue: (v) => values.push(v), onError: (e) => errors.push(e) },
    );
    await flush();
    expect(errors).toEqual([{ code: "read_failed", message: "gate closed" }]);
    emit({ type: "crew_counts", working: 1, idle: 0, queued: 0 });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(values).toEqual(["ok"]);
  });

  it("refuses an unknown read or bad args before reading anything", () => {
    const { fake, read } = api();
    const executor = new ReadExecutor(fake);
    const listener = { onValue: () => {}, onError: () => {} };
    expect(() => executor.subscribe("cards.list", {}, listener)).toThrow(ReadSubscriptionError);
    expect(() => executor.subscribe("cards.list", {}, listener)).toThrow(
      'no read named "cards.list"',
    );
    const codeOf = (run: () => unknown) => {
      try {
        run();
      } catch (caught) {
        return caught instanceof ReadSubscriptionError ? caught.code : "not a refusal";
      }
      return "did not throw";
    };
    expect(codeOf(() => executor.subscribe("cards.list", {}, listener))).toBe("read_unknown");
    expect(codeOf(() => executor.subscribe("observe.session", {}, listener))).toBe("bad_args");
    expect(codeOf(() => executor.subscribe("crew.counts", { extra: 1 }, listener))).toBe(
      "bad_args",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("detaches every listener and timer when stopped", async () => {
    const { fake, listeners } = api();
    const executor = new ReadExecutor(fake);
    const stop = executor.subscribe(
      "observe.sessions",
      {},
      { onValue: () => {}, onError: () => {} },
    );
    const stopQuota = executor.subscribe(
      "quota.snapshot",
      {},
      { onValue: () => {}, onError: () => {} },
    );
    expect(listeners().events).toBe(1);
    expect(listeners().pushes.get("inf:quota")?.size).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stop();
    stopQuota();
    await flush();
    expect(listeners().events).toBe(0);
    expect(listeners().pushes.get("inf:quota")?.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("folds a delta push onto the value it holds, re-reads on a gap or with no value, ignores a stale one (P5)", async () => {
    const { fake, read, set, push } = api();
    type Value = { seq: number; n: number };
    type Delta = { baseSeq: number; seq: number; add: number };
    const catalog = {
      "tasks.board": {
        channel: "inf:tasks:board",
        args: z.strictObject({}),
        toRequest: () => [],
        invalidate: {
          valueFromPush: "inf:tasks",
          deltaFromPush: {
            channel: "inf:tasks:delta",
            apply: (current: unknown, delta: unknown) => {
              const value = current as Value;
              const change = delta as Delta;
              if (change.seq <= value.seq) return value;
              if (change.baseSeq !== value.seq) return null;
              return { seq: change.seq, n: value.n + change.add };
            },
          },
        },
        description: "",
      },
    } as unknown as ConstructorParameters<typeof ReadExecutor>[1];
    set({ seq: 1, n: 10 });
    const values: unknown[] = [];
    const stop = new ReadExecutor(fake, catalog).subscribe(
      "tasks.board",
      {},
      { onValue: (v) => values.push(v), onError: () => {} },
    );
    // A delta before the first read has landed: nothing to fold onto, so
    // the read is asked for again and the delta is not delivered.
    push("inf:tasks:delta", { baseSeq: 1, seq: 2, add: 1 });
    await flush();
    expect(values).toEqual([{ seq: 1, n: 10 }]);
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(values).toEqual([
      { seq: 1, n: 10 },
      { seq: 1, n: 10 },
    ]);
    // Contiguous deltas fold on, with no read.
    push("inf:tasks:delta", { baseSeq: 1, seq: 2, add: 1 });
    push("inf:tasks:delta", { baseSeq: 2, seq: 3, add: 5 });
    expect(values.slice(2)).toEqual([
      { seq: 2, n: 11 },
      { seq: 3, n: 16 },
    ]);
    expect(read).toHaveBeenCalledTimes(2);
    // A stale delta changes nothing and delivers nothing.
    push("inf:tasks:delta", { baseSeq: 1, seq: 2, add: 100 });
    expect(values).toHaveLength(4);
    // A gap: one read, and the fresh value replaces the held one.
    set({ seq: 9, n: 99 });
    push("inf:tasks:delta", { baseSeq: 7, seq: 8, add: 1 });
    await vi.advanceTimersByTimeAsync(COALESCE_MS * 2);
    expect(read).toHaveBeenCalledTimes(3);
    expect(values.at(-1)).toEqual({ seq: 9, n: 99 });
    // And the next delta folds onto that fresh value.
    push("inf:tasks:delta", { baseSeq: 9, seq: 10, add: 1 });
    expect(values.at(-1)).toEqual({ seq: 10, n: 100 });
    // A snapshot push still replaces the value outright.
    push("inf:tasks", { seq: 20, n: 0 });
    push("inf:tasks:delta", { baseSeq: 20, seq: 21, add: 2 });
    expect(values.at(-1)).toEqual({ seq: 21, n: 2 });
    stop();
  });
});
