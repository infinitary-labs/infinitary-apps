// --- knowledge, in every build ----------------------------------------------

/**
 * The captain's personal facts and saved references: concepts and findings
 * with their evidence in the captain's collection. Standing directions use
 * the captain's scope or an exact project identifier. A panel reads them;
 * it never writes them. A collection that cannot be read answers
 * `unavailable` with the app's words for why, never an empty one.
 */
export type PanelKnowledgeUnavailable = { state: "unavailable"; reason: string };

/** One end of a connection or a reference, by name. */
export type PanelKnowledgeNamed = {
  id: string;
  kind: "concept" | "finding";
  title: string;
  retired: boolean;
};

/**
 * Where a finding stands: `differing` when a check with evidence or another
 * finding contradicts it, `recheck` when a source it cites changed or is
 * gone since it was kept, `checked` when its current revision has a
 * supporting check with evidence, else `unchecked`; `superseded` and
 * `retired` before all of them.
 */
export type PanelKnowledgeStanding =
  | "checked"
  | "unchecked"
  | "recheck"
  | "differing"
  | "superseded"
  | "retired";

/** What a finding asks of its reader; both can hold at once. */
export type PanelKnowledgeAttention = { recheck: boolean; differing: boolean };

/** One collection and its active entries, counted. */
export type PanelKnowledgeCollection = {
  /** `captain` for the private collection, else the project's id. */
  scope: string;
  /** The project's name; empty for the private collection. */
  name: string;
  private: boolean;
  concepts: number;
  findings: number;
  directions?: number;
};

/** `knowledge.collections`: the private collection first, then each project's by name. */
export type PanelKnowledgeCollections =
  | { state: "ready"; collections: PanelKnowledgeCollection[] }
  | PanelKnowledgeUnavailable;

export type PanelKnowledgeGraphConcept = {
  id: string;
  title: string;
  aliases: string[];
  findings: number;
  /** Connections it has in the whole collection, drawn or not. */
  degree: number;
};

/**
 * A connection between two concepts: a `claim` is a finding's relationship,
 * from its subject to its object with the finding's own predicate - no
 * truer than that finding; a `context` link is a read-together suggestion
 * with its reason, undirected and never a claim.
 */
export type PanelKnowledgeConnection =
  | {
      kind: "claim";
      id: string;
      from: string;
      to: string;
      predicate: string;
      finding: string;
      standing: PanelKnowledgeStanding;
    }
  | { kind: "context"; id: string; from: string; to: string; reason: string };

/**
 * `knowledge.graph` (`reads.subscribe("knowledge.graph", { scope, focus?,
 * hops?, query? }, listener)`): one collection's concepts and the
 * connections among them, at most 75 and 200 - its most connected first,
 * the neighborhood of `focus` one or two hops out, or what `query` finds -
 * with how many there are (`total`) beside how many came (`shown`).
 */
export type PanelKnowledgeGraph =
  | {
      state: "ready";
      scope: string;
      focus: string | null;
      concepts: PanelKnowledgeGraphConcept[];
      connections: PanelKnowledgeConnection[];
      shown: { concepts: number; connections: number };
      total: { concepts: number; connections: number };
    }
  | PanelKnowledgeUnavailable;

export type PanelKnowledgeConceptRow = {
  id: string;
  title: string;
  aliases: string[];
  explanation: string;
  findings: number;
};

/** `knowledge.concepts` (`{ scope, query?, page? }`): twenty concepts a page, by name or as `query` ranks them. */
export type PanelKnowledgeConcepts =
  | {
      state: "ready";
      scope: string;
      rows: PanelKnowledgeConceptRow[];
      total: number;
      page: number;
    }
  | PanelKnowledgeUnavailable;

export type PanelKnowledgeRelationship = {
  from: PanelKnowledgeNamed;
  predicate: string;
  to: PanelKnowledgeNamed;
};

export type PanelKnowledgeFindingRow = {
  id: string;
  statement: string;
  basis: "observation" | "inference";
  conditions: string;
  about: PanelKnowledgeNamed[];
  relationship: PanelKnowledgeRelationship | null;
  standing: PanelKnowledgeStanding;
  attention: PanelKnowledgeAttention;
  sources: number;
  checks: number;
};

/**
 * `knowledge.findings` (`{ scope, query?, filter?, page? }`): twenty
 * findings a page, newest first or as `query` ranks them; `filter` is
 * `all`, `recheck` or `differing`.
 */
export type PanelKnowledgeFindings =
  | {
      state: "ready";
      scope: string;
      rows: PanelKnowledgeFindingRow[];
      total: number;
      page: number;
    }
  | PanelKnowledgeUnavailable;

/** Where a kept source came from. */
export type PanelKnowledgeOrigin =
  | {
      kind: "file";
      path: string;
      startLine: number;
      endLine: number;
      commit: string | null;
      dirty: boolean;
    }
  | { kind: "report"; key: string; event: number }
  | { kind: "quote"; citation: string }
  | {
      kind: "article";
      url: string;
      title: string;
      author: string | null;
      published: string | null;
      retrieved: number;
    };

/** A kept source and whether it still reads the same where its project lives. */
export type PanelKnowledgeSource = {
  id: string;
  origin: PanelKnowledgeOrigin;
  text: string;
  capturedAt: number;
  check: { state: "unchanged" | "changed" | "missing" | "unknown" | "kept"; detail: string };
};

export type PanelKnowledgeCheck = {
  id: string;
  revision: number;
  verdict: "supports" | "contradicts" | "inconclusive";
  method: string;
  conditions: string;
  by: string;
  at: number;
  sources: PanelKnowledgeSource[];
};

export type PanelKnowledgeEntryConnection =
  | {
      kind: "claim";
      id: string;
      finding: string;
      from: PanelKnowledgeNamed;
      predicate: string;
      to: PanelKnowledgeNamed;
      standing: PanelKnowledgeStanding;
    }
  | {
      kind: "context";
      id: string;
      from: PanelKnowledgeNamed;
      to: PanelKnowledgeNamed;
      reason: string;
    };

/** One concept or finding whole. */
export type PanelKnowledgeEntry = {
  id: string;
  scope: string;
  kind: "concept" | "finding";
  revision: number;
  current: number;
  retired: boolean;
  title: string;
  aliases: string[];
  explanation: string;
  basis: "observation" | "inference" | null;
  conditions: string;
  about: PanelKnowledgeNamed[];
  relationship: PanelKnowledgeRelationship | null;
  standing: PanelKnowledgeStanding | null;
  attention: PanelKnowledgeAttention | null;
  author: string;
  createdAt: number;
  at: number;
  connections: PanelKnowledgeEntryConnection[];
  findings: { id: string; statement: string; standing: PanelKnowledgeStanding }[];
  findingsTotal: number;
  sources: PanelKnowledgeSource[];
  checks: PanelKnowledgeCheck[];
  revisions: {
    revision: number;
    op: "publish" | "revise" | "link" | "retire" | "restore";
    by: string;
    reason: string;
    at: number;
    title: string;
  }[];
  olderRevisions: number;
  relations: {
    type: "contradicts" | "supersedes" | "duplicates";
    reason: string;
    other: PanelKnowledgeNamed;
    outgoing: boolean;
    by: string;
    at: number;
  }[];
  uses: {
    count: number;
    recent: { revision: number; by: string; task: string | null; purpose: string; at: number }[];
  };
};

/** `knowledge.entry` (`{ id, revision? }`): one entry whole, or `missing`. */
export type PanelKnowledgeEntryRead =
  | { state: "ready"; entry: PanelKnowledgeEntry }
  | { state: "missing" }
  | PanelKnowledgeUnavailable;

/**
 * Where the captain's own words for a revision of a direction were heard: their words to the first
 * mate, their reply or click on a card (by id and title), a line they typed in a task's Crewmate tab,
 * their standing reply on a task (by key), or their own change in the window.
 */
export type PanelKnowledgeDirectionHeard = {
  from: "turn" | "card" | "crewmate-tab" | "standing" | "window";
  card?: string;
  title?: string;
  task?: string;
};

/** Standing instructions or advice, distinct from findings. Reads never grant permission. */
export type PanelKnowledgeDirectionRow = {
  id: string;
  kind: "direction";
  text: string;
  scope: string;
  scopeName: string;
  origin: string;
  authority: "instruction" | "advice";
  revision: number;
  updatedAt: number;
  /** Where the current revision was heard from the captain; absent when it was not. */
  heard?: PanelKnowledgeDirectionHeard;
};
export type PanelKnowledgeDirections =
  | {
      state: "ready";
      scope: string;
      rows: PanelKnowledgeDirectionRow[];
      total: number;
      page: number;
    }
  | PanelKnowledgeUnavailable;

/** A direction's current state and its edits in Knowledge. */
export interface PanelKnowledgeDirection extends PanelKnowledgeDirectionRow {
  retired: boolean;
  createdAt: number;
  history: {
    revision: number;
    op: "publish" | "revise" | "retire";
    text: string;
    origin: string;
    scope: string;
    evidence: string;
    at: number;
    heard?: PanelKnowledgeDirectionHeard;
  }[];
  page: number;
  total: number;
}
export type PanelKnowledgeDirectionRead =
  | { state: "ready"; direction: PanelKnowledgeDirection }
  | { state: "missing" }
  | PanelKnowledgeUnavailable;
