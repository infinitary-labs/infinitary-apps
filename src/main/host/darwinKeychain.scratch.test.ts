import { execFileSync, fork } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearClaudeCredentialCache,
  clearKeychainLock,
  readClaudeStore,
} from "@core/claude/claudeQuota";
import type { HostKeychain, HostKeychainQuery } from "@core/host";
import { afterAll, beforeAll, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createDarwinKeychain, openDarwinKeychainApiForTest } from "./darwinKeychain";
import { createKeychainUnlocker, type UnlockHelperProcess } from "./keychainUnlock";

/**
 * The locked-store Retry on the REAL Security.framework path, opt-in:
 *
 *   INFINITARY_SCRATCH_KEYCHAIN_PROBE=1 pnpm vitest run src/main/host/darwinKeychain.scratch.test.ts
 *
 * It creates a throwaway keychain in a temp dir, locks it, drives the quota
 * resolver over the real binding aimed at that one file, and deletes it. It
 * never touches the login keychain, and it keeps the store off the user's
 * search list: `security create-keychain` adds what it creates to the list
 * of whatever HOME it runs under, so every `security` call here runs with
 * HOME at a scratch dir, and the real list is compared before and after.
 *
 * The unlock helper is the app's own file, forked as a plain Node process
 * (the app forks it as an Electron utility process). On a LOCKED screen
 * macOS cannot draw the unlock dialog and the helper reports -60008; on an
 * unlocked screen the dialog really appears for the scratch store - type
 * the scratch password below or cancel it, and both pass. What fails is
 * the dead Retry: an instant -25293 from a process that never offered it.
 */
const enabled =
  process.platform === "darwin" && process.env.INFINITARY_SCRATCH_KEYCHAIN_PROBE === "1";
const out = process.env.INFINITARY_SCRATCH_KEYCHAIN_OUT;

const SCRATCH_PASSWORD = "infinitary-scratch";
const SERVICE = "Claude Code-credentials";
const ACCOUNT = "infinitary-scratch";
const HELPER = join(import.meta.dirname, "keychainUnlockHelper.ts");
/** errSecAuthFailed: the instant refusal of a process that may not show the dialog. */
const DEAD_RETRY = -25293;

let dir = "";
let home = "";
let keychainPath = "";
let searchListBefore = "";
const log: unknown[] = [];

function security(...args: string[]): string {
  return execFileSync("security", args, {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    stdio: "pipe",
  });
}

/** The user's REAL search list, read without the scratch HOME. */
function realSearchList(): string {
  return execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" });
}

function unlocked(): boolean {
  // Succeeds silently only on an unlocked keychain.
  try {
    security("show-keychain-info", keychainPath);
    return true;
  } catch {
    return false;
  }
}

function recorder(inner: HostKeychain): HostKeychain & { calls: string[] } {
  const calls: string[] = [];
  const record = (call: string, query: HostKeychainQuery, outcome: object, t0: number) => {
    calls.push(call);
    const shown = "value" in outcome ? { ...outcome, value: "<dummy, redacted>" } : outcome;
    log.push({
      call,
      interactive: query.interactive === true,
      outcome: shown,
      ms: Date.now() - t0,
    });
  };
  return {
    calls,
    findGenericPassword: async (query) => {
      const t0 = Date.now();
      const outcome = await inner.findGenericPassword(query);
      record("presence", query, outcome, t0);
      return outcome;
    },
    readGenericPassword: async (query) => {
      const t0 = Date.now();
      const outcome = await inner.readGenericPassword(query);
      record("value", query, outcome, t0);
      return outcome;
    },
    unlockKeychain: async (query) => {
      const t0 = Date.now();
      const outcome = (await inner.unlockKeychain?.(query)) ?? {
        kind: "failed" as const,
        message: "no unlock",
      };
      record("unlock", query, outcome, t0);
      return outcome;
    },
  };
}

beforeAll(() => {
  if (!enabled) return;
  dir = scratchDir("infinitary-kc-");
  home = join(dir, "home");
  mkdirSync(join(home, "Library", "Preferences"), { recursive: true });
  mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
  keychainPath = join(dir, "scratch.keychain-db");
  searchListBefore = realSearchList();
  security("create-keychain", "-p", SCRATCH_PASSWORD, keychainPath);
  security("set-keychain-settings", keychainPath);
  security(
    "add-generic-password",
    "-A",
    "-s",
    SERVICE,
    "-a",
    ACCOUNT,
    "-w",
    JSON.stringify({ claudeAiOauth: { accessToken: "dummy", expiresAt: 4102444800000 } }),
    keychainPath,
  );
  security("lock-keychain", keychainPath);
  expect(realSearchList()).toBe(searchListBefore);
});

afterAll(() => {
  if (!enabled) return;
  try {
    security("delete-keychain", keychainPath);
  } catch {}
  if (out) writeFileSync(out, `${JSON.stringify(log, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
  expect(realSearchList()).toBe(searchListBefore);
});

it.runIf(enabled)(
  "a Retry on a locked store offers the unlock dialog after a silent first touch, and recovers",
  async () => {
    const api = openDarwinKeychainApiForTest(keychainPath);
    const unlocker = createKeychainUnlocker({
      helperPath: HELPER,
      fork: (modulePath, args) =>
        fork(modulePath, args, { execArgv: [], stdio: "ignore" }) as UnlockHelperProcess,
      timeoutMs: 60_000,
    });
    const keychain = recorder(createDarwinKeychain(api, unlocker));
    const env = { USER: ACCOUNT };
    const configDir = join(dir, "claude");
    const step = async (label: string, allowPrompt: boolean) => {
      clearClaudeCredentialCache(configDir);
      log.push({ step: label, unlockedBefore: unlocked() });
      const result = await readClaudeStore(configDir, { keychain, env, allowPrompt });
      log.push({
        step: label,
        result: result.state === "present" ? { state: "present" } : result,
        unlockedAfter: unlocked(),
      });
      return result;
    };

    // The startup tick: this process's first touch of the store, silent.
    // It reports the lock without the VALUE read and without asking.
    const tick = await step("background tick, locked", false);
    expect(tick).toEqual({ state: "unreadable", reason: "keychain_locked" });
    expect(keychain.calls).toEqual(["presence"]);
    expect(unlocked()).toBe(false);

    // The dead Retry this fixes, reproduced in THIS process: an in-process
    // interactive read after the silent first touch fails at once.
    api.setUserInteractionAllowed(true);
    const t0 = Date.now();
    const inProcess = api.readGenericPassword(SERVICE, ACCOUNT);
    log.push({
      control: "in-process interactive read",
      status: inProcess.status,
      ms: Date.now() - t0,
    });
    expect(inProcess.status).toBe(DEAD_RETRY);

    // The Retry: the unlock runs in the helper, which can still show the dialog.
    keychain.calls.length = 0;
    const retry = await step("Retry, locked", true);
    const unlockEntry = log.findLast((entry) => (entry as { call?: string }).call === "unlock") as
      | { outcome: { kind: string; code?: number } }
      | undefined;
    expect(unlockEntry).toBeDefined();
    expect(unlockEntry?.outcome.code).not.toBe(DEAD_RETRY);
    if (unlockEntry?.outcome.kind === "unlocked") {
      // Someone typed the password into the dialog.
      expect(retry.state).toBe("present");
    } else {
      // Drawn-but-unanswerable (-60008, a locked screen) or cancelled (-128).
      expect(retry).toEqual({ state: "unreadable", reason: "keychain_locked" });
      expect(keychain.calls).toEqual(["presence", "unlock"]);
      // Stand-in for the person typing the password into the dialog.
      security("unlock-keychain", "-p", SCRATCH_PASSWORD, keychainPath);
      keychain.calls.length = 0;
      const recovered = await step("Retry, after the password", true);
      expect(recovered.state).toBe("present");
      // Already unlocked: no second dialog, and the read is Infinitary's own.
      expect(keychain.calls).toEqual(["presence", "value"]);
    }

    // Locked again: the next tick is silent again.
    security("lock-keychain", keychainPath);
    clearKeychainLock(configDir);
    keychain.calls.length = 0;
    const relocked = await step("background tick, locked again", false);
    expect(relocked).toEqual({ state: "unreadable", reason: "keychain_locked" });
    expect(keychain.calls).toEqual(["presence"]);
  },
  120_000,
);
