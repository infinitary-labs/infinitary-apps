import type { MediatedFetchCall, MediatedFetchResult } from "@shared/plugins/fetch";
import type { NetOriginGrant } from "@shared/plugins/manifest";

/**
 * The mediated fetch service (D6, proposal section 5.1): the one place an
 * installable plugin's outbound request would be performed on its behalf,
 * with the host attaching the credential and the plugin never holding it.
 * Born here, beside quota/http.ts (the proven credentialed-request pattern
 * it will reuse), so the trust boundary is in the core from the first day
 * a frame can utter `inf.fetch` - the renderer forwards the verb and never
 * decides it (proposal section 7.5, "must not foreclose").
 *
 * Phase 1 serves NO grant: `grants` answers nothing for every plugin, so
 * every call is refused with `capability_not_granted` and no request is
 * ever made. The executor - resolving the alias to its origin, refusing
 * private addresses at resolution time, attaching the secret slot,
 * enforcing NET_BOUNDS, following no redirect off the allowlist - is
 * phase 3's addition behind the same `MediatedFetch` signature, gated on a
 * concrete want (docs/ui-plugins.md).
 */

/** The served grants for one plugin: alias to its resolved origin grant. */
export type ServedNetGrants = Readonly<Record<string, NetOriginGrant>>;

export type MediatedFetchOptions = {
  /** Which net grants the host actually serves a plugin; undefined is none. */
  grants: (pluginId: string) => ServedNetGrants | undefined;
};

export type MediatedFetch = (call: MediatedFetchCall) => Promise<MediatedFetchResult>;

export function createMediatedFetch(options: MediatedFetchOptions): MediatedFetch {
  return async (call) => {
    const grant = options.grants(call.pluginId)?.[call.alias];
    if (!grant) {
      return {
        ok: false,
        error: {
          code: "capability_not_granted",
          message: `plugin "${call.pluginId}" holds no net grant for "${call.alias}"`,
        },
      };
    }
    if (!grant.methods.includes(call.request.method)) {
      return {
        ok: false,
        error: {
          code: "method_not_granted",
          message: `"${call.alias}" grants ${grant.methods.join("/")}, not ${call.request.method}`,
        },
      };
    }
    // Phase 3: resolve the origin (or the user-supplied host), attach the
    // secret slot, and perform the bounded request. Until then a grant
    // cannot exist, because no host serves one.
    return {
      ok: false,
      error: {
        code: "capability_not_granted",
        message: "outbound requests are not served by this build",
      },
    };
  };
}

/** Phase 1: no plugin holds a served net grant. */
export const noNetGrants: MediatedFetchOptions["grants"] = () => undefined;
