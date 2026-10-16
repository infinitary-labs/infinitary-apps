/**
 * Project keys (captain decision D6): 2-4 uppercase alphanumerics that
 * prefix every task key (`FM3K-12`, `SCR-3`). Derived from the repo name
 * when none is given; unique across projects, so a collision walks a
 * deterministic ladder instead of failing or inventing randomness. A key
 * chosen when the project is added (`freeProjectKey`) is refused instead.
 */

export const PROJECT_KEY_PATTERN = /^[A-Z0-9]{2,4}$/;

function alnumUpper(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** The base candidate before collision handling; may be shorter than 2. */
function baseKey(name: string): string {
  const tokens = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(alnumUpper)
    .filter(Boolean);
  if (tokens.length === 0) return "";
  if (tokens.length === 1) return (tokens[0] as string).slice(0, 4);
  // Two letters of the first word, then one initial per following word.
  const first = (tokens[0] as string).slice(0, 2);
  const rest = tokens
    .slice(1)
    .map((token) => token[0] as string)
    .join("");
  return (first + rest).slice(0, 4);
}

/**
 * Derive a key for a project name that is not among `taken`. Falls back to
 * numeric suffixes on a shortened base, and finally to `P` + digits so a
 * pathological name set still yields a key.
 */
export function deriveProjectKey(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((key) => key.toUpperCase()));
  const candidates: string[] = [];
  let base = baseKey(name);
  if (base.length < 2) base = `${base}${alnumUpper(name)}PR`.slice(0, 2);
  candidates.push(base);
  const stem3 = base.slice(0, 3);
  for (let digit = 2; digit <= 9; digit += 1) candidates.push(`${stem3}${digit}`);
  const stem2 = base.slice(0, 2);
  for (let n = 10; n <= 99; n += 1) candidates.push(`${stem2}${n}`);
  for (let n = 100; n <= 999; n += 1) candidates.push(`P${n}`);
  for (const candidate of candidates) {
    if (PROJECT_KEY_PATTERN.test(candidate) && !used.has(candidate)) return candidate;
  }
  throw new Error(`Could not derive a unique project key for "${name}".`);
}

/**
 * A key someone chose that no project can take: not 2-4 letters or digits,
 * or already another project's. Its message is the words a person reads.
 */
export class ProjectKeyRefusal extends Error {}

/** The refusal of a key another project has; `removed` when that project was taken off the list. */
export function projectKeyInUseWords(key: string, project: string, removed: boolean): string {
  return `${key} is already the task key of ${project}${removed ? ", a project you removed" : ""}. Choose another.`;
}

/** A caller-supplied key, normalized and validated against the pattern. */
export function normalizeProjectKey(key: string): string {
  const normalized = key.trim().toUpperCase();
  if (!PROJECT_KEY_PATTERN.test(normalized)) {
    throw new ProjectKeyRefusal(`A task key is 2-4 letters or digits; "${key.trim()}" is not one.`);
  }
  return normalized;
}
