import type { QuotaSnapshotView } from "@shared/quota";
import { quotaEntryForPiProvider } from "../quota/auth";
import { effectiveFromProvider } from "../quota/catalog";
import type { DecisionStore } from "../storage/decisionStore";
import { type AccountCandidate, selectAccount } from "./accountPolicy";
import type { PlacedWorkData, PlacedWorkScores } from "./placedWork";

/**
 * Binds the pure account-selection policy to live inputs (the vault's
 * account pool, the per-account quota snapshot, the provider pin, the
 * Firstmate flagship reservation) and records every decision with its
 * reasons in the decision ledger (`account` rows) - the "why this account"
 * surface, beside the `routing` rows.
 *
 * Selection happens only at attachment points: spawn and resume. A running
 * turn is never re-bound.
 */

/** The flagship keeps this much headroom in reserve from crewmate burn. */
export const FLAGSHIP_RESERVE_FLOOR_PERCENT = 15;

/** The slice of the vault the selector reads. */
export type AccountPool = {
  list(providerId?: string): {
    id: string;
    providerId: string;
    label: string;
    enabled: boolean;
    lastSelectedAt?: number;
  }[];
  pinnedAccount(providerId: string): string | undefined;
  connectedSync(accountId: string): boolean | undefined;
  /** Why a connected account serves nothing right now, if it does not. */
  withheldReason(accountId: string): string | undefined;
  markSelected(accountId: string): void;
};

export type AccountSelectorOptions = {
  pool: AccountPool;
  placedWork?: PlacedWorkScores;
  quota: { latest(): QuotaSnapshotView | undefined };
  /** The Firstmate flagship account to protect, when one is pinned. */
  flagshipAccountId: () => string | null;
  /** The decision ledger every selection is recorded in. */
  decisions: DecisionStore;
};

export class AccountSelector {
  constructor(private readonly options: AccountSelectorOptions) {}

  /**
   * Pick the account of `piProviderId` serving a task spawn, and record why.
   * A crewmate's spawn names its `crew` model: the accounts are read in that
   * model's scope and ranked by the crew allowance bands, as routing ranked
   * the model (INF-1714); a decision model's call names none.
   */
  selectForSpawn(
    taskId: string,
    piProviderId: string,
    crew?: { model: string },
  ): string | undefined {
    const decision = this.decide(piProviderId, crew);
    if (!decision) return undefined;
    this.options.decisions.recordAccount({
      taskId,
      provider: piProviderId,
      accountId: decision.accountId ?? null,
      reasons: [...decision.reasons, ...this.withheldElsewhere(piProviderId)],
      facts: {
        kind: "account-candidates",
        candidates: decision.candidates,
        ...(decision.pinned ? { pinned: true as const } : {}),
      },
    });
    if (decision.accountId) {
      this.options.pool.markSelected(decision.accountId);
    }
    return decision.accountId;
  }

  /**
   * The account a crewmate's spawn on `model` would bind now, recording
   * nothing: routing ranks the model by this account's reading, so the
   * model and the account that serves it are judged on the same facts.
   * `placed` is the work the routing evaluation already read.
   */
  crewAccount(piProviderId: string, model: string, placed?: PlacedWorkData): string | undefined {
    return this.decide(piProviderId, { model }, placed)?.accountId;
  }

  private decide(piProviderId: string, crew?: { model: string }, placed?: PlacedWorkData) {
    const candidates = this.candidatesFor(piProviderId, crew?.model, placed);
    if (candidates.length === 0) return undefined;
    const pinned = this.options.pool.pinnedAccount(piProviderId);
    const flagship = this.options.flagshipAccountId();
    return selectAccount({
      providerId: piProviderId,
      candidates,
      ...(pinned ? { pinnedAccountId: pinned } : {}),
      ...(flagship
        ? { protect: { accountId: flagship, floorPercent: FLAGSHIP_RESERVE_FLOOR_PERCENT } }
        : {}),
      ...(crew ? { bands: true } : {}),
    });
  }

  /**
   * A resume is an attachment point: the recorded account is re-checked and
   * kept when still healthy; a dead or removed account triggers a fresh
   * selection for the task's provider (its routing decision) so the
   * transcript survives on a sibling.
   */
  reselectForResume(
    taskId: string,
    accountId: string | null,
  ): { accountId?: string; changed: boolean } {
    // A resume is a crewmate's: its account is ranked for the routed model.
    if (accountId) {
      const record = this.options.pool.list().find((account) => account.id === accountId);
      if (record?.enabled && this.options.pool.connectedSync(accountId) !== false) {
        return { accountId, changed: false };
      }
    }
    const routed = this.options.decisions.latestRouting(taskId);
    const provider = routed?.provider ?? undefined;
    if (!provider) return { changed: Boolean(accountId) };
    const reselected = this.selectForSpawn(
      taskId,
      provider,
      routed?.model ? { model: routed.model } : undefined,
    );
    return {
      ...(reselected ? { accountId: reselected } : {}),
      changed: reselected !== (accountId ?? undefined),
    };
  }

  /** The user label of an account, for user-facing copy. */
  labelOf(accountId: string): string | undefined {
    return this.options.pool.list().find((account) => account.id === accountId)?.label;
  }

  /**
   * The accounts of other providers the pool left out because they serve
   * nothing right now (their models never reached routing), so the row says
   * why they were not in the running.
   */
  private withheldElsewhere(piProviderId: string): string[] {
    return this.options.pool.list().flatMap((account) => {
      if (account.providerId === piProviderId || !account.enabled) return [];
      const reason = this.options.pool.withheldReason(account.id);
      return reason
        ? [`skipped ${account.label} (${account.providerId}): withheld (${reason})`]
        : [];
    });
  }

  private candidatesFor(
    piProviderId: string,
    model?: string,
    placed?: PlacedWorkData,
  ): AccountCandidate[] {
    const snapshot = this.options.quota.latest();
    const quotaId = quotaEntryForPiProvider(piProviderId)?.quotaId;
    const now = Date.now();
    // Every account is scored against one read of the placed work.
    const placedWork = this.options.placedWork;
    let data = placed;
    return this.options.pool.list(piProviderId).map((account) => {
      const row = snapshot?.providers.find(
        (provider) => provider.accountId === account.id && provider.provider === quotaId,
      );
      const effective = effectiveFromProvider(row, now, model);
      if (row && placedWork) data ??= placedWork.data(now);
      const score = row && data ? placedWork?.score(row, now, model, data) : undefined;
      const connected = this.options.pool.connectedSync(account.id);
      const withheld = this.options.pool.withheldReason(account.id);
      return {
        accountId: account.id,
        label: account.label,
        enabled: account.enabled,
        ...(connected !== undefined ? { connected } : {}),
        ...(withheld ? { withheld } : {}),
        ...(effective.effectivePercentRemaining !== undefined
          ? { effectivePercentRemaining: effective.effectivePercentRemaining }
          : {}),
        ...(effective.paceStatus ? { paceStatus: effective.paceStatus } : {}),
        ...(effective.spendPriority !== undefined
          ? { spendPriority: effective.spendPriority }
          : {}),
        ...(effective.lastsThroughReset !== undefined
          ? { lastsThroughReset: effective.lastsThroughReset }
          : {}),
        ...score,
        ...(account.lastSelectedAt !== undefined ? { lastSelectedAt: account.lastSelectedAt } : {}),
      };
    });
  }
}
