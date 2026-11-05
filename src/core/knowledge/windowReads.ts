import {
  KNOWLEDGE_ENTRY_FINDINGS,
  KNOWLEDGE_TASK_USES,
  type KnowledgeCollections,
  type KnowledgeConcepts,
  type KnowledgeConceptsArgs,
  type KnowledgeConnection,
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
import type {
  ConceptBody,
  EntryBody,
  EntryRow,
  FindingBody,
  KnowledgeKind,
  KnowledgeStore,
} from "../storage/knowledgeStore";
import { KNOWLEDGE_LIMITS, PRIVATE_SCOPE, refuse, scopesFor, WINDOW } from "./access";
import { chooseGraph, degreesOf, neighborhoodOf, pageOf, standingOf } from "./browse";
import { type FindingStatus, named, status, summary, titleOf } from "./entries";
import type { KnowledgeHandle } from "./knowledgeService";
import { matchOf, SEARCH_WINDOW, searchTerms } from "./search";
import { checkSource, keptSources, type SourceCheck } from "./sources";

/**
 * What the captain's window reads (docs/knowledge.md, "The browser"): the
 * collections Firstmate reads - the private one and every registered
 * project's - bounded for a window and read only. A collection this build
 * cannot read answers `unavailable` in the app's words; a scope the window
 * cannot read is refused as one that does not exist. The service lends
 * this owner its one store.
 */
export class KnowledgeWindow {
  constructor(private readonly handle: KnowledgeHandle) {}

  /** Each collection, private first then each project's by name, with its entries counted. */
  collections(): KnowledgeCollections {
    return this.handle.browsing((store) => {
      const scopes = scopesFor(WINDOW);
      const counts = store ? store.countsByKind(scopes) : [];
      const directions = store?.directions().filter((row) => !row.retired) ?? [];
      const count = (scope: string, kind: KnowledgeKind) =>
        counts.find((row) => row.scope === scope && row.kind === kind)?.n ?? 0;
      const projects = this.handle.deps.projects
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
    return this.handle.browsing((store) => {
      const scope = this.scope(args.scope);
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
    return this.handle.browsing((store) => {
      const scope = this.scope(args.scope);
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
    return this.handle.browsing((store) => {
      const scope = this.scope(args.scope);
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
        const about = summary(store, this.handle.scopeName, entry);
        return {
          id: entry.id,
          statement: finding.statement,
          basis: finding.basis,
          conditions: finding.conditions,
          about: about.about,
          relationship: about.relationship ?? null,
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

  /** One concept or finding whole, at its current revision or an earlier one. */
  entry(args: KnowledgeEntryArgs): KnowledgeEntryRead {
    return this.handle.browsing((store): KnowledgeEntryRead => {
      const entry = store?.entry(args.id);
      if (!store || !entry) return { state: "missing" };
      const shown = store.revision(entry.id, args.revision ?? entry.revision);
      if (!shown) return { state: "missing" };
      const checks = new Map<string, SourceCheck>();
      const line = summary(store, this.handle.scopeName, entry, shown);
      const sources = (ids: readonly string[]) => this.sources(store, ids, checks);
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
        title: line.title,
        aliases: concept?.aliases ?? [],
        explanation: concept?.explanation ?? "",
        basis: finding?.basis ?? null,
        conditions: finding?.conditions ?? "",
        about: line.about,
        relationship: line.relationship ?? null,
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
          const other = named(store, outgoing ? relation.toId : relation.fromId);
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
            task: use.taskId ? (this.handle.deps.tasks?.resolve(use.taskId)?.key ?? null) : null,
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
    return this.handle.browsing((store): KnowledgeRefs => {
      if (!store) return { state: "ready", refs: [] };
      const checks = new Map<string, SourceCheck>();
      const refs = [...new Set(args.ids)].flatMap((id): KnowledgeRef[] => {
        const entry = store.entry(id);
        const current = entry && store.revision(entry.id, entry.revision);
        if (!entry || !current) return [];
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
  uses(args: KnowledgeUsesArgs): KnowledgeUses {
    return this.handle.browsing((store): KnowledgeUses => {
      if (!store) return { state: "ready", uses: [], total: 0 };
      const checks = new Map<string, SourceCheck>();
      const seen = new Set<string>();
      const uses: KnowledgeTaskUse[] = [];
      for (const use of store.usesOfTask(args.task, 1000)) {
        const key = `${use.entryId}@${use.revision}`;
        if (seen.has(key)) continue;
        const entry = store.entry(use.entryId);
        const used = entry && store.revision(entry.id, use.revision);
        const current = entry && store.revision(entry.id, entry.revision);
        if (!entry || !used || !current) continue;
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

  /** A scope the window reads, or a refusal that reads as one that does not exist. */
  private scope(scope: string): string {
    if (scope !== PRIVATE_SCOPE && !this.handle.deps.projects.get(scope))
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
    const found = status(store, entry);
    const recheck =
      entry.lifecycle === "active" &&
      this.sources(store, body?.sources ?? [], checks).some(
        (source) => source.check.state === "changed" || source.check.state === "missing",
      );
    return {
      standing: standingOf(found, recheck),
      attention: { recheck, differing: found.state === "disputed" || found.challenged },
      status: found,
    };
  }

  /** Kept sources as the browser shows them, each checked once per read. */
  private sources(
    store: KnowledgeStore,
    ids: readonly string[],
    checks: Map<string, SourceCheck>,
  ): KnowledgeSource[] {
    return keptSources(store, ids).map((row) => {
      let check = checks.get(row.id);
      if (!check) {
        check = checkSource(this.handle.deps, WINDOW, row);
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
    const live = (id: string) => store.entry(id)?.lifecycle === "active";
    return store.edgesTouching(entry.id).flatMap((edge): KnowledgeEntryConnection[] => {
      if (edge.layer === "about" || !live(edge.fromId) || !live(edge.toId)) return [];
      const from = named(store, edge.fromId);
      const to = named(store, edge.toId);
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
      .filter((finding) => finding.lifecycle === "active")
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
    const key = taskId ? this.handle.deps.tasks?.resolve(taskId)?.key : undefined;
    return key ? `the crewmate on ${key}` : "a crewmate";
  }
}
