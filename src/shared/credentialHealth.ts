/**
 * Terminal credential health (CD-3=A): the one user-visible state, reached
 * only from proof, sticky until a sign-in, and one-step recoverable.
 *
 * `auth_required` on a quota row IS that state. The two proofs that may set
 * it: a lapsed refresh token (`refresh_token_lapsed`) or a vendor rejection
 * that survived a real renewal (`rejected_after_renewal`). Nothing else -
 * a transient failure, a no-interactive-session block, an unreadable store -
 * may ever say "sign in again".
 *
 * The provider-agnostic framework behind this (health/renew seam, proactive
 * renew at expiresAt-lead, five-rule contract) lives in
 * `src/core/accounts/credentialHealth.ts` and `docs/architecture.md` §16.4.
 */

export const REFRESH_TOKEN_LAPSED = "refresh_token_lapsed";
export const REJECTED_AFTER_RENEWAL = "rejected_after_renewal";

import type { HostEffect } from "./cards";

const AUTH_ACCOUNT_CARD_PREFIX = "card-auth-account-";

/** True when this row is the terminal re-auth state, never a retryable miss. */
export function isNeedsReauthRow(row: { status: string }): boolean {
  return row.status === "auth_required";
}

export function needsReauthCardId(accountId: string): string {
  return `${AUTH_ACCOUNT_CARD_PREFIX}${accountId}`;
}

export function accountIdFromNeedsReauthCard(cardId: string): string | undefined {
  return cardId.startsWith(AUTH_ACCOUNT_CARD_PREFIX)
    ? cardId.slice(AUTH_ACCOUNT_CARD_PREFIX.length)
    : undefined;
}

/**
 * The one way out of the terminal state, as the effect the needs_reauth
 * card's Sign in button carries (cards/tasks/agents P1): the host re-runs
 * the account's own sign-in into its existing store. Only the host authors
 * it; every emit boundary refuses a host effect.
 */
export function restoreAccountEffect(accountId: string): HostEffect {
  return { kind: "host", op: "restore-account", arg: accountId };
}

/** The one sentence the card and the row both name the account with. */
export function needsReauthCopy(providerName: string, accountLabel: string): string {
  return `${providerName} (${accountLabel}) needs you to sign in again.`;
}

export const NEEDS_REAUTH_CONSEQUENCE =
  "Infinitary cannot use this subscription until you sign in again.";
