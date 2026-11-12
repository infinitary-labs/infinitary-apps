import type { QuotaSnapshotView } from "@shared/quota";
import type { ServedModels } from "../models/servedModels";
import type { AccountVault } from "../pi/accountVault";
import type { PushedQuotaStore } from "../quota/pushedQuota";
import type { QuotaService } from "../quota/quotaService";
import type { OfferedModel } from "./acpReading";
import { AntigravityAuthBackend } from "./antigravityAuth";
import { AntigravityOffers } from "./antigravityModels";
import { AntigravityAllowance, antigravityAccounts } from "./antigravityUsage";

/**
 * This Mac's Google AI plan through the installed Antigravity
 * (docs/antigravity-client.md): the program signs in and holds the sign-in
 * (`backend`), its sessions name the models it offers (`offers`, kept for
 * the served list), and its allowance is read only on the person's press
 * (`press`, `opened`; "The allowance").
 */
export class AntigravityHome {
  readonly backend = new AntigravityAuthBackend();
  readonly offers = new AntigravityOffers();
  private allowance: AntigravityAllowance | undefined;

  /** The session factory's `onOffered`: a changed offer re-reads that account's list. */
  offered(served: Pick<ServedModels, "refresh">) {
    return (accountId: string, models: readonly OfferedModel[]) => {
      if (this.offers.note(accountId, models)) void served.refresh(accountId);
    };
  }

  /**
   * Recheck allowance, or a finished sign-in: read the allowance once.
   * True when a new reading was kept.
   */
  press(vault: AccountVault, pushed: Pick<PushedQuotaStore, "record">): Promise<boolean> {
    this.allowance ??= new AntigravityAllowance({
      accounts: antigravityAccounts(
        () => vault.list(),
        (accountId) => vault.cutOff(accountId)?.class === "signed_out",
      ),
      record: (accountId, window) => pushed.record(accountId, window),
    });
    return this.allowance.onPress();
  }

  /** The person opened Subscriptions: read, and answer the snapshot that shows it. */
  async opened(
    vault: AccountVault,
    pushed: Pick<PushedQuotaStore, "record">,
    quota: Pick<QuotaService, "latest" | "refresh">,
  ): Promise<QuotaSnapshotView | undefined> {
    if (!(await this.press(vault, pushed))) return quota.latest();
    return quota.refresh("pushed");
  }
}
