import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { KEYCHAIN_READ_INCOMPLETE_CODE, KEYCHAIN_VALUE_FAILURE_DETAIL } from "@shared/quota";
import { beforeEach, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { HostKeychain, HostKeychainQuery } from "../host";
import { ClaudeAuthBackend } from "./claudeAuth";
import {
  clearClaudeCredentialCache,
  clearKeychainLock,
  readClaudeCredentialEvidence,
  resolveClaudeQuotaAuthResult,
} from "./claudeQuota";

beforeEach(() => {
  clearKeychainLock();
  clearClaudeCredentialCache();
});

it("the 60s account health check leaves the remembered sign-in alone, so the next quota tick reads no Keychain VALUE", async () => {
  const home = scratchDir("infinitary-scratch-home-");
  const dir = join(home, ".claude");
  mkdirSync(dir);
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "u1" } }),
  );
  const env = { HOME: home, USER: "someone" };
  const reads: HostKeychainQuery[] = [];
  // The Mac's shape: no .credentials.json, a live Keychain item that is
  // never rewritten during the test.
  const keychain: HostKeychain = {
    findGenericPassword: async () => ({
      kind: "found",
      modifiedAt: "20261008073320Z",
      locked: false,
    }),
    readGenericPassword: async (query) => {
      reads.push(query);
      return {
        kind: "value",
        value: JSON.stringify({
          claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 },
        }),
      };
    },
  };
  // As services.ts calls it on every quota refresh.
  const quotaTick = () => resolveClaudeQuotaAuthResult(dir, { keychain, env });

  expect((await quotaTick()).status).toBe("resolved");
  expect(reads).toHaveLength(1);
  expect((await quotaTick()).status).toBe("resolved");
  expect(reads).toHaveLength(1); // remembered: no second VALUE read

  // The supervisor's 60s CredentialHealthService tick reads health().
  const backend = new ClaudeAuthBackend({
    available: () => true,
    run: () => Promise.reject(new Error("no client in scratch")),
    keychain,
    evidence: (d) => readClaudeCredentialEvidence(d, { keychain, env }),
    stamp: async () => ({}),
    configDir: () => dir,
  });
  await backend.health({ providerId: CLAUDE_PROVIDER_ID, accountId: "a", dir: home } as never);
  expect(reads).toHaveLength(1); // the health check itself reads no VALUE

  expect((await quotaTick()).status).toBe("resolved");
  expect(reads).toHaveLength(1); // still remembered: the health check did not wipe it
});

it("a read through Apple's tool that ran out of time is retried on the next tick, never held", async () => {
  const home = scratchDir("infinitary-scratch-home-");
  const dir = join(home, ".claude");
  mkdirSync(dir);
  const env = { HOME: home, USER: "someone" };
  let attempt = 0;
  const keychain: HostKeychain = {
    findGenericPassword: async () => ({
      kind: "found",
      modifiedAt: "20261008073320Z",
      locked: false,
    }),
    readGenericPassword: async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          kind: "failed",
          code: KEYCHAIN_READ_INCOMPLETE_CODE,
          message: "The read did not finish.",
        };
      }
      return {
        kind: "value",
        value: JSON.stringify({
          claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 },
        }),
      };
    },
  };
  const first = await resolveClaudeQuotaAuthResult(dir, { keychain, env });
  expect(first).toEqual({ status: "unavailable", reason: "keychain_read_incomplete" });
  expect(KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_read_incomplete).not.toMatch(/Always Allow/);
  expect((await resolveClaudeQuotaAuthResult(dir, { keychain, env })).status).toBe("resolved");
  expect(attempt).toBe(2);
});
