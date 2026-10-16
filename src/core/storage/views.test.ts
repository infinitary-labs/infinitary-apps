import { SQL_VIEWS, SQL_VIEWS_MAJOR, SQL_VIEWS_MINOR } from "@shared/sql";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { recentFeed } from "../tasks/taskFeed";
import { TaskService } from "../tasks/taskService";
import { ActivityStore } from "./activityStore";
import { type AppDatabase, openDatabase, openInMemoryDatabase } from "./db";
import { LEDGER_VIEWS } from "./views";

/**
 * The published views are a contract (plugin data surface, Phase B): these
 * lists are the pin, written out here rather than read back from views.ts,
 * so changing a view's columns is a deliberate edit in two places - an
 * added column a minor bump, anything else a new `_vN`.
 */
const PINNED: Record<(typeof SQL_VIEWS)[number], string[]> = {
  v_placements_v1: [
    "task_id",
    "committed_at",
    "computer_id",
    "computer_name",
    "reservation",
    "snapshot_json",
  ],
  v_version_v1: ["version", "major", "minor"],
  v_tasks_v1: [
    "task_id",
    "key",
    "project_key",
    "parent_id",
    "kind",
    "status",
    "activity",
    "closed_reason",
    "title",
    "goal",
    "priority",
    "repo_name",
    "branch",
    "assignee",
    "model",
    "provider",
    "tier",
    "deliverable",
    "rigor",
    "delivery",
    "created_at",
    "updated_at",
    "started_at",
    "closed_at",
    "basis",
  ],
  v_task_events_v1: ["task_id", "key", "at", "kind", "text", "feed"],
  v_usage_v1: [
    "id",
    "at",
    "task_id",
    "key",
    "title",
    "status",
    "activity",
    "provider",
    "model",
    "account_label",
    "input",
    "output",
    "cache_read",
    "cache_write",
    "cost",
  ],
  v_feed_v1: ["at", "kind", "text", "task_key"],
  v_quota_windows_v1: [
    "provider",
    "account_label",
    "plan",
    "status",
    "stale",
    "measured_at",
    "window_id",
    "label",
    "percent_remaining",
    "pace",
    "resets_at",
  ],
  v_routing_v1: ["at", "task_id", "key", "provider", "model", "bucket", "served", "rule"],
  v_projects_v1: ["id", "key", "name", "archived"],
  v_repos_v1: ["id", "name", "kind", "delivery", "autonomy", "rigor"],
};

const MIN = 60_000;
const T0 = 1_790_000_000_000;

function tempDir(): string {
  return scratchDir("infinitary-views-");
}

function columnsOf(db: AppDatabase, view: string): string[] {
  return db
    .prepare(`SELECT * FROM "${view}" LIMIT 0`)
    .columns()
    .map((column) => column.name);
}

function all<T = Record<string, unknown>>(db: AppDatabase, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/**
 * A database the way an existing install has it: built through migration
 * 41, before the views existed, with a fleet's worth of record in it - then
 * reopened, which runs the migration that publishes the views over it.
 */
function migratedFixture(): AppDatabase {
  const dir = tempDir();
  const before = openDatabase(dir, 41);
  before
    .prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy, rigor, kind) VALUES ('r1', '/fleet/nimbus', 'nimbus', 1, 'clone', NULL, 'direct-pr', 1, 'reviewed', 'project')",
    )
    .run();
  let now = T0;
  const tasks = new TaskService({
    db: before,
    repos: { get: (id) => (id === "r1" ? { delivery: "direct-pr" as const } : undefined) },
    now: () => now,
    strict: true,
  });
  tasks.projects.ensureForRepo({ id: "r1", name: "nimbus" });
  seedTask(tasks, {
    id: "t-build",
    title: "Build the export",
    repoId: "r1",
    branch: "fm/task-build",
    status: "completed",
    outcome: "Export shipped. Tests pass.",
    shape: {
      kind: "feature",
      kind_source: "model",
      basis: null,
      premium_ask: false,
      override_model_id: null,
      rigor: "reviewed",
      deliverable: "change",
    } as never,
  });
  now += MIN;
  seedTask(tasks, { id: "t-fail", title: "Fix the flake", status: "failed" });
  now += MIN;
  seedTask(tasks, { id: "t-ask", title: "What broke?", kind: "question", status: "queued" });
  tasks.recordTurnFailure("t-build", "401 Unauthorized: token expired");
  // Two routing decisions for the builder: the newest that chose a model is
  // the one the task row reads, served a slot below the one it asked for.
  const route = before.prepare(
    "INSERT INTO routing_decisions (task_id, provider, model, bucket, rule, served, reasons_json, at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?)",
  );
  route.run("t-build", "openai-codex", "gpt-6-luna", "low", "R8", "low", T0);
  route.run("t-build", "anthropic", "claude-fable-5-1", "high", "R1b", "medium", T0 + 2 * MIN);
  route.run("t-build", null, null, "premium", "R0", null, T0 + 3 * MIN);
  // A decision record is capture machinery; the timeline view leaves it out.
  before
    .prepare(
      "INSERT INTO task_events (task_id, at, actor, kind, text, data_json, ref, feed) VALUES ('t-build', ?, 'firstmate', 'decided', 'decision d1: routed', '{\"secret\":1}', 'd1', 0)",
    )
    .run(T0 + 4 * MIN);
  const usage = before.prepare(
    "INSERT INTO usage_events (task_id, account_id, provider, model, input, output, cache_read, cache_write, cost, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  usage.run(
    "t-build",
    "acct_7f3",
    "anthropic",
    "claude-fable-5-1",
    1200,
    300,
    50,
    0,
    0.12,
    T0 + 5 * MIN,
  );
  usage.run(
    "firstmate",
    "acct_unknown",
    "openai-codex",
    "gpt-6-sol",
    900,
    80,
    null,
    null,
    null,
    T0 + 6 * MIN,
  );
  before
    .prepare("INSERT INTO quota_snapshots (generated_at, fetched_at, json) VALUES (?, ?, ?)")
    .run(
      "x",
      T0 + 7 * MIN,
      JSON.stringify({
        generatedAt: "x",
        fetchedAt: T0 + 7 * MIN,
        providers: [
          {
            provider: "claude",
            label: "Claude",
            accountId: "acct_7f3",
            accountLabel: "Personal",
            plan: "Max",
            status: "ok",
            stale: false,
            windows: [
              {
                id: "session",
                label: "session",
                percentRemaining: 62,
                pace: "behind",
                resetsAtMs: T0 + 90 * MIN,
              },
              { id: "weekly", label: "weekly", pace: "unknown" },
            ],
          },
          {
            provider: "codex",
            label: "Codex",
            accountId: "acct_9aa",
            accountLabel: "Work",
            status: "not_measured",
            stale: true,
            measuredAt: T0 - 180 * MIN,
            windows: [],
          },
        ],
      }),
    );
  new ActivityStore(before, () => T0 + 8 * MIN).record({ kind: "you", text: "you · ship it" });
  before.close();
  return openDatabase(dir);
}

describe("the published views", () => {
  it("publishes exactly the nine names, each with its pinned columns", () => {
    const db = openInMemoryDatabase();
    const views = all<{ name: string }>(
      db,
      "SELECT name FROM sqlite_schema WHERE type = 'view' ORDER BY name",
    ).map((row) => row.name);
    // Beside them, only the decision ledger's three old names (migration 50),
    // which no plugin's query can reach.
    expect(views).toEqual([...SQL_VIEWS, ...LEDGER_VIEWS.map((view) => view.name)].sort());
    for (const view of SQL_VIEWS) expect(columnsOf(db, view), view).toEqual(PINNED[view]);
  });

  it("reports its major and minor", () => {
    const db = openInMemoryDatabase();
    expect(all(db, "SELECT * FROM v_version_v1")).toEqual([
      {
        version: `${SQL_VIEWS_MAJOR}.${SQL_VIEWS_MINOR}`,
        major: SQL_VIEWS_MAJOR,
        minor: SQL_VIEWS_MINOR,
      },
    ]);
  });

  it("runs every view over a database migrated from before the views existed", () => {
    const db = migratedFixture();
    for (const view of SQL_VIEWS)
      expect(() => all(db, `SELECT * FROM "${view}"`), view).not.toThrow();

    const build = all(db, "SELECT * FROM v_tasks_v1 WHERE task_id = 't-build'")[0];
    expect(build).toMatchObject({
      key: expect.stringMatching(/-1$/),
      repo_name: "nimbus",
      branch: "fm/task-build",
      status: "active",
      activity: "idle",
      // The newest decision that chose a model, and the slot it was served at.
      provider: "anthropic",
      model: "claude-fable-5-1",
      tier: "medium",
      rigor: "reviewed",
      deliverable: "change",
    });
    const ask = all(db, "SELECT * FROM v_tasks_v1 WHERE task_id = 't-ask'")[0];
    expect(ask).toMatchObject({ kind: "question", status: "open", branch: null, tier: null });

    const timeline = all<{ kind: string }>(
      db,
      "SELECT kind FROM v_task_events_v1 WHERE task_id = 't-build'",
    ).map((row) => row.kind);
    expect(timeline).toContain("report");
    expect(timeline).not.toContain("decided");

    const usage = all(db, "SELECT * FROM v_usage_v1 ORDER BY at");
    expect(usage).toEqual([
      expect.objectContaining({
        task_id: "t-build",
        title: "Build the export",
        status: "active",
        activity: "idle",
        provider: "anthropic",
        account_label: "Personal",
        input: 1200,
        output: 300,
        cost: 0.12,
      }),
      expect.objectContaining({
        task_id: "firstmate",
        key: "FIRSTMATE",
        title: "First mate",
        status: null,
        // An account the latest reading does not name has no label - never its id.
        account_label: null,
        cache_read: null,
        cost: null,
      }),
    ]);
    expect(JSON.stringify(usage)).not.toContain("acct_");

    const windows = all(db, "SELECT * FROM v_quota_windows_v1");
    expect(windows).toEqual([
      expect.objectContaining({
        provider: "claude",
        account_label: "Personal",
        plan: "Max",
        status: "ok",
        stale: 0,
        measured_at: T0 + 7 * MIN,
        window_id: "session",
        percent_remaining: 62,
        pace: "behind",
        resets_at: T0 + 90 * MIN,
      }),
      // Unknown is never zero.
      expect.objectContaining({ window_id: "weekly", percent_remaining: null, pace: "unknown" }),
      // A read with no window is still a row, with its staleness and age.
      expect.objectContaining({
        provider: "codex",
        status: "not_measured",
        stale: 1,
        measured_at: T0 - 180 * MIN,
        window_id: null,
        percent_remaining: null,
      }),
    ]);
    expect(JSON.stringify(windows)).not.toContain("acct_");

    expect(all(db, "SELECT provider, served, rule FROM v_routing_v1 ORDER BY at")).toEqual([
      { provider: "openai-codex", served: "low", rule: "R8" },
      { provider: "anthropic", served: "medium", rule: "R1b" },
      { provider: null, served: null, rule: "R0" },
    ]);
    expect(all(db, "SELECT * FROM v_repos_v1")).toEqual([
      {
        id: "r1",
        name: "nimbus",
        kind: "project",
        delivery: "direct-pr",
        autonomy: 1,
        rigor: "reviewed",
      },
    ]);
    expect(all(db, "SELECT key, archived FROM v_projects_v1 ORDER BY key")).toEqual(
      expect.arrayContaining([expect.objectContaining({ archived: 0 })]),
    );
  });

  it("says in v_feed_v1 exactly what the feed read says", () => {
    const db = migratedFixture();
    const tasks = new TaskService({ db, repos: { get: () => undefined }, strict: true });
    const feed = recentFeed(tasks, new ActivityStore(db), 200).map((line) => ({
      at: line.at,
      kind: line.kind,
      text: line.text,
      task_key: line.taskKey ?? null,
    }));
    expect(feed.length).toBeGreaterThan(3);
    // The raw provider error stays on the record; the line says what it means.
    expect(feed.some((line) => line.text.startsWith("Problem: "))).toBe(true);
    const view = all(db, "SELECT at, kind, text, task_key FROM v_feed_v1");
    const order = (rows: { at: number; text: string }[]) =>
      [...rows].sort((a, b) => a.at - b.at || a.text.localeCompare(b.text));
    expect(order(view as typeof feed)).toEqual(order(feed));
  });

  it("puts a view back on open when it drifted from views.ts", () => {
    const dir = tempDir();
    const first = openDatabase(dir);
    first.exec("DROP VIEW v_usage_v1; CREATE VIEW v_usage_v1 AS SELECT 1 AS stale");
    first.close();
    const reopened = openDatabase(dir);
    expect(columnsOf(reopened, "v_usage_v1")).toEqual(PINNED.v_usage_v1);
    reopened.close();
  });
});
