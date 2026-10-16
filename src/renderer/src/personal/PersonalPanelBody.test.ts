import type { PersonalStoreChange } from "@shared/personal/manifest";
import { describe, expect, it, vi } from "vitest";
import { bindInvoke, bindReads, bindStore, type ReadSubscriber } from "./PersonalPanelBody";

/**
 * The declared reads (Step 4, decision Q3): the manifest's `reads` is the
 * grant. A declared name rides the executor; an undeclared one - or a
 * catalog name the panel contract does not serve - throws before anything
 * is subscribed.
 */
describe("bindReads", () => {
  it("serves exactly the declared reads through the executor and stops them", () => {
    const stop = vi.fn();
    const executor: ReadSubscriber = {
      subscribe: vi.fn((name, args, listener) => {
        expect(args).toEqual({});
        listener.onValue({ name, seq: 1 });
        return stop;
      }),
    };
    const reads = bindReads(["feed.recent", "tasks.board"], executor);
    const seen: unknown[] = [];
    const off = reads.subscribe("feed.recent", (value) => seen.push(value));
    expect(seen).toEqual([{ name: "feed.recent", seq: 1 }]);
    off();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(() => reads.subscribe("quota.snapshot", () => {})).toThrow(
      /"quota.snapshot" is not a read this panel declared/,
    );
    expect(executor.subscribe).toHaveBeenCalledTimes(1);
  });

  it("reads one task by its id and closed work by its words, the arguments passed through", () => {
    const executor: ReadSubscriber = { subscribe: vi.fn(() => () => {}) };
    const reads = bindReads(["tasks.detail", "tasks.search"], executor);
    reads.subscribe("tasks.detail", { id: "t1" }, () => {});
    reads.subscribe("tasks.search", { query: "history" }, () => {});
    expect(vi.mocked(executor.subscribe).mock.calls.map(([name, args]) => [name, args])).toEqual([
      ["tasks.detail", { id: "t1" }],
      ["tasks.search", { query: "history" }],
    ]);
  });

  it("never serves a catalog read the panel contract does not list, even when declared", () => {
    const executor: ReadSubscriber = { subscribe: vi.fn(() => () => {}) };
    const reads = bindReads(["observe.sessions", "cards.list"], executor);
    expect(() => reads.subscribe("observe.sessions" as "feed.recent", () => {})).toThrow(
      /not a read this panel declared/,
    );
    expect(executor.subscribe).not.toHaveBeenCalled();
  });
});

describe("bindReads, the sql read", () => {
  it("runs a query over exactly the views the manifest's sql names, the host adding them", () => {
    const answer = { columns: ["n"], rows: [{ n: 3 }], truncated: false, elapsedMs: 1 };
    const executor: ReadSubscriber = {
      subscribe: vi.fn((_name, _args, listener) => {
        listener.onValue(answer);
        return () => {};
      }),
    };
    const reads = bindReads([], executor, ["v_usage_v1"]);
    const seen: unknown[] = [];
    reads.subscribe("sql", { sql: "SELECT COUNT(*) AS n FROM v_usage_v1" }, (value) =>
      seen.push(value),
    );
    expect(seen).toEqual([answer]);
    expect(executor.subscribe).toHaveBeenCalledWith(
      "sql",
      { sql: "SELECT COUNT(*) AS n FROM v_usage_v1" },
      expect.anything(),
      { sql: ["v_usage_v1"] },
    );
  });

  it("serves no query to a panel whose manifest names no view", () => {
    const executor: ReadSubscriber = { subscribe: vi.fn(() => () => {}) };
    const reads = bindReads(["feed.recent"], executor);
    expect(() => reads.subscribe("sql", { sql: "SELECT 1" }, () => {})).toThrow(
      /name them in manifest.json "sql"/,
    );
    expect(executor.subscribe).not.toHaveBeenCalled();
  });
});

/**
 * A panel's draft (docs/personal-panels.md, "Built apart") is bound apart:
 * its store requests and action calls name the draft, and it hears only
 * the draft's store changes, as the panel on the rail hears only its own.
 */
describe("bindStore and bindInvoke, for a draft", () => {
  it("reaches the draft's own store and server, and each side hears only its own changes", async () => {
    const requests: unknown[] = [];
    const invokes: unknown[][] = [];
    const listeners: ((change: PersonalStoreChange) => void)[] = [];
    vi.stubGlobal("window", {
      infinitary: {
        plugins: {
          db: {
            request: async (request: unknown) => {
              requests.push(request);
              return {};
            },
            onChange: (listener: (change: PersonalStoreChange) => void) => {
              listeners.push(listener);
              return () => {};
            },
          },
          invoke: async (...args: unknown[]) => {
            invokes.push(args);
            return { ok: true, result: "done" };
          },
        },
      },
    });
    try {
      const draft = bindStore("clock", true);
      await draft.get("note");
      await draft.set("note", 2);
      await draft.list("n");
      expect(requests).toEqual([
        { op: "get", extensionId: "clock", key: "note", draft: true },
        { op: "set", extensionId: "clock", key: "note", value: 2, draft: true },
        { op: "list", extensionId: "clock", prefix: "n", draft: true },
      ]);
      const heardByDraft: string[] = [];
      const heardByPanel: string[] = [];
      draft.subscribe((key) => heardByDraft.push(key));
      bindStore("clock").subscribe((key) => heardByPanel.push(key));
      for (const change of [
        { extensionId: "clock", key: "own" },
        { extensionId: "clock", key: "built", draft: true as const },
        { extensionId: "other", key: "elsewhere", draft: true as const },
      ]) {
        for (const listener of listeners) listener(change);
      }
      expect(heardByDraft).toEqual(["built"]);
      expect(heardByPanel).toEqual(["own"]);

      expect(await bindInvoke("clock", true)("word", 1)).toBe("done");
      expect(await bindInvoke("clock")("word", 1)).toBe("done");
      expect(invokes).toEqual([
        ["clock", "word", 1, { draft: true }],
        ["clock", "word", 1],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
