import { CLAUDE_MODELS } from "../../src/core/claude/claudeModels";
import { type Slot, STARTER_SLOTS } from "../../src/shared/modelSlots";

/**
 * The model id a provider's starter map puts in a slot (`STARTER_SLOTS`),
 * so a spec that needs "Claude's medium model" names the slot and follows
 * the map when a provider ships a new model, never a pinned id. The catalog
 * specs (model-lists, decision-models) keep their ids: there the catalog is
 * the subject.
 */
export function starterFor(provider: string, slot: Slot): string {
  const entry = Object.entries(STARTER_SLOTS[provider] ?? {}).find(([, slots]) =>
    slots.includes(slot),
  );
  if (!entry) throw new Error(`No starter model for ${provider} in the ${slot} slot`);
  return entry[0];
}

/** The shipped label and id of a Claude starter, for journeys through its controls. */
export function claudeStarter(slot: Slot): { id: string; name: string } {
  const id = starterFor("anthropic-claude", slot);
  const model = CLAUDE_MODELS.find((row) => row.id === id);
  if (!model) throw new Error(`Claude starter ${id} is not in the shipped catalog`);
  return model;
}
