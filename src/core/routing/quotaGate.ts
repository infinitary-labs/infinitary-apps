import { SLOTS, type Slot } from "@shared/modelSlots";
import {
  type ModelsCatalogView,
  QUOTA_TO_PI_PROVIDER,
  type QuotaSnapshotView,
} from "@shared/quota";
import type { PiModelRef } from "./routingEngine";

/** What a quota-reset gate reads, each only when its ref needs it. */
export type QuotaGateReads = {
  /** The routing pool: every model a sign-in serves now. */
  availableModels: () => PiModelRef[];
  /** The slots one offering sits in (`ModelSlots.slotsOf`), empty when it is off. */
  slotsOf: (ref: PiModelRef) => readonly Slot[];
  quota: {
    latest: () => QuotaSnapshotView | undefined;
    latestModels: () => ModelsCatalogView | undefined;
  };
};

/**
 * Whether a quota-reset ref names a scope `quotaGateCleared` can ever
 * evaluate, or the gate would rot unclearable (R1).
 */
export function quotaGateRefValid(ref: string): boolean {
  return ref.startsWith("bucket:")
    ? SLOTS.includes(ref.slice("bucket:".length) as Slot)
    : ref in QUOTA_TO_PI_PROVIDER;
}

/**
 * Whether a quota-reset gate's scope has headroom again (R1). A bucket ref
 * clears when any available model placed in that slot has headroom, or
 * unknown headroom - uncertainty stays eligible - so a slot no model sits
 * in clears only once one is placed there, never on a reset. A provider
 * ref clears when any of its windows has headroom.
 */
export function quotaGateCleared(ref: string, reads: QuotaGateReads): boolean {
  if (ref.startsWith("bucket:")) {
    const bucket = ref.slice("bucket:".length) as Slot;
    const catalog = reads.quota.latestModels()?.models ?? [];
    return reads.availableModels().some((model) => {
      if (!reads.slotsOf(model).includes(bucket)) return false;
      const row = catalog.find(
        (entry) => QUOTA_TO_PI_PROVIDER[entry.provider] === model.provider && entry.id === model.id,
      );
      return !(
        typeof row?.effectivePercentRemaining === "number" && row.effectivePercentRemaining <= 0
      );
    });
  }
  return (
    reads.quota
      .latest()
      ?.providers.some(
        (provider) =>
          provider.provider === ref &&
          provider.windows.some(
            (window) => typeof window.percentRemaining !== "number" || window.percentRemaining > 0,
          ),
      ) ?? false
  );
}
