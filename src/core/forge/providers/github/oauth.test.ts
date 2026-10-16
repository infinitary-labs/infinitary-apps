import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_URL,
  githubOAuthBaseUrl,
  pollForToken,
  readGitHubUser,
  refreshSignIn,
  requestDeviceCode,
} from "./oauth";

/**
 * GitHub's device flow and the one health read (git integration PR 1.2)
 * against a local stub of GitHub's own endpoints: real HTTP, the form
 * bodies GitHub expects, every answer GitHub gives mapped. Never the real
 * github.com.
 */

type Seen = { method: string; path: string; body: string; auth?: string };
type Answer = { status?: number; json: unknown; headers?: Record<string, string> };

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function stub(answer: (seen: Seen, count: number) => Answer) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        path: req.url ?? "",
        body,
        ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
      };
      seen.push(entry);
      const reply = answer(entry, seen.filter((s) => s.path === entry.path).length);
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        ...(reply.headers ?? {}),
      });
      res.end(JSON.stringify(reply.json));
    });
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", () => resolve()));
  const { port } = listening.address() as AddressInfo;
  return { seen, base: `http://127.0.0.1:${port}` };
}

const CODE = {
  device_code: "dev-123",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

const instant = async () => {};

describe("the device flow", () => {
  it("asks for a code with the app's client id and the three scopes", async () => {
    const { seen, base } = await stub(() => ({ json: CODE }));
    const code = await requestDeviceCode({ baseUrl: base });
    expect(code).toEqual({
      deviceCode: "dev-123",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresInS: 900,
      intervalS: 5,
    });
    expect(seen[0]?.path).toBe("/login/device/code");
    const form = new URLSearchParams(seen[0]?.body);
    expect(form.get("client_id")).toBe(GITHUB_OAUTH_CLIENT_ID);
    expect(form.get("scope")).toBe("repo workflow read:org");
  });

  it("waits through pending, slows down when asked, and returns the sign-in", async () => {
    const waits: number[] = [];
    const { seen, base } = await stub((_seen, count) =>
      count === 1
        ? { json: { error: "authorization_pending" } }
        : count === 2
          ? { json: { error: "slow_down", interval: 10 } }
          : { json: { access_token: "gho_signed", token_type: "bearer", scope: "repo,workflow" } },
    );
    const result = await pollForToken(
      { deviceCode: "dev-123", userCode: "X", verificationUri: "u", expiresInS: 900, intervalS: 5 },
      {
        baseUrl: base,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(result).toEqual({
      outcome: "signed-in",
      token: "gho_signed",
      scopes: ["repo", "workflow"],
    });
    // The interval GitHub asked for, then the slower one after slow_down.
    expect(waits).toEqual([5_000, 5_000, 10_000]);
    const form = new URLSearchParams(seen[0]?.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(form.get("device_code")).toBe("dev-123");
  });

  it("adds five seconds on a slow_down that names no interval", async () => {
    const waits: number[] = [];
    const { base } = await stub((_seen, count) =>
      count === 1 ? { json: { error: "slow_down" } } : { json: { access_token: "gho_x" } },
    );
    await pollForToken(
      { deviceCode: "d", userCode: "X", verificationUri: "u", expiresInS: 900, intervalS: 5 },
      { baseUrl: base, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([5_000, 10_000]);
  });

  it("ends as expired or denied on GitHub's own words, never as a failure", async () => {
    const expired = await stub(() => ({ json: { error: "expired_token" } }));
    await expect(
      pollForToken(
        { deviceCode: "d", userCode: "X", verificationUri: "u", expiresInS: 900, intervalS: 5 },
        { baseUrl: expired.base, sleep: instant },
      ),
    ).resolves.toEqual({ outcome: "expired" });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const denied = await stub(() => ({ json: { error: "access_denied" } }));
    await expect(
      pollForToken(
        { deviceCode: "d", userCode: "X", verificationUri: "u", expiresInS: 900, intervalS: 5 },
        { baseUrl: denied.base, sleep: instant },
      ),
    ).resolves.toEqual({ outcome: "denied" });
  });

  it("stops asking once the code has run out on the app's own clock", async () => {
    let clock = 0;
    const { seen, base } = await stub(() => ({ json: { error: "authorization_pending" } }));
    const result = await pollForToken(
      { deviceCode: "d", userCode: "X", verificationUri: "u", expiresInS: 12, intervalS: 5 },
      {
        baseUrl: base,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(result).toEqual({ outcome: "expired" });
    expect(seen).toHaveLength(2);
  });

  it("stops at once on cancel", async () => {
    const abort = new AbortController();
    const { seen, base } = await stub(() => ({ json: { error: "authorization_pending" } }));
    const result = await pollForToken(
      { deviceCode: "d", userCode: "X", verificationUri: "u", expiresInS: 900, intervalS: 5 },
      {
        baseUrl: base,
        signal: abort.signal,
        sleep: async () => {
          abort.abort();
        },
      },
    );
    expect(result).toEqual({ outcome: "cancelled" });
    expect(seen).toHaveLength(0);
  });
});

describe("a short-lived sign-in (GitHub's default for an OAuth App since 2026-08-14)", () => {
  const SHORT_LIVED = {
    token_type: "bearer",
    scope: "read:org,repo,workflow",
    expires_in: 28_800,
    refresh_token_expires_in: 15_897_600,
  };

  it("keeps the device flow's lifetime and refresh token, and exchanges an approved code once", async () => {
    const { seen, base } = await stub((_seen, count) =>
      count === 1
        ? { json: { error: "authorization_pending" } }
        : count === 2
          ? { json: { ...SHORT_LIVED, access_token: "gho_short", refresh_token: "ghr_next" } }
          : // GitHub hands a code's sign-in over once; asking again is refused.
            { json: { error: "bad_verification_code" } },
    );
    const result = await pollForToken(
      { deviceCode: "dev-123", userCode: "X", verificationUri: "u", expiresInS: 900, intervalS: 5 },
      { baseUrl: base, sleep: instant },
    );
    expect(result).toEqual({
      outcome: "signed-in",
      token: "gho_short",
      scopes: ["read:org", "repo", "workflow"],
      refreshToken: "ghr_next",
      expiresInS: 28_800,
      refreshExpiresInS: 15_897_600,
    });
    expect(seen.filter((entry) => entry.path === "/login/oauth/access_token")).toHaveLength(2);
  });

  it("renews with the refresh token and the client id alone - a device-flow sign-in has no secret", async () => {
    const { seen, base } = await stub(() => ({
      json: { ...SHORT_LIVED, access_token: "gho_new", refresh_token: "ghr_new" },
    }));
    await expect(refreshSignIn("ghr_old", { baseUrl: base })).resolves.toEqual({
      outcome: "renewed",
      token: "gho_new",
      scopes: ["read:org", "repo", "workflow"],
      refreshToken: "ghr_new",
      expiresInS: 28_800,
      refreshExpiresInS: 15_897_600,
    });
    expect(seen[0]?.path).toBe("/login/oauth/access_token");
    expect(Object.fromEntries(new URLSearchParams(seen[0]?.body))).toEqual({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "ghr_old",
    });
  });

  it("is refused when GitHub refuses the refresh token, and unavailable when GitHub cannot be asked", async () => {
    const refused = await stub(() => ({ json: { error: "bad_refresh_token" } }));
    await expect(refreshSignIn("ghr_spent", { baseUrl: refused.base })).resolves.toEqual({
      outcome: "refused",
      reason: "bad_refresh_token",
    });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const down = await stub(() => ({ status: 503, json: {} }));
    await expect(refreshSignIn("ghr_live", { baseUrl: down.base })).resolves.toMatchObject({
      outcome: "unavailable",
    });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    await expect(refreshSignIn("ghr_live", { baseUrl: down.base })).resolves.toMatchObject({
      outcome: "unavailable",
    });
  });
});

describe("who a sign-in is (the health read)", () => {
  it("answers ok with the login on a 200, and sends the sign-in as a bearer", async () => {
    const { seen, base } = await stub(() => ({ json: { login: "octo" } }));
    await expect(readGitHubUser("gho_abc", { apiBaseUrl: base })).resolves.toEqual({
      state: "ok",
      login: "octo",
      status: 200,
    });
    expect(seen[0]).toMatchObject({ method: "GET", path: "/user", auth: "Bearer gho_abc" });
  });

  it("answers rejected only on GitHub's 401", async () => {
    const { base } = await stub(() => ({ status: 401, json: { message: "Bad credentials" } }));
    await expect(readGitHubUser("gho_abc", { apiBaseUrl: base })).resolves.toEqual({
      state: "rejected",
      status: 401,
    });
  });

  it("answers unavailable - never a sign-out - on a spent allowance, a 5xx, or no host", async () => {
    const limited = await stub(() => ({
      status: 403,
      json: { message: "rate limited" },
      headers: { "x-ratelimit-remaining": "0" },
    }));
    await expect(readGitHubUser("gho_abc", { apiBaseUrl: limited.base })).resolves.toEqual({
      state: "unavailable",
      reason: "403, the hourly allowance is spent",
      status: 403,
    });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const down = await stub(() => ({ status: 503, json: {} }));
    await expect(readGitHubUser("gho_abc", { apiBaseUrl: down.base })).resolves.toEqual({
      state: "unavailable",
      reason: "503",
      status: 503,
    });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    // Nothing listens on this port any more: no answer, so no status.
    const unreachable = await readGitHubUser("gho_abc", { apiBaseUrl: down.base });
    expect(unreachable).toMatchObject({ state: "unavailable" });
    expect(unreachable).not.toHaveProperty("status");
  });
});

describe("the endpoint", () => {
  it("honours the dev override only in an unpackaged app", () => {
    const env = { INFINITARY_GITHUB_OAUTH_URL: "http://127.0.0.1:9/" };
    expect(githubOAuthBaseUrl({ packaged: false, env })).toBe("http://127.0.0.1:9");
    expect(githubOAuthBaseUrl({ packaged: true, env })).toBe(GITHUB_OAUTH_URL);
    expect(githubOAuthBaseUrl({ packaged: false, env: {} })).toBe("https://github.com");
  });

  it("reads the override under the older FM3000_ name too", () => {
    const env = { FM3000_GITHUB_OAUTH_URL: "http://127.0.0.1:9/" };
    expect(githubOAuthBaseUrl({ packaged: false, env })).toBe("http://127.0.0.1:9");
    expect(githubOAuthBaseUrl({ packaged: true, env })).toBe(GITHUB_OAUTH_URL);
  });
});
