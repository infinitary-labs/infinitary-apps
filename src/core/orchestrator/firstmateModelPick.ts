import { isRetiredProvider, providerServesRole } from "@shared/providers";
import { PREMIUM_SLOT, type Slot, servedModelKey, servedProviderOf } from "@shared/quota";
import { allowanceSpent } from "@shared/quotaSignals";
import type { FirstmateAgentOptions } from "./firstmateAgent";
import type { LocalOrchestratorSeat } from "./localOrchestrator";

/**
 * Which model the first mate answers with: the captain's pick, or the
 * automatic one this file derives once and persists. Pure over the agent's
 * options; the seat reads it when it opens a session or moves.
 */
type ModelPickOptions = Pick<
  FirstmateAgentOptions,
  "availableModels" | "listedModels" | "slotsOf" | "quotaModels" | "settings" | "flagship"
>;

type ModelRef = { provider: string; id: string };

/** The provider-scoped cousin of resolveModel, for a move: any provider, either backend. */
export function deriveModelForProvider(
  options: ModelPickOptions,
  providerId: string,
): ModelRef | undefined {
  const available = options.availableModels().filter((model) => model.provider === providerId);
  if (available.length === 0) return undefined;
  return deriveFrom(options, available);
}

function listed<T extends ModelRef>(options: ModelPickOptions, available: readonly T[]): T[] {
  if (!options.listedModels) return [...available];
  const listed = new Set(options.listedModels().map((model) => `${model.provider}/${model.id}`));
  return available.filter((model) => listed.has(`${model.provider}/${model.id}`));
}

function slotsOf(options: ModelPickOptions, model: ModelRef): Slot[] {
  return options.slotsOf?.(model) ?? ["medium"];
}

function isPremium(options: ModelPickOptions, model: ModelRef): boolean {
  return slotsOf(options, model).includes(PREMIUM_SLOT);
}

export function premiumCanServe(options: ModelPickOptions): boolean {
  const catalog = options.quotaModels()?.models;
  return options.availableModels().some((model) => {
    if (!isPremium(options, model)) return false;
    const reading = catalog?.find((entry) => servedModelKey(entry) === servedModelKey(model));
    // No quota reading is unknown, never zero; a measured exhausted
    // premium offering is not a way this captain can take right now.
    return !(reading && allowanceSpent(reading));
  });
}

/** Local preflight's chosen model, or its normal initial Auto choice; never opens a session. */
export function preflightModel(
  options: ModelPickOptions,
  localSeat: LocalOrchestratorSeat | undefined,
): ModelRef | undefined {
  return (
    localSeat?.model ?? options.settings.getFirstmateModel() ?? resolveModel(options, localSeat)
  );
}

/**
 * The fixed orchestrator model (captain decision Q2): the persisted
 * choice, or a subscription-derived default picked once and persisted so
 * behavior never silently changes - high, medium, premium, then low in
 * catalog allowance order, else the first listed one. Only
 * a model that can answer the Firstmate is derived: its provider's role,
 * and an account the seat can stand on (`Flagship.servesFirstmate`), so a
 * pick never persists a model no seat would open.
 */
export function resolveModel(
  options: ModelPickOptions,
  localSeat: LocalOrchestratorSeat | undefined,
): ModelRef | undefined {
  if (localSeat) return localSeat.model;
  const chosen = options.settings.getFirstmateModel();
  // Leftover Anthropic sessions stay on disk; they are not offered until
  // API-key support lands, so pick a new default rather than crashing.
  // A pin onto a provider this build no longer offers (Cursor) is
  // the same as a leftover Anthropic pin: derive a default instead of
  // opening a session that cannot run.
  if (chosen && chosen.provider !== "anthropic" && !isRetiredProvider(chosen.provider)) {
    return chosen;
  }
  const serves = new Map<string, boolean>();
  const servesFirstmate = (providerId: string): boolean => {
    let known = serves.get(providerId);
    if (known === undefined) {
      known =
        options.flagship?.servesFirstmate(providerId) ??
        providerServesRole(providerId, "firstmate");
      serves.set(providerId, known);
    }
    return known;
  };
  const available = options
    .availableModels()
    .filter(
      (model) =>
        model.provider !== "anthropic" &&
        !isRetiredProvider(model.provider) &&
        servesFirstmate(model.provider),
    );
  if (available.length === 0) return undefined;
  // A fresh Auto pick considers every serving backend in the same pool.
  // A later cross-provider move still asks the captain.
  const derived = deriveFrom(options, available);
  if (derived) options.settings.setFirstmateModel(derived);
  return derived;
}

/**
 * The Firstmate's automatic pick: high, medium, premium, low; catalog
 * allowance order within each slot, across serving backends alike.
 */
function deriveFrom(
  options: ModelPickOptions,
  available: readonly ModelRef[],
): ModelRef | undefined {
  if (available.length === 0) return undefined;
  const availableKeys = new Set(available.map((m) => `${m.provider}/${m.id}`));
  const catalog = options.quotaModels()?.models ?? [];
  const pool = listed(options, available).filter((model) => {
    const reading = catalog.find((entry) => servedModelKey(entry) === servedModelKey(model));
    return !(reading && allowanceSpent(reading));
  });
  for (const bucket of ["high", "medium", "premium", "low"] as const) {
    for (const model of catalog) {
      const provider = servedProviderOf(model.provider);
      if (!availableKeys.has(servedModelKey(model))) continue;
      if (allowanceSpent(model)) continue;
      if (slotsOf(options, { provider, id: model.id }).includes(bucket)) {
        return { provider, id: model.id };
      }
    }
    const model = pool.find((entry) => slotsOf(options, entry).includes(bucket));
    if (model) return model;
  }
  return pool[0];
}
