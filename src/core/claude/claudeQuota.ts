import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { KEYCHAIN_READ_INCOMPLETE_CODE, type KeychainValueFailure } from "@shared/quota";
import type { CredentialStamp } from "../accounts/credentialHealth";
import {
  absentKeychain,
  type HostKeychain,
  type HostKeychainOutcome,
  type HostKeychainUnlockOutcome,
} from "../host";
import { runRenewalStoreTask, type StoreLeaseResult } from "./claudeStoreLease";

/**
 * The machine's default Claude login, as Infinitary is allowed to read it
 * (captain CD-1=B): the access token behind the same read-only usage
 * request the client itself makes, and - without touching a token value at
 * all - whether that login still holds a credential
 * (readClaudeCredentialEvidence, the fallback behind a fallible client probe).
 *
 * Infinitary never mints or refreshes Anthropic OAuth. It reads what the vendor's
 * own `claude login` maintains: a `.credentials.json` in the default config
 * root (`~/.claude`) when the Keychain is unavailable, otherwise the bare
 * login-Keychain item `Claude Code-credentials` (no per-account suffix),
 * under whatever account the client keyed it on (findClaudeKeychainItem).
 * Setting CLAUDE_CONFIG_DIR would hash a suffix onto that name and miss the
 * everyday login - the login probe measured that, which is why Claude runs
 * leave the variable unset. One Claude account, ever.
 *
 * macOS may ask before the Keychain item can be read. On a Claude Code item
 * with an apple-tool partition, even Always Allow for Infinitary's decrypt ACL
 * does not grant Infinitary's process access; the host first tries the direct
 * read and, only when that one item's access rules already trust Apple's
 * security tool without a password, uses that trusted path
 * (see darwinKeychain.ts). Neither
 * path changes the item's ACL. A declined, denied, or timed-out read remains
 * retryable, never a process-lifetime poison (CL-C).
 */

export type ClaudeQuotaAuth = {
  accessToken: string;
  /** Advisory only: the vendor's 401 is the definitive expiry signal. */
  expiresAt?: number;
  /**
   * When the refresh token itself lapses. This is the one local fact that
   * separates "needs renewing" from "really signed out" - an access token
   * past `expiresAt` is renewable and is NOT a sign-out.
   */
  refreshTokenExpiresAt?: number;
};

/**
 * What this account's own store says about its credential, read without ever
 * asking macOS for a value (the file parses, the Keychain answers by
 * attribute). This is the evidence a failed client probe falls back to:
 * `unknown` must never be reported as a sign-out.
 */
export type ClaudeCredentialEvidence =
  /** A credential is there and still renewable. */
  | { state: "live"; label?: string }
  /** A credential is there but its refresh token has lapsed: a real re-auth. */
  | { state: "unrenewable" }
  /** This store holds no credential - what `auth logout` leaves behind. */
  | { state: "absent" }
  /** The store could not be read. Not evidence of anything. */
  | { state: "unknown" };

/**
 * What `resolveClaudeQuotaAuthResult` established. `locked` is the CL-C
 * case: the item is there, the VALUE read was refused, and the meter must
 * say so rather than look like an empty store. `unrenewable` is local proof
 * the refresh token has lapsed (CD-3): a real re-auth, never a retry.
 */
export type ClaudeQuotaAuthResult =
  | { status: "resolved"; auth: ClaudeQuotaAuth }
  | { status: "unrenewable" }
  | { status: "locked"; reason: KeychainValueFailure }
  | { status: "unavailable"; reason?: KeychainValueFailure };

/** Local proof the refresh token itself has lapsed: the client cannot recover. */
export function isRefreshTokenLapsed(auth: ClaudeQuotaAuth, now: number): boolean {
  return auth.refreshTokenExpiresAt !== undefined && auth.refreshTokenExpiresAt <= now;
}

/** errSecItemNotFound as `security(1)` used to report it - residual classifier. */
const SEC_ITEM_NOT_FOUND_CLI = 44;
/** errSecItemNotFound as Security.framework OSStatus. */
const SEC_ITEM_NOT_FOUND = -25300;
/** errSecInteractionNotAllowed - no SecurityAgent dialog could be presented. */
const SEC_INTERACTION_NOT_ALLOWED = -25308;
/** errSecInteractionRequired - the same refusal, as newer macOS reports it. */
const SEC_INTERACTION_REQUIRED = -25315;

/**
 * A declined VALUE read must not re-ask until Retry. Four reasons are not
 * declines and stay out of `keychainLocks`: a read that ran out of time says
 * nothing about the item, a blocked session is
 * environmental, and a missing grant or a locked store heals the moment the
 * user acts - possibly in Keychain Access, or by unlocking the Mac, rather
 * than through our Retry - so the next tick must be free to discover that.
 * A background tick on a locked store costs one silent attribute read.
 */
function holdKeychainLock(reason: KeychainValueFailure): boolean {
  return (
    reason !== "keychain_no_interactive_session" &&
    reason !== "keychain_needs_grant" &&
    reason !== "keychain_locked" &&
    reason !== "keychain_read_incomplete"
  );
}

/**
 * Config roots whose Keychain VALUE read was declined, denied, or timed
 * out, with the reason the meter should show. A background tick must not
 * re-ask; a user-initiated retry (`allowPrompt`) clears the lock and tries
 * again. This is the CL-C fix: never a process-lifetime Set with no reason.
 */
const keychainLocks = new Map<string, KeychainValueFailure>();

/**
 * The store identity a lock was taken under. A store that names another
 * login or was rewritten since is not the one that was declined, so a
 * background tick may make one fresh (never prompting) read of it instead of
 * waiting for Retry; a decline there locks again under the new identity.
 */
const keychainLockIdentity = new Map<string, ObservedStoreIdentity>();

/** A user-initiated read (sign-in, Retry) clears the lock so we can ask again. */
export function clearKeychainLock(configDir?: string): void {
  if (configDir === undefined) {
    keychainLocks.clear();
    keychainLockIdentity.clear();
  } else {
    keychainLocks.delete(configDir);
    keychainLockIdentity.delete(configDir);
  }
}

/**
 * The credential a Keychain VALUE read produced, per config root, held in
 * memory for exactly as long as it is still the current one.
 *
 * The macOS ask is the scarce thing here, not the read. Without this, every
 * quota tick (five minutes, plus window focus, resume, and startup) spends its
 * own VALUE read: on a Mac whose Claude login lives only in the Keychain -
 * no `.credentials.json` sidecar - a grant that did not stick bought exactly
 * one measurement, and the meter failed again minutes later inside the same
 * session. One grant should carry a session.
 *
 * Never persisted, never logged, and never handed across the preload
 * boundary; it is the same value the resolver already returns to its caller.
 * Each entry also records the non-secret account config's UUID and mtime, so
 * an external login or account swap invalidates it without another Keychain
 * VALUE read.
 */
type ObservedStoreIdentity = {
  accountUuid?: string;
  configMtimeMs?: number;
  configPath?: string;
  keychainModifiedAt?: string;
};

type CredentialCacheEntry = {
  auth: ClaudeQuotaAuth;
  goodUntil: number;
  storeIdentity: ObservedStoreIdentity;
};

const credentialCache = new Map<string, CredentialCacheEntry>();

/**
 * Stop serving a remembered credential slightly before it expires, so the
 * store gets re-read while the token it holds is still usable.
 */
const CREDENTIAL_CACHE_LEAD_MS = 60 * 1000;

function sameStoreIdentity(left: ObservedStoreIdentity, right: ObservedStoreIdentity): boolean {
  return (
    left.configPath === right.configPath &&
    left.accountUuid === right.accountUuid &&
    left.configMtimeMs === right.configMtimeMs &&
    left.keychainModifiedAt === right.keychainModifiedAt
  );
}

function rememberedCredential(
  configDir: string,
  now: number,
  storeIdentity: ObservedStoreIdentity | undefined,
): ClaudeQuotaAuth | undefined {
  const entry = credentialCache.get(configDir);
  if (!entry) return undefined;
  if (
    storeIdentity === undefined ||
    !sameStoreIdentity(entry.storeIdentity, storeIdentity) ||
    entry.goodUntil <= now
  ) {
    credentialCache.delete(configDir);
    return undefined;
  }
  return entry.auth;
}

/**
 * A credential without an expiry or observable store metadata is not
 * remembered: serving it later could hide a rotation we have no way to notice.
 * The token expiry bounds the cache, while config or Keychain metadata detects
 * an external rotation before that bound.
 */
function rememberCredential(
  configDir: string,
  auth: ClaudeQuotaAuth,
  now: number,
  storeIdentity: ObservedStoreIdentity | undefined,
): void {
  if (auth.expiresAt === undefined || storeIdentity === undefined) return;
  const goodUntil = auth.expiresAt - CREDENTIAL_CACHE_LEAD_MS;
  if (goodUntil <= now) return;
  credentialCache.set(configDir, { auth, goodUntil, storeIdentity });
}

/** Forget the remembered credential for a store. Sign-out; tests between cases. */
export function clearClaudeCredentialCache(configDir?: string): void {
  if (configDir === undefined) credentialCache.clear();
  else credentialCache.delete(configDir);
}

/**
 * The bare Keychain item the vendor's own `claude login` writes when
 * CLAUDE_CONFIG_DIR is unset. A suffixed name is the per-account store we
 * retired (CD-1=B); do not derive one from a config root.
 */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export function keychainServiceFor(): string {
  return CLAUDE_KEYCHAIN_SERVICE;
}

/**
 * The config root the client uses for that same default login: `~/.claude`.
 * File-store fallback and identity live here; the Keychain item does not
 * take a suffix from this path (setting CLAUDE_CONFIG_DIR would).
 */
export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || safeHomedir();
  return join(home, ".claude");
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

/**
 * The account name the client keys its Keychain item on when it runs with
 * this USER: asked for first, never required (findClaudeKeychainItem).
 */
export function keychainAccountName(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.USER?.trim() || safeUsername();
  return candidate && /^[A-Za-z0-9._@-]{1,128}$/.test(candidate) ? candidate : "claude-code-user";
}

/** Which item presence found, and the account every later read of it names. */
type ClaudeKeychainItem = { presence: HostKeychainOutcome; account?: string };

/**
 * The client's Keychain item: the exact service, under whatever account the
 * client keyed it on. The client names it after USER, but its runtime (Bun)
 * names an unset USER "unknown" where this process would name the real user,
 * and other versions or launchers may differ again. So the name the client
 * keys on with this USER is asked first - when both exist, that is the item
 * the client itself reads - and on a definite miss the service alone, which
 * still matches only Claude's own items, never another saved password.
 * Attributes only, never the value. The returned account is the found
 * item's own, so the value read, the unlock and the Apple tool all reach
 * that one item.
 */
async function findClaudeKeychainItem(
  keychain: HostKeychain,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeKeychainItem> {
  const service = keychainServiceFor();
  const account = keychainAccountName(env);
  const exact = await keychain.findGenericPassword({ service, account });
  if (!isAbsentOutcome(exact)) return { presence: exact, account };
  const any = await keychain.findGenericPassword({ service });
  const found = any.kind === "found" ? any.account : undefined;
  return { presence: any, ...(found !== undefined ? { account: found } : {}) };
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

function parseCredentials(raw: string): ClaudeQuotaAuth | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return undefined;
  const record = oauth as Record<string, unknown>;
  const accessToken = typeof record.accessToken === "string" ? record.accessToken : undefined;
  if (!accessToken) return undefined;
  const expiresAt = typeof record.expiresAt === "number" ? record.expiresAt : undefined;
  const refreshTokenExpiresAt =
    typeof record.refreshTokenExpiresAt === "number" ? record.refreshTokenExpiresAt : undefined;
  return {
    accessToken,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt } : {}),
  };
}

type CredentialsFileRead =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "auth"; auth: ClaudeQuotaAuth };

function isMissingCredentialsFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/**
 * The plain-file store, with absence kept apart from a read or parse that
 * failed. A missing file is a lookup miss. A directory, a permission error,
 * or contents this reader does not understand is unreadable, not missing.
 */
async function readCredentialsFile(configDir: string): Promise<CredentialsFileRead> {
  let raw: string;
  try {
    raw = await readFile(join(configDir, ".credentials.json"), "utf8");
  } catch (error) {
    return isMissingCredentialsFile(error) ? { kind: "absent" } : { kind: "unreadable" };
  }
  const auth = parseCredentials(raw);
  return auth ? { kind: "auth", auth } : { kind: "unreadable" };
}

function fileAuth(read: CredentialsFileRead): ClaudeQuotaAuth | undefined {
  return read.kind === "auth" ? read.auth : undefined;
}

type KeychainRead =
  | { kind: "auth"; auth: ClaudeQuotaAuth }
  | { kind: "locked"; reason: KeychainValueFailure }
  | { kind: "absent" };

/**
 * Classify a failed Keychain VALUE or presence read. The codes are macOS
 * Security.framework OSStatus values as the host reports them. Residual
 * `security(1)` shapes (exit 44, a killed child) stay for the classifier
 * tests and any leftover error objects.
 */
export function classifyKeychainValueError(error: unknown): KeychainValueFailure {
  const err = error as {
    killed?: boolean;
    code?: unknown;
    message?: string;
    stderr?: string;
  } | null;
  if (err?.code === KEYCHAIN_READ_INCOMPLETE_CODE) return "keychain_read_incomplete";
  if (err?.killed === true) return "keychain_prompt_timeout";
  const message = `${err?.message ?? ""}\n${err?.stderr ?? ""}`.toLowerCase();
  if (/timed out|timeout/.test(message)) return "keychain_prompt_timeout";
  const code = err?.code;
  // The dialog could not be presented. Match before the generic "not allowed"
  // denied class: nobody declined. WHY it could not be presented is not in the
  // status - see `interactionFailure`, which knows whether we were the ones
  // who suppressed it.
  if (
    code === SEC_INTERACTION_NOT_ALLOWED ||
    code === SEC_INTERACTION_REQUIRED ||
    /user interaction is not allowed|interaction (is )?required|cssmerr_csp_no_user_interaction/.test(
      message,
    )
  ) {
    return "keychain_no_interactive_session";
  }
  // errSecUserCanceled (-128), errSecAuthFailed (-25293), and the 128 that
  // some `security` builds surface for a dismissed dialog.
  if (code === -128 || code === -25293 || code === 128 || code === "128") {
    return "keychain_access_denied";
  }
  if (/cancel|denied|not allowed|auth failed/.test(message)) {
    return "keychain_access_denied";
  }
  return "keychain_unavailable";
}

function classifyHostFailure(outcome: { code?: number; message: string }): KeychainValueFailure {
  return classifyKeychainValueError({ code: outcome.code, message: outcome.message });
}

function isAbsentOutcome(outcome: HostKeychainOutcome | HostKeychainUnlockOutcome): boolean {
  if (outcome.kind === "absent") return true;
  if (outcome.kind !== "failed") return false;
  return outcome.code === SEC_ITEM_NOT_FOUND || outcome.code === SEC_ITEM_NOT_FOUND_CLI;
}

function lockFromFailure(
  configDir: string,
  reason: KeychainValueFailure,
  persistLock: boolean,
  storeIdentity?: ObservedStoreIdentity,
): KeychainRead {
  if (persistLock && holdKeychainLock(reason)) {
    keychainLocks.set(configDir, reason);
    if (storeIdentity) keychainLockIdentity.set(configDir, storeIdentity);
    else keychainLockIdentity.delete(configDir);
  }
  return { kind: "locked", reason };
}

/**
 * Why no dialog could be presented. macOS reports the same status whether the
 * session has no SecurityAgent at all or WE suppressed the dialog for a
 * background read - but we do not have to guess, because we are the ones who
 * chose. A background read of an item Infinitary has not been granted access to
 * lands here on every tick, and "relaunch it from the Dock" sends the captain
 * somewhere there is nothing to find: what that item needs is one Always Allow.
 */
function interactionFailure(
  reason: KeychainValueFailure,
  allowPrompt: boolean,
): KeychainValueFailure {
  if (reason !== "keychain_no_interactive_session") return reason;
  return allowPrompt ? reason : "keychain_needs_grant";
}

/**
 * Why an unlock the person asked for did not leave the store unlocked. A
 * cancelled or unanswered dialog, a wrong password, a dialog macOS could not
 * draw: the store is still locked and the next Retry asks again, so all of
 * them are `keychain_locked`. Two are not: a session that can present no
 * dialog at all, and a host that could not run the unlock (no status).
 */
function unlockFailure(
  outcome: Extract<HostKeychainUnlockOutcome, { kind: "failed" }>,
): KeychainValueFailure {
  const reason = classifyHostFailure(outcome);
  if (reason === "keychain_no_interactive_session") return reason;
  if (reason === "keychain_unavailable" && outcome.code === undefined) return reason;
  return "keychain_locked";
}

type KeychainReadOptions = {
  configDir: string;
  keychain: HostKeychain;
  env: NodeJS.ProcessEnv;
  allowPrompt: boolean;
  persistLock: boolean;
  /** False when the caller must observe the credential itself (renewal). */
  useCache: boolean;
  now: number;
};

async function readKeychain(options: KeychainReadOptions): Promise<KeychainRead> {
  const { configDir, keychain, env, allowPrompt, persistLock, useCache, now } = options;
  const accountIdentity = await readAccountIdentityRecord(configDir, env);
  const { presence, account } = await findClaudeKeychainItem(keychain, env);
  const query = {
    service: keychainServiceFor(),
    ...(account !== undefined ? { account } : {}),
    ...(allowPrompt ? { interactive: true as const } : {}),
  };
  if (isAbsentOutcome(presence)) {
    credentialCache.delete(configDir);
    return { kind: "absent" };
  }
  if (presence.kind === "failed")
    return lockFromFailure(configDir, classifyHostFailure(presence), persistLock);
  const keychainModifiedAt = presence.kind === "found" ? presence.modifiedAt : undefined;
  const storeIdentity =
    accountIdentity?.observed || keychainModifiedAt
      ? { ...accountIdentity?.observed, ...(keychainModifiedAt ? { keychainModifiedAt } : {}) }
      : undefined;
  if (useCache) {
    const remembered = rememberedCredential(configDir, now, storeIdentity);
    if (remembered) return { kind: "auth", auth: remembered };
  }
  const lockedUnder = keychainLockIdentity.get(configDir);
  if (
    lockedUnder !== undefined &&
    storeIdentity !== undefined &&
    !sameStoreIdentity(lockedUnder, storeIdentity)
  ) {
    clearKeychainLock(configDir);
  }
  const locked = keychainLocks.get(configDir);
  if (locked !== undefined && !allowPrompt) return { kind: "locked", reason: locked };
  if (allowPrompt) clearKeychainLock(configDir);

  // A locked store. The VALUE read cannot succeed until it is unlocked, and
  // from a background tick it must not even be tried: whether this process
  // may show the unlock dialog was settled at its first touch of the store,
  // and a read is the one call that would show it. So a tick reports the
  // lock; a Retry or sign-in asks the host to unlock first (in a process
  // that can still show the dialog), then reads here as always.
  let storeLocked = presence.kind === "found" && presence.locked === true;
  if (storeLocked) {
    if (!allowPrompt)
      return lockFromFailure(configDir, "keychain_locked", persistLock, storeIdentity);
    if (keychain.unlockKeychain) {
      const unlocked = await keychain.unlockKeychain(query);
      if (unlocked.kind === "failed") {
        if (isAbsentOutcome(unlocked)) return { kind: "absent" };
        return lockFromFailure(configDir, unlockFailure(unlocked), persistLock, storeIdentity);
      }
      storeLocked = false;
    }
  }

  const secret = await keychain.readGenericPassword(query);
  if (isAbsentOutcome(secret)) return { kind: "absent" };
  if (secret.kind === "failed") {
    // `allowPrompt` is what the host was told about THIS read, so it is the
    // one fact that separates a suppressed dialog from an absent session.
    const reason = interactionFailure(classifyHostFailure(secret), allowPrompt);
    // A refusal from a store presence saw locked is the lock, not a grant
    // the person declined: no "Always Allow" would fix it.
    return lockFromFailure(
      configDir,
      storeLocked && reason === "keychain_access_denied" ? "keychain_locked" : reason,
      persistLock,
      storeIdentity,
    );
  }
  if (secret.kind !== "value") {
    return lockFromFailure(configDir, "keychain_unavailable", persistLock, storeIdentity);
  }
  clearKeychainLock(configDir);
  const auth = parseCredentials(secret.value.trim());
  if (!auth) return lockFromFailure(configDir, "keychain_unreadable", persistLock, storeIdentity);
  rememberCredential(configDir, auth, now, storeIdentity);
  return { kind: "auth", auth };
}

/** Whether this account's Keychain VALUE read is currently locked after a refusal. */
export function isKeychainLocked(configDir: string): boolean {
  return keychainLocks.has(configDir);
}

export type ResolveClaudeQuotaAuthOptions = {
  /** Host Keychain seam. Tests inject a fake; production passes `host.keychain`. */
  keychain?: HostKeychain;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Read the Keychain even when the file store answered. The vendor's own
   * 401 is the one signal worth spending the macOS ask on: it is the moment
   * a sidecar could be masking a live item. Sign-in priming also sets this
   * so the grant is requested at connect time.
   */
  preferKeychain?: boolean;
  /**
   * User-initiated: sign-in or an explicit retry. May raise the macOS ask,
   * and clears a previous decline so the read is actually retried. Background
   * quota ticks omit this: a locked account stays locked until the user asks.
   */
  allowPrompt?: boolean;
  /**
   * When false, a failed Keychain VALUE read is still classified but does not
   * write `keychainLocks`. The credential-health peek uses this so a
   * Subscriptions status poll cannot starve the meter's Retry.
   */
  persistLock?: boolean;
  /**
   * Answer from the file store alone: the Keychain is not touched, so the
   * credential remembered from it stays remembered. The credential-health
   * peek uses this on every status poll.
   */
  fileOnly?: boolean;
  /**
   * Observe the store itself rather than the credential we last read from it.
   * Two callers need this: a renewal, whose whole job is to notice that the
   * stored credential changed (a remembered copy of the old one would make
   * every renewal look unchanged), and the file-only health peek, which must
   * stay file-only. A bypassing read still REFRESHES what is remembered -
   * what it finds is by definition the current credential.
   */
  bypassCache?: boolean;
};

/**
 * Read both of the client's stores and return what the quota sensor should
 * do with them: a credential, a named Keychain lock, or nothing.
 *
 * Order matters and used to be wrong. The client keeps the Keychain
 * authoritative on macOS and can leave a `.credentials.json` behind as a
 * stale sidecar; reading the file first therefore resolves a token that may
 * be days older than the live one, and the vendor answers 401 while a good
 * credential sits one branch away. Measured on a real machine 2026-09-04: a
 * sidecar 2.4 days past expiry next to a live Keychain item. So: whichever
 * store holds the later expiry wins, and the Keychain wins when neither says.
 */
export async function resolveClaudeQuotaAuthResult(
  configDir: string,
  options: ResolveClaudeQuotaAuthOptions = {},
): Promise<ClaudeQuotaAuthResult> {
  const keychain = options.keychain ?? absentKeychain;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  const at = now();
  const allowPrompt = options.allowPrompt === true;
  const fromFile = fileAuth(await readCredentialsFile(configDir));
  // The Keychain read is the one that can raise the macOS ask, so it is only
  // reached when it can change the answer: the file is missing, the file is
  // KNOWN expired or unrenewable (so it may be the stale sidecar), or the
  // caller wants the authoritative store (sign-in prime, or the vendor just
  // rejected what we sent).
  const fileMayBeCurrent =
    fromFile !== undefined &&
    !isRefreshTokenLapsed(fromFile, at) &&
    (fromFile.expiresAt === undefined || fromFile.expiresAt > at);
  if (fromFile && fileMayBeCurrent && !options.preferKeychain) {
    return concludeClaudeAuth(fromFile, at);
  }
  if (options.fileOnly) {
    return fromFile ? concludeClaudeAuth(fromFile, at) : { status: "unavailable" };
  }
  const fromKeychain = await readKeychain({
    configDir,
    keychain,
    env,
    allowPrompt,
    persistLock: options.persistLock !== false,
    // A user-initiated read means "go and look again", so Retry and the
    // sign-in prime always reach the store. Only background ticks - the reads
    // that must not ask - are answered from memory.
    useCache: options.bypassCache !== true && !allowPrompt,
    now: at,
  });
  if (fromKeychain.kind === "locked") {
    // A live sidecar still works; a locked Keychain next to nothing is the
    // meter failure, not an empty store. A lapsed sidecar is still proof.
    if (fromFile) return concludeClaudeAuth(fromFile, at);
    // A blocked session is not a held lock: the next tick can succeed.
    if (!holdKeychainLock(fromKeychain.reason)) {
      return { status: "unavailable", reason: fromKeychain.reason };
    }
    return { status: "locked", reason: fromKeychain.reason };
  }
  if (fromKeychain.kind === "absent") {
    return fromFile ? concludeClaudeAuth(fromFile, at) : { status: "unavailable" };
  }
  if (!fromFile) return concludeClaudeAuth(fromKeychain.auth, at);
  const auth =
    (fromKeychain.auth.expiresAt ?? 0) >= (fromFile.expiresAt ?? 0) ? fromKeychain.auth : fromFile;
  return concludeClaudeAuth(auth, at);
}

/**
 * A resolved credential whose refresh token has lapsed is local proof of
 * needs_reauth: do not hand it to the vendor and do not treat it as a
 * retryable miss.
 */
function concludeClaudeAuth(auth: ClaudeQuotaAuth, now: number): ClaudeQuotaAuthResult {
  if (isRefreshTokenLapsed(auth, now)) return { status: "unrenewable" };
  return { status: "resolved", auth };
}

/**
 * The credential the client itself would consider current, or nothing.
 * Callers that need to tell a Keychain lock from an empty store should use
 * `resolveClaudeQuotaAuthResult`.
 */
export async function resolveClaudeQuotaAuth(
  configDir: string,
  options: ResolveClaudeQuotaAuthOptions = {},
): Promise<ClaudeQuotaAuth | undefined> {
  const result = await resolveClaudeQuotaAuthResult(configDir, options);
  return result.status === "resolved" ? result.auth : undefined;
}

/**
 * Request the Keychain VALUE at connect / sign-in time: the moment a
 * permission prompt is expected. Does not fail the sign-in; a refusal
 * becomes a locked meter the user can retry.
 */
export async function requestKeychainValueAccess(
  configDir: string,
  options: ResolveClaudeQuotaAuthOptions = {},
): Promise<ClaudeQuotaAuthResult> {
  return resolveClaudeQuotaAuthResult(configDir, {
    ...options,
    allowPrompt: true,
    preferKeychain: true,
  });
}

/**
 * An opaque, in-memory-only marker for "the store still holds the same
 * credential". It exists so a renewal can be OBSERVED rather than presumed:
 * the token value never leaves this module, is never logged and is never
 * persisted - only the equality of two markers is ever used.
 */
export function credentialMarker(auth: ClaudeQuotaAuth | undefined): string | undefined {
  if (!auth) return undefined;
  return createHash("sha256")
    .update(`${auth.accessToken}:${auth.expiresAt ?? ""}`)
    .digest("hex");
}

/**
 * The supported, non-interactive commands of the account's own client that
 * are known to make it look at (and, when needed, rewrite) its own session.
 * Both are documented subcommands of the client; neither starts a
 * session, sends a prompt, or opens a browser.
 *
 * The ladder exists because WHICH of them renews is a property of the vendor's
 * client, not of Infinitary, and it changes between client versions. Rather than
 * presume one, a renewal walks the ladder and stops at the first command that
 * actually changes the stored credential - so the code is correct whichever
 * one does the work, and honest when none of them does.
 */
export const CLAUDE_RENEW_COMMANDS: readonly (readonly string[])[] = [
  ["auth", "status", "--json"],
  ["doctor"],
];

/** What a delegated renewal actually achieved. */
export type ClaudeRenewOutcome =
  /** The store now holds a different credential than before. */
  | { outcome: "renewed"; auth: ClaudeQuotaAuth }
  /** Every command ran and the stored credential is unchanged. */
  | { outcome: "unchanged" }
  /**
   * A command ran, then the store could not be read. Not evidence the
   * credential is the same, and not a sign-out.
   */
  | { outcome: "unreadable" }
  /** No command could run: they all failed or timed out. */
  | { outcome: "failed" }
  /**
   * A live client session owns this store. Standing down is the safe move -
   * the refresh token behind that session is single use - and the next tick
   * tries again, so this resolves when the session ends.
   */
  | { outcome: "deferred_session" }
  /**
   * Another one-shot run held the store for longer than a renewal will wait
   * (a sign-in in progress, realistically), which makes renewing moot anyway.
   */
  | { outcome: "deferred_busy" }
  /** There is no credential in this store to renew. */
  | { outcome: "no_credential" };

export type RenewClaudeQuotaAuthOptions = ResolveClaudeQuotaAuthOptions & {
  /**
   * Run one command of the account's own client under this config root. The
   * client owns the credential; Infinitary never speaks the vendor's OAuth.
   */
  run: (configDir: string, args: readonly string[]) => Promise<unknown>;
  /**
   * Claim the account's store for the duration. Defaults to the process-wide
   * lease's RECOVERY acquisition: it waits out an ordinary one-shot run so the
   * app's own status polling cannot starve its own recovery, and stands down
   * only for a live session, whose single-use refresh token it must not race.
   */
  claim?: <T>(configDir: string, task: () => Promise<T>) => Promise<StoreLeaseResult<T>>;
  commands?: readonly (readonly string[])[];
};

/**
 * Ask the account's own client to renew its session, and report what actually
 * happened.
 *
 * This runs only when the vendor has already rejected the stored credential,
 * which is the one signal that is never stale. It never runs while a client
 * session for the same account is live: that session owns the store and the
 * refresh token behind it is single use, so a second refresher is how one
 * holder ends up presenting a spent token.
 */
export async function renewClaudeQuotaAuth(
  configDir: string,
  options: RenewClaudeQuotaAuthOptions,
): Promise<ClaudeRenewOutcome> {
  const claim = options.claim ?? runRenewalStoreTask;
  const commands = options.commands ?? CLAUDE_RENEW_COMMANDS;
  // A renewal has to see the store, not what we last read from it: comparing
  // a remembered credential with itself would report every renewal unchanged.
  const resolveOpts: ResolveClaudeQuotaAuthOptions = {
    ...options,
    preferKeychain: true,
    bypassCache: true,
  };
  const before = credentialMarker(await resolveClaudeQuotaAuth(configDir, resolveOpts));
  if (before === undefined) return { outcome: "no_credential" };
  const claimed = await claim(configDir, async (): Promise<ClaudeRenewOutcome> => {
    // Another holder may have renewed while we waited for the store. Spending
    // a single-use refresh token again to learn what is already on disk is
    // exactly the race this lease exists to prevent.
    const current = await resolveClaudeQuotaAuth(configDir, resolveOpts);
    if (current && credentialMarker(current) !== before) {
      return { outcome: "renewed", auth: current };
    }
    let ranAny = false;
    for (const args of commands) {
      try {
        await options.run(configDir, args);
        ranAny = true;
      } catch {
        continue;
      }
      const after = await resolveClaudeQuotaAuthResult(configDir, resolveOpts);
      if (after.status === "resolved") {
        if (credentialMarker(after.auth) !== before)
          return { outcome: "renewed", auth: after.auth };
      } else {
        return { outcome: "unreadable" };
      }
    }
    return ranAny ? { outcome: "unchanged" } : { outcome: "failed" };
  });
  if (claimed.ran) return claimed.value;
  return { outcome: claimed.refusal === "session_active" ? "deferred_session" : "deferred_busy" };
}

type AccountIdentityRecord = {
  identity: { label?: string; accountUuid?: string; organizationUuid?: string };
  observed: ObservedStoreIdentity;
};

/**
 * Locate and read the account config the way Claude Code does. The legacy
 * config inside the config home wins when present; otherwise the default
 * login's oauthAccount lives at the home root, not inside `.claude`.
 */
async function readAccountIdentityRecord(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AccountIdentityRecord | undefined> {
  const legacyPath = join(configDir, ".config.json");
  const home = env.CLAUDE_CONFIG_DIR?.trim() || env.HOME?.trim() || safeHomedir();
  let identityPath = legacyPath;
  try {
    const info = await stat(identityPath);
    if (!info.isFile()) throw new Error("legacy config is not a file");
  } catch {
    identityPath = join(home, ".claude.json");
  }

  try {
    const [raw, info] = await Promise.all([readFile(identityPath, "utf8"), stat(identityPath)]);
    const observed: ObservedStoreIdentity = {
      configMtimeMs: info.mtimeMs,
      configPath: identityPath,
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { identity: {}, observed };
    }
    if (!parsed || typeof parsed !== "object") return { identity: {}, observed };
    const oauth = (parsed as Record<string, unknown>).oauthAccount;
    if (!oauth || typeof oauth !== "object") return { identity: {}, observed };
    const record = oauth as Record<string, unknown>;
    const email =
      typeof record.emailAddress === "string" && record.emailAddress
        ? { label: record.emailAddress }
        : {};
    const accountUuid =
      typeof record.accountUuid === "string" && record.accountUuid
        ? { accountUuid: record.accountUuid }
        : {};
    const organizationUuid =
      typeof record.organizationUuid === "string" && record.organizationUuid
        ? { organizationUuid: record.organizationUuid }
        : {};
    return {
      identity: { ...email, ...accountUuid, ...organizationUuid },
      observed: { ...observed, ...accountUuid },
    };
  } catch {
    return undefined;
  }
}

/** The account's own config identity, for the row that lost its label. */
async function readAccountIdentity(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ label?: string } | undefined> {
  const identity = (await readAccountIdentityRecord(configDir, env))?.identity;
  return identity?.label ? { label: identity.label } : undefined;
}

function evidenceFrom(auth: ClaudeQuotaAuth, now: number): ClaudeCredentialEvidence {
  // An expired ACCESS token is renewable and says nothing about sign-in; only
  // a lapsed refresh token means the client can no longer get itself back.
  if (isRefreshTokenLapsed(auth, now)) return { state: "unrenewable" };
  return { state: "live" };
}

/**
 * The default login's stamp (the cut-off contract, docs/quota.md "Typed
 * cut-offs"), from attributes only: which login the account config names
 * (its account and organisation, digested) and when the credential was last
 * written (the plain-file store's modification time, else the Keychain
 * item's). Never a token value, and never the Keychain VALUE, so it spends
 * no macOS ask. A part this read cannot see is left out.
 */
export async function readClaudeCredentialStamp(
  configDir: string,
  options: { keychain?: HostKeychain; env?: NodeJS.ProcessEnv } = {},
): Promise<CredentialStamp> {
  const keychain = options.keychain ?? absentKeychain;
  const env = options.env ?? process.env;
  const identity = (await readAccountIdentityRecord(configDir, env))?.identity;
  const login =
    identity?.accountUuid || identity?.organizationUuid
      ? createHash("sha256")
          .update(`${identity.accountUuid ?? ""}\n${identity.organizationUuid ?? ""}`)
          .digest("hex")
          .slice(0, 16)
      : undefined;
  let written: string | undefined;
  try {
    const info = await stat(join(configDir, ".credentials.json"));
    if (info.isFile()) written = `file:${info.mtimeMs}`;
  } catch {
    // No plain-file store: the Keychain item is the store.
  }
  if (written === undefined) {
    const presence = await findClaudeKeychainItem(keychain, env)
      .then((item) => item.presence)
      .catch(() => undefined);
    if (presence?.kind === "found" && presence.modifiedAt) {
      written = `keychain:${presence.modifiedAt}`;
    }
  }
  return { ...(login ? { login } : {}), ...(written ? { written } : {}) };
}

/**
 * Read what the machine's default Claude login says about its credential,
 * WITHOUT reading a token value: the plain-file store parses locally, and
 * the Keychain answers by attribute (the probe that never raises the macOS
 * ask - that one ask belongs to the quota sensor above, and is not spent here).
 *
 * This exists because the client probe is fallible in ways that look nothing
 * like a sign-out - it is a spawned third-party binary - and the vault turns
 * "not connected" into a red badge, a sign-in card, and the removal of every
 * one of the provider's models from the routing pool. Absence of evidence
 * gets its own state so it can never be reported as a sign-out. A file that
 * cannot be read is that unknown state, not a miss, and a lapsed file does
 * not hide a present Keychain item.
 */
export async function readClaudeCredentialEvidence(
  configDir: string,
  options: { keychain?: HostKeychain; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<ClaudeCredentialEvidence> {
  const keychain = options.keychain ?? absentKeychain;
  const env = options.env ?? process.env;
  const now = (options.now ?? (() => Date.now()))();

  const file = await readCredentialsFile(configDir);
  const identity = readAccountIdentity(configDir, env);
  if (file.kind === "auth") {
    const evidence = evidenceFrom(file.auth, now);
    if (evidence.state === "live") return { ...evidence, ...(await identity) };
    // A lapsed file can be a stale sidecar. The Keychain item, by attribute
    // only, is the authoritative store; its presence is a live login.
    const keychainEvidence = await readKeychainEvidence(keychain, env, identity);
    if (keychainEvidence === "absent") return evidence;
    return keychainEvidence;
  }
  if (file.kind === "unreadable") {
    const keychainEvidence = await readKeychainEvidence(keychain, env, identity);
    // An unreadable file is not a miss. With no Keychain item to adopt, the
    // store stays unknown so a replacement sign-in cannot start over it.
    return keychainEvidence === "absent" ? { state: "unknown" } : keychainEvidence;
  }

  const keychainEvidence = await readKeychainEvidence(keychain, env, identity);
  return keychainEvidence === "absent" ? { state: "absent" } : keychainEvidence;
}

/**
 * The default login's Keychain item, by the exact service under whatever
 * account the client keyed it on (findClaudeKeychainItem), never another
 * service and never the value. `"absent"` is a definite miss.
 */
async function readKeychainEvidence(
  keychain: HostKeychain,
  env: NodeJS.ProcessEnv,
  identity: Promise<{ label?: string } | undefined>,
): Promise<ClaudeCredentialEvidence | "absent"> {
  const { presence } = await findClaudeKeychainItem(keychain, env);
  // Only a definite miss is an absence; anything else (a failed host read,
  // a timeout, a denied search) is simply unreadable.
  if (isAbsentOutcome(presence)) return "absent";
  if (presence.kind === "failed") return { state: "unknown" };
  // The item is there. Its expiry lives in the value, which reading would
  // spend the one macOS ask on - presence is the honest answer here.
  return { state: "live", ...(await identity) };
}
