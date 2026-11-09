import type { CutOff } from "@shared/authFailure";
import {
  accountIdFromNeedsReauthCard,
  needsReauthCopy,
  REFRESH_TOKEN_LAPSED,
} from "@shared/credentialHealth";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import type { QuotaSnapshotView } from "@shared/quota";
import type { ClaudeRateLimit } from "../claude/claudeEvents";
import { CLAUDE_MODELS } from "../claude/claudeModels";
import {
  claudeCredentialStamp,
  defaultClaudeConfigDir,
  readClaudeStore,
} from "../claude/claudeQuota";
import type { HostCapabilities } from "../host";
import type { ServedModels } from "../models/servedModels";
import type { CardService } from "../orchestrator/cardService";
import type { AccountVault } from "../pi/accountVault";
import type { PiAuthService } from "../pi/piAuth";
import type { StandIns } from "../standIns";
import type { AppDatabase } from "../storage/db";
import { type QuotaCatalogModel, quotaEntryForPiProvider } from "./auth";
import { buildModelsCatalog, effectiveFromProvider } from "./catalog";
import { managedFromClaudeStore } from "./claudeAuthResolve";
import { createQuotaFetcher } from "./fetchQuota";
import { createFixtureRefresh } from "./fixture";
import { createQuotaHttp } from "./http";
import { needsReauthTargets } from "./needsReauth";
import type { ProviderOutcome } from "./outcome";
import { PushedQuotaStore, pushedProviderViews, withRejectedReadings } from "./pushedQuota";
import { type QuotaRefresh, QuotaService } from "./quotaService";
import { lowestLeft, recordCutOff } from "./spentAllowance";

/**
 * The home's allowance wiring (docs/quota.md): the sensor that reads each
 * enabled account's allowance from that account's own store (broker phase
 * 2), the readings a session pushes, the cut-offs a session observes, and
 * the catalog routing walks. Unknown is never zero, and only a refused
 * refresh token or a 401 that survived a real renewal says sign in again.
 */
export type HomeQuota = {
  quota: QuotaService;
  /** Plan-window readings a session pushed, and the refusals among them. */
  pushed: PushedQuotaStore;
  /** Every model the quota catalog carries: provider-wide, served-aware. */
  catalogModels: () => QuotaCatalogModel[];
  /**
   * A plan-window reading a Claude client pushed - a crewmate's, the
   * classifier's or the seat's - recorded for the account's quota.
   */
  recordClaudeRateLimit: (accountId: string, reading: ClaudeRateLimit) => void;
  /** A typed cut-off a session observed, recorded on its account (`recordCutOff`). */
  noteCutOff: (accountId: string, cutOff: CutOff) => void;
  /** The first mate's one-line allowance digest (`quotaContextLine`). */
  contextLine: () => string;
  /**
   * A changed login (the machine's Claude login switched, say): what the old
   * login was refused or read is not this account's any more, so its saved
   * refusals and last reading go and a new reading is taken now
   * (docs/quota.md "A changed login").
   */
  forgetLogin: (accountId: string) => void;
  /**
   * CD-3=A: the terminal needs_reauth card is raised only from a quota row
   * that is already auth_required (proof-gated). Recovered rows drop the
   * matching singleton. A !connected sweep is not proof and must never
   * mint this card - first-run, unknown, and retryable misses stay quiet.
   */
  syncNeedsReauthCards: (
    snapshot: QuotaSnapshotView,
    cards: Pick<CardService, "hostCards" | "snapshot">,
  ) => void;
};

/**
 * The machine's default Claude config root when this account is Claude,
 * or nothing. Locations only - never a credential. CD-1=B: not the vault
 * account directory, which is bookkeeping only.
 */
export function claudeStoreDirOf(vault: AccountVault, accountId: string): string | undefined {
  const account = vault.list().find((row) => row.id === accountId);
  if (!account || quotaEntryForPiProvider(account.providerId)?.quotaId !== "claude") {
    return undefined;
  }
  return defaultClaudeConfigDir();
}

export function startHomeQuota(options: {
  host: Pick<HostCapabilities, "keychain">;
  standIns: Pick<StandIns, "quotaFixtureDir" | "quotaEndpoints">;
  db: AppDatabase;
  vault: AccountVault;
  served: ServedModels;
  auth: PiAuthService;
  /** Each new snapshot, once read. */
  broadcast: (snapshot: QuotaSnapshotView) => void;
}): HomeQuota {
  const { host, db, vault, served, auth } = options;
  const pushedQuota = new PushedQuotaStore(db);
  const quotaUnresolved = new Map<string, ProviderOutcome>();
  /**
   * The quota catalog's rows for a client-served provider: the shipped list
   * plus whatever a successful read added, named as the shipped list names
   * them where it does. The catalog is provider-wide on purpose - it is
   * what routing walks, so every served id must have a row.
   */
  const servedCatalogModels = (
    providerId: string,
    shipped: ReadonlyArray<{ id: string; name: string }>,
  ): { provider: string; id: string; name: string }[] => {
    const byId = new Map(shipped.map((model) => [model.id, model.name]));
    for (const account of vault.list()) {
      if (account.providerId !== providerId || !account.enabled) continue;
      for (const model of served.read(account.id)?.models ?? []) {
        if (!byId.has(model.id)) byId.set(model.id, model.name ?? model.id);
      }
    }
    return [...byId.entries()].map(([id, name]) => ({ provider: providerId, id, name }));
  };
  const catalogModels = () => [
    ...auth.catalogModels(vault.piModelRuntimes()),
    ...servedCatalogModels(CLAUDE_PROVIDER_ID, CLAUDE_MODELS),
  ];
  const resolveQuotaAuth = async (accountId: string, resolve?: { allowPrompt?: boolean }) => {
    // A Claude account's usage credential is the machine's default
    // login (bare Keychain item / ~/.claude). Every other sensed account
    // resolves through its Pi runtime. Infinitary never mints Anthropic OAuth.
    const claudeDir = claudeStoreDirOf(vault, accountId);
    if (claudeDir !== undefined) {
      const read = await readClaudeStore(claudeDir, {
        keychain: host.keychain,
        allowPrompt: resolve?.allowPrompt,
      });
      vault.noteCredentialRead(
        accountId,
        claudeCredentialStamp(read),
        read.state === "present" ? read.identity : undefined,
      );
      const mapped = managedFromClaudeStore(read);
      if (mapped.unresolved) quotaUnresolved.set(accountId, mapped.unresolved);
      else quotaUnresolved.delete(accountId);
      return mapped.managed;
    }
    return vault.resolveForQuota(accountId);
  };
  const endRefusedReadings = (accountId: string) => {
    for (const window of pushedQuota.windowsFor(accountId)) {
      if (window.status === "rejected") {
        pushedQuota.record(accountId, { ...window, status: "allowed", at: Date.now() });
      }
    }
  };
  // Dev/e2e can point the quota sensor at fixture files instead of live APIs.
  const fixtureDir = options.standIns.quotaFixtureDir;
  const quotaRefresh: QuotaRefresh = fixtureDir
    ? createFixtureRefresh(fixtureDir)
    : createQuotaFetcher({
        // One sensor call per enabled account, resolved from that account's
        // own store (broker phase 2).
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
          resolve: resolveQuotaAuth,
          // A Pi account whose refresh token the provider refused is the
          // lapsed-sign-in proof: the row says sign in again.
          unresolved: (accountId) =>
            quotaUnresolved.get(accountId) ??
            (vault.refreshLapsed(accountId)
              ? { status: "auth_required", windows: [], reason: REFRESH_TOKEN_LAPSED }
              : undefined),
          /**
           * One caller of AccountBackend.renew (spec §11.2.5): the reactive
           * 401 path. Non-Claude proactive renew rides the supervisor
           * tick. Neither path returns a secret; we re-resolve after a
           * successful rotation.
           */
          renew: async (accountId) => {
            const outcome = await vault.renew(accountId, "vendor_rejected");
            if (outcome.outcome !== "renewed") return { outcome: outcome.outcome };
            const managed = await resolveQuotaAuth(accountId);
            return managed
              ? { outcome: "renewed" as const, auth: managed }
              : { outcome: "unreadable" as const };
          },
        },
        http: createQuotaHttp(),
        // Dev/e2e only, exactly like the fixture seam above: a packaged app
        // never reads it, so the real endpoints cannot be redirected in a
        // build anyone runs.
        ...(options.standIns.quotaEndpoints ? { endpoints: options.standIns.quotaEndpoints } : {}),
        models: () => catalogModels(),
        loginOf: (accountId) => vault.loginSync(accountId),
        // A session's refusal is a zero window until its reset, even on a
        // sensed row: the vendor said no, and the sensor lags behind it.
        onAccepted: (accountId, windows) => {
          vault.noteAccepted(accountId);
          // More left than when the allowance was refused: credits were
          // added, so the hold and its refused reading end now.
          const left = lowestLeft(windows);
          if (left !== undefined && vault.noteReading(accountId, left))
            endRefusedReadings(accountId);
        },
        overlay: (view, now) =>
          view.accountId
            ? withRejectedReadings(view, pushedQuota.windowsFor(view.accountId), now)
            : view,
        // Session-pushed readings still merge for any provider the HTTP
        // sensor does not cover.
        pushed: (now) =>
          pushedProviderViews(
            vault.list().flatMap((account) => {
              const entry = quotaEntryForPiProvider(account.providerId);
              if (!entry || entry.sensed) return [];
              return [
                {
                  accountId: account.id,
                  accountLabel: account.label,
                  quotaId: entry.quotaId,
                  providerLabel: entry.label,
                },
              ];
            }),
            (accountId) => pushedQuota.windowsFor(accountId),
            now,
          ),
      });
  const quota = new QuotaService({
    refresh: quotaRefresh,
    db,
    // The fixture seam (dev/e2e) supplies its own catalog; only the real
    // fetcher's catalog is rebuilt when a read lands.
    ...(fixtureDir
      ? {}
      : {
          catalogFor: (snapshot: QuotaSnapshotView) =>
            buildModelsCatalog(catalogModels(), snapshot.providers, snapshot.generatedAt),
        }),
    broadcast: options.broadcast,
  });
  return {
    quota,
    pushed: pushedQuota,
    catalogModels,
    recordClaudeRateLimit: (accountId, reading) => {
      if (!reading.windowId) return;
      const refusedBefore = pushedQuota
        .windowsFor(accountId)
        .some((window) => window.windowId === reading.windowId && window.status === "rejected");
      pushedQuota.record(accountId, {
        windowId: reading.windowId,
        status: reading.status,
        ...(reading.utilization !== undefined ? { utilization: reading.utilization } : {}),
        ...(reading.resetsAt !== undefined ? { resetsAt: reading.resetsAt } : {}),
        at: Date.now(),
      });
      // A window that just said no, or just stopped saying it, moves the
      // account's headroom now rather than at the next sensor pass.
      if ((reading.status === "rejected") !== refusedBefore) void quota.refresh("pushed");
    },
    noteCutOff: (accountId, cutOff) =>
      recordCutOff(
        {
          providerOf: (id) => vault.get(id)?.providerId,
          latest: () => quota.latest(),
          hold: (id, held, seen) => vault.noteCutOff(id, held, seen),
          holding: (id) => vault.cutOff(id)?.class === "no_headroom",
          refuse: (id, refused) =>
            pushedQuota.record(id, {
              windowId: refused.windowId,
              status: "rejected",
              resetsAt: refused.resetsAt,
              at: refused.at,
            }),
          refresh: () => void quota.refresh("pushed"),
        },
        accountId,
        cutOff,
        Date.now(),
      ),
    contextLine: () => quotaContextLine(quota.latest()),
    forgetLogin: (accountId) => {
      pushedQuota.forget(accountId);
      quota.forgetAccount(accountId);
      void quota.refresh("account-changed");
    },
    syncNeedsReauthCards: (snapshot, cards) => {
      const accounts = vault.list();
      const wanted = new Set<string>();
      for (const target of needsReauthTargets(snapshot)) {
        wanted.add(target.cardId);
        const label =
          accounts.find((account) => account.id === target.accountId)?.label ?? target.accountLabel;
        cards.hostCards.addAuthDecisionCard(
          target.cardId,
          target.providerName,
          needsReauthCopy(target.providerName, label),
          { restoreAccountId: target.accountId },
        );
      }
      for (const card of cards.snapshot()) {
        const accountId = accountIdFromNeedsReauthCard(card.id);
        if (accountId !== undefined && !wanted.has(card.id)) {
          cards.hostCards.clearAuthDecisionCard(card.id);
        }
      }
    },
  };
}

/**
 * A compact one-line quota digest for the Firstmate context block: each
 * account's EFFECTIVE remaining (min across its bounding windows - never an
 * arbitrary window) plus its spend priority when measurable (quota-axi
 * semantics: higher = paid allowance on track to expire unused).
 */
export function quotaContextLine(snapshot: QuotaSnapshotView | undefined): string {
  if (!snapshot || snapshot.providers.length === 0) return "unknown";
  const now = Date.now();
  const parts = snapshot.providers
    .filter((provider) => provider.status === "ok")
    .flatMap((provider) => {
      const effective = effectiveFromProvider(provider, now);
      if (typeof effective.effectivePercentRemaining !== "number") return [];
      const subject = provider.accountLabel
        ? `${provider.provider}/${provider.accountLabel}`
        : provider.provider;
      const priority =
        typeof effective.spendPriority === "number"
          ? ` (spend priority ${effective.spendPriority.toFixed(2)})`
          : "";
      return [`${subject} ${Math.round(effective.effectivePercentRemaining)}%${priority}`];
    });
  return parts.length > 0 ? parts.join("; ") : "unknown";
}
