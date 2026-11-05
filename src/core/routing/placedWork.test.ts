import { AUTOMATIC_COMPUTER } from "@shared/placement";
import type { QuotaProviderView, QuotaSnapshotView } from "@shared/quota";
import type { RepoView } from "@shared/repos";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { AutomaticPlacement } from "../placed/automaticPlacement";
import { ComputerResourceFeed } from "../placed/computerResourceFeed";
import { ComputerResources } from "../placed/computerResources";
import type { WorkDevices } from "../placed/workDevices";
import { buildModelsCatalog, effectiveFromProvider } from "../quota/catalog";
import type { QuotaService } from "../quota/quotaService";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { UsageStore } from "../storage/usageStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { AccountSelector } from "./accountRouter";
import { PlacedWorkScores } from "./placedWork";
import { Router } from "./router";

// INF-443 acceptance, using INF-438's recorded 19%/84% readings, reset instants,
// $289.61 + $0.60 usage and the 24 finished-task costs reconstructed from its
// published scatter plot (0.1 pixel precision, not claimed as original ledger rows).
const AT = Date.parse("2026-10-18T18:07:00Z");
const FINISHED = [
  4.95, 8.37, 9, 10.17, 10.56, 14.22, 14.27, 17.83, 21.78, 22.9, 23.49, 23.68, 24.2, 24.34, 24.68,
  29.22, 36.95, 45.8, 57.39, 58.34, 73.29, 100.63, 101.56, 126.02,
];
const GROK = { provider: "xai", id: "grok-4.7", name: "Grok" };
const CODEX = { provider: "openai-codex", id: "gpt-6-sol", name: "Codex" };
function row(provider = "grok", accountId = "mini-grok", remaining = 19): QuotaProviderView {
  return {
    provider,
    accountId,
    label: provider,
    status: "ok",
    stale: false,
    windows: [
      {
        id: "weekly",
        label: "Weekly",
        percentRemaining: remaining,
        windowSeconds: 604800,
        resetsAtMs: Date.parse(
          provider === "grok" ? "2026-10-20T03:59:00Z" : "2026-10-24T21:09:00Z",
        ),
      },
    ],
  };
}
function snapshot(at: number, providers: QuotaProviderView[]): QuotaSnapshotView {
  return { fetchedAt: at, generatedAt: new Date(at).toISOString(), providers };
}
function world(samples = FINISHED, sampleModel = GROK, level = "medium") {
  const db = freshDatabase();
  const settings = new SettingsStore(db);
  const tasks = new TaskService({ db, now: () => AT });
  const decisions = new DecisionStore(db);
  const usage = new UsageStore(db);
  const scores = new PlacedWorkScores(db, settings);
  const log = (taskId: string, cost: number, at: number, accountId = "mini-grok") =>
    usage.record({
      taskId,
      accountId,
      model: GROK,
      usage: { cost, costSource: "listed-prices" },
      at,
    });
  const seed = (id: string, deviceId?: string) =>
    seedTask(tasks, {
      id,
      title: id,
      status: "running",
      ...(deviceId ? { deviceId } : {}),
      createdAt: AT - 86400000,
    });
  const route = (id: string, model = GROK, level = "medium") =>
    decisions.recordRouting({
      taskId: id,
      provider: model.provider,
      model: model.id,
      bucket: level,
      served: level,
      rule: "R4",
      reasons: [],
    });
  for (const [i, cost] of samples.entries()) {
    const id = `finished-${i}`;
    seed(id);
    route(id, sampleModel, level);
    log(id, cost, AT - 3600000);
    tasks.close(id, { status: "done", reason: "finished", actor: "host" });
  }
  const learn = () => {
    const before = AT - 3600000;
    scores.observe("mini", snapshot(before, [row("grok", "mini-grok", 38)]));
    scores.observe("home", snapshot(before, [row("grok", "home-grok", 38)]));
    log("firstmate", 289.61, AT - 1000);
    log("firstmate", 0.6, AT - 1000, "home-grok");
    scores.observe("mini", snapshot(AT, [row()]));
    scores.observe("home", snapshot(AT, [row("grok", "home-grok")]));
  };
  return { db, settings, tasks, decisions, scores, usage, log, seed, route, learn };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AT);
});
afterEach(() => vi.useRealTimers());
describe("INF-443 learned placed-work ranking", () => {
  it("replays the twelve-task burst through Router commits: one Grok, then eleven Codex; the raw meter is unchanged", () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const w = world();
    w.learn();
    const rows = [row(), row("codex", "mini-codex", 84)];
    const catalog = buildModelsCatalog([GROK, CODEX], rows, new Date(AT).toISOString(), AT);
    const router = new Router({
      settings: w.settings,
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
      availableModels: () => [GROK, CODEX],
    });
    const picked: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `audit-${i}`;
      w.seed(id, "mini");
      picked.push(
        router.decide(
          id,
          "Build the accepted audit piece",
          {
            kind: "implement",
            basis: "plan",
            basis_verified: true,
          },
          {
            pool: {
              available: [GROK, CODEX],
              catalog: catalog.models,
              readings: rows,
              note: "Mac mini",
            },
          },
        )!.choice!.provider,
      );
    }
    expect(picked).toEqual(["xai", ...Array<string>(11).fill("openai-codex")]);
    const facts = w.db
      .prepare("SELECT facts_json FROM decisions WHERE task_id = 'audit-1' AND kind = 'routing'")
      .get() as { facts_json: string };
    const grok = JSON.parse(facts.facts_json).candidates.find(
      (c: { provider: string }) => c.provider === "xai",
    );
    expect(grok.percentRemaining).toBe(19);
    expect(grok.charge.windows[0].pointsPerDollar).toBeCloseTo(38 / 290.21);
    expect(grok.charge.windows[0].points).toBeGreaterThan(4);
    expect(catalog.models.find((m) => m.provider === "grok")!.effectivePercentRemaining).toBe(19);
    console.log(
      JSON.stringify({
        scenario: "INF-438 twelve-task replay",
        picked,
        secondGrokCandidate: grok,
        rawMeter: 19,
      }),
    );
    w.db.close();
  });

  it("charges nothing until learning, keeps a learned price over restart/reset, and ignores duplicate or stale readings", () => {
    const w = world();
    w.seed("new", "mini");
    w.route("new");
    w.scores.observe("mini", snapshot(AT, [row()]));
    expect(w.scores.score(row(), AT).charge!.windows[0]!.points).toBe(0);
    w.learn();
    const price = w.settings.getAllowancePrices();
    expect(Object.values(price)[0]).toBeGreaterThan(0);
    w.scores.observe("mini", snapshot(AT, [row("grok", "mini-grok", 0)]));
    w.scores.observe("mini", snapshot(AT + 1, [{ ...row(), stale: true }]));
    expect(w.settings.getAllowancePrices()).toEqual(price);
    const restarted = new PlacedWorkScores(w.db, new SettingsStore(w.db));
    const reset = row("grok", "mini-grok", 100);
    reset.windows[0]!.resetsAtMs! += 604800000;
    restarted.observe("mini", snapshot(AT + 1000, [reset]));
    expect(restarted.score(reset, AT + 1000).charge!.windows[0]!.points).toBeGreaterThan(0);
    w.db.close();
  });

  it("counts placed work toward the runway: a charge can make a window run out before its reset (INF-898)", () => {
    const w = world();
    w.learn();
    // 22% of Grok's week left with 33.9 hours to go lasts at its observed burn.
    const reading = row("grok", "mini-grok", 22);
    expect(effectiveFromProvider(reading, AT).lastsThroughReset).toBe(true);
    expect(w.scores.score(reading, AT).lastsThroughReset).toBe(true);
    // One running task placed there brings the projection short of the reset.
    w.seed("running", "mini");
    w.route("running");
    const scored = w.scores.score(reading, AT);
    expect(scored.charge!.windows[0]!.points).toBeGreaterThan(2);
    expect(scored.lastsThroughReset).toBe(false);
    w.db.close();
  });

  it("subtracts metered usage, grows a large task from the conditional average, and releases only after a post-finish reading", () => {
    const w = world();
    w.learn();
    w.seed("running", "mini");
    w.route("running");
    const first = w.scores.score(row(), AT).charge!.windows[0]!.points;
    w.log("running", 20, AT - 100);
    const partial = w.scores.score(row(), AT).charge!.windows[0]!.points;
    expect(partial).toBeCloseTo(
      (FINISHED.reduce((sum, cost) => sum + cost, 0) / FINISHED.length - 20) * (38 / 290.21),
    );
    w.log("running", 30, AT + 100);
    expect(w.scores.score(row(), AT + 100).charge!.windows[0]!.points).toBeGreaterThan(partial);
    w.tasks.close("running", { status: "done", reason: "finished", actor: "host" });
    expect(w.scores.score(row(), AT).charge!.windows[0]!.points).toBeGreaterThan(0);
    w.scores.observe("mini", snapshot(AT + 200, [row("grok", "mini-grok", 18)]));
    expect(w.scores.score(row("grok", "mini-grok", 18), AT + 200).charge!.windows[0]!.points).toBe(
      0,
    );
    w.db.close();
  });

  it("can rank a charged allowance below zero without exhausting it or changing a pin", () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const w = world();
    w.learn();
    for (let i = 0; i < 12; i++) {
      w.seed(`placed-${i}`, "mini");
      w.route(`placed-${i}`);
    }
    const rows = [row()];
    const catalog = buildModelsCatalog([GROK], rows, new Date(AT).toISOString(), AT);
    const router = new Router({
      settings: w.settings,
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
      availableModels: () => [GROK],
    });
    expect(
      router.decide("next", "Build", { kind: "implement", basis_verified: true })!.choice,
    ).toMatchObject({ provider: "xai" });
    expect(
      router.decide("pin", "Build", { kind: "unclear", override_model_id: GROK.id })!.choice,
    ).toMatchObject({ provider: "xai" });
    w.db.close();
  });
  it("the second Automatic start sees the first committed charge before either attaches to an account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const w = world();
    w.learn();
    const rows = [row("grok", "home-grok"), row("codex", "home-codex", 84)];
    const catalog = buildModelsCatalog([GROK, CODEX], rows, new Date(AT).toISOString(), AT);
    const router = new Router({
      settings: w.settings,
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
      availableModels: () => [GROK, CODEX],
    });
    const work = { onWorkDevice: () => () => {}, inReach: () => false } as unknown as WorkDevices;
    let sequence = 0;
    const resources = new ComputerResources({
      work,
      now: () => AT,
      local: {
        read: async () => ({
          epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
          sequence: ++sequence,
          status: "sampled",
          sampleMs: 250,
          cpu: { logicalCpus: 10, idleFraction: 0.77 },
          memory: {
            totalBytes: 25165824 * 1024,
            freeBytes: 356672 * 1024,
            purgeableBytes: 335184 * 1024,
            fileBackedBytes: 6852624 * 1024,
          },
        }),
      },
    });
    const feed = new ComputerResourceFeed({
      resources,
      computers: () => [{ computerId: null, label: "This computer" }],
      onComputers: () => () => {},
      onContact: () => () => {},
      emit: () => {},
      now: () => AT,
    });
    const repo = {
      id: "repo",
      name: "Audit",
      path: "/projects/audit",
      setupKind: "clone",
      kind: "project",
      origin: "https://github.com/o/audit.git",
      host: { kind: "github", name: "github.com" },
      delivery: "direct-pr",
      autonomy: false,
      rigor: null,
      runsOn: AUTOMATIC_COMPUTER,
      placementRequirements: { systems: ["macos"], chips: ["arm64"] },
    } as RepoView;
    const placement = new AutomaticPlacement({
      tasks: w.tasks,
      resources: feed,
      work,
      devices: () => [],
      router,
      repo: () => repo,
      catalog: () => [GROK, CODEX],
      now: () => AT,
      running: () => false,
      localFacts: async () => ({
        system: "macos",
        chip: "arm64",
        physicalComputerId: "a".repeat(64),
        tools: { git: "available" },
        projectAccess: "available",
      }),
    });
    try {
      const first = seedTask(w.tasks, { id: "auto-first", title: "Audit first", status: "queued" });
      const second = seedTask(w.tasks, {
        id: "auto-second",
        title: "Audit second",
        status: "queued",
      });
      const shape = { kind: "implement", basis: "plan", basis_verified: true } as const;
      await placement.choose(first, repo, first.title, shape);
      await placement.choose(second, repo, second.title, shape);
      expect(w.decisions.latestRouting(first.id)?.provider).toBe("xai");
      expect(w.decisions.latestRouting(second.id)?.provider).toBe("openai-codex");
      expect(w.tasks.get(first.id)?.accountId).toBeNull();
      console.log(
        JSON.stringify({
          scenario: "successive Automatic starts before account attachment",
          first: w.decisions.latestRouting(first.id),
          second: w.decisions.latestRouting(second.id),
        }),
      );
    } finally {
      placement.dispose();
      feed.dispose();
      w.db.close();
    }
  });

  it.each([4, 5])(
    "needs five finished samples, widening model/level groups before charging (%s samples)",
    (count) => {
      const w = world(FINISHED.slice(0, count), GROK, "high");
      w.learn();
      w.seed("new", "mini");
      w.route("new", { ...GROK, id: "grok-4.3" });
      const points = w.scores.score(row(), AT).charge!.windows[0]!.points;
      expect(points > 0).toBe(count >= 5);
      w.db.close();
    },
  );

  it("keeps Claude logins separate and learns each window independently", () => {
    const w = world(FINISHED, { ...GROK, provider: "anthropic-claude", id: "claude-fable-5-1" });
    const claude = (accountId: string, account: string, remaining: number): QuotaProviderView => ({
      ...row("claude", accountId, remaining),
      account,
      windows: [
        { ...row().windows[0]!, id: "seven_day", percentRemaining: remaining },
        {
          ...row().windows[0]!,
          id: "five_hour",
          percentRemaining: remaining,
          windowSeconds: 18000,
          resetsAtMs: AT + 3600000,
        },
      ],
    });
    w.scores.observe(
      "home",
      snapshot(AT - 1000, [
        claude("c1", "one@example.com", 80),
        claude("c2", "two@example.com", 80),
      ]),
    );
    w.usage.record({
      taskId: "firstmate",
      accountId: "c1",
      model: { provider: "anthropic-claude", id: "claude-fable-5-1" },
      usage: { cost: 60 },
      at: AT - 500,
    });
    const one = claude("c1", "one@example.com", 74);
    one.windows[1]!.percentRemaining = 77;
    const two = claude("c2", "two@example.com", 80);
    w.scores.observe("home", snapshot(AT, [one, two]));
    w.seed("claude-work");
    w.route("claude-work", { ...GROK, provider: "anthropic-claude", id: "claude-fable-5-1" });
    // Bind through the task owner; the other login must not inherit this work.
    w.tasks.starts.dispatch("claude-work", {
      workspace: { repoDir: "", worktreeDir: "", branch: "" },
      accountId: "c1",
      assignee: "crewmate",
    });
    const first = w.scores.score(one, AT).charge!.windows;
    expect(first[0]!.pointsPerDollar).toBeCloseTo(0.1);
    expect(first[1]!.pointsPerDollar).toBeCloseTo(0.05);
    expect(first[0]!.points).toBeCloseTo(first[1]!.points * 2);
    expect(w.scores.score(two, AT).charge!.windows.every((window) => window.points === 0)).toBe(
      true,
    );
    w.db.close();
  });

  it("account selection records the charge and still uses actual headroom for the flagship reserve", () => {
    const w = world();
    w.learn();
    w.seed("placed", "mini");
    w.route("placed");
    const selector = new AccountSelector({
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latest: () => snapshot(AT, [row()]) },
      flagshipAccountId: () => null,
      pool: {
        list: () => [{ id: "mini-grok", providerId: "xai", label: "Grok", enabled: true }],
        connectedSync: () => true,
        withheldReason: () => undefined,
        pinnedAccount: () => undefined,
        markSelected: () => {},
      },
    });
    expect(selector.selectForSpawn("next", "xai")).toBe("mini-grok");
    const saved = w.db.prepare("SELECT facts_json FROM decisions WHERE kind = 'account'").get() as {
      facts_json: string;
    };
    const candidate = JSON.parse(saved.facts_json).candidates[0];
    expect(candidate.percentRemaining).toBe(19);
    expect(candidate.charge.windows[0].points).toBeGreaterThan(0);
    w.db.close();
  });
  it("a fresh unpriced allowance keeps the old twelve-task order, without a one-task restriction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT);
    const w = world();
    const rows = [row(), row("codex", "mini-codex", 84)];
    w.scores.observe("mini", snapshot(AT, rows));
    const catalog = buildModelsCatalog([GROK, CODEX], rows, new Date(AT).toISOString(), AT);
    const router = new Router({
      settings: w.settings,
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
      availableModels: () => [GROK, CODEX],
    });
    for (let i = 0; i < 12; i++) {
      const id = `cold-${i}`;
      w.seed(id, "mini");
      expect(
        router.decide(id, "Build", { kind: "implement", basis_verified: true })?.choice?.provider,
      ).toBe("xai");
    }
    expect(w.settings.getAllowancePrices()).toEqual({});
    w.db.close();
  });

  it("waits for three points of observed drop, not just a positive drop", () => {
    const w = world();
    w.scores.observe("mini", snapshot(AT - 1000, [row("grok", "mini-grok", 22)]));
    w.log("firstmate", 60, AT - 500);
    w.scores.observe("mini", snapshot(AT, [row("grok", "mini-grok", 20)]));
    expect(w.settings.getAllowancePrices()).toEqual({});
    w.scores.observe("mini", snapshot(AT + 1, [row()]));
    expect(Object.values(w.settings.getAllowancePrices())).toEqual([3 / 60]);
    w.db.close();
  });

  // INF-1714: an estimate of placed work orders candidates inside a band and
  // never moves one between bands; only a fresh reading can.
  it("keeps a charged allowance in the band of its unadjusted reading", () => {
    const w = world();
    w.learn();
    const reading = row("grok", "mini-grok", 22);
    w.seed("running", "mini");
    w.route("running");
    const scored = w.scores.score(reading, AT);
    expect(scored.lastsThroughReset).toBe(false);
    expect(scored.band).toBe("room");
    // A fresh reading at the floor moves it.
    expect(w.scores.score(row("grok", "mini-grok", 9), AT).band).toBe("near_floor");
    w.db.close();
  });

  // INF-2056 (the captain's app froze for seconds every few seconds): one
  // preview read the finished tasks again for every account of every model.
  it("reads placed and finished work once per routing preview, however many accounts and models", () => {
    const w = world();
    w.learn();
    w.seed("running", "mini");
    w.route("running");
    const models = [GROK, { ...GROK, id: "grok-4.3" }, { ...GROK, id: "grok-4.1" }];
    const rows = [row("grok", "home-grok", 84), row("grok", "mini-grok", 19)];
    const catalog = buildModelsCatalog(models, rows, new Date(AT).toISOString(), AT);
    const accounts = new AccountSelector({
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latest: () => snapshot(AT, rows) },
      flagshipAccountId: () => null,
      pool: {
        list: () =>
          ["home-grok", "mini-grok"].map((id) => ({
            id,
            providerId: "xai",
            label: id,
            enabled: true,
          })),
        connectedSync: () => true,
        withheldReason: () => undefined,
        pinnedAccount: () => undefined,
        markSelected: () => {},
      },
    });
    const router = new Router({
      settings: w.settings,
      decisions: w.decisions,
      placedWork: w.scores,
      quota: { latestModels: () => catalog, latest: () => snapshot(AT, rows) } as QuotaService,
      availableModels: () => models,
      crewAccount: (provider, model, placed) => accounts.crewAccount(provider, model, placed),
    });
    const reads = w.scores as unknown as { work(): unknown; finished(now: number): unknown };
    const work = vi.spyOn(reads, "work");
    const finished = vi.spyOn(reads, "finished");
    // INF-2255: one routing preview must not read identical usage totals or
    // allowance prices again for each model and its account selection.
    const score = vi.spyOn(w.scores, "score");
    const prices = vi.spyOn(w.settings, "getAllowancePrices");
    const statement = Object.getPrototypeOf(w.db.prepare("SELECT 1"));
    const originalGet = statement.get;
    const sums = new Map<string, number>();
    statement.get = function (this: { source: string }, ...args: unknown[]) {
      if (this.source.includes("SUM(cost) AS logged")) {
        const key = JSON.stringify(args);
        sums.set(key, (sums.get(key) ?? 0) + 1);
      }
      return originalGet.apply(this, args);
    };
    try {
      const preview = router.preview("Build", { kind: "implement", basis_verified: true });
      expect(preview?.result.choice?.provider).toBe("xai");
      expect(finished).toHaveBeenCalledTimes(1);
      expect(work).toHaveBeenCalledTimes(1);
      console.info(
        JSON.stringify({
          intent: "INF-2255 routing evaluation reads",
          models: models.length,
          accounts: rows.length,
          workReads: work.mock.calls.length,
          finishedReads: finished.mock.calls.length,
          scoreCalls: score.mock.calls.length,
          priceReads: prices.mock.calls.length,
          usageReads: [...sums.values()].reduce((a, b) => a + b, 0),
          uniqueUsageReads: sums.size,
          repeatsPerUsageRead: [...new Set(sums.values())],
          preview,
        }),
      );
      expect(sums.size).toBe(FINISHED.length + 1);
      expect([...sums.values()]).toEqual([...sums].map(() => 1));
      expect(prices).toHaveBeenCalledTimes(1);
      // A later evaluation sees new usage, rather than reusing this one's charge.
      const before = preview?.candidates?.[0]?.charge?.windows[0]?.points;
      w.log("running", Math.max(...FINISHED) + 1, AT + 1);
      const next = router.preview("Build", { kind: "implement", basis_verified: true });
      expect(next?.candidates?.[0]?.charge?.windows[0]?.points).toBeGreaterThan(before!);
    } finally {
      statement.get = originalGet;
      score.mockRestore();
      prices.mockRestore();
      work.mockRestore();
      finished.mockRestore();
      w.db.close();
    }
  });

  // INF-1714: the model is ranked by the account that will serve it, so the
  // model ranking and the account binding read the same reading.
  it("ranks a model by the account bound to serve it, and saves which one", () => {
    const w = world();
    const rows = [row("grok", "home-grok", 84), row("grok", "mini-grok", 19)];
    w.scores.observe("home", snapshot(AT, rows));
    const [best] = w.scores.catalog([{ provider: "grok", id: GROK.id, label: "Grok" }], rows, AT);
    expect(best).toMatchObject({ accountId: "home-grok", effectivePercentRemaining: 84 });
    const [bound] = w.scores.catalog(
      [{ provider: "grok", id: GROK.id, label: "Grok" }],
      rows,
      AT,
      () => "mini-grok",
    );
    expect(bound).toMatchObject({
      accountId: "mini-grok",
      effectivePercentRemaining: 19,
      measuredAt: AT,
      resetsAtMs: rows[1]!.windows[0]!.resetsAtMs,
    });
    w.db.close();
  });
});
