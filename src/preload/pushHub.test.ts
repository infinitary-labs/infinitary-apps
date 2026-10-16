import { describe, expect, it } from "vitest";
import { createPushHub, type PushSource } from "./pushHub";

type Handler = (event: unknown, raw: unknown) => void;

/** An ipcRenderer stand-in: records attached handlers and emits pushes to them. */
function fakeIpc() {
  const handlers = new Map<string, Set<Handler>>();
  const source: PushSource = {
    on: (channel, handler) => {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)?.add(handler);
    },
    off: (channel, handler) => {
      handlers.get(channel)?.delete(handler);
    },
  };
  return {
    source,
    attached: (channel: string) => handlers.get(channel)?.size ?? 0,
    push: (channel: string, raw: unknown) => {
      for (const handler of handlers.get(channel) ?? []) handler({}, raw);
    },
  };
}

function hub(validate: (channel: string, raw: unknown) => boolean = () => true) {
  const ipc = fakeIpc();
  const validations: unknown[] = [];
  const reported: unknown[] = [];
  const pushes = createPushHub(
    ipc.source,
    (channel, raw) => {
      validations.push(raw);
      return validate(channel, raw) ? { ok: true, value: { ...(raw as object) } } : { ok: false };
    },
    (error) => reported.push(error),
  );
  return { ipc, pushes, validations, reported };
}

describe("createPushHub", () => {
  it("attaches one IPC listener per channel however many subscribe", () => {
    const { ipc, pushes } = hub();
    for (let i = 0; i < 4; i += 1) pushes.subscribe("inf:tasks", () => {});
    pushes.subscribe("inf:event", () => {});
    expect(ipc.attached("inf:tasks")).toBe(1);
    expect(ipc.attached("inf:event")).toBe(1);
  });

  it("validates each push once and hands every subscriber the same value", () => {
    const { ipc, pushes, validations } = hub();
    const seen: unknown[][] = [[], [], []];
    for (const list of seen) pushes.subscribe("inf:tasks", (value) => list.push(value));
    ipc.push("inf:tasks", { seq: 1 });
    ipc.push("inf:tasks", { seq: 2 });
    expect(validations).toHaveLength(2);
    expect(seen.map((list) => list.length)).toEqual([2, 2, 2]);
    expect(seen[1]?.[0]).toBe(seen[0]?.[0]);
    expect(seen[2]?.[1]).toEqual({ seq: 2 });
  });

  it("drops a payload the contract refuses, for every subscriber", () => {
    const { ipc, pushes } = hub((_channel, raw) => (raw as { seq: number }).seq > 0);
    const seen: unknown[] = [];
    pushes.subscribe("inf:tasks", (value) => seen.push(value));
    pushes.subscribe("inf:tasks", (value) => seen.push(value));
    ipc.push("inf:tasks", { seq: 0 });
    ipc.push("inf:tasks", { seq: 3 });
    expect(seen).toEqual([{ seq: 3 }, { seq: 3 }]);
  });

  it("keeps delivering to the others when one subscriber throws, and reports the error", () => {
    const { ipc, pushes, reported } = hub();
    const seen: unknown[] = [];
    pushes.subscribe("inf:tasks", () => {
      throw new Error("boom");
    });
    pushes.subscribe("inf:tasks", (value) => seen.push(value));
    ipc.push("inf:tasks", { seq: 1 });
    expect(seen).toEqual([{ seq: 1 }]);
    expect(reported).toEqual([new Error("boom")]);
  });

  it("detaches the IPC listener when the last subscriber leaves, and re-attaches for a new one", () => {
    const { ipc, pushes } = hub();
    const seen: unknown[] = [];
    const first = pushes.subscribe("inf:tasks", (value) => seen.push(value));
    const second = pushes.subscribe("inf:tasks", (value) => seen.push(value));
    first();
    first();
    expect(ipc.attached("inf:tasks")).toBe(1);
    ipc.push("inf:tasks", { seq: 1 });
    expect(seen).toHaveLength(1);
    second();
    expect(ipc.attached("inf:tasks")).toBe(0);
    pushes.subscribe("inf:tasks", (value) => seen.push(value));
    expect(ipc.attached("inf:tasks")).toBe(1);
    ipc.push("inf:tasks", { seq: 2 });
    expect(seen).toHaveLength(2);
  });

  it("treats the same function subscribed twice as two subscriptions", () => {
    const { ipc, pushes } = hub();
    const seen: unknown[] = [];
    const listener = (value: unknown) => seen.push(value);
    const stop = pushes.subscribe("inf:tasks", listener);
    pushes.subscribe("inf:tasks", listener);
    ipc.push("inf:tasks", { seq: 1 });
    expect(seen).toHaveLength(2);
    stop();
    ipc.push("inf:tasks", { seq: 2 });
    expect(seen).toHaveLength(3);
  });
});
