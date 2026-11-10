import type { SecretsView } from "./secrets";

type Identity = Pick<SecretsView["entries"][number], "ref" | "label" | "environment">;

/**
 * A secret as a sentence names it: its name, its place when another secret
 * shares the name, and its reference only when name and place both repeat.
 * A reference no entry holds stays itself, never the first remaining secret.
 */
export function secretName(entries: readonly Identity[], ref: string): string {
  const entry = entries.find((row) => row.ref === ref);
  if (!entry) return `a secret no longer saved (${ref})`;
  const sameName = entries.filter((row) => row.label === entry.label);
  if (sameName.length === 1) return entry.label;
  const samePlace = sameName.filter((row) => row.environment === entry.environment);
  const parts = [
    ...(entry.environment ? [entry.environment] : []),
    ...(samePlace.length > 1 ? [entry.ref] : []),
  ];
  return parts.length ? `${entry.label} (${parts.join(", ")})` : entry.label;
}

/** Whether a row needs its reference to tell it apart: another secret has its name and place. */
export function needsReference(entries: readonly Identity[], entry: Identity): boolean {
  return entries.some(
    (row) =>
      row.ref !== entry.ref && row.label === entry.label && row.environment === entry.environment,
  );
}
