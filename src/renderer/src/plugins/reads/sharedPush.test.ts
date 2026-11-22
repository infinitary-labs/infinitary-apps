import { describe, expect, it } from "vitest";
import { sharedSubscription } from "./sharedPush";

function fakeUpstream<Raw>() {
  const listeners = new Set<(raw: Raw) => void>();
  let subscriptions = 0;
  return {
    upstream: (listener: (raw: Raw) => void) => {
      subscriptions += 1;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (raw: Raw) => {
      for (const listener of listeners) listener(raw);
    },
    attached: () => listeners.size,
    subscriptions: () => subscriptions,
  };
}

const board = (seq: number) =>
  JSON.stringify({ seq, tasks: [{ id: "t1", flags: { blocked: false } }], links: [] });

describe("sharedSubscription", () => {
  it("crosses the upstream once and decodes once per value, whatever the subscriber count", () => {
    const up = fakeUpstream<string>();
    let decodes = 0;
    const subscribe = sharedSubscription(up.upstream, (json: string) => {
      decodes += 1;
      return JSON.parse(json) as { seq: number };
    });
    const seen: { seq: number }[][] = [[], [], [], []];
    for (const list of seen) subscribe((value) => list.push(value));
    up.emit(board(1));
    up.emit(board(2));
    expect(up.subscriptions()).toBe(1);
    expect(up.attached()).toBe(1);
    expect(decodes).toBe(2);
    expect(seen.map((list) => list.map((value) => value.seq))).toEqual([
      [1, 2],
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
    expect(seen[3]?.[1]).toBe(seen[0]?.[1]);
  });

  it("hands subscribers a frozen value, so one cannot change what the others see", () => {
    const up = fakeUpstream<string>();
    const subscribe = sharedSubscription(
      up.upstream,
      (json: string) => JSON.parse(json) as { tasks: { flags: { blocked: boolean } }[] },
    );
    const seen: { tasks: { flags: { blocked: boolean } }[] }[] = [];
    subscribe((value) => seen.push(value));
    subscribe((value) => seen.push(value));
    up.emit(board(1));
    const shared = seen[0] as { tasks: { flags: { blocked: boolean } }[] };
    const row = shared.tasks[0] as { flags: { blocked: boolean } };
    expect(() => {
      row.flags.blocked = true;
    }).toThrow(TypeError);
    expect(() => shared.tasks.push({ flags: { blocked: true } })).toThrow(TypeError);
    expect(seen[1]?.tasks).toEqual([{ id: "t1", flags: { blocked: false } }]);
  });

  it("detaches upstream when the last subscriber leaves and re-attaches on the next", () => {
    const up = fakeUpstream<string>();
    const subscribe = sharedSubscription(up.upstream, (json: string) => JSON.parse(json));
    const seen: unknown[] = [];
    const first = subscribe((value) => seen.push(value));
    const second = subscribe((value) => seen.push(value));
    first();
    first();
    expect(up.attached()).toBe(1);
    second();
    expect(up.attached()).toBe(0);
    up.emit(board(1));
    expect(seen).toHaveLength(0);
    subscribe((value) => seen.push(value));
    expect(up.subscriptions()).toBe(2);
    up.emit(board(2));
    expect(seen).toHaveLength(1);
  });

  it("keeps delivering to the others when one subscriber throws, and reports the error", () => {
    const up = fakeUpstream<string>();
    const reported: unknown[] = [];
    const subscribe = sharedSubscription(
      up.upstream,
      (json: string) => JSON.parse(json),
      (error) => reported.push(error),
    );
    const seen: unknown[] = [];
    subscribe(() => {
      throw new Error("boom");
    });
    subscribe((value) => seen.push(value));
    up.emit(board(1));
    expect(seen).toHaveLength(1);
    expect(reported).toEqual([new Error("boom")]);
  });
});
