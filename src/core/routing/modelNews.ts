/**
 * The feed's notes on a provider's models changing (docs/model-lists.md):
 * one for a model a read brought in, and one for a listed or kept model a
 * later successful read no longer serves. `provider` is the provider's
 * name as the captain reads it, `slots` the levels the model is used at.
 */
import type { ServedModels } from "../models/servedModels";
import type { AccountVault } from "../pi/accountVault";
import type { ModelSlots } from "./modelSlots";

export function modelAddedLead(provider: string): string {
  return `${provider} added `;
}

/** A model a read brought in: placed in the levels the starter map names, otherwise off. */
export function modelAddedNote(provider: string, id: string, slots: readonly string[]): string {
  return slots.length > 0
    ? `${modelAddedLead(provider)}${id} to ${slots.join(" and ")}.`
    : `${modelAddedLead(provider)}${id} - it stays off until you place it in a slot.`;
}

export function modelGoneLead(provider: string): string {
  return `${provider} no longer serves `;
}

/** A listed or kept model a later successful read no longer serves, by its label or its id. */
export function modelGoneNote(provider: string, model: string, slots: readonly string[]): string {
  return slots.length > 0
    ? `${modelGoneLead(provider)}${model} - it was in ${slots.join(" and ")}.`
    : `${modelGoneLead(provider)}${model}.`;
}

export type ModelNewsSources = {
  vault: Pick<AccountVault, "availableModelsByAccount">;
  served: Pick<ServedModels, "reads" | "read">;
  slots: Pick<ModelSlots, "departures" | "reconcile" | "labelOf">;
  /** The provider's name as the captain reads it. */
  providerName: (providerId: string) => string;
  /** One note on the feed. */
  note: (text: string) => void;
};

/**
 * Seeds never-seen offerings from the starter map and reports live-catalog
 * newcomers - once each, as an ordinary feed line, because a model arriving
 * into a subscription is fleet news the captain should see without a card.
 * A first-time seed for a provider announces nothing. A later arrival is
 * placed when the map names it, otherwise off until the user slots it.
 *
 * It runs on the same beats the availability snapshot moves on: app start,
 * the daily liveness sweep, every quota refresh (which is also when a 4h
 * pi.dev catalog overlay has had a chance to land), and after an account
 * is added.
 */
export function reconcileModelNews(sources: ModelNewsSources): void {
  const { vault, served, slots, providerName, note } = sources;
  // Departures first, from successful reads only (docs/model-lists.md):
  // a client-served or Pi-filtered account counts only once its own read
  // has succeeded; an unfiltered Pi account's catalog is Pi's own answer.
  const snapshots = vault.availableModelsByAccount().flatMap((row) => {
    if (served.reads(row.providerId) && served.read(row.accountId) === undefined) return [];
    const ids = row.models
      .filter((model) => model.provider === row.providerId)
      .map((model) => model.id);
    return [{ accountId: row.accountId, providerId: row.providerId, ids }];
  });
  for (const notice of slots.departures(snapshots)) {
    const name = providerName(notice.providerId);
    const label = slots.labelOf({ provider: notice.providerId, id: notice.id }) ?? notice.id;
    note(modelGoneNote(name, label, notice.slots));
  }
  for (const notice of slots.reconcile()) {
    const name = providerName(notice.providerId);
    note(modelAddedNote(name, notice.id, notice.slots ?? []));
  }
}
