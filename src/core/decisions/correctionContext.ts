import type { CorrectionContext } from "./correctionQuestion";

/**
 * Experiment/consumer-owned byte budget, not a semantic summary. Keep both ends
 * of a long addressed card and declare the gap, rather than spending on its
 * whole research history or silently throwing away the card's identity.
 * The exact captain reply and its conditions are never shortened here.
 */
export function excerptCorrectionCard(
  context: CorrectionContext,
  bytes: number,
): CorrectionContext {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Invalid card byte budget");
  const card = context.addressedCard;
  if (!card || Buffer.byteLength(card.text, "utf8") <= bytes) return context;
  const marker = "\n[Middle of addressed card omitted]\n";
  const remaining = bytes - Buffer.byteLength(marker, "utf8");
  if (remaining < 0) {
    return { ...context, addressedCard: undefined, unavailableContext: true };
  }
  const characters = [...card.text];
  const leadingBytes = Math.ceil(remaining / 2);
  const trailingBytes = remaining - leadingBytes;
  const take = (source: string[], budget: number): string[] => {
    const kept: string[] = [];
    let used = 0;
    for (const character of source) {
      const size = Buffer.byteLength(character, "utf8");
      if (used + size > budget) break;
      kept.push(character);
      used += size;
    }
    return kept;
  };
  const leading = take(characters, leadingBytes).join("");
  const trailing = take([...characters].reverse(), trailingBytes)
    .reverse()
    .join("");
  return {
    ...context,
    addressedCard: { title: card.title, text: `${leading}${marker}${trailing}` },
    unavailableContext: true,
  };
}
