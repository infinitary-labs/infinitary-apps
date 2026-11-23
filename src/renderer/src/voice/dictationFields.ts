/**
 * The fields besides the main message that the dictation key can write into
 * (docs/composer.md, "Voice"): a card's reply, a note's comment and the
 * crewmate's message box offer themselves here while they are on the page,
 * and the one with focus takes the next recording. The voice store holds
 * whichever field that was and names none of them.
 */
export type DictationField = {
  element: () => HTMLElement | null;
  /** Puts the words at the field's caret, keeps its focus and puts the caret after them. */
  insert: (words: string) => void;
};

const offered = new Set<DictationField>();

/** Offers a field for as long as it is on the page; the return withdraws it. */
export function offerDictationField(field: DictationField): () => void {
  offered.add(field);
  return () => {
    offered.delete(field);
  };
}

/** The offered field that has focus now, or null: then the main message takes the words. */
export function focusedDictationField(): DictationField | null {
  // A window with no page, as in the store's own tests, has no field.
  const active = globalThis.document?.activeElement;
  if (!active) return null;
  for (const field of offered) if (field.element() === active) return field;
  return null;
}
