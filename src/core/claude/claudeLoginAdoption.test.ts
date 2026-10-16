import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthNotice } from "@shared/providers";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { HostKeychain, HostKeychainOutcome, HostKeychainQuery } from "../host";
import type { AuthInteractionBridge } from "../pi/piAuth";
import { CLAUDE_LOGIN_UNREADABLE_TEXT, ClaudeAuthBackend } from "./claudeAuth";
import type { RunClaude } from "./claudeCli";
import { keychainAccountName, readClaudeCredentialEvidence } from "./claudeQuota";
import { resetStoreLeasesForTest, runExclusiveStoreTask } from "./claudeStoreLease";

/**
 * Connecting Claude adopts a usable default login and starts a replacement
 * only from current, consistent evidence. These cases exercise that decision
 * through the account backend and the evidence reader, with injected clients
 * and Keychain answers under a scratch home. They never touch a real
 * credential or Keychain.
 */

const ENV = { HOME: "", USER: "kun" };

function home(): { home: string; dir: string; env: NodeJS.ProcessEnv } {
  const root = scratchDir("infinitary-claude-adopt-");
  const dir = join(root, ".claude");
  mkdirSync(dir, { mode: 0o700 });
  return { home: root, dir, env: { ...ENV, HOME: root } };
}

function bridge(): AuthInteractionBridge & { notices: AuthNotice[] } {
  const notices: AuthNotice[] = [];
  return {
    notices,
    prompt: async () => "unused",
    notify: (notice) => notices.push(notice),
    openExternal: async () => {
      throw new Error("the decision must not open a browser");
    },
  };
}

function loginOf(backend: ClaudeAuthBackend, relay: AuthInteractionBridge) {
  return backend.login({
    providerId: CLAUDE_PROVIDER_ID,
    accountId: "acct_adopt",
    dir: scratchDir("infinitary-claude-adopt-vault-"),
    type: "oauth",
    bridge: relay,
  });
}

function keychain(find: HostKeychainOutcome): HostKeychain & {
  finds: HostKeychainQuery[];
  reads: number;
} {
  const found: HostKeychain & { finds: HostKeychainQuery[]; reads: number } = {
    finds: [],
    reads: 0,
    findGenericPassword: async (query) => {
      found.finds.push(query);
      return find;
    },
    readGenericPassword: async () => {
      found.reads += 1;
      return { kind: "absent" };
    },
  };
  return found;
}

function lapsedFile(dir: string): void {
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "stale", expiresAt: 1, refreshTokenExpiresAt: 1 },
    }),
  );
}

function client(signedIn: boolean): { run: RunClaude; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunClaude = async (args) => {
    calls.push(args);
    if (args[1] === "login") return { code: 0, stdout: "", stderr: "" };
    return {
      code: signedIn ? 0 : 1,
      stdout: JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? "claude.ai" : "none" }),
      stderr: "",
    };
  };
  return { run, calls };
}

function backendFor(
  dir: string,
  env: NodeJS.ProcessEnv,
  passwords: ReturnType<typeof keychain>,
  run: RunClaude,
): ClaudeAuthBackend {
  return new ClaudeAuthBackend({
    run,
    available: () => true,
    keychain: passwords,
    primeKeychain: async () => {},
    configDir: () => dir,
    evidence: (configDir) => readClaudeCredentialEvidence(configDir, { keychain: passwords, env }),
  });
}

describe("Claude connect adopts a usable default login", () => {
  it("asks Claude before a lookup miss and adopts a signed-in answer", async () => {
    const { dir, env } = home();
    const passwords = keychain({ kind: "absent" });
    const claude = client(true);
    const relay = bridge();

    await loginOf(backendFor(dir, env, passwords, claude.run), relay);

    expect(claude.calls.some((args) => args[1] === "login")).toBe(false);
    expect(claude.calls[0]).toEqual(["auth", "status", "--json"]);
    expect(relay.notices.map((notice) => notice.message).join(" ")).toMatch(
      /login on this computer/i,
    );
    expect(passwords.finds).toEqual([
      { service: "Claude Code-credentials", account: keychainAccountName(env) },
    ]);
    expect(passwords.reads).toBe(0);
  });

  it("adopts a present Keychain item hidden by a lapsed credential file", async () => {
    const { dir, env } = home();
    lapsedFile(dir);
    const passwords = keychain({ kind: "found" });
    const claude = client(false);
    const relay = bridge();
    const backend = backendFor(dir, env, passwords, claude.run);

    expect(await readClaudeCredentialEvidence(dir, { keychain: passwords, env })).toEqual({
      state: "live",
    });
    await loginOf(backend, relay);

    expect(claude.calls).toEqual([]);
    expect(relay.notices.map((notice) => notice.message).join(" ")).toMatch(
      /login on this computer/i,
    );
    expect(passwords.finds.every((query) => query.service === "Claude Code-credentials")).toBe(
      true,
    );
    expect(passwords.finds.every((query) => query.account === "kun")).toBe(true);
    expect(passwords.reads).toBe(0);
    const health = await backend.health({
      providerId: CLAUDE_PROVIDER_ID,
      accountId: "acct_adopt",
      dir,
    });
    expect(health.state).not.toBe("needs_reauth");
  });

  it("does not replace a login whose file cannot be read", async () => {
    const { dir, env } = home();
    writeFileSync(join(dir, ".credentials.json"), "{not json");
    expect(
      await readClaudeCredentialEvidence(dir, { keychain: keychain({ kind: "absent" }), env }),
    ).toEqual({ state: "unknown" });

    const signedIn = client(true);
    const relay = bridge();
    await loginOf(backendFor(dir, env, keychain({ kind: "absent" }), signedIn.run), relay);
    expect(signedIn.calls.some((args) => args[1] === "login")).toBe(false);
    expect(relay.notices.map((notice) => notice.message).join(" ")).toMatch(
      /login on this computer/i,
    );

    const signedOut = client(false);
    await expect(
      loginOf(backendFor(dir, env, keychain({ kind: "absent" }), signedOut.run), bridge()),
    ).rejects.toThrow(CLAUDE_LOGIN_UNREADABLE_TEXT);
    expect(signedOut.calls.some((args) => args[1] === "login")).toBe(false);
  });

  it("treats a directory where the credential file should be as unreadable", async () => {
    const { dir, env } = home();
    mkdirSync(join(dir, ".credentials.json"));
    expect(
      await readClaudeCredentialEvidence(dir, { keychain: keychain({ kind: "absent" }), env }),
    ).toEqual({ state: "unknown" });
  });

  it("still starts a sign-in when the refresh token has lapsed in both stores", async () => {
    const { dir, env } = home();
    lapsedFile(dir);
    const calls: string[][] = [];
    const run: RunClaude = async (args, configDir) => {
      calls.push(args);
      if (args[1] === "login") {
        writeFileSync(
          join(configDir, ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: { accessToken: "fresh", refreshTokenExpiresAt: 9e15 },
          }),
        );
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
    };
    expect(
      await readClaudeCredentialEvidence(dir, { keychain: keychain({ kind: "absent" }), env }),
    ).toEqual({ state: "unrenewable" });

    await loginOf(backendFor(dir, env, keychain({ kind: "absent" }), run), bridge());
    expect(calls.some((args) => args[1] === "login")).toBe(true);
    expect(calls[0]).toEqual(["auth", "status", "--json"]);
  });

  it("does not start a sign-in when the store becomes unreadable while it waits", async () => {
    resetStoreLeasesForTest();
    const { dir } = home();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = runExclusiveStoreTask(dir, () => held);
    let unreadable = false;
    const claude = client(false);
    const backend = new ClaudeAuthBackend({
      run: claude.run,
      available: () => true,
      primeKeychain: async () => {},
      configDir: () => dir,
      evidence: async () => (unreadable ? { state: "unknown" } : { state: "absent" }),
    });
    const pending = loginOf(backend, bridge());
    unreadable = true;
    release();
    await expect(pending).rejects.toThrow(CLAUDE_LOGIN_UNREADABLE_TEXT);
    expect(claude.calls.some((args) => args[1] === "login")).toBe(false);
    await blocker;
  });
});
