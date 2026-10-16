import type { ProviderView } from "@shared/providers";
import { PROVIDER_CATALOG } from "@shared/providers";
import type { AccountBackend } from "./accountBackend";

/**
 * The provider rows the Subscriptions tab renders. Pi-served providers get
 * their auth methods from Pi's own catalog; every other provider gets them
 * from its backend. The row itself is the same either way, which is the
 * point: the user sees a subscription and its accounts, and nothing about
 * which client Infinitary runs to reach it.
 */

export type ProviderViewSources = {
  /** Pi's view of the providers it serves; absent ids are simply not shown. */
  piProviders: () => ProviderView[];
  /** Registered backends by id, for the non-Pi rows. */
  backends: Map<string, AccountBackend>;
  /**
   * The vault's accounts, which decide a non-Pi row's connected state.
   * `connected: undefined` means not checked yet - the row reads as not
   * connected until a status read says otherwise, never the reverse.
   */
  accounts: () => { providerId: string; connected: boolean | undefined }[];
};

export function buildProviderViews(sources: ProviderViewSources): ProviderView[] {
  const piViews = new Map(sources.piProviders().map((view) => [view.id, view]));
  const accounts = sources.accounts();
  const views: ProviderView[] = [];
  for (const entry of PROVIDER_CATALOG) {
    if (entry.backend === "pi") {
      const view = piViews.get(entry.id);
      if (view) views.push(view);
      continue;
    }
    const backend = sources.backends.get(entry.backend);
    if (!backend) continue;
    const authTypes = backend.authTypes(entry.id);
    // A backend with no way to sign in is listed only when it can say why
    // (a client the person installs, F14) - the chip then renders disabled
    // with the words. Otherwise a row whose only button cannot work would
    // be worse than none.
    const unavailable = authTypes.length === 0 ? backend.unavailable?.(entry.id) : undefined;
    if (authTypes.length === 0 && !unavailable) continue;
    const owned = accounts.filter((account) => account.providerId === entry.id);
    const connected = owned.some((account) => account.connected === true);
    views.push({
      id: entry.id,
      name: entry.name,
      tier: entry.tier,
      authTypes,
      ...(unavailable ? { unavailable } : {}),
      connected,
      ...(connected ? { activeAuthType: "oauth" as const } : {}),
      // Subscriptions bill by plan window, not per token (D-18).
      billedPerToken: false,
    });
  }
  return views;
}
