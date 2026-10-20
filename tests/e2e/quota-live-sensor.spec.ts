import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { claudeWindowLabel } from "../../src/core/quota/providers/claude";
import { COPILOT_PLAN, COPILOT_PREMIUM_LABEL } from "../../src/core/quota/providers/copilot";
import {
  GROK_CREDITS_LABEL,
  GROK_NO_WINDOW_DETAIL,
  GROK_PRODUCT_LABELS,
} from "../../src/core/quota/providers/grok";
import { KIMI_NO_WINDOW_DETAIL } from "../../src/core/quota/providers/kimi";
import {
  CLAUDE_FIRST_RUN_TEXT,
  EMPTY_QUOTA_TEXT,
} from "../../src/renderer/src/settings/subscriptionsWords";
import { needsReauthCopy } from "../../src/shared/credentialHealth";
import { catalogEntry, providerSignInNote } from "../../src/shared/providers";
import { scratchDir } from "../helpers/scratchDirs";
import { consumerConfigMessage, grpcWebOkBody } from "../support/grpcWebEncoder";
import { type LaunchedApp, launchApp } from "./launch";
import { claudeDefaultStore, writeMockClaudeClient } from "./mockClaudeClient";

/**
 * The one e2e that does NOT use the quota fixture seam.
 *
 * Every other quota spec injects a finished snapshot straight into
 * QuotaService, which means the whole credential-and-request layer -
 * `QuotaAuth.resolve`, `resolveClaudeQuotaAuth`, the provider fetchers, the
 * delegated renewal, the status vocabulary - had no end-to-end coverage at
 * all. That is how two provider defects reached the captain's Settings twice.
 *
 * So this one runs the REAL `createQuotaFetcher` against a local stub of the
 * vendor's usage endpoint, and walks the whole path: resolve the account's own
 * store -> fetch -> parse -> snapshot -> IPC -> render. The only thing
 * redirected is the endpoint's address (a dev/e2e-gated override the packaged
 * app refuses to read); the credential store, the resolver and the renewal are
 * the app's own.
 */

const CLAUDE_PERSONAL = "acct_claude_live";
const GROK_PERSONAL = "acct_grok_live";
const KIMI_PERSONAL = "acct_kimi_live";
/** An unreleased vendor codename the usage stub answers with beside its real windows. */
const UNRELEASED_WINDOW = "nimbus_quill";
/** The Grok product whose own window the credits stub reports. */
const GROK_BUILD_PRODUCT = 2;

/** A store the resolver can read with no Keychain and no macOS ask. */
function seedClaudeCredentialFile(
  accountDir: string,
  accessToken: string,
  expiresAt: number,
  refreshTokenExpiresAt = expiresAt + 30 * 24 * 3600 * 1000,
) {
  mkdirSync(accountDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(accountDir, "stub-credential"), "stub", { mode: 0o600 });
  writeFileSync(
    join(accountDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken: "stub-refresh",
        expiresAt,
        refreshTokenExpiresAt,
        subscriptionType: "max",
      },
    }),
    { mode: 0o600 },
  );
}

type StubUsage = {
  server: Server;
  url: string;
  /** Bearer tokens the stub will answer with a real reading. */
  accept: Set<string>;
  seen: string[];
  status: number;
};

async function startStubUsage(accept: string[]): Promise<StubUsage> {
  const stub: StubUsage = {
    server: createServer(),
    url: "",
    accept: new Set(accept),
    seen: [],
    status: 200,
  };
  stub.server.on("request", (request, response) => {
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    stub.seen.push(bearer);
    if (!stub.accept.has(bearer)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error" }));
      return;
    }
    const resetsAt = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    response.writeHead(stub.status, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        // The vendor's real shape: `limits` is authoritative, unreleased
        // codenames sit beside it at the top level, and a switched-off
        // extra-usage block must not become a meter.
        five_hour: { utilization: 30, resets_at: resetsAt },
        [UNRELEASED_WINDOW]: { utilization: 0, resets_at: resetsAt },
        extra_usage: { is_enabled: false, utilization: 0 },
        limits: [
          { kind: "session", group: "session", percent: 30, resets_at: resetsAt },
          { kind: "weekly_all", group: "weekly", percent: 10, resets_at: resetsAt },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/api/oauth/usage`;
  return stub;
}

type StubMeter = {
  server: Server;
  url: string;
  /** Bearer tokens the stub answers with a real config. */
  accept: Set<string>;
  seen: { bearer: string; contentType: string; body: number[] }[];
};

/**
 * A stand-in for the vendor's consumer credits meter: a gRPC-web unary
 * endpoint that answers the empty request with a framed config message -
 * the exact wire shape captured live on 2026-09-05 - and refuses any other
 * bearer with the vendor's UNAUTHENTICATED verdict in a trailer.
 */
async function startStubMeter(accept: string[]): Promise<StubMeter> {
  const stub: StubMeter = { server: createServer(), url: "", accept: new Set(accept), seen: [] };
  stub.server.on("request", (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      stub.seen.push({
        bearer,
        contentType: request.headers["content-type"] ?? "",
        body: Array.from(Buffer.concat(chunks)),
      });
      response.writeHead(stub.accept.has(bearer) ? 200 : 401, {
        "content-type": "application/grpc-web+proto",
      });
      if (!stub.accept.has(bearer)) {
        response.end();
        return;
      }
      const nowSeconds = Math.floor(Date.now() / 1000);
      response.end(
        Buffer.from(
          grpcWebOkBody(
            consumerConfigMessage({
              percentUsed: 25,
              products: [{ product: GROK_BUILD_PRODUCT, percentUsed: 25 }],
              periodType: 2,
              periodStartSeconds: nowSeconds - 2 * 86_400,
              periodEndSeconds: nowSeconds + 5 * 86_400,
              prepaidBalance: 0,
            }),
          ),
        ),
      );
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig`;
  return stub;
}

/**
 * A Grok account the way the vault stores one: Pi's own auth file in the
 * account's 0700 store, holding an OAuth entry the runtime resolves without
 * a network round trip because it has not expired.
 */
function seedGrokAccount(userDataDir: string, accessToken: string) {
  const accountsDir = join(userDataDir, "accounts");
  const dir = join(accountsDir, "xai", GROK_PERSONAL);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      xai: {
        type: "oauth",
        access: accessToken,
        refresh: "stub-refresh",
        expires: Date.now() + 30 * 24 * 3600 * 1000,
      },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(accountsDir, "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: GROK_PERSONAL,
          providerId: "xai",
          kind: "subscription_oauth",
          label: "Personal",
          enabled: true,
          createdAt: Date.parse("2026-08-01T00:00:00Z"),
        },
      ],
      pins: {},
    }),
    { mode: 0o600 },
  );
}

type StubKimi = {
  server: Server;
  /** The usages meter's address. */
  url: string;
  /** The sign-in server's address, for Pi's own refresh. */
  oauthHost: string;
  /** Bearer tokens the meter answers with a reading. */
  accept: Set<string>;
  meterSeen: string[];
  refreshSeen: number;
};

/**
 * A stand-in for Kimi Code's two hosts: the usages meter, answering an
 * accepted bearer with the ratio-pool shape CodexBar 0.78.1 records for it,
 * and the sign-in server, refusing every refresh the way it refuses a
 * lapsed refresh token (401, `invalid_grant`).
 */
async function startStubKimi(accept: string[]): Promise<StubKimi> {
  const stub: StubKimi = {
    server: createServer(),
    url: "",
    oauthHost: "",
    accept: new Set(accept),
    meterSeen: [],
    refreshSeen: 0,
  };
  stub.server.on("request", (request, response) => {
    request.resume();
    request.on("end", () => {
      if (request.url === "/api/oauth/token") {
        stub.refreshSeen += 1;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      stub.meterSeen.push(bearer);
      if (!stub.accept.has(bearer)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      const at = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          usages: {
            limit_5h: { used_ratio: 0.3, reset_time: at(3) },
            limit_7d: { used_ratio: 0.1, reset_time: at(5 * 24) },
            limit_month_total: { used_ratio: 0.05, reset_time: at(20 * 24) },
          },
          user: { membership: { level: "LEVEL_INTERMEDIATE" } },
          version: "GOODS_VERSION_V1",
        }),
      );
    });
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/coding/v1/usages`;
  stub.oauthHost = `http://127.0.0.1:${port}`;
  return stub;
}

/**
 * A Kimi Code account the way the vault stores one: Pi's own auth file in
 * the account's store, holding Pi's device-code credential. `expires` in the
 * past is an account stored before Kimi Code came back, its token long lapsed.
 */
function seedKimiAccount(userDataDir: string, accessToken: string, expires: number) {
  const accountsDir = join(userDataDir, "accounts");
  const dir = join(accountsDir, "kimi-coding", KIMI_PERSONAL);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      "kimi-coding": { type: "oauth", access: accessToken, refresh: "stub-refresh", expires },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(accountsDir, "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: KIMI_PERSONAL,
          providerId: "kimi-coding",
          kind: "subscription_oauth",
          label: "Personal",
          enabled: true,
          createdAt: Date.parse("2026-08-01T00:00:00Z"),
        },
      ],
      pins: {},
    }),
    { mode: 0o600 },
  );
}

const COPILOT_LIVE = "acct_copilot_live";
const COPILOT_LAPSED = "acct_copilot_lapsed";

type StubCopilot = { server: Server; url: string; seen: string[] };

/**
 * A stand-in for GitHub's `copilot_internal/user`: it answers a paid seat's
 * reading (premium requests metered, chat and completions unlimited, the
 * shape CodexBar's reader decodes) for the one GitHub sign-in it knows, and
 * GitHub's 401 for any other.
 */
async function startStubCopilot(accept: string): Promise<StubCopilot> {
  const stub: StubCopilot = { server: createServer(), url: "", seen: [] };
  stub.server.on("request", (request, response) => {
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    stub.seen.push(bearer);
    if (bearer !== accept) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Bad credentials" }));
      return;
    }
    const reset = new Date();
    reset.setUTCMonth(reset.getUTCMonth() + 1, 1);
    const unlimited = (quota_id: string) => ({
      entitlement: 0,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 100,
      quota_id,
      quota_remaining: 0,
      remaining: 0,
      unlimited: true,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        access_type_sku: "monthly_subscriber_quota",
        chat_enabled: true,
        copilot_plan: "individual",
        quota_reset_date: reset.toISOString().slice(0, 10),
        quota_snapshots: {
          chat: unlimited("chat"),
          completions: unlimited("completions"),
          premium_interactions: {
            entitlement: 300,
            overage_count: 0,
            overage_permitted: false,
            percent_remaining: 62,
            quota_id: "premium_interactions",
            quota_remaining: 186,
            remaining: 186,
            unlimited: false,
          },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const { port } = stub.server.address() as AddressInfo;
  stub.url = `http://127.0.0.1:${port}/copilot_internal/user`;
  return stub;
}

/**
 * Two Copilot accounts the way Pi stored them before Copilot left the
 * catalog: Pi's own auth file holding the GitHub sign-in (`refresh`) and an
 * unexpired Copilot token, so nothing reaches GitHub to renew it.
 */
function seedCopilotAccounts(userDataDir: string, signIns: Record<string, string>) {
  const accountsDir = join(userDataDir, "accounts");
  for (const [id, githubToken] of Object.entries(signIns)) {
    const dir = join(accountsDir, "github-copilot", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        "github-copilot": {
          type: "oauth",
          refresh: githubToken,
          access: "tid=stub;exp=4000000000;proxy-ep=proxy.individual.githubcopilot.com",
          expires: Date.now() + 30 * 24 * 3600 * 1000,
        },
      }),
      { mode: 0o600 },
    );
  }
  writeFileSync(
    join(accountsDir, "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: Object.keys(signIns).map((id, index) => ({
        id,
        providerId: "github-copilot",
        kind: "subscription_oauth",
        label: index === 0 ? "Personal" : "Old work",
        enabled: true,
        createdAt: Date.parse("2026-08-01T00:00:00Z") + index,
      })),
      pins: {},
    }),
    { mode: 0o600 },
  );
}

function seedAccounts(userDataDir: string) {
  const accountsDir = join(userDataDir, "accounts");
  mkdirSync(join(accountsDir, "anthropic-claude", CLAUDE_PERSONAL), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(accountsDir, "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: CLAUDE_PERSONAL,
          providerId: "anthropic-claude",
          kind: "subscription_oauth",
          label: "Personal",
          enabled: true,
          createdAt: Date.parse("2026-08-01T00:00:00Z"),
        },
      ],
      pins: {},
    }),
    { mode: 0o600 },
  );
}

function seedClaudeHome(accessToken: string, expiresAt: number, refreshTokenExpiresAt?: number) {
  return (homeDir: string) =>
    seedClaudeCredentialFile(
      claudeDefaultStore(homeDir),
      accessToken,
      expiresAt,
      refreshTokenExpiresAt ?? expiresAt + 30 * 24 * 3600 * 1000,
    );
}

/**
 * One provider's row from the newest persisted snapshot, read the same
 * read-only way a live validation on a real machine reads it. The snapshot IS
 * the app's per-refresh record: a sanitized status and reason code, and never
 * anything a credential could be recovered from.
 */
function readNewestSnapshotRow(
  userDataDir: string,
  provider: string,
): { status: string; reason?: string } | undefined {
  const db = new Database(join(userDataDir, "firstmate.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT json FROM quota_snapshots ORDER BY id DESC LIMIT 1").get() as
      | { json: string }
      | undefined;
    if (!row) return undefined;
    const snapshot = JSON.parse(row.json) as {
      providers: { provider: string; status: string; reason?: string }[];
    };
    return snapshot.providers.find((entry) => entry.provider === provider);
  } finally {
    db.close();
  }
}

async function openSubscriptions(app: LaunchedApp) {
  await app.page.getByRole("button", { name: "Settings" }).click();
  await app.page.getByRole("tab", { name: "Intelligence" }).click();
}

/** An account's row in Settings → Intelligence, where its allowance shows. */
function accountRow(app: LaunchedApp, accountId: string) {
  return app.page.locator(`[data-account-row="${accountId}"]`);
}

test.describe("the real quota sensor, end to end", () => {
  let app: LaunchedApp | undefined;
  let stub: StubUsage | undefined;
  let meter: StubMeter | undefined;
  let kimi: StubKimi | undefined;
  let copilot: StubCopilot | undefined;

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    // Only a started server can report its close; awaiting an absent one
    // would wait forever.
    for (const server of [stub?.server, meter?.server, kimi?.server, copilot?.server]) {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    stub = undefined;
    meter = undefined;
    kimi = undefined;
    copilot = undefined;
  });

  test("resolves the account's own store, reads the vendor, and renders real meters", async () => {
    const userDataDir = scratchDir("infinitary-e2e-");
    stub = await startStubUsage(["live-token"]);
    seedAccounts(userDataDir);
    app = await launchApp({
      userDataDir,
      prepareHome: seedClaudeHome("live-token", Date.now() + 3600_000),
      env: {
        INFINITARY_CLAUDE_USAGE_URL: stub.url,
        INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "bin")),
      },
    });
    await openSubscriptions(app);
    const row = accountRow(app, CLAUDE_PERSONAL);

    // A real reading, parsed from the vendor's own `limits` shape.
    await expect(row.getByText(claudeWindowLabel("five_hour"), { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByText(EMPTY_QUOTA_TEXT.notYet)).toHaveCount(0);
    await expect(row.getByText(EMPTY_QUOTA_TEXT.unread)).toHaveCount(0);
    // An unreleased vendor codename is never rendered as a meter.
    await expect(row.getByText(claudeWindowLabel(UNRELEASED_WINDOW))).toHaveCount(0);
    // The request really carried the account's own stored token.
    expect(stub.seen).toContain("live-token");
  });

  test("an expired token recovers through the account's own client, with no sign-in", async () => {
    const userDataDir = scratchDir("infinitary-e2e-");
    // The vendor accepts only what the client will write during renewal.
    stub = await startStubUsage(["renewed-token"]);
    seedAccounts(userDataDir);
    const binDir = join(userDataDir, "bin");
    const client = writeMockClaudeClient(binDir);
    // The stand-in client renews the way the real one does: it rewrites the
    // store it owns, and Infinitary never speaks the vendor's OAuth itself. It
    // renews on `doctor` and not on `auth status`, which also exercises the
    // ladder: the code does not presume WHICH supported command renews, it
    // walks them and stops at the one that actually changes the store.
    writeFileSync(
      join(binDir, "renewing-claude.mjs"),
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const home = process.env.HOME;
const dir = process.env.CLAUDE_CONFIG_DIR || (home ? join(home, ".claude") : undefined);
const args = process.argv.slice(2);
if (dir && args[0] === "doctor") {
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
    claudeAiOauth: {
      accessToken: "renewed-token",
      refreshToken: "stub-refresh-2",
      expiresAt: Date.now() + 3600000,
      refreshTokenExpiresAt: Date.now() + 30 * 24 * 3600000,
      subscriptionType: "max",
    },
  }), { mode: 0o600 });
}
const run = spawnSync(process.execPath, [${JSON.stringify(client)}, ...args], { stdio: "inherit" });
process.exit(run.status ?? 0);
`,
      { mode: 0o755 },
    );
    app = await launchApp({
      userDataDir,
      prepareHome: seedClaudeHome("expired-token", Date.now() - 3600_000),
      env: {
        INFINITARY_CLAUDE_USAGE_URL: stub.url,
        INFINITARY_CLAUDE_CLI: join(binDir, "renewing-claude.mjs"),
      },
    });
    await openSubscriptions(app);
    const row = accountRow(app, CLAUDE_PERSONAL);

    await expect(row.getByText(claudeWindowLabel("five_hour"), { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // Routine expiry recovered on its own: the rejected token was renewed
    // through the account's own client and the retry landed.
    expect(stub.seen).toContain("expired-token");
    expect(stub.seen).toContain("renewed-token");
    await expect(row.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toHaveCount(0);
    // And the recovery left its positive trace in the persisted snapshot -
    // read here exactly the way a live validation reads it, because an `ok`
    // row with no marker is indistinguishable from plain network recovery.
    const claudeRow = readNewestSnapshotRow(userDataDir, "claude");
    expect(claudeRow).toMatchObject({ status: "ok", reason: "renewal_succeeded" });
  });

  test("a lapsed refresh token is needs_reauth: card, CTA, and no vendor call", async () => {
    const userDataDir = scratchDir("infinitary-e2e-");
    stub = await startStubUsage(["lapsed-token"]);
    seedAccounts(userDataDir);
    app = await launchApp({
      userDataDir,
      prepareHome: seedClaudeHome("lapsed-token", Date.now() + 3600_000, Date.now() - 1000),
      env: {
        INFINITARY_CLAUDE_USAGE_URL: stub.url,
        INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "bin")),
      },
    });

    await expect
      .poll(async () =>
        app?.page.evaluate(async () => {
          const cards = await window.infinitary.cards.list();
          return cards.map((card) => ({
            title: card.title,
            effects: card.actions.map((action) => action.effect),
          }));
        }),
      )
      .toContainEqual(
        expect.objectContaining({
          title: needsReauthCopy("Claude", "Personal"),
          // The one-step restore is the host's own effect, carrying the
          // account (cards/tasks/agents P1: the id is a name).
          effects: [{ kind: "host", op: "restore-account", arg: "acct_claude_live" }],
        }),
      );
    await expect(app.page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await openSubscriptions(app);
    const row = accountRow(app, CLAUDE_PERSONAL);
    await expect(row.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(row.getByText(CLAUDE_FIRST_RUN_TEXT)).toHaveCount(0);
    expect(stub.seen).toEqual([]);
    const claudeRow = readNewestSnapshotRow(userDataDir, "claude");
    expect(claudeRow).toMatchObject({ status: "auth_required", reason: "refresh_token_lapsed" });
  });

  test("a vendor that stays down never invents a reading and never claims a sign-out", async () => {
    const userDataDir = scratchDir("infinitary-e2e-");
    // Nothing is accepted, and the client renews nothing: every attempt fails.
    stub = await startStubUsage([]);
    seedAccounts(userDataDir);
    app = await launchApp({
      userDataDir,
      prepareHome: seedClaudeHome("dead-token", Date.now() + 3600_000),
      env: {
        INFINITARY_CLAUDE_USAGE_URL: stub.url,
        INFINITARY_CLAUDE_CLI: writeMockClaudeClient(join(userDataDir, "bin")),
      },
    });
    await openSubscriptions(app);
    const row = accountRow(app, CLAUDE_PERSONAL);

    // The stand-in client rewrites nothing, so the renewal changed nothing:
    // that is not knowing, and it must not read as a finished sign-in.
    await expect(row.getByText(EMPTY_QUOTA_TEXT.unread)).toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toHaveCount(0);
    // Not knowing is never rendered as a number.
    await expect(row.getByText("%", { exact: false })).toHaveCount(0);
    // The persisted row says WHICH kind of not-knowing it was, and does not
    // claim a renewal that never worked.
    const claudeRow = readNewestSnapshotRow(userDataDir, "claude");
    expect(claudeRow?.status).toBe("unavailable");
    expect(claudeRow?.reason).toMatch(/^renewal_/);
    expect(claudeRow?.reason).not.toBe("renewal_succeeded");
    const titles = await app.page.evaluate(async () =>
      (await window.infinitary.cards.list()).map((card) => card.title),
    );
    expect(titles.some((title) => /needs you to sign in again/i.test(title))).toBe(false);
  });

  test("a Grok sign-in reads its consumer meter with its own token and renders real meters", async () => {
    // The captain's dogfood defect (2026-09-05): Grok never showed a meter,
    // because the OAuth branch asked nothing that could answer. Now the
    // whole path runs for real - the vault resolves the account's own Pi
    // store, the sensor POSTs the gRPC-web request, the reader decodes the
    // framed config, and Settings renders the windows the way Codex and
    // Claude already do.
    const userDataDir = scratchDir("infinitary-e2e-");
    meter = await startStubMeter(["grok-live-token"]);
    seedGrokAccount(userDataDir, "grok-live-token");
    app = await launchApp({ userDataDir, env: { INFINITARY_GROK_USAGE_URL: meter.url } });
    await openSubscriptions(app);
    const row = accountRow(app, GROK_PERSONAL);

    const grokBuild = GROK_PRODUCT_LABELS[GROK_BUILD_PRODUCT]?.label as string;
    await expect(row.getByText(grokBuild, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(row.getByText(GROK_CREDITS_LABEL, { exact: true })).toBeVisible();
    await expect(row.getByText(EMPTY_QUOTA_TEXT.notYet)).toHaveCount(0);
    await expect(row.getByText(EMPTY_QUOTA_TEXT.unread)).toHaveCount(0);
    await expect(row.getByText(GROK_NO_WINDOW_DETAIL)).toHaveCount(0);
    // The request really was the meter's: the account's own stored token,
    // the gRPC-web content type, and the empty request frame.
    expect(meter.seen.length).toBeGreaterThan(0);
    expect(meter.seen[0]).toMatchObject({
      bearer: "grok-live-token",
      contentType: "application/grpc-web+proto",
      body: [0, 0, 0, 0, 0],
    });
    const grokRow = readNewestSnapshotRow(userDataDir, "grok");
    expect(grokRow).toMatchObject({ status: "ok" });
  });

  test("a Kimi Code sign-in reads its usages meter with its own token and names the plan", async () => {
    // INF-560: Kimi Code is a subscription with an allowance meter. The
    // vault resolves the account's own Pi store, the sensor asks the usages
    // endpoint with that bearer, and the row shows its windows and plan.
    const userDataDir = scratchDir("infinitary-e2e-");
    kimi = await startStubKimi(["kimi-live-token"]);
    seedKimiAccount(userDataDir, "kimi-live-token", Date.now() + 30 * 24 * 3600 * 1000);
    app = await launchApp({ userDataDir, env: { INFINITARY_KIMI_USAGE_URL: kimi.url } });
    await openSubscriptions(app);
    const row = accountRow(app, KIMI_PERSONAL);

    for (const label of ["session", "weekly", "monthly"]) {
      await expect(row.getByText(label, { exact: true })).toBeVisible({ timeout: 20_000 });
    }
    await expect(row.getByText("Allegretto")).toBeVisible();
    await expect(row.getByText(EMPTY_QUOTA_TEXT.notYet)).toHaveCount(0);
    await expect(row.getByText(KIMI_NO_WINDOW_DETAIL)).toHaveCount(0);
    expect(kimi.meterSeen[0]).toBe("kimi-live-token");
    expect(readNewestSnapshotRow(userDataDir, "kimi")).toMatchObject({ status: "ok" });
  });

  test("a Kimi Code account stored before Kimi Code came back loads and asks to sign in again", async () => {
    // INF-560, the captain's answer: "Load them, and let the row say sign
    // in again when the token has lapsed". Pi's own refresh asks the sign-in
    // server, which refuses the lapsed refresh token; the meter is never asked.
    const userDataDir = scratchDir("infinitary-e2e-");
    kimi = await startStubKimi([]);
    seedKimiAccount(userDataDir, "kimi-old-token", Date.parse("2026-08-02T00:00:00Z"));
    app = await launchApp({
      userDataDir,
      env: { INFINITARY_KIMI_USAGE_URL: kimi.url, KIMI_CODE_OAUTH_HOST: kimi.oauthHost },
    });

    await expect
      .poll(async () =>
        app?.page.evaluate(async () =>
          (await window.infinitary.cards.list()).map((card) => card.title),
        ),
      )
      .toContain(needsReauthCopy("Kimi Code", "Personal"));
    await openSubscriptions(app);
    const row = accountRow(app, KIMI_PERSONAL);
    await expect(row.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toBeVisible({ timeout: 20_000 });
    await expect(row.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(kimi.refreshSeen).toBeGreaterThan(0);
    expect(kimi.meterSeen).toEqual([]);
    expect(readNewestSnapshotRow(userDataDir, "kimi")).toMatchObject({
      status: "auth_required",
      reason: "refresh_token_lapsed",
    });
  });

  test("Copilot accounts from before load: one reads premium requests, a lapsed one asks to sign in again", async () => {
    // INF-560, the captain's answers: Copilot comes back through Pi, its chip
    // says it connects through Pi, and accounts stored before load again,
    // their row saying to sign in again once the token has lapsed.
    const userDataDir = scratchDir("infinitary-e2e-");
    copilot = await startStubCopilot("gho_live");
    seedCopilotAccounts(userDataDir, {
      [COPILOT_LIVE]: "gho_live",
      [COPILOT_LAPSED]: "gho_lapsed",
    });
    app = await launchApp({ userDataDir, env: { INFINITARY_COPILOT_USAGE_URL: copilot.url } });
    await openSubscriptions(app);

    const live = accountRow(app, COPILOT_LIVE);
    await expect(live.getByText(COPILOT_PREMIUM_LABEL, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(live.getByText(COPILOT_PLAN, { exact: false })).toBeVisible();
    await expect(live.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toHaveCount(0);

    const lapsed = accountRow(app, COPILOT_LAPSED);
    await expect(lapsed.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toBeVisible({ timeout: 20_000 });
    await expect(lapsed.getByRole("button", { name: "Sign in" })).toBeVisible();
    // The meter asked with each account's stored GitHub sign-in, never the
    // Copilot token Pi resolves for requests.
    expect(new Set(copilot.seen)).toEqual(new Set(["gho_live", "gho_lapsed"]));

    // The chip to add another account says it connects through Pi.
    const chip = app.page.locator('[data-connect-provider="github-copilot"]');
    await expect(chip).toContainText(catalogEntry("github-copilot")?.name as string);
    await expect(chip).toContainText(
      providerSignInNote({ id: "github-copilot", tier: "subscription" }) as string,
    );
  });
});
