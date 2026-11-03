import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { CredentialHealthService } from "../accounts/credentialHealthService";
import { ClaudeAuthBackend } from "../claude/claudeAuth";
import { clearClaudeCredentialCache, readClaudeStore } from "../claude/claudeQuota";
import {
  acquireSessionLease,
  resetStoreLeasesForTest,
  runExclusiveStoreTask,
} from "../claude/claudeStoreLease";
import { managedFromClaudeStore } from "../quota/claudeAuthResolve";
import { createQuotaFetcher } from "../quota/fetchQuota";
import { openInMemoryDatabase } from "../storage/db";
import { QuotaService } from "./quotaService";

// INF-2320, accepted INF-2308 step 4: sessions renew, the reader follows the
// store, and only an idle vendor rejection asks the client once.
const databases: ReturnType<typeof openInMemoryDatabase>[] = [];

function fixture(renew = true) {
  const dir = scratchDir("infinitary-session-renewal-");
  const file = join(dir, ".credentials.json");
  let written = 100;
  const save = (accessToken: string) => {
    writeFileSync(
      file,
      JSON.stringify({
        claudeAiOauth: {
          accessToken,
          refreshToken: "fixture-refresh",
          expiresAt: 1000,
          subscriptionType: "max",
        },
      }),
    );
    utimesSync(file, ++written, written);
  };
  save("saved");
  const events: string[] = [];
  const ref = { providerId: "anthropic-claude", accountId: "acct_claude", dir };
  const readStore = () => readClaudeStore(dir, { env: { HOME: dir } });
  const backend = new ClaudeAuthBackend({
    available: () => true,
    configDir: () => dir,
    readStore: (_dir, options) => readClaudeStore(dir, { ...options, env: { HOME: dir } }),
    run: async (args) => {
      events.push(`client: ${args.join(" ")}`);
      if (renew && args.join(" ") === "auth status --json") save("fresh");
      return { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
    },
  });
  let accepted = "saved";
  const fetcher = createQuotaFetcher({
    auth: {
      accounts: () => [
        {
          ...ref,
          piId: ref.providerId,
          quotaId: "claude",
          providerLabel: "Claude",
          accountLabel: "Personal",
        },
      ],
      resolve: async () => managedFromClaudeStore(await readStore()).managed,
      renew: async () => {
        const result = await backend.renew(ref, "vendor_rejected");
        if (result.outcome !== "renewed") return result;
        const auth = managedFromClaudeStore(await readStore()).managed;
        return auth ? { outcome: "renewed", auth } : { outcome: "unreadable" };
      },
    },
    http: async (_url, init) => {
      const status = init.headers?.Authorization === `Bearer ${accepted}` ? 200 : 401;
      events.push(`allowance: ${status}`);
      return {
        status,
        json:
          status === 200
            ? { five_hour: { utilization: 20, resets_at: "2099-01-01T00:00:00Z" } }
            : {},
      };
    },
    models: () => [],
  });
  const db = openInMemoryDatabase();
  databases.push(db);
  const service = new QuotaService({ refresh: fetcher, db, broadcast: () => {} });
  return {
    dir,
    save,
    ref,
    backend,
    events,
    accept: (token: string) => {
      accepted = token;
    },
    read: async () => {
      const row = (await service.refresh("demand"))?.providers[0];
      if (!row) throw new Error("The sensor did not publish its account reading");
      // A new owner reads exactly the snapshot the sensor persisted.
      const restored = new QuotaService({ refresh: fetcher, db, broadcast: () => {} }).latest()
        ?.providers[0];
      expect(restored).toEqual(row);
      return row;
    },
  };
}

function evidence(scenario: string, events: string[], reading?: unknown) {
  if (process.env.INFINITARY_CLAUDE_RENEWAL_EVIDENCE === "1")
    console.log(JSON.stringify({ scenario, events, reading }));
}

beforeEach(() => {
  resetStoreLeasesForTest();
  clearClaudeCredentialCache();
});
afterEach(() => {
  clearClaudeCredentialCache();
  for (const db of databases.splice(0)) db.close();
});

describe("session-owned Claude renewal", () => {
  it("keeps the saved plan name without asking a refreshing status command", async () => {
    const f = fixture(false);
    expect(await f.backend.health(f.ref)).toMatchObject({
      state: "healthy",
      identity: { plan: "Max" },
    });
    expect(f.events).toEqual([]);
    expect(await f.backend.renew(f.ref, "proactive")).toEqual({ outcome: "unsupported" });
    expect(await f.backend.renew(f.ref, "remedy")).toEqual({ outcome: "unsupported" });
    expect(f.events).toEqual([]);
  });

  it("reads an accepted expired credential without a health-tick client request", async () => {
    const f = fixture(false);
    const health = new CredentialHealthService({
      host: {
        listEnabled: () => [f.ref],
        health: () => f.backend.health(f.ref),
        renew: (_id, reason) => f.backend.renew(f.ref, reason),
      },
    });
    await health.tick();
    await health.tick();
    const row = await f.read();
    evidence("accepted expired credential", f.events, row);
    expect(row.status).toBe("ok");
    expect(f.events).toEqual(["allowance: 200"]);
  });

  it("asks the idle client once after rejection and reads its replacement credential", async () => {
    const f = fixture();
    f.accept("fresh");
    const row = await f.read();
    evidence("idle rejection", f.events, row);
    expect(row).toMatchObject({ status: "ok", reason: "renewal_succeeded" });
    expect(f.events).toEqual(["allowance: 401", "client: auth status --json", "allowance: 200"]);
  });

  it("keeps an unchanged rejected credential stale after that one question", async () => {
    const f = fixture(false);
    f.accept("fresh");
    const row = await f.read();
    evidence("unchanged rejected credential", f.events, row);
    expect(row).toMatchObject({ status: "unavailable", reason: "renewal_unchanged" });
    expect(f.events).toEqual(["allowance: 401", "client: auth status --json"]);
  });

  it("rereads a live session's rewritten store without starting a second refresher", async () => {
    const f = fixture();
    f.accept("fresh");
    const release = await acquireSessionLease(f.dir);
    try {
      const during = await f.read();
      f.save("fresh");
      const after = await f.read();
      evidence("live session rewrites its store", f.events, { during, after });
      expect(during).toMatchObject({ status: "unavailable", reason: "renewal_deferred_session" });
      expect(after.status).toBe("ok");
      expect(f.events).toEqual(["allowance: 401", "allowance: 200"]);
    } finally {
      release();
    }
  });

  it("does not wait behind a login to ask the idle client", async () => {
    const f = fixture();
    f.accept("fresh");
    let release!: () => void;
    const login = runExclusiveStoreTask(
      f.dir,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      const row = await f.read();
      evidence("login slot occupied", f.events, row);
      expect(row).toMatchObject({ status: "unavailable", reason: "renewal_deferred_busy" });
      expect(f.events).toEqual(["allowance: 401"]);
    } finally {
      release();
      await login;
    }
  });
});
