/** The reference format holds 64 characters; a made-up one keeps room for its number. */
const REFERENCE_STEM = 64 - "-9999999".length;

/**
 * A stable reference for a new entry, made from its name: lowercase letters and
 * digits joined by dashes, numbered past every reference an entry, a saved rule
 * or the history already holds, so a rule kept for a forgotten secret never
 * names it and its history never reads as the new one's.
 */
export function newReference(label: string, taken: readonly string[]): string {
  const base =
    label
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, REFERENCE_STEM)
      .replace(/-+$/, "") || "secret";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}
