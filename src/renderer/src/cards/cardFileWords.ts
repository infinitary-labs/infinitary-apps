import * as m from "@shared/i18n/messages.generated";

/**
 * The words a card's file row shows (`CardFiles.tsx`; the design skill's
 * ResponseCard, "Files for the captain"), from the catalog (docs/i18n.md),
 * in a plain module a journey can load.
 */
export const CARD_FILE_WORDS = {
  get label() {
    return m.cardFileLabel();
  },
  get save() {
    return m.cardFileSave();
  },
  get saving() {
    return m.cardFileSaving();
  },
};

/** The row's line once the file is saved, under the name it took in Downloads. */
export function cardFileSavedWords(savedAs: string): string {
  return m.cardFileSaved({ savedAs });
}

/** Why a save did not finish, when the refusal brought no words of its own. */
export function cardFileNotSavedWords(name: string): string {
  return m.cardFileNotSaved({ name });
}
