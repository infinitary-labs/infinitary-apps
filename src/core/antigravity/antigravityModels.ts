import { ANTIGRAVITY_PROVIDER_ID } from "@shared/antigravity";
import type { ReasoningCapabilities } from "@shared/modelSlots";
import type { CatalogReader, ServedModel } from "../models/servedModels";
import { isGeminiModel, type OfferedModel } from "./acpReading";

/**
 * Infinitary's shipped Antigravity catalog (docs/model-lists.md): what an
 * Antigravity account serves until one of its sessions has named the
 * models the program offers this sign-in, and again whenever that list is
 * not in hand. Gemini models only (INF-3776): Google's forum reply that
 * permits apps like this one scopes them to the Gemini models in the
 * person's plan. The program names a model by its family in its model
 * choice and sets the thinking level apart, so ids carry no level.
 */
export const ANTIGRAVITY_MODELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
];

/** Availability contributed by a connected Antigravity account, each model by its name. */
export function antigravityAvailableModels(): { provider: string; id: string; name: string }[] {
  return ANTIGRAVITY_MODELS.map((model) => ({
    provider: ANTIGRAVITY_PROVIDER_ID,
    id: model.id,
    name: model.name,
  }));
}

/**
 * The thinking levels an Antigravity crewmate opens at: the program offers
 * Low, Medium and High as its own choice beside the model, and the session
 * picks among what it offers when it opens (`openingThinking`).
 */
export function antigravityReasoningCapabilities(): ReasoningCapabilities {
  return { levels: ["low", "medium", "high"] };
}

/**
 * The models each account's sessions found the program offering, Gemini
 * only. A session hands them over when its conversation opens, so the list
 * is the program's own answer on that sign-in; nothing starts the program
 * just to ask (docs/antigravity-client.md, "The model list").
 */
export class AntigravityOffers {
  private readonly offered = new Map<string, ServedModel[]>();

  /** Keeps what a session saw; true when it changed what the account offers. */
  note(accountId: string, models: readonly OfferedModel[]): boolean {
    const gemini = models
      .filter(isGeminiModel)
      .map((model) => ({ id: model.id, name: model.name }));
    if (gemini.length === 0) return false;
    const before = this.offered.get(accountId);
    if (before && sameModels(before, gemini)) return false;
    this.offered.set(accountId, gemini);
    return true;
  }

  /** The runtime read: the last list a session named, else nothing to read yet. */
  reader(): CatalogReader {
    return async ({ accountId }) => {
      const models = this.offered.get(accountId);
      return models ? { status: "ok", models: [...models] } : { status: "skipped" };
    };
  }
}

function sameModels(a: readonly ServedModel[], b: readonly ServedModel[]): boolean {
  return a.length === b.length && a.every((model, index) => model.id === b[index]?.id);
}
