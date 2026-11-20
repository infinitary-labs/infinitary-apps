import { dirname, join } from "node:path";
import { InMemoryCredentialStore, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { BEDROCK_PROVIDER_ID } from "@shared/providers";
import { bedrockAccountProvider } from "./bedrock";

/**
 * The one place Infinitary creates a Pi ModelRuntime, so the live-catalog policy
 * is a single decision rather than one per call site.
 *
 * Pi serves models from two layers: the static catalog bundled in pi-ai, and
 * a pi.dev overlay merged over it. The overlay is fetched only when network
 * is allowed, so without it Infinitary's model lists are frozen to whatever
 * pi-ai shipped (that is how grok-4.6 went missing). It adds one
 * unauthenticated, ETag-revalidated GET per signed-in provider per 4h
 * (docs/architecture.md §1 egress list).
 *
 * Captain's hard requirements: a failing pi.dev must never be visible, and
 * nothing the person does may wait on a catalog read (lean model lists,
 * 2026-09-23, docs/model-lists.md). So the runtime is created OFFLINE - the
 * bundled catalog plus the overlay this store last fetched - and returned
 * at once; the network refresh runs in the background and only ever adds
 * to the list when it lands. Every failure mode - network error, timeout,
 * non-200, malformed payload - leaves the offline catalog in place rather
 * than erroring, hanging, or emptying the list. modelRuntime.test.ts proves
 * each of those against a stand-in pi.dev.
 *
 * Pi carries most of that itself: a per-provider refresh failure is
 * collected, not thrown, and the overlay stays as it was. What it does not
 * carry: its fetch is unbounded, so the background refresh is bounded
 * here, and a bound that aborts the refresh cuts the availability pass
 * riding the same signal short - an empty model list - so that pass is
 * rebuilt offline below.
 *
 * A create that still rejects is an account-store fault (an unreadable auth
 * file, a broken models.json), not a catalog one: it propagates, because
 * swallowing it would hide a broken account behind a working-looking one.
 *
 * The overlay's CONTENT gets one correction here too: getModel serves defs
 * through withHonestReasoning (below), because a live def can claim
 * `reasoning: true` while its thinkingLevelMap pins no level to a provider
 * effort token - and Pi's openai-responses driver, which unlike
 * openai-completions has no supportsReasoningEffort gate, then passes the
 * session's thinking level through as `reasoningEffort` and the provider
 * fails the whole turn with a 400.
 */

/**
 * The bound on the background catalog refresh. Nothing waits on it: account
 * attachment awaits only the offline create, so an unreachable pi.dev costs
 * app start nothing.
 */
export const MODEL_REFRESH_TIMEOUT_MS = 30_000;

export type ModelRuntimeOptions = {
  authPath: string;
  modelsPath: string;
  /**
   * Where Pi keeps this runtime's pi.dev overlay cache. Defaults to
   * `models-store.json` beside `modelsPath`; a per-account runtime that
   * reads the app-scoped models.json names its own store here so the
   * overlay still lands per account (docs/architecture.md §16.3).
   */
  modelsStorePath?: string;
  /** Test seam: point the catalog overlay at a stand-in pi.dev. */
  catalogBaseUrl?: string;
  /** Called once the background refresh has settled, landed or not. */
  onCatalogRefreshed?: () => void;
  /** A connection-owned runtime reads no ambient credentials/config/catalog. */
  connectionProvider?: string;
  /** Only a connected Bedrock account can own this runtime. */
  bedrockAccount?: boolean;
  bedrockUrl?: string;
  bedrockRecheckPending?: () => boolean;
  bedrockProfileUnavailable?: (unavailable: boolean) => void;
};

/**
 * A def that says `reasoning: true` but whose thinkingLevelMap maps no level
 * to a provider effort token cannot actually accept a reasoning parameter,
 * so it is served as non-reasoning and no `reasoningEffort` ever reaches the
 * provider. The live pi.dev def for xai/grok-build-0.1 is the proven case:
 * `{ off: null, minimal: null }` on the openai-responses api, where Pi
 * treats every ABSENT key as pass-through and the provider 400s the whole
 * turn - "Model grok-build-0.1 does not support parameter reasoningEffort"
 * (captain dogfood 2026-09-01, twice, zero tokens served). A map with any
 * concrete token (grok-4.6's low/medium/high/xhigh) and a def with no map
 * at all (the widely working pass-through default) stay untouched. The
 * asymmetry is deliberate: wrongly suppressing an optional effort knob costs
 * a little quality, wrongly sending it hard-fails every turn on the model.
 */
export function withHonestReasoning<
  M extends { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap },
>(model: M): M {
  if (!model.reasoning || !model.thinkingLevelMap) return model;
  const usable = Object.values(model.thinkingLevelMap).some((value) => typeof value === "string");
  return usable ? model : { ...model, reasoning: false };
}

export async function createModelRuntime(options: ModelRuntimeOptions): Promise<ModelRuntime> {
  const base = {
    authPath: options.authPath,
    modelsPath: options.connectionProvider || options.bedrockAccount ? null : options.modelsPath,
    ...(options.connectionProvider
      ? { credentials: new InMemoryCredentialStore(), refreshOnCreate: false }
      : {}),
    ...(options.modelsStorePath ? { modelsStorePath: options.modelsStorePath } : {}),
    ...(options.catalogBaseUrl ? { catalogBaseUrl: options.catalogBaseUrl } : {}),
  };
  // Offline: the bundled catalog and this store's last overlay, no network.
  const runtime = await ModelRuntime.create({ ...base, allowModelNetwork: false });
  if (options.connectionProvider) connectionProviders.set(runtime, options.connectionProvider);
  const snapshot = runtime.getAvailableSnapshot.bind(runtime);
  const allows = (model: ModelDef) =>
    options.bedrockAccount
      ? model.provider === BEDROCK_PROVIDER_ID && model.api === "bedrock-converse-stream"
      : model.provider !== BEDROCK_PROVIDER_ID && model.api !== "bedrock-converse-stream";
  runtime.getAvailableSnapshot = () =>
    options.bedrockRecheckPending?.() ? [] : snapshot().filter(allows);
  if (options.bedrockAccount) {
    const stock = runtime.getProvider(BEDROCK_PROVIDER_ID);
    if (!stock) throw new Error("Amazon Bedrock models could not be loaded.");
    runtime.registerNativeProvider(
      bedrockAccountProvider(stock, options.bedrockUrl, options.bedrockProfileUnavailable),
    );
    await runtime.refresh({ allowNetwork: false, providers: [BEDROCK_PROVIDER_ID] });
  }
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = ((model, overrides) => {
    const provider = typeof model === "string" ? model : model.provider;
    if (Boolean(options.bedrockAccount) !== (provider === BEDROCK_PROVIDER_ID))
      return Promise.resolve(undefined);
    if (typeof model !== "string" && model.api === "bedrock-converse-stream") {
      if (
        !options.bedrockAccount ||
        !runtime.getAvailableSnapshot().some((checked) => checked.id === model.id)
      )
        return Promise.resolve(undefined);
    }
    return typeof model === "string" ? getAuth(model, overrides) : getAuth(model, overrides);
  }) as typeof runtime.getAuth;
  // Every session resolves its routed model through getModel, so this one
  // wrap is the request-parameter correction for the whole app.
  const getModel = runtime.getModel.bind(runtime);
  runtime.getModel = (providerId: string, modelId: string) => {
    if (options.connectionProvider && providerId !== options.connectionProvider) return undefined;
    const model = getModel(providerId, modelId);
    return model &&
      allows(model) &&
      (!options.bedrockAccount ||
        runtime.getAvailableSnapshot().some((checked) => checked.id === modelId))
      ? withHonestReasoning(model)
      : undefined;
  };
  // Pi starts refreshes of its own that nobody awaits (registering a
  // provider fires one), and it calls them through this property, so every
  // refresh this runtime runs is tracked here.
  const refresh = runtime.refresh?.bind(runtime);
  if (refresh)
    runtime.refresh = (refreshOptions) =>
      tracked(
        refresh(
          options.connectionProvider
            ? { ...refreshOptions, allowNetwork: false, providers: [options.connectionProvider] }
            : refreshOptions,
        ),
      );
  if (!options.connectionProvider && !options.bedrockAccount)
    void tracked(refreshInBackground(runtime, options.onCatalogRefreshed));
  return runtime;
}

/**
 * A runtime that only keeps Pi's live catalog for providers no account signs
 * in to, such as the catalog a custom connection's Reasoning profiles come
 * from (docs/custom-api.md). Pi fetches a provider's pi.dev catalog only
 * while it holds a credential for it, so `fetch` lends it a stand-in one:
 * the catalog request is unauthenticated and carries no key, and this
 * runtime never serves a model or sends a request to a provider. The
 * overlay it fetched is kept at `modelsStorePath`, so the next launch reads
 * it offline at once, and Pi's own 4h interval bounds how often it asks.
 */
export async function createCatalogRuntime(options: {
  modelsStorePath?: string;
  /** Test seam: point the catalog overlay at a stand-in pi.dev. */
  catalogBaseUrl?: string;
}): Promise<{
  runtime: ModelRuntime;
  fetch: (providers: readonly string[], stop?: AbortSignal) => Promise<void>;
}> {
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    // No models.json: the catalog stays Pi's own, never a person's config.
    modelsPath: options.modelsStorePath
      ? join(dirname(options.modelsStorePath), "catalog-only-models.json")
      : null,
    ...(options.modelsStorePath ? { modelsStorePath: options.modelsStorePath } : {}),
    ...(options.catalogBaseUrl ? { catalogBaseUrl: options.catalogBaseUrl } : {}),
    credentials,
    refreshOnCreate: true,
    allowModelNetwork: false,
  });
  runtime.getModel = () => undefined;
  runtime.getAuth = (async () => undefined) as ModelRuntime["getAuth"];
  const fetch = (providers: readonly string[], stop?: AbortSignal) =>
    tracked(
      (async () => {
        for (const provider of providers)
          await credentials.modify(
            provider,
            async (current) => current ?? { type: "api_key", key: "catalog-only" },
          );
        await runtime.refresh({
          providers: [...providers],
          signal: AbortSignal.any([
            AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS),
            ...(stop ? [stop] : []),
          ]),
        });
      })().catch(() => {
        // A failed or stopped refresh keeps the stored catalog; the next ask retries.
      }),
    );
  return { runtime, fetch };
}

/** The one provider a connection-owned runtime serves, read by `modelLookup`. */
const connectionProviders = new WeakMap<ModelRuntime, string>();

type ModelDef = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/**
 * `getModel` for a read that resolves many models at once. Pi's getModel
 * rebuilds the provider's whole catalog to find one model, so calling it
 * once per listed model costs the square of the catalog size; with
 * OpenRouter's 401 models that blocked the main process for seconds right
 * after a key sign-in (INF-803). This lists each provider's catalog once
 * and answers every lookup from it, with the same defs `getModel` serves:
 * the first match by id, corrected by withHonestReasoning, and nothing for
 * a provider a connection-owned runtime does not serve. Make one per read,
 * never keep it: the catalog grows when a refresh lands.
 */
export function modelLookup(
  runtime: ModelRuntime,
): (providerId: string, modelId: string) => ModelDef | undefined {
  const connectionProvider = connectionProviders.get(runtime);
  const byProvider = new Map<string, Map<string, ModelDef>>();
  return (providerId, modelId) => {
    if (connectionProvider && providerId !== connectionProvider) return undefined;
    let defs = byProvider.get(providerId);
    if (!defs) {
      defs = new Map();
      for (const model of runtime.getModels(providerId))
        if (!defs.has(model.id)) defs.set(model.id, model);
      byProvider.set(providerId, defs);
    }
    const model = defs.get(modelId);
    return model && withHonestReasoning(model);
  };
}

const refreshing = new Set<Promise<unknown>>();

function tracked<T>(work: Promise<T>): Promise<T> {
  refreshing.add(work);
  const settle = () => refreshing.delete(work);
  work.then(settle, settle);
  return work;
}

/**
 * Resolves once every catalog refresh any runtime started has settled. A
 * refresh writes the runtime's overlay store when it lands, so whoever
 * removes that store's directory (a test's scratch directory) waits here
 * first, or the late write puts the directory back.
 */
export async function catalogRefreshesSettled(): Promise<void> {
  while (refreshing.size > 0) await Promise.allSettled([...refreshing]);
}

/**
 * The pi.dev refresh, off every path that waits. Network is Pi's own call
 * (`PI_OFFLINE` switches it off, as e2e does). A bound that cut the refresh
 * short can leave the availability pass empty, so an emptied list is
 * rebuilt offline - the list may grow when the overlay lands, never shrink
 * because it did not.
 */
async function refreshInBackground(runtime: ModelRuntime, onRefreshed?: () => void): Promise<void> {
  const before = runtime.getAvailableSnapshot().length;
  try {
    await runtime.refresh({ signal: AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS) });
  } catch {
    // A failed refresh leaves the offline catalog; the next one retries.
  }
  if (before > 0 && runtime.getAvailableSnapshot().length === 0) {
    await runtime.refresh({ allowNetwork: false }).catch(() => undefined);
  }
  try {
    onRefreshed?.();
  } catch {
    // A listener's failure is its own; the catalog is already in place.
  }
}
