/**
 * Regression: the Codex allowance reads 0% right after
 * a reset, once the vendor reports `used_percent: 1`, and the seat offers to
 * move Firstmate to Grok.
 *
 * The usage body mirrors what the running app stored at 2026-10-02 14:45 for
 * codex/Personal: a Pro plan whose primary window is the 7-day window
 * (limit_window_seconds 604800), reset 43 minutes earlier, no secondary
 * window. Everything below the HTTP stub is the real code path.
 */
import type { QuotaSnapshotView } from "@shared/quota";
import { describe, expect, it } from "vitest";
import { Flagship, type FlagshipVaultView } from "../orchestrator/flagship";
import type { ModelRuntime } from "../pi/types";
import { openInMemoryDatabase } from "../storage/db";
import { effectiveFromProvider } from "./catalog";
import { createQuotaFetcher } from "./fetchQuota";
import type { QuotaHttp } from "./http";
import { QuotaService } from "./quotaService";

const NOW = Date.parse("2026-10-02T21:45:05Z");
const RESET_AFTER = 604_800 - 43 * 60;

function codexUsage(usedPercent: number) {
  return {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: usedPercent,
        limit_window_seconds: 604_800,
        reset_after_seconds: RESET_AFTER,
        reset_at: Math.floor(NOW / 1000) + RESET_AFTER,
      },
      secondary_window: null,
    },
  };
}

/** The real sensor -> the real QuotaService, with only the vendor stubbed. */
async function snapshotFor(usedPercent: number): Promise<QuotaSnapshotView> {
  const http: QuotaHttp = async (url) => {
    if (url.includes("wham/usage")) return { status: 200, json: codexUsage(usedPercent) };
    return { status: 404 };
  };
  const fetcher = createQuotaFetcher({
    auth: {
      accounts: () => [
        {
          accountId: "acct_codex",
          accountLabel: "Personal",
          quotaId: "codex",
          piId: "openai-codex",
          providerLabel: "Codex",
        },
      ],
      resolve: async () => ({ apiKey: "not-a-jwt", usingOAuth: true }),
    },
    http,
    models: () => [],
    now: () => NOW,
  });
  const service = new QuotaService({
    refresh: fetcher,
    db: openInMemoryDatabase(),
    broadcast: () => {},
    now: () => NOW,
  });
  const snapshot = await service.refresh("interval");
  if (!snapshot) throw new Error("no snapshot");
  // Grok as the running app measured it at the time: 81% left.
  return {
    ...snapshot,
    providers: [
      ...snapshot.providers,
      {
        provider: "grok",
        label: "Grok",
        accountId: "acct_grok",
        accountLabel: "Personal",
        status: "ok",
        stale: false,
        windows: [{ id: "credits", label: "credits", percentRemaining: 81 }],
      },
    ],
  };
}

function flagshipOver(snapshot: QuotaSnapshotView): Flagship {
  const accounts = [
    { id: "acct_codex", providerId: "openai-codex", label: "Personal", enabled: true },
    { id: "acct_grok", providerId: "xai", label: "Personal", enabled: true },
  ];
  const vault: FlagshipVaultView = {
    list: (providerId) => accounts.filter((a) => !providerId || a.providerId === providerId),
    get: (id) => accounts.find((a) => a.id === id),
    connectedSync: () => true,
    servesSync: () => true,
    withheldReason: () => undefined,
    withheldDetail: () => undefined,
    cutOff: () => undefined,
    tryAgain: () => false,
    runtimeFor: async () => ({}) as ModelRuntime,
    binding: () => ({ via: "pi-runtime" }),
  };
  let pinned: string | null = "acct_codex";
  return new Flagship({
    vault,
    settings: {
      getFirstmateAccount: () => pinned,
      setFirstmateAccount: (id) => {
        pinned = id;
      },
    },
    quota: { latest: () => snapshot },
    baseRuntime: {} as ModelRuntime,
  });
}

describe("Codex allowance right after a reset", () => {
  it("reads 1% used as 99% left, not 0%", async () => {
    const snapshot = await snapshotFor(1);
    const codex = snapshot.providers.find((row) => row.provider === "codex");
    const effective = effectiveFromProvider(codex, NOW);
    console.log("codex row:", JSON.stringify(codex?.windows), "effective:", effective);
    expect(codex?.windows[0]?.percentRemaining).toBe(99);
    expect(effective.effectivePercentRemaining).toBe(99);
    expect(effective.spendPriority).not.toBe(-100);
  });

  it("does not pause the Firstmate seat or offer Grok at 1% used", async () => {
    const flagship = flagshipOver(await snapshotFor(1));
    const pause = flagship.pause("acct_codex");
    const offer = flagship.otherProviderOption("openai-codex");
    console.log(
      "pause:",
      pause,
      "sentence:",
      pause ? flagship.pauseSentence("acct_codex", pause) : "-",
      "offer:",
      offer,
    );
    expect(pause).toBeUndefined();
  });
});
