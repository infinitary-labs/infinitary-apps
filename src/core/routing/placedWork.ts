import type { CatalogModelView, QuotaProviderView, QuotaSnapshotView } from "@shared/quota";
import { allowanceProviderOf } from "@shared/quota";
import { classifyProviderWindows, compareSpendRank } from "@shared/quotaSignals";
import { effectiveFromProvider, scopeAppliesToModel } from "../quota/catalog";
import type { AppDatabase } from "../storage/db";
import type { SettingsStore } from "../storage/settingsStore";

export type ChargeFact = {
  accountId: string;
  measuredAt: number;
  source: string;
  baseSpendPriority?: number;
  windows: {
    id: string;
    points: number;
    pointsPerDollar?: number;
    percentRemaining?: number;
    resetsAtMs?: number;
  }[];
};
export type RankedModel = CatalogModelView & { charge?: ChargeFact };
type Reading = { source: string; row: QuotaProviderView; at: number };
type Cycle = Reading & { windowId: string; reset: number; initial: number; start: number };
type Work = {
  id: string;
  account: string | null;
  device: string | null;
  provider: string;
  model: string;
  level: string;
  at: number;
  closed: number | null;
  status: string;
};

/** INF-443: prices are learned locally; only ranking, never the meter, is adjusted. */
export class PlacedWorkScores {
  private readonly readings = new Map<string, Reading>();
  private readonly cycles = new Map<string, Cycle>();
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: SettingsStore,
  ) {}

  private login(row: QuotaProviderView): string {
    // Neither Grok nor Codex identifies a login. Claude identities never mix.
    return row.provider === "claude"
      ? JSON.stringify([row.provider, row.account ?? row.accountId])
      : row.provider;
  }
  private priceKey(row: QuotaProviderView, window: string): string {
    return JSON.stringify([this.login(row), window]);
  }

  observe(source: string, snapshot: QuotaSnapshotView): void {
    for (const row of snapshot.providers) {
      if (!row.accountId || row.status !== "ok" || row.stale) continue;
      const at = row.measuredAt ?? snapshot.fetchedAt;
      const key = JSON.stringify([source, row.accountId]);
      const previous = this.readings.get(key);
      if (previous && at <= previous.at) continue; // Recatalog is not another reading.
      const reading = { source, row, at };
      this.readings.set(key, reading);
      const classified = classifyProviderWindows(row.provider, row.windows);
      for (const window of [...classified.bounding, ...[...classified.scoped.values()].flat()]) {
        if (window.percentRemaining === undefined || !window.resetsAtMs || window.resetsAtMs <= at)
          continue;
        const cycleKey = JSON.stringify([key, window.id]);
        const cycle = this.cycles.get(cycleKey);
        if (
          !cycle ||
          cycle.reset !== window.resetsAtMs ||
          window.percentRemaining >
            (cycle.row.windows.find((w) => w.id === window.id)?.percentRemaining ?? 100)
        ) {
          this.cycles.set(cycleKey, {
            ...reading,
            windowId: window.id,
            reset: window.resetsAtMs,
            initial: window.percentRemaining,
            start: at,
          });
        } else {
          this.cycles.set(cycleKey, { ...cycle, ...reading });
        }
      }
    }
    const totals = new Map<string, { drop: number; dollars: number }>();
    for (const cycle of this.cycles.values()) {
      if (cycle.reset <= snapshot.fetchedAt) continue;
      const remaining = cycle.row.windows.find((w) => w.id === cycle.windowId)?.percentRemaining;
      if (remaining === undefined) continue;
      const key = this.priceKey(cycle.row, cycle.windowId);
      const total = totals.get(key) ?? { drop: 0, dollars: 0 };
      total.drop += Math.max(0, cycle.initial - remaining);
      // Includes the first mate's own calls, but only this sign-in's same-time usage.
      const costs = this.db
        .prepare(
          "SELECT model, SUM(cost) AS cost FROM usage_events WHERE account_id = ? AND at > ? AND at <= ? AND cost > 0 GROUP BY model",
        )
        .all(cycle.row.accountId, cycle.start, cycle.at) as {
        model: string | null;
        cost: number;
      }[];
      const scopes = classifyProviderWindows(cycle.row.provider, [
        { id: cycle.windowId, label: cycle.windowId },
      ]).scoped;
      total.dollars += costs
        .filter(
          (cost) =>
            scopes.size === 0 ||
            (cost.model !== null &&
              [...scopes.keys()].some((scope) => scopeAppliesToModel(scope, cost.model ?? ""))),
        )
        .reduce((sum, cost) => sum + cost.cost, 0);
      totals.set(key, total);
    }
    const prices = this.settings.getAllowancePrices();
    let changed = false;
    for (const [key, total] of totals) {
      if (total.drop < 3 || total.dollars <= 0) continue;
      const price = total.drop / total.dollars;
      if (Number.isFinite(price) && price > 0 && prices[key] !== price) {
        prices[key] = price;
        changed = true;
      }
    }
    if (changed) this.settings.setAllowancePrices(prices);
  }

  /** Read the newest committed route, including an Automatic start not yet attached. */
  private work(): Work[] {
    return this.db
      .prepare(`SELECT t.id, COALESCE(t.account_id, json_extract(d.facts_json, '$.accountId')) AS account, t.device_id AS device,
      d.provider, d.model, COALESCE(d.served, d.bucket) AS level, d.at,
      t.closed_at AS closed, t.status
      FROM tasks t JOIN decisions d ON d.task_id = t.id AND d.kind = 'routing'
      WHERE d.id = (SELECT MAX(n.id) FROM decisions n WHERE n.task_id = t.id AND n.kind = 'routing')
      AND d.model IS NOT NULL`)
      .all() as Work[];
  }

  private finished(now: number) {
    const samples = this.db
      .prepare(`SELECT d.provider, d.model, COALESCE(d.served, d.bucket) AS level, SUM(u.cost) AS cost
      FROM tasks t JOIN decisions d ON d.task_id = t.id AND d.kind = 'routing'
      JOIN usage_events u ON u.task_id = t.id
      WHERE t.status = 'done' AND t.closed_at >= ? AND t.closed_at <= ?
      AND d.id = (SELECT MAX(n.id) FROM decisions n WHERE n.task_id = t.id AND n.kind = 'routing')
      GROUP BY t.id HAVING COUNT(u.cost) = COUNT(*) AND SUM(u.cost) > 0`)
      .all(now - 14 * 86400000, now) as {
      provider: string;
      model: string;
      level: string;
      cost: number;
    }[];
    return samples;
  }

  private expected(
    work: Work,
    samples: ReturnType<PlacedWorkScores["finished"]>,
    logged: number,
  ): number | undefined {
    const provider = samples.filter((s) => s.provider === work.provider);
    for (const group of [
      provider.filter((s) => s.model === work.model && s.level === work.level),
      provider.filter((s) => s.model === work.model),
      provider,
    ]) {
      if (group.length < 5) continue;
      const average = group.reduce((sum, s) => sum + s.cost, 0) / group.length;
      if (logged <= average) return average;
      const tail = group.filter((s) => s.cost >= logged);
      return tail.length ? tail.reduce((sum, s) => sum + s.cost, 0) / tail.length : logged;
    }
    return undefined;
  }

  score(
    row: QuotaProviderView,
    now: number,
    model?: string,
    data = { work: this.work(), samples: this.finished(now) },
  ): { spendPriority?: number; lastsThroughReset?: boolean; charge?: ChargeFact } {
    const original = effectiveFromProvider(row, now, model);
    if (row.status !== "ok" || row.stale || !row.accountId) return original;
    const reading =
      [...this.readings.values()].find(
        (r) => r.row.accountId === row.accountId && r.at === row.measuredAt,
      ) ?? [...this.readings.values()].find((r) => r.row.accountId === row.accountId);
    if (!reading) return original;
    const prices = this.settings.getAllowancePrices();
    const works = data.work.filter(
      (w) =>
        allowanceProviderOf(w.provider) === row.provider &&
        (w.account
          ? [...this.readings.values()].some(
              (r) => r.row.accountId === w.account && this.login(r.row) === this.login(row),
            )
          : [...this.readings.values()]
              .filter((r) => (w.device ?? "home") === r.source && r.row.provider === row.provider)
              .slice(0, 1)
              .some((r) => this.login(r.row) === this.login(row))),
    );
    const windows = row.windows.map((window) => {
      const price = prices[this.priceKey(row, window.id)];
      let points = 0;
      if (price !== undefined)
        for (const work of works) {
          if (work.closed !== null && reading.at > work.closed) continue;
          const scoped = classifyProviderWindows(row.provider, [window]).scoped;
          if (
            scoped.size &&
            ![...scoped.keys()].some((scope) => scopeAppliesToModel(scope, work.model))
          )
            continue;
          const sums = this.db
            .prepare(
              "SELECT SUM(cost) AS logged, SUM(CASE WHEN at <= ? THEN cost ELSE 0 END) AS metered FROM usage_events WHERE task_id = ? AND cost > 0",
            )
            .get(reading.at, work.id) as { logged: number | null; metered: number | null };
          const logged = sums.logged ?? 0;
          const expected =
            work.closed !== null ? logged : this.expected(work, data.samples, logged);
          if (expected !== undefined) points += Math.max(0, expected - (sums.metered ?? 0)) * price;
        }
      return {
        id: window.id,
        points,
        percentRemaining: window.percentRemaining,
        resetsAtMs: window.resetsAtMs,
        ...(price !== undefined ? { pointsPerDollar: price } : {}),
      };
    });
    const adjusted = effectiveFromProvider(
      {
        ...row,
        windows: row.windows.map((window, i) => ({
          ...window,
          ...(window.percentRemaining !== undefined
            ? { percentRemaining: window.percentRemaining - (windows[i]?.points ?? 0) }
            : {}),
        })),
      },
      now,
      model,
    );
    return {
      ...(adjusted.spendPriority !== undefined ? { spendPriority: adjusted.spendPriority } : {}),
      // Placed work counts toward the runway too: a charge can bring a
      // window's projected exhaustion before its reset.
      ...(adjusted.lastsThroughReset !== undefined
        ? { lastsThroughReset: adjusted.lastsThroughReset }
        : {}),
      charge: {
        accountId: row.accountId,
        source: reading.source,
        measuredAt: reading.at,
        baseSpendPriority: original.spendPriority,
        windows,
      },
    };
  }

  catalog(catalog: CatalogModelView[], rows: QuotaProviderView[], now: number): RankedModel[] {
    const data = { work: this.work(), samples: this.finished(now) };
    return catalog.map((model) => {
      const candidates = rows
        .filter((row) => row.provider === model.provider)
        .map((row) => ({
          row,
          raw: effectiveFromProvider(row, now, model.id),
          score: this.score(row, now, model.id, data),
        }))
        .filter((c) => c.raw.effectivePercentRemaining !== undefined);
      candidates.sort((a, b) => {
        const order = compareSpendRank({ ...a.raw, ...a.score }, { ...b.raw, ...b.score });
        if (order !== 0) return order;
        return (b.raw.effectivePercentRemaining ?? -1) - (a.raw.effectivePercentRemaining ?? -1);
      });
      const best = candidates[0];
      return best ? { ...model, ...best.raw, ...best.score } : model;
    });
  }
}
