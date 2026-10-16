/** ‘ ’ ‚ ‛ and the modifier-letter apostrophe ʼ. */
const SINGLE_QUOTES = /[‘’‚‛ʼ]/g;

/** “ ” „ ‟ */
const DOUBLE_QUOTES = /[“”„‟]/g;

/**
 * Text as task search compares it (FI3-930): lowercase, with every
 * typographic apostrophe and quote read as the plain one a keyboard types.
 * A title the app writes with a curly apostrophe ("What’s new in …") is
 * found by "what's new", and a straight title by pasted curly text. Fold
 * both the typed text and each field, then compare by substring.
 */
export function foldForSearch(text: string): string {
  return text.toLowerCase().replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"');
}
