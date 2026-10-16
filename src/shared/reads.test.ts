import { describe, expect, it } from "vitest";
import { CORE_INVOKE_CHANNELS, invokeContract } from "./ipc";
import { isReadName, READ_NAMES, readCatalog } from "./reads";
import { DEFAULT_USAGE_QUERY, USAGE_TASK_PAGE } from "./usage";

/**
 * The read catalog is named once, in the protocol's own terms: every entry
 * rides a core channel, its args map onto that channel's request tuple,
 * and nothing account-, auth-, or card-shaped is in it.
 */
describe("the read catalog", () => {
  it("freezes the names (v0, the three task reads of task-system P3, the preferences of talk-to-personalize Step 1, the open changes of git integration PR 1.2, and the record through SQL of Phase B, Settings → Usage, the knowledge browser, and a card's knowledge references and a task's knowledge used, and the task card's Crewmate tab)", () => {
    expect([...READ_NAMES].sort()).toEqual([
      "automation.history",
      "automation.list",
      "computers.resources",
      "crew.counts",
      "feed.recent",
      "forge.changes",
      "knowledge.collections",
      "knowledge.concepts",
      "knowledge.direction",
      "knowledge.directions",
      "knowledge.entry",
      "knowledge.findings",
      "knowledge.graph",
      "knowledge.refs",
      "knowledge.uses",
      "observe.live",
      "observe.session",
      "observe.sessions",
      "personal.mounts",
      "projects.list",
      "quota.snapshot",
      "repos.list",
      "shell.preferences",
      "sql",
      "tasks.board",
      "tasks.crewmate",
      "tasks.crewmate.live",
      "tasks.detail",
      "tasks.search",
      "update.status",
      "usage.summary",
      "usage.tasks",
    ]);
    expect(isReadName("observe.sessions")).toBe(true);
    expect(isReadName("cards.list")).toBe(false);
    expect(isReadName("constructor")).toBe(false);
  });

  it("maps every entry onto a core channel with a request the channel accepts", () => {
    const core = new Set<string>(CORE_INVOKE_CHANNELS);
    for (const name of READ_NAMES) {
      const entry = readCatalog[name];
      expect(core.has(entry.channel), name).toBe(true);
      const shape = "shape" in entry.args ? (entry.args.shape as Record<string, unknown>) : {};
      const sample =
        name === "sql"
          ? { sql: "SELECT 1 AS one" }
          : name === "usage.summary"
            ? DEFAULT_USAGE_QUERY
            : name === "usage.tasks"
              ? { ...DEFAULT_USAGE_QUERY, limit: USAGE_TASK_PAGE }
              : name === "knowledge.entry"
                ? { id: "c-abc123" }
                : name === "knowledge.refs"
                  ? { ids: ["f-abc123"] }
                  : name === "knowledge.uses"
                    ? { task: "t-1" }
                    : "scope" in shape
                      ? { scope: "captain" }
                      : "query" in shape
                        ? { query: "x" }
                        : "id" in shape
                          ? { id: "x" }
                          : {};
      const args = entry.args.parse(sample);
      const request = (entry.toRequest as (a: unknown, grant: object) => unknown[])(args, {});
      expect(invokeContract[entry.channel].request.safeParse(request).success, name).toBe(true);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("keeps args strict, so the only query a plugin composes is the sql read's, over its grant", () => {
    expect(readCatalog["observe.sessions"].args.safeParse({ where: "1=1" }).success).toBe(false);
    expect(readCatalog["observe.session"].args.safeParse({ id: "a", extra: 1 }).success).toBe(
      false,
    );
    expect(readCatalog["observe.session"].args.safeParse({ id: "" }).success).toBe(false);
    // The query is the subscriber's; the views it may reach are the host's.
    const sql = readCatalog.sql;
    expect(sql.args.safeParse({ sql: "SELECT 1", views: ["v_usage_v1"] }).success).toBe(false);
    expect(sql.args.safeParse({ sql: "x".repeat(4_097) }).success).toBe(false);
    expect(sql.args.safeParse({ sql: "SELECT ?", params: new Array(33).fill(1) }).success).toBe(
      false,
    );
    expect(sql.toRequest({ sql: "SELECT 1" }, {})).toEqual([{ sql: "SELECT 1", views: [] }]);
    expect(sql.toRequest({ sql: "SELECT 1", params: [2] }, { sql: ["v_usage_v1"] })).toEqual([
      { sql: "SELECT 1", params: [2], views: ["v_usage_v1"] },
    ]);
  });

  it("declares an invalidation for every entry and scopes the live one to its session", () => {
    for (const name of READ_NAMES) {
      const { invalidate } = readCatalog[name];
      expect(
        Boolean(
          invalidate.events ||
            invalidate.pushes?.length ||
            invalidate.valueFromPush ||
            invalidate.pollMs,
        ),
        name,
      ).toBe(true);
    }
    const live = readCatalog["observe.live"].invalidate.events;
    expect(live?.({ type: "assistant_delta", taskId: "t1", text: "x" }, { id: "t1" })).toBe(true);
    expect(live?.({ type: "assistant_delta", taskId: "t2", text: "x" }, { id: "t1" })).toBe(false);
    expect(live?.({ type: "firstmate_note", text: "x" }, { id: "t1" })).toBe(false);
    const sessions = readCatalog["observe.sessions"].invalidate;
    expect(sessions.events?.({ type: "turn_end", taskId: "t" }, {})).toBe(true);
    expect(sessions.events?.({ type: "assistant_delta", taskId: "t", text: "x" }, {})).toBe(false);
    expect(sessions.pollMs).toBe(2_000);
    expect(
      readCatalog["feed.recent"].invalidate.events?.({ type: "firstmate_note", text: "x" }, {}),
    ).toBe(true);
    expect(readCatalog["quota.snapshot"].invalidate.pushes).toEqual(["inf:quota"]);
    // The sql read is live on any event and on a quota reading (B3), and an
    // answer that says the same thing is not delivered again.
    const sql = readCatalog.sql.invalidate;
    expect(sql.events?.({ type: "firstmate_note", text: "x" }, { sql: "SELECT 1" })).toBe(true);
    expect(sql.pushes).toEqual(["inf:quota"]);
    const answer = { columns: ["n"], rows: [{ n: 1 }], truncated: false, elapsedMs: 1 };
    expect(sql.sameValue?.(answer, { ...answer, elapsedMs: 9 })).toBe(true);
    expect(sql.sameValue?.(answer, { ...answer, rows: [{ n: 2 }] })).toBe(false);
  });

  it("re-reads knowledge after a write, the purge, and a project coming or going, and on nothing else", () => {
    for (const name of [
      "knowledge.collections",
      "knowledge.graph",
      "knowledge.concepts",
      "knowledge.directions",
      "knowledge.findings",
      "knowledge.entry",
      "knowledge.direction",
    ] as const) {
      const events = readCatalog[name].invalidate.events;
      expect(events?.({ type: "knowledge_changed" }, {} as never), name).toBe(true);
      expect(
        events?.({ type: "repo_unregistered", repoId: "r", name: "x" } as never, {} as never),
        name,
      ).toBe(true);
      expect(events?.({ type: "assistant_delta", taskId: "t", text: "x" }, {} as never), name).toBe(
        false,
      );
    }
    // Strict and bounded: a read names one collection, and never composes a query.
    expect(
      readCatalog["knowledge.graph"].args.safeParse({ scope: "captain", hops: 3 }).success,
    ).toBe(false);
    expect(
      readCatalog["knowledge.findings"].args.safeParse({ scope: "captain", sql: "x" }).success,
    ).toBe(false);
    expect(readCatalog["knowledge.entry"].args.safeParse({ id: "../x" }).success).toBe(false);
  });

  it("pins the task reads to their channels and scopes a detail to its own task (P3)", () => {
    expect(readCatalog["tasks.board"].channel).toBe("inf:tasks:board");
    expect(readCatalog["tasks.detail"].channel).toBe("inf:tasks:detail");
    expect(readCatalog["projects.list"].channel).toBe("inf:projects:list");
    // The board rides its own push, never one read per task event - and the
    // push IS the board (P4), so the subscriber takes it without a re-read.
    expect(readCatalog["tasks.board"].invalidate).toMatchObject({ valueFromPush: "inf:tasks" });
    // The preferences take the push as their value too: what the core wrote
    // is what the window applies, with no second read (Step 1).
    expect(readCatalog["shell.preferences"].channel).toBe("inf:shell:preferences");
    expect(readCatalog["shell.preferences"].invalidate).toEqual({
      valueFromPush: "inf:shell:preferences",
    });
    // The delta carrier (P5): the board folds a pushed delta onto itself,
    // and the project index re-reads on either push.
    expect(readCatalog["tasks.board"].invalidate.deltaFromPush?.channel).toBe("inf:tasks:delta");
    expect(readCatalog["projects.list"].invalidate.pushes).toEqual([
      "inf:tasks",
      "inf:tasks:delta",
    ]);
    const detail = readCatalog["tasks.detail"].invalidate.events;
    const changed = {
      type: "task_changed" as const,
      taskId: "t1",
      key: "SCR-1",
      kind: "work" as const,
      status: "active" as const,
      from: "active" as const,
      activity: "idle" as const,
      closedReason: null,
      seq: 3,
    };
    expect(detail?.(changed, { id: "t1" })).toBe(true);
    expect(detail?.({ ...changed, taskId: "t2" }, { id: "t1" })).toBe(false);
    expect(
      detail?.(
        {
          type: "task_event",
          taskId: "t1",
          key: "SCR-1",
          kind: "note",
          text: "x",
          at: 1,
          feed: false,
        },
        { id: "t1" },
      ),
    ).toBe(true);
    expect(detail?.({ type: "firstmate_note", text: "x" }, { id: "t1" })).toBe(false);
    expect(readCatalog["tasks.detail"].args.safeParse({ id: "t1", extra: 1 }).success).toBe(false);
  });

  it("names nothing account-, auth-, or card-shaped", () => {
    for (const name of READ_NAMES) {
      expect(name).not.toMatch(/account|auth|card|secret|token/);
      expect(readCatalog[name].channel).not.toMatch(/accounts|auth|cards/);
    }
  });
});

it("Usage refreshes after separately accounted model-powered tool work", () => {
  for (const name of ["usage.summary", "usage.tasks"] as const) {
    const invalidate = readCatalog[name].invalidate.events;
    expect(
      invalidate?.(
        {
          type: "tool_end",
          taskId: "a",
          callId: "a:compaction",
          toolName: "compact_context",
          isError: false,
          usage: { input: 100 },
        },
        { ...DEFAULT_USAGE_QUERY, limit: USAGE_TASK_PAGE },
      ),
    ).toBe(true);
    expect(
      invalidate?.(
        {
          type: "tool_end",
          taskId: "a",
          callId: "read",
          toolName: "read",
          isError: false,
        },
        { ...DEFAULT_USAGE_QUERY, limit: USAGE_TASK_PAGE },
      ),
    ).toBe(false);
  }
});
