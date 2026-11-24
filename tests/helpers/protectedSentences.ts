/**
 * What a protected served sentence decides (docs/testing.md, "The protected
 * sentences"). A sentence on one of these lists changes only with the
 * captain's approval, the same as weakening a test, so a trim never
 * shortens one to make room.
 */
export const PROTECTED_INTENTS = [
  "consent",
  "what reaches the captain",
  "merges",
  "tests",
  "private data",
  "deleted files",
] as const;

export type ProtectedIntent = (typeof PROTECTED_INTENTS)[number];

/** The intents no entry on a list serves, so emptying one fails by name. */
export function intentsWithoutSentence(entries: { intent: ProtectedIntent }[]): ProtectedIntent[] {
  const served = new Set(entries.map(({ intent }) => intent));
  return PROTECTED_INTENTS.filter((intent) => !served.has(intent));
}
