import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ConceptBody,
  KNOWLEDGE_DB_FILE,
  type KnowledgeKind,
  KnowledgeStore,
  KnowledgeUnavailableError,
  type RevisionRow,
} from "../storage/knowledgeStore";
import {
  actorId,
  bytes,
  canonical,
  clean,
  KNOWLEDGE_LIMITS,
  type KnowledgeActor,
  KnowledgeRefusal,
  MAX,
  PRIVATE_SCOPE,
  readable,
  readScopes,
  refuse,
  scopesFor,
  WINDOW,
} from "./access";
import { StandingDirections } from "./directions";
import {
  type EntrySummary,
  type EntryView,
  type Neighbor,
  named,
  type RelationView,
  summary,
} from "./entries";
import { articleHits, ID_IN_TEXT, matchOf, SEARCH_WINDOW, searchTerms } from "./search";
import { type SourceView, sha256, sourceViews } from "./sources";
import { KnowledgeWindow } from "./windowReads";
import { KnowledgeWrites, type RecordInput, type RecordOutcome } from "./writes";

/**
 * The one owner of knowledge (docs/knowledge.md): concepts that organize
 * what the crew learned, findings that say something about them with their
 * evidence, and the checks, disagreements and declared uses that follow.
 * Every read and write goes through here: Firstmate reads every collection
 * and writes personal context on the captain's words; every crewmate reads
 * and writes captain-owned factual knowledge as needed. Nothing here decides
 * whether a finding is true - the host checks who may write, that every
 * reference names an active entry, that evidence is what it says it is and
 * whether its source still reads the same, and that a write neither
 * overwrites a newer revision nor repeats itself.
 *
 * The collection lives in its own database (`KnowledgeStore`), opened the
 * first time it is needed. A collection this build cannot read makes
 * knowledge unavailable - every call says so - and leaves the app and the
 * data alone. This service is its one opener: the standing directions
 * (`directions`), the captain's window (`window`) and the writes borrow its
 * store through a `KnowledgeHandle`.
 */

export type KnowledgeProject = { id: string; name: string; path: string };

export type KnowledgeDeps = {
  /** The collection's folder; absent, an in-memory store (tests). */
  dir?: string;
  projects: {
    get: (id: string) => KnowledgeProject | undefined;
    list: () => KnowledgeProject[];
    /**
     * Every repository in the same project as this one, itself included
     * (INF-4220): a direction saved for any of them reaches a crewmate in
     * each. Absent, a repository is its own project.
     */
    together?: (id: string) => string[];
  };
  /** Task reports a finding may cite. */
  tasks?: {
    resolve: (ref: string) => { id: string; key: string; repoId: string | null } | undefined;
    reports: (taskId: string) => { id: number; text: string }[];
  };
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

export type Availability = { state: "ready" } | { state: "unavailable"; reason: string };

/** How much the captain's collection holds: personal entries, saved sources and their findings. */
export type SavedCounts = { personal: number; sources: number; findings: number };

/**
 * What the service lends the owners beside it: its dependencies, its clock
 * and ids, and its one store - opened on first need, or read for the
 * captain's window without creating it.
 */
export type KnowledgeHandle = {
  readonly deps: KnowledgeDeps;
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
  readonly open: () => KnowledgeStore;
  readonly browsing: <T>(
    read: (store: KnowledgeStore | undefined) => T,
  ) => T | { state: "unavailable"; reason: string };
  readonly scopeName: (scope: string) => string;
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomId(prefix: string): string {
  const random = randomBytes(6);
  let id = "";
  for (const byte of random) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `${prefix}-${id}`;
}

export class KnowledgeService {
  /** The captain's standing directions, kept beside the collection. */
  readonly directions: StandingDirections;
  /** What the captain's window reads. */
  readonly window: KnowledgeWindow;
  private readonly writes: KnowledgeWrites;
  private store: KnowledgeStore | undefined;
  private failure: KnowledgeUnavailableError | undefined;
  private readonly now: () => number;
  private readonly nameOf = (scope: string) => this.scopeName(scope);

  constructor(private readonly deps: KnowledgeDeps) {
    this.now = deps.now ?? Date.now;
    this.store = deps.store;
    const handle: KnowledgeHandle = {
      deps,
      now: this.now,
      newId: deps.newId ?? randomId,
      open: () => this.open(),
      browsing: (read) => this.browsing(read),
      scopeName: this.nameOf,
    };
    this.directions = new StandingDirections(handle);
    this.window = new KnowledgeWindow(handle);
    this.writes = new KnowledgeWrites(handle);
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
    const scopes = readScopes(actor, input.scope);
    const query = input.query.slice(0, KNOWLEDGE_LIMITS.queryBytes);
    const terms = searchTerms(query);
    const exact = [...new Set(query.toLowerCase().match(ID_IN_TEXT) ?? [])].flatMap((id) => {
      const entry = store.entry(id);
      return entry && (!input.kind || entry.kind === input.kind) ? [entry.id] : [];
    });
    const byUrl = articleHits(store, query, scopes).filter(
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
    ].filter((id) => store.entry(id) !== undefined);
    return {
      hits: ids.slice(offset, offset + limit).flatMap((id) => {
        const entry = store.entry(id);
        return entry ? [summary(store, this.nameOf, entry)] : [];
      }),
      total: ids.length,
    };
  }

  /** A whole entry: its revision, evidence and whether each source still reads the same. */
  get(actor: KnowledgeActor, id: string, revision?: number): EntryView {
    const store = this.open();
    const entry = readable(store, id);
    const shown = store.revision(entry.id, revision ?? entry.revision);
    if (!shown)
      refuse(`${entry.id} has no revision ${revision}; its current one is ${entry.revision}.`);
    const relations = store.relations(entry.id).flatMap((relation): RelationView[] => {
      const outgoing = relation.fromId === entry.id;
      const other = named(store, outgoing ? relation.toId : relation.fromId);
      return other ? [{ ...relation, other, outgoing }] : [];
    });
    const assessments = store.assessments(entry.id).map((assessment) => ({
      ...assessment,
      sources: sourceViews(store, this.deps, actor, assessment.sources),
      current: assessment.revision === entry.revision,
    }));
    const links =
      entry.kind === "concept"
        ? store
            .edgesTouching(entry.id)
            .filter((edge) => edge.layer === "context")
            .flatMap((edge) => {
              const outgoing = edge.fromId === entry.id;
              const other = named(store, outgoing ? edge.toId : edge.fromId);
              return other ? [{ other, reason: edge.label, outgoing }] : [];
            })
        : [];
    const uses = store.uses(entry.id, 1000);
    return {
      summary: summary(store, this.nameOf, entry, shown),
      shown,
      author: entry.author,
      createdAt: entry.createdAt,
      ...(entry.kind === "concept" ? { explanation: (shown.body as ConceptBody).explanation } : {}),
      links,
      sources: sourceViews(store, this.deps, actor, shown.body.sources),
      assessments,
      relations,
      uses: { count: uses.length, recent: uses.slice(0, 5) },
    };
  }

  /** One kept source, whole. */
  source(actor: KnowledgeActor, id: string): SourceView {
    const [view] = sourceViews(this.open(), this.deps, actor, [id]);
    if (!view) refuse(`No source ${id} in a collection you can read.`);
    return view;
  }

  /** One hop from an entry: its links, the findings about it, its relationships and disagreements. */
  neighbors(input: { id: string; layer?: Neighbor["layer"]; offset?: number; limit?: number }): {
    neighbors: Neighbor[];
    total: number;
  } {
    const store = this.open();
    const entry = readable(store, input.id);
    const all: Neighbor[] = [];
    const add = (otherId: string, neighbor: Omit<Neighbor, "other">) => {
      const other = store.entry(otherId);
      if (!other) return;
      all.push({ ...neighbor, other: summary(store, this.nameOf, other) });
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
  history(input: { id: string; before?: number; limit?: number }): {
    entry: EntrySummary;
    revisions: RevisionRow[];
    remaining: number;
  } {
    const store = this.open();
    const entry = readable(store, input.id);
    const before = Math.min(input.before ?? entry.revision + 1, entry.revision + 1);
    const limit = Math.min(input.limit ?? 20, 20);
    const revisions = store.revisions(entry.id, before, limit);
    const oldest = revisions.at(-1)?.revision ?? before;
    return {
      entry: summary(store, this.nameOf, entry),
      revisions,
      remaining: Math.max(0, oldest - 1),
    };
  }

  /**
   * How much the captain's collection holds, by category: the one fact about
   * saved knowledge an agent is given unasked (docs/knowledge.md, "Knowledge
   * as needed"). Nothing recorded yet reads as zero without creating the file.
   */
  savedCounts(): SavedCounts | { state: "unavailable"; reason: string } {
    return this.browsing((store) =>
      store ? store.savedCounts(PRIVATE_SCOPE) : { personal: 0, sources: 0, findings: 0 },
    );
  }

  /** How many active entries the collections hold. */
  count(scopes: readonly string[]): number {
    return this.open().countActive(scopes);
  }

  /**
   * Whether there is knowledge for the captain's window to show: an entry in
   * a collection it reads, or a collection that cannot be read, which says
   * so. The Knowledge panel exists only while this holds.
   */
  held(): boolean {
    if (this.unopened()) return false;
    try {
      const store = this.open();
      return (
        store.countActive(scopesFor(WINDOW)) > 0 || store.directions().some((row) => !row.retired)
      );
    } catch {
      return true;
    }
  }

  // -- writes --------------------------------------------------------------

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
      const write = await this.writes.prepare(store, actor, input);
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

  // -- the one store -------------------------------------------------------

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
}
