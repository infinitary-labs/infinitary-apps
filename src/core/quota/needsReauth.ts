import { isNeedsReauthRow, needsReauthCardId, needsReauthCopy } from "@shared/credentialHealth";
import type { QuotaSnapshotView } from "@shared/quota";

export type NeedsReauthTarget = {
  accountId: string;
  providerName: string;
  accountLabel: string;
  cardId: string;
  copy: string;
};

/**
 * The accounts whose quota row is the terminal re-auth state. One card per
 * account; recovered rows simply drop out of this list.
 */
export function needsReauthTargets(snapshot: QuotaSnapshotView): NeedsReauthTarget[] {
  const targets: NeedsReauthTarget[] = [];
  for (const row of snapshot.providers) {
    if (!isNeedsReauthRow(row) || !row.accountId) continue;
    const accountLabel = row.accountLabel?.trim() || "account";
    targets.push({
      accountId: row.accountId,
      providerName: row.label,
      accountLabel,
      cardId: needsReauthCardId(row.accountId),
      copy: needsReauthCopy(row.label, accountLabel),
    });
  }
  return targets;
}
