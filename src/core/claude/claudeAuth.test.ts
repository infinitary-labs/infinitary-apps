import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_CLIENT_MISSING_TEXT, claudeClientOutdatedText } from "@shared/claudeClient";
import type { AuthNotice, AuthPromptView } from "@shared/providers";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { isNonTerminalFailureReason } from "../accounts/credentialHealth";
import type { HostKeychain } from "../host";
import type { AuthInteractionBridge } from "../pi/piAuth";
import {
  CLAUDE_LOGIN_UNFINISHED_TEXT,
  CLAUDE_LOGIN_UNFINISHED_THERE_TEXT,
  CLAUDE_LOGIN_UNREADABLE_TEXT,
  CLAUDE_LOGIN_UNREADABLE_THERE_TEXT,
  ClaudeAuthBackend,
  MADE_LOGIN_FILE,
  parseStatus,
} from "./claudeAuth";
import { NO_BROWSER, type RunClaude } from "./claudeCli";
import {
  type ClaudeStoreRead,
  claudeCredentialStamp,
  clearClaudeCredentialCache,
  clearKeychainLock,
  isKeychainLocked,
  readClaudeStore,
} from "./claudeQuota";
import { resetStoreLeasesForTest } from "./claudeStoreLease";

/**
 * The backend runs against a fake client that behaves like the real one:
 * `auth login` writes a credential marker into the default config directory
 * it is pointed at (CD-1=B: the machine login, never a vault account dir),
 * and `auth status --json` reports on that directory. Logout is unbind-only
 * and must not spawn `claude auth logout`.
 */

type FakeClient = {
  run: RunClaude;
  calls: { args: string[]; configDir: string }[];
  failLogin?: boolean;
};

/**
 * The store as the backend reads it when the client cannot answer: the same
 * marker the fake client writes, classified the way the real store is (a
 * present credential is live; nothing there is a sign-out). The marker's
 * words stand for the credential, so a new login reads as a new one.
 */
const fakeStore = async (configDir: string): Promise<ClaudeStoreRead> => {
  const marker = join(configDir, "credential");
  const written = existsSync(marker) ? readFileSync(marker, "utf8") : "";
  return written.length > 0
    ? {
        state: "present" as const,
        auth: {
          accessToken: written,
          ...(existsSync(join(configDir, "plan"))
            ? { subscriptionType: readFileSync(join(configDir, "plan"), "utf8") }
            : {}),
        },
        identity: existsSync(join(configDir, "identity-email"))
          ? { label: readFileSync(join(configDir, "identity-email"), "utf8") }
          : {},
      }
    : { state: "absent" };
};

/** A client that cannot be run at all - the packaged-build failure shape. */
const unspawnableClient: RunClaude = () =>
  Promise.reject(new Error("spawn ENOTDIR /app.asar/node_modules/.../claude"));

function fakeClient(options: { identity?: { email: string; plan: string } } = {}): FakeClient {
  const client: FakeClient = {
    calls: [],
    run: async (args, configDir, runOptions) => {
      client.calls.push({ args, configDir });
      const marker = join(configDir, "credential");
      if (args[0] === "auth" && args[1] === "login") {
        runOptions?.onStdout?.("Opening browser to sign in...\n");
        runOptions?.onStdout?.(
          "If it didn't open, visit: https://claude.com/cai/oauth/authorize?x=1\n",
        );
        if (client.failLogin) {
          return { code: 1, stdout: "", stderr: "Your organization has SSO enforced." };
        }
        // Every login the client makes is a new credential.
        writeFileSync(marker, `opaque-credential-written-by-the-client-${client.calls.length}`);
        if (options.identity) {
          writeFileSync(join(configDir, "identity-email"), options.identity.email);
          writeFileSync(join(configDir, "plan"), options.identity.plan);
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "logout") {
        if (existsSync(marker)) writeFileSync(marker, "");
        return { code: 0, stdout: "", stderr: "" };
      }
      const loggedIn = existsSync(marker) && readFileSync(marker, "utf8").length > 0;
      return {
        code: loggedIn ? 0 : 1,
        stdout: JSON.stringify({
          loggedIn,
          authMethod: loggedIn ? "claude.ai" : "none",
          ...(loggedIn && options.identity
            ? { email: options.identity.email, subscriptionType: options.identity.plan }
            : {}),
        }),
        stderr: "",
      };
    },
  };
  return client;
}

/** The vault's reference to the one Claude account over the machine store. */
function accountRef(store: string) {
  return { providerId: CLAUDE_PROVIDER_ID, accountId: "acct_1", dir: store };
}

function bridge(): AuthInteractionBridge & { notices: AuthNotice[]; prompts: AuthPromptView[] } {
  const notices: AuthNotice[] = [];
  const prompts: AuthPromptView[] = [];
  return {
    notices,
    prompts,
    prompt: async (prompt) => {
      prompts.push(prompt);
      return "answer";
    },
    notify: (notice) => notices.push(notice),
    openExternal: async () => {},
  };
}

function accountDir(name: string): string {
  return scratchDir(`infinitary-claude-${name}-`);
}

describe("ClaudeAuthBackend", () => {
  it("signs in through the client into the machine's default store, not the vault dir", async () => {
    const client = fakeClient({ identity: { email: "kun@example.com", plan: "max" } });
    const store = accountDir("store");
    const vaultDir = accountDir("vault");
    const backend = new ClaudeAuthBackend({
      run: client.run,
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
    });
    const relay = bridge();

    await backend.login({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_a",
      dir: vaultDir,
      type: "oauth",
      bridge: relay,
    });

    expect(client.calls.find((call) => call.args[1] === "login")).toEqual({
      args: ["auth", "login", "--claudeai"],
      configDir: store,
    });
    expect(existsSync(join(store, "credential"))).toBe(true);
    expect(existsSync(join(vaultDir, "credential"))).toBe(false);
    const status = await backend.status({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_a",
      dir: vaultDir,
    });
    expect(status.connected).toBe(true);
    expect(status.authType).toBe("oauth");
    expect(status.identity).toEqual({ label: "kun@example.com", plan: "Max" });
  });

  it("signs in without asking macOS for the saved sign-in itself (INF-2317)", async () => {
    // The captain's Sign in raised a password prompt for the saved sign-in
    // and changed nothing. The sign-in is Claude's own; the read after it is
    // the allowance read, never part of the sign-in.
    const store = accountDir("no-ask");
    writeFileSync(join(store, ".config.json"), "{}");
    let item = { token: "refused", modifiedAt: "20261101000000Z" };
    const reads: { interactive?: boolean }[] = [];
    const keychain: HostKeychain = {
      findGenericPassword: async () => ({ kind: "found", modifiedAt: item.modifiedAt }),
      readGenericPassword: async (query) => {
        reads.push(query);
        return {
          kind: "value",
          value: JSON.stringify({ claudeAiOauth: { accessToken: item.token, expiresAt: 9e15 } }),
        };
      },
    };
    const logins: string[][] = [];
    const backend = new ClaudeAuthBackend({
      run: async (args) => {
        if (args[1] === "login") {
          logins.push(args);
          item = { token: "fresh", modifiedAt: "20261102000000Z" };
          return { code: 0, stdout: "", stderr: "" };
        }
        return {
          code: 0,
          stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
          stderr: "",
        };
      },
      available: () => true,
      configDir: () => store,
      keychain,
    });
    await backend.login({ ...accountRef(store), type: "oauth", bridge: bridge(), again: true });
    expect(logins).toEqual([["auth", "login", "--claudeai"]]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((read) => read.interactive === true)).toEqual([]);
  });

  it("adopts a login already on this Mac without opening a browser", async () => {
    const client = fakeClient();
    const store = accountDir("already");
    writeFileSync(join(store, "credential"), "already-signed-in");
    const backend = new ClaudeAuthBackend({
      run: client.run,
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
    });
    const relay = bridge();
    await backend.login({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_a",
      dir: accountDir("vault"),
      type: "oauth",
      bridge: relay,
    });
    expect(client.calls.some((call) => call.args[1] === "login")).toBe(false);
    expect(relay.notices.map((notice) => notice.message).join(" ")).toMatch(
      /login on this computer/i,
    );
  });

  it("never signs in over a store it cannot read, and says so in plain words", async () => {
    const client = fakeClient();
    const store = accountDir("unreadable");
    const backend = new ClaudeAuthBackend({
      run: client.run,
      available: () => true,
      readStore: async () => ({ state: "unreadable" }),
      configDir: () => store,
    });
    const relay = bridge();
    await expect(
      backend.login({
        providerId: CLAUDE_PROVIDER_ID,
        accountId: "acct_u",
        dir: accountDir("u"),
        type: "oauth",
        bridge: relay,
      }),
    ).rejects.toThrow(CLAUDE_LOGIN_UNREADABLE_TEXT);
    // A new vendor sign-in would replace the login it cannot see.
    expect(client.calls.some((call) => call.args[1] === "login")).toBe(false);
    expect(relay.notices.map((notice) => notice.message).join(" ")).not.toMatch(/browser/i);
    expect(CLAUDE_LOGIN_UNREADABLE_TEXT).not.toMatch(/harness|keychain|cli|claude code/i);
  });

  it("signs in again when the saved login is absent and the client confirms it", async () => {
    const client = fakeClient();
    const store = accountDir("lapsed");
    const backend = new ClaudeAuthBackend({
      run: client.run,
      available: () => true,
      // Absence plus the client’s signed-out answer permits a new login.
      readStore: async (dir) =>
        existsSync(join(dir, "credential"))
          ? { state: "present" as const, auth: { accessToken: "fixture-token" }, identity: {} }
          : { state: "absent" },
      configDir: () => store,
    });
    await backend.login({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_l",
      dir: accountDir("l"),
      type: "oauth",
      bridge: bridge(),
    });
    expect(client.calls.filter((call) => call.args[1] === "login")).toHaveLength(1);
  });

  it("tells the user what is happening without naming the machinery", async () => {
    const client = fakeClient();
    const store = accountDir("copy");
    const backend = new ClaudeAuthBackend({
      run: client.run,
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
    });
    const relay = bridge();
    await backend.login({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_a",
      dir: accountDir("b"),
      type: "oauth",
      bridge: relay,
    });
    const said = relay.notices.map((notice) => notice.message).join(" ");
    expect(said).toMatch(/browser/i);
    // The standing product rule: the user connects a Claude subscription and
    // never learns which client Infinitary ran to do it.
    expect(said).not.toMatch(/harness|agent-sdk|claude-code|CLAUDE_CONFIG_DIR|cli/i);
    expect(relay.notices.every((notice) => notice.accountId === "acct_a")).toBe(true);
  });

  it("surfaces the client's own words when a sign-in fails, and leaves no account", async () => {
    const client = fakeClient();
    client.failLogin = true;
    const store = accountDir("c-store");
    const backend = new ClaudeAuthBackend({
      run: client.run,
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
    });
    await expect(
      backend.login({
        providerId: CLAUDE_PROVIDER_ID,
        accountId: "acct_c",
        dir: accountDir("c"),
        type: "oauth",
        bridge: bridge(),
      }),
      // A generic "sign-in failed" would throw away the one sentence that
      // tells the user what to do about it.
    ).rejects.toThrow("Your organization has SSO enforced.");
    expect(existsSync(join(store, "credential"))).toBe(false);
  });

  it("says the sign-in did not finish and what to try when Claude gives no reason", async () => {
    const waited =
      "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?x=1\n";
    // What Claude's client wrote when it could not reach Claude (2.1.289),
    // and a client that wrote nothing at all.
    for (const stderr of ["Login failed: \n", ""]) {
      const store = accountDir("c-silent");
      const backend = new ClaudeAuthBackend({
        run: async (args) =>
          args[1] === "login"
            ? { code: 1, stdout: waited, stderr }
            : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" },
        available: () => true,
        readStore: fakeStore,
        configDir: () => store,
      });
      await expect(
        backend.login({
          providerId: CLAUDE_PROVIDER_ID,
          accountId: "acct_c",
          dir: accountDir("c"),
          type: "oauth",
          bridge: bridge(),
        }),
      ).rejects.toMatchObject({ message: CLAUDE_LOGIN_UNFINISHED_TEXT });
    }
    // A reason after the bare label is still Claude's own.
    const backend = new ClaudeAuthBackend({
      run: async (args) =>
        args[1] === "login"
          ? {
              code: 1,
              stdout: waited,
              stderr: "Login failed: \nSSL certificate error (SELF_SIGNED_CERT_IN_CHAIN).\n",
            }
          : { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" },
      available: () => true,
      readStore: fakeStore,
      configDir: () => accountDir("c-ssl"),
    });
    await expect(
      backend.login({
        providerId: CLAUDE_PROVIDER_ID,
        accountId: "acct_c",
        dir: accountDir("c"),
        type: "oauth",
        bridge: bridge(),
      }),
    ).rejects.toMatchObject({ message: "SSL certificate error (SELF_SIGNED_CERT_IN_CHAIN)." });
    expect(CLAUDE_LOGIN_UNFINISHED_TEXT).not.toMatch(/harness|keychain/i);
  });

  it("adopts a login a sign-in already in front of it just saved, and starts no second login", async () => {
    resetStoreLeasesForTest();
    const store = accountDir("queued-adopt");
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let logins = 0;
    const backend = new ClaudeAuthBackend({
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
      run: async (args, configDir) => {
        if (args[1] === "login") {
          logins += 1;
          if (logins === 1) {
            entered();
            await firstHeld;
            writeFileSync(join(configDir, "credential"), "saved-by-the-first");
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        const loggedIn = existsSync(join(configDir, "credential"));
        return {
          code: loggedIn ? 0 : 1,
          stdout: JSON.stringify({ loggedIn }),
          stderr: "",
        };
      },
    });
    const request = (id: string) => ({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: id,
      dir: accountDir("queued-vault"),
      type: "oauth" as const,
      bridge: bridge(),
    });
    const first = backend.login(request("first"));
    await started;
    const second = backend.login(request("second"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await Promise.all([first, second]);
    expect(logins).toBe(1);
  });

  it("adopts a login the client saved before it stopped answering", async () => {
    const store = accountDir("timeout-saved");
    const backend = new ClaudeAuthBackend({
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
      run: async (args, configDir) => {
        if (args[1] === "login") {
          writeFileSync(join(configDir, "credential"), "saved-before-the-timer");
          throw new Error("Claude did not respond in time.");
        }
        const loggedIn = existsSync(join(configDir, "credential"));
        return {
          code: loggedIn ? 0 : 1,
          stdout: JSON.stringify({ loggedIn }),
          stderr: "",
        };
      },
    });
    await backend.login({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_timeout",
      dir: accountDir("timeout-vault"),
      type: "oauth",
      bridge: bridge(),
    });
    expect(existsSync(join(store, "credential"))).toBe(true);
  });

  it("keeps the sign-in link and a paste while the browser has not come back", async () => {
    const store = accountDir("held-link");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const relay = bridge();
    const backend = new ClaudeAuthBackend({
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
      run: async (args, _configDir, options) => {
        if (args[1] !== "login") {
          return { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
        }
        options?.onStdout?.("Opening browser to sign in…\n");
        options?.onStdout?.(
          "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?x=1\n",
        );
        await held;
        return { code: 1, stdout: "", stderr: "Login failed: \n" };
      },
    });
    const login = backend.login({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_held",
      dir: accountDir("held-vault"),
      type: "oauth",
      bridge: relay,
    });
    await vi.waitFor(() => {
      expect(relay.notices.some((notice) => notice.kind === "auth_url" && notice.url)).toBe(true);
    });
    expect(relay.prompts.some((prompt) => prompt.kind === "manual_code")).toBe(true);
    release();
    await expect(login).rejects.toThrow(/\/login/);
  });

  it("refuses a key paste: a Claude subscription signs in through Claude", async () => {
    const backend = new ClaudeAuthBackend({
      run: fakeClient().run,
      available: () => true,
      readStore: fakeStore,
      configDir: () => accountDir("d"),
    });
    await expect(
      backend.login({
        providerId: CLAUDE_PROVIDER_ID,
        accountId: "acct_d",
        dir: accountDir("d-vault"),
        type: "api_key",
        bridge: bridge(),
      }),
    ).rejects.toThrow(/signs in through Claude/);
  });

  it("unbinds without signing the machine out of Claude", async () => {
    const client = fakeClient();
    const store = accountDir("keep");
    const backend = new ClaudeAuthBackend({
      run: client.run,
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
    });
    const ref = { providerId: CLAUDE_PROVIDER_ID, accountId: "acct_1", dir: accountDir("1") };
    await backend.login({ ...ref, type: "oauth", bridge: bridge() });
    expect((await backend.status(ref)).connected).toBe(true);

    await backend.logout(ref);

    expect(client.calls.some((call) => call.args[1] === "logout")).toBe(false);
    expect((await backend.status(ref)).connected).toBe(true);
  });

  it("binds as the machine's default login, never a credential and never a config dir", async () => {
    const backend = new ClaudeAuthBackend({
      run: fakeClient().run,
      available: () => true,
      readStore: fakeStore,
      configDir: () => accountDir("bind"),
    });
    const dir = accountDir("bind-vault");
    const binding = backend.binding({ providerId: CLAUDE_PROVIDER_ID, accountId: "acct_b", dir });
    expect(binding).toEqual({ via: "default-login" });
    expect(JSON.stringify(binding)).not.toMatch(/token|secret|key/i);
  });

  /**
   * F14: the app ships no client. A live machine login with no Claude Code
   * to run it is not a sign-out - the credential is fine - but the account
   * cannot serve, and the health says so with the sentence the row shows.
   */
  it("degrades a live login with no client as client_missing, never a sign-out", async () => {
    const store = accountDir("no-client");
    const backend = new ClaudeAuthBackend({
      run: unspawnableClient,
      client: async () => ({ state: "missing" }),
      readStore: async () => ({
        state: "present",
        auth: { accessToken: "fixture-token" },
        identity: { label: "kun@example.com" },
      }),
      configDir: () => store,
    });
    const health = await backend.health(accountRef(store));
    expect(health).toMatchObject({
      state: "degraded",
      reason: "client_missing",
      detail: CLAUDE_CLIENT_MISSING_TEXT,
      identity: { label: "kun@example.com" },
    });
    const status = await backend.status(accountRef(store));
    expect(status.connected).toBe(true);
    expect(status.reason).toBe("client_missing");
    expect(status.detail).toBe(CLAUDE_CLIENT_MISSING_TEXT);
    expect(isNonTerminalFailureReason(health.reason)).toBe(true);
  });

  it("degrades a live login behind a too-old client as client_outdated, naming the versions", async () => {
    const store = accountDir("old-client");
    const backend = new ClaudeAuthBackend({
      run: unspawnableClient,
      client: async () => ({
        state: "outdated",
        executable: "/x/claude",
        version: "2.1.100",
        floor: "2.1.234",
      }),
      readStore: async () => ({
        state: "present" as const,
        auth: { accessToken: "fixture-token" },
        identity: {},
      }),
      configDir: () => store,
    });
    const health = await backend.health(accountRef(store));
    expect(health).toMatchObject({ state: "degraded", reason: "client_outdated" });
    expect(health.detail).toBe(claudeClientOutdatedText("2.1.100", "2.1.234"));
    expect(isNonTerminalFailureReason(health.reason)).toBe(true);
  });

  it("stamps its health with the store's login and the client's version, for a cut-off to be read against", async () => {
    const store = accountDir("stamped");
    let written = "file:1";
    const backend = new ClaudeAuthBackend({
      run: unspawnableClient,
      client: async () => ({ state: "ready", executable: "/x/claude", version: "2.1.234" }),
      readStore: async () => ({
        state: "present",
        auth: { accessToken: "fixture-token" },
        identity: { accountUuid: "account-a" },
        written,
      }),
      configDir: () => store,
    });
    expect((await backend.health(accountRef(store))).stamp).toEqual({
      login: claudeCredentialStamp({
        state: "present",
        auth: { accessToken: "fixture-token" },
        identity: { accountUuid: "account-a" },
      }).login,
      written: "file:1",
      client: "2.1.234",
    });
    written = "file:2";
    expect((await backend.health(accountRef(store))).stamp?.written).toBe("file:2");
    // The stamp is the vault's, never the account view's.
    expect(await backend.status(accountRef(store))).toEqual({ connected: true, authType: "oauth" });

    // A test that injects the store read never reaches a real login.
    const unstamped = new ClaudeAuthBackend({
      run: unspawnableClient,
      available: () => true,
      readStore: async () => ({
        state: "present" as const,
        auth: { accessToken: "fixture-token" },
        identity: {},
      }),
      configDir: () => store,
    });
    expect((await unstamped.health(accountRef(store))).stamp).toBeUndefined();
  });

  it("keeps a sign-out a sign-out whatever the client's state", async () => {
    const store = accountDir("no-client-unsigned");
    const backend = new ClaudeAuthBackend({
      run: unspawnableClient,
      client: async () => ({ state: "missing" }),
      readStore: async () => ({ state: "absent" }),
      configDir: () => store,
    });
    expect(await backend.health(accountRef(store))).toEqual({ state: "unsigned" });
    // INF-2317: missing client cannot make a saved refresh date a sign-out.
    writeFileSync(
      join(store, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "saved", refreshTokenExpiresAt: 1 } }),
    );
    const saved = new ClaudeAuthBackend({
      run: unspawnableClient,
      client: async () => ({ state: "missing" }),
      readStore: (dir) => readClaudeStore(dir, { env: { HOME: store } }),
      configDir: () => store,
    });
    expect((await saved.health(accountRef(store))).state).toBe("degraded");
  });

  it("refuses to sign in with no client, in the sentence that says what to do", async () => {
    const store = accountDir("login-no-client");
    const backend = new ClaudeAuthBackend({
      run: unspawnableClient,
      client: async () => ({ state: "missing" }),
      readStore: async () => ({
        state: "present" as const,
        auth: { accessToken: "fixture-token" },
        identity: {},
      }),
      configDir: () => store,
    });
    await expect(
      backend.login({
        providerId: CLAUDE_PROVIDER_ID,
        accountId: "acct_x",
        dir: accountDir("vault"),
        type: "oauth",
        bridge: bridge(),
      }),
    ).rejects.toThrow(CLAUDE_CLIENT_MISSING_TEXT);
  });

  it("offers no way to connect when the client is not installed", () => {
    const absent = new ClaudeAuthBackend({
      run: fakeClient().run,
      available: () => false,
      readStore: fakeStore,
    });
    expect(absent.authTypes()).toEqual([]);
    const present = new ClaudeAuthBackend({
      run: fakeClient().run,
      available: () => true,
      readStore: fakeStore,
    });
    expect(present.authTypes()).toEqual(["oauth"]);
  });

  /**
   * The captain's packaged dogfood build (2026-09-01): the vendored client
   * resolved to a path inside app.asar, where `spawn` cannot reach it, so
   * every status read threw. A fully signed-in Max account - one whose quota
   * windows were being read from that very store, live, at the same moment -
   * was badged "sign in again" and lost every model from the routing pool.
   * A probe that cannot answer is not a sign-out.
   */
  it("stays connected when the client cannot run but the store still holds a credential", async () => {
    const dir = accountDir("unspawnable");
    writeFileSync(join(dir, "credential"), "opaque-credential-written-by-the-client");
    const backend = new ClaudeAuthBackend({
      run: unspawnableClient,
      available: () => true,
      readStore: fakeStore,
      configDir: () => dir,
    });

    const status = await backend.status({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_u",
      dir: accountDir("vault"),
    });
    expect(status.connected).toBe(true);
    expect(status.authType).toBe("oauth");
  });

  it("reports the identity its own store knows when the client cannot answer", async () => {
    const backend = new ClaudeAuthBackend({
      run: unspawnableClient,
      available: () => true,
      readStore: async () => ({
        state: "present",
        auth: { accessToken: "fixture-token" },
        identity: { label: "kun@example.com" },
      }),
    });
    const status = await backend.status({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_i",
      dir: accountDir("identity"),
    });
    expect(status).toEqual({
      connected: true,
      authType: "oauth",
      identity: { label: "kun@example.com" },
    });
  });

  // INF-2318: the current config, not a stale client answer or a separate peek, owns identity.
  it("reads identity, expiry and the refusal stamp from one store result", async () => {
    const dir = accountDir("one-read");
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: 9000 } }),
    );
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "alex.two@example.com", accountUuid: "account-two" },
      }),
    );
    const readStore = vi.fn((store: string) =>
      readClaudeStore(store, { env: { HOME: dir }, now: () => 1000 }),
    );
    const backend = new ClaudeAuthBackend({
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({ loggedIn: true, email: "alex.one@example.com" }),
        stderr: "",
      }),
      available: () => true,
      configDir: () => dir,
      now: () => 1000,
      readStore,
    });
    expect(await backend.health(accountRef(dir))).toMatchObject({
      identity: { label: "alex.two@example.com" },
      expiresAt: 9000,
      stamp: { login: expect.any(String), written: expect.any(String) },
    });
    expect(readStore).toHaveBeenCalledExactlyOnceWith(dir);
  });

  it("does not treat an unreadable store as a sign-out either", async () => {
    const backend = new ClaudeAuthBackend({
      run: async () => ({ code: 0, stdout: "not json at all", stderr: "" }),
      available: () => true,
      readStore: async () => ({ state: "unreadable" }),
    });
    // Unknown is never absent (rule 3): degraded projects as connected, and
    // must never become needs_reauth.
    const status = await backend.status({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_q",
      dir: accountDir("unknown"),
    });
    expect(status.connected).toBe(true);
    expect(status.reason).toBe("unknown");
    const health = await backend.health({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_q",
      dir: accountDir("unknown-h"),
    });
    expect(health.state).toBe("degraded");
    expect(health.reason).toBe("unknown");
  });

  it("asks for a sign-in when the credential is really gone", async () => {
    const gone = new ClaudeAuthBackend({
      run: unspawnableClient,
      available: () => true,
      readStore: async () => ({ state: "absent" }),
    });
    // INF-2317: a saved credential with an old date remains connected.
    const store = accountDir("saved-expired-date");
    writeFileSync(
      join(store, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "saved", refreshTokenExpiresAt: 1 } }),
    );
    const saved = new ClaudeAuthBackend({
      run: unspawnableClient,
      available: () => true,
      readStore: (dir) => readClaudeStore(dir, { env: { HOME: store } }),
      configDir: () => store,
    });
    const ref = { providerId: CLAUDE_PROVIDER_ID, accountId: "acct_x", dir: accountDir("gone") };
    expect((await gone.status(ref)).connected).toBe(false);
    expect((await saved.status(ref)).connected).toBe(true);
  });

  it("creates the default config directory 0700 if the client has not yet", async () => {
    const store = join(accountDir("mode"), "nested");
    const backend = new ClaudeAuthBackend({
      run: fakeClient().run,
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
    });
    await backend.login({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_m",
      dir: accountDir("vault"),
      type: "oauth",
      bridge: bridge(),
    });
    expect(statSync(store).mode & 0o777).toBe(0o700);
  });
});

/**
 * The row's Sign in on an account that already exists (INF-2319, the plan
 * the captain accepted in INF-2308: "The button signs in."). It shows only
 * after Anthropic refused the saved sign-in, so using that sign-in again
 * changes nothing: Claude's own login runs over it, and only a new login
 * counts.
 */
describe("ClaudeAuthBackend: the row's Sign in runs Claude's own login", () => {
  const signInAgain = (backend: ClaudeAuthBackend, store: string, relay = bridge()) =>
    backend.login({ ...accountRef(store), type: "oauth", bridge: relay, again: true });

  it("runs the login over the refused sign-in and counts the new one", async () => {
    const client = fakeClient();
    const store = accountDir("again");
    writeFileSync(join(store, "credential"), "refused-by-anthropic");
    const backend = new ClaudeAuthBackend({
      run: client.run,
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
    });
    const relay = bridge();
    await signInAgain(backend, store, relay);

    expect(client.calls.filter((call) => call.args[1] === "login")).toHaveLength(1);
    expect(readFileSync(join(store, "credential"), "utf8")).not.toBe("refused-by-anthropic");
    const said = relay.notices.map((notice) => notice.message);
    expect(said).toContain("Opening Claude in your browser to sign in...");
    expect(said.join(" ")).not.toMatch(/Using the Claude login/);
  });

  it("says the sign-in did not finish when the refused sign-in is still all there is", async () => {
    const store = accountDir("again-same");
    writeFileSync(join(store, "credential"), "refused-by-anthropic");
    const backend = new ClaudeAuthBackend({
      // The client ends cleanly and says it is signed in, but saved nothing new.
      run: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" }),
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
    });
    await expect(signInAgain(backend, store)).rejects.toMatchObject({
      message: CLAUDE_LOGIN_UNFINISHED_TEXT,
    });
  });

  it("does not count the refused sign-in when the client stops answering", async () => {
    const store = accountDir("again-timeout");
    writeFileSync(join(store, "credential"), "refused-by-anthropic");
    const backend = new ClaudeAuthBackend({
      run: async (args) => {
        if (args[1] === "login") throw new Error("Claude did not respond in time.");
        return { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
      },
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
    });
    await expect(signInAgain(backend, store)).rejects.toThrow("Claude did not respond in time.");
  });

  it("counts a new login the client saved before it stopped answering", async () => {
    const store = accountDir("again-saved");
    writeFileSync(join(store, "credential"), "refused-by-anthropic");
    const backend = new ClaudeAuthBackend({
      run: async (args, configDir) => {
        if (args[1] === "login") {
          writeFileSync(join(configDir, "credential"), "saved-before-the-timer");
          throw new Error("Claude did not respond in time.");
        }
        return { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
      },
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
    });
    await signInAgain(backend, store);
    expect(readFileSync(join(store, "credential"), "utf8")).toBe("saved-before-the-timer");
  });

  it("runs the login over a sign-in it cannot read now, and counts it on Claude's word", async () => {
    // A saved sign-in macOS keeps from this app reads as unreadable in the
    // background: that is no reason to keep the refused one.
    const calls: string[][] = [];
    const run: RunClaude = async (args) => {
      calls.push(args);
      return args[1] === "login"
        ? { code: 0, stdout: "Login successful.", stderr: "" }
        : { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
    };
    const store = accountDir("again-unreadable");
    const backend = new ClaudeAuthBackend({
      run,
      available: () => true,
      readStore: async () => ({ state: "unreadable", reason: "keychain_needs_grant" }),
      configDir: () => store,
    });
    await signInAgain(backend, store);
    expect(calls.filter((args) => args[1] === "login")).toHaveLength(1);
  });

  it("keeps Claude's own words when a login it cannot read afterwards failed", async () => {
    const store = accountDir("again-unreadable-failed");
    const backend = new ClaudeAuthBackend({
      run: async (args) =>
        args[1] === "login"
          ? { code: 1, stdout: "", stderr: "Your organization has SSO enforced." }
          : { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" },
      available: () => true,
      readStore: async () => ({ state: "unreadable", reason: "keychain_needs_grant" }),
      configDir: () => store,
    });
    await expect(signInAgain(backend, store)).rejects.toThrow(
      "Your organization has SSO enforced.",
    );
  });

  it("uses a login Claude says is there when nothing was saved, as a first connect does", async () => {
    const store = accountDir("again-empty");
    const calls: string[][] = [];
    const backend = new ClaudeAuthBackend({
      run: async (args) => {
        calls.push(args);
        return { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
      },
      available: () => true,
      readStore: async () => ({ state: "absent" }),
      configDir: () => store,
    });
    const relay = bridge();
    await signInAgain(backend, store, relay);
    expect(calls.filter((args) => args[1] === "login")).toEqual([]);
    expect(relay.notices.map((notice) => notice.message)).toContain(
      "Using the Claude login on this computer.",
    );
  });
});

/**
 * A computer that runs work signs Claude in with a code pasted back at its
 * home (docs/helper.md, "Its own sign-ins"), against a stand-in client that
 * prints what Claude Code 2.1.288 prints with no terminal: the loopback link
 * goes to the browser opener `BROWSER` names, the link whose page shows a
 * code is printed, and the client waits for that code on stdin.
 */
describe("ClaudeAuthBackend on a computer that runs work: a code pasted back", () => {
  const CODE_PAGE =
    "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1";

  /**
   * `elsewhere`: the client is signed in with a login this process cannot
   * see, as one kept only in the saved passwords is to a look that could not
   * reach them. `silent`: its status read gives no answer. `unreachable`: it
   * cannot reach Claude to take the code, and says only "Login failed: ", as
   * 2.1.289 does.
   */
  function pasteClient(
    status: { elsewhere?: boolean; silent?: boolean; unreachable?: boolean } = {},
  ) {
    const seen: { browser?: string; pasted?: string; logins: number } = { logins: 0 };
    const run: RunClaude = async (args, configDir, options) => {
      const marker = join(configDir, "credential");
      if (args[0] === "auth" && args[1] === "login") {
        seen.logins += 1;
        seen.browser = options?.env?.BROWSER;
        options?.onStdout?.("Opening browser to sign in…\nIf the browser didn't open, visit: ");
        options?.onStdout?.(`${CODE_PAGE}\nPaste code here if prompted > `);
        if (!options?.paste) return { code: 1, stdout: "", stderr: "stdin closed" };
        const pasted = await options.paste;
        seen.pasted = pasted;
        if (status.unreachable)
          return {
            code: 1,
            stdout: `Opening browser to sign in…\nIf the browser didn't open, visit: ${CODE_PAGE}\nPaste code here if prompted > `,
            stderr: "Login failed: \n",
          };
        if (pasted !== "good-code#s1")
          return { code: 1, stdout: "", stderr: "Login failed: Invalid authorization code" };
        writeFileSync(marker, "opaque-credential-written-by-the-client");
        return { code: 0, stdout: "Login successful.", stderr: "" };
      }
      if (status.silent) return { code: 1, stdout: "", stderr: "" };
      const loggedIn =
        status.elsewhere === true ||
        (existsSync(marker) && readFileSync(marker, "utf8").length > 0);
      return { code: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn }), stderr: "" };
    };
    return { run, seen };
  }

  function computer(store: string, run: RunClaude) {
    return new ClaudeAuthBackend({
      run,
      available: () => true,
      readStore: fakeStore,
      configDir: () => store,
      pasteCode: true,
    });
  }

  function pasting(answer: (prompt: AuthPromptView) => Promise<string>) {
    const notices: AuthNotice[] = [];
    const prompts: AuthPromptView[] = [];
    const relay: AuthInteractionBridge = {
      prompt: (prompt) => {
        prompts.push(prompt);
        return answer(prompt);
      },
      notify: (notice) => notices.push(notice),
      openExternal: async () => {
        throw new Error("nothing opens a browser on a computer that runs work");
      },
    };
    return { relay, notices, prompts };
  }

  const login = (backend: ClaudeAuthBackend, relay: AuthInteractionBridge) =>
    backend.login({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_p",
      dir: accountDir("paste-vault"),
      type: "oauth",
      bridge: relay,
    });

  it("sends the link whose page shows a code, takes the code pasted back, and opens no browser", async () => {
    const client = pasteClient();
    const store = accountDir("paste");
    const { relay, notices, prompts } = pasting(async () => "good-code#s1");
    await login(computer(store, client.run), relay);

    expect(client.seen.browser).toBe(NO_BROWSER);
    expect(notices).toContainEqual(
      expect.objectContaining({ kind: "auth_url", url: CODE_PAGE, accountId: "acct_p" }),
    );
    expect(prompts).toEqual([
      expect.objectContaining({ kind: "manual_code", providerId: CLAUDE_PROVIDER_ID }),
    ]);
    expect(client.seen.pasted).toBe("good-code#s1");
    expect(existsSync(join(store, "credential"))).toBe(true);
  });

  it("adopts a login already there, and asks for nothing", async () => {
    const client = pasteClient();
    const store = accountDir("paste-live");
    writeFileSync(join(store, "credential"), "already-signed-in");
    const { relay, prompts } = pasting(async () => "unused");
    await login(computer(store, client.run), relay);
    expect(client.seen.logins).toBe(0);
    expect(prompts).toEqual([]);
  });

  it("signs in again over the refused sign-in with a pasted code, and records the login it made", async () => {
    const client = pasteClient();
    const store = accountDir("paste-again");
    writeFileSync(join(store, "credential"), "refused-by-anthropic");
    const vault = accountDir("paste-again-vault");
    const { relay, prompts } = pasting(async () => "good-code#s1");
    await computer(store, client.run).login({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_p",
      dir: vault,
      type: "oauth",
      bridge: relay,
      again: true,
    });
    expect(client.seen.logins).toBe(1);
    expect(client.seen.browser).toBe(NO_BROWSER);
    expect(prompts).toEqual([expect.objectContaining({ kind: "manual_code" })]);
    expect(existsSync(join(vault, MADE_LOGIN_FILE))).toBe(true);
  });

  it("adopts a login Claude says is there when the store reads as empty, and asks for nothing", async () => {
    const client = pasteClient({ elsewhere: true });
    const { relay, notices, prompts } = pasting(async () => "unused");
    await login(computer(accountDir("paste-elsewhere"), client.run), relay);
    // Nobody at that screen would see a login replaced, so none is.
    expect(client.seen.logins).toBe(0);
    expect(prompts).toEqual([]);
    expect(notices.map((notice) => notice.message)).toContain(
      "Using the Claude login on this computer.",
    );
  });

  it("starts no sign-in there when Claude cannot say whether it is signed in", async () => {
    const client = pasteClient({ silent: true });
    const { relay, prompts } = pasting(async () => "unused");
    await expect(login(computer(accountDir("paste-silent"), client.run), relay)).rejects.toThrow(
      CLAUDE_LOGIN_UNREADABLE_THERE_TEXT,
    );
    expect(client.seen.logins).toBe(0);
    expect(prompts).toEqual([]);
    expect(CLAUDE_LOGIN_UNREADABLE_THERE_TEXT).not.toMatch(/harness|keychain|cli|claude code/i);
  });

  it("refuses a store it cannot read there in words for that computer", async () => {
    const client = pasteClient();
    const backend = new ClaudeAuthBackend({
      run: client.run,
      available: () => true,
      readStore: async () => ({ state: "unreadable" }),
      configDir: () => accountDir("paste-unknown"),
      pasteCode: true,
    });
    const { relay } = pasting(async () => "unused");
    await expect(login(backend, relay)).rejects.toThrow(CLAUDE_LOGIN_UNREADABLE_THERE_TEXT);
    expect(client.seen.logins).toBe(0);
  });

  it("says Claude's own words when the pasted code is refused, and leaves no login", async () => {
    const client = pasteClient();
    const store = accountDir("paste-bad");
    const { relay } = pasting(async () => "wrong-code");
    await expect(login(computer(store, client.run), relay)).rejects.toThrow(
      "Login failed: Invalid authorization code",
    );
    expect(existsSync(join(store, "credential"))).toBe(false);
  });

  it("says the sign-in there did not finish and what to try when Claude gives no reason", async () => {
    const client = pasteClient({ unreachable: true });
    const store = accountDir("paste-unreachable");
    const { relay } = pasting(async () => "good-code#s1");
    await expect(login(computer(store, client.run), relay)).rejects.toMatchObject({
      message: CLAUDE_LOGIN_UNFINISHED_THERE_TEXT,
    });
    expect(client.seen.pasted).toBe("good-code#s1");
    expect(existsSync(join(store, "credential"))).toBe(false);
    expect(CLAUDE_LOGIN_UNFINISHED_THERE_TEXT).not.toMatch(/harness|keychain/i);
  });

  it("stops the client when the sign-in is stopped while it waits for the code", async () => {
    const client = pasteClient();
    const abort = new AbortController();
    const { relay } = pasting(
      () =>
        new Promise<string>((_resolve, reject) => {
          abort.signal.addEventListener("abort", () => reject(new Error("Sign in cancelled")));
        }),
    );
    const signingIn = login(computer(accountDir("paste-stop"), client.run), {
      ...relay,
      signal: abort.signal,
    });
    await vi.waitFor(() => expect(client.seen.logins).toBe(1));
    abort.abort();
    await expect(signingIn).rejects.toThrow("Sign in cancelled");
    expect(client.seen.pasted).toBeUndefined();
  });
});

describe("ClaudeAuthBackend on a computer that runs work: signing out the login it made", () => {
  const CODE_PAGE =
    "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s2";

  /**
   * Claude's client on a computer: a pasted code signs in as the account the
   * code belongs to, which the store names (`identity`, read back as the
   * stamp's login), and `auth logout` signs that login out.
   */
  function client(account = "account-a") {
    const seen = { logins: 0, logouts: 0, failLogout: false };
    const run: RunClaude = async (args, configDir, options) => {
      const marker = join(configDir, "credential");
      if (args[0] === "auth" && args[1] === "login") {
        seen.logins += 1;
        options?.onStdout?.(`If the browser didn't open, visit: ${CODE_PAGE}\n`);
        options?.onStdout?.("Paste code here if prompted > ");
        if ((await options?.paste) !== "good-code#s2") return { code: 1, stdout: "", stderr: "" };
        writeFileSync(marker, "opaque-credential-written-by-the-client");
        writeFileSync(join(configDir, "identity"), account);
        return { code: 0, stdout: "Login successful.", stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "logout") {
        seen.logouts += 1;
        if (!seen.failLogout) {
          writeFileSync(marker, "");
          rmSync(join(configDir, "identity"), { force: true });
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      const loggedIn = existsSync(marker) && readFileSync(marker, "utf8").length > 0;
      return { code: loggedIn ? 0 : 1, stdout: JSON.stringify({ loggedIn }), stderr: "" };
    };
    return { run, seen };
  }

  function computer(store: string, run: RunClaude) {
    return new ClaudeAuthBackend({
      run,
      available: () => true,
      readStore: async (dir) => {
        const read = await fakeStore(dir);
        if (read.state !== "present") return read;
        const identity = join(dir, "identity");
        return {
          ...read,
          identity: existsSync(identity) ? { accountUuid: readFileSync(identity, "utf8") } : {},
        };
      },
      configDir: () => store,
      pasteCode: true,
    });
  }

  const pasted: AuthInteractionBridge = {
    prompt: async () => "good-code#s2",
    notify: () => {},
    openExternal: async () => {},
  };

  /** The account's own folder in the computer's vault, which outlives one call. */
  function account() {
    return { providerId: CLAUDE_PROVIDER_ID, accountId: "acct_c", dir: accountDir("made-vault") };
  }

  const signedIn = async (backend: ClaudeAuthBackend, ref: ReturnType<typeof account>) =>
    (await backend.status(ref)).connected;

  it("signs out the login it made from a pasted code when its account is signed out", async () => {
    const { run, seen } = client();
    const store = accountDir("made");
    const backend = computer(store, run);
    const ref = account();
    await backend.login({ ...ref, type: "oauth", bridge: pasted });
    expect(await signedIn(backend, ref)).toBe(true);

    expect(await backend.logout(ref)).toEqual({ login: "signed-out" });
    expect(seen.logouts).toBe(1);
    expect(await signedIn(backend, ref)).toBe(false);
  });

  it("leaves a login that was there before it, and signs nothing out", async () => {
    const { run, seen } = client();
    const store = accountDir("adopted");
    writeFileSync(join(store, "credential"), "already-signed-in");
    writeFileSync(join(store, "identity"), "account-a");
    const backend = computer(store, run);
    const ref = account();
    await backend.login({ ...ref, type: "oauth", bridge: pasted });
    expect(seen.logins).toBe(0);

    expect(await backend.logout(ref)).toEqual({ login: "kept" });
    expect(seen.logouts).toBe(0);
    expect(await signedIn(backend, ref)).toBe(true);
  });

  it("leaves a login that took the place of the one it made", async () => {
    const { run, seen } = client();
    const store = accountDir("replaced");
    const backend = computer(store, run);
    const ref = account();
    await backend.login({ ...ref, type: "oauth", bridge: pasted });
    // The person signed in to Claude Code there with another account since.
    writeFileSync(join(store, "identity"), "account-b");

    expect(await backend.logout(ref)).toEqual({ login: "kept" });
    expect(seen.logouts).toBe(0);
    expect(await signedIn(backend, ref)).toBe(true);
  });

  it("signs nothing out when it cannot tell whose login is there", async () => {
    const { run, seen } = client();
    const store = accountDir("unknown");
    const backend = computer(store, run);
    const ref = account();
    await backend.login({ ...ref, type: "oauth", bridge: pasted });
    rmSync(join(store, "identity"));

    expect(await backend.logout(ref)).toEqual({ login: "not-signed-out" });
    expect(seen.logouts).toBe(0);
    expect(await signedIn(backend, ref)).toBe(true);
  });

  it("says it could not when the client leaves the login signed in", async () => {
    const { run, seen } = client();
    const store = accountDir("stuck");
    const backend = computer(store, run);
    const ref = account();
    await backend.login({ ...ref, type: "oauth", bridge: pasted });
    seen.failLogout = true;

    expect(await backend.logout(ref)).toEqual({ login: "not-signed-out" });
    expect(seen.logouts).toBe(1);
  });

  it("reads a login already signed out by hand as signed out, and runs nothing", async () => {
    const { run, seen } = client();
    const store = accountDir("gone");
    const backend = computer(store, run);
    const ref = account();
    await backend.login({ ...ref, type: "oauth", bridge: pasted });
    writeFileSync(join(store, "credential"), "");

    expect(await backend.logout(ref)).toEqual({ login: "signed-out" });
    expect(seen.logouts).toBe(0);
  });

  it("signs out, by its record alone, a login it made once that account's folder is gone", async () => {
    const { run, seen } = client();
    const store = accountDir("record");
    const backend = computer(store, run);
    const ref = account();
    await backend.login({ ...ref, type: "oauth", bridge: pasted });
    const kept = join(accountDir("kept"), "claude-login.json");
    renameSync(join(ref.dir, MADE_LOGIN_FILE), kept);

    expect(await backend.signOutMadeLogin(kept)).toBe("signed-out");
    expect(seen.logouts).toBe(1);
  });
});

describe("ClaudeAuthBackend health/renew", () => {
  beforeEach(() => {
    resetStoreLeasesForTest();
    clearClaudeCredentialCache();
  });
  afterEach(() => {
    clearKeychainLock();
    clearClaudeCredentialCache();
  });

  const ref = (dir: string) => ({
    providerId: CLAUDE_PROVIDER_ID,
    accountId: "acct_h",
    dir,
  });

  const credentialJson = (accessToken: string, expiresAt: number, refreshTokenExpiresAt?: number) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        expiresAt,
        ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
      },
    });

  it("INF-2320: keeps a saved token healthy inside the former proactive lead window", async () => {
    const now = 1_000_000;
    const store = accountDir("expiring");
    writeFileSync(join(store, "credential"), "opaque");
    writeFileSync(
      join(store, ".credentials.json"),
      credentialJson("tok", now + 60_000, now + 86_400_000),
    );
    const backend = new ClaudeAuthBackend({
      run: unspawnableClient,
      available: () => true,
      configDir: () => store,
      now: () => now,
    });
    const health = await backend.health(ref(store));
    expect(health.state).toBe("healthy");
    expect(health.expiresAt).toBe(now + 60_000);
    expect((await backend.status(ref(store))).connected).toBe(true);
  });

  it("sign-out forgets the remembered credential, so it never outlives the login", async () => {
    const store = accountDir("forget");
    let reads = 0;
    const keychain = {
      findGenericPassword: async () => ({ kind: "found", modifiedAt: "20260915183000Z" }) as const,
      readGenericPassword: async () => {
        reads += 1;
        return { kind: "value", value: credentialJson("kc-live", 9e15) } as const;
      },
    };
    const backend = new ClaudeAuthBackend({
      run: unspawnableClient,
      available: () => false,
      configDir: () => store,
      keychain,
    });
    // A quota tick reads the store once and remembers what it found.
    await readClaudeStore(store, { keychain, now: () => 1000 });
    await readClaudeStore(store, { keychain, now: () => 2000 });
    expect(reads).toBe(1);

    await backend.logout(ref(store));

    await readClaudeStore(store, { keychain, now: () => 3000 });
    expect(reads).toBe(2);
  });

  it("a not-yet-granted Keychain read is degraded, never needs_reauth", async () => {
    const store = accountDir("no-ui");
    const backend = new ClaudeAuthBackend({
      run: unspawnableClient,
      available: () => false,
      configDir: () => store,
      keychain: {
        findGenericPassword: async () => ({ kind: "found" }),
        readGenericPassword: async () => ({
          kind: "failed",
          code: -25308,
          message: "CSSMERR_CSP_NO_USER_INTERACTION",
        }),
      },
    });
    const health = await backend.health(ref(store));
    expect(health.state).toBe("degraded");
    expect(health.reason).toBe("keychain_needs_grant");
    expect((await backend.status(ref(store))).connected).toBe(true);
    expect((await backend.status(ref(store))).reason).not.toBe("unrenewable");
    expect(isKeychainLocked(store)).toBe(false);
  });

  it("renew reports renewed when the client actually rotates the store", async () => {
    const store = accountDir("renew");
    writeFileSync(join(store, ".credentials.json"), credentialJson("stale", 1000));
    const backend = new ClaudeAuthBackend({
      run: async (_args, configDir) => {
        writeFileSync(join(configDir, ".credentials.json"), credentialJson("fresh", 9e15));
        return { code: 0, stdout: "{}", stderr: "" };
      },
      available: () => true,
      configDir: () => store,
    });
    expect(await backend.renew(ref(store), "vendor_rejected")).toEqual({ outcome: "renewed" });
  });
});

// INF-2320: preserve honest outcomes from the retired ladder at the backend owner.
describe("the one idle client request", () => {
  beforeEach(() => {
    resetStoreLeasesForTest();
    clearClaudeCredentialCache();
  });
  const ref = (dir: string) => ({
    providerId: CLAUDE_PROVIDER_ID,
    accountId: "acct_recovery",
    dir,
  });
  const saved = {
    state: "present" as const,
    auth: { accessToken: "saved", expiresAt: 1000 },
    identity: {},
  };

  it.each(["absent", "unreadable"] as const)(
    "does not ask a client for a %s store",
    async (state) => {
      const run = vi.fn(unspawnableClient);
      const dir = accountDir("empty-recovery");
      const backend = new ClaudeAuthBackend({
        available: () => true,
        configDir: () => dir,
        run,
        readStore: async () => ({ state }),
      });
      expect(await backend.renew(ref(dir), "vendor_rejected")).toEqual({
        outcome: state === "absent" ? "no_credential" : "unreadable",
      });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("reports an unreadable post-request store, never an unchanged or renewed one", async () => {
    const dir = accountDir("unreadable-recovery");
    let read: ClaudeStoreRead = saved;
    const backend = new ClaudeAuthBackend({
      available: () => true,
      configDir: () => dir,
      readStore: async () => read,
      run: async () => {
        read = { state: "unreadable" };
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(await backend.renew(ref(dir), "vendor_rejected")).toEqual({ outcome: "unreadable" });
  });

  it("reports a client that cannot run as failed without trying another command", async () => {
    const dir = accountDir("failed-recovery");
    const run = vi.fn(unspawnableClient);
    const backend = new ClaudeAuthBackend({
      available: () => true,
      configDir: () => dir,
      readStore: async () => saved,
      run,
    });
    expect(await backend.renew(ref(dir), "vendor_rejected")).toEqual({ outcome: "failed" });
    expect(run).toHaveBeenCalledExactlyOnceWith(["auth", "status", "--json"], dir);
  });

  it("a failed exit with an unchanged store is not a completed refresh", async () => {
    const dir = accountDir("failed-exit");
    const backend = new ClaudeAuthBackend({
      available: () => true,
      configDir: () => dir,
      readStore: async () => saved,
      run: async () => ({ code: 1, stdout: "", stderr: "client failed" }),
    });
    expect(await backend.renew(ref(dir), "vendor_rejected")).toEqual({ outcome: "failed" });
  });

  it("spends at most one refresh for concurrent rejections, with no queue of duplicate requests", async () => {
    const dir = accountDir("concurrent-recovery");
    let read: ClaudeStoreRead = saved;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = vi.fn(async () => {
      started();
      await wait;
      read = { ...saved, auth: { accessToken: "fresh" } };
      return { code: 0, stdout: "{}", stderr: "" };
    });
    const backend = new ClaudeAuthBackend({
      available: () => true,
      configDir: () => dir,
      readStore: async () => read,
      run,
    });
    const first = backend.renew(ref(dir), "vendor_rejected");
    await ready;
    try {
      expect(await backend.renew(ref(dir), "vendor_rejected")).toEqual({
        outcome: "deferred_busy",
      });
      expect(await backend.renew(ref(dir), "vendor_rejected")).toEqual({
        outcome: "deferred_busy",
      });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect(await first).toEqual({ outcome: "renewed" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("parseStatus", () => {
  it("reads a signed-in store, with the plan named as the user knows it", () => {
    expect(
      parseStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "a@b.c",
          subscriptionType: "max",
        }),
      ),
    ).toEqual({ connected: true, authType: "oauth", identity: { label: "a@b.c", plan: "Max" } });
  });

  it("reads a signed-out store, and never guesses when the output is not JSON", () => {
    expect(parseStatus(JSON.stringify({ loggedIn: false }))).toEqual({ connected: false });
    expect(parseStatus("command not found")).toEqual({ connected: false });
    expect(parseStatus("")).toEqual({ connected: false });
  });

  it("passes through a plan it does not have a name for", () => {
    const status = parseStatus(
      JSON.stringify({ loggedIn: true, subscriptionType: "some_new_tier" }),
    );
    expect(status.identity?.plan).toBe("some_new_tier");
  });
});
