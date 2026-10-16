import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { renewClaudeQuotaAuth } from "../claude/claudeQuota";
import {
  acquireSessionLease,
  resetStoreLeasesForTest,
  tryExclusiveStoreTask,
} from "../claude/claudeStoreLease";
import { openInMemoryDatabase } from "../storage/db";
import type { QuotaAuth } from "./auth";
import { createQuotaFetcher } from "./fetchQuota";
import type { QuotaHttp } from "./http";
import { QuotaService } from "./quotaService";

/**
 * Can the app starve its OWN recovery?
 *
 * A live MacBook tick came back `unavailable` / `renewal_deferred`, which
 * raised the question this file answers: the sign-in status probe and the
 * quota renewal both want the same account's credential store, so ordinary
 * app activity - not a crewmate session, just the app's own routine polling -
 * could stand a renewal down. If that can happen repeatedly, a 401 never gets
 * its delegated renewal and routine expiry never self-heals, which is the
 * whole point of the change.
 *
 * These drive the REAL interfaces end to end: the real store lease, the real
 * `renewClaudeQuotaAuth`, the real `createQuotaFetcher`, and the real
 * `QuotaService` refresh, with the status probe represented by the same
 * `tryExclusiveStoreTask` call the real probe makes (`claudeAuth.ts:164`).
 */

const credentialJson = (accessToken: string, expiresAt: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });

function storeDir(token = "expired"): string {
  const dir = scratchDir("infinitary-renewal-sched-");
  writeFileSync(join(dir, ".credentials.json"), credentialJson(token, 1000));
  return dir;
}

const CLAUDE_ACCOUNT = {
  accountId: "acct_claude",
  accountLabel: "Personal",
  quotaId: "claude" as const,
  piId: "anthropic-claude",
  providerLabel: "Claude",
};

const USAGE = { five_hour: { utilization: 20, resets_at: "2099-01-01T00:00:00Z" } };

/**
 * The app as it really runs: the vendor rejects whatever is in the store until
 * a delegated renewal rewrites it, and the renewal goes through the real
 * lease-aware path.
 */
function appUnderTest(dir: string, accepted: { token: string }) {
  const clientRuns: string[] = [];
  const auth: QuotaAuth = {
    accounts: () => [CLAUDE_ACCOUNT],
    resolve: async () => {
      const raw = JSON.parse(
        require("node:fs").readFileSync(join(dir, ".credentials.json"), "utf8"),
      ) as { claudeAiOauth: { accessToken: string } };
      return { apiKey: raw.claudeAiOauth.accessToken, usingOAuth: true };
    },
    renew: async () => {
      const result = await renewClaudeQuotaAuth(dir, {
        run: async (configDir, args) => {
          clientRuns.push(args.join(" "));
          writeFileSync(join(configDir, ".credentials.json"), credentialJson("renewed", 9e15));
        },
        now: () => 2000,
      });
      return result.outcome === "renewed"
        ? {
            outcome: "renewed" as const,
            auth: { apiKey: result.auth.accessToken, usingOAuth: true },
          }
        : { outcome: result.outcome };
    },
  };
  const http: QuotaHttp = async (_url, init) =>
    (init.headers?.Authorization ?? "").includes(accepted.token)
      ? { status: 200, json: USAGE }
      : { status: 401, json: {} };
  return { auth, http, clientRuns };
}

describe("the app's own scheduling must not starve its own renewal", () => {
  beforeEach(() => {
    resetStoreLeasesForTest();
  });

  it("renews on the stock refresh tick even while the status probe keeps polling", async () => {
    const dir = storeDir();
    const { auth, http, clientRuns } = appUnderTest(dir, { token: "renewed" });
    const db = openInMemoryDatabase();
    const service = new QuotaService({
      refresh: createQuotaFetcher({ auth, http, models: () => [] }),
      db,
      broadcast: () => {},
    });

    // The status probe as the app really makes it: a one-shot exclusive claim,
    // repeated on its own cadence, entirely independent of the quota tick.
    let probing = true;
    const probes = (async () => {
      while (probing) {
        await tryExclusiveStoreTask(dir, async () => {
          await new Promise((resolve) => setTimeout(resolve, 3));
        });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();

    // Several stock ticks, exactly as the interval fires them.
    const rows = [];
    for (let tick = 0; tick < 5; tick += 1) {
      const snapshot = await service.refresh("interval");
      rows.push(snapshot?.providers[0]);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    probing = false;
    await probes;

    // Recovery must actually happen: routine probing may delay a renewal, it
    // may never prevent one.
    expect(clientRuns.length).toBeGreaterThan(0);
    const recovered = rows.find((row) => row?.status === "ok");
    expect(
      recovered,
      `no tick recovered; saw ${rows.map((r) => r?.reason).join(", ")}`,
    ).toBeDefined();
    expect(recovered).toMatchObject({ reason: "renewal_succeeded" });
    // And it recovers on the FIRST tick: a probe is not a reason to give up.
    expect(rows[0]).toMatchObject({ status: "ok", reason: "renewal_succeeded" });
  });

  it("a probe holding the store delays the tick's renewal instead of cancelling it", async () => {
    const dir = storeDir();
    const { auth, http, clientRuns } = appUnderTest(dir, { token: "renewed" });
    const fetcher = createQuotaFetcher({ auth, http, models: () => [] });

    // A probe is in flight, and stays in flight while the tick wants the store.
    let releaseProbe: (() => void) | undefined;
    const probe = tryExclusiveStoreTask(dir, async () => {
      await new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
    });
    await Promise.resolve();
    const pending = fetcher();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The tick has reached the store and found it busy. It is WAITING - it has
    // neither run the client nor given up on the account.
    expect(clientRuns).toHaveLength(0);
    releaseProbe?.();
    await probe;

    const { snapshot } = await pending;
    expect(clientRuns).toHaveLength(1);
    expect(snapshot.providers[0]).toMatchObject({ status: "ok", reason: "renewal_succeeded" });
  });

  it("stands down for a live session, and recovers on the next tick once it ends", async () => {
    const dir = storeDir();
    const { auth, http, clientRuns } = appUnderTest(dir, { token: "renewed" });
    const fetcher = createQuotaFetcher({ auth, http, models: () => [] });

    const release = await acquireSessionLease(dir);
    const during = (await fetcher()).snapshot.providers[0];
    expect(during).toMatchObject({ status: "unavailable", reason: "renewal_deferred_session" });
    expect(clientRuns).toHaveLength(0);

    // The crewmate finished. Standing down was transient, not a dead end.
    release();
    const after = (await fetcher()).snapshot.providers[0];
    expect(after).toMatchObject({ status: "ok", reason: "renewal_succeeded" });
    expect(clientRuns).toHaveLength(1);
  });
});
