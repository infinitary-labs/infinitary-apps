import {
  clockTime,
  creditsOfferOf,
  type QuotaCreditState,
  type QuotaProviderView,
  type QuotaSnapshotView,
  servedProviderOf,
} from "@shared/quota";
import { effectiveFromProvider, limitingResetOf } from "./catalog";

/**
 * Keep going on credits (INF-4104 piece 2, docs/quota.md "Keep going on
 * credits"): the account's switch laid over its quota row, and what a new
 * snapshot says about an account that keeps going - it started spending
 * credits, its credits ran out, or they answer again.
 */

/** The row with its account's switch laid over it: on, or absent. */
export function stampSwitch(
  row: QuotaProviderView,
  keepsGoing: (accountId: string) => boolean,
): QuotaProviderView {
  const { keepGoingOnCredits: _was, ...rest } = row;
  return row.accountId && keepsGoing(row.accountId) ? { ...rest, keepGoingOnCredits: true } : rest;
}

/** Every row of a snapshot with its account's switch laid over it. */
export function stampSnapshot(
  snapshot: QuotaSnapshotView,
  keepsGoing: (accountId: string) => boolean,
): QuotaSnapshotView {
  return {
    ...snapshot,
    providers: snapshot.providers.map((row) => stampSwitch(row, keepsGoing)),
  };
}

/** What one snapshot changed for the accounts that keep going on credits. */
export type CreditsChange = {
  /** One feed line each: an account started spending credits, or its credits ran out. */
  lines: string[];
  /** Accounts whose credits answer again after they were spent or off (a top-up). */
  available: string[];
};

type Seen = { spending: boolean; state: QuotaCreditState | undefined };

/** The account in a feed line: its provider and, where it has one, its label. */
function nameOf(row: QuotaProviderView): string {
  return row.accountLabel ? `${row.label} · ${row.accountLabel}` : row.label;
}

/**
 * Reads each snapshot against the one before it. A line is said only for a
 * change seen while the app runs, so a restart says nothing again.
 */
export class CreditsWatch {
  private readonly seen = new Map<string, Seen>();

  /** `switchOn` reads the account's switch itself, held by a refusal or not. */
  constructor(private readonly switchOn: (accountId: string) => boolean) {}

  observe(snapshot: QuotaSnapshotView, now: number): CreditsChange {
    const lines: string[] = [];
    const available: string[] = [];
    for (const row of snapshot.providers) {
      const accountId = row.accountId;
      if (!accountId) continue;
      const before = this.seen.get(accountId);
      const state = row.credits?.state;
      const spending =
        row.status === "ok" && !row.stale && effectiveFromProvider(row, now).onCredits === true;
      this.seen.set(accountId, { spending, state });
      if (!before || !this.switchOn(accountId)) continue;
      if (spending && !before.spending) {
        const reset = limitingResetOf(row, now);
        lines.push(
          `${nameOf(row)} is spending credits now: its allowance is used up${
            reset !== undefined ? ` until ${clockTime(reset)}` : ""
          }.`,
        );
      }
      if (state === "spent" && before.state !== "spent") {
        lines.push(
          `${nameOf(row)} has used up its credits. Work on it waits until its allowance resets.`,
        );
      }
      if (state === "available" && (before.state === "spent" || before.state === "off")) {
        available.push(accountId);
      }
    }
    return { lines, available };
  }
}

/** One crew run-out card to raise: the account and what its credits are. */
export type CreditsOffer = {
  accountId: string;
  name: string;
  resetsAt?: string;
  credits: { usedPercent?: number; balance?: string };
};

/**
 * The crew's run-out cards a decision earns (docs/quota.md "Keep going on
 * credits"): each account of the named providers whose allowance is spent,
 * whose provider says its credits are available and whose switch is off
 * (`switchOn`) - once per account until its allowance answers again,
 * remembered in `offered` (`forgetAnsweredOffers`). A reset time is not the
 * key: Codex's moves with every reading.
 */
export function creditsOffers(
  snapshot: QuotaSnapshotView | undefined,
  piProviders: readonly string[],
  offered: Set<string>,
  switchOn: (accountId: string) => boolean,
  now: number,
): CreditsOffer[] {
  const offers: CreditsOffer[] = [];
  for (const row of snapshot?.providers ?? []) {
    const accountId = row.accountId;
    if (!accountId || switchOn(accountId)) continue;
    const credits = creditsOfferOf(row);
    if (!credits || !piProviders.includes(servedProviderOf(row.provider))) continue;
    const effective = effectiveFromProvider(row, now).effectivePercentRemaining;
    if (effective === undefined || effective > 0) continue;
    if (offered.has(accountId)) continue;
    offered.add(accountId);
    const reset = limitingResetOf(row, now);
    offers.push({
      accountId,
      name: nameOf(row),
      ...(reset !== undefined ? { resetsAt: clockTime(reset) } : {}),
      credits,
    });
  }
  return offers;
}

/**
 * Each offered account whose allowance answers again (a measured reading
 * above zero) may be offered once more when it is next spent.
 */
export function forgetAnsweredOffers(
  snapshot: QuotaSnapshotView | undefined,
  offered: Set<string>,
  now: number,
): void {
  for (const row of snapshot?.providers ?? []) {
    if (!row.accountId || !offered.has(row.accountId)) continue;
    const effective = effectiveFromProvider(row, now).effectivePercentRemaining;
    if (effective !== undefined && effective > 0) offered.delete(row.accountId);
  }
}
