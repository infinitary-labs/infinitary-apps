import { cutText } from "@shared/textCut";
import type {
  AssessmentVerdict,
  ConceptBody,
  ConceptLink,
  EdgeRow,
  EntryBody,
  EntryRow,
  FindingBasis,
  FindingBody,
  KnowledgeKind,
  KnowledgeLane,
  KnowledgeStore,
  Relationship,
  RelationType,
  RevisionOp,
  SourceRow,
} from "../storage/knowledgeStore";
import {
  actorId,
  assertNotReferenceReconciliation,
  assertRecorder,
  clean,
  expectedRevision,
  type KnowledgeActor,
  KnowledgeRefusal,
  laneOf,
  MAX,
  originOf,
  readable,
  refuse,
  writeScope,
} from "./access";
import type { KnowledgeHandle } from "./knowledgeService";
import { ID_IN_TEXT, wordsOf } from "./search";
import { capture, evidenceLine, type SourceInput, sourceViews } from "./sources";

/**
 * What a write may ask and what it records (docs/knowledge.md, "Who may
 * write" and "Evidence"): each action is checked and its evidence captured
 * first, then the returned step writes it inside the service's one
 * transaction. Nothing here decides whether a finding is true - the host
 * checks who may write, that every reference names an active entry, that
 * evidence is what it says it is, and that a write never overwrites a newer
 * revision.
 */

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

/** The step that writes a checked write, inside the transaction. */
export type Write = () => { text: string; ids: string[] };

export class KnowledgeWrites {
  constructor(private readonly handle: KnowledgeHandle) {}

  /** Check a write and capture its evidence; the returned step writes it. */
  async prepare(store: KnowledgeStore, actor: KnowledgeActor, input: RecordInput): Promise<Write> {
    // A direction changes through the app action catalog (`StandingDirections.change`).
    if (input.kind === "direction" || input.id?.startsWith("d:"))
      refuse(
        actor.kind === "firstmate"
          ? "Change a standing direction with app_change direction."
          : "Directions are the first mate's to keep: report the captain's words or choice with needs_firstmate.",
      );
    if (input.action !== "use") assertRecorder(actor);
    switch (input.action) {
      case "publish":
        return this.publish(store, actor, input);
      case "revise":
        return this.revise(store, actor, input);
      case "assess":
        return this.assess(store, actor, input);
      case "relate":
        return this.relate(store, actor, input);
      case "retire":
        return this.retire(store, actor, input);
      case "retire_many":
        return this.retireMany(store, actor, input);
      case "use":
        return this.use(store, actor, input);
      default:
        refuse("action must be publish, revise, assess, relate, retire, retire_many or use.");
    }
  }

  private async publish(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<Write> {
    const scope = writeScope(actor, input.scope);
    const lane = input.lane ?? laneOf(actor);
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
    const sources = await capture(this.handle, actor, scope, input.sources);
    const ids = sources.map((s) => s.id);
    const body =
      kind === "concept"
        ? this.conceptBody(store, undefined, input, ids)
        : this.findingBody(store, undefined, input, ids);
    if (kind === "concept") {
      refuseDuplicateTitle(store, scope, (body as ConceptBody).title);
      refuseDuplicateArticle(store, scope, sources);
      stampArticle(body as ConceptBody, sources);
    }
    if (kind === "finding") requireSavedArticle(store, scope, sources);
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
      let id = this.handle.newId(kind === "concept" ? "c" : "f");
      while (store.entry(id)) id = this.handle.newId(kind === "concept" ? "c" : "f");
      const at = this.handle.now();
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
      if (kind === "concept") rememberArticles(store, scope, id, sources);
      writeRevision(store, entry, "publish", body, actor, "", at);
      const what =
        kind === "concept" ? `concept ${id} "${(body as ConceptBody).title}"` : `finding ${id}`;
      return {
        text: `Recorded ${what} (revision 1) in ${this.handle.scopeName(scope)}.${evidenceLine(sources)}${
          kind === "finding"
            ? " It reads as not yet checked until someone assesses it with a method and evidence."
            : ""
        }`,
        ids: [id],
      };
    };
  }

  private async revise(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<Write> {
    const entry = readable(store, input.id);
    if (entry.lifecycle === "retired")
      refuse(`${entry.id} is retired; publish a new entry instead.`);
    if (entry.kind === "finding" && entry.author !== actorId(actor)) {
      refuse(
        `${entry.id} is another author's finding: assess it, or publish your own and relate it (supersedes or contradicts). Its evidence stays as recorded.`,
      );
    }
    const expected = expectedRevision(entry, input.expectedRevision);
    const current = store.revision(entry.id, entry.revision);
    if (!current) refuse(`${entry.id} cannot be read just now.`);
    assertNotReferenceReconciliation(actor, entry);
    const sources = await capture(this.handle, actor, entry.scope, input.sources);
    const ids = [...current.body.sources, ...sources.map((s) => s.id)];
    if (ids.length > MAX.sources * 2) refuse(`An entry keeps at most ${MAX.sources * 2} sources.`);
    const body =
      entry.kind === "concept"
        ? this.conceptBody(store, current.body as ConceptBody, input, ids, entry.id)
        : this.findingBody(store, current.body as FindingBody, input, ids);
    if (entry.kind === "concept") {
      refuseDuplicateTitle(store, entry.scope, (body as ConceptBody).title, entry.id);
      refuseDuplicateArticle(store, entry.scope, sources, entry.id);
      stampArticle(body as ConceptBody, sources);
    } else {
      requireSavedArticle(store, entry.scope, sources);
    }
    const reason = clean(input.reason, "reason", MAX.reason, false);
    return () => {
      const fresh = store.entry(entry.id);
      if (!fresh || fresh.revision !== expected) {
        refuse(
          `${entry.id} moved to revision ${fresh?.revision}; read it again and revise from there.`,
        );
      }
      const at = this.handle.now();
      for (const source of sources) store.insertSource(source);
      if (entry.kind === "concept") rememberArticles(store, entry.scope, entry.id, sources);
      const next = nextRevision(fresh, at);
      writeRevision(store, next, "revise", body, actor, reason, at);
      return {
        text: `Revised ${entry.id} to revision ${next.revision}.${evidenceLine(sources)}${
          entry.kind === "finding" ? " Checks of earlier revisions do not carry over." : ""
        }`,
        ids: [entry.id],
      };
    };
  }

  private async assess(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<Write> {
    const entry = readable(store, input.id);
    assertNotReferenceReconciliation(actor, entry);
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
    const sources = await capture(this.handle, actor, entry.scope, input.sources);
    return () => {
      const at = this.handle.now();
      for (const source of sources) store.insertSource(source);
      const id = this.handle.newId("a");
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
        text: `Assessed ${entry.id} revision ${revision}: ${verdict}.${evidenceLine(sources)}${unbacked}`,
        ids: [entry.id],
      };
    };
  }

  private async relate(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<Write> {
    const from = readable(store, input.from);
    const to = readable(store, input.to);
    assertNotReferenceReconciliation(actor, from);
    assertNotReferenceReconciliation(actor, to);
    if (from.id === to.id) refuse("An entry cannot relate to itself.");
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
        const at = this.handle.now();
        const next = nextRevision(fresh, at);
        writeRevision(
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
      const at = this.handle.now();
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

  /**
   * Retire one entry. Only the first mate on the captain's words gets here
   * (`assertRecorder`), so the captain asked for it whoever wrote the entry.
   */
  private async retire(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<Write> {
    const entry = readable(store, input.id);
    if (entry.lifecycle === "retired") refuse(`${entry.id} is already retired.`);
    if (actor.kind === "crewmate") {
      refuse(
        "Removing an entry waits for the captain. The first mate retires it on the captain's word.",
      );
    }
    const expected = expectedRevision(entry, input.expectedRevision);
    const reason = clean(input.reason, "reason", MAX.reason, true);
    return () => {
      const fresh = store.entry(entry.id);
      const current = fresh && store.revision(fresh.id, fresh.revision);
      if (!fresh || !current || fresh.revision !== expected) {
        refuse(`${entry.id} moved to revision ${fresh?.revision}; read it again first.`);
      }
      const at = this.handle.now();
      const next = nextRevision(fresh, at, "retired");
      writeRevision(store, next, "retire", current.body, actor, reason, at);
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
  private async retireMany(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<Write> {
    if (actor.kind !== "firstmate" || actor.origin !== "captain-turn") {
      refuse(
        "Removing entries waits for the captain. The first mate retires them on the captain's word.",
      );
    }
    const ref = clean(input.task, "task", MAX.reason, true);
    const approval = this.handle.deps.approvals?.of(ref);
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
    const named = new Set(approval.body.match(ID_IN_TEXT) ?? []);
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
        entry = readable(store, id);
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
      const at = this.handle.now();
      const done: string[] = [];
      for (const entry of targets) {
        const fresh = store.entry(entry.id);
        const current = fresh && store.revision(fresh.id, fresh.revision);
        if (!fresh || !current || fresh.lifecycle === "retired") continue;
        writeRevision(
          store,
          nextRevision(fresh, at, "retired"),
          "retire",
          current.body,
          actor,
          cutText(`${reason} (approved on ${approval.key})`, MAX.reason),
          at,
        );
        done.push(entry.id);
      }
      return {
        text: `Retired ${done.length} ${done.length === 1 ? "entry" : "entries"} approved on ${approval.key}: ${done.join(", ")}. ${
          done.length === 1 ? "Its" : "Their"
        } history and evidence stay readable.${
          skipped.length > 0 ? ` Left alone: ${skipped.join(", ")}.` : ""
        }`,
        ids: done,
      };
    };
  }

  private async use(
    store: KnowledgeStore,
    actor: KnowledgeActor,
    input: RecordInput,
  ): Promise<Write> {
    const entry = readable(store, input.id);
    const revision = input.revision ?? entry.revision;
    const shown = store.revision(entry.id, revision);
    if (!shown) refuse(`${entry.id} has no revision ${revision}.`);
    const purpose = clean(input.purpose, "purpose", MAX.purpose, true);
    const checks = sourceViews(store, this.handle.deps, actor, shown.body.sources);
    return () => {
      const at = this.handle.now();
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

  private conceptBody(
    store: KnowledgeStore,
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
      if (!activeConcept(store, to))
        refuse(`Link ${to} is not an active concept in this collection.`);
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
      if (!activeConcept(store, wanted)) {
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

  private appliesOf(input: RecordInput, previous: string[] | undefined): string[] | undefined {
    if (input.appliesTo === undefined) return previous;
    if (input.appliesTo.length > MAX.appliesTo) {
      refuse(`An entry applies to at most ${MAX.appliesTo} projects.`);
    }
    const ids = [...new Set(input.appliesTo.map((id) => id.trim()).filter(Boolean))];
    for (const id of ids) {
      if (!this.handle.deps.projects.get(id)) refuse(`Unknown project "${id}" in applies_to.`);
    }
    return ids.length > 0 ? ids : undefined;
  }
}

/** An entry's next revision, stamped `at`; a retirement also changes its lifecycle. */
function nextRevision(entry: EntryRow, at: number, lifecycle = entry.lifecycle): EntryRow {
  return { ...entry, revision: entry.revision + 1, lifecycle, updatedAt: at };
}

function activeConcept(store: KnowledgeStore, id: string): boolean {
  const target = store.entry(id);
  return target?.kind === "concept" && target.lifecycle === "active";
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

function writeRevision(
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

function refuseDuplicateArticle(
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

function requireSavedArticle(
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

function stampArticle(body: ConceptBody, sources: readonly SourceRow[]): void {
  const article = sources.find((source) => source.origin.kind === "article");
  if (article && article.origin.kind === "article") body.savedUrl = article.origin.url;
}

function rememberArticles(
  store: KnowledgeStore,
  scope: string,
  conceptId: string,
  sources: readonly SourceRow[],
): void {
  for (const source of sources) {
    if (source.origin.kind === "article") store.saveArticle(scope, source.origin.url, conceptId);
  }
}

function refuseDuplicateTitle(store: KnowledgeStore, scope: string, title: string, self?: string) {
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
