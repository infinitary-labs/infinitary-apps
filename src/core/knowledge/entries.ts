import type {
  AssessmentRow,
  ConceptBody,
  EntryBody,
  EntryRow,
  FindingBasis,
  FindingBody,
  KnowledgeKind,
  KnowledgeLane,
  KnowledgeStore,
  RelationRow,
  RevisionRow,
  UseRow,
} from "../storage/knowledgeStore";
import type { SourceView } from "./sources";

/**
 * An entry as both read sides show it (docs/knowledge.md, "Reading"): the
 * agent's tools and the captain's window. What a finding's status is - how
 * far it was checked, and whether something disputes or supersedes it - is
 * derived here from its assessments and relations, never stored.
 */

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

export function titleOf(kind: KnowledgeKind, body: EntryBody): string {
  return kind === "concept" ? (body as ConceptBody).title : (body as FindingBody).statement;
}

export function named(store: KnowledgeStore, id: string): Named | undefined {
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
export function summary(
  store: KnowledgeStore,
  scopeName: (scope: string) => string,
  entry: EntryRow,
  shown?: RevisionRow,
): EntrySummary {
  const revision = shown ?? store.revision(entry.id, entry.revision);
  const body = revision?.body;
  const base = {
    id: entry.id,
    scope: entry.scope,
    scopeName: scopeName(entry.scope),
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
    named(store, id) ?? { id, kind: "concept", title: id, retired: true };
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
    status: status(store, entry),
  };
}

export function status(store: KnowledgeStore, entry: EntryRow): FindingStatus {
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
