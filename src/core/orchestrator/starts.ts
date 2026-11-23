import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AttachmentRef } from "@shared/attachments";
import { isClientIssueReason } from "@shared/claudeClient";
import { preparedPublicationRemote } from "@shared/contributions";
import { COMPUTER, HERE } from "@shared/deviceNames";
import { levelModel, levelModels, levelName } from "@shared/levelWords";
import { placementNamedModelWait, UNCOMPARED_WAIT } from "@shared/placement";
import { TASK_CARD_VIA } from "@shared/provenance";
import { catalogEntry } from "@shared/providers";
import { opensPullRequest } from "@shared/repos";
import {
  isFolderRepair,
  isFolderWork,
  isPullRepair,
  levelDefaultReasoning,
  type WorkShape,
} from "@shared/routingPolicy";
import { CUT_OFF_REFUSED, CUT_OFF_SIGNED_OUT } from "../accounts/credentialHealth";
import { DeviceOutOfReachError } from "../connection/connection";
import { capWithOverflow, type MessageFile } from "../overflow";
import { type PlacedCopy, PreparationUnknown } from "../placed/placedCopies";
import { KIND_SOURCE, kindEstablished } from "../routing/kindClassifier";
import { legacyShapeFromDifficulty, tierFor } from "../routing/policy";
import { type RouteResult, requiresReasoningWait } from "../routing/router";
import { isDowngrade } from "../routing/routingEngine";
import { OpenReads } from "../session/openReads";
import { LOCAL_MACHINE_ID } from "../session/session";
import type { TaskGate, TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { UNCONFIRMED_START_RETURNED } from "../tasks/taskStarts";
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import { taskRemoteName } from "../workspace/git";
import { type TaskBranchStem, taskBranchStem } from "../workspace/taskBranches";
import type { DispatchBase, WorktreeAcquisition } from "../workspace/workspaceService";
import { briefCarriesPictures, type CrewBrief } from "./crewBrief";
import type { CrewCore } from "./crewCore";
import type { TaskRuntime } from "./crewRuntime";
import { CrewTurn } from "./crewTurn";
import type { RunningJob } from "./idleLadder";
import { levelGateEnd } from "./intake";
import {
  type BriefPart,
  briefText,
  renderIntentBrief,
  renderPullRepairBrief,
  withDeliveryLine,
} from "./intentBrief";
import { unnamedBackgroundWork } from "./jobWakes";
import { lostComputer, lostStartLine, lostTwiceReason, type StartStep } from "./lostStarts";
import { namedModelDiffers, namedModelOf } from "./namedModel";
import { ReasoningHolds } from "./reasoningHolds";
import { StartFailure, StartSettle, startFailureReason } from "./startSettle";
import { computerLeftOutWake, namedModelWaitWake, systemWaitWake } from "./startWakes";
import { withAttachmentsKept } from "./wakes";
import {
  branchFromSource,
  classifyShape,
  deliverableOf,
  withBasisVerdict,
  withDeliverable,
  workShape,
} from "./workShape";

export { StartFailure, startFailureReason };

/** The same waiting phrased at dispatch, once it cleared. */
function gateClearedText(gate: TaskGate): string {
  switch (gate.kind) {
    case "quota-reset":
      return gate.ref?.startsWith("bucket:")
        ? `a ${gate.ref.slice(7)} model ${levelGateEnd(gate, "has allowance again")}`
        : `${gate.ref}'s allowance is back`;
    case "at-time":
      return "its time arrived";
    case "captain":
      return "you said to";
  }
}

/**
 * The timeline line a dispatch leaves about its working copy: reused warm
 * from the pool or made new, and the commit it starts from. A failed
 * refresh of the default branch is said, never hidden - the task still
 * starts, from what this machine last saw.
 */
function worktreeText(acquired: WorktreeAcquisition, where?: string, branch?: string): string {
  const on = where ? ` on ${where}` : "";
  const copy =
    acquired.source === "pool"
      ? `a warm working copy was reused${on}`
      : `a new working copy was made${on}`;
  const { base } = acquired;
  const prefix = branch ? `${taskRemoteName(branch)}/` : "";
  const ref = prefix && base.ref.startsWith(prefix) ? base.ref.slice(prefix.length) : base.ref;
  switch (base.fetch) {
    case "fetched":
      return `${copy}, starting from the latest ${ref}`;
    case "failed":
      return `${copy}; ${ref} could not be refreshed (${base.fetchError ?? "unknown error"}), so it starts from the last one this machine saw`;
    case "none":
      return `${copy}, starting from ${ref === "HEAD" ? "the project's current commit" : ref}`;
  }
}

/**
 * The feed's line when a task is served from a weaker slot than it asked for
 * (P7: never a silent downgrade). When a withheld account would have served
 * the slot asked for, the line says what withholds it; when that slot's models
 * that could serve read text only and the task carries pictures, it says so;
 * otherwise that slot's models had no allowance left.
 */
export function downgradeLine(
  title: string,
  served: RouteResult["bucket"],
  routed: Pick<RouteResult, "bucket" | "withheld" | "picturesUnread">,
): string {
  const lead = `"${title}" is a ${levelName(routed.bucket)} task on ${levelModel(served)}`;
  const withheld = routed.withheld;
  if (!withheld && routed.picturesUnread) {
    return `${lead}. None of your ${levelModels(routed.bucket)} can read the pictures it carries.`;
  }
  if (!withheld) {
    return `${lead}. Your ${levelModels(routed.bucket)} have used up their allowance right now.`;
  }
  const name = catalogEntry(withheld.provider)?.name ?? "Its provider";
  const held = `${lead}. ${name}'s ${levelModels(routed.bucket)} are paused`;
  if (withheld.reason === CUT_OFF_SIGNED_OUT) return `${held} until you sign in again.`;
  if (withheld.reason === CUT_OFF_REFUSED) return `${held} while ${name} refuses your sign-in.`;
  if (isClientIssueReason(withheld.reason)) return `${held}: ${name} cannot run on ${HERE.this}.`;
  return `${held} right now.`;
}

/** How one queued row is dispatched (`CrewStarts.dispatchQueuedTask`). */
type DispatchOptions = {
  ignoreAsk?: boolean;
  /**
   * `behind` is a start the first mate's tool answered before it ran
   * (`CrewStarts.startBehind`); `spawned` marks the start of a task it
   * spawned just now, which posts no Starting line, as a spawn never has.
   */
  requested?: {
    by: "firstmate" | "captain";
    from?: typeof TASK_CARD_VIA;
    panel?: string;
    behind?: boolean;
    spawned?: boolean;
    /** The task was in the backlog when this start behind the answer queued it. */
    backlog?: boolean;
  };
  message?: { attachments: readonly AttachmentRef[]; files: readonly MessageFile[] };
};

/**
 * Starting a task (docs/task-graph.md, docs/inbox.md): classifying a queued
 * row and its brief, dispatching it when it is ready, starting it on the
 * captain's or the first mate's request and again after a failed start,
 * the waits a start holds on - a reasoning level, a gate - and the jobs a
 * started crewmate runs. Shares the crew's state through `CrewCore`.
 */
export class CrewStarts {
  /** Dispatches running now, by task, so a sweep never starts the same row twice at once. */
  private readonly dispatching = new Map<string, Promise<boolean | undefined>>();
  /** Starts running behind the first mate's answer, until each has ended (INF-3060). */
  private readonly behind = new Map<string, Promise<void>>();
  /** Hand-overs waiting for a task's next start to run (`nextStart`). */
  private readonly awaitingStart = new Map<string, Array<() => void>>();
  /**
   * Each start that went back in line after losing a computer it needs:
   * the step it lost it at and that computer, which its next start waits
   * for while the task still needs it - the one it runs on, or the source
   * task (`source`) whose live work its brief reads there - and what the
   * start that lost it carried: a Start from the backlog, which stays a
   * started backlog task once it starts, and a Start past a reasoning wait
   * (`ignoreAsk`). Kept until the task starts or fails otherwise, and while
   * an Automatic order is reconciled: a second loss of the same computer at
   * the same step is news for the first mate (INF-5142 part 4). Kept in
   * memory, so a restart here begins again, as any start after a restart does.
   */
  private readonly lostAt = new Map<
    string,
    {
      step?: StartStep;
      device?: string;
      source?: string;
      backlog: boolean;
      ignoreAsk: boolean;
    }
  >();

  /**
   * Whether a lost start still needs the computer it lost: the task still
   * runs there, or its brief still reads that source's live work there
   * (`CrewBrief.liveSources`). One whose need changed - its Runs on moved,
   * its basis or replacement link changed, its source closed or moved -
   * waits no more, and its next loss starts the count again.
   */
  private stillNeeds(record: TaskRecord, lost: { device?: string; source?: string }): boolean {
    if (!lost.device) return false;
    if (!this.core.options.machines?.computers().includes(lost.device)) return false;
    if (lost.source)
      return this.core.briefs
        .liveSources(record.id)
        .some((source) => source.id === lost.source && source.deviceId === lost.device);
    return this.core.placement.placementOf(record) === lost.device;
  }

  private readonly settle: StartSettle;
  /** The waits a start holds on its reasoning level (`ReasoningHolds`). */
  readonly reasoning: ReasoningHolds;

  constructor(private readonly core: CrewCore) {
    this.settle = new StartSettle(core, this.lostAt);
    this.reasoning = new ReasoningHolds(core);
  }

  /**
   * The commit a branching task's working copy starts at, or undefined when
   * it names none. A task with no project (`repoDir` undefined) branches in
   * the default workspace, where its source's branch and kept ref live.
   */
  private async branchFromBase(
    record: TaskRecord | undefined,
    repoDir: string | undefined,
  ): Promise<{ base?: DispatchBase; fromSource: boolean }> {
    if (!record) return { fromSource: false };
    const repo = async () => repoDir ?? (await this.core.options.workspace.ensureDefaultRepo());
    // A part that starts at an earlier part's approval begins on the version
    // the captain approved, before it merges (docs/task-graph.md).
    const approved = this.core.options.tasks.graph.approvedBase(record);
    if (approved) {
      const base = await this.core.options.workspace.approvedBaseAt(
        await repo(),
        approved.head,
        approved.branch,
      );
      this.core.options.tasks.placement.setBuiltOn(record.id, {
        task: approved.task.key || approved.task.id,
        branch: approved.branch,
        head: approved.head,
      });
      return { base, fromSource: false };
    }
    const ref = record.shape?.branch_from;
    if (!ref) return { fromSource: false };
    const source = branchFromSource(this.core.options.tasks, ref, record.repoId, record.id);
    if ("refused" in source) throw new Error(source.refused);
    return {
      base: await this.core.options.workspace.baseAt(await repo(), source.ref),
      fromSource: true,
    };
  }

  /**
   * The approved commit a placed part starts on, in the working copy its
   * approved base keeps on `machine` (docs/task-graph.md, "A part that
   * starts at approval"), recorded as the part's `built_on`. Undefined when
   * the part has no approved base; refused in words when that base's work
   * is on another computer, where nothing here can reach it.
   */
  private placedApprovedBase(
    record: TaskRecord,
    machine: string,
  ): { task: string; headSha: string } | undefined {
    const approved = this.core.options.tasks.graph.approvedBase(record);
    if (!approved) return undefined;
    const key = approved.task.key || approved.task.id;
    if (approved.task.deviceId !== machine)
      throw new Error(
        `This task starts on ${key}'s approved version, whose working copy is on another computer, so it starts only where ${key} runs: set its Runs on to that computer.`,
      );
    this.core.options.tasks.placement.setBuiltOn(record.id, {
      task: key,
      branch: approved.branch,
      head: approved.head,
    });
    return { task: approved.task.id, headSha: approved.head };
  }

  /**
   * A queued row's tier, moved to the one its verdict now gives: a basis
   * that answered after the row was planned grounds it (R4/R6), and the
   * row's tier says so. A quiet write, like the kind stamp: it explains a
   * routing decision, it is not one.
   */
  private restampGroundedTier(taskId: string, shape: WorkShape): void {
    if (!shape.basis_verified) return;
    const record = this.core.options.tasks.get(taskId);
    const bucket = tierFor(shape).bucket ?? null;
    if (!record || record.difficulty === bucket) return;
    this.core.options.tasks.placement.recordShape(taskId, {}, bucket);
  }

  /**
   * What a new task's branch is named from (docs/architecture.md, "A
   * task's branch"): the first mate's written name or `inf/` and its
   * title's slug, and the names its project's other tasks saved.
   */
  private branchStem(
    taskId: string,
    record: TaskRecord | undefined,
    title: string,
  ): TaskBranchStem {
    return {
      stem: taskBranchStem({
        id: taskId,
        key: record?.key || taskId,
        title: record?.title ?? title,
        written: record?.shape?.branch,
      }),
      savedByAnother: (branch) =>
        this.core.options.tasks.starts.branchSavedByAnother(record?.repoId ?? null, branch, taskId),
    };
  }

  /**
   * Start (or dispatch) one task: worktree, routing, account, session,
   * first turn. Shared by immediate commissions and the ready sweep.
   */
  async startTask(spec: {
    taskId: string;
    title: string;
    brief: string;
    repoId: string | null;
    routed: RouteResult | undefined;
    placementAccount?: string;
    /** A record born this instant (immediate commission) vs a dispatched queued row. */
    fresh: boolean;
    /**
     * A start the first mate asked for (INF-3060): one that fails keeps its
     * task open, and its working copy, for update_task start_now to retry.
     */
    asked?: boolean;
    /**
     * A start behind the first mate's answer that queued a backlog task
     * (`startBehind`), such as the captain's held Start: one that fails goes
     * back to the backlog with Could not start, as an asked one does.
     */
    backlog?: boolean;
    /**
     * The queue's own start, which nobody asked for: one that fails says so
     * in Activity, since no reply or note will.
     */
    swept?: boolean;
    /** Pictures the brief carries beyond those the task's messages keep (`TaskIntake.commission`). */
    messageFiles?: readonly MessageFile[];
    attachments?: readonly AttachmentRef[];
  }): Promise<{ taskId: string; crewmate: string }> {
    const { taskId, title, brief } = spec;
    if (spec.repoId) await this.core.hostOps.projectChange?.inspect(spec.repoId);
    const repoDir = spec.repoId ? this.core.options.repos.get(spec.repoId)?.path : undefined;
    if (spec.repoId && !repoDir) {
      throw new Error(`The repository for task ${taskId} is no longer registered.`);
    }
    if (this.core.tasks.has(taskId)) {
      throw new Error(`Task ${taskId} already has a running crewmate.`);
    }
    const crewmate = this.core.sessions.nameCrewmate();
    const record = this.core.options.tasks.get(taskId);
    if (record && TaskService.isClosed(record))
      throw new Error("The task closed before it could start.");
    const task: TaskRuntime = {
      id: taskId,
      title,
      key: record?.key || taskId,
      crewmate,
      currentTurnText: "",
      lastCompleteText: "",
      turn: new CrewTurn("opening"),
      filedThisTurn: [],
      withdrawnThisTurn: [],
      lastEventAt: this.core.now(),
      turnStartedAt: this.core.now(),
      quietLevel: 0,
      wallClockEscalated: false,
      clientTasks: new Map(),
      openCalls: new Map(),
      unreadSteers: [],
      openReads: new OpenReads(this.core.now),
    };
    this.core.tasks.set(taskId, task);
    this.core.facts.broadcastCrewCounts();

    // Create workspace and session before resolving, so a spawn failure
    // returns as a loud tool error instead of a phantom task.
    const live = this.core.facts.isPersonalTask(taskId);
    const personal = live ? this.core.options.personal : undefined;
    const machine = this.core.facts.machineOf(taskId);
    const placed = machine !== LOCAL_MACHINE_ID;
    // A folder repair (INF-549) works in its project's own folder, as the
    // personal workspace does, with none of that workspace's own rules.
    const inPlace = !live && !placed && this.core.facts.worksInPlace(taskId);
    // On a computer that runs work, its working copy is there, made by that
    // computer from where the project lives (docs/helper.md, "Its working
    // copies"). This Mac makes none, so the runtime holds no workspace a
    // failed start could remove here.
    let cwd: string | undefined;
    let elsewhere: PlacedCopy | undefined;
    let minted: BriefPart[];
    let pictures: Awaited<ReturnType<CrewBrief["briefPictures"]>>;
    // Where the start is, so a start that loses a computer names the step (INF-5142 part 4).
    let step: StartStep = "checks";
    // Whether the working copy begins at its branch_from source (the brief says so).
    let fromSource = false;
    try {
      if (record && deliverableOf(record) === "change") {
        const pending = await this.core.options.prepareContribution?.(taskId);
        if (pending) throw new Error(pending);
      }
      // Without a routed model or a model the local runtime serves in its
      // own right, do not open a session that cannot take the task.
      if (
        spec.routed &&
        !spec.routed.choice &&
        !placed &&
        this.core.options.accountlessServes?.() === false
      ) {
        throw new Error(
          "No signed-in model can take this task now. Check your accounts and their allowance in Settings → Intelligence.",
        );
      }
      // A task on a computer that runs work takes a model only that
      // computer's own subscriptions serve; with none, it does not start,
      // and nothing is made there for it.
      if (placed && spec.routed && !spec.routed.choice) {
        const who = this.core.options.machines?.placeOf(machine).who ?? "That computer";
        throw new Error(
          `${who} has no subscription of its own that can take this task now. Sign it in to one in Settings → Intelligence.`,
        );
      }
      if (placed) {
        const machines = this.core.options.machines;
        if (!machines?.folders(machine, taskId))
          throw new DeviceOutOfReachError("The computer this task runs on is out of reach.", {
            deviceId: machine,
          });
        if (
          record &&
          opensPullRequest(this.core.facts.taskDelivery(taskId)) &&
          deliverableOf(record) === "change" &&
          !machines.takesCheckDeclarations?.(machine)
        )
          throw new Error(
            `${machines.placeOf(machine).who ?? "That computer"} must be updated before it runs a change whose check and repair declarations it does not understand.`,
          );
        if (record?.shape?.result_schema && !machines.takesResults?.(machine))
          throw new Error(
            `${this.core.options.machines?.placeOf(machine).who ?? "That computer"} must be updated before it runs a task whose report carries a typed result.`,
          );
        const builder = this.core.reviewBuilderOf(record);
        const headSha = builder ? record?.delivery?.headSha : undefined;
        // A part starting at an earlier part's approval begins on the approved
        // commit in that part's own working copy, so both run on one computer.
        const approved = record && !builder ? this.placedApprovedBase(record, machine) : undefined;
        // A task that branches from work kept here starts there all the
        // same: its brief carries that work across (INF-5142 part 5). One
        // whose source has nothing to branch from is refused as here. A
        // review's version or an approved base wins, as it does here.
        fromSource = !!record?.shape?.branch_from && !(builder && headSha) && !approved;
        if (fromSource && record?.shape?.branch_from) {
          const source = branchFromSource(
            this.core.options.tasks,
            record.shape.branch_from,
            record.repoId,
            record.id,
          );
          if ("refused" in source) throw new Error(source.refused);
          if (!machines.sourceRef)
            throw new Error(
              `${machines.placeOf(machine).who ?? "That computer"} must be updated before it starts a task that branches from another.`,
            );
        }
        // Named before anything is reserved, so a name the project cannot
        // take leaves no preparation behind; the computer answers a copy it
        // already made on its own name, which the start saves.
        const branch =
          record?.branch ||
          (await this.core.options.workspace.taskBranchName(
            taskId,
            repoDir,
            this.branchStem(taskId, record, title),
          ));
        this.core.options.tasks.placement.beginPlacementPreparation(taskId);
        step = "working-copy";
        elsewhere = await machines.prepare(
          machine,
          taskId,
          spec.repoId,
          builder && headSha ? { task: builder.id, headSha } : approved,
          branch,
        );
        cwd = elsewhere.cwd;
      } else if ((live || inPlace) && repoDir) {
        // The personal workspace (Step 4), or a folder repair: the crewmate
        // works in the repository itself. No worktree, no branch; the record's
        // workspace columns stay empty so no close ever tries to remove one.
        // Other work in the folder is refused while it is missing, as a task
        // needing it is below; only the repair bringing it back starts (INF-584).
        if (
          inPlace &&
          spec.repoId &&
          !isFolderRepair(record?.shape?.in_place) &&
          !existsSync(repoDir)
        ) {
          throw new Error(
            this.core.inPlaceWork.folderMissing(
              spec.repoId,
              "start",
              this.core.options.tasks.get(taskId),
            ),
          );
        }
        const cwd = inPlace ? this.core.inPlaceWork.inPlaceDir(taskId, repoDir) : repoDir;
        task.workspace = { taskId, cwd, branch: "", repoDir };
      } else {
        // A task that needs the project's folder here is refused while it
        // is missing, naming it and the repair that brings it back (INF-572).
        if (spec.repoId && repoDir && !existsSync(repoDir)) {
          throw new Error(
            this.core.inPlaceWork.folderMissing(
              spec.repoId,
              "start",
              this.core.options.tasks.get(taskId),
            ),
          );
        }
        const headSha = this.core.reviewBuilderOf(record) ? record?.delivery?.headSha : undefined;
        // A task that branches from another starts at that task's last commit (INF-799).
        const branchFrom = headSha
          ? { fromSource: false }
          : await this.branchFromBase(record, repoDir);
        fromSource = branchFrom.fromSource;
        this.core.options.tasks.placement.beginPlacementPreparation(taskId);
        step = "working-copy";
        task.workspace = await this.core.options.workspace.createTaskWorktree(
          taskId,
          repoDir,
          headSha ? { headSha } : branchFrom.base,
          preparedPublicationRemote(this.core.options.tasks.get(taskId)),
          record?.branch || this.branchStem(taskId, record, title),
        );
      }
      cwd ??= task.workspace?.cwd ?? "";
      const routed = spec.routed;
      const routedModel = routed?.choice;
      // Routing placed it on no model here: a model its user named that this
      // Mac's account-less runtime serves is the one it runs on.
      const namedHere = record?.shape?.override_model_id?.trim();
      const accountless = namedHere
        ? this.core.placement.accountlessNamed(namedHere, machine, routed)
        : undefined;
      // Never silently downgrade intelligence (P7): a task served from a
      // lesser bucket than it called for says so in the feed.
      if (routed?.servedBucket && isDowngrade(routed.bucket, routed.servedBucket)) {
        this.core.options.broadcastEvent({
          type: "firstmate_note",
          text: downgradeLine(title, routed.servedBucket, routed),
        });
      }
      // The account-selection step (broker phase 4): routing picked the
      // model; the selector picks which account of its provider serves it.
      // A task on a computer that runs work is served by that computer's
      // own account, which its binding names, never one of this Mac's.
      const selectingAccount =
        routedModel && !placed
          ? this.core.options.accounts?.selectForSpawn(taskId, routedModel.provider, {
              model: routedModel.id,
            })
          : placed
            ? spec.placementAccount
            : undefined;
      const accountId =
        selectingAccount instanceof Promise ? await selectingAccount : selectingAccount;
      if (
        routedModel &&
        !placed &&
        this.core.options.accounts &&
        !accountId &&
        this.core.options.accountlessServes?.(routedModel) !== true
      ) {
        throw new Error(
          "No eligible account can serve the selected model now. Check your accounts and their allowance in Settings → Intelligence.",
        );
      }
      if (accountId) task.accountId = accountId;
      // Care must be stamped before opening the session: its first request
      // already carries the model's chosen effort.
      const rigor = this.core.briefs.deriveRigor(taskId);
      const servedLevel = routed?.servedBucket ?? routed?.bucket ?? "medium";
      // The captain's word on this task's effort outranks the model's
      // Settings choice, which outranks the level's default. Read as the
      // record stands now, as the requested speed is, never from the copy
      // taken before the working copy was prepared.
      const chosenReasoning = routedModel
        ? (this.core.options.tasks.get(taskId)?.shape?.override_reasoning ??
          this.core.options.router?.reasoningChoice?.(routedModel, servedLevel))
        : undefined;
      // A task with no project elsewhere merges into this Mac's default workspace.
      const workspaceRepoDir =
        task.workspace?.repoDir ??
        repoDir ??
        (elsewhere ? await this.core.options.workspace.ensureDefaultRepo() : "");
      step = "conversation";
      const session = await this.core.sessions.openCrewmate(
        task,
        {
          taskId,
          machineId: machine,
          ...(rigor === "quick" && !chosenReasoning ? { quick: true } : {}),
          cwd,
          ...(routedModel ? { model: routedModel } : accountless ? { model: accountless } : {}),
          ...(routedModel
            ? {
                thinkingLevel: chosenReasoning ?? levelDefaultReasoning(servedLevel),
              }
            : {}),
          ...this.core.toolHooks.crewmateHooks(task, personal),
        },
        accountId,
      );
      task.session = session;
      // Done can close the task while its session opens. Check before the
      // dispatch write, with no await between the check and the write.
      this.core.sessions.endIfLetGo(task);
      // The record's dispatch facts, once the crewmate really exists: the
      // model the session runs on outranks the routing choice it came from.
      this.core.options.tasks.starts.dispatch(taskId, {
        workspace: {
          repoDir: workspaceRepoDir,
          worktreeDir: live || inPlace || !task.workspace ? "" : task.workspace.cwd,
          branch: task.workspace?.branch ?? elsewhere?.branch ?? "",
          ...(elsewhere ? { elsewhere: true } : {}),
        },
        accountId: accountId ?? null,
        assignee: crewmate,
        model: session.modelRef() ?? routedModel,
        reasoning: session.reasoning(),
      });
      this.core.sessions.recordCrewSession(task, session, task.conversationBegan ?? "start");
      // Right after `dispatched`, so the timeline reads in a fixed order:
      // where the working copy came from and the commit it starts at.
      const acquired = task.workspace?.acquired ?? elsewhere?.acquired;
      if (acquired) {
        const where = elsewhere ? this.core.options.machines?.nameOf(machine) : undefined;
        this.core.options.tasks.note(
          taskId,
          worktreeText(acquired, where, task.workspace?.branch ?? elsewhere?.branch),
          {
            news: false,
            data: {
              worktree: acquired.source,
              ms: acquired.ms,
              base: {
                ref: acquired.base.ref,
                sha: acquired.base.sha,
                fetch: acquired.base.fetch,
                ...(acquired.base.fetchError ? { fetchError: acquired.base.fetchError } : {}),
              },
            },
          },
        );
      }
      task.unsubscribe = await this.core.toolHooks.follow(task, session);
      // From here every save in the workspace carries the task (the
      // running dot), until the task closes.
      step = "brief";
      pictures = await this.core.briefs.briefPictures(
        taskId,
        spec.attachments ?? [],
        spec.messageFiles ?? [],
      );
      minted = await this.core.briefs.mintBrief(
        taskId,
        brief,
        spec.repoId,
        pictures.section,
        fromSource,
      );
      if (this.core.tasks.get(taskId) !== task)
        throw new Error("The task closed while its source work was being copied.");
      personal?.beginLiveTask(taskId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const current = this.core.tasks.get(taskId) === task;
      // A start that lost a computer it needs - the one it runs on, or the
      // one its brief reads from - goes back in line and waits for that
      // computer, once per step: lost again at the same step, it could not
      // start, and the first mate hears which step (INF-5142 part 4).
      const loss = current ? lostComputer(caught) : undefined;
      const needs = loss ? (loss.deviceId ?? (placed ? machine : undefined)) : undefined;
      const prior = this.lostAt.get(taskId);
      const lostAgain = needs !== undefined && prior?.step === step && prior.device === needs;
      // An unconfirmed reply while an Automatic order is reconciled keeps
      // what an earlier loss recorded (below).
      const reconciling =
        needs === undefined &&
        record?.placement !== undefined &&
        caught instanceof PreparationUnknown;
      if (current && !reconciling) {
        if (needs !== undefined && !lostAgain)
          this.lostAt.set(taskId, {
            step,
            device: needs,
            ...(loss?.sourceId ? { source: loss.sourceId } : {}),
            backlog:
              spec.backlog === true ||
              record?.startPolicy === "on-request" ||
              prior?.backlog === true,
            ignoreAsk: prior?.ignoreAsk === true,
          });
        else this.lostAt.delete(taskId);
      }
      const who = needs
        ? (this.core.options.machines?.nameOf(needs) ?? `the ${COMPUTER.one} it needs`)
        : "";
      if (record?.placement && caught instanceof PreparationUnknown && current && !lostAgain) {
        // A missing reply proves neither success nor failure. Keep the choice,
        // order and demand; the next attempt reconciles this same preparation.
        // A typed loss counts toward the second-loss word above all the same.
        this.core.tasks.delete(taskId);
        this.core.options.tasks.starts.returnStart(taskId, {
          kind: "retry",
          text: UNCONFIRMED_START_RETURNED,
        });
        this.core.options.tasks.starts.markStartChecking(taskId);
        // A Start from the backlog keeps its go: the next sweep reconciles it.
        this.core.options.tasks.starts.queueForStart(taskId);
        this.core.placement.sayAutomaticWait(this.core.options.tasks.get(taskId) ?? record);
        return { taskId, crewmate: "queued" };
      }
      const backInLine = needs !== undefined && !lostAgain;
      // A start that goes back in line keeps its computer choice and order.
      if (
        record?.placement &&
        !backInLine &&
        (!placed ||
          elsewhere ||
          !this.core.options.tasks.get(taskId)?.placement?.preparationStarted)
      )
        this.core.options.tasks.placement.releasePlacement(
          taskId,
          record.placement.snapshot.orderId,
          "ended",
        );
      if (!current) throw new StartFailure(message);
      const forge = caught instanceof ForgeAuthRequiredError;
      // Its answer named the task, or the captain started it from the
      // backlog: the working copy stays for the start that tries again.
      const keep = !forge && (spec.asked || spec.backlog);
      if (spec.fresh && !forge && !keep && !backInLine) {
        await this.core.sessions.cleanupFailedSpawn(task);
        throw new StartFailure(message);
      }
      await task.unsubscribe?.();
      task.session?.dispose();
      this.core.tasks.delete(taskId);
      this.core.cards.deleteRowsForTask(taskId);
      if (task.workspace && !keep)
        await this.core.options.workspace.removeTaskWorktree(task.workspace).catch(() => {});
      if (backInLine) {
        // A working copy there stays for the start that tries again, which
        // the computer answers where it is; nothing began a crewmate turn.
        this.core.options.tasks.starts.returnStart(taskId, {
          kind: "lost",
          text: lostStartLine(who, step),
          step,
          keepWorkspace: placed,
        });
        this.core.cards.scheduleBroadcast();
        this.core.facts.broadcastCrewCounts();
        return { taskId, crewmate: "queued" };
      }
      const reason = lostAgain ? lostTwiceReason(who, step, startFailureReason(caught)) : undefined;
      this.settle.settleFailedStart(
        taskId,
        reason ? new StartFailure(reason) : caught,
        machine,
        spec.swept === true,
      );
      // A review held for its sign-in is queued: nobody waits on it to fail.
      if (forge && spec.fresh) return { taskId, crewmate: "queued" };
      throw new StartFailure(reason ?? message);
    }
    this.lostAt.delete(taskId);
    this.core.options.broadcastEvent({
      type: "task_started",
      taskId,
      title,
      machineId: machine,
      crewmate,
    });
    this.core.facts.broadcastCrewCounts();
    // The brief rides the durable inbox as the task's first row (captain
    // refinement on review): the first turn gets the same retry ladder and
    // boot re-presentation as every later steer. Queued rows keep their
    // brief in tasks.prompt while gated; this row is minted only here, at
    // dispatch, so nothing is bookkept twice. Active repo notes append
    // here, origin-labeled (stage 0 / Q5).
    // The captain's pictures ride the row by reference, so a retried or
    // re-presented first turn still carries them (docs/inbox.md).
    const briefRowId = this.core.options.inbox.enqueue(
      taskId,
      pictures.riding.length > 0
        ? withAttachmentsKept(briefText(minted), pictures.riding)
        : briefText(minted),
    );
    this.core.options.inbox.markDelivered([briefRowId]);
    void this.core.turns.prepareFirstTurn(task, minted, [briefRowId], pictures.images);
    return { taskId, crewmate };
  }

  /**
   * A queued row's kind, established at gate-open (S3): the classifier runs
   * once and the verdict is stamped on the row, so a row that waited days
   * is sorted against what it was commissioned with and a row already
   * sorted keeps its kind. The stamp is a quiet write - no timeline event,
   * no feed line: it explains a routing decision, it is not one.
   *
   * The verdict is written as the host's stamp onto the row as it stands
   * when the call returns (INF-83, INF-416 piece F): a model, a basis or
   * any other field a person owns, named or cleared while the classifier
   * ran, stays, and the tier is computed from that row. The shape the
   * classifier was asked about is never written back. A skip asks nothing,
   * so one whose named model was cleared meanwhile classifies the row as
   * it now stands.
   */
  private async classifyQueued(record: TaskRecord): Promise<void> {
    const shape = this.queuedShape(record);
    if (kindEstablished(shape.kind_source)) return;
    const intent = record.intent ?? { goal: record.title, userWords: record.prompt };
    const classified = withDeliverable(
      await classifyShape(
        this.core.options,
        record.id,
        record.title,
        intent,
        record.repoId,
        shape,
        record.intent != null,
      ),
      record.intent ?? undefined,
    );
    const current = this.core.options.tasks.get(record.id);
    if (current?.status !== "open" || current.kind !== "work") return;
    const now = this.queuedShape(current);
    if (classified.kind_source === `${KIND_SOURCE.skipped}override` && !now.override_model_id)
      return this.classifyQueued(current);
    const stamp = {
      kind: classified.kind,
      kind_source: classified.kind_source,
      ...(classified.kind_detail ? { kind_detail: classified.kind_detail } : {}),
      deliverable: classified.deliverable,
    };
    const stamped: WorkShape = { ...now, ...stamp };
    if (stamped.kind_source === now.kind_source && stamped.deliverable === now.deliverable) return;
    this.core.options.tasks.placement.recordShape(
      record.id,
      stamp,
      tierFor(stamped).bucket ?? null,
    );
  }

  /**
   * A queued row's shape as its record holds it now, with its basis
   * verdict derived now: what it was commissioned with - its basis, its
   * premium ask and the model the captain named. A commissioned row written
   * before the shape existed is read as the judgment it carried. A
   * crewmate's follow-up is filed with no shape and no intent: it never
   * carried a judgment, so its shape is built here the way a planned row's
   * is, and `rigorFor` derives its rigor like any other row's - never the
   * legacy quick.
   */
  queuedShape(record: TaskRecord): WorkShape {
    return withBasisVerdict(
      this.core.options.tasks,
      record.shape ??
        (record.intent
          ? legacyShapeFromDifficulty(record.difficulty)
          : workShape(this.core.options.tasks, undefined)),
    );
  }

  /**
   * The brief a queued row dispatches from. Its stored prompt was rendered
   * at commission, before the classifier ran, so a row the classifier has
   * just called an ANSWER may still carry the `Delivery:` line a change
   * gets - which the mint's answer-shape section would then contradict. The
   * host re-renders it from the same template and the same intent when that
   * happens, and always renders ordinary tasks from saved intent to avoid
   * template drift after goal edits. An escalation (whose brief carries a
   * host-written section the intent alone cannot rebuild) keeps it. A row
   * with no intent - a crewmate's follow-up - keeps the brief it was filed
   * with, its Delivery line written again: the posture its own merge takes
   * now (FI3-733), or none when it is an answer (FI3-598), which gets no
   * delivery tools and so must not be told to ship.
   */
  private queuedBrief(record: TaskRecord, shape: WorkShape): string {
    // A review keeps the host's brief at its assigned head, through a retry.
    if (shape.escalation || this.core.reviewBuilderOf(record)) return record.prompt;
    // A folder repair is rendered again from its facts as they stand now: a
    // later refusal may have moved the version the folder must reach.
    const repo = record.repoId ? this.core.options.repos.get(record.repoId) : undefined;
    if (shape.in_place && repo) {
      const where = { project: repo.name, folder: repo.path };
      // Folder work (INF-567) is the first mate's intent, told the folder.
      if (isFolderWork(shape.in_place)) {
        return record.intent
          ? renderIntentBrief(record.intent, undefined, undefined, where)
          : record.prompt;
      }
      return isPullRepair(shape.in_place)
        ? renderPullRepairBrief({ ...shape.in_place, ...where })
        : this.core.inPlaceWork.folderRepairBrief(repo, shape.in_place);
    }
    const personal = this.core.facts.isPersonalTask(record.id);
    const delivery =
      shape.deliverable !== "change" || personal
        ? undefined
        : (this.core.facts.taskDelivery(record.id) ?? "local-only");
    if (!record.intent) return withDeliveryLine(record.prompt, delivery);
    return renderIntentBrief(
      record.intent,
      delivery,
      personal ? this.core.facts.personalFacts(shape.ongoing) : undefined,
      undefined,
    );
  }

  /**
   * Dispatch one queued row through the shared start path. `requested` is a
   * start someone asked for (`startQueuedNow`): its asker already knows, so
   * no queued-started wake follows, and a failure says who asked. `from`
   * writes the start on the history as the captain's task card click.
   * `message` is the spawning message's pictures and files, for a start
   * made before that message attaches to the task; a later start reads
   * them from the record.
   */
  /** Resolves true when the start failed and its failure was told. */
  async dispatchQueuedTask(
    taskId: string,
    options: DispatchOptions = {},
  ): Promise<boolean | undefined> {
    // The ready sweep finds a row whose start is already running - one the
    // first mate started behind its answer, or the captain's Start - and
    // waits on that start instead of comparing computers for it again.
    const running = this.dispatching.get(taskId);
    if (running && !options.requested) return running;
    const dispatch = this.dispatchOnce(taskId, options);
    this.dispatching.set(taskId, dispatch);
    try {
      return await dispatch;
    } finally {
      if (this.dispatching.get(taskId) === dispatch) this.dispatching.delete(taskId);
      this.startRan(taskId);
    }
  }

  /**
   * A start the first mate asked for, run behind its answer (INF-3060): the
   * row is recorded and shows Starting at once, and the tool returns while
   * classification, routing and the working copy, which can take minutes on
   * another computer, go on. A wait for room shows on the task itself; a
   * failure reaches the first mate as an [fm-op], and so does the model that
   * took a task the captain named one for (FI3-444).
   */
  startBehind(
    taskId: string,
    options: Omit<DispatchOptions, "requested"> & {
      requested?: Omit<NonNullable<DispatchOptions["requested"]>, "behind">;
    } = {},
  ): Promise<void> {
    if (!this.core.options.tasks.starts.startAttemptOf(taskId))
      this.core.options.tasks.starts.beginStartAttempt(taskId);
    const record = this.core.options.tasks.get(taskId);
    const audience = options.requested?.by === "captain" ? "captain" : "tool";
    // A backlog task is queued while it starts, so a quit leaves it for the
    // next launch's sweep; a failure puts it back in the backlog.
    const backlog = record?.status === "open" && record.startPolicy === "on-request";
    if (backlog) this.core.options.tasks.starts.queueForStart(taskId);
    return this.runBehind(taskId, () =>
      this.dispatchQueuedTask(taskId, {
        ...options,
        requested: {
          by: "firstmate",
          ...options.requested,
          behind: true,
          ...(backlog ? { backlog: true } : {}),
        },
      })
        .then(async (failed) => {
          if (!record || this.core.disposed()) return;
          if (backlog && !failed) this.core.options.tasks.starts.keepOnRequest(taskId);
          await this.settle.settleStartAttempt(record, audience);
          // A failed start already told the first mate (queued-start-failed).
          if (failed) return;
          // A wait the tile names, or a start, needs no word; any other wait
          // is told to the first mate, whose answer no longer said it.
          const outcome = await this.settle.startOutcome(record.id, "It", audience);
          if (outcome.shown || this.core.disposed()) return;
          this.core.routeCrewEvent(
            record.id,
            {
              facts: {
                kind: "asked-start-waits",
                task: { id: record.id, title: record.title },
                words: outcome.text,
              },
            },
            "agent",
          );
        })
        .catch((caught: unknown) => {
          console.warn("[crew] a start behind the first mate's answer failed:", caught);
        }),
    );
  }

  /**
   * The start of a task that runs behind the first mate's answer, while it
   * runs: a message or a hand-over of files to the task waits for it.
   */
  startingBehind(taskId: string): Promise<void> | undefined {
    return this.behind.get(taskId);
  }

  private runBehind(taskId: string, start: () => Promise<void>): Promise<void> {
    const running = start();
    this.behind.set(taskId, running);
    void running.finally(() => {
      if (this.behind.get(taskId) === running) this.behind.delete(taskId);
      this.startRan(taskId);
    });
    return running;
  }

  /**
   * Resolves once a start of the task, the one running now or the next,
   * has run, whatever came of it: a hand-over of files to a task that has
   * not started waits on it (INF-3060).
   */
  nextStart(taskId: string): Promise<void> {
    return new Promise((resolve) => {
      this.awaitingStart.set(taskId, [...(this.awaitingStart.get(taskId) ?? []), resolve]);
    });
  }

  private startRan(taskId: string): void {
    const waiting = this.awaitingStart.get(taskId);
    this.awaitingStart.delete(taskId);
    for (const resolve of waiting ?? []) resolve();
  }

  /**
   * A record born active whose start the first mate's answer did not wait
   * for (a review, INF-3060). One that could not start stays open, waiting
   * for update_task start_now or a drop, and the first mate hears so.
   */
  startTaskBehind(
    taskId: string,
    title: string,
    start: () => Promise<unknown>,
    /** The model the first mate's words named; the review is routed on its own (FI3-444). */
    named?: string,
  ): Promise<void> {
    return this.runBehind(taskId, () =>
      start().then(
        (started) => {
          // A start that went back in line has started nothing yet (INF-5142 part 4).
          if ((started as { crewmate?: string } | undefined)?.crewmate === "queued") return;
          const took = this.core.options.tasks.get(taskId)?.model ?? null;
          // Only a model other than the one named is news (INF-5123).
          if (!named || !namedModelDiffers({ named, took })) return;
          this.core.routeCrewEvent(
            taskId,
            {
              facts: {
                kind: "queued-started",
                task: { id: taskId, title },
                model: { named, took },
                asked: true,
              },
            },
            "agent",
          );
        },
        (caught: unknown) => {
          // A quit stopped it; it did not fail (`dispatchOnce`).
          if (this.core.disposed()) return;
          const reason = startFailureReason(caught);
          this.settle.settleOutsideStart(taskId, caught, true, false);
          const open = this.core.options.tasks.get(taskId)?.status === "open";
          this.core.routeCrewEvent(
            taskId,
            {
              facts: {
                kind: "queued-start-failed",
                task: { id: taskId, title },
                error: capWithOverflow(reason, "queue-start-failure"),
                asked: true,
                ...(open ? { open: true as const } : {}),
              },
            },
            "agent",
          );
        },
      ),
    );
  }

  private async dispatchOnce(
    taskId: string,
    options: DispatchOptions,
  ): Promise<boolean | undefined> {
    // The quit starts nothing; the next launch's sweep starts it.
    if (this.core.disposed()) return;
    // A Start waiting for the Firstmate's directions begins only through it.
    if (this.core.hostOps.pendingStarts.has(taskId)) return;
    let record = this.core.options.tasks.get(taskId);
    if (record?.status !== "open" || record.kind !== "work") return;
    // A program runs in the host's runner, never on a model; a running one is left alone.
    if (record.shape?.program) {
      this.core.programs.run(taskId);
      return;
    }
    // A start that lost a computer it needs waits for that computer to be
    // back, and its next start is a recovery nobody needs to hear of
    // (INF-5142 part 4). One whose computer is gone from the list waits no more.
    const lost = this.lostAt.get(taskId);
    if (lost?.device) {
      if (!this.stillNeeds(record, lost)) {
        // Its need moved on: it waits no more, and that loss counts no more.
        lost.device = undefined;
        lost.source = undefined;
        lost.step = undefined;
      } else if (this.core.options.machines?.ready(lost.device, taskId) !== true) return;
    }
    const originalTitle = record.title;
    const gate = record.gate;
    // A start the first mate asked for, which its answer already named.
    const asked = options.requested?.behind === true && options.requested.by !== "captain";
    const blockers = this.core.options.tasks.graph.blockers(taskId);
    try {
      await this.classifyQueued(record);
      // Classification awaits a provider. An edit during that await must
      // reach the first turn, not the earlier snapshot used to classify:
      // the row routes from its own shape as the record now holds it.
      record = this.core.options.tasks.get(taskId);
      if (record?.status !== "open" || record.kind !== "work") return;
      const shape = this.queuedShape(record);
      this.restampGroundedTier(record.id, shape);
      // Placement and routing can wait on a computer, and a model or basis
      // named or cleared meanwhile (INF-83), or a move of where it runs
      // (INF-409), decides this start: it starts over from the record as it
      // now stands.
      const routedFrom = record.shape;
      const startsAt = this.core.placement.startPlace(record);
      const moved = () => {
        const now = this.core.options.tasks.get(taskId);
        return (
          !now ||
          routingAskMoved(routedFrom, now.shape) ||
          this.core.placement.startPlace(now) !== startsAt
        );
      };
      // A task that waits for its computer chooses its model once that
      // computer is back, among its own subscriptions.
      const automatic = this.core.placement.automaticFor(record);
      if (!automatic) this.core.options.tasks.placement.setPlacementWait(taskId, null);
      // A Start past a reasoning wait that lost its computer is still past it.
      const ignoreAsk =
        options.ignoreAsk ||
        lost?.ignoreAsk === true ||
        record.shape?.placement_fallback_accepted === true;
      const repo = record.repoId ? this.core.options.repos.get(record.repoId) : undefined;
      // The captain's pictures its brief will carry: a model that takes text only is skipped.
      const images = briefCarriesPictures(
        this.core.options.tasks,
        taskId,
        shape,
        options.message?.attachments,
      );
      const choice =
        automatic && repo
          ? await this.core.options.automaticPlacement?.choose(
              record,
              repo,
              this.queuedBrief(record, shape),
              shape,
              { ignoreAsk, images },
            )
          : undefined;
      const selected = choice && "computerId" in choice ? choice : undefined;
      // An added computer left out for a reason only a change ends: the
      // first mate hears it once per project, computer and reason, whichever
      // computer took the task (INF-1456).
      if (repo)
        for (const left of choice?.leftOut ?? [])
          this.core
            .hooks()
            .notifyOp(
              computerLeftOutWake(
                { id: record.id, key: record.key || record.id, title: record.title },
                { id: repo.id, name: repo.name },
                left,
              ),
              "agent",
            );
      if (automatic && !selected) {
        // Automatic declines a task that changed while computers were
        // compared, which is no wait for room.
        if (moved()) return this.dispatchOnce(taskId, options);
        // A wait whose computers were compared says why; another keeps what was said.
        const waiting = choice && "wait" in choice ? choice : undefined;
        const wait =
          waiting?.wait ??
          this.core.options.tasks.get(taskId)?.shape?.placement_wait ??
          UNCOMPARED_WAIT;
        this.core.options.tasks.placement.waitForPlacement(taskId, ignoreAsk, wait.words);
        this.core.placement.sayAutomaticWait(record, wait);
        // No computer runs a system it requires, which no room or reading
        // changes: the first mate hears it at once, once (INF-720).
        if (waiting?.unserved)
          this.core
            .hooks()
            .notifyOp(
              systemWaitWake(
                { id: record.id, key: record.key || record.id, title: record.title },
                waiting.unserved,
              ),
              "agent",
              taskId,
            );
        // No computer serves the model the captain named: it waits instead of
        // starting on another one, and the first mate hears it once to ask.
        if (waiting?.namedUnserved)
          this.core
            .hooks()
            .notifyOp(
              namedModelWaitWake(
                { id: record.id, key: record.key || record.id, title: record.title },
                waiting.namedUnserved,
              ),
              "agent",
              taskId,
            );
        // No computer serves the level it asked for: held on that level's
        // reset with one wake, as a This computer start is (P7 + R1).
        if (waiting?.held) {
          this.reasoning.holdForReasoning(taskId, record.title, gate, waiting.held);
          this.core.facts.broadcastCrewCounts();
        }
        return;
      }
      if (selected) this.core.options.tasks.placement.setPlacementWait(taskId, null);
      const target = selected ? selected.computerId : this.core.placement.placementOf(record);
      const ready = !target || this.core.options.machines?.ready(target, taskId) === true;
      // One that waits for its own sign-in there tries nothing until it
      // serves: known before routing once that computer said so, and after
      // routing found nothing there to take it.
      const signInWait = () =>
        !selected &&
        target !== null &&
        ready &&
        !this.core.tasks.has(taskId) &&
        this.core.placement.waitsForSignIn(taskId, target);
      if (signInWait()) return;
      // One with no sign-in at all, or none for where its project lives,
      // tries nothing until that computer reports one.
      if (!selected && target !== null && ready && !this.core.tasks.has(taskId)) {
        const waitFor = await this.core.placement.placedWaitFor(target, record.repoId);
        if (moved()) return this.dispatchOnce(taskId, options);
        if (waitFor) {
          this.core.placement.waitForSetup(taskId, target, waitFor);
          this.core.facts.broadcastCrewCounts();
          return;
        }
      }
      const routed =
        selected?.routed ??
        (ready
          ? await this.core.placement.routeTask(taskId, record.prompt, shape, target, { images })
          : undefined);
      // From here to the claim nothing waits; a quit that came meanwhile starts nothing.
      if (this.core.disposed()) return;
      if (moved()) return this.dispatchOnce(taskId, options);
      if (!routed?.choice && signInWait()) return;
      // A model the captain named runs only where it is served, never as
      // another model in silence: the task waits, on this computer or the
      // one it runs on as on Automatic, and the first mate hears it once.
      const named = shape.override_model_id?.trim();
      if (routed && named && !this.core.placement.servesNamed(named, target, routed)) {
        const wait = { kind: "model", words: placementNamedModelWait(named) } as const;
        this.core.options.tasks.placement.waitForPlacement(taskId, ignoreAsk, wait.words);
        // The top of this attempt cleared the saved wait off Automatic, so the
        // record read before it says whether this wait was already said.
        if (record.shape?.placement_wait?.words === wait.words)
          this.core.options.tasks.placement.setPlacementWait(taskId, record.shape.placement_wait);
        else this.core.placement.sayAutomaticWait(record, wait);
        this.core
          .hooks()
          .notifyOp(
            namedModelWaitWake(
              { id: record.id, key: record.key || record.id, title: record.title },
              named,
            ),
            "agent",
            taskId,
          );
        this.core.facts.broadcastCrewCounts();
        return;
      }
      // A wait it said before, such as for the named model, is over.
      if (!selected) this.core.options.tasks.placement.setPlacementWait(taskId, null);
      if (!ignoreAsk && routed && requiresReasoningWait(shape, routed)) {
        // The user's premium ask - or an escalation's rung (S4) - still
        // cannot be served when the gate clears: re-gate on the quota reset
        // instead of quietly starting lower (P7) - the commission-time
        // protection, applied at dispatch too. update_task start_now passes
        // ignoreAsk.
        this.reasoning.holdForReasoning(taskId, record.title, gate, routed);
        this.core.facts.broadcastCrewCounts();
        return;
      }
      if (this.core.tasks.has(taskId)) return;
      // This computer is being updated: it starts once the update is over
      // or let go (`releaseUpdate`).
      if (this.core.updates.updatingHere()) return;
      // It runs on a computer that is out of reach: it waits, and never starts here instead.
      if (this.core.placement.placeForStart(taskId)) return;
      if (
        !this.core.options.tasks.starts.claimForDispatch(
          taskId,
          options.requested?.from,
          options.requested?.panel,
          options.requested?.spawned ? { spawned: true } : {},
        )
      )
        return;
      const start = await this.startTask({
        taskId,
        title: record.title,
        brief: this.queuedBrief(record, shape),
        repoId: record.repoId,
        routed,
        placementAccount: selected?.accountId,
        fresh: false,
        ...(asked ? { asked } : {}),
        ...(options.requested?.backlog ? { backlog: true } : {}),
        ...(options.requested ? {} : { swept: true }),
        ...(options.message?.attachments.length
          ? { attachments: options.message.attachments }
          : {}),
        ...(options.message?.files.length ? { messageFiles: options.message.files } : {}),
      });
      if (start.crewmate === "queued") {
        // Its next start carries this one's routing authorization.
        const back = this.lostAt.get(taskId);
        if (back && ignoreAsk) back.ignoreAsk = true;
        return;
      }
      // A Start from the backlog that recovered is a started backlog task again.
      if (lost?.backlog) this.core.options.tasks.starts.keepOnRequest(taskId);
      this.core.placement.sayPlacedStarted(taskId);
      const because = gate
        ? gateClearedText(gate)
        : blockers.length > 0
          ? `${blockers.map((blocker) => `"${blocker.title}" (${blocker.key})`).join(" and ")} finished`
          : undefined;
      if (!options.requested?.spawned)
        this.core.options.broadcastEvent({
          type: "firstmate_note",
          text: `Starting "${record.title}"${because ? ` - ${because}` : ""}.`,
        });
      // Only a start whose wait ended wakes the Firstmate with this line. The
      // captain's Start reaches its next context block the way the captain's
      // card choices do (FI3-695), and a program's part was started by its
      // program, which is what waits on it (INF-799). A start behind the first
      // mate's answer - which said only that it is starting - wakes it here
      // only when a task named a model it did not start on, or none is
      // recorded to confirm it (INF-5123): a start on the named model is no
      // news, and the crew list names the model; a failure or a wait its
      // tile does not name wakes it from `startBehind`.
      const started = this.core.options.tasks.get(taskId);
      const model = started && namedModelOf(started);
      if (lost) {
        // A start that recovered from a lost computer: its record says so.
      } else if (options.requested?.behind) {
        if (model && namedModelDiffers(model))
          this.core.routeCrewEvent(
            taskId,
            {
              facts: {
                kind: "queued-started",
                task: { id: taskId, title: record.title },
                model,
                asked: true,
              },
            },
            "agent",
          );
      } else if (!options.requested && !record.shape?.program_part) {
        this.core.routeCrewEvent(
          taskId,
          {
            facts: {
              kind: "queued-started",
              task: { id: taskId, title: record.title },
              ...(model ? { model } : {}),
            },
          },
          "agent",
        );
      }
    } catch (caught) {
      // A quit stops a start, whoever began it; it did not fail. The row
      // stays as the quit left it for the next launch, which starts a queued
      // row again and returns a claimed one that began nothing
      // (`releaseUnstartedDispatches`), and nobody is told: the task store
      // may already be closed.
      if (this.core.disposed()) return;
      // A close took this attempt; there is no failed start to settle or tell.
      const after = this.core.options.tasks.get(taskId);
      if (after && TaskService.isClosed(after)) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      this.settle.settleOutsideStart(taskId, caught, asked, !options.requested);
      const current = this.core.options.tasks.get(taskId);
      this.core.routeCrewEvent(
        taskId,
        {
          facts: {
            kind: "queued-start-failed",
            task: { id: taskId, title: record?.title ?? originalTitle },
            error: capWithOverflow(
              options.requested?.behind ? startFailureReason(caught) : message,
              "queue-start-failure",
            ),
            ...(options.requested?.by === "captain" ? { by: "captain" as const } : {}),
            ...(options.requested?.behind ? { asked: true as const } : {}),
            ...(asked && current?.status === "open" ? { open: true as const } : {}),
          },
        },
        "agent",
      );
      this.core.facts.broadcastCrewCounts();
      return true;
    }
    this.core.facts.broadcastCrewCounts();
  }

  /**
   * update_task start_now: a queued row starts on the Firstmate's word,
   * past the reasoning re-ask (the one operation the retired wait card's
   * button carried; cards/tasks/agents P0, WI-3), or on the captain's Start
   * in the task record (`start-task`). A refusal is text; the captain's
   * leaves out the tool's way around it. `from` marks the captain's click on
   * the task card, which the history records as his.
   */
  async startQueuedNow(
    taskRef: string,
    options: {
      audience?: "tool" | "captain";
      from?: typeof TASK_CARD_VIA;
      panel?: string;
      /** The captain's Start that skips the first mate's directions. */
      direct?: boolean;
    } = {},
  ): Promise<string> {
    const audience = options.audience ?? "tool";
    let { from, panel } = options;
    const record = this.core.intake.resolveTaskRef(taskRef, "task");
    const handle = `${record.key || record.id} "${record.title}"`;
    if (record.status === "active" && record.backlogSince != null)
      return this.core.hostOps.startFromBacklog(
        record,
        audience === "captain" ? "captain" : "firstmate",
        from,
        panel,
      );
    const refused = this.core.hostOps.startRefusal(record, audience);
    if (refused) return refused;
    // The captain's Start goes to the Firstmate first, so his standing
    // directions apply before a crewmate begins. The Firstmate's own
    // start_now on that pending Start is the same press, finished.
    const pending = this.core.hostOps.pendingStarts.get(record.id);
    if (pending) {
      this.core.hostOps.pendingStarts.delete(record.id);
      from = pending.from;
      panel = pending.panel;
    } else if (
      audience === "captain" &&
      !options.direct &&
      this.core.hostOps.askFirstmateFirst(record, from, panel)
    ) {
      return `${handle} is starting. Your first mate applies your standing directions first.`;
    }
    const asCaptain = audience === "captain" || pending !== undefined;
    // Publish before classification and routing, so both surfaces leave
    // Backlog while that work is still going. A known refusal above never
    // publishes. startOnRequest may already hold `starting`; this is the
    // shared board's copy of that attempt.
    if (!this.core.options.tasks.starts.startAttemptOf(record.id))
      this.core.options.tasks.starts.beginStartAttempt(record.id);
    if (record.gate)
      this.core.options.tasks.placement.setGate(record.id, null, "started on request");
    // The first mate's answer waits for nothing more: the task shows
    // Starting, and then its wait or its crewmate, on its tile; a wait the
    // tile does not name reaches the first mate as an [fm-op] (INF-3060).
    if (audience === "tool" && !record.shape?.program) {
      void this.startBehind(record.id, {
        ignoreAsk: true,
        requested: {
          by: asCaptain ? "captain" : "firstmate",
          ...(from ? { from } : {}),
          ...(panel ? { panel } : {}),
        },
      });
      return `${handle} is starting. Its tile shows any wait, such as for room on its computer; you hear an [fm-op] if it cannot start or waits for something its tile does not name.`;
    }
    await this.dispatchQueuedTask(record.id, {
      ignoreAsk: true,
      requested: {
        by: asCaptain ? "captain" : "firstmate",
        ...(from ? { from } : {}),
        ...(panel ? { panel } : {}),
      },
    });
    // A program stays open while the runner holds it; its first run is recorded on its timeline.
    const program = this.core.options.tasks.get(record.id);
    if (program?.shape?.program) {
      if (this.core.options.tasks.starts.startAttemptOf(record.id))
        this.core.options.tasks.starts.clearStartAttempt(record.id);
      return this.core.options.tasks.starts.programStarted(record.id)
        ? `Started ${handle}.`
        : `${handle} could not start.`;
    }
    await this.settle.settleStartAttempt(record, asCaptain ? "captain" : "tool");
    return (await this.settle.startOutcome(record.id, handle, audience)).text;
  }

  /** Captain-requested dropped work starts as a fresh record, never an escalation. */
  startAgain(
    taskRef: string,
    audience: "tool" | "captain" = "tool",
    panel?: string,
  ): { ok: false; text: string } | { ok: true; task: TaskRecord; started: Promise<string> } {
    const old = this.core.intake.resolveTaskRef(taskRef, "task");
    const refusal = this.core.options.tasks.starts.startAgainRefusal(old.id);
    if (refusal) return { ok: false, text: refusal };
    // Only declarations carry over: dispatch stamps, chosen accounts/models,
    // escalation floors and delivery outcomes all belong to the old attempt.
    const { kind: _oldKind, ...oldAsk } = old.shape ?? { kind: "unclear" };
    const shape = workShape(this.core.options.tasks, {
      ...oldAsk,
      ...(old.shape?.kind_source === "firstmate:declared" && old.shape.kind !== "review"
        ? { kind: old.shape.kind }
        : {}),
    });
    if (old.shape?.policies) shape.policies = { ...old.shape.policies, revision: 0 };
    const fresh = this.core.options.tasks.starts.startAgain(old.id, {
      id: randomUUID().slice(0, 8),
      shape: old.intent ? withDeliverable(shape, old.intent) : shape,
      actor: audience === "tool" ? "firstmate" : "captain",
      ...(audience === "captain" ? { via: TASK_CARD_VIA } : {}),
      ...(panel ? { panel } : {}),
    });
    this.core.hostOps.starting.add(fresh.id);
    const started = this.core.settling.closing
      .finishWorkspaceRetirement(old.id)
      .then(() => this.startQueuedNow(fresh.id, { audience }))
      .finally(() => this.core.hostOps.starting.delete(fresh.id));
    return { ok: true, task: fresh, started };
  }

  /**
   * A queued task whose wait can never end (its blocker was dropped) is one
   * wake to the Firstmate, not a card and not a hold: its tools already
   * express every way out. The wake is deduped by content on the task's
   * ref while it stands, so the tick does not repeat it.
   */
  wakeDeadGate(record: TaskRecord, dead: TaskRecord): void {
    this.core.hooks().notifyOp(
      {
        facts: {
          kind: "dead-gate",
          task: { id: record.id, key: record.key || record.id, title: record.title },
          blocker: { id: dead.id, key: dead.key || dead.id, title: dead.title },
          closed: dead.closedReason ?? "dropped",
        },
      },
      "agent",
      record.id,
    );
  }

  /**
   * When a client-run backend (Claude, or any conversation a computer that
   * runs work holds) last reported background work, if it has any now: the
   * host cannot see those commands, so the reported count stands in for its
   * job list, bounded the same way.
   */
  clientJobStart(taskId: string): number | undefined {
    const runtime = this.core.tasks.get(taskId);
    if (!runtime?.session || (runtime.clientJobs ?? 0) <= 0) return undefined;
    return runtime.clientJobsSince ?? this.core.now();
  }

  /**
   * The host's longest-running job, or the client's work when it has no job
   * list: by the job its runner named (INF-1536), else by where it runs - a
   * Claude client here, or the computer that runs the task's work.
   */
  oldestJob(taskId: string): RunningJob | undefined {
    const host = this.core.options.oldestRunningJob?.(taskId);
    const since = this.clientJobStart(taskId);
    if (since === undefined || (host && host.startedAt <= since)) return host;
    const named = this.core.tasks.get(taskId)?.clientJob;
    if (named) return { jobId: named.id, command: named.command, startedAt: since };
    const machine = this.core.facts.machineOf(taskId);
    return {
      jobId: `client-${taskId}`,
      command: unnamedBackgroundWork(
        machine === LOCAL_MACHINE_ID
          ? undefined
          : (this.core.options.machines?.nameOf(machine) ?? `another ${COMPUTER.one}`),
      ),
      startedAt: since,
    };
  }
}

/**
 * Whether an edit since `before` named or cleared a queued row's model or
 * its basis: the asks of its shape that decide its tier and its model
 * (INF-83).
 */
function routingAskMoved(
  before: WorkShape | null | undefined,
  after: WorkShape | null | undefined,
): boolean {
  return before?.override_model_id !== after?.override_model_id || before?.basis !== after?.basis;
}
