import type { QuotaProviderView, QuotaSnapshotView } from "@shared/quota";

// INF-443 acceptance, using INF-438's recorded 19%/84% readings, reset instants,
// $289.61 + $0.60 usage and the 24 finished-task costs reconstructed from its
// published scatter plot (0.1 pixel precision, not claimed as original ledger rows).
export const AT = Date.parse("2026-10-18T18:07:00Z");
export const FINISHED = [
  4.95, 8.37, 9, 10.17, 10.56, 14.22, 14.27, 17.83, 21.78, 22.9, 23.49, 23.68, 24.2, 24.34, 24.68,
  29.22, 36.95, 45.8, 57.39, 58.34, 73.29, 100.63, 101.56, 126.02,
];
export const GROK = { provider: "xai", id: "grok-4.7", name: "Grok" };
export const CODEX = { provider: "openai-codex", id: "gpt-6-sol", name: "Codex" };
export function row(provider = "grok", accountId = "mini-grok", remaining = 19): QuotaProviderView {
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
export function snapshot(at: number, providers: QuotaProviderView[]): QuotaSnapshotView {
  return { fetchedAt: at, generatedAt: new Date(at).toISOString(), providers };
}
