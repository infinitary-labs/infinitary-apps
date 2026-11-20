import type { CatalogModelView } from "@shared/quota";
import { isAutoRoutableSlot, type Slot, servedModelKey, servedProviderOf } from "@shared/quota";
import { capabilityMiss, type ModelCapabilityLookup, type TurnNeeds } from "./capability";
import type { PiModelRef } from "./routingEngine";

/**
 * In-process auxiliary sessions such as supervision shop the quota catalog
 * themselves rather than through the pure routing engine, because they bind
 * an ACCOUNT per candidate instead of returning one choice. They still owe
 * the same two boundaries the engine
 * enforces, so the walk lives here once instead of twice:
 *
 * - a premium-slot model is never a candidate (captain decision A) - not in
 *   the slot walk and not in the everything-else tail;
 * - a candidate whose def cannot carry the turn is dropped with a reason.
 *
 * The slot record is applied by the CALLER, by handing this an already-
 * filtered `available` pool that carries each model's slot - the same seam
 * the sign-in gate uses.
 */

export type CandidateWalk = {
  /** Ordered candidates, best first. */
  models: PiModelRef[];
  /** Why anything was dropped, for the audit trail and the feed. */
  skipped: string[];
};

export function orderCandidates(input: {
  /** The routable pool: signed in, and slotted when a record exists. */
  available: Array<PiModelRef & { slot?: Slot }>;
  catalog: CatalogModelView[];
  /** Slot order for this grain, such as low-first for supervision triage. */
  buckets: ReadonlyArray<Slot>;
  capabilityFor?: ModelCapabilityLookup;
  needs?: TurnNeeds;
}): CandidateWalk {
  const availableKeys = new Set(input.available.map((model) => `${model.provider}/${model.id}`));
  const slotByKey = new Map<string, Slot[]>();
  for (const model of input.available) {
    if (!model.slot) continue;
    const key = `${model.provider}/${model.id}`;
    slotByKey.set(key, [...(slotByKey.get(key) ?? []), model.slot]);
  }
  const skipped: string[] = [];
  const models: PiModelRef[] = [];
  const seen = new Set<string>();

  const consider = (ref: PiModelRef, slot: Slot): void => {
    const key = `${ref.provider}/${ref.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!isAutoRoutableSlot(slot)) {
      skipped.push(`skipped ${key}: premium models are never chosen automatically`);
      return;
    }
    const miss = capabilityMiss({
      ref,
      ...(input.needs ? { needs: input.needs } : {}),
      ...(input.capabilityFor ? { capabilityFor: input.capabilityFor } : {}),
    });
    if (miss) {
      skipped.push(miss);
      return;
    }
    models.push(ref);
  };

  for (const bucket of input.buckets) {
    if (!isAutoRoutableSlot(bucket)) continue;
    for (const model of input.catalog) {
      const key = servedModelKey(model);
      if (!availableKeys.has(key)) continue;
      const memberSlots = slotByKey.get(key);
      if (!memberSlots?.includes(bucket)) continue;
      consider({ provider: servedProviderOf(model.provider), id: model.id }, bucket);
    }
  }
  // The tail: an available model the quota catalog has no row for, or whose
  // slot was not in the walk. Unread slot is considered at `medium`. It
  // keeps the walk's slot order - with no catalog at all (before the first
  // reading, or when it fails) the whole pool is here, and pool order would
  // put a strong model ahead of a cheap one - then slots the walk does not
  // name; within a slot, pool order.
  const rank = (slot: Slot): number => {
    const index = input.buckets.indexOf(slot);
    return index === -1 ? input.buckets.length : index;
  };
  const tail = input.available
    .map((model) => ({ model, slot: model.slot ?? "medium" }))
    .sort((a, b) => rank(a.slot) - rank(b.slot));
  for (const { model, slot } of tail) {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    consider(model, slot);
  }
  return { models, skipped };
}
