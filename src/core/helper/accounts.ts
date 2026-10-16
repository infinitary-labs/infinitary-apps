import { join } from "node:path";
import type { CrewSpeed } from "@shared/crewSpeed";
import { backendForProvider, CLAUDE_PROVIDER_ID, type ProviderView } from "@shared/providers";
import { KEYCHAIN_VALUE_FAILURE_THERE, type QuotaSnapshotView } from "@shared/quota";
import type { AccountBackend } from "../accounts/accountBackend";
import { CredentialHealthService } from "../accounts/credentialHealthService";
import { buildProviderViews } from "../accounts/providerViews";
import { ClaudeAuthBackend } from "../claude/claudeAuth";
import {
  clearKeychainLock,
  defaultClaudeConfigDir,
  resolveClaudeQuotaAuthResult,
} from "../claude/claudeQuota";
import { absentKeychain, type HostKeychain } from "../host";
import { type AccountStoreOptions, createAccountStore } from "../models/accountStore";
import type { AccountVault } from "../pi/accountVault";
import { PiAccountBackend } from "../pi/piAccountBackend";
import { PiAuthService } from "../pi/piAuth";
import { type ManagedAuth, quotaEntryForPiProvider } from "../quota/auth";
import { managedFromClaudeAuthResult } from "../quota/claudeAuthResolve";
import { createQuotaFetcher } from "../quota/fetchQuota";
import { createQuotaHttp, type QuotaHttp } from "../quota/http";
import type { ProviderOutcome } from "../quota/outcome";
import { mergeStaleProviders } from "../quota/quotaService";

/**
 * A computer that runs work's own sign-ins (docs/helper.md, "Its own
 * sign-ins"): an account store of its own under its data folder, the same
 * `AccountVault` the home keeps its sign-ins in, with Pi's accounts and
 * Claude on this macOS user's own login, which a code pasted back at the home
 * signs in when there is none. The login is looked for in its file and in
 * this Mac's saved passwords, where macOS keeps it, never asking, and a
 * sign-in starts only once Claude Code itself says there is none. Nothing of
 * the home's sign-ins is here, and nothing here leaves for the home but the
 * account rows and the allowance read here.
 *
 *   work/accounts/        the store: registry.json and one 0700 folder per account
 *   work/pi-base/         Pi's catalog, which says how each provider signs in
 *
 * The allowance is read here, on this computer's own clock, and renewal runs
 * only here: the home holds no store for these accounts, so it cannot renew
 * one. Claude's is read with this macOS user's own login, and never with a
 * macOS dialog: nobody may be at this screen to answer one, so a read macOS
 * would have to ask about is said at the home instead.
 */

/** How often the allowance is read while nothing asks for it. */
const ALLOWANCE_EVERY_MS = 5 * 60 * 1000;

/**
 * How often an account's own model list is read again, failed or not: once a
 * day, as this Mac's own pass. Claude's read starts its client and holds the
 * login's store while it runs, so it never rides each allowance read.
 */
const MODEL_LISTS_EVERY_MS = 24 * 60 * 60 * 1000;

export type ComputerAccounts = {
  vault: AccountVault;
  speedCapabilities?: (accountId: string, id: string) => readonly CrewSpeed[] | undefined;
  speedExpiresAt?: (accountId: string, id: string) => number | undefined;
  /** What this computer can sign in to, with why it cannot (Claude Code not installed). */
  providers: () => ProviderView[];
  /** The newest reading of every account's allowance; null before the first. */
  allowance: () => QuotaSnapshotView | null;
  /** Reads the allowance now; one read at a time. */
  readAllowance: (reason: string) => Promise<QuotaSnapshotView | null>;
  /**
   * Reads one account's own model list now, as after a sign-in. Settles when
   * the read does and never rejects; nothing waits on it but a test.
   */
  readModels?: (accountId: string) => Promise<void>;
  /**
   * The ids a Codex or Grok account's own list named at its last successful
   * read here, which the home narrows this computer's list by behind its own
   * rail (`narrowServedThere`); undefined for any other account, or with none.
   */
  accountList?: (accountId: string) => readonly string[] | undefined;
  /** Stops the clock that reads the allowance and renews what is expiring. */
  close: () => void;
};

export type ComputerAccountsOptions = {
  dataDir: string;
  /** Every new reading of the allowance. */
  onAllowance: (snapshot: QuotaSnapshotView) => void;
  /** The allowance's requests; the providers' own endpoints unless a test stands in its own. */
  http?: QuotaHttp;
  /** A stand-in Claude client check, for tests; production looks at this Mac. */
  claude?: ConstructorParameters<typeof ClaudeAuthBackend>[0];
  /** A stand-in for the model list Claude's client here answers, for tests (`AccountStoreOptions.claudeList`). */
  claudeList?: AccountStoreOptions["claudeList"];
  /** Whether it runs from a packaged app; the dev and test list addresses are read only off one. */
  packaged?: boolean;
  /**
   * This Mac's saved passwords, where Claude Code keeps its login: the work
   * mode passes the app's own reader, and only ever reads without asking.
   * Without one, only the login's file is read.
   */
  keychain?: HostKeychain;
  /** Starts the clock; tests drive `readAllowance` themselves. */
  clock?: boolean;
  /** A runtime's model list settled: the home should hear which models this computer serves. */
  onModels?: () => void;
  log?: (line: string) => void;
  now?: () => number;
};

export async function startComputerAccounts(
  options: ComputerAccountsOptions,
): Promise<ComputerAccounts> {
  const now = options.now ?? Date.now;
  const accountsDir = join(options.dataDir, "accounts");
  const baseDir = join(options.dataDir, "pi-base");
  const base = await PiAuthService.create({
    authDir: baseDir,
    authPath: join(baseDir, "auth.json"),
    modelsPath: join(baseDir, "models.json"),
  });
  const keychain = options.keychain ?? absentKeychain;
  // Claude on this macOS user's own login: adopted when it is here, and
  // otherwise signed in with a code pasted back at the home, never a browser
  // here. A sign-in asks macOS nothing: the allowance read after it is the
  // same silent read as every other.
  const claude = new ClaudeAuthBackend({
    keychain,
    primeKeychain: async () => {},
    ...options.claude,
    pasteCode: true,
  });
  const claudeDir = options.claude?.configDir ?? (() => defaultClaudeConfigDir());
  const pi = new PiAccountBackend({
    modelsPath: join(baseDir, "models.json"),
    ...(options.onModels ? { onCatalogRefreshed: options.onModels } : {}),
  });
  // The model lists are built as the home builds its own (docs/model-lists.md),
  // so the home's Automatic start routes among what each account here serves
  // (docs/helper.md, "Automatic starts"): Claude's client's own list, else
  // its shipped one. Codex's and Grok's own lists are judged at the home,
  // which holds the models the captain kept that the rail protects.
  const { vault, served } = createAccountStore(
    { accountsDir },
    {
      pi,
      backends: [claude],
      now,
      packaged: options.packaged ?? false,
      claudeConfigDir: claudeDir,
      ...(options.claudeList ? { claudeList: options.claudeList } : {}),
      http: options.http,
      rail: "home",
      ...(options.onModels ? { onSettled: options.onModels } : {}),
      ...(options.log ? { log: options.log } : {}),
    },
  );
  const providers = () =>
    buildProviderViews({
      piProviders: () => base.providers(),
      backends: new Map<string, AccountBackend>([[claude.id, claude]]),
      accounts: () =>
        vault.list().map((account) => ({
          providerId: account.providerId,
          connected: vault.connectedSync(account.id),
        })),
    });

  // Claude's allowance is read with this macOS user's own login, as the home
  // reads its own (docs/quota.md), with one difference: nothing here ever
  // lets macOS ask. A read it would have to ask about - no permission given
  // here yet, or the saved passwords locked - is said in the row at the home,
  // in words for a computer (`KEYCHAIN_VALUE_FAILURE_THERE`), and the next
  // read tries again: with no Retry here, a refusal is never held.
  const claudeUnread = new Map<string, ProviderOutcome>();
  const resolveClaude = async (accountId: string): Promise<ManagedAuth | undefined> => {
    const dir = claudeDir();
    clearKeychainLock(dir);
    const mapped = managedFromClaudeAuthResult(
      await resolveClaudeQuotaAuthResult(dir, { keychain, allowPrompt: false, persistLock: false }),
      KEYCHAIN_VALUE_FAILURE_THERE,
    );
    if (mapped.unresolved) claudeUnread.set(accountId, mapped.unresolved);
    else claudeUnread.delete(accountId);
    return mapped.managed;
  };
  const isClaude = (accountId: string) =>
    vault
      .list()
      .some((account) => account.id === accountId && account.providerId === CLAUDE_PROVIDER_ID);
  // Whatever a read is for, it never asks: the fetcher's `allowPrompt` stops here.
  const resolve = (accountId: string): Promise<ManagedAuth | undefined> =>
    isClaude(accountId) ? resolveClaude(accountId) : vault.resolveForQuota(accountId);

  // The allowance, read here with each account's own store.
  const fetch = createQuotaFetcher({
    auth: {
      accounts: () =>
        vault.list().flatMap((account) => {
          if (!account.enabled) return [];
          const entry = quotaEntryForPiProvider(account.providerId);
          if (!entry?.sensed) return [];
          return [
            {
              accountId: account.id,
              accountLabel: account.label,
              quotaId: entry.quotaId,
              piId: entry.piId,
              providerLabel: entry.label,
            },
          ];
        }),
      resolve: (accountId) => resolve(accountId),
      unresolved: (accountId) => claudeUnread.get(accountId),
      // A rejection is renewed here, by the account's own store, and only here.
      renew: async (accountId) => {
        const outcome = await vault.renew(accountId, "vendor_rejected");
        if (outcome.outcome !== "renewed") return { outcome: outcome.outcome };
        const auth = await resolve(accountId);
        return auth ? { outcome: "renewed" as const, auth } : { outcome: "unreadable" as const };
      },
    },
    http: options.http ?? createQuotaHttp(),
    models: () => [],
    onAccepted: (accountId) => vault.noteAccepted(accountId),
    now,
  });
  // Each account's own model list is read as this Mac reads its own: when it
  // is first seen here, after a sign-in, and once a day after its last try,
  // whether that try succeeded or failed. A read that could not start while
  // a session held the login's store is no try, so the next allowance read
  // starts it again.
  const listTried = new Map<string, number>();
  const readModels = (accountId: string): Promise<void> => {
    listTried.set(accountId, now());
    return served.refresh(accountId).then((settled) => {
      if (settled === "deferred") listTried.delete(accountId);
    });
  };
  let latest: QuotaSnapshotView | null = null;
  let reading: Promise<QuotaSnapshotView | null> | undefined;
  const readAllowance = (reason: string): Promise<QuotaSnapshotView | null> => {
    for (const account of vault.list()) {
      const tried = listTried.get(account.id);
      if (account.enabled && (tried === undefined || now() - tried >= MODEL_LISTS_EVERY_MS))
        void readModels(account.id);
    }
    reading ??= fetch(reason)
      .then(({ snapshot }) => {
        latest = mergeStaleProviders(snapshot, latest ?? undefined, now());
        options.onAllowance(latest);
        return latest;
      })
      .catch((error: unknown) => {
        options.log?.(`the allowance could not be read: ${messageOf(error)}`);
        return latest;
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };

  // Proactive renewal, before a sign-in expires, on this computer alone.
  const health = new CredentialHealthService({
    host: {
      listEnabled: () =>
        vault.list().flatMap((account) => (account.enabled ? [{ accountId: account.id }] : [])),
      health: (accountId) => vault.health(accountId, { refresh: true }),
      renew: (accountId, reason) => vault.renew(accountId, reason),
    },
    now,
  });
  let timers: NodeJS.Timeout[] = [];
  if (options.clock !== false) {
    timers = [
      setInterval(() => void readAllowance("interval"), ALLOWANCE_EVERY_MS),
      setInterval(() => void health.tick().catch(() => undefined), 60_000),
    ];
    for (const timer of timers) timer.unref();
  }
  await vault.warm().catch(() => undefined);
  if (vault.list().length > 0) void readAllowance("startup");
  return {
    vault,
    readModels,
    accountList: (accountId) => {
      const account = vault.get(accountId);
      if (!account || backendForProvider(account.providerId) !== "pi") return undefined;
      return served.read(accountId)?.models.map((model) => model.id);
    },
    speedCapabilities: (accountId, id) => served.speeds(accountId, id),
    speedExpiresAt: (accountId, id) => served.speedExpiresAt(accountId, id),
    providers,
    allowance: () => latest,
    readAllowance,
    close: () => {
      for (const timer of timers) clearInterval(timer);
      timers = [];
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
