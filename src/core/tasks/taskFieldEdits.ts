import { fixedHoldWords } from "@shared/holds";
import { placementRequirementsSchema } from "@shared/placement";
import { reasoningWord } from "@shared/reasoning";
import {
  POLICY_CARE_BOUND,
  POLICY_DELIVERY_WORDS,
  POLICY_MERGING_WORDS,
  POLICY_SOURCE_WORDS,
} from "@shared/taskPolicies";
import { taskTitleRefusal } from "@shared/taskTitle";
import { cutText } from "@shared/textCut";
import { RIGOR_WORDS } from "@shared/vocabulary";
import { amendBriefGoal } from "../orchestrator/intentBrief";
import { KIND_SOURCE } from "../routing/kindClassifier";
import { tierFor } from "../routing/policy";
import type { ProjectStore } from "../storage/projectStore";
import type { TaskEventActor } from "../storage/taskEventStore";
import type { TaskRecord, TaskStore } from "../storage/taskRecords";
import type { TaskReferenceKind } from "../storage/taskReferenceStore";
import { repositoryName } from "./repositoryMove";
import { TaskGraphRefusal } from "./taskGraph";
import { referenceRefusal } from "./taskRelationships";
import type { TaskService, UpdateTaskPatch } from "./taskService";
import { keyOrId, type TaskWriter, withShapeKey } from "./taskWriter";

export type TaskFieldEditContext = {
  writer: TaskWriter;
  projects: ProjectStore;
  service: Pick<
    TaskService,
    "moveToProject" | "moveWithinProject" | "resolve" | "setParent" | "policiesOf" | "isClosed"
  >;
};

/**
 * The refusal when start_at_approval names a task that is not one of the
 * task's own blocked_by: the mark is on that wait, so filing and editing
 * refuse it in the same words.
 */
export function startAtApprovalNotABlocker(named: string): string {
  return `start_at_approval names ${named}, which is not one of this task's blocked_by: name the prerequisite whose approved merge starts it, and list it in blocked_by too.`;
}

/**
 * The refusal when needs_merge names a task that is not one of the task's
 * own blocked_by, or the one its start_at_approval names: filing and
 * editing refuse it in the same words.
 */
export function needsMergeRefusal(named: string, startMark: boolean): string {
  // i18n-exempt: a tool answer served to the first mate, not shown to a person
  return startMark
    ? `needs_merge names ${named}, which start_at_approval names too: a task starts at a wait's approval or needs its merge, not both.`
    : `needs_merge names ${named}, which is not one of this task's blocked_by: name only waits whose merge it needs, and list each in blocked_by too.`;
}

/**
 * The waits a task needs merged, by key, from the names given: each one of
 * its own `blocks` prerequisites (`isWait`) and not the one its start mark
 * names. Refused in words otherwise.
 */
export function needsMergeKeys(
  names: readonly string[],
  resolve: (ref: string) => { id: string; key: string } | undefined,
  isWait: (id: string) => boolean,
  startMark: string | undefined,
): string[] {
  const marked = startMark ? resolve(startMark)?.id : undefined;
  const keys: string[] = [];
  for (const name of names.map((entry) => entry.trim()).filter(Boolean)) {
    const task = resolve(name);
    if (!task || !isWait(task.id)) throw new TaskGraphRefusal(needsMergeRefusal(name, false));
    if (task.id === marked) throw new TaskGraphRefusal(needsMergeRefusal(name, true));
    const key = task.key || task.id;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Edit the plain fields of a record; one `note` event lists what changed. */
export function updateTaskFields(
  { writer, projects, service }: TaskFieldEditContext,
  id: string,
  patch: UpdateTaskPatch,
  actor: TaskEventActor,
): string[] {
  // A new title is its author's words: past the room it is refused whole, never cut.
  const titleRefused = patch.title !== undefined ? taskTitleRefusal(patch.title) : undefined;
  if (titleRefused) throw new TaskGraphRefusal(titleRefused);
  const at = writer.now();
  const run = writer.write((): string[] => {
    let record = writer.mustGet(id);
    const changes: string[] = [];
    const from = patch.direction?.trim() ? `, from ${cutText(patch.direction.trim(), 80)}` : "";
    if (patch.correctRequiredAction) {
      const action = record.delivery?.captainAction;
      if (
        !action ||
        record.status !== "done" ||
        (action.state !== "confirmed" && action.state !== "checked")
      )
        throw new TaskGraphRefusal("Only a completed required action can be corrected.");
      writer.patch(id, {
        status: "open",
        closedAt: null,
        closedReason: null,
        gate: { kind: "captain", ref: action.cardId },
        delivery: writer.mergeDelivery(record, {
          captainAction: {
            ...action,
            state: "blocked",
            generation: action.generation + 1,
            completedAt: undefined,
          },
        }),
        updatedAt: at,
      });
      writer.addEvent({
        taskId: id,
        at,
        actor,
        kind: "note",
        text: "The captain corrected the earlier confirmation. This does not reverse work that already continued.",
        data: { previous: action },
        feed: true,
      });
      changes.push("required action reopened; previous confirmation kept in history");
      record = writer.mustGet(id);
    }
    const project =
      patch.project !== undefined
        ? (projects.byKey(patch.project) ?? projects.get(patch.project))
        : undefined;
    if (patch.project !== undefined && !project)
      throw new TaskGraphRefusal(`Unknown project "${patch.project}".`);
    if (project && project.id !== record.projectId) {
      const moved = service.moveToProject(id, project.id, actor, patch.repository);
      if (moved.key !== record.key) changes.push(`moved to ${project.name} as ${moved.key}`);
      record = writer.mustGet(id);
    } else if (patch.repository !== undefined) {
      // Another repository of its own project: its key stays.
      const moved = service.moveWithinProject(id, patch.repository, actor);
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      if (moved) changes.push(`moved to the ${moved} repository`);
      record = writer.mustGet(id);
    }
    if (patch.parent !== undefined) {
      const parent = patch.parent.trim() ? service.resolve(patch.parent.trim()) : undefined;
      if (patch.parent.trim() && !parent)
        throw new TaskGraphRefusal(`Unknown parent "${patch.parent}".`);
      service.setParent(id, parent?.id ?? null, actor);
      changes.push(parent ? `parent ${keyOrId(parent)}` : "parent cleared");
      record = writer.mustGet(id);
    }
    const unstarted =
      record.status === "open" &&
      record.startedAt === null &&
      !record.placement &&
      record.kind === "work";
    if (patch.basis !== undefined && !unstarted) {
      throw new TaskGraphRefusal("A basis can only change on open work that has not started.");
    }
    if (patch.internalStep !== undefined && !unstarted) {
      throw new TaskGraphRefusal(
        "internal_step can only change on open work that has not started.",
      );
    }
    const handOff = [patch.resultSchema, patch.branchFrom, patch.branch];
    if (handOff.some((field) => field !== undefined) && !unstarted) {
      throw new TaskGraphRefusal(
        "A result shape, branch_from or branch can only change on open work that has not started.",
      );
    }
    if (patch.startAtApproval !== undefined && !unstarted) {
      throw new TaskGraphRefusal(
        "start_at_approval can only change on open work that has not started.",
      );
    }
    if (patch.needsMerge !== undefined && !unstarted) {
      // i18n-exempt: a tool answer served to the first mate, not shown to a person
      throw new TaskGraphRefusal("needs_merge can only change on open work that has not started.");
    }

    if (
      patch.programBound !== undefined &&
      (record.status !== "open" ||
        !record.shape?.program ||
        !Number.isInteger(patch.programBound) ||
        patch.programBound < 1)
    ) {
      throw new TaskGraphRefusal(
        "program_bound changes only an open program's bound, to a whole number of at least 1.",
      );
    }
    if (
      patch.speed !== undefined &&
      (record.kind !== "work" || record.status === "done" || record.status === "dropped")
    ) {
      throw new TaskGraphRefusal("Crew speed can only change on unfinished work.");
    }
    if (patch.model !== undefined && (record.status !== "open" || record.kind !== "work")) {
      throw new TaskGraphRefusal(
        "A model can only be named on open work that no crewmate has taken.",
      );
    }
    if (patch.reasoning !== undefined && (record.status !== "open" || record.kind !== "work")) {
      throw new TaskGraphRefusal(
        "A reasoning effort can only be named on open work that no crewmate has taken.",
      );
    }

    if (
      patch.runsOn !== undefined &&
      (record.status !== "open" || record.placement || record.kind !== "work")
    ) {
      throw new TaskGraphRefusal(
        "Where a task runs can change only before it starts; a started task finishes where it started.",
      );
    }

    const update: Parameters<TaskStore["update"]>[1] = {};
    // Relationships change through their checks once the row is written.
    const referenceEdits: [TaskReferenceKind, string | undefined, TaskRecord | undefined][] = [];
    if (patch.placementRequirements !== undefined) {
      if (
        record.status !== "open" ||
        record.kind !== "work" ||
        record.branch ||
        record.sessionFile ||
        record.placement
      )
        throw new TaskGraphRefusal("Computer requirements can change only before the task starts.");
      update.shape = withShapeKey(
        record.shape,
        "placement_requirements",
        patch.placementRequirements
          ? placementRequirementsSchema.parse(patch.placementRequirements)
          : undefined,
      );
      changes.push("computer requirements updated");
    }
    if (patch.basis !== undefined) {
      const basis = patch.basis.trim() ? service.resolve(patch.basis.trim()) : undefined;
      if (patch.basis.trim() && !basis)
        throw new TaskGraphRefusal(`Unknown basis "${patch.basis}".`);
      if (basis?.id === id) throw new TaskGraphRefusal("A task cannot be its own basis.");
      const ref = basis ? keyOrId(basis) : undefined;
      if (ref !== record.shape?.basis) {
        referenceEdits.push(["basis", ref, basis]);
        changes.push(ref ? `basis ${ref}` : "basis cleared");
      }
    }
    if (patch.resultSchema !== undefined) {
      update.shape = withShapeKey(
        update.shape ?? record.shape,
        "result_schema",
        patch.resultSchema || undefined,
      );
      changes.push(patch.resultSchema ? "result shape set" : "result shape cleared");
    }
    if (patch.internalStep !== undefined) {
      if (patch.internalStep !== (record.shape?.internal_step === true)) {
        update.shape = withShapeKey(
          update.shape ?? record.shape,
          "internal_step",
          patch.internalStep ? true : undefined,
        );
        changes.push(patch.internalStep ? "marked an internal step" : "internal step cleared");
      }
    }
    if (patch.branchFrom !== undefined) {
      const branchFrom = patch.branchFrom.trim() || undefined;
      if (branchFrom !== record.shape?.branch_from) {
        referenceEdits.push([
          "branch-source",
          branchFrom,
          branchFrom ? service.resolve(branchFrom) : undefined,
        ]);
        changes.push(branchFrom ? `branches from ${branchFrom}` : "branch_from cleared");
      }
    }
    if (patch.startAtApproval !== undefined) {
      const named = patch.startAtApproval.trim();
      const prerequisite = named ? service.resolve(named) : undefined;
      // The mark is on one of the task's own waits (docs/task-graph.md, "A
      // part that starts at approval"), as filing checks it.
      if (
        named &&
        (!prerequisite ||
          !writer.links.listTo(id, "blocks").some((link) => link.fromId === prerequisite.id))
      )
        throw new TaskGraphRefusal(startAtApprovalNotABlocker(named));
      const mark = prerequisite ? keyOrId(prerequisite) : undefined;
      const current = update.shape ?? record.shape;
      if (mark !== current?.start_at_approval) {
        update.shape = withShapeKey(current, "start_at_approval", mark);
        changes.push(mark ? `starts at ${mark}'s approval` : "start_at_approval cleared");
      }
    }
    if (patch.needsMerge !== undefined || patch.startAtApproval !== undefined) {
      const current = update.shape ?? record.shape;
      const waits = new Set(writer.links.listTo(id, "blocks").map((link) => link.fromId));
      // Checked again when only the start mark moves, so the two never name one wait.
      const keys = needsMergeKeys(
        patch.needsMerge ?? current?.needs_merge ?? [],
        (ref) => service.resolve(ref),
        (wait) => waits.has(wait),
        current?.start_at_approval,
      );
      const before = current?.needs_merge ?? [];
      if (keys.join("\n") !== before.join("\n")) {
        update.shape = withShapeKey(current, "needs_merge", keys.length ? keys : undefined);
        changes.push(`needs_merge ${keys.length ? keys.join(", ") : "[]"}`);
      }
    }
    const branch = patch.branch?.trim() || undefined;
    if (patch.branch !== undefined && branch !== record.shape?.branch) {
      update.shape = withShapeKey(update.shape ?? record.shape, "branch", branch);
      changes.push(branch ? `branch ${branch}` : "branch name cleared");
    }
    if (patch.programBound !== undefined) {
      const current = update.shape ?? record.shape;
      if (current?.program && current.program.bound !== patch.programBound) {
        update.shape = { ...current, program: { ...current.program, bound: patch.programBound } };
        changes.push(`bound ${patch.programBound}`);
      }
    }
    if (patch.speed !== undefined) {
      update.shape = withShapeKey(
        update.shape ?? record.shape,
        "override_speed",
        patch.speed === null ? undefined : patch.speed,
      );
      const words =
        patch.speed === null ? "crew speed follows the model default" : `crew speed ${patch.speed}`;
      changes.push(`${words}${from}`);
    }
    if (patch.reasoning !== undefined) {
      const reasoning = patch.reasoning ?? undefined;
      const current = update.shape ?? record.shape;
      if (reasoning !== current?.override_reasoning) {
        update.shape = withShapeKey(current, "override_reasoning", reasoning || undefined);
        const words = reasoning
          ? `reasoning ${reasoningWord({ level: reasoning }).toLowerCase()}`
          : "reasoning follows Models";
        changes.push(`${words}${from}`);
      }
    }
    if (patch.model !== undefined) {
      const model = patch.model.trim() || undefined;
      const current = update.shape ?? record.shape;
      if (model !== current?.override_model_id) {
        // The rest of the shape stays: only the model the captain named
        // changes, and with it the tier the record computes from it. A
        // kind skipped only because a model was named is asked for again
        // once none is.
        const shape = withShapeKey(
          withShapeKey(current, "placement_fallback_accepted", undefined),
          "override_model_id",
          model,
        );
        update.shape =
          !model && shape.kind_source === `${KIND_SOURCE.skipped}override`
            ? { ...shape, kind_source: "none" }
            : shape;
        update.difficulty = tierFor(update.shape).bucket ?? null;
        changes.push(`${model ? `model ${model}` : "model cleared"}${from}`);
      }
    }
    if (patch.runsOn !== undefined) {
      const ask = patch.runsOn.ask ?? undefined;
      const current = update.shape ?? record.shape;
      if (ask !== current?.runs_on_ask) {
        update.shape = withShapeKey(current, "runs_on_ask", ask || undefined);
        changes.push(`Runs on: ${patch.runsOn.words}${from}`);
      }
    }
    if (patch.policies && Object.keys(patch.policies).length > 0) {
      if (service.isClosed(record) || !service.policiesOf(record)) {
        throw new TaskGraphRefusal(
          `Policies can only change on open work that ships a change; answers, reviews and the personal workspace have no merge policy. ${fixedHoldWords("nothing-to-merge")}`,
        );
      }
      const shape = update.shape ?? record.shape ?? { kind: "unclear" as const };
      const policies = {
        ...shape.policies,
        ...patch.policies,
        revision: (shape.policies?.revision ?? 0) + 1,
      };
      update.shape = { ...shape, policies };
      const next = service.policiesOf({ ...record, shape: update.shape });
      if (!next) throw new TaskGraphRefusal("This task has no delivery policies.");
      for (const key of ["delivery", "autonomy", "rigor"] as const) {
        if (patch.policies[key] === undefined) continue;
        const value =
          key === "delivery"
            ? POLICY_DELIVERY_WORDS[next.delivery.value]
            : key === "autonomy"
              ? POLICY_MERGING_WORDS[next.autonomy.value ? "on" : "off"]
              : RIGOR_WORDS[next.rigor.value];
        changes.push(
          `${key === "autonomy" ? "Merging" : key === "rigor" ? "Rigor" : "Delivery"}: ${value} (${POLICY_SOURCE_WORDS[next[key].source]})${from}`,
        );
      }
      if (next.rigor.requested !== next.rigor.value) changes.push(POLICY_CARE_BOUND);
      // Cancel pending attempts in this same transaction. The revision also
      // invalidates attempts already reading asynchronous checks.
      const cancel =
        patch.policies.delivery !== undefined ||
        (patch.policies.autonomy !== undefined && !next.autonomy.value);
      const approval = record.delivery?.mergeAuthorization;
      if (cancel) {
        update.pendingSettle = null;
        if (approval?.status === "standing") {
          update.delivery = writer.mergeDelivery(record, {
            mergeAuthorization: {
              ...approval,
              status: "invalidated",
              endedAt: at,
              generation: approval.generation + 1,
              reason: "the task's policy changed",
              // Policy reversal is not an explicit withdrawal hold. A merge
              // sent whose outcome is unknown stays (`endedAuthorization`).
              retryAt: undefined,
              waiting: undefined,
              // Approvals of its other pull requests end with it once the
              // supervisor hears the change, which tells its crewmate
              // (INF-2746, `CrewSupervisor.policiesChanged`).
            },
          });
        }
      }
    }
    if (patch.title !== undefined && patch.title !== record.title) {
      update.title = patch.title;
      changes.push(`title "${patch.title}"`);
    }
    if (
      patch.goal !== undefined &&
      (patch.goal !== record.goal ||
        (record.intent && record.intent.goal !== (patch.goal ?? patch.title ?? record.title)))
    ) {
      update.goal = patch.goal;
      // Goal edits amend host scope, never the captain's verbatim words.
      // Both intent and the stored template must change in this transaction.
      if (record.intent)
        update.intent = { ...record.intent, goal: patch.goal ?? patch.title ?? record.title };
      const previousGoal = record.intent?.goal ?? record.goal;
      if (previousGoal != null) {
        update.prompt = amendBriefGoal(
          record.prompt,
          previousGoal,
          patch.goal ?? patch.title ?? record.title,
          record.intent?.userWords,
        );
      }
      changes.push(patch.goal ? `goal "${patch.goal}"` : "goal cleared");
    }
    if (patch.priority !== undefined && patch.priority !== record.priority) {
      update.priority = patch.priority;
      changes.push(`priority ${patch.priority}`);
    }
    if (patch.startPolicy !== undefined && patch.startPolicy !== record.startPolicy) {
      update.startPolicy = patch.startPolicy;
      changes.push(`start policy ${patch.startPolicy}`);
    }
    if (patch.verdict !== undefined) {
      const verdict = cutText(patch.verdict?.trim() ?? "", 280) || null;
      if (verdict !== (record.verdict ?? null)) {
        update.verdict = verdict;
        changes.push(verdict ? `verdict "${verdict}"` : "verdict cleared");
      }
    }
    if (changes.length === 0) return changes;
    // A reference is read with the shape, so a task gains one before its first.
    if (referenceEdits.some(([, ref]) => ref) && !update.shape && !record.shape)
      update.shape = { kind: "unclear" };
    writer.patch(id, { ...update, updatedAt: at });
    for (const [kind, ref, target] of referenceEdits) {
      if (ref) recordReference(writer, writer.mustGet(id), kind, ref, target, actor, at);
      else writer.references.delete(id, kind);
    }
    writer.addEvent({
      taskId: id,
      at,
      actor,
      kind: "note",
      text: update.verdict ? update.verdict : `updated: ${changes.join(", ")}`,
      data: {
        changes: patch,
        ...(("goal" in update || "prompt" in update || "intent" in update) &&
        writer.store.specifications.exists()
          ? {
              specificationRevision: writer.store.specifications.revision(id),
              journal: true,
            }
          : {}),
        ...(update.verdict ? { ledger: "verdict" } : {}),
        news: true,
      },
      feed: Boolean(update.verdict || patch.policies || patch.runsOn),
    });
    return changes;
  });
  return run();
}

/**
 * The one writer of a task's references (INF-1296 piece 2): each kind's
 * rule is checked (`referenceRefusal`), and a refusal is a graph refusal
 * that rolls the write back. The task must already have a shape, which
 * reads it under its older field.
 */
export function recordReference(
  writer: TaskWriter,
  task: TaskRecord,
  kind: TaskReferenceKind,
  ref: string,
  target: TaskRecord | undefined,
  actor: TaskEventActor,
  at: number,
): void {
  const refused = referenceRefusal(kind, {
    task,
    ref,
    target,
    repositoryName: (record) => repositoryName({ writer }, record.projectId, record.repoId),
  });
  if (refused) throw new TaskGraphRefusal(refused);
  writer.references.set(task.id, {
    kind,
    ref,
    targetId: target?.id ?? null,
    actor,
    recordedAt: at,
  });
  writer.touch(task.id);
}
