// A shipped queue part's version list only grows (src/core/queue/shipped.ts):
// a version once on the default branch keeps its hash, and a change appends
// a version instead of rewriting one. `scripts/generate-shipped-queue.ts`
// reads the lists it compares from git and words the refusal; this is the
// comparison.

/**
 * How a version list breaks the default branch's history: it rewrote or
 * dropped a version it started from, or it holds another hash at a version
 * the default branch has since taken. `version` counts from one.
 */
export type HistoryBreak = { kind: "rewrote" | "taken"; version: number };

/**
 * Where a part's version list breaks the default branch's history, or
 * undefined when it keeps it. `published` is the default branch's list and
 * `forked` the list this version started from, where it meets the default
 * branch: a pull request's merged result started from the default branch
 * itself, so there the two are the same list. A version need not hold the
 * versions the default branch appended after it started.
 */
export function historyBreak(
  sources: readonly string[],
  published: readonly string[],
  forked: readonly string[],
): HistoryBreak | undefined {
  const rewrote = forked.findIndex((sha, index) => sources[index] !== sha);
  if (rewrote >= 0) return { kind: "rewrote", version: rewrote + 1 };
  const taken = published.findIndex((sha, index) => index < sources.length && sources[index] !== sha);
  if (taken >= 0) return { kind: "taken", version: taken + 1 };
  return undefined;
}
