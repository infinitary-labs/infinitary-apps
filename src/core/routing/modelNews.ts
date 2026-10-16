/**
 * The feed's notes on a provider's models changing (docs/model-lists.md):
 * one for a model a read brought in, and one for a listed or kept model a
 * later successful read no longer serves. `provider` is the provider's
 * name as the captain reads it, `slots` the levels the model is used at.
 */

/** How a note on a model a provider added starts. */
export function modelAddedLead(provider: string): string {
  return `${provider} added `;
}

/** A model a read brought in: placed in the levels the starter map names, otherwise off. */
export function modelAddedNote(provider: string, id: string, slots: readonly string[]): string {
  return slots.length > 0
    ? `${modelAddedLead(provider)}${id} to ${slots.join(" and ")}.`
    : `${modelAddedLead(provider)}${id} - it stays off until you place it in a slot.`;
}

/** How a note on a model a provider no longer serves starts. */
export function modelGoneLead(provider: string): string {
  return `${provider} no longer serves `;
}

/** A listed or kept model a later successful read no longer serves, by its label or its id. */
export function modelGoneNote(provider: string, model: string, slots: readonly string[]): string {
  return slots.length > 0
    ? `${modelGoneLead(provider)}${model} - it was in ${slots.join(" and ")}.`
    : `${modelGoneLead(provider)}${model}.`;
}
