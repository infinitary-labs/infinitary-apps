import { type CardNote, noteText } from "@shared/cardNotes";

/** Strict older desktops need fields removed; readers without annotations keep a readable note. */
export function threadLinesFor(
  value: unknown,
  reads: { sharing: boolean; annotations: boolean },
): unknown {
  if (Array.isArray(value)) return value.map((entry) => threadLinesFor(entry, reads));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.messages))
    return Array.isArray(record.cards)
      ? { ...record, cards: record.cards.map((card) => threadLinesFor(card, reads)) }
      : value;
  return {
    ...record,
    messages: record.messages.map((message) => {
      if (!message || typeof message !== "object") return message;
      const { contributor, answersMessage, clarification, notes, ...line } = message as Record<
        string,
        unknown
      >;
      return {
        ...line,
        ...(reads.sharing ? { contributor, answersMessage, clarification } : {}),
        ...(reads.annotations
          ? notes
            ? { notes }
            : {}
          : notes && Array.isArray(notes)
            ? {
                text: [line.text, ...(notes as CardNote[]).map(noteText)]
                  .filter(Boolean)
                  .join("\n"),
              }
            : {}),
      };
    }),
  };
}
