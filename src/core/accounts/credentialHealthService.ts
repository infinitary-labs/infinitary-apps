import {
  CREDENTIAL_RENEW_MAX_ATTEMPTS,
  type CredentialHealth,
  isNeedsReauthHealth,
  type RenewalOutcome,
  type RenewReason,
} from "./credentialHealth";

/**
 * The fourth rider on the supervisor's existing 60s tick (spec §11.2.6):
 * per enabled account, read health and act. Single-flight per account.
 * Proactive renewal at `expiresAt - lead` is the one genuinely new
 * behavior - today's quota path still renews after a vendor 401.
 *
 * A renew failure degrades honestly: the next health() read is the source
 * of truth. This service never writes "healthy" on its own.
 */

export type CredentialHealthHost = {
  listEnabled: () => { accountId: string }[];
  health: (accountId: string) => Promise<CredentialHealth>;
  renew: (accountId: string, reason: RenewReason) => Promise<RenewalOutcome>;
};

export type CredentialHealthServiceOptions = {
  host: CredentialHealthHost;
  now?: () => number;
  maxAttempts?: number;
};

type AttemptState = { count: number };

export class CredentialHealthService {
  private readonly host: CredentialHealthHost;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly attempts = new Map<string, AttemptState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private ticking = false;

  constructor(options: CredentialHealthServiceOptions) {
    this.host = options.host;
    this.now = options.now ?? Date.now;
    this.maxAttempts = options.maxAttempts ?? CREDENTIAL_RENEW_MAX_ATTEMPTS;
  }

  async tick(now: number = this.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const account of this.host.listEnabled()) {
        await this.step(account.accountId, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async step(accountId: string, now: number): Promise<void> {
    const pending = this.inFlight.get(accountId);
    if (pending) {
      await pending;
      return;
    }
    const work = this.run(accountId, now).finally(() => {
      if (this.inFlight.get(accountId) === work) this.inFlight.delete(accountId);
    });
    this.inFlight.set(accountId, work);
    await work;
  }

  private async run(accountId: string, _now: number): Promise<void> {
    const health = await this.host.health(accountId);
    if (health.state === "unsigned" || isNeedsReauthHealth(health)) {
      this.attempts.delete(accountId);
      return;
    }
    if (health.state === "healthy") {
      this.attempts.delete(accountId);
      return;
    }
    if (health.state === "degraded") {
      // The remedy for a read/probe/parse failure is the next health() read,
      // not a renew. A no-interactive-session block has no in-process
      // remedy (spec §11.2.4) and must never be treated as terminal.
      return;
    }
    if (health.state !== "expiring") return;

    const prior = this.attempts.get(accountId);
    if (prior && prior.count >= this.maxAttempts) return;

    let outcome: RenewalOutcome;
    try {
      outcome = await this.host.renew(accountId, "proactive");
    } catch {
      outcome = { outcome: "failed" };
    }
    if (outcome.outcome === "renewed") {
      this.attempts.delete(accountId);
      return;
    }
    if (outcome.outcome === "unsupported") {
      this.attempts.delete(accountId);
      return;
    }
    if (outcome.outcome === "deferred_session" || outcome.outcome === "deferred_busy") {
      return;
    }
    this.attempts.set(accountId, { count: (prior?.count ?? 0) + 1 });
  }
}
