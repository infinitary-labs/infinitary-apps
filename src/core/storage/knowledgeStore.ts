import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { type AppDatabase, readDatabaseSnapshot, schemaHistoryKnown } from "./db";

/**
 * userData/knowledge/knowledge.db (docs/knowledge.md, "Where it is kept"):
 * the captain-owned collection and standing directions in every build.
 * Its own schema history is checked before a writable connection opens it.
 * An unreadable collection remains untouched and pauses new agent work.
 *
 * Rows are immutable history plus two derived projections: `edges`, the
 * links the current revision of each entry declares, and `search`, its
 * words. Both are rebuilt for an entry each time it takes a revision.
 */

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('concept', 'finding')),
    revision INTEGER NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'retired')),
    author TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX entries_scope ON entries (scope, kind, lifecycle);
  CREATE TABLE revisions (
    entry_id TEXT NOT NULL REFERENCES entries (id),
    revision INTEGER NOT NULL,
    op TEXT NOT NULL,
    body TEXT NOT NULL,
    actor TEXT NOT NULL,
    origin TEXT NOT NULL,
    reason TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (entry_id, revision)
  );
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'report', 'quote')),
    origin TEXT NOT NULL,
    text TEXT NOT NULL,
    digest TEXT NOT NULL,
    actor TEXT NOT NULL,
    captured_at INTEGER NOT NULL
  );
  CREATE TABLE assessments (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL REFERENCES entries (id),
    revision INTEGER NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('supports', 'contradicts', 'inconclusive')),
    method TEXT NOT NULL,
    conditions TEXT NOT NULL,
    sources TEXT NOT NULL,
    actor TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX assessments_entry ON assessments (entry_id);
  CREATE TABLE relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL REFERENCES entries (id),
    from_revision INTEGER NOT NULL,
    to_id TEXT NOT NULL REFERENCES entries (id),
    to_revision INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('contradicts', 'supersedes', 'duplicates')),
    reason TEXT NOT NULL,
    actor TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX relations_from ON relations (from_id);
  CREATE INDEX relations_to ON relations (to_id);
  CREATE TABLE edges (
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    layer TEXT NOT NULL CHECK (layer IN ('context', 'about', 'relationship')),
    label TEXT NOT NULL,
    via TEXT NOT NULL,
    PRIMARY KEY (from_id, to_id, layer, via)
  );
  CREATE INDEX edges_to ON edges (to_id);
  CREATE INDEX edges_via ON edges (via);
  CREATE TABLE uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id TEXT NOT NULL REFERENCES entries (id),
    revision INTEGER NOT NULL,
    actor TEXT NOT NULL,
    task_id TEXT,
    purpose TEXT NOT NULL,
    observed TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX uses_entry ON uses (entry_id);
  CREATE INDEX uses_task ON uses (task_id);
  CREATE TABLE requests (
    actor TEXT NOT NULL,
    request_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    result TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (actor, request_id)
  );
  CREATE VIRTUAL TABLE search USING fts5 (
    entry_id UNINDEXED,
    scope UNINDEXED,
    kind UNINDEXED,
    title,
    aliases,
    body,
    tokenize = 'porter unicode61'
  );
  `,
  `
  -- Rebuild only the finding projection, not its immutable revisions or evidence.
  UPDATE search SET body = (
    SELECT json_extract(r.body, '$.statement') FROM entries e
    JOIN revisions r ON r.entry_id = e.id AND r.revision = e.revision
    WHERE e.id = search.entry_id
  ) WHERE kind = 'finding';
  `,
  `
  ALTER TABLE entries ADD COLUMN lane TEXT NOT NULL DEFAULT 'personal';
  CREATE TABLE articles (
    scope TEXT NOT NULL,
    url TEXT NOT NULL,
    concept_id TEXT NOT NULL,
    PRIMARY KEY (scope, url)
  );
  CREATE TABLE sources_next (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('file', 'report', 'quote', 'article')),
    origin TEXT NOT NULL,
    text TEXT NOT NULL,
    digest TEXT NOT NULL,
    actor TEXT NOT NULL,
    captured_at INTEGER NOT NULL
  );
  INSERT INTO sources_next SELECT * FROM sources;
  DROP TABLE sources;
  ALTER TABLE sources_next RENAME TO sources;
  `,
  `
  -- Captain-approved removal of project-owned knowledge, not personal entries.
  DELETE FROM requests WHERE EXISTS (
    SELECT 1 FROM json_each(requests.result, '$.ids') r
    JOIN entries e ON e.id = r.value WHERE e.scope <> 'captain'
  );
  DELETE FROM assessments WHERE entry_id IN (SELECT id FROM entries WHERE scope <> 'captain');
  DELETE FROM relations WHERE from_id IN (SELECT id FROM entries WHERE scope <> 'captain')
    OR to_id IN (SELECT id FROM entries WHERE scope <> 'captain');
  DELETE FROM uses WHERE entry_id IN (SELECT id FROM entries WHERE scope <> 'captain');
  DELETE FROM edges WHERE from_id IN (SELECT id FROM entries WHERE scope <> 'captain')
    OR to_id IN (SELECT id FROM entries WHERE scope <> 'captain')
    OR via IN (SELECT id FROM entries WHERE scope <> 'captain');
  DELETE FROM revisions WHERE entry_id IN (SELECT id FROM entries WHERE scope <> 'captain');
  DELETE FROM search WHERE scope <> 'captain';
  DELETE FROM articles WHERE scope <> 'captain';
  DELETE FROM sources WHERE scope <> 'captain';
  DELETE FROM entries WHERE scope <> 'captain';
  CREATE TABLE directions (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    text TEXT NOT NULL,
    origin TEXT NOT NULL,
    revision INTEGER NOT NULL,
    retired INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE direction_history (
    id TEXT NOT NULL REFERENCES directions(id),
    revision INTEGER NOT NULL,
    text TEXT NOT NULL,
    origin TEXT NOT NULL,
    scope TEXT NOT NULL,
    op TEXT NOT NULL,
    evidence TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (id, revision)
  );
  `,
];

export const KNOWLEDGE_DB_FILE = "knowledge.db";

export type DirectionRow = {
  id: string;
  scope: string;
  text: string;
  origin: string;
  revision: number;
  retired: boolean;
  createdAt: number;
  updatedAt: number;
};
export type DirectionRevision = {
  revision: number;
  text: string;
  origin: string;
  scope: string;
  op: "publish" | "revise" | "retire";
  evidence: string;
  at: number;
};

export type KnowledgeKind = "concept" | "finding";
export type KnowledgeLifecycle = "active" | "retired";
export type FindingBasis = "observation" | "inference";
export type AssessmentVerdict = "supports" | "contradicts" | "inconclusive";
export type RelationType = "contradicts" | "supersedes" | "duplicates";
export type EdgeLayer = "context" | "about" | "relationship";
export type RevisionOp = "publish" | "revise" | "link" | "retire" | "restore";

/** A navigation link a concept declares: read these together, and why. */
export type ConceptLink = { to: string; reason: string };

export type ConceptBody = {
  title: string;
  aliases: string[];
  explanation: string;
  links: ConceptLink[];
  sources: string[];
  /** Projects this entry applies to. Absent means it applies generally. */
  appliesTo?: string[];
  /** The link of a saved article, so a later search can find the concept. */
  savedUrl?: string;
};

/** An authored claim between two concepts: subject, predicate, object. */
export type Relationship = { from: string; predicate: string; to: string };

export type FindingBody = {
  statement: string;
  basis: FindingBasis;
  about: string[];
  relationship?: Relationship;
  conditions: string;
  sources: string[];
  /** Projects this entry applies to. Absent means it applies generally. */
  appliesTo?: string[];
};

export type EntryBody = ConceptBody | FindingBody;

/** Whose collection an entry belongs to within the captain's knowledge. */
export type KnowledgeLane = "personal" | "reference";

export type EntryRow = {
  id: string;
  scope: string;
  kind: KnowledgeKind;
  revision: number;
  lifecycle: KnowledgeLifecycle;
  author: string;
  createdAt: number;
  updatedAt: number;
  /** Personal context, or a reference saved on purpose. Older rows are personal. */
  lane: KnowledgeLane;
};

export type RevisionRow = {
  entryId: string;
  revision: number;
  op: RevisionOp;
  body: EntryBody;
  actor: string;
  origin: string;
  reason: string;
  at: number;
};

export type FileOrigin = {
  kind: "file";
  /** The registered project the file belongs to. */
  project: string;
  path: string;
  startLine: number;
  endLine: number;
  /** The working copy's commit when captured; null when it had none. */
  commit: string | null;
  /** The file differed from that commit when captured: branch-local work. */
  dirty: boolean;
  /** sha256 of the whole file as captured, to tell later whether it changed. */
  fileDigest: string;
};
export type ReportOrigin = { kind: "report"; task: string; key: string; event: number };
export type QuoteOrigin = { kind: "quote"; citation: string };
/** A deliberately saved article. The excerpt is `text`; the page itself is not kept. */
export type ArticleOrigin = {
  kind: "article";
  url: string;
  title: string;
  author: string | null;
  published: string | null;
  /** When the excerpt was kept, stamped by the host. */
  retrieved: number;
};
export type SourceOrigin = FileOrigin | ReportOrigin | QuoteOrigin | ArticleOrigin;

export type SourceRow = {
  id: string;
  scope: string;
  kind: SourceOrigin["kind"];
  origin: SourceOrigin;
  text: string;
  /** sha256 of `text`: integrity of what was kept, never proof that it is true. */
  digest: string;
  actor: string;
  capturedAt: number;
};

export type AssessmentRow = {
  id: string;
  entryId: string;
  revision: number;
  verdict: AssessmentVerdict;
  method: string;
  conditions: string;
  sources: string[];
  actor: string;
  at: number;
};

export type RelationRow = {
  id: number;
  fromId: string;
  fromRevision: number;
  toId: string;
  toRevision: number;
  type: RelationType;
  reason: string;
  actor: string;
  at: number;
};

export type EdgeRow = {
  fromId: string;
  toId: string;
  layer: EdgeLayer;
  label: string;
  via: string;
};

export type UseRow = {
  id: number;
  entryId: string;
  revision: number;
  actor: string;
  taskId: string | null;
  purpose: string;
  observed: Record<string, unknown>;
  at: number;
};

export type SearchHit = { id: string; rank: number };

/** Why this build cannot use the collection; knowledge alone is refused. */
export class KnowledgeUnavailableError extends Error {
  constructor(readonly reason: "newer" | "unreadable") {
    super(
      reason === "newer"
        ? "Knowledge was saved by a newer version of the app, so this version leaves it untouched."
        : "Knowledge could not be read, so this version leaves it untouched.",
    );
    this.name = "KnowledgeUnavailableError";
  }
}

type EntryDbRow = {
  id: string;
  scope: string;
  kind: KnowledgeKind;
  revision: number;
  lifecycle: KnowledgeLifecycle;
  author: string;
  created_at: number;
  updated_at: number;
  lane?: string;
};

function entryOf(row: EntryDbRow): EntryRow {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    revision: row.revision,
    lifecycle: row.lifecycle,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lane: row.lane === "reference" ? "reference" : "personal",
  };
}

type RevisionDbRow = {
  entry_id: string;
  revision: number;
  op: RevisionOp;
  body: string;
  actor: string;
  origin: string;
  reason: string;
  at: number;
};

function revisionOf(row: RevisionDbRow): RevisionRow {
  return {
    entryId: row.entry_id,
    revision: row.revision,
    op: row.op,
    body: JSON.parse(row.body) as EntryBody,
    actor: row.actor,
    origin: row.origin,
    reason: row.reason,
    at: row.at,
  };
}

/**
 * The one connection to the collection. Only `KnowledgeService` holds it,
 * so every write goes through that one writer.
 */
export class KnowledgeStore {
  private constructor(private readonly db: AppDatabase) {}

  /**
   * Open (creating when absent) the collection under `dir`. A file whose
   * schema history this build does not know is inspected through a private
   * copy and refused before any writable connection touches it.
   */
  static open(dir: string): KnowledgeStore {
    const path = join(dir, KNOWLEDGE_DB_FILE);
    if (existsSync(path)) {
      let known: boolean;
      try {
        known = readDatabaseSnapshot(path, (db) => schemaHistoryKnown(db, MIGRATIONS.length));
      } catch {
        throw new KnowledgeUnavailableError("unreadable");
      }
      if (!known) throw new KnowledgeUnavailableError("newer");
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let db: AppDatabase | undefined;
    try {
      db = new Database(path);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      migrate(db);
      return new KnowledgeStore(db);
    } catch {
      db?.close();
      throw new KnowledgeUnavailableError("unreadable");
    }
  }

  /** A collection that lives only in memory, for tests. */
  static inMemory(): KnowledgeStore {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    return new KnowledgeStore(db);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(run: () => T): T {
    return this.db.transaction(run)();
  }

  directions(): DirectionRow[] {
    return this.db
      .prepare(`SELECT id, scope, text, origin, revision, retired,
      created_at AS createdAt, updated_at AS updatedAt FROM directions ORDER BY created_at, id`)
      .all()
      .map((row) => {
        const entry = row as Omit<DirectionRow, "retired"> & { retired: number };
        return { ...entry, retired: Boolean(entry.retired) };
      });
  }

  directionHistory(id: string): DirectionRevision[] {
    return this.db
      .prepare(`SELECT revision, text, origin, scope, op, evidence, at
      FROM direction_history WHERE id = ? ORDER BY revision DESC`)
      .all(id) as DirectionRevision[];
  }

  saveDirection(row: DirectionRow, op: DirectionRevision["op"], evidence: string): void {
    this.db
      .prepare(`INSERT INTO directions VALUES (@id, @scope, @text, @origin, @revision,
      @retired, @createdAt, @updatedAt) ON CONFLICT(id) DO UPDATE SET
      text=excluded.text, origin=excluded.origin, revision=excluded.revision,
      retired=excluded.retired, updated_at=excluded.updated_at`)
      .run({ ...row, retired: Number(row.retired) });
    this.db
      .prepare(`INSERT INTO direction_history VALUES
      (@id, @revision, @text, @origin, @scope, @op, @evidence, @updatedAt)`)
      .run({ ...row, retired: Number(row.retired), op, evidence });
  }

  entry(id: string): EntryRow | undefined {
    const row = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as
      | EntryDbRow
      | undefined;
    return row ? entryOf(row) : undefined;
  }

  entries(ids: readonly string[]): EntryRow[] {
    return ids.flatMap((id) => this.entry(id) ?? []);
  }

  /** Active entries of the scopes, newest first, for a bounded listing. */
  listed(scopes: readonly string[], kind: KnowledgeKind | undefined, limit: number): EntryRow[] {
    if (scopes.length === 0) return [];
    const marks = scopes.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM entries WHERE scope IN (${marks}) AND lifecycle = 'active'
         ${kind ? "AND kind = ?" : ""} ORDER BY updated_at DESC, id LIMIT ?`,
      )
      .all(...scopes, ...(kind ? [kind] : []), limit) as EntryDbRow[];
    return rows.map(entryOf);
  }

  countActive(scopes: readonly string[]): number {
    if (scopes.length === 0) return 0;
    const marks = scopes.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM entries WHERE scope IN (${marks}) AND lifecycle = 'active'`,
      )
      .get(...scopes) as { n: number };
    return row.n;
  }

  /** Active entries of the scopes, counted by kind: the browser's collection counts. */
  countsByKind(scopes: readonly string[]): { scope: string; kind: KnowledgeKind; n: number }[] {
    if (scopes.length === 0) return [];
    const marks = scopes.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT scope, kind, COUNT(*) AS n FROM entries
         WHERE scope IN (${marks}) AND lifecycle = 'active' GROUP BY scope, kind`,
      )
      .all(...scopes) as { scope: string; kind: KnowledgeKind; n: number }[];
  }

  /**
   * Every active entry of one kind in a scope, with its current revision's
   * body, newest first: what the browser pages and draws from.
   */
  currentOf(scope: string, kind: KnowledgeKind): { entry: EntryRow; body: EntryBody }[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, r.body AS current_body FROM entries e
         JOIN revisions r ON r.entry_id = e.id AND r.revision = e.revision
         WHERE e.scope = ? AND e.kind = ? AND e.lifecycle = 'active'
         ORDER BY e.updated_at DESC, e.id`,
      )
      .all(scope, kind) as (EntryDbRow & { current_body: string })[];
    return rows.map((row) => ({
      entry: entryOf(row),
      body: JSON.parse(row.current_body) as EntryBody,
    }));
  }

  /** The links every active entry of a scope declares now. */
  edgesIn(scope: string): EdgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT ed.from_id, ed.to_id, ed.layer, ed.label, ed.via FROM edges ed
         JOIN entries v ON v.id = ed.via
         WHERE v.scope = ? AND v.lifecycle = 'active'
         ORDER BY ed.layer, ed.from_id, ed.to_id, ed.via`,
      )
      .all(scope) as {
      from_id: string;
      to_id: string;
      layer: EdgeLayer;
      label: string;
      via: string;
    }[];
    return rows.map((row) => ({
      fromId: row.from_id,
      toId: row.to_id,
      layer: row.layer,
      label: row.label,
      via: row.via,
    }));
  }

  revision(id: string, revision: number): RevisionRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM revisions WHERE entry_id = ? AND revision = ?")
      .get(id, revision) as RevisionDbRow | undefined;
    return row ? revisionOf(row) : undefined;
  }

  /** Revisions newest first, from `before` (exclusive) down. */
  revisions(id: string, before: number, limit: number): RevisionRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM revisions WHERE entry_id = ? AND revision < ? ORDER BY revision DESC LIMIT ?",
      )
      .all(id, before, limit) as RevisionDbRow[];
    return rows.map(revisionOf);
  }

  insertEntry(entry: EntryRow): void {
    this.db
      .prepare(
        `INSERT INTO entries (id, scope, kind, revision, lifecycle, author, created_at, updated_at, lane)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.scope,
        entry.kind,
        entry.revision,
        entry.lifecycle,
        entry.author,
        entry.createdAt,
        entry.updatedAt,
        entry.lane,
      );
  }

  /** The concept already saved for this article link, if any. */
  articleConcept(scope: string, url: string): string | undefined {
    const row = this.db
      .prepare("SELECT concept_id FROM articles WHERE scope = ? AND url = ?")
      .get(scope, url) as { concept_id: string } | undefined;
    return row?.concept_id;
  }

  /** Remember which concept a saved article link finds. A link keeps its first concept. */
  saveArticle(scope: string, url: string, conceptId: string): void {
    this.db
      .prepare(
        "INSERT INTO articles (scope, url, concept_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(scope, url, conceptId);
  }

  /** Move an entry to a new current revision; the revision row is appended beside it. */
  advance(id: string, revision: number, lifecycle: KnowledgeLifecycle, at: number): void {
    this.db
      .prepare("UPDATE entries SET revision = ?, lifecycle = ?, updated_at = ? WHERE id = ?")
      .run(revision, lifecycle, at, id);
  }

  insertRevision(row: RevisionRow): void {
    this.db
      .prepare(
        `INSERT INTO revisions (entry_id, revision, op, body, actor, origin, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.entryId,
        row.revision,
        row.op,
        JSON.stringify(row.body),
        row.actor,
        row.origin,
        row.reason,
        row.at,
      );
  }

  /** Replace the links one entry's current revision declares. */
  replaceEdges(via: string, edges: readonly Omit<EdgeRow, "via">[]): void {
    this.db.prepare("DELETE FROM edges WHERE via = ?").run(via);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO edges (from_id, to_id, layer, label, via) VALUES (?, ?, ?, ?, ?)",
    );
    for (const edge of edges) insert.run(edge.fromId, edge.toId, edge.layer, edge.label, via);
  }

  /** Every edge with `id` at either end. */
  edgesTouching(id: string): EdgeRow[] {
    const rows = this.db
      .prepare(
        `SELECT from_id, to_id, layer, label, via FROM edges WHERE from_id = ? OR to_id = ?
         ORDER BY layer, from_id, to_id, via`,
      )
      .all(id, id) as {
      from_id: string;
      to_id: string;
      layer: EdgeLayer;
      label: string;
      via: string;
    }[];
    return rows.map((row) => ({
      fromId: row.from_id,
      toId: row.to_id,
      layer: row.layer,
      label: row.label,
      via: row.via,
    }));
  }

  /** The edges one entry's current revision declares. */
  edgesVia(via: string): EdgeRow[] {
    const rows = this.db
      .prepare(
        "SELECT from_id, to_id, layer, label, via FROM edges WHERE via = ? ORDER BY layer, from_id, to_id",
      )
      .all(via) as {
      from_id: string;
      to_id: string;
      layer: EdgeLayer;
      label: string;
      via: string;
    }[];
    return rows.map((row) => ({
      fromId: row.from_id,
      toId: row.to_id,
      layer: row.layer,
      label: row.label,
      via: row.via,
    }));
  }

  /** Replace an entry's words in the search index; a retired entry has none. */
  index(entry: Pick<EntryRow, "id" | "scope" | "kind" | "lifecycle">, words: SearchWords): void {
    this.db.prepare("DELETE FROM search WHERE entry_id = ?").run(entry.id);
    if (entry.lifecycle !== "active") return;
    this.db
      .prepare(
        "INSERT INTO search (entry_id, scope, kind, title, aliases, body) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(entry.id, entry.scope, entry.kind, words.title, words.aliases, words.body);
  }

  /**
   * Lexical search over names, aliases and text, best first: a title match
   * outranks an alias, an alias outranks the body. `match` is an FTS5 query
   * the service builds from plain words, never the caller's syntax.
   */
  search(
    scopes: readonly string[],
    match: string,
    kind: KnowledgeKind | undefined,
    limit: number,
    offset: number,
  ): { hits: SearchHit[]; total: number } {
    if (scopes.length === 0) return { hits: [], total: 0 };
    const marks = scopes.map(() => "?").join(", ");
    const where = `search MATCH ? AND scope IN (${marks}) ${kind ? "AND kind = ?" : ""}`;
    const args = [match, ...scopes, ...(kind ? [kind] : [])];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM search WHERE ${where}`).get(...args) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT entry_id AS id, bm25(search, 0, 0, 0, 6.0, 4.0, 1.0) AS rank FROM search
         WHERE ${where} ORDER BY rank, entry_id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as SearchHit[];
    return { hits: rows, total };
  }

  insertSource(row: SourceRow): void {
    this.db
      .prepare(
        `INSERT INTO sources (id, scope, kind, origin, text, digest, actor, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.scope,
        row.kind,
        JSON.stringify(row.origin),
        row.text,
        row.digest,
        row.actor,
        row.capturedAt,
      );
  }

  sources(ids: readonly string[]): SourceRow[] {
    const read = this.db.prepare("SELECT * FROM sources WHERE id = ?");
    return ids.flatMap((id) => {
      const row = read.get(id) as
        | {
            id: string;
            scope: string;
            kind: SourceOrigin["kind"];
            origin: string;
            text: string;
            digest: string;
            actor: string;
            captured_at: number;
          }
        | undefined;
      if (!row) return [];
      return [
        {
          id: row.id,
          scope: row.scope,
          kind: row.kind,
          origin: JSON.parse(row.origin) as SourceOrigin,
          text: row.text,
          digest: row.digest,
          actor: row.actor,
          capturedAt: row.captured_at,
        },
      ];
    });
  }

  insertAssessment(row: AssessmentRow): void {
    this.db
      .prepare(
        `INSERT INTO assessments (id, entry_id, revision, verdict, method, conditions, sources, actor, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.entryId,
        row.revision,
        row.verdict,
        row.method,
        row.conditions,
        JSON.stringify(row.sources),
        row.actor,
        row.at,
      );
  }

  assessments(entryId: string): AssessmentRow[] {
    const rows = this.db
      .prepare("SELECT * FROM assessments WHERE entry_id = ? ORDER BY at, id")
      .all(entryId) as {
      id: string;
      entry_id: string;
      revision: number;
      verdict: AssessmentVerdict;
      method: string;
      conditions: string;
      sources: string;
      actor: string;
      at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      entryId: row.entry_id,
      revision: row.revision,
      verdict: row.verdict,
      method: row.method,
      conditions: row.conditions,
      sources: JSON.parse(row.sources) as string[],
      actor: row.actor,
      at: row.at,
    }));
  }

  insertRelation(row: Omit<RelationRow, "id">): number {
    const result = this.db
      .prepare(
        `INSERT INTO relations (from_id, from_revision, to_id, to_revision, type, reason, actor, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.fromId,
        row.fromRevision,
        row.toId,
        row.toRevision,
        row.type,
        row.reason,
        row.actor,
        row.at,
      );
    return Number(result.lastInsertRowid);
  }

  /** Every history relation with `id` at either end, oldest first. */
  relations(id: string): RelationRow[] {
    const rows = this.db
      .prepare("SELECT * FROM relations WHERE from_id = ? OR to_id = ? ORDER BY at, id")
      .all(id, id) as {
      id: number;
      from_id: string;
      from_revision: number;
      to_id: string;
      to_revision: number;
      type: RelationType;
      reason: string;
      actor: string;
      at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      fromId: row.from_id,
      fromRevision: row.from_revision,
      toId: row.to_id,
      toRevision: row.to_revision,
      type: row.type,
      reason: row.reason,
      actor: row.actor,
      at: row.at,
    }));
  }

  insertUse(row: Omit<UseRow, "id">): number {
    const result = this.db
      .prepare(
        `INSERT INTO uses (entry_id, revision, actor, task_id, purpose, observed, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.entryId,
        row.revision,
        row.actor,
        row.taskId,
        row.purpose,
        JSON.stringify(row.observed),
        row.at,
      );
    return Number(result.lastInsertRowid);
  }

  /** Declared uses of an entry, newest first. */
  uses(entryId: string, limit: number): UseRow[] {
    return this.rowsOfUses(
      this.db
        .prepare("SELECT * FROM uses WHERE entry_id = ? ORDER BY at DESC, id DESC LIMIT ?")
        .all(entryId, limit),
    );
  }

  /** The uses one task's work declared, newest first. */
  usesOfTask(taskId: string, limit: number): UseRow[] {
    return this.rowsOfUses(
      this.db
        .prepare("SELECT * FROM uses WHERE task_id = ? ORDER BY at DESC, id DESC LIMIT ?")
        .all(taskId, limit),
    );
  }

  private rowsOfUses(found: unknown[]): UseRow[] {
    const rows = found as {
      id: number;
      entry_id: string;
      revision: number;
      actor: string;
      task_id: string | null;
      purpose: string;
      observed: string;
      at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      entryId: row.entry_id,
      revision: row.revision,
      actor: row.actor,
      taskId: row.task_id,
      purpose: row.purpose,
      observed: JSON.parse(row.observed) as Record<string, unknown>,
      at: row.at,
    }));
  }

  /** The result a request already produced, for an idempotent retry. */
  request(actor: string, requestId: string): { digest: string; result: string } | undefined {
    return this.db
      .prepare("SELECT digest, result FROM requests WHERE actor = ? AND request_id = ?")
      .get(actor, requestId) as { digest: string; result: string } | undefined;
  }

  saveRequest(actor: string, requestId: string, digest: string, result: string, at: number) {
    this.db
      .prepare(
        "INSERT INTO requests (actor, request_id, digest, result, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(actor, requestId, digest, result, at);
  }
}

/** The words an entry is found by. */
export type SearchWords = { title: string; aliases: string; body: string };

function migrate(db: AppDatabase): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (row) => row.version,
    ),
  );
  MIGRATIONS.forEach((migration, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(migration);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    })();
  });
}

/** How many schema versions this build knows, for tests that write a newer one. */
export const KNOWLEDGE_SCHEMA_VERSION = MIGRATIONS.length;
