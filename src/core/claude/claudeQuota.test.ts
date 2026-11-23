import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type {
  HostKeychain,
  HostKeychainOutcome,
  HostKeychainQuery,
  HostKeychainUnlockOutcome,
} from "../host";
import { ClaudeAuthBackend } from "./claudeAuth";
import {
  classifyKeychainValueError,
  claudeCredentialStamp,
  clearClaudeCredentialCache,
  clearKeychainLock,
  defaultClaudeConfigDir,
  isKeychainLocked,
  keychainAccountName,
  keychainServiceFor,
  readClaudeStore,
} from "./claudeQuota";
import { resetStoreLeasesForTest } from "./claudeStoreLease";

const credentialJson = (accessToken: string, expiresAt?: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken, ...(expiresAt ? { expiresAt } : {}) } });

function storeDir(): string {
  return scratchDir("infinitary-claude-quota-");
}

function storeWithHomeIdentity(accountUuid: string): { home: string; dir: string } {
  const home = scratchDir("infinitary-claude-home-");
  const dir = join(home, ".claude");
  mkdirSync(dir);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid } }));
  return { home, dir };
}

function fakeKeychain(control: {
  find?: HostKeychainOutcome | ((query: HostKeychainQuery) => HostKeychainOutcome);
  read?: HostKeychainOutcome | ((query: HostKeychainQuery) => HostKeychainOutcome);
  /** Present only when the fake host can unlock (the app's host can). */
  unlock?: (query: HostKeychainQuery) => HostKeychainUnlockOutcome;
}): HostKeychain & {
  finds: HostKeychainQuery[];
  reads: HostKeychainQuery[];
  unlocks: HostKeychainQuery[];
} {
  const finds: HostKeychainQuery[] = [];
  const reads: HostKeychainQuery[] = [];
  const unlocks: HostKeychainQuery[] = [];
  const resolve = (
    spec: HostKeychainOutcome | ((query: HostKeychainQuery) => HostKeychainOutcome) | undefined,
    fallback: HostKeychainOutcome,
    query: HostKeychainQuery,
  ): HostKeychainOutcome => {
    if (spec === undefined) return fallback;
    return typeof spec === "function" ? spec(query) : spec;
  };
  const unlock = control.unlock;
  return {
    finds,
    reads,
    unlocks,
    findGenericPassword: async (query) => {
      finds.push(query);
      return resolve(control.find, { kind: "found" }, query);
    },
    readGenericPassword: async (query) => {
      reads.push(query);
      return resolve(control.read, { kind: "absent" }, query);
    },
    ...(unlock
      ? {
          unlockKeychain: async (query: HostKeychainQuery) => {
            unlocks.push(query);
            return unlock(query);
          },
        }
      : {}),
  };
}

describe("keychain naming", () => {
  it("reads the bare machine-default item, never a per-account suffix", () => {
    expect(keychainServiceFor()).toBe("Claude Code-credentials");
    // Two config roots used to be two items; CD-1=B is one login on the Mac.
    expect(keychainServiceFor()).toBe(keychainServiceFor());
  });

  it("resolves the default config root from HOME, never a vault account dir", () => {
    expect(defaultClaudeConfigDir({ HOME: "/tmp/throwaway-home" })).toBe(
      "/tmp/throwaway-home/.claude",
    );
  });

  it("uses the safe account fallback when USER is unusable", () => {
    expect(keychainAccountName({ USER: "kun" })).toBe("kun");
    expect(keychainAccountName({ USER: "bad name with spaces!!" })).toBe("claude-code-user");
  });
});

/**
 * INF-1798: on a real Mac the client's item was keyed on account "unknown"
 * (the client runs on Bun, whose userInfo() names an unset USER that way)
 * while the app ran as USER "kunchen", so every check that asked for
 * "kunchen" alone read a signed-in Mac as signed out. The item is found
 * whatever its account, and every later read names that one item.
 */
describe("the client's item under an account other than USER", () => {
  const SERVICE = "Claude Code-credentials";
  const env = { HOME: "/tmp/infinitary-no-claude-home", USER: "kunchen" };

  function savedPasswords(items: Record<string, string>) {
    const found = (account: string | undefined): HostKeychainOutcome =>
      account !== undefined && account in items
        ? { kind: "found", modifiedAt: "20261028213000Z", locked: false, account }
        : { kind: "absent" };
    return fakeKeychain({
      find: (query) => found(query.account ?? Object.keys(items)[0]),
      read: (query) => {
        const value = query.account === undefined ? undefined : items[query.account];
        return value === undefined ? { kind: "absent" } : { kind: "value", value };
      },
    });
  }

  beforeEach(() => {
    clearKeychainLock();
    clearClaudeCredentialCache();
  });

  it("reads the current login through its found item", async () => {
    const keychain = savedPasswords({ unknown: credentialJson("client-token") });
    expect(await readClaudeStore(storeDir(), { keychain, env })).toMatchObject({
      state: "present",
    });
    expect(keychain.finds).toEqual([
      { service: SERVICE, account: "kunchen" },
      { service: SERVICE },
    ]);
    expect(keychain.reads).toHaveLength(1);
  });

  it("reads that one item's value for the meter, by the account presence found", async () => {
    const keychain = savedPasswords({ unknown: credentialJson("client-token", 4102444800000) });
    expect(await readClaudeStore(storeDir(), { keychain, env })).toMatchObject({
      state: "present",
      auth: { accessToken: "client-token", expiresAt: 4102444800000 },
    });
    expect(keychain.reads).toEqual([{ service: SERVICE, account: "unknown" }]);
  });

  it("dates it for the cut-off stamp", async () => {
    const keychain = savedPasswords({ unknown: credentialJson("client-token") });
    expect(
      await readClaudeStore(storeDir(), { keychain, env }).then(claudeCredentialStamp),
    ).toEqual({
      written: "keychain:20261028213000Z",
    });
  });

  it("prefers the item under USER when both are there, as the client running with that USER does", async () => {
    const keychain = savedPasswords({
      unknown: credentialJson("other-token"),
      kunchen: credentialJson("user-token"),
    });
    expect(await readClaudeStore(storeDir(), { keychain, env })).toMatchObject({
      state: "present",
      auth: { accessToken: "user-token" },
    });
    expect(keychain.finds).toEqual([{ service: SERVICE, account: "kunchen" }]);
    expect(keychain.reads).toEqual([{ service: SERVICE, account: "kunchen" }]);
  });
});

describe("readClaudeStore", () => {
  beforeEach(() => {
    clearKeychainLock();
    clearClaudeCredentialCache();
  });

  it("reads the plain-file store first and never touches the Keychain", async () => {
    const dir = storeDir();
    writeFileSync(join(dir, ".credentials.json"), credentialJson("tok-1"));
    const keychain = fakeKeychain({});
    const auth = await readClaudeStore(dir, { keychain }).then((read) =>
      read.state === "present" ? read.auth : undefined,
    );
    expect(auth).toEqual({ accessToken: "tok-1" });
    expect(keychain.finds).toHaveLength(0);
    expect(keychain.reads).toHaveLength(0);
  });

  it("returns nothing for an empty store (no ask, no invention)", async () => {
    const keychain = fakeKeychain({ find: { kind: "absent" } });
    const auth = await readClaudeStore(storeDir(), { keychain }).then((read) =>
      read.state === "present" ? read.auth : undefined,
    );
    expect(auth).toBeUndefined();
  });

  it("the Keychain read routes through the host capability: presence first, value second", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({
      read: { kind: "value", value: `${credentialJson("kc-token")}\n` },
    });
    const auth = await readClaudeStore(dir, { keychain, env: { USER: "kun" } }).then((read) =>
      read.state === "present" ? read.auth : undefined,
    );
    expect(auth).toEqual({ accessToken: "kc-token" });
    expect(keychain.finds).toEqual([{ service: "Claude Code-credentials", account: "kun" }]);
    expect(keychain.reads).toEqual([{ service: "Claude Code-credentials", account: "kun" }]);
  });

  it("a declined value read is locked with a reason, not a silent empty store", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({
      read: { kind: "failed", code: -128, message: "User canceled the request." },
    });
    const result = await readClaudeStore(dir, { keychain, env: { USER: "kun" } });
    expect(result).toEqual({ state: "unreadable", reason: "keychain_access_denied" });
    expect(isKeychainLocked(dir)).toBe(true);
  });

  it("does not re-ask from a background read after a decline (CL-C)", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({
      read: { kind: "failed", code: -128, message: "User canceled the request." },
    });
    expect(
      await readClaudeStore(dir, { keychain }).then((read) =>
        read.state === "present" ? read.auth : undefined,
      ),
    ).toBeUndefined();
    expect(
      await readClaudeStore(dir, { keychain }).then((read) =>
        read.state === "present" ? read.auth : undefined,
      ),
    ).toBeUndefined();
    expect(keychain.reads).toHaveLength(1);
  });

  it("a rewritten store gets one fresh background read after a decline, and a decline there locks again", async () => {
    const dir = storeDir();
    let modifiedAt = "2026-10-02T11:00:00Z";
    let allow = false;
    const keychain = fakeKeychain({
      find: () => ({ kind: "found", modifiedAt }),
      read: () =>
        allow
          ? { kind: "value", value: credentialJson("kc-new-login") }
          : { kind: "failed", code: -128, message: "User canceled the request." },
    });
    const ask = () => readClaudeStore(dir, { keychain, env: { USER: "kun" } });
    expect(await ask()).toEqual({ state: "unreadable", reason: "keychain_access_denied" });
    // The same store: no second ask until Retry.
    expect(await ask()).toEqual({ state: "unreadable", reason: "keychain_access_denied" });
    expect(keychain.reads).toHaveLength(1);

    // A swapped login rewrites the item: one background read, never a prompt,
    // and a decline locks the new item until Retry.
    modifiedAt = "2026-10-02T11:57:00Z";
    expect(await ask()).toEqual({ state: "unreadable", reason: "keychain_access_denied" });
    expect(keychain.reads).toHaveLength(2);
    expect(keychain.reads[1]?.interactive).toBeUndefined();
    expect(await ask()).toEqual({ state: "unreadable", reason: "keychain_access_denied" });
    expect(keychain.reads).toHaveLength(2);

    // Another rewrite the client can read: the meter comes back with no Retry.
    modifiedAt = "2026-10-02T11:58:00Z";
    allow = true;
    expect(await ask()).toMatchObject({ state: "present", auth: { accessToken: "kc-new-login" } });
    expect(isKeychainLocked(dir)).toBe(false);
  });

  it("a decline followed by a retry that succeeds is a working credential, not a dead meter", async () => {
    const dir = storeDir();
    let allow = false;
    const keychain = fakeKeychain({
      read: () => {
        if (!allow) return { kind: "failed", code: -128, message: "User canceled the request." };
        return { kind: "value", value: credentialJson("kc-retry") };
      },
    });
    const declined = await readClaudeStore(dir, { keychain, env: { USER: "kun" } });
    expect(declined).toEqual({ state: "unreadable", reason: "keychain_access_denied" });
    expect(await readClaudeStore(dir, { keychain, env: { USER: "kun" } })).toEqual({
      state: "unreadable",
      reason: "keychain_access_denied",
    });
    expect(keychain.reads).toHaveLength(1);

    allow = true;
    const retried = await readClaudeStore(dir, {
      keychain,
      env: { USER: "kun" },
      allowPrompt: true,
    });
    expect(retried).toMatchObject({ state: "present", auth: { accessToken: "kc-retry" } });
    expect(keychain.reads).toHaveLength(2);
    expect(keychain.reads[1]?.interactive).toBe(true);
    expect(isKeychainLocked(dir)).toBe(false);
  });

  it("a presence-probe error that is not errSecItemNotFound is locked, not absent", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({
      find: { kind: "failed", message: "timed out" },
    });
    const result = await readClaudeStore(dir, { keychain, env: { USER: "kun" } });
    expect(result).toEqual({ state: "unreadable", reason: "keychain_prompt_timeout" });
    // INF-3307 audit: unreadable, but not a held lock - no dialog was declined.
    expect(isKeychainLocked(dir)).toBe(false);
  });

  it("INF-3307 audit: one failed presence read does not hold background reads until Retry", async () => {
    const dir = storeDir();
    let presenceFails = true;
    const keychain = fakeKeychain({
      find: () =>
        presenceFails
          ? { kind: "failed", message: "timed out" }
          : { kind: "found", modifiedAt: "20261110093000Z", locked: false },
      read: { kind: "value", value: credentialJson("kc-after-blip") },
    });
    const tick = () => readClaudeStore(dir, { keychain, env: { USER: "kun" } });
    expect(await tick()).toEqual({ state: "unreadable", reason: "keychain_prompt_timeout" });

    // The attribute read asks nobody, so nothing was declined: the next
    // background tick reads again and the meter comes back with no Retry.
    presenceFails = false;
    expect(await tick()).toMatchObject({
      state: "present",
      auth: { accessToken: "kc-after-blip" },
    });
    expect(keychain.reads).toHaveLength(1);
    expect(keychain.reads[0]?.interactive).toBeUndefined();
  });

  it("an unparseable Keychain value is a read failure, not an empty store", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({ read: { kind: "value", value: "not-json" } });
    const result = await readClaudeStore(dir, { keychain, env: { USER: "kun" } });
    expect(result).toEqual({ state: "unreadable", reason: "keychain_unreadable" });
    expect(isKeychainLocked(dir)).toBe(true);
  });

  // INF-6273 reproduced both on a Mac with Claude Code's own leftovers: a
  // sign-out keeps a remote-device key and drops the login (G), and a refused
  // renewal blanks the login's tokens in place (H). Either is no login.
  it.each([
    ["only a remote-device key", { coworkRemoteDevice: { deviceId: "device-1", key: "k" } }],
    [
      "a login Claude blanked",
      { claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] } },
    ],
  ])("a Keychain value holding %s is absent, not a held lock", async (_shape, leftover) => {
    const dir = storeDir();
    const keychain = fakeKeychain({ read: { kind: "value", value: JSON.stringify(leftover) } });
    const result = await readClaudeStore(dir, { keychain, env: { USER: "kun" } });
    expect(result).toEqual({ state: "absent" });
    expect(isKeychainLocked(dir)).toBe(false);
  });

  it("a no-interactive-session probe is retryable and never a held lock", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({
      find: {
        kind: "failed",
        code: -25308,
        message: "User interaction is not allowed.",
      },
    });
    const first = await readClaudeStore(dir, { keychain, env: { USER: "kun" } });
    expect(first).toEqual({
      state: "unreadable",
      reason: "keychain_no_interactive_session",
    });
    expect(isKeychainLocked(dir)).toBe(false);
    const second = await readClaudeStore(dir, { keychain, env: { USER: "kun" } });
    expect(second).toEqual(first);
    expect(keychain.finds).toHaveLength(2);
  });

  it("a blocked VALUE read followed by a retry that succeeds is a working credential", async () => {
    const dir = storeDir();
    let allow = false;
    const keychain = fakeKeychain({
      read: () => {
        if (!allow) {
          return { kind: "failed", code: -25308, message: "User interaction is not allowed." };
        }
        return { kind: "value", value: credentialJson("kc-session") };
      },
    });
    // A background read suppresses the dialog itself, so this status means
    // "not granted yet", not "this session has no dialogs".
    const blocked = await readClaudeStore(dir, { keychain, env: { USER: "kun" } });
    expect(blocked).toEqual({
      state: "unreadable",
      reason: "keychain_needs_grant",
    });
    expect(isKeychainLocked(dir)).toBe(false);
    allow = true;
    const retried = await readClaudeStore(dir, {
      keychain,
      env: { USER: "kun" },
    });
    expect(retried).toMatchObject({ state: "present", auth: { accessToken: "kc-session" } });
  });

  it("the same status on a read that DID permit the dialog is a real session failure", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({
      read: { kind: "failed", code: -25308, message: "User interaction is not allowed." },
    });
    // allowPrompt let the host present a dialog and macOS still could not:
    // this is the SSH / non-Aqua case the "relaunch from the Dock" copy is for.
    const result = await readClaudeStore(dir, {
      keychain,
      env: { USER: "kun" },
      allowPrompt: true,
    });
    expect(result).toEqual({
      state: "unreadable",
      reason: "keychain_no_interactive_session",
    });
  });

  it("classifies errSecInteractionRequired alongside errSecInteractionNotAllowed", () => {
    // Newer macOS reports the suppressed-dialog refusal as -25315. Before this
    // it fell through to keychain_unavailable and lost the one distinction
    // that decides whether Retry can fix the row.
    expect(classifyKeychainValueError({ code: -25315, message: "Interaction required." })).toBe(
      "keychain_no_interactive_session",
    );
  });

  it("classifies a killed value read as a timeout and a canceled dialog as denied", () => {
    expect(classifyKeychainValueError({ killed: true, message: "timeout" })).toBe(
      "keychain_prompt_timeout",
    );
    expect(classifyKeychainValueError({ code: -128, message: "User canceled the request." })).toBe(
      "keychain_access_denied",
    );
    expect(classifyKeychainValueError(new Error("security: mysterious failure"))).toBe(
      "keychain_unavailable",
    );
    expect(
      classifyKeychainValueError(
        Object.assign(new Error("User interaction is not allowed."), { code: -25308 }),
      ),
    ).toBe("keychain_no_interactive_session");
    expect(classifyKeychainValueError(new Error("CSSMERR_CSP_NO_USER_INTERACTION"))).toBe(
      "keychain_no_interactive_session",
    );
  });

  it("prefers the Keychain over an expired sidecar - the client keeps it authoritative", async () => {
    const dir = storeDir();
    writeFileSync(join(dir, ".credentials.json"), credentialJson("stale-sidecar", 1000));
    const keychain = fakeKeychain({
      read: { kind: "value", value: credentialJson("live-keychain", 9e15) },
    });
    const auth = await readClaudeStore(dir, { keychain, now: () => 2000 }).then((read) =>
      read.state === "present" ? read.auth : undefined,
    );
    expect(auth?.accessToken).toBe("live-keychain");
  });

  it("keeps the sidecar when the Keychain has nothing newer", async () => {
    const dir = storeDir();
    writeFileSync(join(dir, ".credentials.json"), credentialJson("only-sidecar", 1000));
    const keychain = fakeKeychain({ find: { kind: "absent" } });
    const auth = await readClaudeStore(dir, { keychain, now: () => 2000 }).then((read) =>
      read.state === "present" ? read.auth : undefined,
    );
    expect(auth?.accessToken).toBe("only-sidecar");
  });

  it("spends the macOS ask only when the Keychain could change the answer", async () => {
    const dir = storeDir();
    writeFileSync(join(dir, ".credentials.json"), credentialJson("live", 9e15));
    const keychain = fakeKeychain({
      read: { kind: "value", value: credentialJson("kc", 9e15) },
    });
    await readClaudeStore(dir, { keychain, now: () => 2000 }).then((read) =>
      read.state === "present" ? read.auth : undefined,
    );
    expect(keychain.finds).toHaveLength(0);
    expect(keychain.reads).toHaveLength(0);
    await readClaudeStore(dir, { keychain, now: () => 2000, preferKeychain: true }).then((read) =>
      read.state === "present" ? read.auth : undefined,
    );
    expect(keychain.reads).toHaveLength(1);
  });
});

/**
 * A locked store (fm3000-keychain-locked-retry-unlock-fix-r1). macOS settles,
 * at a process's first touch of a store, whether that process may ever show
 * the store's unlock dialog, and Infinitary's first touch is the silent startup
 * tick - so an in-process read on Retry fails at once (-25293) and never
 * offers the dialog. The fake below models that: its VALUE read refuses
 * while the store is locked, whatever `interactive` says, and only the host's
 * unlock (a fresh process in the app) can change the lock.
 */
describe("a locked store", () => {
  // A clean HOME: the store identity must never come from the machine's own
  // ~/.claude.json, which exists on a developer's Mac and not on CI.
  let env: NodeJS.ProcessEnv = {};
  beforeEach(() => {
    clearKeychainLock();
    clearClaudeCredentialCache();
    env = { USER: "kun", HOME: scratchDir("infinitary-claude-locked-home-") };
  });

  const AUTH_FAILED: HostKeychainOutcome = {
    kind: "failed",
    code: -25293,
    message: "Auth failed.",
  };

  function lockedStore(options: {
    unlock?: (query: HostKeychainQuery) => HostKeychainUnlockOutcome;
    grant?: HostKeychainOutcome;
  }) {
    const state = { locked: true };
    const keychain = fakeKeychain({
      find: () => ({ kind: "found", locked: state.locked }),
      read: () =>
        state.locked
          ? AUTH_FAILED
          : (options.grant ?? { kind: "value", value: credentialJson("kc-unlocked") }),
      ...(options.unlock
        ? {
            unlock: (query: HostKeychainQuery) => {
              const outcome = options.unlock?.(query) ?? { kind: "unlocked" };
              if (outcome.kind === "unlocked") state.locked = false;
              return outcome;
            },
          }
        : {}),
    });
    return { keychain, state };
  }

  it("a background tick reports the lock without the VALUE read or the unlock", async () => {
    const dir = storeDir();
    const { keychain } = lockedStore({ unlock: () => ({ kind: "unlocked" }) });
    const result = await readClaudeStore(dir, { keychain, env });
    expect(result).toEqual({ state: "unreadable", reason: "keychain_locked" });
    // The VALUE read is the one call that could raise a dialog on a locked
    // store, so a tick never makes it; nor may it ask to unlock.
    expect(keychain.reads).toHaveLength(0);
    expect(keychain.unlocks).toHaveLength(0);
    expect(keychain.finds).toEqual([{ service: "Claude Code-credentials", account: "kun" }]);
  });

  it("is never a held lock: the next tick sees an unlock done elsewhere and recovers", async () => {
    const dir = storeDir();
    const { keychain, state } = lockedStore({});
    await readClaudeStore(dir, { keychain, env });
    expect(isKeychainLocked(dir)).toBe(false);
    // The person unlocks the Mac, or another app unlocks the store.
    state.locked = false;
    const next = await readClaudeStore(dir, { keychain, env });
    expect(next).toMatchObject({ state: "present", auth: { accessToken: "kc-unlocked" } });
  });

  it("Retry asks the host to unlock first, then reads in-app and recovers", async () => {
    const dir = storeDir();
    const { keychain, state } = lockedStore({ unlock: () => ({ kind: "unlocked" }) });
    expect(await readClaudeStore(dir, { keychain, env })).toEqual({
      state: "unreadable",
      reason: "keychain_locked",
    });
    const retried = await readClaudeStore(dir, {
      keychain,
      env,
      allowPrompt: true,
    });
    expect(retried).toMatchObject({ state: "present", auth: { accessToken: "kc-unlocked" } });
    expect(state.locked).toBe(false);
    expect(keychain.unlocks).toEqual([
      { service: "Claude Code-credentials", account: "kun", interactive: true },
    ]);
    // One VALUE read, after the unlock, from Infinitary itself: the grant stays Infinitary's.
    expect(keychain.reads).toEqual([
      { service: "Claude Code-credentials", account: "kun", interactive: true },
    ]);
  });

  it("a cancelled or unanswered unlock leaves it locked and retryable, without a read", async () => {
    const dir = storeDir();
    for (const refused of [
      { kind: "failed", code: -128, message: "User canceled the request." },
      { kind: "failed", code: -60008, message: "The macOS dialog could not be shown." },
      { kind: "failed", message: "The unlock dialog timed out without an answer." },
    ] satisfies HostKeychainUnlockOutcome[]) {
      const { keychain, state } = lockedStore({ unlock: () => refused });
      const result = await readClaudeStore(dir, {
        keychain,
        env,
        allowPrompt: true,
      });
      expect(result).toEqual({ state: "unreadable", reason: "keychain_locked" });
      expect(state.locked).toBe(true);
      expect(keychain.reads).toHaveLength(0);
      expect(isKeychainLocked(dir)).toBe(false);
    }
  });

  it("an unlock the session cannot present is the no-dialog state, not a lock", async () => {
    const { keychain } = lockedStore({
      unlock: () => ({ kind: "failed", code: -25308, message: "User interaction is not allowed." }),
    });
    const result = await readClaudeStore(storeDir(), {
      keychain,
      env,
      allowPrompt: true,
    });
    expect(result).toEqual({ state: "unreadable", reason: "keychain_no_interactive_session" });
  });

  it("an unlock the host could not run at all is not promised to a Retry", async () => {
    // "Retry, then enter your password" would be a promise this host cannot keep.
    const { keychain } = lockedStore({
      unlock: () => ({
        kind: "failed",
        message: "The unlock helper exited (1) without an answer.",
      }),
    });
    const result = await readClaudeStore(storeDir(), {
      keychain,
      env,
      allowPrompt: true,
    });
    expect(result).toEqual({ state: "unreadable", reason: "keychain_unavailable" });
  });

  it("on a host that cannot unlock, a refused in-app read of a locked store is the lock", async () => {
    // No `unlockKeychain`: today's in-process read, and its refusal is named
    // for what it is - never "choose Always Allow", which no dialog offers.
    const { keychain } = lockedStore({});
    const result = await readClaudeStore(storeDir(), {
      keychain,
      env,
      allowPrompt: true,
    });
    expect(result).toEqual({ state: "unreadable", reason: "keychain_locked" });
    expect(keychain.reads).toHaveLength(1);
    expect(keychain.reads[0]?.interactive).toBe(true);
  });

  it("a grant declined after the unlock is still the grant refusal, with its own copy", async () => {
    const dir = storeDir();
    const { keychain } = lockedStore({
      unlock: () => ({ kind: "unlocked" }),
      grant: { kind: "failed", code: -128, message: "User canceled the request." },
    });
    const result = await readClaudeStore(dir, {
      keychain,
      env,
      allowPrompt: true,
    });
    expect(result).toEqual({ state: "unreadable", reason: "keychain_access_denied" });
    expect(isKeychainLocked(dir)).toBe(true);
  });

  it("a remembered credential still answers ticks while the store is locked", async () => {
    const dir = storeDir();
    const state = { locked: false };
    const keychain = fakeKeychain({
      find: () => ({ kind: "found", modifiedAt: "20260922183000Z", locked: state.locked }),
      read: () =>
        state.locked
          ? AUTH_FAILED
          : { kind: "value", value: credentialJson("kc-remembered", 9e15) },
    });
    const options = { keychain, env, now: () => 1000 };
    await readClaudeStore(dir, options);
    // The Mac locks the store; the credential read before it is still current.
    state.locked = true;
    const tick = await readClaudeStore(dir, { ...options, now: () => 2000 });
    expect(tick).toMatchObject({
      state: "present",
      auth: { accessToken: "kc-remembered", expiresAt: 9e15 },
    });
    expect(keychain.reads).toHaveLength(1);
  });

  it("the unified read reports a locked store without attempting a value or unlock", async () => {
    const { keychain } = lockedStore({ unlock: () => ({ kind: "unlocked" }) });
    expect(
      await readClaudeStore(storeDir(), {
        keychain,
        env: { HOME: "/tmp/infinitary-no-claude-home", USER: "kun" },
      }),
    ).toEqual({ state: "unreadable", reason: "keychain_locked" });
    expect(keychain.reads).toHaveLength(0);
    expect(keychain.unlocks).toHaveLength(0);
  });
});

describe("the remembered credential", () => {
  beforeEach(() => {
    clearKeychainLock();
    clearClaudeCredentialCache();
  });

  it("answers later ticks from memory, so one grant covers a whole session", async () => {
    const home = scratchDir("infinitary-claude-clean-home-");
    const dir = join(home, ".claude");
    mkdirSync(dir);
    const keychain = fakeKeychain({
      find: { kind: "found", modifiedAt: "20260915183000Z" },
      read: { kind: "value", value: credentialJson("kc-once", 9e15) },
    });
    const options = { keychain, env: { HOME: home }, now: () => 1000 };
    const first = await readClaudeStore(dir, options);
    expect(first).toMatchObject({ state: "present", auth: { accessToken: "kc-once" } });
    expect(keychain.reads).toHaveLength(1);

    const later = await readClaudeStore(dir, { ...options, now: () => 2000 });
    expect(later).toMatchObject({ state: "present", auth: { accessToken: "kc-once" } });
    expect(keychain.reads).toHaveLength(1);
  });

  it("re-reads after an external store mtime change but not for an unchanged store", async () => {
    const { home, dir } = storeWithHomeIdentity("account-a");
    let stored = credentialJson("kc-a", 9e15);
    const keychain = fakeKeychain({
      find: { kind: "found", modifiedAt: "20260915183000Z" },
      read: () => ({ kind: "value", value: stored }),
    });
    const options = { keychain, env: { HOME: home }, now: () => 1_000 };

    await readClaudeStore(dir, options);
    expect(keychain.reads).toHaveLength(1);
    await readClaudeStore(dir, options);
    expect(keychain.reads).toHaveLength(1);

    // A swap can rewrite the non-secret home-root config without changing the
    // account UUID. Its mtime alone must invalidate the remembered token.
    utimesSync(join(home, ".claude.json"), new Date(2_000), new Date(2_000));
    stored = credentialJson("kc-mtime", 9e15);
    const afterMtime = await readClaudeStore(dir, options);
    expect(afterMtime).toMatchObject({ state: "present", auth: { accessToken: "kc-mtime" } });
    expect(keychain.reads).toHaveLength(2);

    // An account rotation rewrites the config; its modification date
    // invalidates the identity and credential together.
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "account-b" } }),
    );
    utimesSync(join(home, ".claude.json"), new Date(3_000), new Date(3_000));
    stored = credentialJson("kc-uuid", 9e15);
    const afterUuid = await readClaudeStore(dir, options);
    expect(afterUuid).toMatchObject({ state: "present", auth: { accessToken: "kc-uuid" } });
    expect(keychain.reads).toHaveLength(3);
  });

  it("invalidates a Keychain-only cache when the item changes", async () => {
    const home = scratchDir("infinitary-claude-clean-home-");
    const dir = join(home, ".claude");
    mkdirSync(dir);
    let modifiedAt = "20260915183000Z";
    let stored = credentialJson("kc-a", 9e15);
    const keychain = fakeKeychain({
      find: () => ({ kind: "found", modifiedAt }),
      read: () => ({ kind: "value", value: stored }),
    });
    const options = { keychain, env: { HOME: home }, now: () => 1_000 };

    await readClaudeStore(dir, options);
    await readClaudeStore(dir, options);
    expect(keychain.reads).toHaveLength(1);

    modifiedAt = "20260915183100Z";
    stored = credentialJson("kc-b", 9e15);
    const rotated = await readClaudeStore(dir, options);
    expect(rotated).toMatchObject({ state: "present", auth: { accessToken: "kc-b" } });
    expect(keychain.reads).toHaveLength(2);
  });

  it("keeps the cached value at access expiry until the modification date changes", async () => {
    const dir = storeDir();
    const expiresAt = 600_000;
    const keychain = fakeKeychain({
      find: { kind: "found", modifiedAt: "20260915183000Z" },
      read: { kind: "value", value: credentialJson("kc-dated", expiresAt) },
    });
    await readClaudeStore(dir, { keychain, now: () => 1000 });
    expect(keychain.reads).toHaveLength(1);
    // Inside the lead: still the current credential.
    await readClaudeStore(dir, { keychain, now: () => expiresAt - 90_000 });
    expect(keychain.reads).toHaveLength(1);
    // INF-2318: an unchanged modification date, not expiry, owns the cache.
    await readClaudeStore(dir, { keychain, now: () => expiresAt + 30_000 });
    expect(keychain.reads).toHaveLength(1);
  });

  it("never remembers a Keychain item with no modification date", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({
      read: { kind: "value", value: credentialJson("kc-undated") },
    });
    await readClaudeStore(dir, { keychain, now: () => 1000 });
    await readClaudeStore(dir, { keychain, now: () => 2000 });
    // No modification date means every tick must read the item again.
    expect(keychain.reads).toHaveLength(2);
  });

  it("does not let a remembered credential make a renewal look unchanged", async () => {
    resetStoreLeasesForTest();
    const dir = storeDir();
    let stored = credentialJson("before", 9e15);
    const keychain = fakeKeychain({ read: () => ({ kind: "value", value: stored }) });
    // Seed memory the way a quota tick would.
    await readClaudeStore(dir, { keychain, now: () => 1000 });
    const backend = new ClaudeAuthBackend({
      keychain,
      available: () => true,
      configDir: () => dir,
      run: async () => {
        stored = credentialJson("after", 9e15);
        return { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
      },
    });
    const result = await backend.renew(
      { providerId: "anthropic-claude", accountId: "acct_claude", dir },
      "vendor_rejected",
    );
    expect(result).toEqual({ outcome: "renewed" });
    const next = await readClaudeStore(dir, { keychain, now: () => 1000 });
    expect(next).toMatchObject({ state: "present", auth: { accessToken: "after" } });
  });

  it("is bypassed by Retry, which means 'look again'", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({
      find: { kind: "found", modifiedAt: "20260915183000Z" },
      read: { kind: "value", value: credentialJson("kc-asked", 9e15) },
    });
    await readClaudeStore(dir, { keychain, now: () => 1000 });
    expect(keychain.reads).toHaveLength(1);
    await readClaudeStore(dir, { keychain, now: () => 1000, allowPrompt: true });
    expect(keychain.reads).toHaveLength(2);
    expect(keychain.reads[1]?.interactive).toBe(true);
  });

  it("is never seeded by a read that failed", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({
      read: { kind: "failed", code: -25308, message: "User interaction is not allowed." },
    });
    await readClaudeStore(dir, { keychain, now: () => 1000 });
    const again = await readClaudeStore(dir, { keychain, now: () => 2000 });
    expect(again).toEqual({ state: "unreadable", reason: "keychain_needs_grant" });
    expect(keychain.reads).toHaveLength(2);
  });
});

describe("readClaudeStore", () => {
  it("reads a live credential from the plain-file store without asking macOS", async () => {
    const dir = storeDir();
    writeFileSync(join(dir, ".credentials.json"), credentialJson("tok"));
    const keychain = fakeKeychain({});
    expect(
      await readClaudeStore(dir, {
        keychain,
        env: { HOME: "/tmp/infinitary-no-claude-home" },
      }),
    ).toMatchObject({ state: "present" });
    expect(keychain.finds).toHaveLength(0);
    expect(keychain.reads).toHaveLength(0);
  });

  it("names the account from Claude Code's home-root config", async () => {
    const home = scratchDir("infinitary-claude-home-");
    const dir = join(home, ".claude");
    mkdirSync(dir);
    writeFileSync(join(dir, ".credentials.json"), credentialJson("tok"));
    // The old implementation's path must not be consulted.
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "wrong@example.com" } }),
    );
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "kun@example.com" } }),
    );
    expect(
      await readClaudeStore(dir, { keychain: fakeKeychain({}), env: { HOME: home } }),
    ).toMatchObject({
      state: "present",
      identity: { label: "kun@example.com" },
    });
  });

  it("uses CLAUDE_CONFIG_DIR for the non-legacy config location", async () => {
    const configuredHome = scratchDir("infinitary-claude-config-");
    const dir = join(configuredHome, ".claude");
    mkdirSync(dir);
    writeFileSync(join(dir, ".credentials.json"), credentialJson("tok"));
    writeFileSync(
      join(configuredHome, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "configured@example.com" } }),
    );
    expect(
      await readClaudeStore(dir, {
        keychain: fakeKeychain({}),
        env: { CLAUDE_CONFIG_DIR: configuredHome, HOME: "/tmp/infinitary-wrong-home" },
      }),
    ).toMatchObject({
      state: "present",
      identity: { label: "configured@example.com" },
    });
  });

  it("gives the legacy config inside the config home precedence", async () => {
    const home = scratchDir("infinitary-claude-home-");
    const dir = join(home, ".claude");
    mkdirSync(dir);
    writeFileSync(join(dir, ".credentials.json"), credentialJson("tok"));
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "current@example.com" } }),
    );
    writeFileSync(
      join(dir, ".config.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "legacy@example.com" } }),
    );
    expect(
      await readClaudeStore(dir, { keychain: fakeKeychain({}), env: { HOME: home } }),
    ).toMatchObject({
      state: "present",
      identity: { label: "legacy@example.com" },
    });
  });

  it("calls an expired ACCESS token live: renewing is not signing in again", async () => {
    const dir = storeDir();
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok",
          expiresAt: 1_000,
          refreshTokenExpiresAt: 9_000_000,
        },
      }),
    );
    const evidence = await readClaudeStore(dir, {
      keychain: fakeKeychain({}),
      env: { HOME: "/tmp/infinitary-no-claude-home" },
      now: () => 5_000,
    });
    expect(evidence).toMatchObject({ state: "present" });
  });

  it("INF-2317: ignores a passed refresh date even with expired access", async () => {
    const dir = storeDir();
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "tok", expiresAt: 1_000, refreshTokenExpiresAt: 2_000 },
      }),
    );
    const evidence = await readClaudeStore(dir, {
      keychain: fakeKeychain({ find: { kind: "absent" } }),
      env: { HOME: dir },
      now: () => 5_000,
    });
    expect(evidence).toMatchObject({ state: "present" });
    expect(
      await readClaudeStore(dir, {
        keychain: fakeKeychain({}),
        now: () => 5_000,
      }),
    ).toMatchObject({ state: "present", auth: { accessToken: "tok", expiresAt: 1_000 } });
  });

  it("INF-2317: resolves live access despite a passed refresh date", async () => {
    const dir = storeDir();
    writeFileSync(
      join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok",
          expiresAt: 9_000,
          refreshTokenExpiresAt: 2_000,
        },
      }),
    );
    expect(
      await readClaudeStore(dir, {
        keychain: fakeKeychain({}),
        now: () => 5_000,
      }),
    ).toMatchObject({ state: "present", auth: { accessToken: "tok", expiresAt: 9_000 } });
    expect(
      await readClaudeStore(dir, { keychain: fakeKeychain({}), now: () => 5_000 }).then((read) =>
        read.state === "present" ? read.auth : undefined,
      ),
    ).toEqual({ accessToken: "tok", expiresAt: 9_000 });
  });

  it("INF-2317: a Keychain-only login with a passed refresh date remains usable", async () => {
    const { home, dir } = storeWithHomeIdentity("account-1");
    const keychain = fakeKeychain({
      read: {
        kind: "value",
        value: JSON.stringify({
          claudeAiOauth: {
            accessToken: "saved-token",
            expiresAt: 9_000,
            refreshTokenExpiresAt: 2_000,
          },
        }),
      },
    });
    expect(
      await readClaudeStore(dir, {
        keychain,
        env: { HOME: home, USER: "test" },
        now: () => 5_000,
      }),
    ).toMatchObject({ state: "present", auth: { accessToken: "saved-token", expiresAt: 9_000 } });
    expect(keychain.reads).toHaveLength(1);
    expect(await readClaudeStore(dir, { keychain, env: { HOME: home } })).toMatchObject({
      state: "present",
    });
  });

  it("reads a Keychain value once for health and allowance", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({
      find: { kind: "found" },
      read: { kind: "value", value: credentialJson("current-token") },
    });
    expect(
      await readClaudeStore(dir, {
        keychain,
        env: { HOME: "/tmp/infinitary-no-claude-home", USER: "kun" },
      }),
    ).toMatchObject({
      state: "present",
    });
    expect(keychain.finds).toEqual([{ service: "Claude Code-credentials", account: "kun" }]);
    expect(keychain.reads).toHaveLength(1);
  });

  it("separates a missing item from an unreadable Keychain", async () => {
    const dir = storeDir();
    expect(
      await readClaudeStore(dir, {
        keychain: fakeKeychain({ find: { kind: "absent" } }),
      }),
    ).toEqual({ state: "absent" });

    // Not an answer, so not a sign-out: the caller must be told it does not
    // know rather than be handed a false negative.
    expect(
      await readClaudeStore(dir, {
        keychain: fakeKeychain({ find: { kind: "failed", message: "timed out" } }),
      }),
    ).toEqual({ state: "unreadable", reason: "keychain_prompt_timeout" });
  });
});

/**
 * The stamp a cut-off is recorded under (W1 S7): which login the store holds
 * and when its credential was last written, projected from the same store result as health and allowance.
 * The projection itself never carries a token.
 */
describe("claudeCredentialStamp", () => {
  function homeWith(oauthAccount: Record<string, string>): { home: string; dir: string } {
    const home = scratchDir("infinitary-claude-stamp-");
    const dir = join(home, ".claude");
    mkdirSync(dir);
    writeFileSync(join(dir, ".credentials.json"), credentialJson("store-token"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount }));
    return { home, dir };
  }

  it("names the login by its account and organisation, and dates the plain-file store", async () => {
    const { home, dir } = homeWith({ accountUuid: "acct-1", organizationUuid: "org-1" });
    writeFileSync(join(dir, ".credentials.json"), credentialJson("secret-token"));
    utimesSync(join(dir, ".credentials.json"), 1_000, 1_000);
    const keychain = fakeKeychain({});
    const stamp = await readClaudeStore(dir, { keychain, env: { HOME: home } }).then(
      claudeCredentialStamp,
    );
    expect(stamp.login).toMatch(/^[0-9a-f]{16}$/);
    expect(stamp.written).toBe("file:1000000");
    expect(JSON.stringify(stamp)).not.toContain("secret-token");
    expect(keychain.finds).toHaveLength(0);
    expect(keychain.reads).toHaveLength(0);

    // A renewal rewrites the store: the same login, written again.
    utimesSync(join(dir, ".credentials.json"), 2_000, 2_000);
    const renewed = await readClaudeStore(dir, { keychain, env: { HOME: home } }).then(
      claudeCredentialStamp,
    );
    expect(renewed).toEqual({ login: stamp.login, written: "file:2000000" });
  });

  it("tells another organisation's login apart from the same account's", async () => {
    const first = homeWith({ accountUuid: "acct-1", organizationUuid: "org-1" });
    const second = homeWith({ accountUuid: "acct-1", organizationUuid: "org-2" });
    const same = homeWith({ accountUuid: "acct-1", organizationUuid: "org-1" });
    const read = ({ home, dir }: { home: string; dir: string }) =>
      readClaudeStore(dir, { keychain: fakeKeychain({}), env: { HOME: home } }).then(
        claudeCredentialStamp,
      );
    const [a, b, c] = await Promise.all([read(first), read(second), read(same)]);
    expect(a.login).toBeDefined();
    expect(b.login).not.toBe(a.login);
    expect(c.login).toBe(a.login);
  });

  it("projects the Keychain modification date from the unified result", async () => {
    const { home, dir } = homeWith({ accountUuid: "acct-1" });
    rmSync(join(dir, ".credentials.json"));
    const keychain = fakeKeychain({
      find: { kind: "found", modifiedAt: "20260926120000Z" },
      read: { kind: "value", value: credentialJson("keychain-token", 9e15) },
    });
    expect(
      await readClaudeStore(dir, { keychain, env: { HOME: home }, preferKeychain: true }).then(
        claudeCredentialStamp,
      ),
    ).toMatchObject({
      written: "keychain:20260926120000Z",
    });
    expect(keychain.finds).toHaveLength(1);
    expect(keychain.reads).toHaveLength(1);
  });

  it("leaves out what it cannot see rather than guessing", async () => {
    const dir = storeDir();
    const keychain = fakeKeychain({ find: { kind: "failed", code: -1, message: "denied" } });
    expect(
      await readClaudeStore(dir, {
        keychain,
        env: { HOME: scratchDir("infinitary-claude-nohome-") },
      }).then(claudeCredentialStamp),
    ).toEqual({});
  });
});
