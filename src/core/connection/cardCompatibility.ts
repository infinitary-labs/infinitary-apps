import { type CardNote, noteText } from "@shared/cardNotes";

/** Strict older desktops need fields removed; readers without annotations keep a readable note. */
export function threadLinesFor(
  value: unknown,
  reads: { sharing: boolean; annotations: boolean; through?: boolean },
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
      const { contributor, answersMessage, clarification, notes, through, ...line } =
        message as Record<string, unknown>;
      return {
        ...line,
        ...(reads.through && through ? { through } : {}),
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

/**
 * A view reads the look strictly, so each choice added after it - the
 * language (`language-choice.md`) and the fonts (`font-choice.md`) - is left
 * out of the look it is pushed or answered when its hello does not list the
 * change; a view keeps its own look and never needs the home's.
 */
export function lookFor(channel: string, value: unknown, unread: readonly string[]): unknown {
  if (unread.length === 0 || !value || typeof value !== "object") return value;
  if (channel === "inf:settings:appearance:get") return without(value, unread);
  if (channel !== "inf:shell:preferences") return value;
  const look = value as Record<string, unknown>;
  return { ...look, appearance: without(look.appearance, unread) };
}

function without(appearance: unknown, unread: readonly string[]): unknown {
  if (!appearance || typeof appearance !== "object") return appearance;
  return Object.fromEntries(
    Object.entries(appearance as Record<string, unknown>).filter(([key]) => !unread.includes(key)),
  );
}
