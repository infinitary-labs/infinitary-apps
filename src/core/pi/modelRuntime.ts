import { InMemoryCredentialStore, type ThinkingLevelMap } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

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
    modelsPath: options.connectionProvider ? null : options.modelsPath,
    ...(options.connectionProvider
      ? { credentials: new InMemoryCredentialStore(), refreshOnCreate: false }
      : {}),
    ...(options.modelsStorePath ? { modelsStorePath: options.modelsStorePath } : {}),
    ...(options.catalogBaseUrl ? { catalogBaseUrl: options.catalogBaseUrl } : {}),
  };
  // Offline: the bundled catalog and this store's last overlay, no network.
  const runtime = await ModelRuntime.create({ ...base, allowModelNetwork: false });
  // Every session resolves its routed model through getModel, so this one
  // wrap is the request-parameter correction for the whole app.
  const getModel = runtime.getModel.bind(runtime);
  runtime.getModel = (providerId: string, modelId: string) => {
    if (options.connectionProvider && providerId !== options.connectionProvider) return undefined;
    const model = getModel(providerId, modelId);
    return model && withHonestReasoning(model);
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
  if (!options.connectionProvider)
    void tracked(refreshInBackground(runtime, options.onCatalogRefreshed));
  return runtime;
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
