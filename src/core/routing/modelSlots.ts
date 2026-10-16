import type { CrewSpeed } from "@shared/crewSpeed";
import { isCustomApiProvider } from "@shared/customApi";
import { modelNames } from "@shared/modelDisplayName";
import { isTrackedProvider, listedIds } from "@shared/modelListing";
import {
  allStarterKeys,
  type ModelSlotsState,
  type ModelSlotsView,
  offeringKey,
  parseOfferingKey,
  type ReasoningCapabilities,
  type ReasoningChoice,
  SLOTS,
  type Slot,
  type SlotModelView,
  STARTER_SLOTS,
  sortModelRows,
  starterSlots,
} from "@shared/modelSlots";
import { catalogEntry } from "@shared/providers";
import type { ModelsCatalogView } from "@shared/quota";
import { servedModelKey } from "@shared/quota";
import { levelDefaultReasoning } from "@shared/routingPolicy";
import { openingReasoning } from "../session/session";
import type { SettingsStore } from "../storage/settingsStore";
import type { PiModelRef, SlottedRef } from "./routingEngine";

/**
 * User-assigned intelligence slots: which of a subscription's models
 * Firstmate may route work to on its own, and as what.
 *
 * Four behaviors carry the whole design:
 *
 * - LISTING. Only part of what a provider serves gets a row: the newest
 *   generation of each tracked family, the starter rows, and whatever the
 *   user kept - slotted, pinned, or chosen as the Firstmate model
 *   (`@shared/modelListing`, docs/model-lists.md). The rest stays in the
 *   pool, reachable by name only: never listed, announced or auto-picked.
 * - SEEDING. An offering this install has never seen is placed from the
 *   starter map (or left off). Seeding never overwrites a seen key.
 * - NEWS. A listed arrival is announced once - in the map → placed; not in
 *   the map → off until the user places it - and a listed or kept model a
 *   successful read no longer serves is announced once as gone. Both come
 *   only from successful reads: a failed one falls back to the shipped
 *   catalog silently and is never evidence that a model left.
 * - THE FALLBACK. If nothing anywhere is slotted, routing does not stop:
 *   it applies the starter map virtually, then every listed model at
 *   medium. A shortlist is a preference, never a way to brick the app.
 *
 * Off is not a sign-out: an unslotted model is still available, and an
 * explicit pin still reaches it (naming a model is its own placement).
 */

export type NewModelNotice = {
  providerId: string;
  id: string;
  /** Set when the starter map placed it; omitted when it arrived off. */
  slots?: readonly Slot[];
};

/** A listed or kept model a successful read no longer serves. */
export type DepartureNotice = {
  providerId: string;
  id: string;
  /** The slots it sat in, if any - it keeps them in case it comes back. */
  slots: readonly Slot[];
};

export type AccountModels = {
  accountId: string;
  accountLabel: string;
  providerId: string;
  /** `name`: the runtime catalog's display name, the label when the quota catalog has none. */
  models: {
    provider: string;
    id: string;
    name?: string;
    reasoningCapabilities?: ReasoningCapabilities;
    speeds?: readonly CrewSpeed[];
  }[];
  /** The computer these models run on, when they are not this Mac's. */
  place?: string;
};

/** One account's models as its last successful catalog read served them. */
export type ServedSnapshot = { accountId: string; providerId: string; ids: readonly string[] };

export type ModelSlotsOptions = {
  settings: SettingsStore;
  /**
   * The faster speeds each account's model offers, read once per board view:
   * it answers a lookup the view then asks for every model it lists.
   */
  speeds?: () => (accountId: string, ref: PiModelRef) => readonly CrewSpeed[] | undefined;
  reasoningCapabilities?: (ref: PiModelRef) => ReasoningCapabilities | undefined;
  accounts: () => AccountModels[];
  quotaModels: () => ModelsCatalogView | undefined;
  /**
   * What the user named outside the slots - routing pins and the Firstmate
   * model - which keeps a model listed whatever generation it is.
   */
  kept?: () => Iterable<PiModelRef>;
  /**
   * Whether an account's models came from a successful read, so an arrival
   * may be announced. An account still on the shipped catalog seeds and
   * marks what it holds as seen, but never announces it. Absent: every
   * account may announce.
   */
  canAnnounce?: (accountId: string) => boolean;
};

export class ModelSlots {
  /** Offerings announced as newcomers this session, for the Settings "new" mark. */
  private lastNew = new Set<string>();

  constructor(private readonly options: ModelSlotsOptions) {}

  /**
   * Seeds never-seen offerings from the starter map and records newcomers
   * on the ones that have been seen. Returns the newcomers so the caller
   * can announce them exactly once; a first-time seed for a provider
   * announces nothing, because none of those models is new to the user.
   */
  reconcile(): NewModelNotice[] {
    const state = this.read();
    const seen = new Set(state.seen);
    const notices: NewModelNotice[] = [];
    let changed = false;
    const providerHadHistory = new Map<string, boolean>();

    for (const account of this.options.accounts()) {
      if (!providerHadHistory.has(account.providerId)) {
        const prefix = `${account.providerId}/`;
        providerHadHistory.set(
          account.providerId,
          state.seen.some((key) => key.startsWith(prefix)),
        );
      }
      const firstForProvider = providerHadHistory.get(account.providerId) !== true;
      const announce = !firstForProvider && (this.options.canAnnounce?.(account.accountId) ?? true);
      const listed = announce ? this.listedKeysOf([account]) : new Set<string>();
      for (const model of account.models) {
        const key = offeringKey(model);
        if (seen.has(key)) continue;
        seen.add(key);
        state.seen.push(key);
        changed = true;
        const seed = starterSlots(model.provider, model.id);
        if (seed.length > 0) state.assignments[key] = [...seed];
        if (announce && listed.has(key)) {
          notices.push({
            providerId: account.providerId,
            id: model.id,
            ...(seed.length > 0 ? { slots: seed } : {}),
          });
        }
      }
    }
    if (changed) this.write(state);
    this.lastNew = new Set(notices.map((notice) => `${notice.providerId}/${notice.id}`));
    return notices;
  }

  /**
   * The routable pool for one grain: `available` narrowed to what has a
   * slot, with the fallback ladder applied and its rung named. Each model
   * carries the slot routing will walk.
   */
  routable(available: PiModelRef[]): { models: SlottedRef[]; note: string } {
    const assigned = this.slottedOf(available);
    if (assigned.length > 0) {
      return {
        models: assigned,
        note: `${assigned.length} of ${available.length} available models have a slot`,
      };
    }
    const approved = new Set(allStarterKeys());
    const defaults = available.flatMap((model) => {
      const key = offeringKey(model);
      if (!approved.has(key)) return [];
      return starterSlots(model.provider, model.id).map((slot) => ({ ...model, slot }));
    });
    if (defaults.length > 0) {
      const state = this.read();
      const hadAssignments = Object.keys(state.assignments).length > 0;
      return {
        models: defaults,
        note: hadAssignments
          ? `no slotted model is available; using the starter map (${defaults.length})`
          : `no models slotted; using the starter map (${defaults.length})`,
      };
    }
    const fallback = available.filter((model) => !isCustomApiProvider(model.provider));
    const listed = this.listedOf(fallback);
    if (listed.length > 0) {
      return {
        models: listed.map((model) => ({ ...model, slot: "medium" as const })),
        note: "no slotted or starter-map model is available; using every listed model",
      };
    }
    return {
      models: fallback.map((model) => ({ ...model, slot: "medium" as const })),
      note: "no slotted, starter-map or listed model is available; using every signed-in model",
    };
  }

  /**
   * `available` narrowed to what is listed (docs/model-lists.md). A model
   * from a provider the listing does not track - the user's own models.json
   * providers - is always listed.
   */
  listedOf<T extends PiModelRef>(available: readonly T[]): T[] {
    const listed = this.listedKeysOf(this.options.accounts());
    return available.filter(
      (model) => listed.has(offeringKey(model)) || !isTrackedProvider(model.provider),
    );
  }

  /**
   * Departures (docs/model-lists.md): each snapshot is one account's LAST
   * SUCCESSFUL read. Against the previous successful read of the same
   * account, anything that was listed then - or is kept now - and is no
   * longer served is gone, announced once. The snapshot then becomes the
   * baseline. An account with no baseline yet only records one, and an
   * empty snapshot is never a read: nothing a failure or a still-empty
   * runtime could produce reaches here as evidence.
   */
  departures(snapshots: readonly ServedSnapshot[]): DepartureNotice[] {
    const baselines = { ...this.options.settings.getServedBaselines() };
    const state = this.read();
    const kept = this.keptKeys(state);
    const notices: DepartureNotice[] = [];
    let changed = false;
    for (const snapshot of snapshots) {
      if (snapshot.ids.length === 0) continue;
      const current = [...new Set(snapshot.ids)].sort();
      const previous = baselines[snapshot.accountId];
      if (previous && sameIds(previous, current)) continue;
      if (previous) {
        const served = new Set(current);
        const keptIds = new Set(
          [...kept].flatMap((key) => {
            const ref = parseOfferingKey(key);
            return ref.provider === snapshot.providerId ? [ref.id] : [];
          }),
        );
        const listedBefore = listedIds(snapshot.providerId, previous, keptIds);
        for (const id of previous) {
          if (served.has(id)) continue;
          if (!listedBefore.has(id) && !keptIds.has(id)) continue;
          notices.push({
            providerId: snapshot.providerId,
            id,
            slots: state.assignments[offeringKey({ provider: snapshot.providerId, id })] ?? [],
          });
        }
      }
      baselines[snapshot.accountId] = current;
      changed = true;
    }
    if (changed) this.options.settings.setServedBaselines(baselines);
    return notices;
  }

  /** The slots one offering sits in, empty when it is off. */
  slotsOf(ref: PiModelRef): Slot[] {
    return this.read().assignments[offeringKey(ref)] ?? [];
  }

  /**
   * The catalog's display name for one offering ("Fable 5", not
   * "claude-fable-5"), for surfaces that name a model to the captain.
   * Undefined when the quota catalog does not know the offering.
   */
  labelOf(ref: PiModelRef): string | undefined {
    return this.catalogByKey().get(offeringKey(ref))?.label;
  }

  /**
   * One offering by the name every surface gives it (FI3-565 piece 2): its
   * Settings row's label, listed or by name, through the one lookup
   * (`modelNames`) the renderer applies to these same rows, or its bare id
   * when no account serves it. The record, its Activity, the crew summary
   * and the fact strip never name one model two ways.
   */
  nameOf(ref: PiModelRef): string {
    const view = this.view();
    return modelNames([...view.models, ...view.byName])(offeringKey(ref));
  }

  /**
   * Adds or removes one slot from one offering's membership, leaving its
   * other slots untouched - a model may sit in more than one. Unknown keys
   * are ignored.
   */
  setSlotMembership(key: string, slot: Slot, on: boolean): void {
    const offered = this.offeredKeys();
    if (!offered.has(key)) return;
    const state = this.read();
    if (!state.seen.includes(key)) state.seen.push(key);
    const current = state.assignments[key] ?? [];
    const next = on
      ? current.includes(slot)
        ? current
        : [...current, slot]
      : current.filter((existing) => existing !== slot);
    if (next.length > 0) state.assignments[key] = next;
    else delete state.assignments[key];
    this.lastNew.delete(key);
    this.write(state);
  }

  /** A provider/model's choice for the tier actually served, not the requested tier. */
  reasoningChoice(ref: PiModelRef, slot: Slot): ReasoningChoice | undefined {
    return this.read().reasoning?.[offeringKey(ref)]?.[slot];
  }

  speed(ref: PiModelRef): CrewSpeed {
    return this.read().speed?.[offeringKey(ref)] ?? "standard";
  }

  setSpeed(key: string, speed: CrewSpeed): void {
    const model = [...this.view().models, ...this.view().byName].find(
      (row) => offeringKey(row) === key,
    );
    if (model?.provider !== "openai-codex")
      throw new Error("Crew speed is only available for Codex models.");
    if (speed !== "standard" && !model.speeds?.includes(speed))
      throw new Error("No account currently offers that speed. Your saved choice has not changed.");
    const state = this.read();
    state.speed ??= {};
    if (speed === "standard") delete state.speed[key];
    else state.speed[key] = speed;
    this.write(state);
  }

  setReasoning(key: string, slot: Slot, level: ReasoningChoice | null): void {
    const model = [...this.view().models, ...this.view().byName].find(
      (row) => offeringKey(row) === key,
    );
    if (!model) throw new Error("This model is not available. Reopen Settings to try again.");
    if (level !== null && !model.reasoningCapabilities?.levels.includes(level))
      throw new Error(
        "This model no longer offers that reasoning level. Your saved choice has not changed.",
      );
    const state = this.read();
    state.reasoning ??= {};
    const choices = state.reasoning[key] ?? {};
    if (level === null) delete choices[slot];
    else choices[slot] = level;
    if (Object.keys(choices).length) state.reasoning[key] = choices;
    else delete state.reasoning[key];
    this.write(state);
  }

  /** Retire only one provider's slot metadata, including unavailable offerings. */
  forgetProvider(providerId: string): void {
    const state = this.read();
    const prefix = `${providerId}/`;
    state.seen = state.seen.filter((key) => !key.startsWith(prefix));
    for (const key of Object.keys(state.assignments))
      if (key.startsWith(prefix)) {
        delete state.assignments[key];
        this.lastNew.delete(key);
      }
    for (const key of Object.keys(state.reasoning ?? {}))
      if (key.startsWith(prefix)) delete state.reasoning?.[key];
    this.write(state);
  }

  /**
   * Rewrites currently available offerings to the starter map (or off).
   * `seen` and pins are untouched. Scoped to one provider, or all.
   */
  reset(providerId?: string): void {
    const state = this.read();
    for (const key of this.offeredKeys()) {
      const { provider, id } = parseOfferingKey(key);
      if (providerId && provider !== providerId) continue;
      const seed = starterSlots(provider, id);
      if (seed.length > 0) state.assignments[key] = [...seed];
      else delete state.assignments[key];
    }
    this.write(state);
  }

  /**
   * The slot-first Settings board: one row per LISTED offering, provider on
   * the row, and everything else the accounts serve beside it for the "use
   * a model by name" controls.
   */
  view(): ModelSlotsView {
    const state = this.read();
    const catalog = this.catalogByKey();
    const accounts = this.options.accounts();
    const listed = this.listedKeysOf(accounts, state);
    const speedsOf = this.options.speeds?.();
    const byKey = new Map<string, SlotModelView>();
    for (const account of accounts) {
      for (const model of account.models) {
        const key = offeringKey(model);
        const speeds = model.speeds ?? speedsOf?.(account.accountId, model);
        const previous = byKey.get(key);
        if (previous) {
          if (speeds) previous.speeds = [...new Set([...(previous.speeds ?? []), ...speeds])];
          continue;
        }
        const row = catalog.get(key);
        const capabilities =
          model.reasoningCapabilities ?? this.options.reasoningCapabilities?.(model);
        const choices = state.reasoning?.[key];
        const reasoning =
          capabilities || choices
            ? Object.fromEntries(
                SLOTS.map((slot) => {
                  const chosen = choices?.[slot];
                  const requested = chosen ?? levelDefaultReasoning(slot);
                  const effective = !capabilities
                    ? undefined
                    : capabilities.fixed
                      ? { level: capabilities.fixed }
                      : (openingReasoning(
                          ["low", "medium", "high", "xhigh"],
                          capabilities.levels,
                          requested,
                          false,
                        ) ?? { level: "default" });
                  return [
                    slot,
                    { ...(chosen ? { chosen } : {}), ...(effective ? { effective } : {}) },
                  ];
                }),
              )
            : undefined;
        byKey.set(key, {
          provider: model.provider,
          // The model's own provider: a models.json provider every runtime
          // reads is not the account's.
          providerLabel: isCustomApiProvider(model.provider)
            ? account.accountLabel
            : (catalogEntry(model.provider)?.name ?? model.provider),
          id: model.id,
          label: isCustomApiProvider(model.provider)
            ? model.id
            : (row?.label ?? model.name ?? model.id),
          slots: state.assignments[key] ?? [],
          ...(model.provider === "openai-codex"
            ? {
                speed: state.speed?.[key] ?? "standard",
                ...(speeds ? { speeds: [...speeds] } : {}),
              }
            : {}),
          ...(capabilities ? { reasoningCapabilities: capabilities } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(this.lastNew.has(key) ? { isNew: true as const } : {}),
          ...(account.place ? { place: account.place } : {}),
        });
      }
    }
    const rows = sortModelRows([...byKey.values()]);
    return {
      models: rows.filter((row) => listed.has(offeringKey(row))),
      byName: rows.filter((row) => !listed.has(offeringKey(row))),
      usingDefaults: this.assignedInPool().size === 0,
    };
  }

  /**
   * Every listed key across the given accounts: per served provider, the
   * lean rule over what that account serves plus what the user kept.
   */
  private listedKeysOf(
    accounts: readonly AccountModels[],
    state: ModelSlotsState = this.read(),
  ): Set<string> {
    const kept = this.keptKeys(state);
    const listed = new Set<string>();
    for (const account of accounts) {
      const byProvider = new Map<string, string[]>();
      for (const model of account.models) {
        const ids = byProvider.get(model.provider) ?? [];
        ids.push(model.id);
        byProvider.set(model.provider, ids);
      }
      for (const [provider, ids] of byProvider) {
        const keptIds = new Set(ids.filter((id) => kept.has(offeringKey({ provider, id }))));
        for (const id of listedIds(provider, ids, keptIds)) {
          listed.add(offeringKey({ provider, id }));
        }
      }
    }
    return listed;
  }

  /**
   * The ids of one provider a read may never be trusted to take away: its
   * starter rows and whatever the user kept. The Pi account-list filters'
   * safety rail (docs/model-lists.md) refuses an answer that omits one.
   */
  protectedIds(providerId: string): string[] {
    const ids = new Set(Object.keys(STARTER_SLOTS[providerId] ?? {}));
    for (const key of this.keptKeys(this.read())) {
      const ref = parseOfferingKey(key);
      if (ref.provider === providerId) ids.add(ref.id);
    }
    return [...ids];
  }

  /** Slotted, pinned, or the Firstmate model: what keeps a model listed. */
  private keptKeys(state: ModelSlotsState): Set<string> {
    const kept = new Set<string>();
    for (const [key, slots] of Object.entries(state.assignments)) {
      if (slots.length > 0) kept.add(key);
    }
    for (const ref of this.options.kept?.() ?? []) kept.add(offeringKey(ref));
    return kept;
  }

  /** One row per membership - an offering in two slots returns two rows. */
  private slottedOf(available: PiModelRef[]): SlottedRef[] {
    const state = this.read();
    return available.flatMap((model) => {
      const slots = state.assignments[offeringKey(model)] ?? [];
      return slots.map((slot) => ({ ...model, slot }));
    });
  }

  private assignedInPool(): Set<string> {
    const state = this.read();
    const offered = this.offeredKeys();
    const keys = new Set<string>();
    for (const [key, slots] of Object.entries(state.assignments)) {
      if (slots.length > 0 && offered.has(key)) keys.add(key);
    }
    return keys;
  }

  private offeredKeys(): Set<string> {
    const keys = new Set<string>();
    for (const account of this.options.accounts()) {
      for (const model of account.models) keys.add(offeringKey(model));
    }
    return keys;
  }

  private catalogByKey(): Map<string, { label: string }> {
    const byKey = new Map<string, { label: string }>();
    for (const model of this.options.quotaModels()?.models ?? []) {
      byKey.set(servedModelKey(model), { label: model.label });
    }
    return byKey;
  }

  private read(): ModelSlotsState {
    return this.options.settings.getModelSlots();
  }

  private write(state: ModelSlotsState): void {
    this.options.settings.setModelSlots(state);
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
