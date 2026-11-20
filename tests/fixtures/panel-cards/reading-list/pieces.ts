/** The fixture's list: a local helper every view imports. */
export const PIECES = ["The calm interface", "Notes on focus", "A quiet stack"];

/** A piece's card id, the same from the panel and from a card. */
export function notesId(piece: string): string {
  return `notes-${piece.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
