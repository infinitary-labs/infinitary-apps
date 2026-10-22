import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  KNOWLEDGE_ENTRY_FINDINGS,
  KNOWLEDGE_TASK_USES,
  type KnowledgeCollections,
  type KnowledgeConcepts,
  type KnowledgeConceptsArgs,
  type KnowledgeConnection,
  type KnowledgeDirectionArgs,
  type KnowledgeDirectionChange,
  type KnowledgeDirectionChanged,
  type KnowledgeDirectionRead,
  type KnowledgeDirectionRow,
  type KnowledgeDirections,
  type KnowledgeDirectionsArgs,
  type KnowledgeEntry,
  type KnowledgeEntryArgs,
  type KnowledgeEntryConnection,
  type KnowledgeEntryRead,
  type KnowledgeFindingRow,
  type KnowledgeFindings,
  type KnowledgeFindingsArgs,
  type KnowledgeGraph,
  type KnowledgeGraphArgs,
  type KnowledgeGraphConcept,
  type KnowledgeRef,
  type KnowledgeRefs,
  type KnowledgeRefsArgs,
  type KnowledgeSource,
  type KnowledgeStanding,
  type KnowledgeTaskUse,
  type KnowledgeUses,
  type KnowledgeUsesArgs,
} from "@shared/knowledge";
import type { KnowledgeOrigin } from "../knowledge/origin";
import { scanKnowledgeThreat } from "../knowledge/threatScan";
import type { AppDatabase } from "../storage/db";
import {
  type ArticleOrigin,
  type AssessmentRow,
  type AssessmentVerdict,
  type ConceptBody,
  type ConceptLink,
  type DirectionRow,
  type EdgeRow,
  type EntryBody,
  type EntryRow,
  type FindingBasis,
  type FindingBody,
  KNOWLEDGE_DB_FILE,
  type KnowledgeKind,
  type KnowledgeLane,
  KnowledgeStore,
  KnowledgeUnavailableError,
  type RelationRow,
  type Relationship,
  type RelationType,
  type RevisionOp,
  type RevisionRow,
  type SearchWords,
  type SourceOrigin,
  type SourceRow,
  type UseRow,
} from "../storage/knowledgeStore";
import { chooseGraph, degreesOf, neighborhoodOf, pageOf, standingOf } from "./browse";
import { checkFile, type GitFacts, type SourceCheck, sha256 } from "./sources";

/**
 * The one owner of knowledge (docs/knowledge.md): concepts that organize
 * what the crew learned, findings that say something about them with their
 * evidence, and the checks, disagreements and declared uses that follow.
 * Every read and write goes through here, scoped to who asks: Firstmate
 * reads every collection and writes personal context on the captain's words;
 * every crewmate reads and writes captain-owned factual knowledge as needed.
 * Nothing here decides
 * whether a finding is true - the host checks who may write, that every
 * reference stays in its collection, that evidence is what it says it is
 * and whether its source still reads the same, and that a write neither
 * overwrites a newer revision nor repeats itself.
 *
 * The collection lives in its own database (`KnowledgeStore`), opened the
 * first time it is needed. A collection this build cannot read makes
 * knowledge unavailable - every call says so - and leaves the app and the
 * data alone.
 */

export const KNOWLEDGE_LIMITS = {
  /** Search and neighbor pages: hits per page, and the bytes they may fill. */
  pageHits: 10,
  pageBytes: 4 * 1024,
  /** A whole-entry read or a history page. */
  readBytes: 32 * 1024,
  /** One write, everything it carries included. */
  writeBytes: 16 * 1024,
  /** The words a search or an automatic lookup reads. */
  queryBytes: 1024,
  /** Entries one get reads at once. */
  getIds: 5,
  /** The automatic candidates a turn or a brief carries, and their bytes. */
  shortlistHits: 5,
  shortlistBytes: 2 * 1024,
} as const;

/** The collection Firstmate keeps for the captain alone, beside each project's. */
export const PRIVATE_SCOPE = "captain";

/** Who is asking: the host stamps it from the session, never from the model's words. */
export type KnowledgeActor =
  | { kind: "firstmate"; origin: KnowledgeOrigin; canCreate: boolean }
  | {
      kind: "crewmate";
      taskId: string;
      repoId: string;
      cwd?: string;
      /** Legacy actor metadata, ignored; all crewmates have equal factual access. */
      access?: "references";
    };

export type KnowledgeProject = { id: string; name: string; path: string };

export type KnowledgeDeps = {
  /** The collection's folder; absent, an in-memory store (tests). */
  dir?: string;
  projects: {
    get: (id: string) => KnowledgeProject | undefined;
    list: () => KnowledgeProject[];
  };
  /** Task reports a finding may cite. */
  tasks?: {
    resolve: (ref: string) => { id: string; key: string; repoId: string | null } | undefined;
    reports: (taskId: string) => { id: number; text: string }[];
  };
  gitFacts: GitFacts;
  now?: () => number;
  /**
   * Where each new id comes from: random, unless a test pins them so what it
   * records reads and draws the same on every run (tests).
   */
  newId?: (prefix: string) => string;
  /** A store to use instead of opening one (tests). */
  store?: KnowledgeStore;
  /** Told after a write commits and after a purge, so the browser reads again. */
  changed?: () => void;
  /**
   * The captain's closing choice on a task: its newest card he resolved with
   * a choice (a dismissal is none), as it was shown. Bulk retirement stands
   * on it.
   */
  approvals?: {
    of: (ref: string) => KnowledgeApproval | undefined;
  };
  /** Says one line in the feed (a bulk retirement is one line, not one per entry). */
  announce?: (text: string) => void;
};

export type KnowledgeApproval = {
  /** The task's key, as the captain knows it. */
  key: string;
  /** The card's title and body as the captain read them. */
  title: string;
  body: string;
  /** The choice he clicked, by id; `close` is a dismissal. */
  action: string;
  resolvedAt: number;
};

export type FindingState = "checked" | "unchecked" | "disputed" | "superseded" | "retired";

export type FindingStatus = {
  state: FindingState;
  /** A contradicting verdict that cites no evidence: visible, never a dispute. */
  challenged: boolean;
  /** An earlier revision was checked; this one has not been. */
  earlierChecked: boolean;
  supersededBy?: string;
  duplicateOf?: string;
  disputedBy: string[];
  /** The checks that support the current revision, with their method. */
  checks: { method: string; conditions: string; actor: string }[];
};

/** One end of a link, by name. */
export type Named = { id: string; kind: KnowledgeKind; title: string; retired: boolean };

export type EntrySummary = {
  id: string;
  scope: string;
  scopeName: string;
  kind: KnowledgeKind;
  revision: number;
  retired: boolean;
  /** Personal context, or a reference saved on purpose. */
  lane: KnowledgeLane;
  /** A concept's title, or a finding's statement. */
  title: string;
  aliases: string[];
  basis?: FindingBasis;
  about: Named[];
  relationship?: { from: Named; predicate: string; to: Named };
  conditions?: string;
  status?: FindingStatus;
  /** A concept's active findings and read-together links. */
  findings?: number;
  links?: number;
};

export type SourceView = Omit<SourceRow, "scope"> & { check: SourceCheck };

export type AssessmentView = Omit<AssessmentRow, "sources"> & {
  sources: SourceView[];
  current: boolean;
};

export type RelationView = RelationRow & { other: Named; outgoing: boolean };

export type EntryView = {
  summary: EntrySummary;
  /** The revision shown: the current one unless an earlier one was asked for. */
  shown: RevisionRow;
  author: string;
  createdAt: number;
  explanation?: string;
  links: { other: Named; reason: string; outgoing: boolean }[];
  sources: SourceView[];
  assessments: AssessmentView[];
  relations: RelationView[];
  uses: { count: number; recent: UseRow[] };
};

export type Neighbor = {
  layer: "context" | "about" | "relationship" | "history";
  /** Out: this entry declares it. In: the other one does. */
  outgoing: boolean;
  label: string;
  other: EntrySummary;
  /** The finding that claims a relationship between two concepts. */
  via?: string;
};

export type SourceInput =
  | { kind: "file"; path: string; startLine?: number; endLine?: number }
  | { kind: "report"; task: string }
  | { kind: "quote"; text: string; citation: string }
  | {
      kind: "article";
      url: string;
      title: string;
      excerpt: string;
      author?: string;
      published?: string;
    };

export type RecordAction =
  | "publish"
  | "revise"
  | "assess"
  | "relate"
  | "retire"
  | "retire_many"
  | "use";

export type RecordInput = {
  action: RecordAction;
  requestId: string;
  kind?: KnowledgeKind | "direction";
  /** Factual category, not a capability. Crewmates default to reference. */
  lane?: KnowledgeLane;
  id?: string;
  expectedRevision?: number;
  revision?: number;
  scope?: string;
  title?: string;
  aliases?: string[];
  explanation?: string;
  links?: ConceptLink[];
  statement?: string;
  basis?: FindingBasis;
  about?: string[];
  relationship?: Relationship;
  conditions?: string;
  /** Repo ids this entry applies to. Absent means it applies generally. */
  appliesTo?: string[];
  sources?: SourceInput[];
  verdict?: AssessmentVerdict;
  method?: string;
  from?: string;
  to?: string;
  type?: RelationType | "related";
  reason?: string;
  purpose?: string;
  /** retire_many: the task whose closing choice approved the removal. */
  task?: string;
  /** retire_many: the entries to retire; absent, every active entry that card names. */
  ids?: string[];
  /** retire_many: entries the card names that stay. */
  except?: string[];
};

/** A write's answer: its words, and whether this call itself changed the collection. */
export type RecordOutcome = { text: string; committed: boolean; ids: string[] };

export type Availability = { state: "ready" } | { state: "unavailable"; reason: string };

/**
 * The captain's window, as the browser reads: what Firstmate reads - the
 * private collection and every registered project's - and nothing it could
 * write with, since the browser only ever reads.
 */
const WINDOW: KnowledgeActor = { kind: "firstmate", origin: "agent", canCreate: false };

const ID = /^[cf]-[a-z0-9]{6}$/;
/** The most matches one search ranks; later pages stop there. */
const SEARCH_WINDOW = 200;
const SOURCE_ID = /^s-[a-z0-9]{6}$/;
const ID_IN_TEXT = /\b[cf]-[a-z0-9]{6}\b/g;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its me my not of on or our so than that the their them then there these they this to us was we were what when where which who why will with you your".split(
    " ",
  ),
);

/** Text field bounds, in characters. */
const MAX = {
  title: 120,
  alias: 60,
  aliases: 8,
  explanation: 4000,
  links: 12,
  reason: 400,
  statement: 2000,
  about: 8,
  predicate: 60,
  conditions: 1000,
  sources: 6,
  quote: 6000,
  citation: 500,
  excerpt: 1500,
  url: 500,
  author: 80,
  published: 40,
  appliesTo: 8,
  method: 600,
  purpose: 600,
  requestId: 100,
} as const;

/** A write or read the host refused: its message is guidance for the model, never a failed turn. */
export class KnowledgeRefusal extends Error {}

function refuse(message: string): never {
  throw new KnowledgeRefusal(message);
}

function randomId(prefix: string): string {
  const bytes = randomBytes(6);
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}-${id}`;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : item,
  );
}

function clean(value: string | undefined, field: string, max: number, required: boolean): string {
  const text = value?.trim() ?? "";
  if (!text) {
    if (required) refuse(`${field} is required.`);
    return "";
  }
  if (text.length > max) refuse(`${field} is at most ${max} characters.`);
  const threat = scanKnowledgeThreat(text);
  if (threat) {
    refuse(
      `Refused: ${field} matches a ${threat.pattern} pattern. Knowledge is not a place for credentials, instruction overrides or exfiltration links.`,
    );
  }
  return text;
}

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

function matchOf(terms: readonly string[]): string {
  const quoted = terms.map((term) => `"${term}"`);
  const names = `{title aliases} : (${quoted.join(" OR ")})`;
  // A body-only hit needs two distinct query words, never one loose prefix.
  const pairs = quoted.flatMap((left, index) =>
    quoted.slice(index + 1).map((right) => `(body : ${left} AND body : ${right})`),
  );
  return [names, ...pairs].join(" OR ");
}

function wordsOf(body: EntryBody, kind: KnowledgeKind): SearchWords {
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

function edgesOf(id: string, kind: KnowledgeKind, body: EntryBody): Omit<EdgeRow, "via">[] {
  if (kind === "concept") {
    return (body as ConceptBody).links.map((link) => ({
      fromId: id,
      toId: link.to,
      layer: "context" as const,
      label: link.reason,
    }));
  }
  const finding = body as FindingBody;
  return [
    ...finding.about.map((concept) => ({
      fromId: id,
      toId: concept,
      layer: "about" as const,
      label: "",
    })),
    ...(finding.relationship
      ? [
          {
            fromId: finding.relationship.from,
            toId: finding.relationship.to,
            layer: "relationship" as const,
            label: finding.relationship.predicate,
          },
        ]
      : []),
  ];
}

function actorId(actor: KnowledgeActor): string {
  return actor.kind === "firstmate" ? "firstmate" : `task:${actor.taskId}`;
}

function originOf(actor: KnowledgeActor): string {
  return actor.kind === "firstmate" ? actor.origin : "crewmate";
}

export class KnowledgeService {
  private store: KnowledgeStore | undefined;
  private failure: KnowledgeUnavailableError | undefined;
  private readonly now: () => number;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly deps: KnowledgeDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomId;
    this.store = deps.store;
  }

  /**
   * Carry only the remaining active directions before any agent starts.
   * There is no archive or old revision import. Once kept, the old tables
   * are removed. A quit between databases retries the same current rows;
   * a conflicting destination stops startup rather than losing a direction.
   */
  carryDirections(db: AppDatabase): void {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memories'").get()) return;
    const rows = db
      .prepare(`SELECT id, scope, content AS text, origin,
      created_at AS createdAt, updated_at AS updatedAt
      FROM memories WHERE kind = 'preference' AND status = 'active' ORDER BY created_at, id`)
      .all() as Omit<DirectionRow, "revision" | "retired">[];
    if (rows.length) {
      const store = this.open();
      store.transaction(() => {
        for (const row of rows) {
          const next: DirectionRow = { ...row, revision: 1, retired: false };
          const previous = store.directions().find((entry) => entry.id === row.id);
          if (previous) {
            if (canonical(previous) !== canonical(next))
              throw new Error(
                "A standing direction conflicts with Knowledge. No original direction was removed.",
              );
          } else {
            store.saveDirection(
              next,
              "publish",
              "Carried from the active direction at notes retirement.",
            );
          }
        }
      });
    }
    db.transaction(() => db.exec("DROP TABLE memory_revisions; DROP TABLE memories;"))();
  }

  /** Full authoritative set, never shortened to a search or formatting budget. */
  standingDirections(actor: KnowledgeActor): KnowledgeDirectionRow[] {
    return this.open()
      .directions()
      .filter((row) => !row.retired && this.directionVisible(actor, row))
      .map((row) => this.directionRow(row));
  }

  private directionVisible(actor: KnowledgeActor, row: DirectionRow): boolean {
    // Global directions stay private to Firstmate. Crew receive their project's
    // directions, including when a brief is carried to another computer.
    return (
      actor.kind === "firstmate" ||
      (row.scope === actor.repoId && Boolean(this.deps.projects.get(actor.repoId)))
    );
  }

  private directionRow(row: DirectionRow): KnowledgeDirectionRow {
    return {
      id: row.id,
      kind: "direction",
      text: row.text,
      scope: row.scope,
      scopeName: this.directionScopeName(row.scope),
      origin: row.origin,
      authority: row.origin === "captain-turn" ? "instruction" : "advice",
      revision: row.revision,
      updatedAt: row.updatedAt,
    };
  }

  /** Whether the collection can be used, opening it the first time. */
  availability(): Availability {
    try {
      this.open();
      return { state: "ready" };
    } catch (error) {
      return {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Close the connection; the next call opens it again. */
  close(): void {
    this.store?.close();
    this.store = undefined;
    this.failure = undefined;
  }

  /**
   * Remove the whole collection (the alpha purge): every entry, revision,
   * piece of evidence and declared use, and the database's own sidecars.
   */
  purge(): void {
    this.close();
    if (this.deps.dir) rmSync(this.deps.dir, { recursive: true, force: true });
    this.deps.changed?.();
  }

  /**
   * Every actor reads the captain's factual collection. Project applicability
   * describes relevance, not access; directions use their separate exact scopes.
   */
  scopesFor(_actor: KnowledgeActor): string[] {
    return [PRIVATE_SCOPE];
  }

  scopeName(scope: string): string {
    if (scope === PRIVATE_SCOPE) return "private";
    return this.deps.projects.get(scope)?.name ?? scope;
  }

  // -- reads ---------------------------------------------------------------

  /** Lexical search over names, aliases and text, best first, within `scopes`. */
  search(
    actor: KnowledgeActor,
    input: { query: string; scope?: string; kind?: KnowledgeKind; offset?: number; limit?: number },
  ): { hits: EntrySummary[]; total: number } {
    const store = this.open();
    const scopes = this.readScopes(actor, input.scope);
    const query = input.query.slice(0, KNOWLEDGE_LIMITS.queryBytes);
    const terms = searchTerms(query);
    const exact = [...new Set(query.toLowerCase().match(ID_IN_TEXT) ?? [])].flatMap((id) => {
      const entry = store.entry(id);
      return entry &&
        scopes.includes(entry.scope) &&
        this.visible(actor, entry) &&
        (!input.kind || entry.kind === input.kind)
        ? [entry.id]
        : [];
    });
    const byUrl = this.articleHits(store, actor, query, scopes).filter(
      (id) => !exact.includes(id) && (!input.kind || store.entry(id)?.kind === input.kind),
    );
    if (terms.length === 0 && exact.length === 0 && byUrl.length === 0) {
      if (query.trim()) return { hits: [], total: 0 };
      refuse("Give a few words to search for: a name, an alias, or what the entry says.");
    }
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(input.limit ?? KNOWLEDGE_LIMITS.pageHits, KNOWLEDGE_LIMITS.pageHits);
    // Pages read past the best SEARCH_WINDOW matches find nothing more.
    const found =
      terms.length > 0
        ? store.search(scopes, matchOf(terms), input.kind, SEARCH_WINDOW, 0)
        : { hits: [], total: 0 };
    const matched = found.hits.map((hit) => hit.id);
    const ids = [
      ...exact,
      ...byUrl,
      ...matched.filter((id) => !exact.includes(id) && !byUrl.includes(id)),
    ].filter((id) => {
      const entry = store.entry(id);
      return entry !== undefined && this.visible(actor, entry);
    });
    return {
      hits: ids.slice(offset, offset + limit).flatMap((id) => {
        const entry = store.entry(id);
        return entry ? [this.summary(entry)] : [];
      }),
      total: ids.length,
    };
  }

  /** A whole entry: its revision, evidence and whether each source still reads the same. */
  get(actor: KnowledgeActor, id: string, revision?: number): EntryView {
    const store = this.open();
    const entry = this.readable(actor, id);
    const shown = store.revision(entry.id, revision ?? entry.revision);
    if (!shown)
      refuse(`${entry.id} has no revision ${revision}; its current one is ${entry.revision}.`);
    const relations = store.relations(entry.id).flatMap((relation): RelationView[] => {
      const outgoing = relation.fromId === entry.id;
      const other = this.named(outgoing ? relation.toId : relation.fromId);
      return other ? [{ ...relation, other, outgoing }] : [];
    });
    const assessments = store.assessments(entry.id).map((assessment) => ({
      ...assessment,
      sources: this.sourceViews(actor, assessment.sources),
      current: assessment.revision === entry.revision,
    }));
    const links =
      entry.kind === "concept"
        ? store
            .edgesTouching(entry.id)
            .filter((edge) => edge.layer === "context")
            .flatMap((edge) => {
              const outgoing = edge.fromId === entry.id;
              const other = this.named(outgoing ? edge.toId : edge.fromId);
              return other ? [{ other, reason: edge.label, outgoing }] : [];
            })
        : [];
    const uses = store.uses(entry.id, 1000);
    return {
      summary: this.summary(entry, shown),
      shown,
      author: entry.author,
      createdAt: entry.createdAt,
      ...(entry.kind === "concept" ? { explanation: (shown.body as ConceptBody).explanation } : {}),
      links,
      sources: this.sourceViews(actor, shown.body.sources),
      assessments,
      relations,
      uses: { count: uses.length, recent: uses.slice(0, 5) },
    };
  }

  /** One kept source, whole, when it belongs to a collection `actor` can read. */
  source(actor: KnowledgeActor, id: string): SourceView {
    const store = this.open();
    const [row] = store.sources([id]);
    if (!row || !this.scopesFor(actor).includes(row.scope)) {
      refuse(`No source ${id} in a collection you can read.`);
    }
    const [view] = this.sourceViews(actor, [id]);
    if (!view) refuse(`No source ${id} in a collection you can read.`);
    return view;
  }

  /** One hop from an entry: its links, the findings about it, its relationships and disagreements. */
  neighbors(
    actor: KnowledgeActor,
    input: { id: string; layer?: Neighbor["layer"]; offset?: number; limit?: number },
  ): { neighbors: Neighbor[]; total: number } {
    const store = this.open();
    const entry = this.readable(actor, input.id);
    const all: Neighbor[] = [];
    const add = (otherId: string, neighbor: Omit<Neighbor, "other">) => {
      const other = store.entry(otherId);
      if (!other || other.scope !== entry.scope) return;
      all.push({ ...neighbor, other: this.summary(other) });
    };
    for (const edge of store.edgesTouching(entry.id)) {
      const outgoing = edge.fromId === entry.id;
      const otherId = outgoing ? edge.toId : edge.fromId;
      if (edge.layer === "relationship") {
        add(otherId, { layer: "relationship", outgoing, label: edge.label, via: edge.via });
      } else {
        add(otherId, { layer: edge.layer, outgoing, label: edge.label });
      }
    }
    if (entry.kind === "finding") {
      for (const edge of store.edgesVia(entry.id)) {
        if (edge.layer !== "relationship") continue;
        // The claim's own endpoints are already its `about` neighbors.
        const known = all.find((item) => item.layer === "about" && item.other.id === edge.toId);
        if (known) known.label = `${edge.label} (object)`;
        const subject = all.find((item) => item.layer === "about" && item.other.id === edge.fromId);
        if (subject) subject.label = `${edge.label} (subject)`;
      }
    }
    for (const relation of store.relations(entry.id)) {
      const outgoing = relation.fromId === entry.id;
      add(outgoing ? relation.toId : relation.fromId, {
        layer: "history",
        outgoing,
        label: relation.type,
      });
    }
    const layers = ["relationship", "context", "about", "history"] as const;
    const chosen = all
      .filter((item) => !input.layer || item.layer === input.layer)
      .sort(
        (a, b) =>
          layers.indexOf(a.layer) - layers.indexOf(b.layer) ||
          Number(a.other.retired) - Number(b.other.retired) ||
          (a.other.id < b.other.id ? -1 : a.other.id > b.other.id ? 1 : 0),
      );
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(input.limit ?? KNOWLEDGE_LIMITS.pageHits, KNOWLEDGE_LIMITS.pageHits);
    return { neighbors: chosen.slice(offset, offset + limit), total: chosen.length };
  }

  /** Earlier revisions, newest first, from before `before`. */
  history(
    actor: KnowledgeActor,
    input: { id: string; before?: number; limit?: number },
  ): { entry: EntrySummary; revisions: RevisionRow[]; remaining: number } {
    const store = this.open();
    const entry = this.readable(actor, input.id);
    const before = Math.min(input.before ?? entry.revision + 1, entry.revision + 1);
    const limit = Math.min(input.limit ?? 20, 20);
    const revisions = store.revisions(entry.id, before, limit);
    const oldest = revisions.at(-1)?.revision ?? before;
    return { entry: this.summary(entry), revisions, remaining: Math.max(0, oldest - 1) };
  }

  /**
   * The few entries a turn or a brief is offered on its own (docs/knowledge.md,
   * "Knowledge first"): the best matches for `query` in `scopes`, as
   * candidates to read - never evidence, and never a declared use.
   */
  shortlist(scopes: readonly string[], query: string, actor?: KnowledgeActor): EntrySummary[] {
    const store = this.open();
    const terms = searchTerms(query.slice(0, KNOWLEDGE_LIMITS.queryBytes));
    if (terms.length === 0 || scopes.length === 0) return [];
    const { hits } = store.search(scopes, matchOf(terms), undefined, SEARCH_WINDOW, 0);
    const visible = hits.flatMap((hit) => {
      const entry = store.entry(hit.id);
      if (!entry || (actor && !this.visible(actor, entry))) return [];
      return [this.summary(entry)];
    });
    return visible.slice(0, KNOWLEDGE_LIMITS.shortlistHits);
  }

  /** How many active entries the collections hold. */
  count(scopes: readonly string[]): number {
    return this.open().countActive(scopes);
  }

  // -- the browser's reads -------------------------------------------------
  //
  // What the captain's window reads (docs/knowledge.md, "The browser"): the
  // collections Firstmate reads - the private one and every registered
  // project's - bounded for a window and read only. A collection this build
  // cannot read answers `unavailable` in the app's words; a scope the window
  // cannot read is refused as one that does not exist.

  /**
   * Whether there is knowledge for the captain's window to show: an entry in
   * a collection it reads, or a collection that cannot be read, which says
   * so. The Knowledge panel exists only while this holds.
   */
  held(): boolean {
    if (this.unopened()) return false;
    try {
      return (
        this.open().countActive(this.scopesFor(WINDOW)) > 0 ||
        this.open()
          .directions()
          .some((row) => !row.retired)
      );
    } catch {
      return true;
    }
  }

  /**
   * Nothing has been recorded since the collection last began - no database
   * file yet, or the purge took it - and nothing has opened it: a browser
   * read answers empty rather than create the file, which the first write
   * does.
   */
  private unopened(): boolean {
    return (
      !this.store &&
      !this.failure &&
      this.deps.dir !== undefined &&
      !existsSync(join(this.deps.dir, KNOWLEDGE_DB_FILE))
    );
  }

  /** Each collection, private first then each project's by name, with its entries counted. */
  collections(): KnowledgeCollections {
    return this.browsing((store) => {
      const scopes = this.scopesFor(WINDOW);
      const counts = store ? store.countsByKind(scopes) : [];
      const directions = store?.directions().filter((row) => !row.retired) ?? [];
      const count = (scope: string, kind: KnowledgeKind) =>
        counts.find((row) => row.scope === scope && row.kind === kind)?.n ?? 0;
      const projects = this.deps.projects
        .list()
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
      return {
        state: "ready",
        collections: [
          { scope: PRIVATE_SCOPE, name: "", private: true },
          ...projects.map((project) => ({ scope: project.id, name: project.name, private: false })),
        ].map((collection) => ({
          ...collection,
          concepts: count(collection.scope, "concept"),
          findings: count(collection.scope, "finding"),
          directions: directions.filter((row) => row.scope === collection.scope).length,
        })),
      };
    });
  }

  /**
   * One collection's concepts and the connections among them, bounded: its
   * most connected, the neighborhood of `focus`, or what `query` finds.
   */
  graph(args: KnowledgeGraphArgs): KnowledgeGraph {
    return this.browsing((store) => {
      const scope = this.browseScope(args.scope);
      if (!store || scope !== PRIVATE_SCOPE) {
        const none = { concepts: 0, connections: 0 };
        return {
          state: "ready",
          scope,
          focus: null,
          concepts: [],
          connections: [],
          shown: none,
          total: none,
        };
      }
      const checks = new Map<string, SourceCheck>();
      const findings = new Map(
        store.currentOf(scope, "finding").map(({ entry, body }) => [entry.id, { entry, body }]),
      );
      const concepts = store.currentOf(scope, "concept");
      const conceptIds = new Set(concepts.map(({ entry }) => entry.id));
      const connections: KnowledgeConnection[] = [];
      const about = new Map<string, Set<string>>();
      for (const edge of store.edgesIn(scope)) {
        if (edge.layer === "about") {
          if (!conceptIds.has(edge.toId)) continue;
          const set = about.get(edge.toId) ?? new Set<string>();
          set.add(edge.via);
          about.set(edge.toId, set);
          continue;
        }
        if (!conceptIds.has(edge.fromId) || !conceptIds.has(edge.toId)) continue;
        if (edge.layer === "context") {
          connections.push({
            kind: "context",
            id: `context:${edge.fromId}:${edge.toId}`,
            from: edge.fromId,
            to: edge.toId,
            reason: edge.label,
          });
          continue;
        }
        const finding = findings.get(edge.via);
        if (!finding) continue;
        connections.push({
          kind: "claim",
          id: `claim:${edge.via}`,
          from: edge.fromId,
          to: edge.toId,
          predicate: edge.label,
          finding: edge.via,
          standing: this.standing(store, finding.entry, finding.body as FindingBody, checks)
            .standing,
        });
      }
      const degree = degreesOf(connections);
      const nodes: KnowledgeGraphConcept[] = concepts.map(({ entry, body }) => {
        const concept = body as ConceptBody;
        return {
          id: entry.id,
          title: concept.title,
          aliases: concept.aliases,
          findings: about.get(entry.id)?.size ?? 0,
          degree: degree.get(entry.id) ?? 0,
        };
      });
      const focus = args.focus && conceptIds.has(args.focus) ? args.focus : null;
      const found = this.conceptsFound(store, scope, args.query);
      const within = found
        ? new Map([...found].map((id) => [id, 0]))
        : focus
          ? neighborhoodOf(focus, connections, args.hops ?? 1)
          : undefined;
      const chosen = chooseGraph(nodes, connections, within);
      return { state: "ready", scope, focus, ...chosen };
    });
  }

  /** A page of one collection's concepts, by name, or as typed words rank them. */
  concepts(args: KnowledgeConceptsArgs): KnowledgeConcepts {
    return this.browsing((store) => {
      const scope = this.browseScope(args.scope);
      if (!store || scope !== PRIVATE_SCOPE)
        return { state: "ready", scope, rows: [], total: 0, page: 0 };
      const all = store.currentOf(scope, "concept");
      const ranked = this.ranked(store, scope, "concept", args.query);
      const ordered = ranked
        ? ranked.flatMap((id) => all.filter(({ entry }) => entry.id === id))
        : all
            .slice()
            .sort((a, b) =>
              (a.body as ConceptBody).title.localeCompare((b.body as ConceptBody).title),
            );
      const findingsOf = new Map<string, Set<string>>();
      for (const edge of store.edgesIn(scope)) {
        if (edge.layer !== "about") continue;
        const set = findingsOf.get(edge.toId) ?? new Set<string>();
        set.add(edge.via);
        findingsOf.set(edge.toId, set);
      }
      const { rows, page } = pageOf(ordered, args.page);
      return {
        state: "ready",
        scope,
        rows: rows.map(({ entry, body }) => {
          const concept = body as ConceptBody;
          return {
            id: entry.id,
            title: concept.title,
            aliases: concept.aliases,
            explanation: concept.explanation,
            findings: findingsOf.get(entry.id)?.size ?? 0,
          };
        }),
        total: ordered.length,
        page,
      };
    });
  }

  /**
   * A page of one collection's findings, newest first or as typed words rank
   * them, each with where it stands: filtered to those whose sources changed
   * (`recheck`) or whose evidence differs (`differing`).
   */
  findings(args: KnowledgeFindingsArgs): KnowledgeFindings {
    return this.browsing((store) => {
      const scope = this.browseScope(args.scope);
      if (!store || scope !== PRIVATE_SCOPE)
        return { state: "ready", scope, rows: [], total: 0, page: 0 };
      const all = store.currentOf(scope, "finding");
      const ranked = this.ranked(store, scope, "finding", args.query);
      const ordered = ranked
        ? ranked.flatMap((id) => all.filter(({ entry }) => entry.id === id))
        : all;
      const checks = new Map<string, SourceCheck>();
      const row = ({ entry, body }: { entry: EntryRow; body: EntryBody }): KnowledgeFindingRow => {
        const finding = body as FindingBody;
        const { standing, attention, status } = this.standing(store, entry, finding, checks);
        const summary = this.summary(entry);
        return {
          id: entry.id,
          statement: finding.statement,
          basis: finding.basis,
          conditions: finding.conditions,
          about: summary.about,
          relationship: summary.relationship ?? null,
          standing,
          attention,
          sources: finding.sources.length,
          checks: status.checks.length,
        };
      };
      const filter = args.filter ?? "all";
      if (filter === "all") {
        const { rows, page } = pageOf(ordered, args.page);
        return { state: "ready", scope, rows: rows.map(row), total: ordered.length, page };
      }
      const kept = ordered.map(row).filter((item) => item.attention[filter]);
      const { rows, page } = pageOf(kept, args.page);
      return { state: "ready", scope, rows, total: kept.length, page };
    });
  }

  /** A paged browser view of the authoritative directions. */
  directions(args: KnowledgeDirectionsArgs): KnowledgeDirections {
    return this.browsing((store) => {
      const scope = args.scope === "all" ? "all" : this.directionScope(args.scope);
      const query = args.query?.trim().toLocaleLowerCase() ?? "";
      const all = (store?.directions() ?? [])
        .filter((row) => !row.retired)
        .filter((row) => row.scope === PRIVATE_SCOPE || Boolean(this.deps.projects.get(row.scope)))
        .filter((row) => scope === "all" || row.scope === scope)
        .filter((row) => !query || row.text.toLocaleLowerCase().includes(query))
        .sort(
          (a, b) =>
            Number(b.origin === "captain-turn") - Number(a.origin === "captain-turn") ||
            b.updatedAt - a.updatedAt ||
            a.id.localeCompare(b.id),
        );
      const { rows, page } = pageOf(all, args.page);
      return {
        state: "ready",
        scope,
        page,
        total: all.length,
        rows: rows.map((row) => this.directionRow(row)),
      };
    });
  }

  direction(args: KnowledgeDirectionArgs, actor: KnowledgeActor = WINDOW): KnowledgeDirectionRead {
    return this.browsing((store): KnowledgeDirectionRead => {
      const row = store?.directions().find((entry) => entry.id === args.id);
      if (
        !store ||
        !row ||
        (row.scope !== PRIVATE_SCOPE && !this.deps.projects.get(row.scope)) ||
        !this.directionVisible(actor, row)
      )
        return { state: "missing" };
      const history = store.directionHistory(row.id);
      const { rows, page } = pageOf(history, args.page);
      return {
        state: "ready",
        direction: {
          ...this.directionRow(row),
          retired: row.retired,
          createdAt: row.createdAt,
          history: rows,
          page,
          total: history.length,
        },
      };
    });
  }

  private directionScope(scope: string): string {
    if (scope !== PRIVATE_SCOPE && !this.deps.projects.get(scope))
      refuse("This project is not available.");
    return scope;
  }

  private directionScopeName(scope: string): string {
    return scope === PRIVATE_SCOPE ? "Everywhere" : (this.deps.projects.get(scope)?.name ?? scope);
  }

  /** One concept or finding whole, at its current revision or an earlier one. */
  entry(args: KnowledgeEntryArgs): KnowledgeEntryRead {
    return this.browsing((store): KnowledgeEntryRead => {
      const entry = store?.entry(args.id);
      if (!store || !entry || !this.scopesFor(WINDOW).includes(entry.scope)) {
        return { state: "missing" };
      }
      const shown = store.revision(entry.id, args.revision ?? entry.revision);
      if (!shown) return { state: "missing" };
      const checks = new Map<string, SourceCheck>();
      const summary = this.summary(entry, shown);
      const sources = (ids: readonly string[]) => this.browseSources(ids, checks);
      const isFinding = entry.kind === "finding";
      const finding = isFinding ? (shown.body as FindingBody) : undefined;
      const concept = isFinding ? undefined : (shown.body as ConceptBody);
      const where = isFinding
        ? this.standing(
            store,
            entry,
            store.revision(entry.id, entry.revision)?.body as FindingBody,
            checks,
          )
        : undefined;
      const history = store.revisions(entry.id, entry.revision + 1, 20);
      const uses = store.uses(entry.id, 1000);
      const read: KnowledgeEntry = {
        id: entry.id,
        scope: entry.scope,
        kind: entry.kind,
        revision: shown.revision,
        current: entry.revision,
        retired: entry.lifecycle === "retired",
        title: summary.title,
        aliases: concept?.aliases ?? [],
        explanation: concept?.explanation ?? "",
        basis: finding?.basis ?? null,
        conditions: finding?.conditions ?? "",
        about: summary.about,
        relationship: summary.relationship ?? null,
        standing: where?.standing ?? null,
        attention: where?.attention ?? null,
        author: this.byOf(entry.author),
        createdAt: entry.createdAt,
        at: shown.at,
        connections: concept ? this.conceptConnections(store, entry, checks) : [],
        ...(concept
          ? this.conceptFindings(store, entry, checks)
          : { findings: [], findingsTotal: 0 }),
        sources: sources(shown.body.sources),
        checks: store.assessments(entry.id).map((assessment) => ({
          id: assessment.id,
          revision: assessment.revision,
          verdict: assessment.verdict,
          method: assessment.method,
          conditions: assessment.conditions,
          by: this.byOf(assessment.actor),
          at: assessment.at,
          sources: sources(assessment.sources),
        })),
        revisions: history.map((revision) => ({
          revision: revision.revision,
          op: revision.op,
          by: this.byOf(revision.actor),
          reason: revision.reason,
          at: revision.at,
          title: titleOf(entry.kind, revision.body),
        })),
        olderRevisions: Math.max(0, (history.at(-1)?.revision ?? 1) - 1),
        relations: store.relations(entry.id).flatMap((relation) => {
          const outgoing = relation.fromId === entry.id;
          const other = this.named(outgoing ? relation.toId : relation.fromId);
          return other
            ? [
                {
                  type: relation.type,
                  reason: relation.reason,
                  other,
                  outgoing,
                  by: this.byOf(relation.actor),
                  at: relation.at,
                },
              ]
            : [];
        }),
        uses: {
          count: uses.length,
          recent: uses.slice(0, 20).map((use) => ({
            revision: use.revision,
            by: this.byOf(use.actor),
            task: use.taskId ? (this.deps.tasks?.resolve(use.taskId)?.key ?? null) : null,
            purpose: use.purpose,
            at: use.at,
          })),
        },
      };
      return { state: "ready", entry: read };
    });
  }

  /**
   * The entries a card body names, as its references show them (docs/
   * knowledge.md, "References in an answer"): those a collection the window
   * reads holds, in the order asked, each with where it stands now. Reading
   * them records no use and checks nothing.
   */
  refs(args: KnowledgeRefsArgs): KnowledgeRefs {
    return this.browsing((store): KnowledgeRefs => {
      if (!store) return { state: "ready", refs: [] };
      const scopes = this.scopesFor(WINDOW);
      const checks = new Map<string, SourceCheck>();
      const refs = [...new Set(args.ids)].flatMap((id): KnowledgeRef[] => {
        const entry = store.entry(id);
        if (!entry || !scopes.includes(entry.scope)) return [];
        const current = store.revision(entry.id, entry.revision);
        if (!current) return [];
        return [
          {
            id: entry.id,
            kind: entry.kind,
            scope: entry.scope,
            title: titleOf(entry.kind, current.body),
            revision: entry.revision,
            retired: entry.lifecycle === "retired",
            standing:
              entry.kind === "finding"
                ? this.standing(store, entry, current.body as FindingBody, checks).standing
                : null,
          },
        ];
      });
      return { state: "ready", refs };
    });
  }

  /**
   * What one task's work declared it relied on (docs/knowledge.md, "Knowledge
   * used on a task"), newest first, each entry and revision once: the revision
   * it used as that revision said it, beside the current one. Only entries in
   * a collection the window reads; reading it changes nothing.
   */
  taskUses(args: KnowledgeUsesArgs): KnowledgeUses {
    return this.browsing((store): KnowledgeUses => {
      if (!store) return { state: "ready", uses: [], total: 0 };
      const scopes = this.scopesFor(WINDOW);
      const checks = new Map<string, SourceCheck>();
      const seen = new Set<string>();
      const uses: KnowledgeTaskUse[] = [];
      for (const use of store.usesOfTask(args.task, 1000)) {
        const key = `${use.entryId}@${use.revision}`;
        if (seen.has(key)) continue;
        const entry = store.entry(use.entryId);
        const used = entry && store.revision(entry.id, use.revision);
        const current = entry && store.revision(entry.id, entry.revision);
        if (!entry || !used || !current || !scopes.includes(entry.scope)) continue;
        seen.add(key);
        uses.push({
          id: entry.id,
          kind: entry.kind,
          scope: entry.scope,
          revision: use.revision,
          title: titleOf(entry.kind, used.body),
          current: entry.revision,
          currentTitle: titleOf(entry.kind, current.body),
          retired: entry.lifecycle === "retired",
          standing:
            entry.kind === "finding"
              ? this.standing(store, entry, current.body as FindingBody, checks).standing
              : null,
          purpose: use.purpose,
          at: use.at,
        });
      }
      return { state: "ready", uses: uses.slice(0, KNOWLEDGE_TASK_USES), total: uses.length };
    });
  }

  // -- writes --------------------------------------------------------------

  /**
   * One change to a standing direction, the app action catalog's `direction`
   * line (`inf:knowledge:direction:set`): the captain's window and the first
   * mate's app_change ask it alike, through the dispatcher's one path, which
   * checks who may and writes the feed line (INF-638, the captain: "why not
   * just give first mate a tool to freely read and write standing
   * directions, and then rely on the agent's judgment on when/how to do
   * it?"). Every direction is his instruction, and its history keeps the
   * reason. A refusal throws, as every catalog change's does.
   */
  changeDirection(change: KnowledgeDirectionChange): KnowledgeDirectionChanged {
    const store = this.open();
    const id = change.id?.replace(/^d:/, "") ?? this.newId("d");
    const previous = store.directions().find((row) => row.id === id);
    if (change.op === "add" && previous)
      refuse("This direction already exists; revise it instead.");
    if (change.op !== "add" && !previous) refuse(`No direction d:${id} exists.`);
    if (
      previous &&
      change.op !== "add" &&
      change.expectedRevision !== undefined &&
      change.expectedRevision !== previous.revision
    )
      refuse(`d:${id} is at revision ${previous.revision} now; read it again before changing it.`);
    const scope =
      change.op === "add"
        ? this.directionScope(change.scope ?? PRIVATE_SCOPE)
        : (previous?.scope ?? PRIVATE_SCOPE);
    const text =
      change.op === "retire"
        ? (previous?.text ?? "")
        : clean(change.text, "text", MAX.explanation, true);
    const reason = clean(change.reason, "reason", MAX.reason, true);
    const at = this.now();
    const next: DirectionRow = {
      id,
      scope,
      text,
      origin: "captain-turn",
      revision: (previous?.revision ?? 0) + 1,
      retired: change.op === "retire",
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    };
    store.transaction(() => {
      const current = store.directions().find((row) => row.id === id);
      if (current?.revision !== previous?.revision)
        refuse("The direction changed. Read it again before writing.");
      store.saveDirection(next, change.op === "add" ? "publish" : change.op, reason);
    });
    this.deps.changed?.();
    return { op: change.op, direction: this.directionRow(next) };
  }

  /**
   * One write, all or nothing. A refusal is the answer's words, never a
   * throw: the caller hands it back to the model as guidance.
   */
  async record(actor: KnowledgeActor, input: RecordInput): Promise<RecordOutcome> {
    let store: KnowledgeStore;
    try {
      store = this.open();
    } catch (error) {
      return {
        text: `Knowledge is unavailable: ${error instanceof Error ? error.message : String(error)} Nothing was recorded.`,
        committed: false,
        ids: [],
      };
    }
    const who = actorId(actor);
    try {
      const requestId = clean(input.requestId, "request_id", MAX.requestId, true);
      const { requestId: _omit, ...call } = input;
      if (bytes(JSON.stringify(call)) > KNOWLEDGE_LIMITS.writeBytes) {
        refuse(`One write carries at most ${KNOWLEDGE_LIMITS.writeBytes / 1024} KB; split it up.`);
      }
      const digest = sha256(canonical(call));
      const replay = this.replay(store, who, requestId, digest);
      if (replay) return replay;
      const write = await this.prepare(store, actor, input);
      const outcome = store.transaction((): RecordOutcome => {
        // A concurrent retry may have finished first.
        const again = this.replay(store, who, requestId, digest);
        if (again) return again;
        const done = write();
        store.saveRequest(who, requestId, digest, JSON.stringify(done), this.now());
        return { ...done, committed: true };
      });
      if (outcome.committed) {
        this.deps.changed?.();
        if (input.action === "retire_many") {
          this.deps.announce?.(
            `First mate · retired ${outcome.ids.length} knowledge ${outcome.ids.length === 1 ? "entry" : "entries"} the captain approved${input.task ? ` (${input.task.trim()})` : ""}`,
          );
        }
      }
      return outcome;
    } catch (error) {
      if (error instanceof KnowledgeRefusal)
        return { text: error.message, committed: false, ids: [] };
      throw error;
    }
  }

  private replay(
    store: KnowledgeStore,
    who: string,
    requestId: string,
    digest: string,
  ): RecordOutcome | undefined {
    const earlier = store.request(who, requestId);
    if (!earlier) return undefined;
    if (earlier.digest !== digest) {
      refuse(
        `request_id ${requestId} was already used for a different write; use a new request_id for a new write.`,
      );
    }
    const done = JSON.parse(earlier.result) as { text: string; ids: string[] };
    return {
      text: `Already done (same request_id): ${done.text}`,
      committed: false,
      ids: done.ids,
    };
  }

  /** Check a write and capture its evidence; the returned step writes it. */
  private async prepare(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<() => { text: string; ids: string[] }> {
    // A direction changes through the app action catalog (`changeDirection`).
    if (input.kind === "direction" || input.id?.startsWith("d:"))
      refuse(
        actor.kind === "firstmate"
          ? "Change a standing direction with app_change direction."
          : "Directions are the first mate's to keep: report the captain's words or choice with needs_firstmate.",
      );
    if (input.action !== "use") this.assertRecorder(actor);
    switch (input.action) {
      case "publish":
        return this.preparePublish(store, actor, input);
      case "revise":
        return this.prepareRevise(store, actor, input);
      case "assess":
        return this.prepareAssess(store, actor, input);
      case "relate":
        return this.prepareRelate(store, actor, input);
      case "retire":
        return this.prepareRetire(store, actor, input);
      case "retire_many":
        return this.prepareRetireMany(store, actor, input);
      case "use":
        return this.prepareUse(store, actor, input);
      default:
        refuse("action must be publish, revise, assess, relate, retire, retire_many or use.");
    }
  }

  private async preparePublish(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<() => { text: string; ids: string[] }> {
    const scope = this.writeScope(actor, input.scope);
    const lane = input.lane ?? this.laneOf(actor);
    if (actor.kind === "firstmate" && lane !== "personal")
      refuse("An import or reconciliation is a crewmate's write.");
    if (actor.kind === "firstmate" && input.sources?.some((source) => source.kind === "article")) {
      refuse(
        "An article import is a crewmate's write. Ask a crewmate to save it, and do not extract the article yourself.",
      );
    }
    if (lane === "personal" && input.sources?.some((source) => source.kind === "article"))
      refuse("An article is a saved reference, not personal context.");
    const kind = input.kind;
    if (kind !== "concept" && kind !== "finding") refuse("publish needs kind: concept or finding.");
    const sources = await this.capture(actor, scope, input.sources);
    const body =
      kind === "concept"
        ? this.conceptBody(
            store,
            actor,
            scope,
            undefined,
            input,
            sources.map((s) => s.id),
          )
        : this.findingBody(
            store,
            actor,
            scope,
            undefined,
            input,
            sources.map((s) => s.id),
          );
    if (kind === "concept") {
      this.refuseDuplicateTitle(store, scope, (body as ConceptBody).title);
      this.refuseDuplicateArticle(store, scope, sources);
      this.stampArticle(body as ConceptBody, sources);
    }
    if (kind === "finding") this.requireSavedArticle(store, scope, sources);
    if (
      kind === "finding" &&
      (body as FindingBody).basis === "observation" &&
      body.sources.length === 0
    ) {
      refuse(
        "An observation cites its evidence: pass sources (a task's report, a quotation, or a short article excerpt).",
      );
    }
    return () => {
      let id = this.newId(kind === "concept" ? "c" : "f");
      while (store.entry(id)) id = this.newId(kind === "concept" ? "c" : "f");
      const at = this.now();
      for (const source of sources) store.insertSource(source);
      const entry: EntryRow = {
        id,
        scope,
        kind,
        revision: 1,
        lifecycle: "active",
        author: actorId(actor),
        createdAt: at,
        updatedAt: at,
        lane,
      };
      store.insertEntry(entry);
      if (kind === "concept") this.rememberArticles(store, scope, id, sources);
      this.writeRevision(store, entry, "publish", body, actor, "", at);
      const what =
        kind === "concept" ? `concept ${id} "${(body as ConceptBody).title}"` : `finding ${id}`;
      return {
        text: `Recorded ${what} (revision 1) in ${this.scopeName(scope)}.${this.evidenceLine(sources)}${
          kind === "finding"
            ? " It reads as not yet checked until someone assesses it with a method and evidence."
            : ""
        }`,
        ids: [id],
      };
    };
  }

  private async prepareRevise(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<() => { text: string; ids: string[] }> {
    const entry = this.writable(actor, input.id);
    if (entry.lifecycle === "retired")
      refuse(`${entry.id} is retired; publish a new entry instead.`);
    if (entry.kind === "finding" && entry.author !== actorId(actor)) {
      refuse(
        `${entry.id} is another author's finding: assess it, or publish your own and relate it (supersedes or contradicts). Its evidence stays as recorded.`,
      );
    }
    const expected = this.expectedRevision(entry, input.expectedRevision);
    const current = store.revision(entry.id, entry.revision);
    if (!current) refuse(`${entry.id} cannot be read just now.`);
    this.assertNotReferenceReconciliation(actor, entry);
    const sources = await this.capture(actor, entry.scope, input.sources);
    const ids = [...current.body.sources, ...sources.map((s) => s.id)];
    if (ids.length > MAX.sources * 2) refuse(`An entry keeps at most ${MAX.sources * 2} sources.`);
    const body =
      entry.kind === "concept"
        ? this.conceptBody(
            store,
            actor,
            entry.scope,
            current.body as ConceptBody,
            input,
            ids,
            entry.id,
          )
        : this.findingBody(store, actor, entry.scope, current.body as FindingBody, input, ids);
    if (entry.kind === "concept") {
      this.refuseDuplicateTitle(store, entry.scope, (body as ConceptBody).title, entry.id);
      this.refuseDuplicateArticle(store, entry.scope, sources, entry.id);
      this.stampArticle(body as ConceptBody, sources);
    } else {
      this.requireSavedArticle(store, entry.scope, sources);
    }
    const reason = clean(input.reason, "reason", MAX.reason, false);
    return () => {
      const fresh = store.entry(entry.id);
      if (!fresh || fresh.revision !== expected) {
        refuse(
          `${entry.id} moved to revision ${fresh?.revision}; read it again and revise from there.`,
        );
      }
      const at = this.now();
      for (const source of sources) store.insertSource(source);
      if (entry.kind === "concept") this.rememberArticles(store, entry.scope, entry.id, sources);
      const next = { ...fresh, revision: fresh.revision + 1, updatedAt: at };
      this.writeRevision(store, next, "revise", body, actor, reason, at);
      return {
        text: `Revised ${entry.id} to revision ${next.revision}.${this.evidenceLine(sources)}${
          entry.kind === "finding" ? " Checks of earlier revisions do not carry over." : ""
        }`,
        ids: [entry.id],
      };
    };
  }

  private async prepareAssess(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<() => { text: string; ids: string[] }> {
    const entry = this.writable(actor, input.id);
    this.assertNotReferenceReconciliation(actor, entry);
    if (entry.kind !== "finding") refuse("assess takes a finding; revise a concept instead.");
    if (entry.lifecycle === "retired") refuse(`${entry.id} is retired.`);
    const revision = input.revision ?? entry.revision;
    if (!store.revision(entry.id, revision)) refuse(`${entry.id} has no revision ${revision}.`);
    const verdict = input.verdict;
    if (verdict !== "supports" && verdict !== "contradicts" && verdict !== "inconclusive") {
      refuse("assess needs verdict: supports, contradicts or inconclusive.");
    }
    const method = clean(input.method, "method", MAX.method, true);
    const conditions = clean(input.conditions, "conditions", MAX.conditions, true);
    const sources = await this.capture(actor, entry.scope, input.sources);
    return () => {
      const at = this.now();
      for (const source of sources) store.insertSource(source);
      const id = this.newId("a");
      store.insertAssessment({
        id,
        entryId: entry.id,
        revision,
        verdict,
        method,
        conditions,
        sources: sources.map((source) => source.id),
        actor: actorId(actor),
        at,
      });
      const unbacked =
        sources.length === 0 && verdict !== "inconclusive"
          ? " It cites no evidence, so it is shown but checks nothing."
          : "";
      return {
        text: `Assessed ${entry.id} revision ${revision}: ${verdict}.${this.evidenceLine(sources)}${unbacked}`,
        ids: [entry.id],
      };
    };
  }

  private async prepareRelate(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<() => { text: string; ids: string[] }> {
    const from = this.writable(actor, input.from);
    const to = this.writable(actor, input.to);
    this.assertNotReferenceReconciliation(actor, from);
    this.assertNotReferenceReconciliation(actor, to);
    if (from.id === to.id) refuse("An entry cannot relate to itself.");
    if (from.scope !== to.scope) refuse("Both entries must be in the same collection.");
    const reason = clean(input.reason, "reason", MAX.reason, true);
    const type = input.type;
    if (type === "related") {
      if (from.kind !== "concept" || to.kind !== "concept") {
        refuse(
          "related links two concepts; between findings use contradicts, supersedes or duplicates.",
        );
      }
      if (from.lifecycle === "retired" || to.lifecycle === "retired")
        refuse("Both concepts must be active.");
      return () => {
        const fresh = store.entry(from.id);
        const current = fresh && store.revision(fresh.id, fresh.revision);
        if (!fresh || !current) refuse(`${from.id} cannot be read just now.`);
        const body = current.body as ConceptBody;
        if (body.links.some((link) => link.to === to.id)) {
          refuse(`${from.id} already links to ${to.id}; revise it to change the reason.`);
        }
        if (body.links.length >= MAX.links) refuse(`A concept keeps at most ${MAX.links} links.`);
        const at = this.now();
        const next = { ...fresh, revision: fresh.revision + 1, updatedAt: at };
        this.writeRevision(
          store,
          next,
          "link",
          { ...body, links: [...body.links, { to: to.id, reason }] },
          actor,
          reason,
          at,
        );
        return {
          text: `Linked ${from.id} and ${to.id} to read together (${from.id} revision ${next.revision}).`,
          ids: [from.id, to.id],
        };
      };
    }
    if (type !== "contradicts" && type !== "supersedes" && type !== "duplicates") {
      refuse(
        "relate needs type: related (concepts), or contradicts, supersedes or duplicates (findings).",
      );
    }
    if (from.kind !== "finding" || to.kind !== "finding") {
      refuse(`${type} relates two findings; link concepts with related.`);
    }
    if (from.lifecycle === "retired") refuse(`${from.id} is retired.`);
    return () => {
      const at = this.now();
      store.insertRelation({
        fromId: from.id,
        fromRevision: from.revision,
        toId: to.id,
        toRevision: to.revision,
        type,
        reason,
        actor: actorId(actor),
        at,
      });
      return {
        text: `Recorded that ${from.id} (revision ${from.revision}) ${type} ${to.id} (revision ${to.revision}). Both stay readable with their evidence.`,
        ids: [from.id, to.id],
      };
    };
  }

  private async prepareRetire(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<() => { text: string; ids: string[] }> {
    const entry = this.writable(actor, input.id);
    if (entry.lifecycle === "retired") refuse(`${entry.id} is already retired.`);
    if (actor.kind === "crewmate") {
      refuse(
        "Removing an entry waits for the captain. The first mate retires it on the captain's word.",
      );
    }
    const captainAsked = actor.kind === "firstmate" && actor.origin === "captain-turn";
    if (entry.author !== actorId(actor) && !captainAsked) {
      refuse(
        `${entry.id} is not yours to retire: its author can, or the first mate on the captain's word. Relate or assess it instead.`,
      );
    }
    const expected = this.expectedRevision(entry, input.expectedRevision);
    const reason = clean(input.reason, "reason", MAX.reason, true);
    return () => {
      const fresh = store.entry(entry.id);
      const current = fresh && store.revision(fresh.id, fresh.revision);
      if (!fresh || !current || fresh.revision !== expected) {
        refuse(`${entry.id} moved to revision ${fresh?.revision}; read it again first.`);
      }
      const at = this.now();
      const next = {
        ...fresh,
        revision: fresh.revision + 1,
        lifecycle: "retired" as const,
        updatedAt: at,
      };
      this.writeRevision(store, next, "retire", current.body, actor, reason, at);
      return {
        text: `Retired ${entry.id} at revision ${next.revision}. Its history and evidence stay readable.`,
        ids: [entry.id],
      };
    };
  }

  /**
   * Retire a captain-approved list in one write. The approval is the task's
   * closing choice: its card names the entries, and Firstmate judges that the
   * choice he clicked approved removing them (the host reads no words). Each
   * entry keeps its history, exactly as a single retire does.
   */
  private async prepareRetireMany(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<() => { text: string; ids: string[] }> {
    if (actor.kind !== "firstmate" || actor.origin !== "captain-turn") {
      refuse(
        "Removing entries waits for the captain. The first mate retires them on the captain's word.",
      );
    }
    const ref = clean(input.task, "task", MAX.reason, true);
    const approval = this.deps.approvals?.of(ref);
    if (!approval) {
      refuse(
        `${ref} has no card the captain resolved with a choice, so there is no approval to stand on. Retire one entry at a time, or ask them first.`,
      );
    }
    if (approval.action === "close") {
      refuse(
        `The captain dismissed ${approval.key}'s card without choosing; a dismissal approves nothing.`,
      );
    }
    const named = new Set(approval.body.match(/\b[cf]-[a-z0-9]{6}\b/g) ?? []);
    const unique = (ids: string[] | undefined) => [
      ...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)),
    ];
    const asked = input.ids === undefined ? undefined : unique(input.ids);
    const strangers = (asked ?? []).filter((id) => !named.has(id));
    if (strangers.length > 0) {
      refuse(
        `${strangers.join(", ")} ${strangers.length === 1 ? "is" : "are"} not named on the card ${approval.key} showed; the approval covers only what it listed.`,
      );
    }
    const kept = new Set(unique(input.except));
    const reason = clean(input.reason, "reason", MAX.reason, true);
    const targets: EntryRow[] = [];
    const skipped: string[] = [];
    for (const id of asked ?? [...named]) {
      if (kept.has(id)) continue;
      let entry: EntryRow;
      try {
        entry = this.writable(actor, id);
      } catch (error) {
        if (!(error instanceof KnowledgeRefusal)) throw error;
        skipped.push(`${id} (not readable)`);
        continue;
      }
      if (entry.lifecycle === "retired") {
        skipped.push(`${id} (already retired)`);
        continue;
      }
      targets.push(entry);
    }
    if (targets.length === 0) {
      refuse(`Nothing to retire: every entry that card names is retired already or kept.`);
    }
    return () => {
      const at = this.now();
      const done: string[] = [];
      for (const entry of targets) {
        const fresh = store.entry(entry.id);
        const current = fresh && store.revision(fresh.id, fresh.revision);
        if (!fresh || !current || fresh.lifecycle === "retired") continue;
        const next = {
          ...fresh,
          revision: fresh.revision + 1,
          lifecycle: "retired" as const,
          updatedAt: at,
        };
        this.writeRevision(
          store,
          next,
          "retire",
          current.body,
          actor,
          `${reason} (approved on ${approval.key})`.slice(0, MAX.reason),
          at,
        );
        done.push(entry.id);
      }
      return {
        text: `Retired ${done.length} entries approved on ${approval.key}: ${done.join(", ")}. Their history and evidence stay readable.${
          skipped.length > 0 ? ` Left alone: ${skipped.join(", ")}.` : ""
        }`,
        ids: done,
      };
    };
  }

  private async prepareUse(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<() => { text: string; ids: string[] }> {
    const entry = this.readable(actor, input.id);
    const revision = input.revision ?? entry.revision;
    const shown = store.revision(entry.id, revision);
    if (!shown) refuse(`${entry.id} has no revision ${revision}.`);
    const purpose = clean(input.purpose, "purpose", MAX.purpose, true);
    const checks = this.sourceViews(actor, shown.body.sources);
    return () => {
      const at = this.now();
      store.insertUse({
        entryId: entry.id,
        revision,
        actor: actorId(actor),
        taskId: actor.kind === "crewmate" ? actor.taskId : null,
        purpose,
        observed: {
          current: entry.revision,
          lifecycle: entry.lifecycle,
          sources: Object.fromEntries(checks.map((source) => [source.id, source.check.state])),
        },
        at,
      });
      const changed = checks.filter(
        (source) => source.check.state === "changed" || source.check.state === "missing",
      );
      return {
        text: `Recorded that your work relied on ${entry.id} revision ${revision}.${
          revision !== entry.revision ? ` Its current revision is ${entry.revision}.` : ""
        }${changed.length > 0 ? ` ${changed.length} of its sources changed since they were kept.` : ""}`,
        ids: [entry.id],
      };
    };
  }

  // -- helpers -------------------------------------------------------------

  private open(): KnowledgeStore {
    if (this.store) return this.store;
    if (this.failure) throw this.failure;
    try {
      this.store = this.deps.dir ? KnowledgeStore.open(this.deps.dir) : KnowledgeStore.inMemory();
      return this.store;
    } catch (error) {
      this.failure =
        error instanceof KnowledgeUnavailableError
          ? error
          : new KnowledgeUnavailableError("unreadable");
      throw this.failure;
    }
  }

  /**
   * A browser read, or the app's words for why the collection cannot be
   * read. The read is handed no store while nothing has been recorded
   * (`unopened`), and answers empty.
   */
  private browsing<T>(
    read: (store: KnowledgeStore | undefined) => T,
  ): T | { state: "unavailable"; reason: string } {
    if (this.unopened()) return read(undefined);
    let store: KnowledgeStore;
    try {
      store = this.open();
    } catch (error) {
      return {
        state: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return read(store);
  }

  /** A scope the window reads, or a refusal that reads as one that does not exist. */
  private browseScope(scope: string): string {
    if (scope !== PRIVATE_SCOPE && !this.deps.projects.get(scope))
      refuse(`No collection ${scope}.`);
    return scope;
  }

  /** The ids typed words find in one collection, best first; undefined when they name nothing to search. */
  private ranked(
    store: KnowledgeStore,
    scope: string,
    kind: KnowledgeKind,
    query: string | undefined,
  ): string[] | undefined {
    const terms = searchTerms((query ?? "").slice(0, KNOWLEDGE_LIMITS.queryBytes));
    if (terms.length === 0) return undefined;
    return store.search([scope], matchOf(terms), kind, SEARCH_WINDOW, 0).hits.map((hit) => hit.id);
  }

  /** The concepts typed words find: by name, alias or explanation, or as a finding about them. */
  private conceptsFound(
    store: KnowledgeStore,
    scope: string,
    query: string | undefined,
  ): Set<string> | undefined {
    const concepts = this.ranked(store, scope, "concept", query);
    if (!concepts) return undefined;
    const found = new Set(concepts);
    for (const id of this.ranked(store, scope, "finding", query) ?? []) {
      for (const edge of store.edgesVia(id)) if (edge.layer === "about") found.add(edge.toId);
    }
    return found;
  }

  /**
   * Where a finding stands and what it asks: its status, and whether a source
   * its current revision cites changed or went (each source checked once per
   * read, through `checks`).
   */
  private standing(
    store: KnowledgeStore,
    entry: EntryRow,
    body: FindingBody | undefined,
    checks: Map<string, SourceCheck>,
  ): {
    standing: KnowledgeStanding;
    attention: { recheck: boolean; differing: boolean };
    status: FindingStatus;
  } {
    const status = this.status(store, entry);
    const recheck =
      entry.lifecycle === "active" &&
      this.browseSources(body?.sources ?? [], checks).some(
        (source) => source.check.state === "changed" || source.check.state === "missing",
      );
    return {
      standing: standingOf(status, recheck),
      attention: { recheck, differing: status.state === "disputed" || status.challenged },
      status,
    };
  }

  /** Kept sources as the browser shows them, each checked once per read. */
  private browseSources(
    ids: readonly string[],
    checks: Map<string, SourceCheck>,
  ): KnowledgeSource[] {
    const store = this.open();
    return store
      .sources(ids.filter((id) => SOURCE_ID.test(id)))
      .filter((row) => this.scopesFor(WINDOW).includes(row.scope))
      .map((row) => {
        let check = checks.get(row.id);
        if (!check) {
          check = this.check(WINDOW, row);
          checks.set(row.id, check);
        }
        const origin = row.origin;
        return {
          id: row.id,
          origin:
            origin.kind === "file"
              ? {
                  kind: "file" as const,
                  path: origin.path,
                  startLine: origin.startLine,
                  endLine: origin.endLine,
                  commit: origin.commit,
                  dirty: origin.dirty,
                }
              : origin.kind === "report"
                ? { kind: "report" as const, key: origin.key, event: origin.event }
                : origin.kind === "article"
                  ? {
                      kind: "article" as const,
                      url: origin.url,
                      title: origin.title,
                      author: origin.author,
                      published: origin.published,
                      retrieved: origin.retrieved,
                    }
                  : { kind: "quote" as const, citation: origin.citation },
          text: row.text,
          capturedAt: row.capturedAt,
          check,
        };
      });
  }

  /** A concept's connections: the claims and read-together links at either end. */
  private conceptConnections(
    store: KnowledgeStore,
    entry: EntryRow,
    checks: Map<string, SourceCheck>,
  ): KnowledgeEntryConnection[] {
    const live = (id: string) => {
      const other = store.entry(id);
      return other && other.lifecycle === "active" && other.scope === entry.scope;
    };
    return store.edgesTouching(entry.id).flatMap((edge): KnowledgeEntryConnection[] => {
      if (edge.layer === "about" || !live(edge.fromId) || !live(edge.toId)) return [];
      const from = this.named(edge.fromId);
      const to = this.named(edge.toId);
      if (!from || !to) return [];
      if (edge.layer === "context") {
        return [
          {
            kind: "context",
            id: `context:${edge.fromId}:${edge.toId}`,
            from,
            to,
            reason: edge.label,
          },
        ];
      }
      const finding = store.entry(edge.via);
      if (finding?.lifecycle !== "active") return [];
      const body = store.revision(finding.id, finding.revision)?.body as FindingBody | undefined;
      return [
        {
          kind: "claim",
          id: `claim:${edge.via}`,
          finding: edge.via,
          from,
          predicate: edge.label,
          to,
          standing: this.standing(store, finding, body, checks).standing,
        },
      ];
    });
  }

  /** A concept's active findings, newest first, at most `KNOWLEDGE_ENTRY_FINDINGS`, and their count. */
  private conceptFindings(
    store: KnowledgeStore,
    entry: EntryRow,
    checks: Map<string, SourceCheck>,
  ): Pick<KnowledgeEntry, "findings" | "findingsTotal"> {
    const ids = new Set(
      store
        .edgesTouching(entry.id)
        .filter((edge) => edge.layer === "about" && edge.toId === entry.id)
        .map((edge) => edge.via),
    );
    const findings = store
      .entries([...ids])
      .filter((finding) => finding.lifecycle === "active" && finding.scope === entry.scope)
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    return {
      findings: findings.slice(0, KNOWLEDGE_ENTRY_FINDINGS).map((finding) => {
        const body = store.revision(finding.id, finding.revision)?.body as FindingBody | undefined;
        return {
          id: finding.id,
          statement: body?.statement ?? finding.id,
          standing: this.standing(store, finding, body, checks).standing,
        };
      }),
      findingsTotal: findings.length,
    };
  }

  /** Who did something, in the captain's words: Firstmate, or a crewmate by its task's key. */
  private byOf(actor: string): string {
    if (actor === "firstmate") return "the first mate";
    const taskId = actor.startsWith("task:") ? actor.slice("task:".length) : undefined;
    const key = taskId ? this.deps.tasks?.resolve(taskId)?.key : undefined;
    return key ? `the crewmate on ${key}` : "a crewmate";
  }

  private readScopes(actor: KnowledgeActor, scope: string | undefined): string[] {
    const scopes = this.scopesFor(actor);
    const wanted = scope?.trim();
    if (!wanted) return scopes;
    if (!scopes.includes(wanted)) {
      refuse(
        actor.kind === "crewmate"
          ? "You read the captain's factual knowledge. Leave scope out."
          : `Unknown scope "${wanted}". Use captain or a repo_id from the context block.`,
      );
    }
    return [wanted];
  }

  private writeScope(actor: KnowledgeActor, scope: string | undefined): string {
    const wanted = scope?.trim();
    if (actor.kind === "crewmate") {
      if (wanted && wanted !== PRIVATE_SCOPE) {
        refuse("A crewmate writes factual knowledge in the captain's collection. Leave scope out.");
      }
      return PRIVATE_SCOPE;
    }
    if (wanted && wanted !== PRIVATE_SCOPE) {
      refuse(
        "Knowledge keeps what the captain says about themselves, and sources they ask to save. How a project works stays in its code, documents and tests. What an investigation found stays on the task.",
      );
    }
    return PRIVATE_SCOPE;
  }

  /** A captain-owned entry this actor may see. */
  private visible(actor: KnowledgeActor, entry: EntryRow): boolean {
    return entry.scope === PRIVATE_SCOPE && this.scopesFor(actor).includes(entry.scope);
  }

  private articleHits(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    query: string,
    scopes: readonly string[],
  ): string[] {
    const url = query.trim();
    if (!/^https?:\/\//i.test(url)) return [];
    return scopes.flatMap((scope) => {
      const id = store.articleConcept(scope, url);
      const entry = id ? store.entry(id) : undefined;
      return entry && this.visible(actor, entry) ? [entry.id] : [];
    });
  }

  /** Who may record. A declared use is not a record, so it does not come here. */
  private assertRecorder(actor: KnowledgeActor): void {
    if (actor.kind === "firstmate" && (actor.origin !== "captain-turn" || !actor.canCreate)) {
      refuse(
        "The first mate records a personal statement or correction only on the captain's words. An import or a reconciliation is the crewmate's write. A scheduled turn records nothing.",
      );
    }
  }

  /** Reconciliation of a saved reference is the crewmate's, not Firstmate's. */
  private assertNotReferenceReconciliation(actor: KnowledgeActor, entry: EntryRow): void {
    if (actor.kind === "firstmate" && entry.lane === "reference") {
      refuse(
        "A saved reference is the importing crewmate's to reconcile. The first mate records personal statements and corrections, and retires an entry only on the captain's word.",
      );
    }
  }

  /** An entry `actor` may read, or the same refusal whether it is hidden or absent. */
  private readable(actor: KnowledgeActor, id: string | undefined): EntryRow {
    const wanted = id?.trim() ?? "";
    if (!ID.test(wanted)) refuse(`Give an entry id such as c-1a2b3c or f-1a2b3c; got "${wanted}".`);
    const entry = this.open().entry(wanted);
    if (!entry || !this.visible(actor, entry)) {
      refuse(`No entry ${wanted} in a collection you can read.`);
    }
    return entry;
  }

  private writable(actor: KnowledgeActor, id: string | undefined): EntryRow {
    return this.readable(actor, id);
  }

  private expectedRevision(entry: EntryRow, expected: number | undefined): number {
    if (expected === undefined) {
      refuse(
        `Pass expected_revision: the revision you read (${entry.id} is at ${entry.revision}).`,
      );
    }
    if (expected !== entry.revision) {
      refuse(
        `${entry.id} is at revision ${entry.revision}, not ${expected}; read it again and decide from there.`,
      );
    }
    return expected;
  }

  private conceptBody(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    scope: string,
    previous: ConceptBody | undefined,
    input: RecordInput,
    sources: string[],
    self?: string,
  ): ConceptBody {
    const title = clean(input.title ?? previous?.title, "title", MAX.title, true);
    const aliases = (input.aliases ?? previous?.aliases ?? []).map((alias) =>
      clean(alias, "alias", MAX.alias, true),
    );
    if (aliases.length > MAX.aliases) refuse(`A concept has at most ${MAX.aliases} aliases.`);
    const explanation = clean(
      input.explanation ?? previous?.explanation,
      "explanation",
      MAX.explanation,
      true,
    );
    const links = (input.links ?? previous?.links ?? []).map((link) => {
      const to = link.to?.trim() ?? "";
      if (to === self) refuse("A concept cannot link to itself.");
      const target = store.entry(to);
      if (
        !target ||
        target.scope !== scope ||
        target.kind !== "concept" ||
        target.lifecycle !== "active" ||
        !this.visible(actor, target)
      ) {
        refuse(`Link ${to} is not an active concept in this collection.`);
      }
      return { to, reason: clean(link.reason, "link reason", MAX.reason, true) };
    });
    if (links.length > MAX.links) refuse(`A concept keeps at most ${MAX.links} links.`);
    const appliesTo = this.appliesOf(input, previous?.appliesTo);
    return {
      title,
      aliases: [...new Set(aliases)],
      explanation,
      links,
      sources,
      ...(appliesTo ? { appliesTo } : {}),
      ...(previous?.savedUrl ? { savedUrl: previous.savedUrl } : {}),
    };
  }

  private findingBody(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    scope: string,
    previous: FindingBody | undefined,
    input: RecordInput,
    sources: string[],
  ): FindingBody {
    const statement = clean(
      input.statement ?? previous?.statement,
      "statement",
      MAX.statement,
      true,
    );
    const basis = input.basis ?? previous?.basis;
    if (basis !== "observation" && basis !== "inference") {
      refuse("A finding's basis is observation (you saw it) or inference (you reasoned to it).");
    }
    const conditions = clean(
      input.conditions ?? previous?.conditions,
      "conditions",
      MAX.conditions,
      true,
    );
    const concept = (id: string, what: string): string => {
      const wanted = id?.trim() ?? "";
      const target = store.entry(wanted);
      if (
        !target ||
        target.scope !== scope ||
        target.kind !== "concept" ||
        target.lifecycle !== "active" ||
        !this.visible(actor, target)
      ) {
        refuse(
          `${what} ${wanted || "(none)"} is not an active concept in this collection; publish the concept first.`,
        );
      }
      return wanted;
    };
    const relationship =
      input.relationship !== undefined
        ? {
            from: concept(input.relationship.from, "relationship.from"),
            predicate: clean(
              input.relationship.predicate,
              "relationship.predicate",
              MAX.predicate,
              true,
            ),
            to: concept(input.relationship.to, "relationship.to"),
          }
        : previous?.relationship;
    if (relationship && relationship.from === relationship.to) {
      refuse("A relationship joins two different concepts.");
    }
    const about = [
      ...new Set([
        ...(input.about ?? previous?.about ?? []).map((id) => concept(id, "about")),
        ...(relationship ? [relationship.from, relationship.to] : []),
      ]),
    ];
    if (about.length === 0) {
      refuse(
        "Say which concepts a finding is about (about: concept ids); publish a concept first if none fits.",
      );
    }
    if (about.length > MAX.about) refuse(`A finding is about at most ${MAX.about} concepts.`);
    const appliesTo = this.appliesOf(input, previous?.appliesTo);
    return {
      statement,
      basis,
      about,
      ...(relationship ? { relationship } : {}),
      conditions,
      sources,
      ...(appliesTo ? { appliesTo } : {}),
    };
  }

  private laneOf(actor: KnowledgeActor): KnowledgeLane {
    return actor.kind === "crewmate" ? "reference" : "personal";
  }

  private appliesOf(input: RecordInput, previous: string[] | undefined): string[] | undefined {
    if (input.appliesTo === undefined) return previous;
    if (input.appliesTo.length > MAX.appliesTo) {
      refuse(`An entry applies to at most ${MAX.appliesTo} projects.`);
    }
    const ids = [...new Set(input.appliesTo.map((id) => id.trim()).filter(Boolean))];
    for (const id of ids) {
      if (!this.deps.projects.get(id)) refuse(`Unknown project "${id}" in applies_to.`);
    }
    return ids.length > 0 ? ids : undefined;
  }

  private refuseDuplicateArticle(
    store: KnowledgeStore,
    scope: string,
    sources: readonly SourceRow[],
    self?: string,
  ): void {
    for (const source of sources) {
      if (source.origin.kind !== "article") continue;
      const existing = store.articleConcept(scope, source.origin.url);
      if (existing && existing !== self) {
        refuse(
          `This article is already saved as ${existing}. Revise that concept or add a finding; do not publish another.`,
        );
      }
    }
  }

  private requireSavedArticle(
    store: KnowledgeStore,
    scope: string,
    sources: readonly SourceRow[],
  ): void {
    for (const source of sources) {
      if (source.origin.kind !== "article") continue;
      if (!store.articleConcept(scope, source.origin.url)) {
        refuse(
          `Save ${source.origin.url} as a concept first, so the article stays findable even when it adds no claim.`,
        );
      }
    }
  }

  private stampArticle(body: ConceptBody, sources: readonly SourceRow[]): void {
    const article = sources.find((source) => source.origin.kind === "article");
    if (article && article.origin.kind === "article") body.savedUrl = article.origin.url;
  }

  private rememberArticles(
    store: KnowledgeStore,
    scope: string,
    conceptId: string,
    sources: readonly SourceRow[],
  ): void {
    for (const source of sources) {
      if (source.origin.kind === "article") store.saveArticle(scope, source.origin.url, conceptId);
    }
  }

  private refuseDuplicateTitle(store: KnowledgeStore, scope: string, title: string, self?: string) {
    const wanted = title.toLowerCase();
    for (const entry of store.listed([scope], "concept", 10_000)) {
      if (entry.id === self) continue;
      const body = store.revision(entry.id, entry.revision)?.body as ConceptBody | undefined;
      if (body?.title.toLowerCase() === wanted) {
        refuse(
          `A concept titled "${body.title}" already exists as ${entry.id}; revise or link it instead.`,
        );
      }
    }
  }

  private writeRevision(
    store: KnowledgeStore,
    entry: EntryRow,
    op: RevisionOp,
    body: EntryBody,
    actor: KnowledgeActor,
    reason: string,
    at: number,
  ): void {
    if (entry.revision > 1) store.advance(entry.id, entry.revision, entry.lifecycle, at);
    store.insertRevision({
      entryId: entry.id,
      revision: entry.revision,
      op,
      body,
      actor: actorId(actor),
      origin: originOf(actor),
      reason,
      at,
    });
    store.replaceEdges(
      entry.id,
      entry.lifecycle === "active" ? edgesOf(entry.id, entry.kind, body) : [],
    );
    store.index(entry, wordsOf(body, entry.kind));
  }

  /** Read and keep each cited source, before anything is written. */
  private async capture(
    actor: KnowledgeActor,
    scope: string,
    inputs: readonly SourceInput[] | undefined,
  ): Promise<SourceRow[]> {
    const list = inputs ?? [];
    if (list.length > MAX.sources) refuse(`Cite at most ${MAX.sources} sources in one write.`);
    const rows: SourceRow[] = [];
    for (const input of list) {
      const kept = await this.captureOne(actor, scope, input);
      const threat = scanKnowledgeThreat(kept.text);
      if (threat) {
        refuse(
          `Refused: a cited source matches a ${threat.pattern} pattern; cite text without it.`,
        );
      }
      rows.push({
        id: this.newId("s"),
        scope,
        kind: kept.origin.kind,
        origin: kept.origin,
        text: kept.text,
        digest: sha256(kept.text),
        actor: actorId(actor),
        capturedAt: this.now(),
      });
    }
    return rows;
  }

  private async captureOne(
    actor: KnowledgeActor,
    scope: string,
    input: SourceInput,
  ): Promise<{ text: string; origin: SourceOrigin }> {
    if (input.kind === "file") {
      refuse(
        "A file in the project stays with the project. Cite a task's report, a quotation, or a short article excerpt.",
      );
    }
    if (input.kind === "article") return this.captureArticle(actor, input);
    if (input.kind === "report") {
      const task = this.deps.tasks?.resolve(input.task?.trim() ?? "");
      if (!task) refuse(`No task "${input.task}" to cite.`);
      if (scope !== PRIVATE_SCOPE && task.repoId !== scope) {
        refuse(
          `${task.key || task.id} belongs to another project; cite only this collection's work.`,
        );
      }
      const report = this.deps.tasks?.reports(task.id).at(-1);
      if (!report) refuse(`${task.key || task.id} has no report to cite yet.`);
      let text = report.text;
      while (bytes(text) > 32 * 1024) text = text.slice(0, Math.floor(text.length * 0.9));
      return {
        text,
        origin: { kind: "report", task: task.id, key: task.key, event: report.id },
      };
    }
    if (input.kind === "quote") {
      const text = clean(input.text, "quote", MAX.quote, true);
      const citation = clean(input.citation, "citation", MAX.citation, true);
      return { text, origin: { kind: "quote", citation } };
    }
    refuse("A source is a task's report, a quotation, or a short article excerpt.");
  }

  private captureArticle(
    actor: KnowledgeActor,
    input: Extract<SourceInput, { kind: "article" }>,
  ): { text: string; origin: ArticleOrigin } {
    if (actor.kind !== "crewmate") {
      refuse("An article import is a crewmate's write, on the captain's request.");
    }
    const url = clean(input.url, "url", MAX.url, true);
    if (!/^https?:\/\//i.test(url)) refuse("An article source needs an http or https link.");
    const title = clean(input.title, "title", MAX.title, true);
    const excerpt = clean(input.excerpt, "excerpt", MAX.excerpt, true);
    const author = input.author?.trim() ? clean(input.author, "author", MAX.author, true) : null;
    const published = input.published?.trim()
      ? clean(input.published, "published", MAX.published, true)
      : null;
    return {
      text: excerpt,
      origin: { kind: "article", url, title, author, published, retrieved: this.now() },
    };
  }

  private sourceViews(actor: KnowledgeActor, ids: readonly string[]): SourceView[] {
    const store = this.open();
    return store
      .sources(ids.filter((id) => SOURCE_ID.test(id)))
      .filter((row) => this.scopesFor(actor).includes(row.scope))
      .map((row) => {
        const { scope: _scope, ...kept } = row;
        return { ...kept, check: this.check(actor, row) };
      });
  }

  /** Whether a kept source still reads the same where the reader works. */
  private check(actor: KnowledgeActor, row: SourceRow): SourceCheck {
    const origin = row.origin;
    if (origin.kind === "file") {
      const root =
        actor.kind === "crewmate" && actor.repoId === origin.project && actor.cwd
          ? actor.cwd
          : this.deps.projects.get(origin.project)?.path;
      return checkFile(origin, root);
    }
    if (origin.kind === "report") {
      const report = this.deps.tasks
        ?.reports(origin.task)
        .find((event) => event.id === origin.event);
      if (!report)
        return { state: "unknown", detail: `${origin.key}'s report is no longer on its record` };
      const kept = report.text.startsWith(row.text);
      return kept
        ? { state: "unchanged", detail: `${origin.key}'s report, as recorded` }
        : { state: "changed", detail: `${origin.key}'s report reads differently now` };
    }
    if (origin.kind === "article") {
      const who = origin.author ? `, ${origin.author}` : "";
      const when = origin.published ? `, published ${origin.published}` : "";
      return {
        state: "kept",
        detail: `saved from ${origin.url}${who}${when}; the app does not re-fetch it`,
      };
    }
    return {
      state: "kept",
      detail: `quoted from ${origin.citation}; an attributed quotation, not checked by the app`,
    };
  }

  private evidenceLine(sources: readonly SourceRow[]): string {
    if (sources.length === 0) return "";
    const kept = sources.map((source) => {
      const origin = source.origin;
      if (origin.kind === "file") {
        return `${source.id} ${origin.path}:${origin.startLine}-${origin.endLine}${
          origin.commit ? ` at ${origin.commit.slice(0, 10)}` : ""
        }${origin.dirty ? " (uncommitted)" : ""}`;
      }
      if (origin.kind === "report") return `${source.id} ${origin.key}'s report`;
      if (origin.kind === "article") return `${source.id} article ${origin.title} (${origin.url})`;
      return `${source.id} quotation from ${origin.citation}`;
    });
    return ` Evidence kept: ${kept.join("; ")}.`;
  }

  private named(id: string): Named | undefined {
    const store = this.open();
    const entry = store.entry(id);
    if (!entry) return undefined;
    const body = store.revision(entry.id, entry.revision)?.body;
    return {
      id: entry.id,
      kind: entry.kind,
      title: body ? titleOf(entry.kind, body) : entry.id,
      retired: entry.lifecycle === "retired",
    };
  }

  /** The one-line view of an entry, as its current revision (or `shown`) says. */
  summary(entry: EntryRow, shown?: RevisionRow): EntrySummary {
    const store = this.open();
    const revision = shown ?? store.revision(entry.id, entry.revision);
    const body = revision?.body;
    const base = {
      id: entry.id,
      scope: entry.scope,
      scopeName: this.scopeName(entry.scope),
      kind: entry.kind,
      revision: revision?.revision ?? entry.revision,
      retired: entry.lifecycle === "retired",
      lane: entry.lane,
      title: body ? titleOf(entry.kind, body) : entry.id,
    };
    if (entry.kind === "concept") {
      const concept = body as ConceptBody | undefined;
      const edges = store.edgesTouching(entry.id);
      return {
        ...base,
        aliases: concept?.aliases ?? [],
        about: [],
        findings: new Set(
          edges
            .filter((edge) => edge.layer === "about" && edge.toId === entry.id)
            .map((edge) => edge.via),
        ).size,
        links: edges.filter((edge) => edge.layer === "context").length,
      };
    }
    const finding = body as FindingBody | undefined;
    const name = (id: string): Named =>
      this.named(id) ?? { id, kind: "concept", title: id, retired: true };
    return {
      ...base,
      aliases: [],
      ...(finding ? { basis: finding.basis, conditions: finding.conditions } : {}),
      about: (finding?.about ?? []).map(name),
      ...(finding?.relationship
        ? {
            relationship: {
              from: name(finding.relationship.from),
              predicate: finding.relationship.predicate,
              to: name(finding.relationship.to),
            },
          }
        : {}),
      status: this.status(store, entry),
    };
  }

  private status(store: KnowledgeStore, entry: EntryRow): FindingStatus {
    const assessments = store.assessments(entry.id);
    const relations = store.relations(entry.id);
    const active = (id: string) => store.entry(id)?.lifecycle === "active";
    const evidenced = (assessment: AssessmentRow) => assessment.sources.length > 0;
    const current = assessments.filter((assessment) => assessment.revision === entry.revision);
    const supports = current.filter((a) => a.verdict === "supports" && evidenced(a));
    const contradicts = current.filter((a) => a.verdict === "contradicts" && evidenced(a));
    const supersededBy = relations.find(
      (relation) =>
        relation.type === "supersedes" && relation.toId === entry.id && active(relation.fromId),
    )?.fromId;
    const duplicateOf = relations.find(
      (relation) => relation.type === "duplicates" && relation.fromId === entry.id,
    )?.toId;
    const disputedBy = [
      ...contradicts.map((assessment) => assessment.actor),
      ...relations
        .filter((relation) => relation.type === "contradicts")
        .map((relation) => (relation.fromId === entry.id ? relation.toId : relation.fromId))
        .filter(active),
    ];
    const state: FindingState =
      entry.lifecycle === "retired"
        ? "retired"
        : supersededBy
          ? "superseded"
          : disputedBy.length > 0
            ? "disputed"
            : supports.length > 0
              ? "checked"
              : "unchecked";
    return {
      state,
      challenged: current.some((a) => a.verdict === "contradicts" && !evidenced(a)),
      earlierChecked: assessments.some(
        (a) => a.revision < entry.revision && a.verdict === "supports" && evidenced(a),
      ),
      ...(supersededBy ? { supersededBy } : {}),
      ...(duplicateOf ? { duplicateOf } : {}),
      disputedBy: [...new Set(disputedBy)],
      checks: supports.map((a) => ({ method: a.method, conditions: a.conditions, actor: a.actor })),
    };
  }
}

function titleOf(kind: KnowledgeKind, body: EntryBody): string {
  return kind === "concept" ? (body as ConceptBody).title : (body as FindingBody).statement;
}

export { KnowledgeUnavailableError };
