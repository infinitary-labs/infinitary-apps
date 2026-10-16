import { isClientIssueReason } from "@shared/claudeClient";

/**
 * Provider-agnostic credential health (spec §11.2): one owner for "keep
 * every account healthy", so renewal is not three shapes in three places.
 *
 * State machine (spec §11.2.4):
 *
 *   healthy --expiresAt-lead--> expiring --renew()--> healthy
 *      |                           |
 *      |                           +--renew failed (bounded)--> degraded(reason)
 *      +--read/probe/parse failure--> degraded(reason) --remedy--> healthy
 *      +--vendor rejection--> renewing --survived--> needs_reauth
 *                                    +--recovered--> healthy
 *   refresh-token lapsed --> needs_reauth
 *
 * `unsigned` is the honest empty-store state (first-run, logged out). It is
 * not a failure and not a re-auth: nothing to heal. `renewing` is a
 * transition the health service occupies while `renew()` is in flight;
 * backends report the durable states.
 *
 * Five-rule contract (spec §11.2.3):
 * 1. Sign in once. Any extra grant (Claude's Keychain ACL) is requested at
 *    connect, where a dialog is expected.
 * 2. Self-heal invisibly. Every failure class has a bounded automatic remedy
 *    before anything reaches a surface.
 * 3. Unknown is never absent, and a no-UI / no-interaction failure is
 *    never a "no" / sign-out.
 * 4. Escalate to needs_reauth ONLY from proof: a lapsed refresh token, or a
 *    401 that survived a real renewal.
 * 5. The terminal state is first-class, visible, and one-step recoverable.
 *
 * `status()` is a projection of this value so the vault's connected badge
 * keeps working. Infinitary never reads a token through this type: `expiresAt`
 * is an instant, not a secret.
 */

/** Access-token expiry minus this lead is when proactive renewal fires. */
export const CREDENTIAL_RENEW_LEAD_MS = 10 * 60 * 1000;
/** Proactive renewals stop after this many failed attempts in one window. */
export const CREDENTIAL_RENEW_MAX_ATTEMPTS = 3;

export type CredentialHealthState =
  | "healthy"
  | "expiring"
  | "renewing"
  | "degraded"
  | "needs_reauth"
  | "unsigned";

export type CredentialHealth = {
  state: CredentialHealthState;
  /** Why, when not a plain healthy. Never a secret. */
  reason?: string;
  /**
   * The one sentence a surface shows for this reason, when the backend has
   * one: what the person can do. Plain text, rendered verbatim.
   */
  detail?: string;
  /** Access-token expiry in ms, when the backend can observe it. */
  expiresAt?: number;
  authType?: "oauth" | "api_key";
  identity?: { label?: string; plan?: string };
  /**
   * What the store and its client look like from outside, when the backend
   * can say: the stamp a cut-off is recorded under, so it clears only when
   * one of these changes (docs/quota.md "Typed cut-offs").
   */
  stamp?: CredentialStamp;
};

/**
 * A sign-in's store and client as seen from outside - store evidence only,
 * never a token value. Each part is opaque and compared for equality alone;
 * an absent part is one this read could not see, never a change.
 */
export type CredentialStamp = {
  /** Which login the store holds: a digest of the account and organisation it names. */
  login?: string;
  /** When the store's credential was last written (a new sign-in, or a renewal). */
  written?: string;
  /** The version of the client that serves it, for a backend with a client of its own. */
  client?: string;
};

/**
 * Health reasons a recorded cut-off stamps on a connected account
 * (`AccountVault.noteCutOff`): the credential is not proven bad, so the
 * account stays connected, but it serves no model while the fact stands.
 */
export const CUT_OFF_REFUSED = "refused";
export const CUT_OFF_SIGNED_OUT = "signed_out";

/**
 * Whether an account serves models right now: connected, and not withheld
 * by a fact beside its credential - no client to run it (F14) or a
 * recorded cut-off. The one predicate the routing pool, the flagship's
 * eligibility and crew delivery read.
 */
export function servesModels(status: { connected: boolean; reason?: string }): boolean {
  return status.connected && !isWithheldReason(status.reason);
}

/** A reason that withholds a connected account from serving. */
export function isWithheldReason(reason: string | undefined): boolean {
  return isClientIssueReason(reason) || reason === CUT_OFF_REFUSED || reason === CUT_OFF_SIGNED_OUT;
}

/**
 * Why a renew was asked. The backend may ignore the distinction; the
 * quota sensor and the tick use it so a reactive 401 is not starved by
 * the proactive budget, and vice versa.
 */
export type RenewReason = "proactive" | "vendor_rejected" | "remedy";

/**
 * What a renew actually achieved, reported rather than presumed. No secret
 * crosses this seam: a caller that needs the fresh credential re-resolves
 * through the quota path after `renewed`. `withheld` is a renewal the vault
 * never asked for: the account stands refused, and a refusal never renews.
 */
export type RenewalOutcome =
  | { outcome: "renewed" }
  | {
      outcome:
        | "unchanged"
        | "unreadable"
        | "failed"
        | "deferred_session"
        | "deferred_busy"
        | "no_credential"
        | "unsupported"
        | "withheld";
    };

/** True when this health is the terminal re-auth state, never a retryable miss. */
export function isNeedsReauthHealth(health: CredentialHealth): boolean {
  return health.state === "needs_reauth";
}

/**
 * Connected for the vault badge: anything we have not proven is a sign-out
 * stays eligible. `unsigned` and `needs_reauth` are the only disconnected
 * states. Degraded and unknown project as connected (rule 3).
 */
export function isConnectedHealth(health: CredentialHealth): boolean {
  return health.state !== "needs_reauth" && health.state !== "unsigned";
}

/** Classify a live access token against the proactive lead. */
export function classifyExpiry(
  expiresAt: number | undefined,
  now: number,
  leadMs: number = CREDENTIAL_RENEW_LEAD_MS,
): "healthy" | "expiring" {
  if (expiresAt === undefined) return "healthy";
  return expiresAt - leadMs <= now ? "expiring" : "healthy";
}

/**
 * Reasons that must never become needs_reauth: we could not read, could
 * not ask, or the environment made asking impossible. Proof is the only
 * path to the terminal state (rule 3 + 4).
 */
export function isNonTerminalFailureReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return (
    reason === "unknown" ||
    reason === "unreadable" ||
    reason === "unavailable" ||
    reason === "probe_failed" ||
    reason === "client_unavailable" ||
    reason === "client_missing" ||
    reason === "client_outdated" ||
    reason === CUT_OFF_REFUSED ||
    reason === CUT_OFF_SIGNED_OUT ||
    reason.startsWith("keychain_") ||
    reason.startsWith("renewal_")
  );
}
