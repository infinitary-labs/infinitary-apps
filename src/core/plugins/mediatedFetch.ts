import type { MediatedFetchCall, MediatedFetchResult } from "@shared/plugins/fetch";

/**
 * The mediated fetch seam (D6): the core answer to a frame's `inf.fetch`.
 * It refuses every call and sends nothing. Per-plugin hosts and keys are
 * retired (the captain's principle, 2026-11-02, "Integrations reach every
 * surface the same way"): a panel reaches a service outside the captain's
 * projects only through an integration (`PanelProps.integrations`), so no
 * grant can name a host for this seam to serve. The channel and the
 * bridge's verb stay until a major contract change removes them
 * (`src/shared/contract-changes/README.md`).
 */

export type MediatedFetch = (call: MediatedFetchCall) => Promise<MediatedFetchResult>;

export const RETIRED_FETCH_WORDS =
  "a panel sends no request of its own: it reaches a service outside your projects through an integration it names in manifest.json";

export function createMediatedFetch(): MediatedFetch {
  return async () => ({
    ok: false,
    error: { code: "capability_not_granted", message: RETIRED_FETCH_WORDS },
  });
}
