import {
  addUsageAmounts,
  DEFAULT_USAGE_QUERY,
  EMPTY_USAGE_AMOUNT,
  type UsageAmount,
  type UsageWhere,
  usageCategoryValue,
  usageValue,
} from "@shared/usage";
import { describe, expect, it, vi } from "vitest";
import { createNormalizerState, fmEventsFromClaudeMessage } from "../claude/claudeEvents";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { openInMemoryDatabase } from "./db";
import { ensureRepoProject } from "./projectStore";
import { localDate, type UsageNames, UsageStore } from "./usageStore";

describe("UsageStore", () => {
  it("reads saved retrieval alongside older research, unclear and absent shapes", () => {
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db });
    const store = new UsageStore(db);
    for (const kind of ["retrieval", "research", "unclear", null] as const) {
      const id = kind ?? "old";
      seedTask(tasks, {
        id,
        title: id,
        status: "queued",
        startPolicy: "on-request",
        ...(kind ? { shape: { kind } } : {}),
      });
      store.record({
        taskId: id,
        model: { provider: "xai", id: "test" },
        usage: { input: 10 },
        at: Date.now(),
      });
    }
    const summary = store.summary(
      { period: "all", scope: "all" },
      { now: Date.now(), names: { provider: (id) => id, model: (ref) => ref.id } },
    );
    expect(
      summary.where.projects
        .flatMap((project) => project.kinds)
        .map(({ kind, amount }) => [kind, amount.records]),
    ).toEqual(
      expect.arrayContaining([
        ["retrieval", 1],
        ["research", 1],
        [null, 2],
      ]),
    );
    db.close();
  });

  it("sums task records with category coverage and separate model attribution", () => {
    const store = new UsageStore(openInMemoryDatabase());
    store.record({
      taskId: "a",
      accountId: "acct-1",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1, cost: 0.5 },
      at: 1000,
    });
    store.record({
      taskId: "a",
      model: { provider: "xai", id: "grok-5" },
      usage: { input: 50, output: 10, cost: 0.25 },
      at: 3000,
    });
    store.record({ taskId: "b", usage: { output: 7 }, at: 2000 });

    const rows = new Map(store.byTask().map((row) => [row.task_id, row]));
    expect(rows.get("a")).toMatchObject({
      task_id: "a",
      input: 150,
      output: 30,
      cache_read: 5,
      cache_write: 1,
      cost: 0.75,
      records: 2,
      reported: { input: 2, output: 2, cacheRead: 1, cacheWrite: 1 },
      priced: 2,
      last_at: 3000,
      first_at: 1000,
      models: [
        expect.objectContaining({ provider: "openai-codex", model: "gpt-5.5", cost: 0.5 }),
        expect.objectContaining({ provider: "xai", model: "grok-5", cost: 0.25 }),
      ],
    });
    // A turn with no reported cost leaves the cost unknown, never zero.
    expect(rows.get("b")).toMatchObject({ input: 0, output: 7, cost: null, records: 1 });
    expect(rows.get("b")?.models[0]?.model).toBeNull();
    expect(rows.get("b")?.reported).toEqual({ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 });
  });

  it("counts three model records, not turns, and excludes unpriced zero estimates", () => {
    const db = openInMemoryDatabase();
    const store = new UsageStore(db);
    store.record({
      taskId: "plan",
      model: { provider: "openai-codex", id: "luna" },
      usage: { input: 65, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.0000675 },
      at: 1000,
    });
    store.record({
      taskId: "plan",
      model: { provider: "anthropic-claude", id: "opus" },
      usage: {
        models: [
          { model: "haiku", input: 20, output: 2, cacheRead: 0, cost: 0.00204 },
          { model: "opus", input: 100, output: 30, cacheRead: 400, cacheWrite: 0, cost: 8.3256488 },
        ],
      },
      at: 2000,
    });
    const [plan] = store.byTask("plan");
    expect(plan).toMatchObject({
      records: 3,
      input: 185,
      output: 35,
      cache_read: 400,
      reported: { input: 3, output: 3, cacheRead: 3, cacheWrite: 2 },
      priced: 3,
    });
    expect(plan?.cost).toBeCloseTo(8.3277563, 7);
    expect(plan?.models.map((model) => [model.model, model.attribution, model.records])).toEqual([
      ["haiku", "served", 1],
      ["opus", "served", 1],
      ["luna", "requested", 1],
    ]);
    // Neither tied timestamps nor different indexes can pick a latest model.
    db.exec("DROP INDEX usage_events_task");
    expect(store.byTask("plan")).toEqual([plan]);
    store.record({ taskId: "partial", usage: { input: 0, cost: 0 }, at: 3000 });
    store.record({ taskId: "partial", usage: { output: 7, cost: 0.5 }, at: 3000 });
    store.record({ taskId: "partial", usage: {}, at: 3000 });
    expect(store.byTask("partial")[0]).toMatchObject({
      records: 3,
      cost: 0.5,
      priced: 1,
      reported: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      models: [expect.objectContaining({ model: null, attribution: "historical" })],
    });
    store.record({ taskId: "zero", usage: { cost: 0 }, at: 4000 });
    expect(store.byTask("zero")[0]).toMatchObject({ records: 1, cost: null, priced: 0 });
  });

  it("reads one task alone when asked, and nothing for a task that never ran", () => {
    const store = new UsageStore(openInMemoryDatabase());
    store.record({ taskId: "a", usage: { input: 1 }, at: 1 });
    store.record({ taskId: "b", usage: { input: 2 }, at: 2 });
    expect(store.byTask("b").map((row) => [row.task_id, row.input])).toEqual([["b", 2]]);
    expect(store.byTask("never")).toEqual([]);
  });
});

describe("UsageStore, served models", () => {
  it("records partial Claude cumulative reports once and leaves missing categories null", () => {
    const db = openInMemoryDatabase();
    const store = new UsageStore(db);
    const state = createNormalizerState();
    for (const row of [
      { inputTokens: 100, outputTokens: 10, costUSD: 1 },
      { outputTokens: 15, costUSD: 1.5 },
      { outputTokens: 15, costUSD: 1.5 },
      { inputTokens: 120, outputTokens: 20, costUSD: 2 },
    ]) {
      const { events } = fmEventsFromClaudeMessage(
        { type: "result", subtype: "success", modelUsage: { opus: row } },
        "a",
        state,
      );
      for (const event of events) {
        if (event.type === "turn_end" && event.usage) {
          store.record({
            taskId: event.taskId,
            model: { provider: "anthropic-claude", id: "opus" },
            usage: event.usage,
            at: 1,
          });
        }
      }
    }
    expect(
      db
        .prepare(
          "SELECT input, output, cache_read, cache_write, cost FROM usage_events ORDER BY id",
        )
        .all(),
    ).toEqual([
      { input: 100, output: 10, cache_read: null, cache_write: null, cost: 1 },
      { input: null, output: 5, cache_read: null, cache_write: null, cost: 0.5 },
      { input: 20, output: 5, cache_read: null, cache_write: null, cost: 0.5 },
    ]);
    expect(store.byTask("a")[0]).toMatchObject({ input: 120, output: 20, cost: 2, records: 3 });
  });
  it("writes one row per model a turn names, under the session's provider, and qualifies the rest", () => {
    const db = openInMemoryDatabase();
    const store = new UsageStore(db);
    store.record({
      taskId: "a",
      model: { provider: "anthropic-claude", id: "opus" },
      usage: {
        input: 140,
        cost: 0.51,
        costSource: "claude",
        models: [
          { model: "claude-opus-4-1", input: 100, cost: 0.5, costSource: "claude" },
          { model: "claude-haiku-4-5", input: 40, cost: 0.01, costSource: "claude" },
        ],
      },
      at: 1,
    });
    store.record({
      taskId: "a",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      usage: {
        input: 10,
        cost: 0.2,
        costSource: "listed-prices",
        costParts: { input: 0.2 },
      },
      at: 2,
    });
    store.record({ taskId: "a", usage: { input: 3 }, at: 3 });
    expect(
      db
        .prepare(
          "SELECT provider, model, model_source, input, cost, cost_source, cost_input FROM usage_events ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        provider: "anthropic-claude",
        model: "claude-opus-4-1",
        model_source: "served",
        input: 100,
        cost: 0.5,
        cost_source: "claude",
        cost_input: null,
      },
      {
        provider: "anthropic-claude",
        model: "claude-haiku-4-5",
        model_source: "served",
        input: 40,
        cost: 0.01,
        cost_source: "claude",
        cost_input: null,
      },
      {
        provider: "openai-codex",
        model: "gpt-5.5",
        model_source: "requested",
        input: 10,
        cost: 0.2,
        cost_source: "listed-prices",
        cost_input: 0.2,
      },
      // No model, no claim about one; no price, no source.
      {
        provider: null,
        model: null,
        model_source: null,
        input: 3,
        cost: null,
        cost_source: null,
        cost_input: null,
      },
    ]);
  });
  it("names a decision by the model its reply said answered, priced by the cost the reply stated", () => {
    const store = new UsageStore(openInMemoryDatabase());
    // What an OpenRouter decision records: asked for an alias, answered by a dated model.
    const reported = { input: 412, output: 62, cost: 0.0000317, costSource: "reported" as const };
    store.record({
      taskId: "a",
      accountId: "acct-openrouter",
      model: { provider: "openrouter", id: "~typesafe/jev-latest" },
      usage: { ...reported, models: [{ ...reported, model: "typesafe/jev-1.13-20260917" }] },
      at: 1,
    });
    const summary = store.summary(
      { period: "all", scope: "all" },
      { now: 2, names: { model: (ref) => ref.id, provider: (provider) => provider } },
    );
    expect(summary.models).toHaveLength(1);
    expect(summary.models[0]).toMatchObject({
      id: "openrouter/typesafe/jev-1.13-20260917",
      model: "typesafe/jev-1.13-20260917",
      attribution: "served",
      priceSources: ["reported"],
      amount: { records: 1, priced: 1, cost: 0.0000317, split: 0 },
    });
  });
});

describe("UsageStore.summary, Settings → Usage", () => {
  const NOW = new Date(2026, 9, 5, 15, 0).getTime();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const names: UsageNames = {
    model: (ref) => `${ref.id} by name`,
    provider: (provider) => `${provider} by name`,
  };

  function ledger() {
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true });
    // A finished crewmate closes done when its work is merged or answered.
    const finish = (id: string) =>
      tasks.close(id, { status: "done", reason: "finished", actor: "host" });
    vi.useFakeTimers({ now: NOW - 40 * DAY });
    seedTask(tasks, { id: "old", title: "Explain setup", status: "completed" });
    finish("old");
    vi.setSystemTime(NOW - 2 * DAY);
    seedTask(tasks, { id: "site", title: "Refresh the website", status: "completed" });
    finish("site");
    seedTask(tasks, { id: "search", title: "Improve search", status: "running" });
    seedTask(tasks, { id: "dropped", title: "Compare options", status: "cancelled" });
    seedTask(tasks, {
      id: "ops",
      kind: "operation",
      title: "Repair the checks",
      status: "completed",
    });
    finish("ops");
    vi.useRealTimers();
    const store = new UsageStore(db);
    // Claude names each model it served.
    store.record({
      taskId: "site",
      model: { provider: "anthropic-claude", id: "opus" },
      usage: {
        models: [
          { model: "claude-opus-4-1", input: 1000, output: 200, cost: 2, costSource: "claude" },
          { model: "claude-haiku-4-5", input: 100, output: 10, cost: 0.1, costSource: "claude" },
        ],
      },
      at: NOW - 2 * DAY,
    });
    // Pi prices by category from the model's listed prices.
    store.record({
      taskId: "search",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      usage: {
        input: 5000,
        output: 500,
        cacheRead: 20000,
        cost: 0.5,
        costSource: "listed-prices",
        costParts: { input: 0.25, output: 0.15, cacheRead: 0.1, cacheWrite: 0 },
      },
      at: NOW - HOUR,
    });
    // The Firstmate's own turn on a model with no listed prices.
    store.record({
      taskId: "firstmate",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      usage: { input: 300, output: 30 },
      at: NOW - 3 * DAY,
    });
    // A model call tied to no task, and one whose task the record no longer has.
    store.record({
      taskId: "routing",
      model: { provider: "openrouter", id: "small" },
      usage: { input: 50, output: 5 },
      at: NOW - DAY,
    });
    store.record({
      taskId: "gone",
      model: { provider: "openrouter", id: "small" },
      usage: { input: 60, output: 6 },
      at: NOW - DAY,
    });
    // A row from before the ledger kept its sources: a Claude total under the
    // model recorded then, and an older zero that never proved the work free.
    db.prepare(
      "INSERT INTO usage_events (task_id, provider, model, input, output, cost, at) VALUES ('site', 'anthropic-claude', 'opus', 400, 40, 0.8, ?), ('site', 'anthropic-claude', 'opus', 10, 1, 0, ?)",
    ).run(NOW - 4 * DAY, NOW - 4 * DAY);
    // Outside the last 30 days.
    store.record({
      taskId: "old",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      usage: { input: 9, cost: 9, costSource: "listed-prices" },
      at: NOW - 40 * DAY,
    });
    return store;
  }

  it("reconciles every view of the last 30 days to one total, in tokens and in known dollars", () => {
    const summary = ledger().summary(DEFAULT_USAGE_QUERY, { now: NOW, names });
    expect(summary.total.records).toBe(8);
    expect(summary.total.tokens).toEqual({
      input: 1000 + 100 + 5000 + 300 + 50 + 60 + 400 + 10,
      output: 200 + 10 + 500 + 30 + 5 + 6 + 40 + 1,
      cacheRead: 20000,
      cacheWrite: 0,
    });
    // Only priced records count toward the estimate; the older zero is unpriced.
    expect(summary.total.priced).toBe(4);
    expect(summary.total.cost).toBeCloseTo(2 + 0.1 + 0.5 + 0.8, 6);
    // The days, the models and the places each add up to the same total.
    for (const parts of [
      summary.days.map((day) => day.amount),
      summary.models.map((model) => model.amount),
    ]) {
      const sum = addUsageAmounts(parts);
      expect(sum.tokens).toEqual(summary.total.tokens);
      expect(sum.records).toBe(summary.total.records);
      expect(sum.priced).toBe(summary.total.priced);
      expect(sum.cost).toBeCloseTo(summary.total.cost ?? 0, 6);
    }
    expect(summary.days).toHaveLength(30);
    expect(summary.days.at(-1)?.date).toBe(localDate(NOW));
    expect(summary.since).toBe(new Date(2026, 8, 6).getTime());
  });

  it("keeps each model by provider and recorded name, says how loosely it is named, and where its estimates came from", () => {
    const summary = ledger().summary(DEFAULT_USAGE_QUERY, { now: NOW, names });
    const model = (id: string) => summary.models.find((each) => each.id === id);
    expect(model("anthropic-claude/claude-opus-4-1")).toMatchObject({
      name: "claude-opus-4-1 by name",
      providerName: "anthropic-claude by name",
      attribution: "served",
      priceSources: ["claude"],
    });
    expect(model("openai-codex/gpt-5.5")).toMatchObject({
      attribution: "requested",
      priceSources: ["listed-prices"],
    });
    expect(model("openai-codex/gpt-5.5")?.amount).toMatchObject({
      records: 2,
      priced: 1,
      split: 1,
      cost: 0.5,
      costParts: { input: 0.25, output: 0.15, cacheRead: 0.1, cacheWrite: 0 },
    });
    expect(model("anthropic-claude/opus")).toMatchObject({
      attribution: "recorded",
      priceSources: ["unrecorded"],
    });
    // A model no record priced has no estimate, never a free one.
    expect(model("openrouter/small")?.amount.cost).toBeNull();
    expect(model("openrouter/small")?.places.map((place) => place.kind)).toEqual(["other"]);
  });

  it("names where usage went: the Firstmate, other work, and the tasks by key, title and project", () => {
    const summary = ledger().summary(DEFAULT_USAGE_QUERY, { now: NOW, names });
    const where = new Map(
      summary.places.map((place) => [place.task?.title ?? place.kind, place.amount.records]),
    );
    expect(where).toEqual(
      new Map([
        ["Refresh the website", 4],
        ["Improve search", 1],
        ["firstmate", 1],
        ["other", 2],
      ]),
    );
    expect(summary.places.find((place) => place.kind === "task")?.task).toMatchObject({
      key: expect.any(String),
      project: expect.any(String),
    });
  });

  it("counts finished work with a crewmate, in the period and over all history, never dropped or operation rows", () => {
    const store = ledger();
    const month = store.summary(DEFAULT_USAGE_QUERY, { now: NOW, names });
    expect(month.finished).toBe(1);
    expect(month.finishedEver).toBe(2);
    expect(store.summary({ period: "all", scope: "all" }, { now: NOW, names }).finished).toBe(2);
    expect(store.summary({ period: "30d", scope: "firstmate" }, { now: NOW, names }).finished).toBe(
      0,
    );
  });

  it("filters by the kind of work and the period", () => {
    const store = ledger();
    const records = (period: "7d" | "30d" | "all", scope: "all" | "task" | "firstmate" | "other") =>
      store.summary({ period, scope }, { now: NOW, names }).total.records;
    expect(records("30d", "task")).toBe(5);
    expect(records("30d", "firstmate")).toBe(1);
    expect(records("30d", "other")).toBe(2);
    expect(records("7d", "all")).toBe(8);
    expect(records("all", "all")).toBe(9);
    const all = store.summary({ period: "all", scope: "all" }, { now: NOW, names });
    expect(all.days[0]?.date).toBe(localDate(NOW - 40 * DAY));
    expect(all.days.at(-1)?.date).toBe(localDate(NOW));
  });

  it("answers an empty ledger with nothing recorded, not with zeros that look measured", () => {
    const store = new UsageStore(openInMemoryDatabase());
    const all = store.summary({ period: "all", scope: "all" }, { now: NOW, names });
    expect(all).toMatchObject({ since: null, days: [], models: [], places: [], finished: 0 });
    expect(all.total).toEqual(EMPTY_USAGE_AMOUNT);
    expect(usageValue(all.total, "tokens")).toBeNull();
    expect(usageValue(all.total, "usd")).toBeNull();
    const month = store.summary(DEFAULT_USAGE_QUERY, { now: NOW, names });
    expect(month.days).toHaveLength(30);
    expect(month.days.every((day) => day.amount.records === 0)).toBe(true);
    expect(month.where).toEqual({
      firstmate: EMPTY_USAGE_AMOUNT,
      projects: [],
      other: EMPTY_USAGE_AMOUNT,
    });
    expect(store.tasks({ ...DEFAULT_USAGE_QUERY, limit: 10 }, { now: NOW })).toEqual({
      query: { ...DEFAULT_USAGE_QUERY, limit: 10 },
      tasks: [],
      matching: 0,
    });
  });
});

describe("UsageStore, where it went by project and kind of work, and recent tasks", () => {
  const NOW = new Date(2026, 9, 5, 15, 0).getTime();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const names: UsageNames = { model: (ref) => ref.id, provider: (provider) => provider };

  /**
   * Two projects and one the record no longer has, tasks of saved kinds,
   * one with no kind and one unclear, a supporting model call made for a
   * task, the Firstmate, other work, and a record outside the month.
   */
  function ledger() {
    const db = openInMemoryDatabase();
    const repo = db.prepare(
      "INSERT INTO repos (id, path, name, added_at, setup_kind, origin, delivery, autonomy) VALUES (?, ?, ?, ?, 'clone', NULL, 'direct-pr', 0)",
    );
    for (const [id, name, key] of [
      ["repo-fm", "firstmate-3000", "FM3K"],
      ["repo-web", "Website", "WEB"],
      ["repo-old", "Old project", "OLD"],
    ] as const) {
      repo.run(id, `/repos/${id}`, name, NOW);
      ensureRepoProject(db, { id, name }, NOW, key);
    }
    let clock = NOW - 10 * DAY;
    const tasks = new TaskService({ db, strict: true, now: () => clock });
    const seed = (id: string, repoId: string, kind?: "implement" | "fix" | "plan" | "unclear") => {
      clock += HOUR;
      seedTask(tasks, {
        id,
        title: id,
        status: "queued",
        startPolicy: "on-request",
        repoId,
        ...(kind ? { shape: { kind } } : {}),
      });
    };
    seed("build", "repo-fm", "implement");
    seed("repair", "repo-fm", "fix");
    seed("older", "repo-fm");
    seed("vague", "repo-fm", "unclear");
    seed("homepage", "repo-web", "implement");
    seed("pricing", "repo-web", "plan");
    seed("orphan", "repo-old", "fix");
    db.prepare(
      "DELETE FROM projects WHERE id = (SELECT project_id FROM tasks WHERE id = 'orphan')",
    ).run();
    const store = new UsageStore(db);
    const record = (taskId: string, tokens: number, at: number, extra = {}) =>
      store.record({
        taskId,
        model: { provider: "openai-codex", id: "gpt-5.5" },
        usage: { input: tokens, output: 1, cacheRead: 2, cacheWrite: 3, ...extra },
        at,
      });
    record("build", 1000, NOW - HOUR, {
      cost: 1,
      costSource: "listed-prices",
      costParts: { input: 0.5, output: 0.2, cacheRead: 0.2, cacheWrite: 0.1 },
    });
    // A supporting model call made for the same task, on another model.
    store.record({
      taskId: "build",
      model: { provider: "xai", id: "grok-5" },
      usage: { input: 50, output: 5 },
      at: NOW - 2 * HOUR,
    });
    record("repair", 400, NOW - DAY);
    record("older", 300, NOW - DAY);
    record("vague", 200, NOW - DAY);
    record("homepage", 700, NOW - DAY, { cost: 0.7, costSource: "claude" });
    record("pricing", 100, NOW - 2 * DAY);
    record("orphan", 60, NOW - DAY);
    record("firstmate", 900, NOW - HOUR);
    record("routing", 80, NOW - HOUR);
    // Outside the last 30 days.
    record("pricing", 5000, NOW - 40 * DAY);
    return store;
  }

  const tokensOf = (amount: UsageAmount) => usageValue(amount, "tokens");
  const shape = (where: UsageWhere) =>
    Object.fromEntries(
      where.projects.map((project) => [
        project.project?.name ?? "unavailable",
        Object.fromEntries(project.kinds.map((each) => [each.kind ?? "none", each.amount.records])),
      ]),
    );

  it("sums each project's task work by saved kind, the unclear and the unsaved together, under one subtotal", () => {
    const { where } = ledger().summary(DEFAULT_USAGE_QUERY, { now: NOW, names });
    expect(shape(where)).toEqual({
      "firstmate-3000": { implement: 2, fix: 1, none: 2 },
      Website: { implement: 1, plan: 1 },
      unavailable: { fix: 1 },
    });
    for (const project of where.projects) {
      expect(addUsageAmounts(project.kinds.map((each) => each.amount))).toEqual(project.amount);
    }
    const website = where.projects.find((project) => project.project?.name === "Website");
    expect(website?.project).toEqual({ id: expect.any(String), name: "Website" });
    expect(tokensOf(where.firstmate)).toBe(900 + 6);
    expect(tokensOf(where.other)).toBe(80 + 6);
  });

  it("reconciles the Firstmate, the project subtotals and other work to the total, counting no row twice", () => {
    const summary = ledger().summary(DEFAULT_USAGE_QUERY, { now: NOW, names });
    const sum = addUsageAmounts([
      summary.where.firstmate,
      ...summary.where.projects.map((project) => project.amount),
      summary.where.other,
    ]);
    expect(sum.tokens).toEqual(summary.total.tokens);
    expect(sum.records).toBe(summary.total.records);
    expect(sum.priced).toBe(summary.total.priced);
    expect(sum.cost).toBeCloseTo(summary.total.cost ?? 0, 6);
  });

  it("groups a model's own work the same way, over that model's records alone", () => {
    const summary = ledger().summary(DEFAULT_USAGE_QUERY, { now: NOW, names });
    const grok = summary.models.find((model) => model.id === "xai/grok-5");
    expect(shape(grok?.where as UsageWhere)).toEqual({ "firstmate-3000": { implement: 1 } });
    expect(grok?.where.firstmate.records).toBe(0);
    expect(tokensOf(grok?.where.projects[0]?.amount as UsageAmount)).toBe(55);
  });

  it("follows the work and the period: task work names no Firstmate, other work no project", () => {
    const store = ledger();
    const task = store.summary({ period: "30d", scope: "task" }, { now: NOW, names }).where;
    expect(task.firstmate.records).toBe(0);
    expect(task.other.records).toBe(0);
    expect(task.projects).toHaveLength(3);
    const other = store.summary({ period: "30d", scope: "other" }, { now: NOW, names }).where;
    expect(other.projects).toEqual([]);
    const all = store.summary({ period: "all", scope: "all" }, { now: NOW, names }).where;
    expect(shape(all).Website).toEqual({ implement: 1, plan: 2 });
  });

  it("lists recent tasks newest created first, as many as asked, with how many match", () => {
    const store = ledger();
    const read = (limit: number) => store.tasks({ ...DEFAULT_USAGE_QUERY, limit }, { now: NOW });
    const first = read(3);
    expect(first.matching).toBe(7);
    expect(first.tasks.map((each) => each.task.title)).toEqual(["orphan", "pricing", "homepage"]);
    // A longer read keeps the shorter one's tasks first, in the same order.
    const all = read(10);
    expect(all.tasks.map((each) => each.task.title)).toEqual([
      "orphan",
      "pricing",
      "homepage",
      "vague",
      "older",
      "repair",
      "build",
    ]);
    expect(all.tasks[0]?.task.project).toBeNull();
    expect(all.tasks[1]?.task).toEqual({ key: "WEB-2", title: "pricing", project: "Website" });
    // The Firstmate and other work are never tasks; neither is anything outside the work.
    expect(
      store.tasks({ period: "30d", scope: "firstmate", limit: 10 }, { now: NOW }).tasks,
    ).toEqual([]);
    expect(store.tasks({ period: "30d", scope: "other", limit: 10 }, { now: NOW }).matching).toBe(
      0,
    );
    expect(store.tasks({ period: "30d", scope: "task", limit: 10 }, { now: NOW }).matching).toBe(7);
  });

  it("breaks a tie on the moment a task was created by the task, so no read skips or repeats one", () => {
    const db = openInMemoryDatabase();
    const tasks = new TaskService({ db, strict: true, now: () => NOW - DAY });
    const store = new UsageStore(db);
    for (const id of ["b", "c", "a"]) {
      seedTask(tasks, { id, title: id, status: "queued", startPolicy: "on-request" });
      store.record({ taskId: id, usage: { input: 1 }, at: NOW - HOUR });
    }
    const titles = (limit: number) =>
      store
        .tasks({ ...DEFAULT_USAGE_QUERY, limit }, { now: NOW })
        .tasks.map((each) => each.task.title);
    expect(titles(3)).toEqual(["c", "b", "a"]);
    expect(titles(2)).toEqual(["c", "b"]);
  });

  it("sums a recent task over the period alone, and says how many records reported each category", () => {
    const store = ledger();
    const task = (title: string, period: "30d" | "all" = "30d") =>
      store
        .tasks({ period, scope: "all", limit: 10 }, { now: NOW })
        .tasks.find((each) => each.task.title === title);
    expect(task("pricing")?.amount.tokens.input).toBe(100);
    expect(task("pricing", "all")?.amount.tokens.input).toBe(5100);
    const build = task("build");
    // The supporting call counts once, under its task, and reported no cache.
    expect(build?.amount.records).toBe(2);
    expect(build?.amount.tokens).toEqual({ input: 1050, output: 6, cacheRead: 2, cacheWrite: 3 });
    expect(build?.reported).toEqual({ input: 2, output: 2, cacheRead: 1, cacheWrite: 1 });
    expect(build?.amount.tokenReported).toEqual(build?.reported);
    expect(build?.costReported).toEqual({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
    // Claude's own estimate: priced, never split.
    expect(task("homepage")?.amount).toMatchObject({ cost: 0.7, priced: 1, split: 0 });
    expect(task("homepage")?.costReported).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("token category coverage", () => {
  it("keeps zero distinct from missing through every aggregate and filter", () => {
    const store = new UsageStore(openInMemoryDatabase());
    const now = Date.now();
    const names: UsageNames = { provider: (id) => id, model: (ref) => ref.id };
    store.record({
      taskId: "firstmate",
      model: { provider: "anthropic-claude", id: "input-only" },
      usage: { input: 42, output: 0 },
      at: now,
    });
    store.record({
      taskId: "routing",
      model: { provider: "xai", id: "mixed" },
      usage: { input: 8, cacheRead: 0 },
      at: now,
    });
    store.record({
      taskId: "routing",
      model: { provider: "xai", id: "mixed" },
      usage: { output: 3 },
      at: now,
    });
    store.record({
      taskId: "routing",
      model: { provider: "xai", id: "no-tokens" },
      usage: { cost: 1 },
      at: now,
    });
    for (const period of ["7d", "30d", "all"] as const) {
      const summary = store.summary({ period, scope: "all" }, { now, names });
      expect(summary.total.tokenReported).toEqual({
        input: 2,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
      });
      expect(summary.total.tokens).toEqual({ input: 50, output: 3, cacheRead: 0, cacheWrite: 0 });
      for (const parts of [
        summary.models.map((each) => each.amount),
        summary.days.map((each) => each.amount),
        [summary.where.firstmate, summary.where.other],
      ]) {
        expect(addUsageAmounts(parts).tokenReported).toEqual(summary.total.tokenReported);
      }
      const inputOnly = summary.models.find((each) => each.model === "input-only")?.amount;
      if (!inputOnly) throw new Error("Missing seeded model input-only");
      expect(usageCategoryValue(inputOnly, "output", "tokens")).toBe(0);
      expect(usageCategoryValue(inputOnly, "cacheRead", "tokens")).toBeNull();
      expect(usageCategoryValue(inputOnly, "cacheWrite", "tokens")).toBeNull();
      const mixed = summary.models.find((each) => each.model === "mixed")?.amount;
      if (!mixed) throw new Error("Missing seeded model mixed");
      expect(mixed.tokenReported).toEqual({ input: 1, output: 1, cacheRead: 1, cacheWrite: 0 });
      expect(usageCategoryValue(mixed, "cacheRead", "tokens")).toBe(0);
      const none = summary.models.find((each) => each.model === "no-tokens")?.amount;
      if (!none) throw new Error("Missing seeded model no-tokens");
      expect(usageValue(none, "tokens")).toBeNull();
      expect(usageValue(none, "usd")).toBe(1);
      expect(
        store.summary({ period, scope: "firstmate" }, { now, names }).total.tokenReported,
      ).toEqual(inputOnly.tokenReported);
      expect(store.summary({ period, scope: "other" }, { now, names }).total.records).toBe(3);
    }
  });

  it("does not infer category coverage from an older home's any-token flag", () => {
    const older: UsageAmount = {
      ...EMPTY_USAGE_AMOUNT,
      records: 1,
      counted: 1,
      tokenReported: undefined,
    };
    expect(usageCategoryValue(older, "cacheRead", "tokens")).toBeNull();
    expect(addUsageAmounts([older, EMPTY_USAGE_AMOUNT]).tokenReported).toBeUndefined();
    expect(addUsageAmounts([EMPTY_USAGE_AMOUNT, older]).tokenReported).toBeUndefined();
  });
});
