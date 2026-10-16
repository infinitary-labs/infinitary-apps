import {
  KNOWLEDGE_GRAPH_LIMITS,
  KNOWLEDGE_LIST_PAGE,
  type KnowledgeConnection,
  type KnowledgeGraphConcept,
  type KnowledgeStanding,
} from "@shared/knowledge";

/**
 * The knowledge browser's bounds, as pure functions over what the owner
 * read (docs/knowledge.md, "The browser"): which concepts and connections
 * a graph read draws, and which page of a list a list read answers. The
 * owner (`KnowledgeService`) reads the collection and checks scope; these
 * only choose, so each choice is tested on its own.
 */

/** Where a finding stands, from its status and whether a source it cites changed or went. */
export function standingOf(
  status: { state: string; challenged: boolean },
  recheck: boolean,
): KnowledgeStanding {
  if (status.state === "retired") return "retired";
  if (status.state === "superseded") return "superseded";
  if (status.state === "disputed" || status.challenged) return "differing";
  if (recheck) return "recheck";
  return status.state === "checked" ? "checked" : "unchecked";
}

/** Connections touching each concept, in the whole collection. */
export function degreesOf(connections: readonly KnowledgeConnection[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const connection of connections) {
    degree.set(connection.from, (degree.get(connection.from) ?? 0) + 1);
    degree.set(connection.to, (degree.get(connection.to) ?? 0) + 1);
  }
  return degree;
}

/**
 * The concepts within `hops` of `focus`, nearest first: the focus, then its
 * neighbors, then theirs. A cycle never walks twice.
 */
export function neighborhoodOf(
  focus: string,
  connections: readonly KnowledgeConnection[],
  hops: number,
): Map<string, number> {
  const next = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    const set = next.get(a) ?? new Set<string>();
    set.add(b);
    next.set(a, set);
  };
  for (const connection of connections) {
    add(connection.from, connection.to);
    add(connection.to, connection.from);
  }
  const distance = new Map<string, number>([[focus, 0]]);
  let frontier = [focus];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    const reached: string[] = [];
    for (const id of frontier) {
      for (const other of next.get(id) ?? []) {
        if (distance.has(other)) continue;
        distance.set(other, hop);
        reached.push(other);
      }
    }
    frontier = reached;
  }
  return distance;
}

export type GraphChoice = {
  concepts: KnowledgeGraphConcept[];
  connections: KnowledgeConnection[];
  shown: { concepts: number; connections: number };
  total: { concepts: number; connections: number };
};

/**
 * What one graph read draws: the candidates - every concept, or those
 * `within` names (a neighborhood with each one's distance, or what typed
 * words found) - ranked nearest first, then most connected, then by name;
 * at most `KNOWLEDGE_GRAPH_LIMITS.concepts` of them, and of the connections
 * among the drawn ones at most `KNOWLEDGE_GRAPH_LIMITS.connections`, claims
 * before read-together links and the best connected first. `total` counts
 * the candidates and the connections among them, so a view says what it
 * left out.
 */
export function chooseGraph(
  concepts: readonly KnowledgeGraphConcept[],
  connections: readonly KnowledgeConnection[],
  within?: ReadonlyMap<string, number>,
  limits: { concepts: number; connections: number } = KNOWLEDGE_GRAPH_LIMITS,
): GraphChoice {
  const candidates = concepts
    .filter((concept) => !within || within.has(concept.id))
    .sort(
      (a, b) =>
        (within?.get(a.id) ?? 0) - (within?.get(b.id) ?? 0) ||
        b.degree - a.degree ||
        a.title.localeCompare(b.title) ||
        (a.id < b.id ? -1 : 1),
    );
  const candidateIds = new Set(candidates.map((concept) => concept.id));
  const among = (ids: ReadonlySet<string>) =>
    connections.filter((connection) => ids.has(connection.from) && ids.has(connection.to));
  const drawn = candidates.slice(0, limits.concepts);
  const drawnIds = new Set(drawn.map((concept) => concept.id));
  const degree = new Map(concepts.map((concept) => [concept.id, concept.degree]));
  const weight = (connection: KnowledgeConnection) =>
    (degree.get(connection.from) ?? 0) + (degree.get(connection.to) ?? 0);
  const lines = among(drawnIds)
    .sort(
      (a, b) =>
        Number(a.kind === "context") - Number(b.kind === "context") ||
        weight(b) - weight(a) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, limits.connections);
  return {
    concepts: drawn,
    connections: lines,
    shown: { concepts: drawn.length, connections: lines.length },
    total: { concepts: candidates.length, connections: among(candidateIds).length },
  };
}

/** One page of a list, clamped to the pages it has, and which page that was. */
export function pageOf<T>(
  rows: readonly T[],
  page: number | undefined,
  size = KNOWLEDGE_LIST_PAGE,
): { rows: T[]; page: number } {
  const last = Math.max(0, Math.ceil(rows.length / size) - 1);
  const at = Math.min(Math.max(0, page ?? 0), last);
  return { rows: rows.slice(at * size, at * size + size), page: at };
}
