import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { COMPUTER, HERE } from "@shared/deviceNames";
import { offeringKey, parseOfferingKey, type Slot } from "@shared/modelSlots";
import { AUTOMATIC_COMPUTER, type ComputerMove } from "@shared/placement";
import { PROVIDER_CATALOG } from "@shared/providers";
import { moveOutOfReach } from "@shared/recordBar";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import { levelDefaultReasoning, type WorkShape } from "@shared/routingPolicy";
import type { MoveDestination, MoveOptions, TaskView } from "@shared/tasks";
import {
  crewmateCardBodiesDir,
  crewmateEvidenceDir,
  crewmateSessionsDir,
  crewmateSourceCardsDir,
  crewmateTempDir,
} from "../paths";
import { errorText } from "../personal/errorText";
import type { RoutePreview } from "../routing/router";
import { LOCAL_MACHINE_ID } from "../session/session";
import type { TaskRecord } from "../storage/taskStore";
import { HANDOVER_IN_DIR_NAME } from "../tasks/handoverFiles";
import { TaskService } from "../tasks/taskService";
import { type MovedFolders, packWork, unpackWork } from "../workspace/workMove";
import type { DependencyInstall } from "../workspace/workspaceService";
import type { MoveAsk, MoveTarget, TaskRuntime } from "./crewRuntime";
import type { CrewmateSpec } from "./crewSession";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { describeStatus } from "./settleService";
import type { TaskPlacement } from "./taskPlacement";

/** The timeline line for a dependency install: a commission's (WI-7), or a moved task's where it runs now. */
export function installText(install: Exclude<DependencyInstall, { outcome: "skipped" }>): string {
  const seconds = `${Math.max(1, Math.round(install.ms / 1000))}s`;
  switch (install.outcome) {
    case "offline":
      return `the project's dependencies are installed (${seconds})`;
    case "online":
      return `dependencies installed; the shared pnpm store was missing packages, so they were fetched (${seconds})`;
    case "failed":
      return `could not install the project's dependencies - ${install.error}; the crewmate can do it itself`;
  }
}

/** A move step that threw past its own handling; the next tick tries it again. */
function warnMove(caught: unknown): void {
  console.warn("[crew] a move to another computer could not go on yet:", caught);
}

/** What the task moves reach of the supervisor beyond its options. */
export type TaskMovesHost = {
  now(): number;
  /** Where each task runs: the computer a move names, read as Runs on reads it. */
  readonly placement: TaskPlacement;
  /** The crewmate running a task here now, if one is. */
  runtime(taskId: string): TaskRuntime | undefined;
  /** Let go of a crewmate's session (`CrewSessions.releaseSession`). */
  releaseSession(runtime: TaskRuntime): void;
  /** The supervisor stops tracking a task's crewmate. */
  forgetRuntime(taskId: string): void;
  /** Open a task's conversation again, on the model a move names when it names one. */
  resumeTask(taskId: string, move?: MoveTarget): Promise<TaskRuntime>;
  /** Hand an idle crewmate what waits on its lane. */
  deliverPendingToTask(task: TaskRuntime): void;
  /** A lane's due rows go now, resuming the task if need be. */
  deliverLane(taskId: string): void;
  /** Where a task's crewmate runs: the computer that runs work its record names, or this Mac. */
  machineOf(taskId: string): string;
  /** The task builds in the personal workspace. */
  isPersonalTask(taskId: string): boolean;
  /** The work shape a task is routed by. */
  queuedShape(record: TaskRecord): WorkShape;
  /** When work the crewmate's client started on its own began running, if it still runs. */
  clientJobStart(taskId: string): number | undefined;
  /** A model by its Settings name. */
  modelName(model: { provider: string; id: string }): string;
  /** A computer that runs work is being updated now. */
  beingUpdated(deviceId: string): boolean;
  /** Take down the sign-in card a task's provider raised. */
  clearSignInCard(taskId: string): void;
  /** The app is quitting: no move starts now. */
  disposed(): boolean;
  /** Tell the window the crew's counts changed. */
  broadcastCrewCounts(): void;
};

/**
 * A started task's moves (docs/helper.md, "Moving a started task"; INF-849):
 * to another provider between turns, and to another computer at a safe
 * pause, with its key, branch, working copy and record kept, and each
 * standing move driven one step further on the shared tick.
 */
export class TaskMoves {
  /** Tasks moving to another provider now (INF-849). */
  private readonly moving = new Set<string>();
  /** Tasks whose move to another computer is being carried out now (`runComputerMove`). */
  private readonly computerMoving = new Set<string>();
  /** Tasks whose moved-off or unfinished copy is being removed now (`retireMovedSource`, `undoMovedDestination`). */
  private readonly clearingMoves = new Set<string>();
  /** In-flight moves, including reopening and source/destination cleanup, until their writes end. */
  private readonly computerMoveOperations = new Set<Promise<void>>();
  private readonly moveFact = Symbol("computer move facts");

  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: TaskMovesHost,
  ) {}

  /** The task is moving to another provider or another computer right now. */
  isMoving(taskId: string): boolean {
    return this.moving.has(taskId) || this.computerMoving.has(taskId);
  }

  /** The task's move to another computer is being carried out right now. */
  isCrossing(taskId: string): boolean {
    return this.computerMoving.has(taskId);
  }

  /** Every move operation still writing, for the quit to wait on. */
  operations(): Iterable<Promise<void>> {
    return this.computerMoveOperations.values();
  }

  /**
   * The effort a move or a reopen asks for on `model` at `level`: the
   * captain's word on the task, else the model's Settings choice, else the
   * level's default.
   */
  private effortFor(
    record: TaskRecord,
    model: { provider: string; id: string },
    level: Slot,
  ): NonNullable<CrewmateSpec["thinkingLevel"]> {
    return (
      record.shape?.override_reasoning ??
      this.options.router?.reasoningChoice(model, level) ??
      levelDefaultReasoning(level)
    );
  }

  /** The name a person knows a provider by: its catalog name, else its id. */
  private providerName(provider: string): string {
    return PROVIDER_CATALOG.find((entry) => entry.id === provider)?.name ?? provider;
  }

  /** Why a move refuses the model its card offered, when the app would now pick another. */
  private offerGone(
    plan: { record: TaskRecord; choice: { provider: string; id: string } },
    ask: MoveAsk,
  ): string | undefined {
    if (!ask.offered || offeringKey(plan.choice) === ask.offered) return undefined;
    const handle = `${plan.record.key || plan.record.id} "${plan.record.title}"`;
    return `${handle} did not move: the app would now pick ${this.host.modelName(plan.choice)}, not the model its card offered.`;
  }

  /**
   * Where a move would take a started task now (INF-849): the router's
   * evaluation for its own shape, with its current provider left out - or
   * the model named, as R0 pins one - never recorded. A refusal is text:
   * a task not started or closed, one on another computer, none that serves.
   */
  planMove(
    taskId: string,
    model?: string,
  ):
    | { refused: string }
    | {
        record: TaskRecord;
        from: string | undefined;
        preview: RoutePreview;
        choice: { provider: string; id: string };
      } {
    const record = this.options.tasks.get(taskId);
    if (!record) return { refused: `Unknown task "${taskId}".` };
    const handle = `${record.key || record.id} "${record.title}"`;
    if (record.kind !== "work" || record.status !== "active")
      return { refused: `${handle} is ${describeStatus(record)}; only started work moves.` };
    if (this.host.machineOf(taskId) !== LOCAL_MACHINE_ID)
      return {
        refused: `${handle} runs on another computer, so it stays on that computer's own subscriptions.`,
      };
    const router = this.options.router;
    const from =
      router?.servedProvider(taskId) ??
      (record.model ? parseOfferingKey(record.model).provider || undefined : undefined);
    if (!model && !from) return { refused: `${handle} has no provider on its record to move off.` };
    const { override_model_id: _named, ...shape } = this.host.queuedShape(record);
    const preview = router?.preview(
      record.prompt,
      model ? { ...shape, override_model_id: model } : shape,
      model || !from ? {} : { withoutProvider: from },
    );
    if (!preview)
      return { refused: "Automatic model choice is off, so the app cannot pick another model." };
    const choice = preview.result.choice;
    const named =
      choice && model
        ? model.includes("/")
          ? offeringKey(choice) === model
          : choice.id === model
        : true;
    if (!choice || !named)
      return {
        refused: model
          ? `${model} cannot take ${handle} now, so it stays where it runs.`
          : `No other signed-in provider can take ${handle} now, so it stays on ${this.providerName(from ?? "")}.`,
      };
    if (record.model === offeringKey(choice))
      return { refused: `${handle} already runs on ${offeringKey(choice)}.` };
    return { record, from, preview, choice: { provider: choice.provider, id: choice.id } };
  }

  /**
   * Move a started task to another provider (INF-849): the sign-in card's
   * Move, or update_task's model on started work. It keeps its key, branch,
   * working copy and record. A crewmate mid-turn moves once that turn ends,
   * and is never cut short. A refusal is text and changes nothing.
   */
  requestMove(taskId: string, ask: MoveAsk): { ok: boolean; text: string } {
    const plan = this.planMove(taskId, ask.model);
    if ("refused" in plan) return { ok: false, text: plan.refused };
    const { record, from, choice } = plan;
    const handle = `${record.key || record.id} "${record.title}"`;
    if (ask.from && from !== ask.from)
      return { ok: false, text: `${handle} already moved off ${this.providerName(ask.from)}.` };
    const gone = this.offerGone(plan, ask);
    if (gone) return { ok: false, text: gone };
    if (this.moving.has(taskId)) return { ok: false, text: `${handle} is already moving.` };
    const to = `${this.host.modelName(choice)} on ${this.providerName(choice.provider)}`;
    const runtime = this.host.runtime(taskId);
    if (runtime && runtime.state !== "idle") {
      runtime.pendingMove = ask;
      return { ok: true, text: `${handle} moves to ${to} once its crewmate's turn ends.` };
    }
    void this.runMove(taskId, ask);
    return {
      ok: true,
      text: `Moving ${handle} to ${to}; it keeps its key, branch and working copy.`,
    };
  }

  /**
   * The move itself, between turns: route again and record why, pick the
   * account, let go of the old session, write the record, take the sign-in
   * card down, end the lane's outage, and reopen in the same working copy -
   * the same conversation between two Pi providers, a new one told it moved
   * otherwise - then deliver what waited. A failure is a feed line and a
   * timeline row; the record then reopens on its new provider when next asked.
   */
  async runMove(taskId: string, ask: MoveAsk): Promise<void> {
    if (this.moving.has(taskId)) return;
    this.moving.add(taskId);
    try {
      const runtime = this.host.runtime(taskId);
      if (runtime && runtime.state !== "idle") {
        runtime.pendingMove = ask;
        return;
      }
      const plan = this.planMove(taskId, ask.model);
      const refused = "refused" in plan ? plan.refused : this.offerGone(plan, ask);
      if (refused || "refused" in plan) {
        this.options.broadcastEvent({ type: "firstmate_note", text: refused ?? "", taskId });
        return;
      }
      const { record, from, preview, choice } = plan;
      const who = ask.by === "captain" ? "the captain" : "the first mate";
      preview.reasons.push(
        ask.model
          ? `moved by ${who} to the model named`
          : `moved by ${who} off ${from ?? "its provider"}`,
      );
      this.options.router?.commit(taskId, preview);
      const accountId = this.options.accounts?.selectForSpawn(taskId, choice.provider, {
        model: choice.id,
      });
      if (runtime) {
        this.host.releaseSession(runtime);
        this.host.forgetRuntime(taskId);
      }
      const fromName = from ? this.providerName(from) : "its provider";
      const toName = this.providerName(choice.provider);
      this.options.tasks.placement.recordMove(taskId, {
        model: choice,
        accountId: accountId ?? null,
        actor: ask.by,
        text: `${who} moved it from ${fromName} to ${this.host.modelName(choice)} on ${toName}`,
        data: {
          moved: {
            from: record.model,
            to: offeringKey(choice),
            ...(accountId ? { accountId } : {}),
          },
        },
      });
      this.host.clearSignInCard(taskId);
      this.options.inbox.movedProvider(taskId);
      const level = preview.result.servedBucket ?? preview.result.bucket;
      const resumed = await this.host.resumeTask(taskId, {
        model: choice,
        ...(accountId ? { accountId } : {}),
        thinkingLevel: this.effortFor(record, choice, level),
        providerName: toName,
      });
      this.host.deliverPendingToTask(resumed);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.options.tasks.note(taskId, `its move could not reopen it: ${message}`, { news: true });
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: `Task ${this.options.tasks.get(taskId)?.title ?? taskId} could not move: ${message}`,
        taskId,
      });
    } finally {
      this.moving.delete(taskId);
      this.host.broadcastCrewCounts();
    }
  }

  /**
   * Where a started task could move now (docs/helper.md, "Moving a started
   * task"): the computer it runs on, and each other computer with why it
   * cannot take the task, when it cannot. A refusal is text.
   */
  async moveOptions(taskId: string): Promise<MoveOptions> {
    const record = this.options.tasks.get(taskId);
    if (!record) return { ok: false, text: `Unknown task "${taskId}".` };
    const refused = this.moveRefusal(record);
    if (refused) return { ok: false, text: refused };
    const from = this.computerOf(record);
    const ids = [RUNS_ON_THIS_MAC, ...(this.options.machines?.computers() ?? [])].filter(
      (id) => id !== from,
    );
    const destinations: MoveDestination[] = [];
    for (const id of ids) {
      const unavailable = await this.destinationRefusal(record, id);
      destinations.push({
        id,
        name: this.computerName(id),
        ...(unavailable ? { unavailable } : {}),
      });
    }
    return { ok: true, from: this.computerName(from), destinations };
  }

  /**
   * Move a started task to another computer (docs/helper.md, "Moving a
   * started task"): the record's Move to a computer, or move_task. It keeps
   * its key, branch, working copy, files and record. It moves at a safe
   * pause - its crewmate's turn over and nothing it started still running -
   * and no new turn starts meanwhile. A refusal is text and changes nothing.
   */
  async requestComputerMove(
    taskId: string,
    ask: string,
    by: "captain" | "firstmate",
    keep: readonly string[] = [],
  ): Promise<{ ok: boolean; text: string }> {
    const record = this.options.tasks.get(taskId) ?? this.options.tasks.resolve(taskId);
    if (!record) return { ok: false, text: `Unknown task "${taskId}".` };
    const handle = `${record.key || record.id} "${record.title}"`;
    const refused = this.moveRefusal(record);
    if (refused) return { ok: false, text: refused };
    let to: string;
    try {
      to = this.host.placement.resolveRunsOn(ask);
    } catch (caught) {
      return { ok: false, text: caught instanceof Error ? caught.message : String(caught) };
    }
    if (to === AUTOMATIC_COMPUTER)
      return { ok: false, text: `Name the computer ${handle} moves to.` };
    const from = this.computerOf(record);
    if (to === from)
      return { ok: false, text: `${handle} already runs on ${this.computerName(to)}.` };
    const kept = [...new Set(keep.map((path) => path.trim()).filter(Boolean))];
    const outside = kept.find(
      (path) => isAbsolute(path) || path === ".." || normalize(path).startsWith(`..${sep}`),
    );
    if (outside)
      return {
        ok: false,
        text: `${handle} cannot move: ${outside} is outside its working copy; keep names files in it.`,
      };
    const unavailable = await this.destinationRefusal(record, to);
    if (unavailable) return { ok: false, text: `${handle} cannot move: ${unavailable}` };
    // The record may have moved on while the destination was read.
    const now = this.options.tasks.get(record.id);
    const again = now ? this.moveRefusal(now) : `Unknown task "${taskId}".`;
    if (again) return { ok: false, text: again };
    const who = by === "captain" ? "the captain" : "the first mate";
    const toName = this.computerName(to);
    this.options.tasks.placement.setComputerMove(
      record.id,
      {
        from,
        to,
        by,
        at: this.host.now(),
        phase: "waiting",
        ...(kept.length ? { keep: kept } : {}),
      },
      {
        text: `${who} asked to move it from ${this.computerName(from)} to ${toName}`,
        actor: by,
      },
    );
    this.host.broadcastCrewCounts();
    const waiting = this.pauseBlockers(record.id);
    void this.runComputerMove(record.id);
    return {
      ok: true,
      text: waiting.length
        ? `${handle} moves to ${toName} once ${waiting.join(" and ")}. No new turn starts meanwhile.`
        : `Moving ${handle} to ${toName}; it keeps its key, branch, working copy and files.`,
    };
  }

  /** Cancel a move that has not started crossing; a refusal is text. */
  cancelComputerMove(taskId: string, by: "captain" | "firstmate"): { ok: boolean; text: string } {
    const record = this.options.tasks.get(taskId) ?? this.options.tasks.resolve(taskId);
    if (!record) return { ok: false, text: `Unknown task "${taskId}".` };
    const handle = `${record.key || record.id} "${record.title}"`;
    const move = record.shape?.computer_move;
    if (!move || move.phase === "undoing")
      return { ok: false, text: `${handle} is not moving to another computer.` };
    if (move.phase !== "waiting" || this.computerMoving.has(record.id))
      return {
        ok: false,
        text: `${handle} is already moving to ${this.computerName(move.to)}, so the move can no longer be cancelled.`,
      };
    const who = by === "captain" ? "the captain" : "the first mate";
    this.options.tasks.placement.setComputerMove(record.id, null, {
      text: `${who} cancelled its move to ${this.computerName(move.to)}; it stays on ${this.computerName(move.from)}`,
      actor: by,
    });
    this.host.broadcastCrewCounts();
    this.host.deliverLane(record.id);
    return { ok: true, text: `${handle} stays on ${this.computerName(move.from)}.` };
  }

  /**
   * A task's move as its record shows it: whether it may move now, and the
   * move that stands with what still stops a safe pause (`TaskView`).
   */
  computerMoveFacts(record: TaskRecord): Pick<TaskView, "movable" | "computerMove"> {
    return this.options.tasks.projectedFact(record, this.moveFact, () =>
      this.readComputerMoveFacts(record),
    );
  }

  private readComputerMoveFacts(record: TaskRecord): Pick<TaskView, "movable" | "computerMove"> {
    const move = record.shape?.computer_move;
    if (move) {
      if (move.phase === "undoing") return {};
      return {
        computerMove: {
          from: this.computerName(move.from),
          to: this.computerName(move.to),
          state: move.phase,
          waitingFor: move.phase === "waiting" ? this.pauseBlockers(record.id) : [],
          ...(move.problem ? { problem: move.problem } : {}),
        },
      };
    }
    if (this.moveBlocker(record)) return {};
    const from = this.computerOf(record);
    const others = [RUNS_ON_THIS_MAC, ...(this.options.machines?.computers() ?? [])].filter(
      (id) => id !== from,
    );
    return others.length ? { movable: true } : {};
  }

  /** A computer that runs work by its device id, or `this-mac`, as the record holds it. */
  computerOf(record: TaskRecord): string {
    return record.deviceId ?? RUNS_ON_THIS_MAC;
  }

  computerName(id: string): string {
    return id === RUNS_ON_THIS_MAC
      ? HERE.this
      : (this.options.machines?.nameOf(id) ?? `the other ${COMPUTER.one}`);
  }

  /** Why a task cannot move to another computer at all, or undefined when it can. */
  private moveRefusal(record: TaskRecord): string | undefined {
    return this.moveBlocker(record)?.();
  }

  /** The bulk view needs eligibility, not a refusal sentence for each row. */
  private moveBlocker(record: TaskRecord): (() => string) | undefined {
    const handle = () => `${record.key || record.id} "${record.title}"`;
    if (record.kind !== "work" || record.status !== "active" || TaskService.isClosed(record))
      return () =>
        `${handle()} is ${describeStatus(record)}; only started work moves to another computer.`;
    if (!record.sessionFile || !record.branch)
      return () => `${handle()} has no working copy of its own to move.`;
    if (this.host.isPersonalTask(record.id))
      return () => `${handle()} builds in your personal workspace, which stays on ${HERE.this}.`;
    if (record.shape?.in_place)
      return () => `${handle()} works in its project's own folder, which stays where it is.`;
    if (record.shape?.kind === "review")
      return () => `${handle()} is a review and follows its builder's computer.`;
    const move = record.shape?.computer_move;
    if (move?.phase === "waiting" || move?.phase === "moving")
      return () => `${handle()} is already moving to ${this.computerName(move.to)}.`;
    if (move) return () => `${handle()} is still finishing its last move; try again once it has.`;
    const from = this.computerOf(record);
    const machines = this.options.machines;
    if (from !== RUNS_ON_THIS_MAC && machines?.takesMoves?.(from) !== true)
      // A computer out of reach has no version to read until it is back.
      return () =>
        machines?.ready(from, record.id) !== true
          ? moveOutOfReach(this.computerName(from))
          : `Infinitary on ${this.computerName(from)} cannot move a started task yet. Update it first.`;
    return undefined;
  }

  /** Why `to` cannot take this task now, or undefined when it can. */
  private async destinationRefusal(record: TaskRecord, to: string): Promise<string | undefined> {
    const name = this.computerName(to);
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    // What a start reads of a computer: its system, chip and programs, and
    // its own sign-in where the project lives; a project kept here only
    // crosses in a bundle (docs/helper.md, "Moving a started task").
    const eligible = () =>
      this.options.automaticPlacement?.moveRefusal(
        record,
        repo,
        to === RUNS_ON_THIS_MAC ? null : to,
        name,
      );
    if (to === RUNS_ON_THIS_MAC) return eligible();
    const machines = this.options.machines;
    if (!machines?.computers().includes(to))
      return "No computer that runs work has that deviceId. Look with app_state.";
    // Reach first: a computer out of reach has no version to read until it is back.
    if (machines.ready(to, record.id) !== true) return moveOutOfReach(name);
    if (machines.takesMoves?.(to) !== true || !machines.moveIn)
      return `Infinitary on ${name} cannot take a started task yet. Update it first.`;
    const model = this.modelOfTask(record);
    if (model) {
      const pool = await machines.served(to).catch(() => undefined);
      const serves = pool
        ? (pool.modelAccounts?.has(offeringKey(model)) ?? pool.accounts.has(model.provider))
        : false;
      if (!serves)
        return `${name} has no signed-in account that serves ${this.host.modelName(model)}.`;
    }
    return eligible();
  }

  /** The model a task runs on: its newest routing choice, else its record's. */
  private modelOfTask(record: TaskRecord): { provider: string; id: string } | undefined {
    const routed = this.options.router?.servedChoice(record.id)?.model;
    if (routed) return { provider: routed.provider, id: routed.id };
    if (!record.model) return undefined;
    const parsed = parseOfferingKey(record.model);
    return parsed.provider ? { provider: parsed.provider, id: parsed.id } : undefined;
  }

  /** What still stops a safe pause for a task's move, in words; empty when nothing does. */
  private pauseBlockers(taskId: string): string[] {
    const record = this.options.tasks.get(taskId);
    if (!record) return [];
    const runtime = this.host.runtime(taskId);
    const blockers: string[] = [];
    if (
      runtime &&
      (runtime.state !== "idle" ||
        runtime.settling === true ||
        runtime.session?.isStreaming() === true)
    )
      blockers.push("its crewmate's current turn ends");
    if (
      this.options.hasRunningJobs?.(taskId) === true ||
      this.host.clientJobStart(taskId) !== undefined ||
      (runtime?.clientTasks.size ?? 0) > 0
    )
      blockers.push("the commands it started finish");
    if (record.pendingSettle) blockers.push("its merge is settled");
    // A live page, or one in the captain's hands, never moves or closes under the captain.
    if (
      this.options.browsers?.fact(taskId)?.state === "open" ||
      this.options.browsers?.withCaptain(taskId) === true
    )
      blockers.push("its browser is closed");
    if (
      this.options.tasks.graph
        .children(taskId)
        .some((child) => child.shape?.kind === "review" && !TaskService.isClosed(child))
    )
      blockers.push("its independent review finishes");
    const move = record.shape?.computer_move;
    for (const id of move ? [move.from, move.to] : []) {
      if (id === RUNS_ON_THIS_MAC) continue;
      if (this.host.beingUpdated(id) || this.options.machines?.ready(id, taskId) !== true)
        blockers.push(`${this.computerName(id)} is in reach`);
    }
    return blockers;
  }

  /** The task's own folders a move carries, here (`MOVED_FOLDERS`). */
  private localMoveFolders(taskId: string): MovedFolders {
    const paths = this.options.paths;
    return {
      evidence: crewmateEvidenceDir(paths, taskId),
      "card-bodies": crewmateCardBodiesDir(paths, taskId),
      "source-cards": crewmateSourceCardsDir(paths, taskId),
      sessions: crewmateSessionsDir(paths, taskId),
      handover: join(crewmateTempDir(paths, taskId), HANDOVER_IN_DIR_NAME),
    };
  }

  /**
   * Every standing move to another computer goes one step further: one
   * waiting for a safe pause moves once nothing stops it, a commit's old
   * working copy is removed, and a copy a move that did not finish made is
   * removed. A move a quit cut off while its work crossed did not finish.
   * Runs on the shared tick and once at boot. The work crossing and the
   * new conversation's install run on their own, so a large pack or a long
   * install never holds the rest of the tick; `computerMoving` keeps a
   * later tick from starting either twice.
   */
  async driveComputerMoves(): Promise<void> {
    for (const record of this.options.tasks.listActive()) {
      const move = record.shape?.computer_move;
      if (!move || this.computerMoving.has(record.id)) continue;
      if (move.phase === "waiting") void this.runComputerMove(record.id).catch(warnMove);
      else if (move.phase === "moving")
        await this.endUnfinishedMove(record.id, "Infinitary stopped while its work moved");
      else if (move.phase === "retiring" && (move.restartFrom !== undefined || move.preparing))
        void this.reopenMovedTask(record.id).catch(warnMove);
      else if (move.phase === "retiring") await this.retireMovedSource(record.id);
      else await this.undoMovedDestination(record.id);
    }
    // A task closed meanwhile moves no further; what its move left goes with its close.
    for (const record of this.options.tasks.listWithComputerMove()) {
      if (!TaskService.isClosed(record)) continue;
      if (this.computerMoving.has(record.id)) continue;
      this.options.tasks.placement.setComputerMove(record.id, null);
    }
  }

  /** Keep the whole lifetime, not just the task-id exclusion, for the quit to await. */
  private trackComputerMove(operation: Promise<void>): Promise<void> {
    const tracked = operation.finally(() => this.computerMoveOperations.delete(tracked));
    this.computerMoveOperations.add(tracked);
    return tracked;
  }

  /**
   * The move itself, at a safe pause: the crewmate's conversation is let
   * go, the work is packed where it runs - the branch's commits, what is
   * staged and what is not, the files git does not track and the task's own
   * folders - and unpacked on the destination, checked against what left.
   * Then the record names the destination once, the old conversation's
   * execution state is set aside, a new conversation opens there with the
   * brief and where the earlier conversation is, and the old working copy
   * goes. A failure before that commit leaves the task where it was.
   */
  runComputerMove(taskId: string): Promise<void> {
    return this.trackComputerMove(this.runComputerMoveOperation(taskId));
  }

  private async runComputerMoveOperation(taskId: string): Promise<void> {
    if (this.computerMoving.has(taskId) || this.host.disposed()) return;
    const record = this.options.tasks.get(taskId);
    const move = record?.shape?.computer_move;
    if (!record || move?.phase !== "waiting") return;
    if (this.pauseBlockers(taskId).length) {
      this.host.broadcastCrewCounts();
      return;
    }
    this.computerMoving.add(taskId);
    const machines = this.options.machines;
    const attempt = String(this.host.now());
    const pack = join(this.options.paths.crewmatesDir, taskId, "move", `move-${attempt}.pack`);
    let committed = false;
    try {
      const runtime = this.host.runtime(taskId);
      if (runtime) {
        this.host.releaseSession(runtime);
        this.host.forgetRuntime(taskId);
        await runtime.session?.closed().catch(() => {});
      }
      this.options.tasks.placement.setComputerMove(taskId, {
        ...move,
        phase: "moving",
        problem: undefined,
      });
      this.host.broadcastCrewCounts();
      mkdirSync(dirname(pack), { recursive: true, mode: 0o700 });
      let out: { head: string; branch: string; repoDir: string };
      try {
        if (move.from === RUNS_ON_THIS_MAC) {
          const { manifest } = await packWork(
            record.worktreeDir || "",
            record.branch || "",
            this.localMoveFolders(taskId),
            pack,
            move.keep,
          );
          out = { head: manifest.head, branch: manifest.branch, repoDir: record.repoDir };
        } else {
          if (!machines?.moveOut) throw new Error("this Mac cannot reach that computer's work");
          out = await machines.moveOut(move.from, taskId, attempt, pack, move.keep);
        }
      } catch (caught) {
        // Nothing has changed anywhere yet: the move waits, and says why.
        this.options.tasks.placement.setComputerMove(taskId, {
          ...move,
          problem: `its work could not be packed: ${errorText(caught)}`,
        });
        this.host.broadcastCrewCounts();
        return;
      }
      const toName = this.computerName(move.to);
      let cwd: string;
      let branch = out.branch;
      let accountId: string | undefined;
      if (move.to === RUNS_ON_THIS_MAC) {
        const model = this.modelOfTask(record);
        accountId = model
          ? this.options.accounts?.selectForSpawn(taskId, model.provider)
          : undefined;
        if (model && this.options.accounts && !accountId)
          throw new Error(
            `${HERE.this} has no signed-in account that serves ${this.host.modelName(model)}`,
          );
        const workspace = await this.options.workspace.createTaskWorktree(taskId, out.repoDir, {
          headSha: out.head,
        });
        await unpackWork(workspace.cwd, pack, this.localMoveFolders(taskId));
        cwd = workspace.cwd;
        branch = workspace.branch;
      } else {
        if (!machines?.moveIn) throw new Error(`${toName} cannot take a started task`);
        const copy = await machines.moveIn(move.to, taskId, attempt, {
          repoId: record.repoId,
          head: out.head,
          branch: out.branch,
          pack,
        });
        cwd = copy.cwd;
      }
      if (move.from !== RUNS_ON_THIS_MAC) machines?.forgetExecution?.(taskId);
      const who = move.by === "captain" ? "the captain" : "the first mate";
      this.options.tasks.placement.commitComputerMove(taskId, {
        deviceId: move.to === RUNS_ON_THIS_MAC ? null : move.to,
        repoDir: out.repoDir,
        worktreeDir: move.to === RUNS_ON_THIS_MAC ? cwd : "",
        branch,
        move: {
          ...move,
          phase: "retiring",
          problem: undefined,
          ...(move.from === RUNS_ON_THIS_MAC && record.worktreeDir
            ? { fromDir: record.worktreeDir }
            : {}),
          restartFrom: basename(record.sessionFile ?? "").replace(/\.jsonl$/, ""),
          preparing: true,
        },
        actor: move.by,
        text: `${who} moved it from ${this.computerName(move.from)} to ${toName}; it keeps its key, branch, working copy and files`,
      });
      committed = true;
      // A computer that runs work binds its own account there again.
      this.options.tasks.placement.setAccountId(taskId, accountId ?? null);
      this.host.broadcastCrewCounts();
      await rm(pack, { force: true });
      // Still held: nothing on its lane starts a turn before it reopened there.
      await this.reopenMovedTask(taskId, true);
    } catch (caught) {
      if (!committed) {
        this.computerMoving.delete(taskId);
        await this.endUnfinishedMove(taskId, errorText(caught));
      } else {
        // Its record names the destination: the next tick reopens it there.
        this.options.tasks.note(
          taskId,
          `it moved, but could not reopen yet: ${errorText(caught)}`,
          {
            news: true,
          },
        );
      }
    } finally {
      await rm(pack, { force: true }).catch(() => {});
      this.computerMoving.delete(taskId);
      this.host.broadcastCrewCounts();
    }
    if (committed) {
      this.host.deliverLane(taskId);
      await this.retireMovedSource(taskId);
    }
  }

  /**
   * A committed move's new conversation where the task runs now: it opens
   * told it moved (`restartFrom`, read by `resumeTask`), and its
   * dependencies install there before anything on its lane starts a turn,
   * as a first turn's do (`prepareFirstTurn`). The lane stays held
   * meanwhile, by the record's `preparing` until the install is over, so a
   * quit mid-install installs again at the next launch before any turn;
   * `held` says the caller already holds it, and retires the copy it left
   * itself. A failure is kept for the next tick.
   */
  private reopenMovedTask(taskId: string, held = false): Promise<void> {
    return this.trackComputerMove(this.reopenMovedTaskOperation(taskId, held));
  }

  private async reopenMovedTaskOperation(taskId: string, held = false): Promise<void> {
    if (!held) {
      if (this.computerMoving.has(taskId) || this.host.disposed()) return;
      this.computerMoving.add(taskId);
    }
    try {
      const resumed = this.host.runtime(taskId) ?? (await this.host.resumeTask(taskId));
      const machine = this.host.machineOf(taskId);
      const installing =
        machine !== LOCAL_MACHINE_ID
          ? this.options.machines?.install(machine, taskId)
          : resumed.workspace?.cwd
            ? this.options.workspace.installDependencies(resumed.workspace.cwd)
            : undefined;
      const install = await installing?.catch(
        (caught): DependencyInstall => ({ outcome: "failed", ms: 0, error: errorText(caught) }),
      );
      if (install && install.outcome !== "skipped" && this.options.tasks.get(taskId))
        this.options.tasks.note(taskId, installText(install), {
          news: install.outcome === "failed",
          data: {
            install: install.outcome,
            ms: install.ms,
            ...(install.outcome === "failed" ? { error: install.error } : {}),
          },
        });
      const prepared = this.options.tasks.get(taskId)?.shape?.computer_move;
      if (prepared?.preparing) {
        const { preparing: _done, ...rest } = prepared;
        this.options.tasks.placement.setComputerMove(taskId, rest);
      }
    } catch (caught) {
      // Its record names the destination: the next tick reopens it there.
      const problem = `it moved, but could not reopen yet: ${errorText(caught)}`;
      const move = this.options.tasks.get(taskId)?.shape?.computer_move;
      if (move && move.problem !== problem) {
        this.options.tasks.placement.setComputerMove(taskId, { ...move, problem });
        this.options.tasks.note(taskId, problem, { news: true });
      }
    } finally {
      if (!held) this.computerMoving.delete(taskId);
    }
    if (held || !this.host.runtime(taskId)) return;
    this.host.deliverLane(taskId);
    await this.retireMovedSource(taskId);
  }

  /**
   * A move that did not finish before its commit: the task stays where it
   * was, with its work and conversation there untouched, and its timeline
   * and the feed say why. What the move made on the destination is
   * removed next (`undoing`).
   */
  private async endUnfinishedMove(taskId: string, reason: string): Promise<void> {
    const record = this.options.tasks.get(taskId);
    const move = record?.shape?.computer_move;
    if (!record || !move) return;
    const from = this.computerName(move.from);
    this.options.tasks.placement.setComputerMove(
      taskId,
      { ...move, phase: "undoing", problem: reason },
      {
        text: `its move to ${this.computerName(move.to)} did not finish: ${reason}. It stays on ${from}`,
        actor: "host",
        feed: true,
      },
    );
    this.host.broadcastCrewCounts();
    await this.undoMovedDestination(taskId);
    this.host.deliverLane(taskId);
  }

  /** Removes the copy an unfinished move made on its destination; retried while out of reach. */
  private undoMovedDestination(taskId: string): Promise<void> {
    return this.trackComputerMove(this.undoMovedDestinationOperation(taskId));
  }

  private async undoMovedDestinationOperation(taskId: string): Promise<void> {
    const record = this.options.tasks.get(taskId);
    const move = record?.shape?.computer_move;
    if (!record || move?.phase !== "undoing" || this.clearingMoves.has(taskId)) return;
    this.clearingMoves.add(taskId);
    try {
      if (move.to === RUNS_ON_THIS_MAC) {
        const cwd = join(this.options.paths.worktreesDir, taskId);
        if (existsSync(cwd) && cwd !== record.worktreeDir)
          await this.options.workspace.removeTaskWorktree({
            taskId,
            cwd,
            branch: record.branch || `fm/task-${taskId}`,
            repoDir: record.repoDir,
          });
      } else {
        await this.options.machines?.retireMoved?.(move.to, taskId);
      }
      if (this.sameMove(taskId, move)) this.options.tasks.placement.setComputerMove(taskId, null);
    } catch (caught) {
      // Kept, and tried again on the next tick.
      console.warn("[crew] a moved copy could not be removed yet:", caught);
    } finally {
      this.clearingMoves.delete(taskId);
    }
  }

  /** The task's move is still `move` in the same phase: a newer ask is never cleared by an older one's end. */
  private sameMove(taskId: string, move: Pick<ComputerMove, "at" | "to" | "phase">): boolean {
    const now = this.options.tasks.get(taskId)?.shape?.computer_move;
    return (
      now !== undefined && now.at === move.at && now.to === move.to && now.phase === move.phase
    );
  }

  /** Removes the working copy a committed move left on the computer it left; retried while out of reach. */
  private retireMovedSource(taskId: string): Promise<void> {
    return this.trackComputerMove(this.retireMovedSourceOperation(taskId));
  }

  private async retireMovedSourceOperation(taskId: string): Promise<void> {
    const record = this.options.tasks.get(taskId);
    const move = record?.shape?.computer_move;
    if (!record || move?.phase !== "retiring" || this.clearingMoves.has(taskId)) return;
    // Its old conversation stays until a new one opened where it runs now.
    if (move.restartFrom !== undefined || move.preparing) return;
    this.clearingMoves.add(taskId);
    try {
      if (move.from === RUNS_ON_THIS_MAC) {
        if (move.fromDir && existsSync(move.fromDir))
          await this.options.workspace.removeTaskWorktree({
            taskId,
            cwd: move.fromDir,
            branch: `fm/task-${taskId}`,
            repoDir: record.repoDir,
          });
      } else {
        if (!this.options.machines?.retireMoved)
          throw new Error(`${this.computerName(move.from)} cannot remove it`);
        await this.options.machines.retireMoved(move.from, taskId);
      }
      if (this.sameMove(taskId, move))
        this.options.tasks.placement.setComputerMove(taskId, null, {
          text: `the working copy it left on ${this.computerName(move.from)} was removed`,
          actor: "host",
        });
    } catch (caught) {
      const problem = `the working copy it left on ${this.computerName(move.from)} is not removed yet: ${errorText(caught)}`;
      if (move.problem !== problem && this.sameMove(taskId, move))
        this.options.tasks.placement.setComputerMove(taskId, { ...move, problem });
    } finally {
      this.clearingMoves.delete(taskId);
      this.host.broadcastCrewCounts();
    }
  }
}
