import { randomUUID } from "node:crypto";
import type { AttachmentRef } from "@shared/attachments";
import { formatDateTime } from "@shared/i18n/format";
import { validationAssignment } from "@shared/liveValidation";
import type { InterruptEventData } from "@shared/provenance";
import { deliveryFor, type RepoDelivery, type RepoView } from "@shared/repos";
import {
  isFolderWork,
  planSkippedText,
  type WorkShape,
  type WorkShapeAsk,
} from "@shared/routingPolicy";
import type { MessageFile } from "../overflow";
import { NOTHING_SPAWNED, type ReviewAssigned } from "../pi/crewTools";
import { programShape } from "../program/programRunner";
import { tierFor } from "../routing/policy";
import type { RouteResult } from "../routing/router";
import type { TaskLinkType } from "../storage/taskLinkStore";
import type { TaskGate, TaskRecord, TaskStartPolicy } from "../storage/taskRecords";
import { TaskGraphRefusal } from "../tasks/taskGraph";
import { TaskService } from "../tasks/taskService";
import type { CardService } from "./cardService";
import type { InterruptSource, TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import {
  assertDeliverableConstraints,
  type FolderBriefFacts,
  type PersonalBriefFacts,
  renderEscalationBrief,
  renderIntentBrief,
  renderReviewBrief,
  type SpawnIntent,
} from "./intentBrief";
import { queueMerges } from "./projectQueue";
import type { Reviews } from "./reviews";
import type { SettleOwners } from "./settleOwners";
import { describeStatus } from "./settleService";
import { workspaceOf } from "./taskClose";
import type { TaskPlacement } from "./taskPlacement";
import {
  type EscalationPlan,
  handOffShape,
  resolveEscalation,
  withBasisVerdict,
  withDeliverable,
  workShape,
} from "./workShape";

/** What the intake reaches of the supervisor beyond its options. */
export type TaskIntakeHost = {
  now(): number;
  /** The card stack: a task's cards, retired when it is replaced or dropped. */
  readonly cards: CardService;
  /** Settling and closing: every close's teardown, and a carried-on close. */
  readonly settling: SettleOwners;
  /** Where each task runs: routing, Runs on, and the waits for a computer. */
  readonly placement: TaskPlacement;
  /** Independent reviews: the builder's branch and evidence a review reads. */
  readonly reviews: Reviews;
  /** The crewmate running a task here now, if one is. */
  runtime(taskId: string): TaskRuntime | undefined;
  /** Let go of a crewmate's session (`CrewSessions.releaseSession`). */
  releaseSession(runtime: TaskRuntime): void;
  /** The supervisor stops tracking a task's crewmate. */
  forgetRuntime(taskId: string): void;
  /** The interrupt request or outcome's timeline event. */
  recordInterrupt(
    taskId: string,
    mode: "interrupt" | "cancel",
    source: InterruptSource,
    effect: InterruptEventData["effect"],
  ): void;
  /** The personal brief's workspace facts, when this build has a personal workspace. */
  personalFacts(): PersonalBriefFacts | undefined;
  /** A task's delivery posture: whether it delivers through a pull request. */
  taskDelivery(taskId: string): RepoDelivery | undefined;
  /** The live review task of a builder, if one is open. */
  openReviewOf(builderId: string): TaskRecord | undefined;
  /** Start one task: worktree, routing, account, session, first turn. */
  startTask(spec: {
    taskId: string;
    title: string;
    brief: string;
    repoId: string | null;
    routed: RouteResult | undefined;
    fresh: boolean;
    /** The first mate's spawn: a failed start keeps the review open (INF-3060). */
    asked?: boolean;
    messageFiles?: readonly MessageFile[];
    attachments?: readonly AttachmentRef[];
  }): Promise<{ taskId: string; crewmate: string }>;
  /** Start a recorded row behind the first mate's answer (`CrewStarts.startBehind`). */
  startBehind(
    taskId: string,
    options: {
      requested: { by: "firstmate"; spawned: true };
      message: { attachments: readonly AttachmentRef[]; files: readonly MessageFile[] };
    },
  ): Promise<void>;
  /** A started task the first mate's answer did not wait for; a failure wakes it. */
  startTaskBehind(
    taskId: string,
    title: string,
    start: () => Promise<unknown>,
    named?: string,
  ): Promise<void>;
  /** Something sent reached a crewmate: one push, and the center draws its spark. */
  announceReach(taskId: string): void;
  /** A program being dropped stops at once and never runs again. */
  haltProgram(programId: string): void;
  /** Tell the window the crew's counts changed. */
  broadcastCrewCounts(): void;
  /** Run the ready sweep now. */
  sweepGates(now: number): Promise<void>;
};

/** The waiting phrased for the feed, at queue time. */
export function gateText(gate: TaskGate): string {
  switch (gate.kind) {
    case "quota-reset":
      return gate.ref?.startsWith("bucket:")
        ? `starts when a ${gate.ref.slice(7)} model has allowance again`
        : `starts when ${gate.ref}'s allowance resets`;
    case "at-time":
      return gate.until !== undefined ? `starts at ${formatDateTime(gate.until)}` : "starts later";
    case "captain":
      return gate.reason ?? "waiting on you";
  }
}

/** A link phrased for tool text: who waits on whom, in keys. */
function linkPhrase(from: TaskRecord, to: TaskRecord, type: TaskLinkType): string {
  const a = from.key || from.id;
  const b = to.key || to.id;
  switch (type) {
    case "blocks":
      return `${a} blocks ${b} (${b} waits until ${a} closes)`;
    case "related":
      return `${a} is related to ${b}`;
    case "discovered-from":
      return `${a} was discovered from ${b}`;
    case "replaced-by":
      return `${a} is replaced by ${b} (${b} does its work)`;
  }
}

/** A blocks edge phrased for the feed (the old after-task wait). */
export function blockedText(blockers: TaskRecord[]): string {
  const names = blockers.map((blocker) => blocker.key).join(" and ");
  return `starts when ${names} ${blockers.length === 1 ? "finishes" : "finish"}`;
}

/**
 * The gate a queued premium ask waits on when no model of its class has
 * quota (P7 + R1): the class's own quota reset, so the sweep starts it when
 * headroom returns and nothing has to be clicked.
 */
export function reasoningWaitGate(bucket: string): TaskGate {
  return { kind: "quota-reset", ref: `bucket:${bucket}` };
}

/**
 * How the crew takes in new work (docs/task-record.md, docs/task-graph.md,
 * docs/programs.md "Filing a program"): a commission, which starts a
 * crewmate now or queues its row; the independent review of a builder's
 * change; a planned row, a program among them; an escalation that replaces
 * the attempt the captain rejected; and the task graph's links, drops and
 * carry-ons, with the container that closes once everything under it has.
 * Every refusal is a loud error or tool text before a row exists. The crew
 * supervisor composes it and its callers reach it as
 * `CrewSupervisor.intake`.
 */
export class TaskIntake {
  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: TaskIntakeHost,
  ) {}

  /**
   * Commission a crewmate (the spawn_crewmate tool). Fail-loud: an unknown
   * repoId rejects rather than silently landing in the default workspace.
   * Returns the admission handle as soon as the crewmate starts; results
   * flow back through the hooks, never through this promise.
   *
   * With start_after (R1) the work is queued instead: a row with a gate,
   * no worktree and no session until the ready sweep dispatches it. An
   * explicit reasoning ask that cannot be served right now also queues,
   * behind one decision card, rather than silently downgrading (P7).
   */
  async commission(input: {
    title: string;
    /** The structured intent (spawn v2); the host renders the fixed brief. */
    intent: SpawnIntent;
    repoId?: string;
    /**
     * The facts the Firstmate supplied (contract v2.8): a basis task, the
     * captain's premium ask, a model he named. The host checks the basis
     * and computes the tier; the Firstmate judges no class.
     */
    shape?: WorkShapeAsk;
    /** R1: queue behind a gate instead of starting now. */
    startAfter?: { afterTask?: string; whenQuotaResets?: string; at?: number };
    /** The graph (P2): a parent, blockers (queues the work), a priority. */
    parent?: string;
    blockedBy?: string[];
    priority?: number;
    /**
     * The copies of the pictures on the captain's message that asked for
     * this work. Its brief carries them before that message attaches to
     * the new task; a queued row reads them from the task once it has.
     */
    messageFiles?: readonly MessageFile[];
    attachments?: readonly AttachmentRef[];
  }): Promise<{
    taskId: string;
    /** `starting` for a start behind the answer (INF-3060), or `queued` for a wait. */
    crewmate: string;
    /** Settles once a start behind the answer has started, waited or failed. */
    started?: Promise<void>;
    /** A review ask's assigned version (INF-3141). */
    review?: ReviewAssigned;
  }> {
    assertDeliverableConstraints(input.intent, input.shape?.in_folder === true);
    // An independent review (delivery rigor phase 2) is its own commission:
    // the host briefs it from the record and holds nothing on the builder
    // (INF-1876).
    if (input.shape?.review_of?.trim()) {
      if (input.shape.in_folder)
        throw new Error(`${NOTHING_SPAWNED} A review reads its builder's branch; omit in_folder.`);
      // Review placement belongs to the builder, never a second choice.
      if (input.shape.runs_on_ask?.trim())
        throw new Error(
          `${NOTHING_SPAWNED} A review follows its builder's computer; omit runs_on_ask.`,
        );
      return this.commissionReview(
        {
          ...input,
          behind: true,
          ...(input.shape.override_model_id?.trim()
            ? { named: input.shape.override_model_id.trim() }
            : {}),
        },
        input.shape.review_of.trim(),
      );
    }
    // A personal-ui ask is bound by the host (Step 4): the personal
    // workspace, registered on first need, whatever repo_id came with it.
    const personalRepo = input.intent.kind === "personal-ui" ? this.personalRepo() : undefined;
    // An escalation is resolved FIRST (S4): every refusal - an unknown or
    // never-run task, a lineage past its bound, nothing above premium -
    // happens before a row, a worktree or a rejection exists.
    const escalation = resolveEscalation(
      (ref, param) => this.resolveTaskRef(ref, param),
      input.shape?.escalate_from,
      input.shape?.premium_ask,
    );
    const inheritedDeliveryAsk =
      input.shape?.delivery_ask ?? escalation?.previous.shape?.delivery_ask;
    const placement = this.resolveGraphPlacement(
      personalRepo
        ? { ...input, repoId: personalRepo.id }
        : escalation
          ? {
              ...input,
              // The lineage stays where it was: same repository, same
              // parent, so the fresh attempt lands in the same project.
              // The previous task's delivery_ask rides too, so the brief
              // matches the shape workShape will stamp.
              ...((input.repoId ?? escalation.previous.repoId)
                ? { repoId: input.repoId ?? escalation.previous.repoId ?? undefined }
                : {}),
              ...((input.parent ?? escalation.previous.parentId)
                ? { parent: input.parent ?? escalation.previous.parentId ?? undefined }
                : {}),
              ...(inheritedDeliveryAsk
                ? { shape: { ...input.shape, delivery_ask: inheritedDeliveryAsk } }
                : {}),
            }
          : input,
    );
    const boundRepoId = placement.repoId;
    // The fixed template is host-rendered from the intent (contract v1):
    // no model authors the crewmate's first message. An escalation adds
    // one host-written section about the attempt it replaces.
    const personal = placement.personal ? this.host.personalFacts() : undefined;
    // Two kinds of task are told no delivery posture at all, because
    // neither ships a change through one: a personal task builds in place
    // (Task A), and an ANSWER task commits nothing, pushes nothing and
    // opens no pull request (Task B). So the brief is rendered from the
    // shape, once the deliverable on it is settled.
    // Folder work (INF-567) ships nothing either, and is told the folder.
    const renderBrief = (shaped: WorkShape): string => {
      // A stronger-model retry of folder work inherits it with no ask of its own.
      const inheritedRepo =
        !placement.folder && isFolderWork(shaped.in_place) && boundRepoId
          ? this.options.repos.get(boundRepoId)
          : undefined;
      const folder =
        placement.folder ??
        (inheritedRepo ? { project: inheritedRepo.name, folder: inheritedRepo.path } : undefined);
      const delivery =
        placement.personal || folder || shaped.deliverable !== "change"
          ? undefined
          : placement.delivery;
      return escalation
        ? renderEscalationBrief(
            input.intent,
            delivery,
            escalation.facts,
            personal ? { ...personal, ongoing: shaped.ongoing } : undefined,
            folder,
            queueMerges(placement.repoId ? this.options.repos.get(placement.repoId) : undefined),
          )
        : renderIntentBrief(
            input.intent,
            delivery,
            personal ? { ...personal, ongoing: shaped.ongoing } : undefined,
            folder,
            queueMerges(placement.repoId ? this.options.repos.get(placement.repoId) : undefined),
          );
    };
    const taskId = randomUUID().slice(0, 8);
    const title = (input.title.trim() || input.intent.goal || "Task").slice(0, 64);
    // Where the captain said it runs is checked before a row exists
    // (docs/helper.md, "A task's own Runs on").
    let runsOnAsk: string | undefined;
    try {
      runsOnAsk = input.shape?.runs_on_ask?.trim()
        ? this.host.placement.resolveRunsOn(input.shape.runs_on_ask)
        : undefined;
    } catch (caught) {
      throw new Error(
        `${NOTHING_SPAWNED} ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
    const runsOnRefused =
      runsOnAsk &&
      this.host.placement.placeRefusal(`"${title}"`, { repoId: boundRepoId }, runsOnAsk);
    if (runsOnRefused) throw new Error(`${NOTHING_SPAWNED} ${runsOnRefused}`);
    const handOff = handOffShape(this.options.tasks, input.shape, boundRepoId);
    if ("refused" in handOff) throw new Error(`${NOTHING_SPAWNED} ${handOff.refused}`);
    const shape = withDeliverable(
      {
        ...workShape(this.options.tasks, input.shape, escalation),
        ...handOff,
        ...(runsOnAsk ? { runs_on_ask: runsOnAsk } : {}),
      },
      input.intent,
    );
    const graph = {
      ...(placement.parentId ? { parentId: placement.parentId } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    };

    if (input.startAfter || placement.blockedBy.length > 0) {
      const wait = this.waitFromStartAfter(input.startAfter ?? {}, placement.blockedBy);
      // The kind is established at gate-open, so this row's deliverable is
      // what its typed constraints alone say; `classifyQueued` re-derives it
      // from the classifier's kind and `dispatchQueuedTask` re-renders the
      // brief if that changes the answer.
      this.insertQueuedWork(taskId, title, renderBrief(shape), input.intent, boundRepoId, shape, {
        ...wait,
        ...graph,
      });
      this.announcePlanSkip(shape);
      const blockers = this.options.tasks.graph.blockers(taskId);
      if (escalation) await this.applyEscalation(escalation, taskId);
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Queued "${title}" - ${wait.gate ? gateText(wait.gate) : blockedText(blockers)}.`,
      });
      this.host.broadcastCrewCounts();
      return { taskId, crewmate: "queued" };
    }

    // The first mate's spawn is recorded now and starts behind its answer
    // (INF-3060): classification, placement, routing and the working copy
    // can take minutes on another computer, and the captain's reply waited
    // on them. The row starts through the queue's own path with the
    // message's pictures and files; `started` settles when that start has.
    this.insertQueuedWork(
      taskId,
      title,
      renderBrief(shape),
      input.intent,
      boundRepoId,
      shape,
      graph,
    );
    if (escalation) await this.applyEscalation(escalation, taskId);
    this.announcePlanSkip(shape);
    const started = this.host.startBehind(taskId, {
      requested: { by: "firstmate", spawned: true },
      message: { attachments: input.attachments ?? [], files: input.messageFiles ?? [] },
    });
    this.host.broadcastCrewCounts();
    return { taskId, crewmate: "starting", started };
  }

  /** Presentation of the agent's declaration, never a host gate or inference. */
  private announcePlanSkip(shape: WorkShape): void {
    if (!shape.skipped_plan_because?.trim()) return;
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: planSkippedText(shape.skipped_plan_because),
    });
  }

  /**
   * Commission the independent reviewer of a task's change (delivery rigor
   * phase 2; a review at any care since INF-1875). Every refusal is a loud
   * tool error before a row exists: the builder must be crewmate work that
   * is still open, must have reported, must have commits on its branch to
   * read, and must not already have a review open. The reviewer reads the
   * builder's branch at its current head (worktrees share the repository's
   * refs, so the diff against the default branch is the change); whether
   * the push, PR and CI wait for the pass is the care guidance's, which
   * the builder follows. An existing PR never hides a
   * newer builder version; an unreadable current branch holds the review.
   * The reviewer is a fresh crewmate on the
   * builder's repository, briefed by the host with the fixed review text,
   * its shape `review` established by the host and never the classifier,
   * and linked `blocks` onto the builder so the builder's close waits on
   * its verdict. It is read-only by brief, not by jail - like every
   * crewmate's isolation.
   */
  async commissionReview(
    input: {
      title: string;
      intent: SpawnIntent;
      repoId?: string;
      priority?: number;
      /** The first mate's spawn: answered once the review is recorded (INF-3060). */
      behind?: boolean;
      /** The model the first mate's words named, told beside the one that took it (FI3-444). */
      named?: string;
    },
    reviewOf: string,
  ): Promise<{
    taskId: string;
    crewmate: string;
    started?: Promise<void>;
    review: ReviewAssigned;
  }> {
    const builder = this.resolveTaskRef(reviewOf, "review_of");
    const handle = builder.key || builder.id;
    if (builder.kind !== "work") {
      throw new Error(
        `${handle} is not crewmate work, so there is no change to review. review_of names the task whose branch an independent reviewer should read.`,
      );
    }
    if (builder.status === "done" || builder.status === "dropped") {
      throw new Error(
        `${handle} is already ${describeStatus(builder)}; there is nothing left to review.`,
      );
    }
    // A review is an operation on a change at a version (INF-1875): any
    // change with commits can be reviewed on request, at any care. Care is
    // a name the record carries; what it asks for is runbook guidance.
    const delivery = this.host.taskDelivery(builder.id) ?? "local-only";
    // The reviewer reads the builder's branch at its current head and
    // evidence, including unpublished repairs to an existing PR.
    const facts = await this.host.reviews.reviewFacts(builder);
    const { headSha, prUrl } = facts;
    const open = this.host.openReviewOf(builder.id);
    if (open) {
      throw new Error(
        `${handle} already has a review open: ${open.key || open.id} "${open.title}". Steer it to re-review at the new head instead of spawning another.`,
      );
    }
    if (input.repoId && input.repoId !== builder.repoId) {
      throw new Error(
        `review_of ${handle} is on another repository than repo_id "${input.repoId}"; pass the builder's repo_id or omit it.`,
      );
    }
    const intent: SpawnIntent = {
      ...input.intent,
      goal: `Review the change for "${builder.title}" and report findings.`,
    };
    // A review after an earlier pass reads only what changed since that
    // pass (INF-401), and only the live proof at the passed version itself
    // (INF-2672): the passed version rides the brief and this review's own
    // record, so its later turns keep the same scope.
    const passedHead =
      builder.delivery?.reviewVerdict === "pass" ? builder.delivery.reviewSha : undefined;
    const brief = renderReviewBrief(
      intent,
      delivery,
      passedHead ? { ...facts, passedHead } : facts,
      queueMerges(builder.repoId ? this.options.repos.get(builder.repoId) : undefined),
    );
    const taskId = randomUUID().slice(0, 8);
    const title = `Review: ${builder.title}`.slice(0, 64);
    // The host establishes the kind: a review is never classified, and its
    // basis is the builder, whose report it reads. The builder join is the
    // parent edge below, never a shape field.
    const shape = withBasisVerdict(this.options.tasks, {
      kind: "review",
      kind_source: "host:review",
      basis: builder.id,
    });
    // Prefer another provider on the builder's computer, never move the
    // review to another computer just to get a different provider.
    const avoidProvider = this.options.router?.servedProvider(builder.id);
    const routed = await this.host.placement.routeTask(
      taskId,
      brief,
      shape,
      builder.deviceId ?? null,
      avoidProvider,
      (routed) => {
        // Two asks for the same review at once - the captain's click and the
        // first mate's spawn - open one review: the second finds the first.
        const raced = this.host.openReviewOf(builder.id);
        if (raced) {
          throw new Error(
            `${handle} already has a review open: ${raced.key || raced.id} "${raced.title}". Steer it to re-review at the new head instead of spawning another.`,
          );
        }
        this.options.tasks.create({
          id: taskId,
          kind: "work",
          title,
          prompt: brief,
          intent,
          repoId: builder.repoId,
          difficulty: routed?.bucket ?? tierFor(shape).bucket ?? null,
          shape,
          status: "active",
          // The review is the builder's own delivery machinery: a CHILD of the
          // builder (the one stored join), host-fenced against re-parenting,
          // excluded from the children-open close gate, and retired by the
          // builder's close whatever its direction (`retireDeliveryChildren`).
          parentId: builder.id,
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
        });
        this.options.tasks.placement.setDevice(taskId, builder.deviceId ?? null);
        this.options.tasks.delivery.recordChangeEvidence(taskId, {
          headSha,
          ...(facts.changeReading ? { reviewChange: facts.changeReading } : {}),
          ...(passedHead ? { passedHead } : {}),
          validationAssignment: validationAssignment(builder.delivery?.liveValidation, headSha),
        });
      },
    );
    // No hold: the parent edge is the one join, a child out of the close
    // gate holds nothing, and whether a merge waits for the verdict is the
    // care runbook's guidance, never a host edge (INF-1876).
    this.options.tasks.delivery.recordChangeEvidence(
      builder.id,
      {},
      {
        kind: "review",
        text: `review opened - ${title} reads branch ${builder.branch} at ${headSha.slice(0, 7)}${
          passedHead === headSha
            ? ", only the live proof, its code passed there"
            : passedHead
              ? `, only what changed since the pass at ${passedHead.slice(0, 7)}`
              : ""
        }${prUrl ? ` (pull request ${prUrl} is not the assigned head)` : ""}`,
        feed: false,
        data: { reviewTaskId: taskId },
      },
    );
    const start = () =>
      this.host.startTask({
        taskId,
        title,
        brief,
        repoId: builder.repoId,
        routed,
        fresh: true,
        ...(input.behind ? { asked: true } : {}),
      });
    // The answer names the version assigned, and whether the builder holds
    // edits not yet committed, which the review cannot see (INF-3141).
    const review = { head: headSha, uncommitted: await this.uncommitted(builder) };
    // The first mate's spawn answers once the review is recorded (INF-3060).
    if (input.behind) {
      const started = this.host.startTaskBehind(taskId, title, start, input.named);
      return { taskId, crewmate: "starting", started, review };
    }
    return { ...(await start()), review };
  }

  /** Whether a builder's working copy holds edits not yet committed; null when unreadable. */
  private async uncommitted(builder: TaskRecord): Promise<boolean | null> {
    const status = await (builder.deviceId
      ? (this.options.machines?.workStatus(builder.id) ?? Promise.resolve(null))
      : builder.worktreeDir && builder.branch
        ? this.options.workspace.taskWorkStatus(workspaceOf(builder), { strict: true })
        : Promise.resolve(null)
    ).catch(() => null);
    return status ? status.dirty : null;
  }

  /** The personal workspace as a repo (Step 4), or a loud refusal when this build has none. */
  private personalRepo(): RepoView {
    const personal = this.options.personal;
    if (!personal) {
      throw new Error("Personal panels are not available in this build; nothing was started.");
    }
    return personal.repo();
  }

  /**
   * Record work (create_task, design section 7): an open row that waits
   * on request by default, or dispatches with the ready
   * sweep when its policy is when-ready and nothing blocks or holds it. A
   * pure container (a parent with no crewmate of its own) is exactly this.
   * The row carries a shape the way a queued spawn does, so it dispatches
   * from what it was planned with: a basis named here is usually still
   * running, and its verdict is derived again when the row dispatches.
   * `alongside` is the caller's own writes about the new row, such as a
   * program's found-on link and its origin's wait: they commit with the
   * row, so no reader ever sees it without them (INF-3046).
   */
  plan(
    input: {
      title: string;
      intent: SpawnIntent;
      repoId?: string;
      parent?: string;
      blockedBy?: string[];
      startPolicy?: TaskStartPolicy;
      priority?: number;
      shape?: WorkShapeAsk;
    },
    alongside?: (record: TaskRecord) => void,
  ): TaskRecord {
    const placement = this.resolveGraphPlacement(input);
    const brief = renderIntentBrief(
      input.intent,
      placement.folder ? undefined : placement.delivery,
      undefined,
      placement.folder,
      queueMerges(placement.repoId ? this.options.repos.get(placement.repoId) : undefined),
    );
    const taskId = randomUUID().slice(0, 8);
    const title = (input.title.trim() || input.intent.goal || "Task").slice(0, 64);
    const handOff = handOffShape(this.options.tasks, input.shape, placement.repoId);
    if ("refused" in handOff) throw new TaskGraphRefusal(`Nothing was filed. ${handOff.refused}`);
    const program = input.shape?.program
      ? programShape(input.shape, placement.repoId, placement.personal, this.options.programProcess)
      : undefined;
    if (typeof program === "string") throw new TaskGraphRefusal(`Nothing was filed. ${program}`);
    const shape = withDeliverable(
      {
        ...workShape(this.options.tasks, input.shape),
        ...handOff,
        ...(program ? { program } : {}),
      },
      input.intent,
    );
    const file = (): TaskRecord => {
      const filed = this.options.tasks.create({
        id: taskId,
        kind: "work",
        title,
        prompt: brief,
        intent: input.intent,
        repoId: placement.repoId,
        difficulty: tierFor(shape).bucket ?? null,
        shape,
        ...(placement.parentId ? { parentId: placement.parentId } : {}),
        ...(placement.blockedBy.length > 0 ? { blockedBy: placement.blockedBy } : {}),
        startPolicy: input.startPolicy ?? "on-request",
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        status: "open",
      });
      alongside?.(filed);
      return filed;
    };
    // The feed line and the sweep below follow the one commit.
    const record = alongside ? this.options.tasks.atomic(file, () => {}) : file();
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: `Planned "${title}" (${record.key}) - ${this.plannedWaiting(record)}.`,
    });
    this.host.broadcastCrewCounts();
    // A when-ready plan with nothing in its way starts on this very sweep.
    void this.host.sweepGates(this.host.now());
    return record;
  }

  /**
   * How a row plan() filed waits, phrased for the feed and the first mate's
   * reply: it carries no gate, only its blockers. Work on request waits in
   * the backlog for a Start whatever it is blocked by, and only queued work
   * starts with its moment (INF-2715: file means the backlog).
   */
  plannedWaiting(record: TaskRecord): string {
    if (record.startPolicy === "on-request") return "waits in the backlog";
    const waiting = this.options.tasks.graph.waitingOn(record.id);
    return waiting.length > 0 ? blockedText(waiting) : "starts now";
  }

  /**
   * The graph placement a spawn or plan asks for: the repo (fail-loud on an
   * unknown id), the parent (inherits the repo when none was named), and
   * the blockers - ids or keys, each resolved against the record.
   */
  resolveGraphPlacement(input: {
    repoId?: string;
    parent?: string;
    blockedBy?: string[];
    intent?: SpawnIntent;
    shape?: WorkShapeAsk;
  }): {
    repoId: string | null;
    delivery: RepoDelivery;
    /** The bound repository is the personal workspace: it builds in place. */
    personal: boolean;
    /** The project and folder declared folder work works in (INF-567). */
    folder?: FolderBriefFacts;
    parentId: string | undefined;
    blockedBy: string[];
  } {
    const parent = input.parent?.trim() ? this.resolveTaskRef(input.parent, "parent") : undefined;
    let repoId: string | null = parent?.repoId ?? null;
    if (input.repoId) {
      const repo = this.options.repos.get(input.repoId);
      if (!repo) {
        throw new Error(
          `Unknown repo_id "${input.repoId}". Use a repo_id from the context block, or omit it for the default workspace.`,
        );
      }
      repoId = repo.id;
    }
    const repo = repoId ? this.options.repos.get(repoId) : undefined;
    const folder = input.shape?.in_folder ? this.folderWorkOf(repo, input.shape) : undefined;
    const delivery = this.resolveSpawnDelivery(repo, input.intent, input.shape);
    const blockedBy = [
      ...new Set((input.blockedBy ?? []).map((ref) => this.resolveTaskRef(ref, "blocked_by").id)),
    ];
    return {
      repoId,
      delivery,
      personal: repo?.kind === "personal",
      ...(folder ? { folder } : {}),
      parentId: parent?.id,
      blockedBy,
    };
  }

  /**
   * The project and folder a task declared as folder work works in
   * (INF-567): a registered project of the captain's, never the personal
   * workspace, which builds in place already. The folder decides where it
   * runs and that it ships nothing, so a Runs on, a delivery or a review
   * named beside it is refused.
   */
  private folderWorkOf(repo: RepoView | undefined, ask: WorkShapeAsk): FolderBriefFacts {
    if (!repo) {
      throw new Error(
        `${NOTHING_SPAWNED} in_folder needs a project: pass the repo_id of the project whose folder the task works in.`,
      );
    }
    if (repo.kind === "personal") {
      throw new Error(
        `${NOTHING_SPAWNED} The personal workspace already builds in place; omit in_folder.`,
      );
    }
    const clash = ask.runs_on_ask?.trim()
      ? "runs_on_ask"
      : ask.delivery_ask
        ? "delivery_ask"
        : ask.review_of?.trim()
          ? "review_of"
          : undefined;
    if (clash) {
      throw new Error(
        `${NOTHING_SPAWNED} Folder work runs on the computer keeping ${repo.name}'s folder and ships nothing; omit ${clash}.`,
      );
    }
    return { project: repo.name, folder: repo.path };
  }

  /**
   * The posture this spawn ships at: the captain's ask for this task, else
   * the repository's default. The personal workspace takes neither - it
   * builds in place - so its tasks carry the local-only nobody reads.
   */
  private resolveSpawnDelivery(
    repo: RepoView | undefined,
    intent: SpawnIntent | undefined,
    shape: WorkShapeAsk | undefined,
  ): RepoDelivery {
    const personal = repo?.kind === "personal" || intent?.kind === "personal-ui";
    const ask = shape?.delivery_ask;
    if (ask === "direct-pr" && !personal) {
      if (!repo) {
        throw new Error(
          'delivery_ask "direct-pr" needs a managed repository to open a PR on. Omit it for the default workspace, or pass repo_id.',
        );
      }
      if (!repo.origin) {
        throw new Error(
          `delivery_ask "direct-pr" needs a remote to open a PR on; ${repo.name} has none. Configure a remote, or omit delivery_ask to stay local-only.`,
        );
      }
    }
    if (personal) return "local-only";
    return deliveryFor({ repo: repo?.delivery, ask }).delivery;
  }

  /**
   * The escalation, once the fresh row exists (report section 4 steps 4-6):
   * the lineage edge, the rejected attempt stopped and closed superseded
   * with its branch kept, and the two `escalated` timeline rows - of which
   * the rejected attempt's is the move's one feed line. Nothing here is a
   * card: the now panel simply shows the new row underway and the old one
   * gone, which is the captain's own principle for finished work.
   */
  private async applyEscalation(plan: EscalationPlan, freshId: string): Promise<void> {
    const fresh = this.options.tasks.get(freshId);
    if (!fresh) return;
    // The captain's chosen link: provenance only. A discovered-from edge
    // gates no readiness and holds no close, so the fresh attempt starts
    // although its origin is still being closed below.
    this.options.tasks.graph.link(fresh.id, plan.previous.id, "discovered-from", "captain");
    this.options.tasks.turns.recordEscalation({
      from: { id: plan.previous.id, key: plan.previous.key || plan.previous.id },
      to: { id: fresh.id, key: fresh.key || fresh.id },
      attempt: plan.stamp.attempt,
      tier: plan.stamp.floor,
    });
    await this.supersedeAttempt(plan.previous.id, fresh.key || fresh.id);
  }

  /**
   * Retire the attempt the captain rejected (O1: "Close it
   * dropped/superseded"). A running turn is interrupted the way a close
   * interrupts one; the record closes dropped with `escalated_to`, its
   * lane and cards go with it; and the worktree retires like every closed
   * task's (2026-09-22), its work always saved on the kept ref the fresh
   * attempt's brief names.
   *
   * The close's own feed line is suppressed: the `escalated` line already
   * says this row was replaced and names its successor.
   */
  private async supersedeAttempt(taskId: string, continuesAs: string): Promise<void> {
    const record = this.options.tasks.get(taskId);
    if (!record) return;
    this.options.killJobs?.(taskId);
    this.options.personal?.endLiveTask(taskId);
    const runtime = this.host.runtime(taskId);
    if (runtime) {
      runtime.turn.request("cancel");
      await runtime.session?.abort().catch(() => {});
      this.host.releaseSession(runtime);
      this.host.forgetRuntime(taskId);
      this.host.settling.locks.turnEnded(taskId);
    }
    this.host.recordInterrupt(
      taskId,
      "interrupt",
      { actor: "captain", via: "tool", decision: null },
      runtime ? "aborted-turn" : "no-turn",
    );
    if (record.status !== "done" && record.status !== "dropped") {
      this.host.settling.closing.closeAndPurge([taskId], () =>
        this.options.tasks.close(taskId, {
          status: "dropped",
          reason: "superseded",
          actor: "captain",
          feed: false,
          data: { escalated_to: continuesAs },
        }),
      );
      await this.host.settling.closing.closeOpenPullRequest(taskId);
    } else {
      this.options.inbox.purgeTask(taskId);
    }
    this.host.cards.retireTaskCards(taskId, "superseded");
    this.host.cards.scheduleBroadcast();
    this.host.broadcastCrewCounts();
    await this.host.settling.closing.retireDeliveryChildren(taskId, record.title);
    await this.host.settling.closing.retireWorkspace(taskId, { keepAlways: true });
    void this.host.sweepGates(this.host.now());
  }

  /** A task by id or key, or a loud error naming the parameter at fault. */
  resolveTaskRef(ref: string, param: string): TaskRecord {
    const record = this.options.tasks.resolve(ref);
    if (!record) {
      throw new Error(
        `Unknown task "${ref}" in ${param}. Use a task id or key from the context's crew, crew_status, or the tasks tool.`,
      );
    }
    return record;
  }

  /**
   * The wait a start_after asks for: another task closing is a `blocks`
   * edge (task-system P0; the old after-task gate, kept as an alias of
   * blocked_by), the rest are holds.
   */
  private waitFromStartAfter(
    startAfter: {
      afterTask?: string;
      whenQuotaResets?: string;
      at?: number;
    },
    blockedBy: string[] = [],
  ): { gate?: TaskGate; blockedBy?: string[] } {
    const blockers = [...blockedBy];
    if (startAfter.afterTask) {
      const after = this.options.tasks.resolve(startAfter.afterTask);
      if (!after) {
        throw new Error(
          `Unknown task "${startAfter.afterTask}" in start_after. Use a task id from crew_status.`,
        );
      }
      if (!blockers.includes(after.id)) blockers.push(after.id);
    }
    if (startAfter.whenQuotaResets) {
      if (this.options.quotaGateRefValid?.(startAfter.whenQuotaResets) === false) {
        throw new Error(
          `Unknown quota scope "${startAfter.whenQuotaResets}" in start_after. ` +
            "Use a provider name from the quota line, or bucket:premium / bucket:high / bucket:medium / bucket:low.",
        );
      }
      return {
        gate: { kind: "quota-reset", ref: startAfter.whenQuotaResets },
        ...(blockers.length > 0 ? { blockedBy: blockers } : {}),
      };
    }
    if (startAfter.at !== undefined) {
      return {
        gate: { kind: "at-time", until: startAfter.at },
        ...(blockers.length > 0 ? { blockedBy: blockers } : {}),
      };
    }
    if (blockers.length > 0) return { blockedBy: blockers };
    throw new Error("start_after needs after_task, when_quota_resets, or at_time.");
  }

  private insertQueuedWork(
    taskId: string,
    title: string,
    brief: string,
    intent: SpawnIntent,
    repoId: string | null,
    shape: WorkShape,
    wait: { gate?: TaskGate; blockedBy?: string[]; parentId?: string; priority?: number },
  ): void {
    this.options.tasks.create({
      id: taskId,
      kind: "work",
      title,
      prompt: brief,
      intent,
      repoId,
      // The tier the table gives this shape; R0 leaves it to the pin's own
      // slot, which only the router can resolve, so the row records none.
      difficulty: tierFor(shape).bucket ?? null,
      shape,
      ...(wait.gate ? { gate: wait.gate } : {}),
      ...(wait.blockedBy ? { blockedBy: wait.blockedBy } : {}),
      ...(wait.parentId ? { parentId: wait.parentId } : {}),
      ...(wait.priority !== undefined ? { priority: wait.priority } : {}),
      status: "open",
    });
  }

  /**
   * A container completes with its children (docs/task-graph.md, "The
   * close rules"). A parent that never started - on request, no crewmate,
   * no working copy - has nothing of its own to settle, so nothing else
   * could ever close it; once every child is closed it closes too: done
   * when any child is done, else dropped. A parent that carries a
   * crewmate, ever started, still has an open child, or has a card of its
   * own waiting on the captain is left exactly as it is.
   */
  completeContainers(): void {
    for (const record of this.options.tasks.listOpen()) {
      if (record.kind !== "work" || record.startPolicy !== "on-request") continue;
      if (
        record.startedAt !== null ||
        record.worktreeDir ||
        this.host.runtime(record.id) !== undefined
      )
        continue;
      // A program closes when its script ends, not when its parts so far have.
      if (record.shape?.program) continue;
      const children = this.options.tasks.graph.children(record.id);
      if (children.length === 0 || children.some((child) => !TaskService.isClosed(child))) {
        continue;
      }
      if (this.host.cards.snapshot().some((card) => card.taskId === record.id)) continue;
      const done = children.some((child) => child.status === "done");
      this.host.settling.closing.closeAndPurge([record.id], () =>
        this.options.tasks.close(record.id, {
          status: done ? "done" : "dropped",
          reason: done ? "finished" : "cancelled",
          actor: "host",
          text: done ? "everything under it is finished" : "nothing under it went ahead",
          data: { container: true },
        }),
      );
      this.host.broadcastCrewCounts();
    }
  }

  /**
   * link_tasks: a typed edge between two records, ids or keys. A `blocks`
   * edge that would close a cycle is refused as tool text (never thrown),
   * and any change re-runs the ready query.
   */
  linkTasks(fromRef: string, toRef: string, type: TaskLinkType): string {
    const from = this.resolveTaskRef(fromRef, "from");
    const to = this.resolveTaskRef(toRef, "to");
    let created: boolean;
    try {
      created = this.options.tasks.graph.link(from.id, to.id, type, "firstmate");
    } catch (caught) {
      if (caught instanceof TaskGraphRefusal) return caught.message;
      throw caught;
    }
    const phrase = linkPhrase(from, to, type);
    if (!created) return `${phrase} was already recorded.`;
    // Its tasks changed, though neither crewmate hears it: each sparks.
    this.host.announceReach(from.id);
    this.host.announceReach(to.id);
    this.graphChanged();
    return `Recorded: ${phrase}.`;
  }

  /**
   * link_tasks with remove: the edge goes, and the ready query judges the
   * row again on the sweep - a dead wait ends with its edge, nothing to
   * lift.
   */
  unlinkTasks(fromRef: string, toRef: string, type: TaskLinkType): string {
    const from = this.resolveTaskRef(fromRef, "from");
    const to = this.resolveTaskRef(toRef, "to");
    const removed = this.options.tasks.graph.unlink(from.id, to.id, type, "firstmate");
    const phrase = linkPhrase(from, to, type);
    if (!removed) return `No such link: ${phrase}.`;
    this.host.announceReach(from.id);
    this.host.announceReach(to.id);
    this.graphChanged();
    return `Removed: ${phrase}.`;
  }

  /** A graph or field change: counts move, and the ready query runs again. */
  graphChanged(): void {
    this.host.broadcastCrewCounts();
    void this.host.sweepGates(this.host.now());
  }

  /**
   * update_task drop: an open row (planned or queued work) closes as
   * dropped. A parent with open children needs `confirm`, which drops
   * them too as superseded (design section 7). Work a crewmate holds is
   * settle_task's business - it has the unlanded-work guard - so this
   * refuses rather than tearing a worktree down from a field edit.
   * `replacedBy` names the task that does its work instead, linked
   * `replaced-by` before the close (docs/task-record.md, "Whom an event
   * concerns").
   */
  dropTask(
    taskRef: string,
    input: {
      reason: string;
      confirm?: boolean;
      replacedBy?: string;
      /** Who drops it: the crewmate that started a program stops its own. */
      actor?: "firstmate" | "crewmate";
    },
  ): string {
    const actor = input.actor ?? "firstmate";
    const record = this.resolveTaskRef(taskRef, "task");
    const replacement = input.replacedBy
      ? this.resolveTaskRef(input.replacedBy, "replaced_by")
      : undefined;
    const handle = `${record.key || record.id} "${record.title}"`;
    if (record.status !== "open") {
      return record.status === "active"
        ? `Cannot drop ${handle} here: a crewmate holds it. Use settle_task (discard) for work that has started, or done with why carried_on when another task carries its work.`
        : `${handle} is already ${describeStatus(record)}.`;
    }
    const started = this.options.tasks.graph
      .descendants(record.id)
      .filter((child) => child.status === "active");
    if (record.shape?.program) {
      // With no part started, the close below may refuse for its open parts: then the program runs on.
      const refusal =
        started.length === 0 ? this.options.tasks.graph.closeRefusal(record.id) : undefined;
      if (refusal && !input.confirm) return refusal.text;
      // A dropped program stops at once and files nothing more; its started
      // parts close first, their work saved, and then it drops (INF-799).
      this.host.haltProgram(record.id);
      if (started.length > 0) {
        void (async () => {
          for (const part of started)
            await this.host.settling.closing.closeTask(part.id, {
              status: "dropped",
              reason: "superseded",
              actor,
              text: "superseded - its program was dropped",
            });
          this.dropTask(record.id, { ...input, confirm: true });
        })().catch((caught: unknown) => console.warn("[program] drop did not finish:", caught));
        const names = started.map((child) => child.key || child.id).join(", ");
        return `Dropping ${handle}: its program stopped, and its started ${started.length === 1 ? "part" : "parts"} ${names} close first, their work saved.`;
      }
    }
    if (started.length > 0) {
      const names = started.map((child) => `${child.key || child.id} "${child.title}"`).join(", ");
      return `Cannot drop ${handle}: ${started.length === 1 ? "its child has" : "children have"} started (${names}). Settle them first.`;
    }
    const refusal = this.options.tasks.graph.closeRefusal(record.id);
    if (refusal && !input.confirm) return refusal.text;
    const affected = [
      record.id,
      ...this.options.tasks.graph.descendants(record.id).map((c) => c.id),
    ];
    const dropped = this.host.settling.closing.closeAndPurge(affected, () =>
      this.options.tasks.dropWithChildren(record.id, {
        reason: input.reason,
        actor,
        ...(replacement ? { replacedBy: replacement.id } : {}),
      }),
    );
    this.host.cards.retireTaskCards(record.id, replacement ? "superseded" : "dropped");
    for (const child of dropped) this.host.cards.retireTaskCards(child.id, "superseded");
    // Work another task carries on closed done through it (INF-1825).
    const other = replacement ? replacement.key || replacement.id : "";
    const parts =
      dropped.length > 0
        ? `${dropped.length} ${dropped.length === 1 ? "child" : "children"} under it`
        : "";
    this.options.broadcastEvent({
      type: "firstmate_note",
      text: replacement
        ? `"${record.title}" (${record.key}) is carried on by ${other}${parts ? `; dropped ${parts}` : ""}.`
        : `Dropped "${record.title}" (${record.key})${parts ? ` and ${parts}` : ""} - ${input.reason}.`,
    });
    this.host.cards.scheduleBroadcast();
    this.graphChanged();
    const named = dropped.map((child) => child.key || child.id).join(", ");
    if (replacement)
      return `Closed ${handle} as done: ${other} carries on its work.${named ? ` Dropped ${named} as superseded.` : ""}`;
    return dropped.length > 0
      ? `Dropped ${handle} and ${named} as superseded.`
      : `Dropped ${handle}.`;
  }
}
