import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { HostKeychain } from "../host";
import {
  claudeCredentialStamp,
  clearClaudeCredentialCache,
  clearKeychainLock,
  readClaudeStore,
} from "./claudeQuota";

// INF-2318, approved slim step 2: one present/absent/unreadable reading,
// current identity and modification-date caching, not a saved-expiry verdict.
beforeEach(() => {
  clearClaudeCredentialCache();
  clearKeychainLock();
});

function store() {
  const home = scratchDir("infinitary-claude-store-");
  const dir = join(home, ".claude");
  mkdirSync(dir);
  return { home, dir, env: { HOME: home, USER: "reader" } };
}

function credential(accessToken: string, expiresAt: number) {
  return JSON.stringify({ claudeAiOauth: { accessToken, expiresAt, refreshTokenExpiresAt: 1 } });
}

it("returns the current file credential and account together after either file changes", async () => {
  const { home, dir, env } = store();
  const config = join(home, ".claude.json");
  const file = join(dir, ".credentials.json");
  const firstAccount = {
    emailAddress: "alex.one@example.com",
    accountUuid: "account-one",
    organizationUuid: "personal",
  };
  const nextAccount = {
    emailAddress: "alex.two@example.com",
    accountUuid: "account-two",
    organizationUuid: "personal",
  };
  writeFileSync(file, credential("first-test-token", 1000));
  writeFileSync(config, JSON.stringify({ oauthAccount: firstAccount }));
  utimesSync(file, 100, 100);
  utimesSync(config, 100, 100);
  const first = await readClaudeStore(dir, { env, now: () => 2000 });
  expect(first).toMatchObject({
    state: "present",
    auth: { accessToken: "first-test-token", expiresAt: 1000 },
    identity: { label: firstAccount.emailAddress, accountUuid: firstAccount.accountUuid },
  });
  // A config-only change must not leave the old name beside the current store.
  writeFileSync(config, JSON.stringify({ oauthAccount: nextAccount }));
  utimesSync(config, 200, 200);
  expect(await readClaudeStore(dir, { env, now: () => 2000 })).toMatchObject({
    state: "present",
    identity: { label: nextAccount.emailAddress, accountUuid: nextAccount.accountUuid },
  });
  writeFileSync(file, credential("second-test-token", 3000));
  utimesSync(file, 200, 200);
  expect(await readClaudeStore(dir, { env, now: () => 2000 })).toMatchObject({
    state: "present",
    auth: { accessToken: "second-test-token", expiresAt: 3000 },
    identity: { label: nextAccount.emailAddress },
  });
});

it("shares a silent Keychain read and keeps its value through access expiry until the item changes", async () => {
  const { dir, env } = store();
  let modifiedAt = "20261102190000Z";
  let token = "first-test-token";
  let reads = 0;
  const keychain: HostKeychain = {
    findGenericPassword: async () => ({ kind: "found", account: env.USER, modifiedAt }),
    readGenericPassword: async (query) => {
      expect(query.interactive).not.toBe(true);
      reads++;
      return { kind: "value", value: credential(token, 1000) };
    },
  };
  const read = () => readClaudeStore(dir, { env, keychain, now: () => 2000 });
  const [health, allowance] = await Promise.all([read(), read()]);
  expect(health).toMatchObject({ state: "present", auth: { accessToken: token, expiresAt: 1000 } });
  expect(allowance).toEqual(health);
  expect(reads).toBe(1);
  expect(await read()).toEqual(health);
  expect(reads).toBe(1);
  token = "second-test-token";
  modifiedAt = "20261102190100Z";
  expect(await read()).toMatchObject({ state: "present", auth: { accessToken: token } });
  expect(reads).toBe(2);
});

it("distinguishes an empty store from malformed files and failed or declined Keychain reads", async () => {
  const { dir, env } = store();
  expect(await readClaudeStore(dir, { env })).toEqual({ state: "absent" });
  writeFileSync(join(dir, ".credentials.json"), "{incomplete");
  expect(await readClaudeStore(dir, { env })).toEqual({ state: "unreadable" });
  const keychain: HostKeychain = {
    findGenericPassword: async () => ({ kind: "found", modifiedAt: "20261102190000Z" }),
    readGenericPassword: async () => ({ kind: "failed", code: -128, message: "User canceled" }),
  };
  expect(await readClaudeStore(dir, { env, keychain })).toEqual({
    state: "unreadable",
    reason: "keychain_access_denied",
  });
  const failed: HostKeychain = {
    findGenericPassword: async () => {
      throw new Error("Service unavailable");
    },
    readGenericPassword: async () => {
      throw new Error("Must not reach the value");
    },
  };
  expect(await readClaudeStore(dir, { env, keychain: failed })).toEqual({
    state: "unreadable",
    reason: "keychain_unavailable",
  });
});

// The captain kept real-refusal records: their existing file-first date must not change
// just because the consolidated reader selects a working Keychain credential.
it("keeps the refusal record's file date when a malformed sidecar accompanies a readable Keychain", async () => {
  const { dir, env } = store();
  const file = join(dir, ".credentials.json");
  writeFileSync(file, "{incomplete");
  const writtenSeconds = 2000;
  utimesSync(file, writtenSeconds, writtenSeconds);
  const keychain: HostKeychain = {
    findGenericPassword: async () => ({ kind: "found", modifiedAt: "20261102190000Z" }),
    readGenericPassword: async () => ({
      kind: "value",
      value: credential("keychain-test-token", 1000),
    }),
  };
  const read = await readClaudeStore(dir, { env, keychain });
  expect(read).toMatchObject({ state: "present", auth: { accessToken: "keychain-test-token" } });
  expect(claudeCredentialStamp(read)).toEqual({ written: `file:${writtenSeconds * 1000}` });
});
