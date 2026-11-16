import { formatNumber } from "@shared/i18n/format";
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
  get showAll() {
    return m.cardFilesShowAll();
  },
  get showFewer() {
    return m.cardFilesShowFewer();
  },
  get saveAll() {
    return m.cardFilesSaveAll();
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

/** The counting row of a folded list: how many files the fold hides. */
export function cardFilesMoreWords(count: number): string {
  return m.cardFilesMore({ count });
}

/** The counting row of an opened list: how many files the card has. */
export function cardFilesAllWords(count: number): string {
  return m.cardFilesAll({ count });
}

/** The counting row's line once Save all saved every file, into the folder it made in Downloads. */
export function cardFilesSavedAllWords(folder: string): string {
  return m.cardFilesSavedAll({ folder });
}

/** The counting row's line when Save all saved only some files: the first that was not, and why. */
export function cardFilesPartlySavedWords(input: {
  saved: number;
  total: number;
  folder: string;
  name: string;
  why: string;
}): string {
  return m.cardFilesPartlySaved({
    ...input,
    saved: formatNumber(input.saved),
    total: formatNumber(input.total),
  });
}
