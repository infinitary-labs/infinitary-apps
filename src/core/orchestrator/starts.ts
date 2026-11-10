import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AttachmentRef } from "@shared/attachments";
import { isClientIssueReason } from "@shared/claudeClient";
import { COMPUTER, HERE } from "@shared/deviceNames";
import { noSignInsStartRefusal, updateStartRefusal } from "@shared/deviceSetup";
import { noNewWorkStartRefusal } from "@shared/deviceUpdateNudge";
import { forgeSignInCardId } from "@shared/forges";
import { UNCOMPARED_WAIT } from "@shared/placement";
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
import { ForgeAuthRequiredError } from "../workspace/forgeAuth";
import type { DispatchBase, WorktreeAcquisition } from "../workspace/workspaceService";
import type { CrewBrief } from "./crewBrief";
import type { CrewCore } from "./crewCore";
import type { TaskRuntime } from "./crewRuntime";
import { CrewTurn } from "./crewTurn";
import type { RunningJob } from "./idleLadder";
import { reasoningWaitGate } from "./intake";
import {
  type BriefPart,
  briefText,
  renderIntentBrief,
  renderPullRepairBrief,
  withDeliveryLine,
} from "./intentBrief";
import { unnamedBackgroundWork } from "./jobWakes";
import { namedModelOf, namedModelWords } from "./namedModel";
import { computerLeftOutWake, systemWaitWake } from "./startWakes";
import { placedCutOffStartRefusal } from "./taskPlacement";
import { withAttachmentsKept } from "./wakes";
import {
  branchFromSource,
  classifyShape,
  deliverableOf,
  withBasisVerdict,
  withDeliverable,
  workShape,
} from "./workShape";

/**
 * A crewmate start that failed. Its message reads as it always has for a
 * tool that waited on the start; `reason` is the cause alone, for a wake
 * about a task that is still there.
 */
export class StartFailure extends Error {
  constructor(readonly reason: string) {
    super(`Could not commission a crewmate: ${reason}`);
  }
}

/** What a failed start's wake says went wrong: the cause, never the tool's framing. */
export function startFailureReason(caught: unknown): string {
  if (caught instanceof StartFailure) return caught.reason;
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Why a start on request refuses a row that waits on blockers. Only a done
 * blocker clears its wait (`TaskService.blockerCleared`) and a dropped edge
 * keeps blocking until it is removed, so the tool's way out is removing the
 * edge - never dropping the blocker. The captain's refusal leaves it out.
 */
function readStartNotice(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason.length > 0
      ? parsed.reason
      : undefined;
  } catch {
    return undefined;
  }
}

/** The same waiting phrased at dispatch, once it cleared. */
function gateClearedText(gate: TaskGate): string {
  switch (gate.kind) {
    case "quota-reset":
      return gate.ref?.startsWith("bucket:")
        ? `a ${gate.ref.slice(7)} model has allowance again`
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
function worktreeText(acquired: WorktreeAcquisition, where?: string): string {
  const on = where ? ` on ${where}` : "";
  const copy =
    acquired.source === "pool"
      ? `a warm working copy was reused${on}`
      : `a new working copy was made${on}`;
  const { base } = acquired;
  switch (base.fetch) {
    case "fetched":
      return `${copy}, starting from the latest ${base.ref}`;
    case "failed":
      return `${copy}; ${base.ref} could not be refreshed (${base.fetchError ?? "unknown error"}), so it starts from the last one this machine saw`;
    case "none":
      return `${copy}, starting from ${base.ref === "HEAD" ? "the project's current commit" : base.ref}`;
  }
}

/**
 * The feed's line when a task is served from a weaker slot than it asked for
 * (P7: never a silent downgrade). When a withheld account would have served
 * the slot asked for, the line says what withholds it; otherwise that slot's
 * models had no allowance left.
 */
export function downgradeLine(
  title: string,
  served: RouteResult["bucket"],
  routed: Pick<RouteResult, "bucket" | "withheld">,
): string {
  const lead = `Using a ${served} model for "${title}"`;
  const withheld = routed.withheld;
  if (!withheld) return `${lead} - ${routed.bucket} models have used up their allowance right now.`;
  const name = catalogEntry(withheld.provider)?.name ?? "Its provider";
  const held = `${lead} - ${name}'s ${routed.bucket} models are paused`;
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

  constructor(private readonly core: CrewCore) {}

  /** The commit a branching task's working copy starts at, or undefined when it names none. */
  private async branchFromBase(
    record: TaskRecord | undefined,
    repoDir: string,
  ): Promise<DispatchBase | undefined> {
    const ref = record?.shape?.branch_from;
    if (!record || !ref) return undefined;
    const source = branchFromSource(this.core.options.tasks, ref, record.repoId, record.id);
    if ("refused" in source) throw new Error(source.refused);
    return this.core.options.workspace.baseAt(repoDir, source.ref);
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
    try {
      // Routing chose no model for a start on this Mac. With Dynamic routing
      // off, or with an account-less runtime that serves no model of its
      // own, a session opened anyway would fail as if a sign-in had lapsed.
      if (
        spec.routed &&
        !spec.routed.choice &&
        !placed &&
        (this.core.options.router?.dynamicEnabled?.() === false ||
          this.core.options.accountlessServes?.() === false)
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
          throw new Error("The computer this task runs on is out of reach.");
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
        if (record?.shape?.branch_from)
          throw new Error(
            `This task branches from ${record.shape.branch_from}, whose work is on this Mac, so it starts only on this Mac: set its Runs on to this Mac.`,
          );
        const builder = this.core.reviewBuilderOf(record);
        const headSha = builder ? record?.delivery?.headSha : undefined;
        this.core.options.tasks.placement.beginPlacementPreparation(taskId);
        elsewhere = await machines.prepare(
          machine,
          taskId,
          spec.repoId,
          builder && headSha ? { task: builder.id, headSha } : undefined,
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
        const branchFrom =
          !headSha && repoDir ? await this.branchFromBase(record, repoDir) : undefined;
        this.core.options.tasks.placement.beginPlacementPreparation(taskId);
        task.workspace = await this.core.options.workspace.createTaskWorktree(
          taskId,
          repoDir,
          headSha ? { headSha } : branchFrom,
        );
      }
      cwd ??= task.workspace?.cwd ?? "";
      const routed = spec.routed;
      const routedModel = routed?.choice;
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
        this.core.options.router?.dynamicEnabled?.() === false
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
      const session = await this.core.sessions.openCrewmate(
        task,
        {
          taskId,
          machineId: machine,
          ...(rigor === "quick" && !chosenReasoning ? { quick: true } : {}),
          cwd,
          ...(routedModel ? { model: routedModel } : {}),
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
      // The record's dispatch facts, once the crewmate really exists: the
      // model the session runs on outranks the routing choice it came from.
      this.core.options.tasks.starts.dispatch(taskId, {
        workspace: {
          // A task with no project elsewhere merges into this Mac's default workspace.
          repoDir:
            task.workspace?.repoDir ??
            repoDir ??
            (elsewhere ? await this.core.options.workspace.ensureDefaultRepo() : ""),
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
        this.core.options.tasks.note(taskId, worktreeText(acquired, where), {
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
        });
      }
      task.unsubscribe = await this.core.toolHooks.follow(task, session);
      // From here every save in the workspace carries the task (the
      // running dot), until the task closes.
      pictures = await this.core.briefs.briefPictures(
        taskId,
        spec.attachments ?? [],
        spec.messageFiles ?? [],
      );
      minted = await this.core.briefs.mintBrief(taskId, brief, spec.repoId, pictures.section);
      if (this.core.tasks.get(taskId) !== task)
        throw new Error("The task closed while its source work was being copied.");
      personal?.beginLiveTask(taskId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (
        record?.placement &&
        caught instanceof PreparationUnknown &&
        this.core.tasks.get(taskId) === task
      ) {
        // A missing reply proves neither success nor failure. Keep the choice,
        // order and demand; the next attempt reconciles this same preparation.
        this.core.tasks.delete(taskId);
        this.core.options.tasks.starts.releaseUnconfirmedStart(taskId);
        this.core.options.tasks.starts.markStartChecking(taskId);
        this.core.placement.sayAutomaticWait(this.core.options.tasks.get(taskId) ?? record);
        return { taskId, crewmate: "queued" };
      }
      if (
        record?.placement &&
        (!placed ||
          elsewhere ||
          !this.core.options.tasks.get(taskId)?.placement?.preparationStarted)
      )
        this.core.options.tasks.placement.releasePlacement(
          taskId,
          record.placement.snapshot.orderId,
          "ended",
        );
      if (caught instanceof ForgeAuthRequiredError && this.core.tasks.get(taskId) === task) {
        await task.unsubscribe?.();
        task.session?.dispose();
        this.core.tasks.delete(taskId);
        this.core.cards.deleteRowsForTask(taskId);
        if (task.workspace) {
          await this.core.options.workspace.removeTaskWorktree(task.workspace).catch(() => {});
        }
        if (!spec.fresh) throw caught;
        if (placed) {
          // The computer's own clone was refused for want of its own sign-in
          // there: the task waits for that sign-in, never this Mac's.
          this.core.placement.holdForDeviceForge(taskId, machine, caught.host);
          const waiting = this.core.options.tasks.get(taskId);
          if (waiting)
            this.core.placement.sayPlacedWait(this.core.placement.waitSubject(waiting), machine, {
              kind: "forge",
              host: caught.host,
            });
          this.core.cards.scheduleBroadcast();
          this.core.facts.broadcastCrewCounts();
          return { taskId, crewmate: "queued" };
        }
        this.core.options.tasks.starts.requeue(
          taskId,
          {
            kind: "captain",
            ref: `forge-sign-in:${caught.host}`,
            reason: `waiting for ${caught.place} sign-in`,
          },
          `waiting for ${caught.place} sign-in before starting`,
        );
        this.core.cards.hostCards.addForgeSignInCard(
          forgeSignInCardId(caught.host),
          caught.host,
          caught.place,
          0,
          { reauth: false },
        );
        this.core.cards.scheduleBroadcast();
        this.core.facts.broadcastCrewCounts();
        return { taskId, crewmate: "queued" };
      }
      if (this.core.tasks.get(taskId) !== task) {
        throw new StartFailure(message);
      }
      if (spec.asked || spec.backlog) {
        // Its answer named the task, or the captain started it from the
        // backlog, so it stays: open, waiting for the first mate's go, with
        // the working copy its retry starts on.
        await task.unsubscribe?.();
        task.session?.dispose();
        this.core.tasks.delete(taskId);
        this.core.cards.deleteRowsForTask(taskId);
        this.core.options.tasks.starts.failManualStart(taskId, message, { onRequest: true });
        this.core.cards.scheduleBroadcast();
        this.core.facts.broadcastCrewCounts();
      } else if (!spec.fresh) {
        // A failed dispatch returns the row to the queue behind a captain
        // gate - never deleted, never hot-retried by the sweep. Do not
        // requeue or delete when this attempt does not own the runtime.
        await task.unsubscribe?.();
        task.session?.dispose();
        this.core.tasks.delete(taskId);
        this.core.cards.deleteRowsForTask(taskId);
        if (task.workspace) {
          await this.core.options.workspace.removeTaskWorktree(task.workspace).catch(() => {});
        }
        this.core.options.tasks.starts.requeue(
          taskId,
          { kind: "captain", ref: "dispatch-failed", reason: message },
          `could not start: ${message}`,
        );
        this.core.cards.scheduleBroadcast();
        this.core.facts.broadcastCrewCounts();
      } else {
        await this.core.sessions.cleanupFailedSpawn(task);
      }
      throw new StartFailure(message);
    }
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
          await this.settleStartAttempt(record, audience);
          // A failed start already told the first mate (queued-start-failed).
          if (failed) return;
          // A wait the tile names, or a start, needs no word; any other wait
          // is told to the first mate, whose answer no longer said it.
          const outcome = await this.startOutcome(record.id, "It", audience);
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
   * A start the first mate asked for that failed before its crewmate and
   * working copy began stays open for its go, update_task start_now, as
   * `startTask`'s asked failure leaves one that got further.
   */
  private keepFailedAskedStart(taskId: string, reason: string): void {
    const record = this.core.options.tasks.get(taskId);
    if (!record || record.startNotice || this.core.tasks.has(taskId)) return;
    if (
      record.status === "open" ||
      (record.status === "active" && !record.worktreeDir && !record.sessionFile)
    )
      this.core.options.tasks.starts.failManualStart(taskId, reason, { onRequest: true });
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
        () => {
          const took = this.core.options.tasks.get(taskId)?.model ?? null;
          if (!named) return;
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
          this.keepFailedAskedStart(taskId, reason);
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
      const ignoreAsk = options.ignoreAsk || record.shape?.placement_fallback_accepted === true;
      const repo = record.repoId ? this.core.options.repos.get(record.repoId) : undefined;
      const choice =
        automatic && repo
          ? await this.core.options.automaticPlacement?.choose(
              record,
              repo,
              this.queuedBrief(record, shape),
              shape,
              { ignoreAsk },
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
        // No computer serves the level it asked for: held on that level's
        // reset with one wake, as a This computer start is (P7 + R1).
        if (waiting?.held) {
          this.holdForReasoning(taskId, record.title, gate, waiting.held);
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
          ? await this.core.placement.routeTask(taskId, record.prompt, shape, target)
          : undefined);
      // From here to the claim nothing waits; a quit that came meanwhile starts nothing.
      if (this.core.disposed()) return;
      if (moved()) return this.dispatchOnce(taskId, options);
      if (!routed?.choice && signInWait()) return;
      if (!ignoreAsk && routed && requiresReasoningWait(shape, routed)) {
        // The user's premium ask - or an escalation's rung (S4) - still
        // cannot be served when the gate clears: re-gate on the quota reset
        // instead of quietly starting lower (P7) - the commission-time
        // protection, applied at dispatch too. update_task start_now passes
        // ignoreAsk.
        this.holdForReasoning(taskId, record.title, gate, routed);
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
        ...(options.message?.attachments.length
          ? { attachments: options.message.attachments }
          : {}),
        ...(options.message?.files.length ? { messageFiles: options.message.files } : {}),
      });
      if (start.crewmate === "queued") return;
      this.core.placement.sayPlacedStarted(taskId);
      const because = gate
        ? gateClearedText(gate)
        : blockers.length > 0
          ? `${blockers.map((blocker) => `task ${blocker.id}`).join(" and ")} finished`
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
      // only to say which model took a task the captain named one for; a
      // failure or a wait its tile does not name wakes it from `startBehind`.
      const started = this.core.options.tasks.get(taskId);
      const model = started && namedModelOf(started);
      if (options.requested?.behind && model) {
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
      // A quit stops a start behind the first mate's answer; it did not fail.
      // The row stays as the quit left it, queued, for the next launch's
      // sweep, and nobody is told.
      if (options.requested?.behind && this.core.disposed()) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      if (asked && !(caught instanceof ForgeAuthRequiredError))
        this.keepFailedAskedStart(taskId, startFailureReason(caught));
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
      if (
        caught instanceof ForgeAuthRequiredError &&
        current?.status === "active" &&
        current.deviceId &&
        current.deviceId !== LOCAL_MACHINE_ID
      ) {
        // Refused on that computer for want of its own sign-in: held for it.
        this.core.placement.holdForDeviceForge(taskId, current.deviceId, caught.host);
        this.core.placement.sayPlacedWait(
          this.core.placement.waitSubject(current),
          current.deviceId,
          {
            kind: "forge",
            host: caught.host,
          },
        );
        this.core.cards.scheduleBroadcast();
      } else if (caught instanceof ForgeAuthRequiredError && current?.status === "active") {
        this.core.options.tasks.starts.requeue(
          taskId,
          {
            kind: "captain",
            ref: `forge-sign-in:${caught.host}`,
            reason: `waiting for ${caught.place} sign-in`,
          },
          `waiting for ${caught.place} sign-in before starting`,
        );
        this.core.cards.hostCards.addForgeSignInCard(
          forgeSignInCardId(caught.host),
          caught.host,
          caught.place,
          0,
          { reauth: false },
        );
        this.core.cards.scheduleBroadcast();
      } else if (
        current?.status === "active" &&
        !current.worktreeDir &&
        !this.core.tasks.has(taskId)
      ) {
        if (
          options.requested?.by === "captain" &&
          (current.startPolicy === "on-request" || options.requested.backlog)
        ) {
          this.core.options.tasks.starts.failManualStart(taskId, message, { onRequest: true });
        } else {
          this.core.options.tasks.starts.requeue(
            taskId,
            { kind: "captain", ref: "dispatch-failed", reason: message },
            `could not start: ${message}`,
          );
        }
      }
      this.core.facts.broadcastCrewCounts();
      return true;
    }
    this.core.facts.broadcastCrewCounts();
  }

  /**
   * The preview published before the slow start either becomes the claimed
   * row, a known hold, a lost-contact check, or a confirmed failure.
   * Holds keep their existing route. An unknown outcome is not a failure.
   */
  private async settleStartAttempt(
    record: TaskRecord,
    audience: "tool" | "captain",
  ): Promise<void> {
    if (!this.core.options.tasks.starts.startAttemptOf(record.id)) return;
    const now = this.core.options.tasks.get(record.id);
    if (!now) {
      this.core.options.tasks.starts.clearStartAttempt(record.id);
      return;
    }
    if (now.status === "active") {
      if (
        now.activity === "starting" &&
        !this.core.tasks.has(now.id) &&
        now.deviceId &&
        this.core.facts.outOfReach(now.id)
      ) {
        this.core.options.tasks.starts.markStartChecking(now.id);
        return;
      }
      this.core.options.tasks.starts.clearStartAttempt(now.id);
      return;
    }
    if (now.shape?.placement_wait) {
      this.core.options.tasks.starts.clearStartAttempt(now.id);
      return;
    }
    const signIn = now.deviceId ? this.core.options.machines?.signInWait(now.deviceId) : undefined;
    const setup = now.deviceId
      ? await this.core.placement.placedWaitFor(now.deviceId, now.repoId)
      : undefined;
    if (now.gate || signIn || setup || (now.deviceId && this.core.facts.outOfReach(now.id))) {
      this.core.options.tasks.starts.clearStartAttempt(now.id);
      return;
    }
    if (audience === "captain" && record.startPolicy === "on-request" && !now.startNotice) {
      this.core.options.tasks.starts.failManualStart(now.id, "it did not start", {
        onRequest: true,
      });
      return;
    }
    this.core.options.tasks.starts.clearStartAttempt(now.id);
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
    await this.settleStartAttempt(record, asCaptain ? "captain" : "tool");
    return (await this.startOutcome(record.id, handle, audience)).text;
  }

  /**
   * What a requested start came to, in words for whoever asked: started,
   * still being checked, or the wait it holds on. `shown` says the task's
   * tile already tells it - a start, a check, or a placement wait in its own
   * words - so a start behind the first mate's answer tells it the rest.
   */
  private async startOutcome(
    taskId: string,
    handle: string,
    audience: "tool" | "captain",
  ): Promise<{ text: string; shown: boolean }> {
    const told = (text: string) => ({ text, shown: false });
    const now = this.core.options.tasks.get(taskId);
    if (this.core.options.tasks.starts.startAttemptOf(taskId)?.phase === "checking") {
      return { text: `${handle} is still starting. Checking whether it started.`, shown: true };
    }
    if (now?.status !== "active" && now?.deviceId && this.core.facts.outOfReach(taskId)) {
      const place = this.core.options.machines?.placeOf(now.deviceId);
      const who = place?.who ?? "the computer it runs on";
      if (this.core.options.takesNoWorkUntilUpdated?.(now.deviceId))
        return told(noNewWorkStartRefusal(handle, who, HERE.this));
      return told(
        `${handle} waits for ${who}, which is out of reach. It never runs on ${HERE.this} instead.`,
      );
    }
    const signIn =
      now?.status !== "active" && now?.deviceId
        ? this.core.options.machines?.signInWait(now.deviceId)
        : undefined;
    if (now?.deviceId && signIn) {
      const place = this.core.options.machines?.placeOf(now.deviceId);
      return told(
        placedCutOffStartRefusal(
          handle,
          place?.who ?? "the computer it runs on",
          signIn,
          this.core.now(),
        ),
      );
    }
    if (now?.status !== "active" && now?.deviceId && !now.gate) {
      const waitFor = await this.core.placement.placedWaitFor(now.deviceId, now.repoId);
      if (waitFor?.kind === "no-sign-ins") {
        const place = this.core.options.machines?.placeOf(now.deviceId);
        return told(noSignInsStartRefusal(handle, place?.who ?? "the computer it runs on"));
      }
      if (waitFor?.kind === "update") {
        const place = this.core.options.machines?.placeOf(now.deviceId);
        return told(updateStartRefusal(handle, place?.who ?? "the computer it runs on"));
      }
    }
    const automaticWait = now?.shape?.placement_wait?.words;
    if (now?.status !== "active" && automaticWait)
      return { text: `${handle}: ${automaticWait}`, shown: true };
    if (now?.status !== "active") {
      const notice = readStartNotice(now?.startNotice);
      const why = notice ?? now?.gate?.reason;
      const text = `${handle} could not start${why ? `: ${why}` : ""}${audience === "tool" ? "; see the feed" : ""}.`;
      // A gate is named on the tile (`queueWaitOf`), and a gate with a wake
      // of its own - a level's reset, a failed start - already sent it.
      return now?.gate ? { text, shown: true } : told(text);
    }
    // A model the captain named routes only when it can serve; the tool's
    // answer says which model took the task, so the Firstmate never reports
    // the named one when routing fell back.
    const named = namedModelOf(now);
    return {
      text:
        audience === "tool" && named
          ? `Started ${handle} ${namedModelWords(named)}.`
          : `Started ${handle}.`,
      shown: true,
    };
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
   * A queued premium ask or escalation rung that nothing can serve waits on
   * its level's quota reset (P7 + R1), with one wake the first time that gate
   * is set (`gate` is the row's gate before this dispatch).
   */
  private holdForReasoning(
    taskId: string,
    title: string,
    gate: TaskGate | null,
    routed: RouteResult,
  ): void {
    const waitGate = reasoningWaitGate(routed.bucket);
    if (gate?.kind === waitGate.kind && gate.ref === waitGate.ref) return;
    this.core.options.tasks.placement.setGate(
      taskId,
      waitGate,
      routed.emptyBucket
        ? `held: no model is placed at ${routed.bucket}`
        : `held: no ${routed.bucket} model has allowance`,
    );
    this.wakeReasoningWait(taskId, title, routed);
  }

  /**
   * An Automatic task held on its own level's reset (`holdForReasoning`).
   * Another computer's headroom at that level can end the hold, and only its
   * choice reads that, so the gate sweep asks it again each pass.
   */
  heldOnItsLevel(record: TaskRecord): boolean {
    const shape = record.shape;
    const bucket =
      shape && (shape.premium_ask || shape.escalation) ? tierFor(shape).bucket : undefined;
    return (
      bucket !== undefined &&
      record.gate?.kind === "quota-reset" &&
      record.gate.ref === reasoningWaitGate(bucket).ref &&
      this.core.placement.automaticFor(record)
    );
  }

  /**
   * The ask-first wake (P7 + R1; cards/tasks/agents P0, WI-3): the user
   * explicitly asked for a reasoning class no model can serve right now.
   * The row already waits on that class's quota reset - the safe default -
   * and the Firstmate may start it lower with update_task start_now, or
   * drop it. With no model in that class at all there is no reset to wait
   * for, and the wake says the wait ends when one is placed there.
   * Deduped by content on the task's ref.
   */
  private wakeReasoningWait(taskId: string, title: string, routed: RouteResult): void {
    this.core.hooks().notifyOp(
      {
        facts: {
          kind: "reasoning-wait",
          task: { id: taskId, title },
          requested: routed.bucket,
          ...(routed.servedBucket ? { served: routed.servedBucket } : {}),
          ...(routed.emptyBucket ? { empty: true as const } : {}),
        },
      },
      "agent",
      taskId,
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
