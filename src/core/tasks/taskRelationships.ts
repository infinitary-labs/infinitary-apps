import type { TaskLinkType } from "../storage/taskLinkStore";
import type { TaskRecord } from "../storage/taskRecords";
import type { TaskReferenceKind } from "../storage/taskReferenceStore";

/**
 * The checked relationships between tasks (INF-1296 piece 2,
 * `docs/task-record.md` "Relationships"): one contract over the parent
 * edge, the typed links and the three references a task names one of.
 * Each kind keeps its own rule; what they share is how they are read.
 */
export type TaskRelationshipKind = "parent" | TaskLinkType | TaskReferenceKind;

export type TaskRelationshipRule = {
  /** How many of this kind one task names. */
  cardinality: "one" | "many";
  /**
   * Whether it holds the start of the task it points at until its other end
   * closes done. Only a dependency does; the ready query reads only that.
   */
  holdsStart: boolean;
  refusesCycles: boolean;
  /** Where the other task must be: the child moves into its parent's project. */
  scope: "joins-project" | "same-repository" | "any";
  /** Whether a name that resolves to no task is kept as named, to resolve later. */
  keepsUnresolved: boolean;
  /** Where it is stored, its one writer being TaskService. */
  store: "tasks.parent_id" | "task_links" | "task_references";
};

export const TASK_RELATIONSHIP_RULES = {
  parent: {
    cardinality: "one",
    holdsStart: false,
    refusesCycles: true,
    scope: "joins-project",
    keepsUnresolved: false,
    store: "tasks.parent_id",
  },
  blocks: {
    cardinality: "many",
    holdsStart: true,
    refusesCycles: true,
    scope: "any",
    keepsUnresolved: false,
    store: "task_links",
  },
  related: {
    cardinality: "many",
    holdsStart: false,
    refusesCycles: false,
    scope: "any",
    keepsUnresolved: false,
    store: "task_links",
  },
  "discovered-from": {
    cardinality: "many",
    holdsStart: false,
    refusesCycles: false,
    scope: "any",
    keepsUnresolved: false,
    store: "task_links",
  },
  "replaced-by": {
    cardinality: "many",
    holdsStart: false,
    refusesCycles: false,
    scope: "any",
    keepsUnresolved: false,
    store: "task_links",
  },
  // A basis is derived verified at every read (`TaskService.graph.basisHolds`),
  // so a spawn's name stands as named; update_task refuses an unknown one.
  basis: {
    cardinality: "one",
    holdsStart: false,
    refusesCycles: false,
    scope: "any",
    keepsUnresolved: true,
    store: "task_references",
  },
  // Its working copy's start is checked again when the task starts
  // (`branchFromSource` in `workShape.ts`), which also needs saved work.
  "branch-source": {
    cardinality: "one",
    holdsStart: false,
    refusesCycles: false,
    scope: "same-repository",
    keepsUnresolved: false,
    store: "task_references",
  },
  // The escalation stamp beside it stays the attempt's execution fact.
  "retry-of": {
    cardinality: "one",
    holdsStart: false,
    refusesCycles: false,
    scope: "any",
    keepsUnresolved: false,
    store: "task_references",
  },
} as const satisfies Record<TaskRelationshipKind, TaskRelationshipRule>;

/** What a reference's check reads: the task, and what its name resolved to. */
export type ReferenceCheck = {
  task: Pick<TaskRecord, "id" | "repoId">;
  ref: string;
  target: Pick<TaskRecord, "id" | "key" | "repoId"> | undefined;
};

const REFERENCE_WORDS: Record<TaskReferenceKind, string> = {
  basis: "basis",
  "branch-source": "branch_from",
  "retry-of": "escalate_from",
};

/**
 * Why a reference cannot be recorded, in words a tool call reads, or
 * undefined when its kind's rule holds. The rule's own words, never a
 * judgment of whether the named task is any good as one.
 */
export function referenceRefusal(
  kind: TaskReferenceKind,
  check: ReferenceCheck,
): string | undefined {
  const rule = TASK_RELATIONSHIP_RULES[kind];
  const field = REFERENCE_WORDS[kind];
  if (!check.ref.trim()) return `An empty ${field} names no task.`;
  if (!check.target)
    return rule.keepsUnresolved
      ? undefined
      : `Unknown ${field} "${check.ref}": name a task by its key.`;
  if (check.target.id === check.task.id)
    return kind === "branch-source"
      ? "A task cannot branch from itself."
      : `A task cannot be its own ${kind === "basis" ? "basis" : "earlier attempt"}.`;
  if (rule.scope === "same-repository" && check.target.repoId !== check.task.repoId)
    return `${field} ${check.target.key || check.target.id} is in another project; a task branches only from work in its own project.`;
  return undefined;
}
