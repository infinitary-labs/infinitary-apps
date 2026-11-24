import type { Card } from "@shared/cards";
import { secretKeepFields } from "@shared/secrets";

/**
 * The secret ask card the phone home raised, as the phone journey names it:
 * its title, and the ids of the buttons the phone names its choices by -
 * Save secret is the field's keep, Don't save the decline.
 */
export function secretAskShown(cards: readonly Card[]): {
  title: string | null;
  save: string | null;
  dontSave: string | null;
} {
  const card = cards.find((one) => one.id.startsWith("card-secrets-ask-"));
  return {
    title: card?.title ?? null,
    save: (card && secretKeepFields(card)?.pass) ?? null,
    dontSave: card?.actions.find((action) => action.declines)?.id ?? null,
  };
}
