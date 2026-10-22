import { z } from "zod";

/**
 * The knowledge browser's reads (docs/knowledge.md, "The browser"): what
 * the captain's window reads personal knowledge and standing directions in
 * every build. Personal entries live in the captain collection, directions
 * in the captain or exact project scope. Graphs and lists are bounded for
 * a window, with totals saying how much a page left out. Reads never write
 * a record, declare a use or grant permission.
 */

/** The most a graph read draws: concepts, and the connections among them. */
export const KNOWLEDGE_GRAPH_LIMITS = { concepts: 75, connections: 200 } as const;

/** Rows a page of the Concepts or Findings list holds. */
export const KNOWLEDGE_LIST_PAGE = 20;

/** The words a Find narrows by, at most. */
const QUERY_MAX = 200;

const scopeSchema = z.string().min(1).max(64);
const entryIdSchema = z.string().regex(/^[cf]-[a-z0-9]{6}$/);

/** Why a collection cannot be read just now, in the app's words; never a zero. */
const unavailableSchema = z.object({ state: z.literal("unavailable"), reason: z.string() });

/** One end of a connection or a reference, by name. */
export const knowledgeNamedSchema = z.object({
  id: z.string(),
  kind: z.enum(["concept", "finding"]),
  title: z.string(),
  retired: z.boolean(),
});
export type KnowledgeNamed = z.infer<typeof knowledgeNamedSchema>;

/**
 * Where a finding stands, as one word the browser shows: `differing` when a
 * check with evidence or another finding contradicts it (or a check without
 * evidence challenges it), `recheck` when a source it cites changed or is
 * gone since it was kept, `checked` when its current revision has a
 * supporting check with evidence, else `unchecked`; `superseded` and
 * `retired` before all of them.
 */
export const knowledgeStandingSchema = z.enum([
  "checked",
  "unchecked",
  "recheck",
  "differing",
  "superseded",
  "retired",
]);
export type KnowledgeStanding = z.infer<typeof knowledgeStandingSchema>;

/** What a finding asks of its reader: both can hold at once. */
export const knowledgeAttentionSchema = z.object({
  recheck: z.boolean(),
  differing: z.boolean(),
});
export type KnowledgeAttention = z.infer<typeof knowledgeAttentionSchema>;

// -- the collections -------------------------------------------------------

export const knowledgeCollectionSchema = z.object({
  /** `captain` for the private collection, else the project's id. */
  scope: scopeSchema,
  /** The project's name; empty for the private collection, which the browser names itself. */
  name: z.string(),
  private: z.boolean(),
  concepts: z.number().int().nonnegative(),
  findings: z.number().int().nonnegative(),
  /** Optional for clients of an older minor. */
  directions: z.number().int().nonnegative().optional(),
});
export type KnowledgeCollection = z.infer<typeof knowledgeCollectionSchema>;

/** `knowledge.collections`: the private collection first, then each project's by name. */
export const knowledgeCollectionsSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), collections: z.array(knowledgeCollectionSchema) }),
  unavailableSchema,
]);
export type KnowledgeCollections = z.infer<typeof knowledgeCollectionsSchema>;

// -- the graph ---------------------------------------------------------------

export const knowledgeGraphArgsSchema = z.strictObject({
  scope: scopeSchema,
  /** A concept whose neighborhood alone is drawn. */
  focus: entryIdSchema.optional(),
  /** How far from `focus`: one hop or two. */
  hops: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Words that narrow the graph to the concepts they find. */
  query: z.string().max(QUERY_MAX).optional(),
});
export type KnowledgeGraphArgs = z.infer<typeof knowledgeGraphArgsSchema>;

export const knowledgeGraphConceptSchema = z.object({
  id: z.string(),
  title: z.string(),
  aliases: z.array(z.string()),
  /** Active findings about it. */
  findings: z.number().int().nonnegative(),
  /** Connections it has in the whole collection, drawn or not. */
  degree: z.number().int().nonnegative(),
});
export type KnowledgeGraphConcept = z.infer<typeof knowledgeGraphConceptSchema>;

/**
 * A connection between two concepts. A `claim` is a finding's relationship,
 * directed from its subject to its object and labeled with the finding's own
 * predicate; it is no truer than that finding. A `context` link is a
 * concept's read-together suggestion with its reason: undirected, never a
 * claim.
 */
export const knowledgeConnectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claim"),
    /** `claim:<finding id>`. */
    id: z.string(),
    from: z.string(),
    to: z.string(),
    predicate: z.string(),
    finding: z.string(),
    standing: knowledgeStandingSchema,
  }),
  z.object({
    kind: z.literal("context"),
    /** `context:<declaring concept>:<other concept>`. */
    id: z.string(),
    from: z.string(),
    to: z.string(),
    reason: z.string(),
  }),
]);
export type KnowledgeConnection = z.infer<typeof knowledgeConnectionSchema>;

const graphCountsSchema = z.object({
  concepts: z.number().int().nonnegative(),
  connections: z.number().int().nonnegative(),
});

/**
 * `knowledge.graph`: the concepts of one collection and the connections
 * among them - its most connected first, or the neighborhood of `focus`, or
 * what `query` finds - with how many there are in all (`total`, after the
 * focus or the words narrowed it) beside how many are drawn (`shown`).
 */
export const knowledgeGraphSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    scope: scopeSchema,
    /** The concept the neighborhood is around, while it is still in the collection. */
    focus: z.string().nullable(),
    concepts: z.array(knowledgeGraphConceptSchema),
    connections: z.array(knowledgeConnectionSchema),
    shown: graphCountsSchema,
    total: graphCountsSchema,
  }),
  unavailableSchema,
]);
export type KnowledgeGraph = z.infer<typeof knowledgeGraphSchema>;

// -- the lists ---------------------------------------------------------------

export const knowledgeConceptsArgsSchema = z.strictObject({
  scope: scopeSchema,
  query: z.string().max(QUERY_MAX).optional(),
  /** From 0. */
  page: z.number().int().min(0).max(10_000).optional(),
});
export type KnowledgeConceptsArgs = z.infer<typeof knowledgeConceptsArgsSchema>;

export const knowledgeConceptRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  aliases: z.array(z.string()),
  explanation: z.string(),
  findings: z.number().int().nonnegative(),
});
export type KnowledgeConceptRow = z.infer<typeof knowledgeConceptRowSchema>;

/** `knowledge.concepts`: a page of a collection's concepts, by name, or as Find ranks them. */
export const knowledgeConceptsSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    scope: scopeSchema,
    rows: z.array(knowledgeConceptRowSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().nonnegative(),
  }),
  unavailableSchema,
]);
export type KnowledgeConcepts = z.infer<typeof knowledgeConceptsSchema>;

/** Which findings the list shows: all, those whose sources changed, or those with differing evidence. */
export const knowledgeFindingFilterSchema = z.enum(["all", "recheck", "differing"]);
export type KnowledgeFindingFilter = z.infer<typeof knowledgeFindingFilterSchema>;

export const knowledgeFindingsArgsSchema = z.strictObject({
  scope: scopeSchema,
  query: z.string().max(QUERY_MAX).optional(),
  filter: knowledgeFindingFilterSchema.optional(),
  page: z.number().int().min(0).max(10_000).optional(),
});
export type KnowledgeFindingsArgs = z.infer<typeof knowledgeFindingsArgsSchema>;

export const knowledgeRelationshipSchema = z.object({
  from: knowledgeNamedSchema,
  predicate: z.string(),
  to: knowledgeNamedSchema,
});
export type KnowledgeRelationship = z.infer<typeof knowledgeRelationshipSchema>;

export const knowledgeFindingRowSchema = z.object({
  id: z.string(),
  statement: z.string(),
  basis: z.enum(["observation", "inference"]),
  /** Where it holds, in its author's words. */
  conditions: z.string(),
  about: z.array(knowledgeNamedSchema),
  relationship: knowledgeRelationshipSchema.nullable(),
  standing: knowledgeStandingSchema,
  attention: knowledgeAttentionSchema,
  /** Sources its current revision cites, and checks that support it with evidence. */
  sources: z.number().int().nonnegative(),
  checks: z.number().int().nonnegative(),
});
export type KnowledgeFindingRow = z.infer<typeof knowledgeFindingRowSchema>;

/** `knowledge.findings`: a page of a collection's findings, newest first, or as Find ranks them. */
export const knowledgeFindingsSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    scope: scopeSchema,
    rows: z.array(knowledgeFindingRowSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().nonnegative(),
  }),
  unavailableSchema,
]);
export type KnowledgeFindings = z.infer<typeof knowledgeFindingsSchema>;

// -- standing directions -------------------------------

/** Directions are instructions or advice, never ordinary findings or permissions. */
export const knowledgeDirectionRowSchema = z.object({
  id: z.string(),
  kind: z.literal("direction"),
  text: z.string(),
  scope: scopeSchema,
  scopeName: z.string(),
  origin: z.string(),
  authority: z.enum(["instruction", "advice"]),
  revision: z.number().int().positive(),
  updatedAt: z.number(),
});
export type KnowledgeDirectionRow = z.infer<typeof knowledgeDirectionRowSchema>;

export const knowledgeDirectionsArgsSchema = knowledgeConceptsArgsSchema;
export type KnowledgeDirectionsArgs = z.infer<typeof knowledgeDirectionsArgsSchema>;
export const knowledgeDirectionsSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    scope: scopeSchema,
    rows: z.array(knowledgeDirectionRowSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().nonnegative(),
  }),
  unavailableSchema,
]);
export type KnowledgeDirections = z.infer<typeof knowledgeDirectionsSchema>;

/** A standing direction and the edits made in Knowledge. */
export const knowledgeDirectionArgsSchema = z.strictObject({
  id: z.string().min(1).max(64),
  page: z.number().int().min(0).max(10_000).optional(),
});
export type KnowledgeDirectionArgs = z.infer<typeof knowledgeDirectionArgsSchema>;
export const knowledgeDirectionSchema = knowledgeDirectionRowSchema.extend({
  retired: z.boolean(),
  createdAt: z.number(),
  history: z.array(
    z.object({
      revision: z.number().int().positive(),
      op: z.enum(["publish", "revise", "retire"]),
      text: z.string(),
      origin: z.string(),
      scope: scopeSchema,
      evidence: z.string(),
      at: z.number(),
    }),
  ),
  page: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type KnowledgeDirection = z.infer<typeof knowledgeDirectionSchema>;
export const knowledgeDirectionReadSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), direction: knowledgeDirectionSchema }),
  z.object({ state: z.literal("missing") }),
  unavailableSchema,
]);
export type KnowledgeDirectionRead = z.infer<typeof knowledgeDirectionReadSchema>;

/**
 * One change to a standing direction (`inf:knowledge:direction:set`), the
 * app action catalog's `direction` line (src/shared/actions.ts): the
 * captain's window and the first mate's app_change ask this one channel
 * (INF-638). revise and retire check `expectedRevision` when it is given;
 * the reason is kept in the direction's history.
 */
const directionChangeIdSchema = z.string().regex(/^(d:)?[a-z0-9][a-z0-9-]{0,63}$/);
const directionChangeTextSchema = z.string().min(1).max(4000);
const directionChangeReasonSchema = z.string().min(1).max(400);
const directionChangeRevisionSchema = z.number().int().positive().optional();
export const knowledgeDirectionChangeSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("add"),
    /** A new id of the caller's choosing; the app makes one when it is absent. */
    id: directionChangeIdSchema.optional(),
    text: directionChangeTextSchema,
    /** `captain` for everywhere, or one project's id. */
    scope: scopeSchema.optional(),
    reason: directionChangeReasonSchema,
  }),
  z.strictObject({
    op: z.literal("revise"),
    id: directionChangeIdSchema,
    text: directionChangeTextSchema,
    expectedRevision: directionChangeRevisionSchema,
    reason: directionChangeReasonSchema,
  }),
  z.strictObject({
    op: z.literal("retire"),
    id: directionChangeIdSchema,
    expectedRevision: directionChangeRevisionSchema,
    reason: directionChangeReasonSchema,
  }),
]);
export type KnowledgeDirectionChange = z.infer<typeof knowledgeDirectionChangeSchema>;
/** The direction as the change left it. */
export const knowledgeDirectionChangedSchema = z.object({
  op: z.enum(["add", "revise", "retire"]),
  direction: knowledgeDirectionRowSchema,
});
export type KnowledgeDirectionChanged = z.infer<typeof knowledgeDirectionChangedSchema>;

// -- one entry ---------------------------------------------------------------

export const knowledgeEntryArgsSchema = z.strictObject({
  id: entryIdSchema,
  /** An earlier revision to read instead of the current one. */
  revision: z.number().int().positive().optional(),
});
export type KnowledgeEntryArgs = z.infer<typeof knowledgeEntryArgsSchema>;

/** Where a kept source came from: a file, a task's report, a quotation, or a saved article. */
export const knowledgeOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
    /** The working copy's commit when it was kept; null when it had none. */
    commit: z.string().nullable(),
    /** The file differed from that commit when it was kept. */
    dirty: z.boolean(),
  }),
  z.object({ kind: z.literal("report"), key: z.string(), event: z.number().int() }),
  z.object({ kind: z.literal("quote"), citation: z.string() }),
  z.object({
    kind: z.literal("article"),
    url: z.string(),
    title: z.string(),
    author: z.string().nullable(),
    published: z.string().nullable(),
    retrieved: z.number(),
  }),
]);
export type KnowledgeOrigin = z.infer<typeof knowledgeOriginSchema>;

/** A kept source, whole, and whether it still reads the same where its project lives. */
export const knowledgeSourceSchema = z.object({
  id: z.string(),
  origin: knowledgeOriginSchema,
  /** The text kept when it was cited, at most 32 KB. */
  text: z.string(),
  capturedAt: z.number(),
  check: z.object({
    state: z.enum(["unchanged", "changed", "missing", "unknown", "kept"]),
    detail: z.string(),
  }),
});
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

export const knowledgeCheckSchema = z.object({
  id: z.string(),
  /** The finding's revision it checked. */
  revision: z.number().int().positive(),
  verdict: z.enum(["supports", "contradicts", "inconclusive"]),
  method: z.string(),
  conditions: z.string(),
  /** Who checked it: Firstmate, or a crewmate by its task. */
  by: z.string(),
  at: z.number(),
  sources: z.array(knowledgeSourceSchema),
});
export type KnowledgeCheck = z.infer<typeof knowledgeCheckSchema>;

export const knowledgeRevisionSchema = z.object({
  revision: z.number().int().positive(),
  op: z.enum(["publish", "revise", "link", "retire", "restore"]),
  by: z.string(),
  reason: z.string(),
  at: z.number(),
  /** A concept's title or a finding's statement, as that revision said it. */
  title: z.string(),
});
export type KnowledgeRevision = z.infer<typeof knowledgeRevisionSchema>;

/** A disagreement or replacement between two findings, with its reason. */
export const knowledgeRelationSchema = z.object({
  type: z.enum(["contradicts", "supersedes", "duplicates"]),
  reason: z.string(),
  other: knowledgeNamedSchema,
  /** This entry declares it (it contradicts, supersedes or duplicates the other). */
  outgoing: z.boolean(),
  by: z.string(),
  at: z.number(),
});
export type KnowledgeRelation = z.infer<typeof knowledgeRelationSchema>;

/** A use some work declared: the revision it relied on, and why. */
export const knowledgeUseSchema = z.object({
  revision: z.number().int().positive(),
  by: z.string(),
  /** The task's key, when the use was a task's. */
  task: z.string().nullable(),
  purpose: z.string(),
  at: z.number(),
});
export type KnowledgeUse = z.infer<typeof knowledgeUseSchema>;

/** A connection as a concept's inspector lists it. */
export const knowledgeEntryConnectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("claim"),
    id: z.string(),
    finding: z.string(),
    from: knowledgeNamedSchema,
    predicate: z.string(),
    to: knowledgeNamedSchema,
    standing: knowledgeStandingSchema,
  }),
  z.object({
    kind: z.literal("context"),
    id: z.string(),
    from: knowledgeNamedSchema,
    to: knowledgeNamedSchema,
    reason: z.string(),
  }),
]);
export type KnowledgeEntryConnection = z.infer<typeof knowledgeEntryConnectionSchema>;

/** The most a concept's inspector lists of its findings; `findingsTotal` counts them all. */
export const KNOWLEDGE_ENTRY_FINDINGS = 20;

export const knowledgeEntrySchema = z.object({
  id: z.string(),
  scope: scopeSchema,
  kind: z.enum(["concept", "finding"]),
  /** The revision shown, and the entry's current one. */
  revision: z.number().int().positive(),
  current: z.number().int().positive(),
  retired: z.boolean(),
  /** A concept's title or a finding's statement. */
  title: z.string(),
  aliases: z.array(z.string()),
  /** A concept's explanation; empty for a finding. */
  explanation: z.string(),
  basis: z.enum(["observation", "inference"]).nullable(),
  conditions: z.string(),
  about: z.array(knowledgeNamedSchema),
  relationship: knowledgeRelationshipSchema.nullable(),
  /** A finding's standing and what it asks; null for a concept. */
  standing: knowledgeStandingSchema.nullable(),
  attention: knowledgeAttentionSchema.nullable(),
  author: z.string(),
  createdAt: z.number(),
  /** When the shown revision was made. */
  at: z.number(),
  /** A concept's connections, claimed and read-together. */
  connections: z.array(knowledgeEntryConnectionSchema),
  /** A concept's active findings, newest first, at most `KNOWLEDGE_ENTRY_FINDINGS`. */
  findings: z.array(
    z.object({ id: z.string(), statement: z.string(), standing: knowledgeStandingSchema }),
  ),
  findingsTotal: z.number().int().nonnegative(),
  sources: z.array(knowledgeSourceSchema),
  checks: z.array(knowledgeCheckSchema),
  /** Earlier revisions, newest first, at most twenty, and how many older ones are not listed. */
  revisions: z.array(knowledgeRevisionSchema),
  olderRevisions: z.number().int().nonnegative(),
  relations: z.array(knowledgeRelationSchema),
  uses: z.object({
    count: z.number().int().nonnegative(),
    recent: z.array(knowledgeUseSchema),
  }),
});
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;

/** `knowledge.entry`: one entry whole, or `missing` for one no collection the window reads holds. */
export const knowledgeEntryReadSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), entry: knowledgeEntrySchema }),
  z.object({ state: z.literal("missing") }),
  unavailableSchema,
]);
export type KnowledgeEntryRead = z.infer<typeof knowledgeEntryReadSchema>;

/**
 * A finding's standing in words, for the app's own surfaces outside the
 * browser: a reference in a card body. The browser's chips say the same
 * words from its own folder (`src/panels/knowledge/words.ts`), which a test
 * holds equal.
 */
export const KNOWLEDGE_STANDING_WORDS: Record<KnowledgeStanding, string> = {
  checked: "Checked",
  unchecked: "Not yet checked",
  recheck: "Needs rechecking",
  differing: "Differing evidence",
  superseded: "Superseded",
  retired: "Retired",
};

// -- references in a card body ------------------------------------------------

/**
 * An entry's id as text writes it (docs/knowledge.md, "References in an
 * answer"): `c-` or `f-` and six lowercase letters or digits, a word of its
 * own - `xf-abc123` and `f-abc1234` name nothing. Shape is only a candidate:
 * a card body links an id only once the window has read an entry with
 * exactly that id.
 */
export const KNOWLEDGE_ID_IN_TEXT = "(?<![A-Za-z0-9_-])[cf]-[a-z0-9]{6}(?![A-Za-z0-9_-])";

/** One id alone, as a bridge message carries it. */
export const KNOWLEDGE_ID_EXACT = /^[cf]-[a-z0-9]{6}$/;

/** The ids one body may link; past this, later ids stay text. */
export const KNOWLEDGE_REFS_MAX = 32;

/** The distinct entry ids `text` writes, in order of first mention, at most KNOWLEDGE_REFS_MAX. */
export function knowledgeIdsIn(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(new RegExp(KNOWLEDGE_ID_IN_TEXT, "g"))) {
    if (ids.includes(match[0])) continue;
    ids.push(match[0]);
    if (ids.length === KNOWLEDGE_REFS_MAX) break;
  }
  return ids;
}

export const knowledgeRefsArgsSchema = z.strictObject({
  ids: z.array(entryIdSchema).min(1).max(KNOWLEDGE_REFS_MAX),
});
export type KnowledgeRefsArgs = z.infer<typeof knowledgeRefsArgsSchema>;

/** An entry a card body names, as its reference shows it: what it is and where it stands now. */
export const knowledgeRefSchema = z.object({
  id: z.string(),
  kind: z.enum(["concept", "finding"]),
  scope: scopeSchema,
  /** A concept's title or a finding's statement, as its current revision says it. */
  title: z.string(),
  revision: z.number().int().positive(),
  retired: z.boolean(),
  /** A finding's standing now; null for a concept. */
  standing: knowledgeStandingSchema.nullable(),
});
export type KnowledgeRef = z.infer<typeof knowledgeRefSchema>;

/**
 * `knowledge.refs`: the entries among `ids` that a collection the window
 * reads holds, in the order asked; an id no such collection holds is left
 * out, exactly as one that does not exist.
 */
export const knowledgeRefsSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), refs: z.array(knowledgeRefSchema) }),
  unavailableSchema,
]);
export type KnowledgeRefs = z.infer<typeof knowledgeRefsSchema>;

// -- a task's declared uses ---------------------------------------------------

/** The most declared uses a task record lists; `total` counts them all. */
export const KNOWLEDGE_TASK_USES = 20;

export const knowledgeUsesArgsSchema = z.strictObject({ task: z.string().min(1).max(64) });
export type KnowledgeUsesArgs = z.infer<typeof knowledgeUsesArgsSchema>;

/**
 * One entry a task's work declared it relied on: the revision it used, as
 * that revision said it, beside the entry's current revision. A record of
 * what was declared, never changed by reading it.
 */
export const knowledgeTaskUseSchema = z.object({
  id: z.string(),
  kind: z.enum(["concept", "finding"]),
  scope: scopeSchema,
  /** The revision the work used, and what it said then. */
  revision: z.number().int().positive(),
  title: z.string(),
  /** The entry's current revision, and what it says now. */
  current: z.number().int().positive(),
  currentTitle: z.string(),
  retired: z.boolean(),
  /** A finding's standing now; null for a concept. */
  standing: knowledgeStandingSchema.nullable(),
  /** Why the work relied on it, in its own words. */
  purpose: z.string(),
  at: z.number(),
});
export type KnowledgeTaskUse = z.infer<typeof knowledgeTaskUseSchema>;

/**
 * `knowledge.uses`: what one task's work declared it used, newest first -
 * each entry and revision once - in the collections the window reads, at
 * most `KNOWLEDGE_TASK_USES`.
 */
export const knowledgeUsesSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    uses: z.array(knowledgeTaskUseSchema),
    total: z.number().int().nonnegative(),
  }),
  unavailableSchema,
]);
export type KnowledgeUses = z.infer<typeof knowledgeUsesSchema>;

/** Every knowledge read's refusal where the build has none (docs/knowledge.md, "Who has it"). */
export const KNOWLEDGE_OFF = "Knowledge is not part of this build.";
