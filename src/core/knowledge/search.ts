import type {
  ConceptBody,
  EntryBody,
  FindingBody,
  KnowledgeKind,
  KnowledgeStore,
  SearchWords,
} from "../storage/knowledgeStore";

/**
 * The full-text projection's two sides (docs/knowledge.md, "Reading"): the
 * words an entry is indexed under when it is written, and the match a
 * search's words become. They are kept together so what a write indexes is
 * what a search can find.
 */

/** The most matches one search ranks; later pages stop there. */
export const SEARCH_WINDOW = 200;

/** An entry id written in a search's words or a card's body. */
export const ID_IN_TEXT = /\b[cf]-[a-z0-9]{6}\b/g;

const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its me my not of on or our so than that the their them then there these they this to us was we were what when where which who why will with you your".split(
    " ",
  ),
);

/** The plain words a search matches, without the caller's query syntax. */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms: string[] = [];
  for (const word of words) {
    if (word.length < 2 || !/\p{L}/u.test(word) || STOPWORDS.has(word) || terms.includes(word))
      continue;
    terms.push(word);
    if (terms.length >= 16) break;
  }
  return terms;
}

export function matchOf(terms: readonly string[]): string {
  const quoted = terms.map((term) => `"${term}"`);
  const names = `{title aliases} : (${quoted.join(" OR ")})`;
  // A body-only hit needs two distinct query words, never one loose prefix.
  const pairs = quoted.flatMap((left, index) =>
    quoted.slice(index + 1).map((right) => `(body : ${left} AND body : ${right})`),
  );
  return [names, ...pairs].join(" OR ");
}

/** The words an entry's revision is indexed under. */
export function wordsOf(body: EntryBody, kind: KnowledgeKind): SearchWords {
  if (kind === "concept") {
    const concept = body as ConceptBody;
    return {
      title: concept.title,
      aliases: concept.aliases.join(" "),
      body: [
        concept.explanation,
        concept.savedUrl ?? "",
        ...concept.links.map((link) => link.reason),
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  const finding = body as FindingBody;
  return {
    title: "",
    aliases: finding.relationship?.predicate ?? "",
    body: finding.statement,
  };
}

/** The concept an article link in a search's words was saved as, in each collection. */
export function articleHits(
  store: KnowledgeStore,
  query: string,
  scopes: readonly string[],
): string[] {
  const url = query.trim();
  if (!/^https?:\/\//i.test(url)) return [];
  return scopes.flatMap((scope) => {
    const id = store.articleConcept(scope, url);
    const entry = id ? store.entry(id) : undefined;
    return entry ? [entry.id] : [];
  });
}
