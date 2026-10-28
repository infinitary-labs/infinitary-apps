import type { CatalogModelView, ModelsCatalogView, QuotaProviderView } from "@shared/quota";
import { allowanceProviderOf } from "@shared/quota";
import { compareSpendRank, providerScopes, type ScopeSignals } from "@shared/quotaSignals";
import type { QuotaCatalogModel } from "./auth";

type EffectiveView = {
  effectivePercentRemaining?: number;
  paceStatus?: CatalogModelView["paceStatus"];
  spendPriority?: number;
  lastsThroughReset?: boolean;
};

/**
 * Does a model-scoped quota window (a "model:<slug>" scope) apply to this
 * catalog model? Conservative on purpose: the slug's normalized tokens must
 * appear contiguously inside the model id's ("fable" in claude-fable-5;
 * "opus" in claude-opus-4-5). A vendor codename that matches nothing falls
 * back to the account-wide scope rather than a guessed narrowing.
 */
export function scopeAppliesToModel(scope: string, modelId: string): boolean {
  const slug = scope.replace(/^model:/, "");
  const tokens = (value: string) =>
    value.toLowerCase().replace(/[._:]/g, "-").split("-").filter(Boolean);
  const slugTokens = tokens(slug);
  const idTokens = tokens(modelId);
  if (slugTokens.length === 0) return false;
  outer: for (let start = 0; start <= idTokens.length - slugTokens.length; start++) {
    for (let offset = 0; offset < slugTokens.length; offset++) {
      if (idTokens[start + offset] !== slugTokens[offset]) continue outer;
    }
    return true;
  }
  return false;
}

/** The scope that bounds a model on one account row: its model window's, else account-wide. */
function modelScope(
  provider: QuotaProviderView,
  nowMs: number,
  modelId?: string,
): ScopeSignals | undefined {
  const view = providerScopes(provider, nowMs);
  if (modelId) {
    const match = view.scopes.find(
      (candidate) =>
        candidate.scope.startsWith("model:") && scopeAppliesToModel(candidate.scope, modelId),
    );
    if (match) return match;
  }
  return view.allModels;
}

/** When the window holding a model's least headroom on one account row resets. */
export function limitingResetOf(
  provider: QuotaProviderView,
  nowMs: number,
  modelId?: string,
): number | undefined {
  if (provider.status !== "ok" || provider.stale) return undefined;
  const id = modelScope(provider, nowMs, modelId)?.limitingWindowId;
  return provider.windows.find((window) => window.id === id)?.resetsAtMs;
}

/**
 * One account row's effective view for a model: the account-wide scope
 * (windows that jointly bound every model), narrowed by a model-scoped
 * window when one names this model. Model windows never drag the
 * account-wide minimum down for OTHER models - that is the scope rule
 * (quota-axi parity).
 */
export function effectiveFromProvider(
  provider: QuotaProviderView | undefined,
  nowMs: number,
  modelId?: string,
): EffectiveView {
  if (provider?.status !== "ok" || provider.stale) return {};
  const scope = modelScope(provider, nowMs, modelId);
  if (!scope) return {};
  // The pace label keeps the pre-existing display ladder over the scope's
  // own windows (ahead - the conserve signal - outranks the rest).
  const scopeWindowIds = new Set(scope.boundedBy);
  const paces = provider.windows
    .filter((window) => scopeWindowIds.has(window.id))
    .map((window) => window.pace)
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const paceStatus = paces.includes("ahead")
    ? "ahead"
    : paces.includes("behind")
      ? "behind"
      : paces.includes("on_pace")
        ? "on_pace"
        : paces.includes("unknown")
          ? "unknown"
          : undefined;
  return {
    ...(scope.effectivePercentRemaining !== undefined
      ? { effectivePercentRemaining: scope.effectivePercentRemaining }
      : {}),
    ...(paceStatus ? { paceStatus } : {}),
    ...(scope.spendPriority !== undefined ? { spendPriority: scope.spendPriority } : {}),
    ...(scope.runway.status === "through_reset"
      ? { lastsThroughReset: true }
      : scope.runway.status === "unknown"
        ? {}
        : { lastsThroughReset: false }),
  };
}

/**
 * With N accounts per provider (broker phase 2), a model's catalog signals
 * are the BEST account's - the routing engine picks the model, then the
 * account-selection step picks which account serves it. Best is the highest
 * spend priority when any account has one (that is the account with paid
 * allowance on track to expire unused), an account projected to last
 * through its resets before one projected to run out, and highest
 * effective remaining otherwise; an unmeasurable signal is never ranked as
 * zero.
 */
function effectiveAcrossAccounts(
  rows: QuotaProviderView[],
  nowMs: number,
  modelId: string,
): EffectiveView {
  let best: EffectiveView = {};
  for (const row of rows) {
    const effective = effectiveFromProvider(row, nowMs, modelId);
    if (effective.effectivePercentRemaining === undefined) continue;
    const order = compareSpendRank(effective, best);
    const wins =
      best.effectivePercentRemaining === undefined ||
      order < 0 ||
      (order === 0 &&
        effective.spendPriority === undefined &&
        effective.effectivePercentRemaining > best.effectivePercentRemaining);
    if (wins) best = effective;
  }
  if (best.effectivePercentRemaining !== undefined) return best;
  // No measurable account: fall back to the first row's pace-only view.
  return rows.length > 0 ? effectiveFromProvider(rows[0], nowMs, modelId) : {};
}

function runwayRank(model: CatalogModelView): number {
  if (typeof model.effectivePercentRemaining === "number") return model.effectivePercentRemaining;
  return -1;
}

export function buildModelsCatalog(
  models: QuotaCatalogModel[],
  providers: QuotaProviderView[],
  generatedAt: string,
  nowMs?: number,
): ModelsCatalogView {
  const at =
    nowMs ?? (Number.isFinite(Date.parse(generatedAt)) ? Date.parse(generatedAt) : Date.now());
  const byQuotaId = new Map<string, QuotaProviderView[]>();
  for (const provider of providers) {
    const rows = byQuotaId.get(provider.provider) ?? [];
    rows.push(provider);
    byQuotaId.set(provider.provider, rows);
  }
  const catalog: CatalogModelView[] = models.flatMap((model) => {
    const quotaId = allowanceProviderOf(model.provider);
    if (!quotaId) return [];
    const effective = effectiveAcrossAccounts(byQuotaId.get(quotaId) ?? [], at, model.id);
    return [
      {
        provider: quotaId,
        id: model.id,
        label: model.name,
        ...effective,
      },
    ];
  });
  // Spend-priority order (quota-axi ranking semantics): the scope whose paid
  // allowance is most on track to expire unused comes first, among models
  // projected to last through their resets before those projected to run
  // out (INF-898). Models without a measurable signal keep runway order
  // among themselves - unknown is not zero, and headroom is still real
  // evidence.
  catalog.sort((a, b) => {
    const order = compareSpendRank(a, b);
    if (order !== 0) return order;
    const rank = runwayRank(b) - runwayRank(a);
    if (rank !== 0) return rank;
    return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
  });
  return { generatedAt, models: catalog };
}
