import { SLOTS, type Slot } from "@shared/modelSlots";
import {
  answersOnCredits,
  isAllowanceProvider,
  type ModelsCatalogView,
  type QuotaSnapshotView,
  servedModelKey,
} from "@shared/quota";
import { allowanceSpent } from "@shared/quotaSignals";
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
    : isAllowanceProvider(ref);
}

/**
 * Whether a quota-reset gate's scope has headroom again (R1). A bucket ref
 * clears when any available model placed in that slot has headroom, or
 * unknown headroom - uncertainty stays eligible - so a slot no model sits
 * in clears only once one is placed there, never on a reset. A provider
 * ref clears when any of its windows has headroom. Either clears, too, on
 * an account that keeps going on credits (`answersOnCredits`).
 */
export function quotaGateCleared(ref: string, reads: QuotaGateReads): boolean {
  if (ref.startsWith("bucket:")) {
    const bucket = ref.slice("bucket:".length) as Slot;
    const catalog = reads.quota.latestModels()?.models ?? [];
    return reads.availableModels().some((model) => {
      if (!reads.slotsOf(model).includes(bucket)) return false;
      const row = catalog.find((entry) => servedModelKey(entry) === servedModelKey(model));
      // A spent allowance that keeps going on credits serves (INF-4104).
      return !(row && allowanceSpent(row));
    });
  }
  return (
    reads.quota
      .latest()
      ?.providers.some(
        (provider) =>
          provider.provider === ref &&
          (answersOnCredits(provider) ||
            provider.windows.some(
              (window) =>
                typeof window.percentRemaining !== "number" || window.percentRemaining > 0,
            )),
      ) ?? false
  );
}
