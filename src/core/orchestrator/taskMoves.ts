import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { preparedPublicationRemote } from "@shared/contributions";
import { isCustomApiProvider } from "@shared/customApi";
import { COMPUTER, HERE } from "@shared/deviceNames";
import { englishOf, said } from "@shared/i18n/said";
import { offeringKey, parseOfferingKey, type Slot } from "@shared/modelSlots";
import { AUTOMATIC_COMPUTER, type ComputerMove } from "@shared/placement";
import { PROVIDER_CATALOG } from "@shared/providers";
import { agoWords, leftBehindLine, moveOutOfReach } from "@shared/recordBar";
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
import { type ComputerPool, servesOnComputer, servingNow } from "../routing/computerPool";
import type { RoutePreview } from "../routing/router";
import { LOCAL_MACHINE_ID } from "../session/session";
import type { TaskRecord } from "../storage/taskRecords";
import { HANDOVER_IN_DIR_NAME } from "../tasks/handoverFiles";
import { TaskService } from "../tasks/taskService";
import { defaultTaskBranch } from "../workspace/taskBranches";
import { type MovedFolders, packHomeCopy, packWork, unpackWork } from "../workspace/workMove";
import type { DependencyInstall } from "../workspace/workspaceService";
import { briefCarriesPictures } from "./crewBrief";
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

/** The model a task routed again to, the account it binds here or there, and how it opens. */
export type RoutedAgain = {
  model: { provider: string; id: string };
  /** This Mac's account for it. */
  accountId?: string;
  /** The account of a computer that runs work that serves it there. */
  binding?: string;
  thinkingLevel: NonNullable<CrewmateSpec["thinkingLevel"]>;
  /** Quick care opens a rung lower, as its start did, unless an effort was chosen. */
  quick?: true;
  providerName: string;
  /**
   * The move is recorded only once a conversation opened on this model -
   * here, or as a computer that runs work answers - with what opened:
   * `commit` writes it then, the account that computer says it bound
   * recorded as the one that serves it. It answers "stale" when a stop, a
   * close or another move took the task meanwhile, "again" when Settings
   * changed so this is no longer the model routing picks, or when the
   * conversation opened on another model or an account that does not serve
   * it now, read again where it opened: that pair is passed over, and the
   * new conversation routes among the rest, waiting once none is left. Only
   * "committed" lets the conversation take work: on any other answer it is
   * let go.
   */
  commit: (opened: OpenedOn) => Promise<RerouteOutcome>;
  /**
   * The open failed before any conversation took words: that model and
   * account are passed over, and routing again tries the rest, waiting once
   * none is left.
   */
  passOver: () => void;
};

/** What a rerouted conversation opened on: its model, and the account a computer that runs work says it bound. */
export type OpenedOn = { model?: { provider: string; id: string }; account?: string };

/** What a rerouted conversation's open came to (`RoutedAgain.commit`). */
export type RerouteOutcome = "committed" | "stale" | "again";

/**
 * A new conversation does not open: the model the task routed to left
 * every level and no other model where it opens can take it (`routeAgainIfLeft`).
 * The task says why once and its lane holds (`waitsForModel`); a reopen that
 * meets this is no failure and is tried again when that changes.
 */
export class ModelWaitError extends Error {}

/**
 * A conversation opened but was not accepted - it opened on another model
 * than it asked, or its check could not finish - so it took no words and
 * was let go: no delivery happened, and the next open tries again.
 */
export class NotAcceptedError extends Error {}

/** Why a reopen waits while this Mac's accounts have not said what they serve. */
const UNREAD_ACCOUNTS_WAIT =
  // i18n-exempt: an internal outcome and error; no person reads it.
  "This Mac's accounts have not said yet which models they serve, so its conversation waits.";

/**
 * The account of a computer that runs work that serves `model` there,
 * passing over one that already failed to open it (`failed`, as
 * provider/id@account): the pin or first that lists it, else another that
 * lists it, else - from a computer too old to list what it serves - the one
 * that serves its provider.
 */
function bindingThere(
  pool: ComputerPool,
  model: { provider: string; id: string },
  failed: ReadonlySet<string> | undefined,
): string | undefined {
  const key = offeringKey(model);
  // A computer that lists what it serves names it in the ranked pool
  // (`servingNow`); an older one, the account there for its provider.
  const account = pool.servedBy ? pool.modelAccounts?.get(key) : pool.accounts.get(model.provider);
  return account !== undefined && failed?.has(`${key}@${account}`) !== true ? account : undefined;
}

/** Why a task waits for a model (`TaskMoves.modelWaitCause`). */
export type ModelWaitCause = "none" | "update" | "unread";

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
  /** Tasks waiting for a model, with what Settings and the models were when they began. */
  private readonly modelWaits = new Map<string, string>();
  /**
   * What a task's new conversation opened on that took no words - a model
   * (provider/id), or a model and this Mac's account (provider/id@account) -
   * passed over until its routing again commits or waits (`routeAgainIfLeft`).
   */
  private readonly failedOpens = new Map<string, Set<string>>();
  /**
   * Tasks whose computer that runs work still holds a conversation this Mac
   * refused to give words to; the next open there opens anew instead of
   * reattaching to it (`refusedThere`), until an open there is accepted.
   */
  private readonly refused = new Set<string>();
  /** What each task's newest wait for a model said (`modelWaitWords`). */
  private readonly waitWords = new Map<string, ReturnType<typeof said>>();
  /**
   * Why each task waits for a model (`modelWaitCause`): no other model can
   * take it, its computer must be updated first, or this Mac's accounts have
   * not said yet what they serve.
   */
  private readonly waitCauses = new Map<string, ModelWaitCause>();
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

  /** A provider as the captain names it, for words outside the move. */
  providerLabel(provider: string): string {
    return this.providerName(provider);
  }

  /** The name a person knows a provider by: its catalog name, else its id. */
  private providerName(provider: string): string {
    return PROVIDER_CATALOG.find((entry) => entry.id === provider)?.name ?? provider;
  }

  /** The providers a move routes among, in words: this Mac's own, or the computer's the task runs on. */
  private signedInWhere(taskId: string): string {
    const machine = this.host.machineOf(taskId);
    return machine === LOCAL_MACHINE_ID
      ? "signed-in provider"
      : `provider signed in on ${this.computerName(machine)}`;
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
   * the model named, as R0 pins one - never recorded. A task on a computer
   * that runs work is routed among that computer's own sign-ins. A task
   * whose brief carries the captain's pictures moves only to a model that
   * reads them (docs/routing.md, "Pictures"). A refusal is text: a task not
   * started or closed, one whose computer is out of reach, none that serves.
   */
  async planMove(taskId: string, model?: string) {
    const source = this.modelMoveSource(taskId);
    if ("refused" in source) return source;
    // A task on a computer that runs work moves among that computer's own
    // sign-ins, never this Mac's (docs/helper.md, "Its own sign-ins").
    const machine = this.host.machineOf(taskId);
    // A computer that has said nothing of its sign-ins serves an empty pool.
    const pool =
      machine === LOCAL_MACHINE_ID ? undefined : await this.options.machines?.served(machine);
    const images = briefCarriesPictures(
      this.options.tasks,
      taskId,
      source.record.shape ?? undefined,
    );
    const prepared = await this.options.router?.prepare({ ...(pool ? { pool } : {}), images });
    return this.preparedMove(taskId, model, prepared);
  }

  async requestMove(taskId: string, ask: MoveAsk) {
    return this.requestPreparedMove(taskId, ask, await this.planMove(taskId, ask.model));
  }

  private modelMoveSource(taskId: string): { record: TaskRecord } | { refused: string } {
    const record = this.options.tasks.get(taskId);
    if (!record) return { refused: `Unknown task "${taskId}".` };
    const handle = `${record.key || record.id} "${record.title}"`;
    if (record.kind !== "work" || record.status !== "active")
      return { refused: `${handle} is ${describeStatus(record)}; only started work moves.` };
    const machine = this.host.machineOf(taskId);
    // Its conversation reopens there on the new model, so that computer must be in reach.
    if (machine !== LOCAL_MACHINE_ID && this.options.machines?.ready(machine, taskId) !== true)
      return {
        refused: `${handle} stays where it runs: ${moveOutOfReach(this.computerName(machine))}`,
      };
    return { record };
  }

  private preparedMove(
    taskId: string,
    model: string | undefined,
    prepared: import("../routing/router").PreparedRouteOptions | undefined,
  ):
    | { refused: string }
    | {
        record: TaskRecord;
        from: string | undefined;
        preview: RoutePreview;
        choice: { provider: string; id: string };
      } {
    const source = this.modelMoveSource(taskId);
    if ("refused" in source) return source;
    const { record } = source;
    const handle = `${record.key || record.id} "${record.title}"`;
    const router = this.options.router;
    const from =
      router?.servedProvider(taskId) ??
      (record.model ? parseOfferingKey(record.model).provider || undefined : undefined);
    if (!model && !from) return { refused: `${handle} has no provider on its record to move off.` };
    const { override_model_id: _named, ...shape } = this.host.queuedShape(record);
    const preview =
      router && prepared
        ? router.preview(record.prompt, model ? { ...shape, override_model_id: model } : shape, {
            ...prepared,
            ...(model || !from ? {} : { withoutProvider: from }),
          })
        : undefined;
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
          : `No other ${this.signedInWhere(taskId)} can take ${handle} now, so it stays on ${this.providerName(from ?? "")}.`,
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
  private requestPreparedMove(
    taskId: string,
    ask: MoveAsk,
    plan: Awaited<ReturnType<TaskMoves["planMove"]>>,
  ): { ok: boolean; text: string } {
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
    if (runtime && runtime.turn.busy) {
      runtime.turn.queueMove(ask);
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
      const move = async () => {
        const runtime = this.host.runtime(taskId);
        if (runtime && runtime.turn.busy) {
          runtime.turn.queueMove(ask);
          return;
        }
        const plan = await this.planMove(taskId, ask.model);
        const refused = "refused" in plan ? plan.refused : this.offerGone(plan, ask);
        if (refused || "refused" in plan) {
          this.options.broadcastEvent({ type: "firstmate_note", text: refused ?? "", taskId });
          return;
        }
        if (runtime && runtime.turn.busy) {
          runtime.turn.queueMove(ask);
          return;
        }
        const { record, from, preview, choice } = plan;
        const who = ask.by === "captain" ? "the captain" : "the first mate";
        preview.reasons.push(
          ask.model
            ? `moved by ${who} to the model named`
            : `moved by ${who} off ${from ?? "its provider"}`,
        );
        // A task on a computer that runs work binds that computer's own
        // account there when it reopens; no account of this Mac's is chosen.
        const pick =
          this.host.machineOf(taskId) === LOCAL_MACHINE_ID
            ? await this.pickAccount(taskId, choice)
            : undefined;
        const accountId = pick?.accountId;
        if (runtime && runtime.turn.busy) {
          runtime.turn.queueMove(ask);
          return;
        }
        const current = this.options.tasks.get(taskId);
        if (!current || current.status !== "active" || this.host.disposed()) return;
        if (runtime) {
          this.host.releaseSession(runtime);
          this.host.forgetRuntime(taskId);
        }
        const fromName = from ? this.providerName(from) : "its provider";
        const toName = this.providerName(choice.provider);
        // The account decision, the routing row and the record move together;
        // the account is marked selected only once they committed.
        this.options.tasks.atomic(
          () => {
            pick?.record();
            this.options.router?.commit(taskId, preview);
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
          },
          () => pick?.selected(),
        );
        const level = preview.result.servedBucket ?? preview.result.bucket;
        return {
          model: choice,
          ...(accountId ? { accountId } : {}),
          thinkingLevel: this.effortFor(record, choice, level),
          providerName: toName,
        };
      };
      const router = this.options.router;
      const prepared = router ? await router.inOrder(move) : await move();
      if (!prepared) return;
      this.host.clearSignInCard(taskId);
      this.options.inbox.movedProvider(taskId);
      const resumed = await this.host.resumeTask(taskId, prepared);
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
   * A task's next conversation when the model it routed to left every level
   * (docs/routing.md, "A model that left every level"): before a reopen or a
   * restart opens a new conversation - on this Mac, on a computer that runs
   * work, or where a move to another computer took it - the task routes
   * again on its own shape, as its start did - a review still away from its
   * builder's provider (R9) - among the models that computer's sign-ins
   * serve. A custom connection routes only among its own models. It answers
   * the model the conversation opens with, its effort, and on this Mac its
   * account; the new routing row, the record's model and account and one
   * timeline and feed line commit together, only once the conversation
   * opened on it (`RoutedAgain.commit`). Undefined keeps the routed model: a level, a
   * pin or the defaults standing in for levels still hold it, the newest
   * model chosen was named and served (at the start or by a move), or it
   * never routed. "wait" says no other model on the levels that one of the
   * computer's accounts serves can take it: the conversation does not
   * open, the task's lane holds (`waitsForModel`) and it says so once. An
   * older computer that holds a conversation open there (`attach`) could
   * bring the removed model back, so it waits too; while this Mac's accounts
   * have not said what they serve, it waits saying nothing. "stale" says a stop, a quit, a
   * close or another move took the task while it waited, so the reopen
   * opens nothing; the account it picked is recorded only with the move it
   * commits.
   */
  /**
   * Whether the task's next conversation may need routing again
   * (`routeAgainIfLeft`), read at once from the record and Settings: it is
   * active, its newest model was routed rather than named, and no pin or
   * level holds that model. A no clears its wait for a model.
   */
  mayRouteAgain(taskId: string): boolean {
    const router = this.options.router;
    const record = this.options.tasks.get(taskId);
    const routed = router?.servedChoice(taskId);
    const may =
      !!router &&
      record?.status === "active" &&
      !!routed &&
      !routed.named &&
      // A pool known to be empty: only a pin or a level holds it.
      router.holdsAtALevel(routed.model, []) !== true;
    if (!may) {
      this.modelWaits.delete(taskId);
      this.failedOpens.delete(taskId);
    }
    return may;
  }

  /**
   * Whether a conversation that opened anew on the task's routed model,
   * routing nothing, keeps it: the task names it, a level where it opened
   * holds it, or nothing can have left (`routeAgainIfLeft`). One that does
   * not takes no words, and its task routes again.
   */
  async keepsModel(taskId: string, machine = this.host.machineOf(taskId)): Promise<boolean> {
    const router = this.options.router;
    if (!router || !this.mayRouteAgain(taskId)) return true;
    const local = machine === LOCAL_MACHINE_ID;
    // What serves there now, asked after the open, never an earlier report.
    const pool = local ? undefined : await this.options.machines?.served(machine, true);
    if (!local && !pool) return true;
    const routed = router.servedChoice(taskId);
    if (!routed || routed.named) return true;
    const kept = router.holdsAtALevel(routed.model, pool?.available) === true;
    if (!kept) this.refuseOpened(taskId, machine);
    return kept;
  }

  /**
   * A conversation opened on `machine` takes no words: on a computer that
   * runs work it is still held there, so nothing reattaches to it, even
   * after this Mac restarts (`refusedThere`).
   */
  refuseOpened(taskId: string, machine: string): void {
    if (machine === LOCAL_MACHINE_ID) return;
    this.refused.add(taskId);
    this.options.machines?.refuseHeld?.(taskId, true);
  }

  /**
   * Whether the task's computer that runs work still holds a conversation
   * this Mac refused (`keepsModel`, a reroute's commit): one never reattached
   * to, so a removed model is not adopted as if it were live work.
   */
  refusedThere(taskId: string): boolean {
    return this.refused.has(taskId) || this.options.machines?.refusedHeld?.(taskId) === true;
  }

  /** An open there took words: nothing it holds is refused any more. */
  openedThere(taskId: string): void {
    if (!this.refusedThere(taskId)) return;
    this.refused.delete(taskId);
    this.options.machines?.refuseHeld?.(taskId, false);
  }

  async routeAgainIfLeft(
    taskId: string,
    asking: {
      /** The computer the conversation opens on; the task's own by default. */
      machine?: string;
      /** This open is a move's own, so that move does not supersede it. */
      ownMove?: boolean;
      /**
       * An older computer holds a conversation open there, so its open may
       * reattach to it or open it again on the model it had: when the model
       * left every level, nothing is asked of it, and the task waits.
       */
      attach?: boolean;
    } = {},
  ): Promise<RoutedAgain | "stale" | "wait" | undefined> {
    const router = this.options.router;
    if (!router || !this.mayRouteAgain(taskId)) return undefined;
    const machine = asking.machine ?? this.host.machineOf(taskId);
    const local = machine === LOCAL_MACHINE_ID;
    // A computer that runs work routes among its own sign-ins.
    const pool = local ? undefined : await this.options.machines?.served(machine);
    if (!local && !pool) return undefined;
    // Read against what serves where it opens: the pool read first, or one
    // read again since.
    const left = (record: TaskRecord | undefined, on = pool) => {
      const routed = router.servedChoice(taskId);
      if (!record || record.status !== "active" || !routed) return undefined;
      // The newest model named and served - at the start or by a move - is kept.
      if (routed.named) return undefined;
      // Undefined: what this Mac's accounts serve is not read yet.
      return router.holdsAtALevel(routed.model, on?.available) === false ? routed.model : undefined;
    };
    const asked = left(this.options.tasks.get(taskId));
    if (!asked) {
      // Whether the defaults standing in for levels hold it is not known
      // until this Mac's accounts said what they serve: nothing opens on it
      // meanwhile, and the lane holds, saying nothing, until they have.
      const routed = router.servedChoice(taskId);
      if (routed && router.holdsAtALevel(routed.model, pool?.available) === undefined) {
        this.modelWaits.set(taskId, this.modelsNow(taskId, machine));
        this.waitCauses.set(taskId, "unread");
        return "wait";
      }
      this.modelWaits.delete(taskId);
      return undefined;
    }
    // An older computer's open may only bring back the removed model there:
    // the task waits until that computer is updated, or holds no
    // conversation of it open, whatever else could take it.
    if (asking.attach) {
      this.waitForModel(taskId, asked, machine, true);
      return "wait";
    }
    // A stop, a quit, a close or a move - to another model or computer -
    // while this waited supersedes the reopen that asked: it opens nothing.
    const stale = () => {
      const current = this.options.tasks.get(taskId);
      const routed = router.servedChoice(taskId);
      return (
        !current ||
        current.status !== "active" ||
        this.host.disposed() ||
        (!asking.ownMove && this.isMoving(taskId)) ||
        this.host.machineOf(taskId) !== machine ||
        !routed ||
        offeringKey(routed.model) !== offeringKey(asked)
      );
    };
    return router.inOrder(async () => {
      if (stale()) return "stale";
      const record = this.options.tasks.get(taskId);
      const from = left(record);
      if (!record || !from) return undefined;
      // Routing again is no move to a model named: a name the start gave was
      // not the newest choice.
      const { override_model_id: _named, ...shape } = this.host.queuedShape(record);
      const builder = shape.kind === "review" ? shape.basis : undefined;
      const avoidProvider = builder ? router.servedProvider(builder) : undefined;
      const images = briefCarriesPictures(this.options.tasks, taskId, record.shape ?? undefined);
      const custom = isCustomApiProvider(from.provider);
      // Each model there is ranked on the account that would serve it now,
      // passing over one whose allowance there is spent or that failed to
      // open it, so a preview and its binding name the same account.
      const ranked = (serving: ComputerPool) =>
        servingNow(
          serving,
          this.host.now(),
          (key, account) => this.failedOpens.get(taskId)?.has(`${key}@${account}`) === true,
        );
      const prepare = (serving: ComputerPool | undefined) =>
        router.prepare({
          ...(serving ? { pool: ranked(serving) } : {}),
          ...(avoidProvider ? { avoidProvider } : {}),
          images,
        });
      const prepared = await prepare(pool);
      // A replacement no account there serves is passed over for the next,
      // and so is one that opened on another model or an account that does
      // not serve it, until this selection commits or waits.
      const passed = new Set<string>();
      const failed = this.failedOpens.get(taskId);
      const only = (model: { provider: string; id: string }) =>
        (!custom || model.provider === from.provider) &&
        !passed.has(offeringKey(model)) &&
        failed?.has(offeringKey(model)) !== true;
      const look = (on = prepared) => {
        const preview = router.preview(record.prompt, shape, { ...on, only });
        const choice = preview.result.choice;
        if (!choice || preview.requiresReasoningWait) return undefined;
        if (offeringKey(choice) === offeringKey(from)) return undefined;
        return { preview, to: { provider: choice.provider, id: choice.id } };
      };
      let found = look();
      while (found) {
        const { to } = found;
        const pick = local && !custom ? await this.pickAccount(taskId, to, failed) : undefined;
        if (stale()) return "stale";
        // What Settings holds now, after the account was chosen: a level that
        // took the old model back keeps it, and a replacement that left its
        // level meanwhile gives way to the one routing picks now.
        if (!left(this.options.tasks.get(taskId))) return undefined;
        const now = look();
        if (!now || offeringKey(now.to) !== offeringKey(to)) {
          found = now;
          continue;
        }
        const accountId = custom ? (record.accountId ?? undefined) : pick?.accountId;
        // There, the account that serves it, passing over one that already
        // failed to open it: its pin, else another that lists it.
        const binding = pool ? bindingThere(ranked(pool), to, failed) : undefined;
        // The model and account an open that failed passes over.
        const pair = (account: string | undefined) =>
          account !== undefined ? `${offeringKey(to)}@${account}` : offeringKey(to);
        const passOver = (whole: boolean) => {
          const passing = this.failedOpens.get(taskId) ?? new Set<string>();
          passing.add(whole ? offeringKey(to) : pair(pool ? binding : accountId));
          this.failedOpens.set(taskId, passing);
        };
        // Here, the account picked must serve the model now, or it would open on another.
        const servesHere = () =>
          accountId !== undefined
            ? this.options.accounts?.serves?.(accountId, to) !== false
            : custom || !this.options.accounts || this.options.accountlessServes?.(to) === true;
        const serves = pool
          ? binding !== undefined
          : servesHere() && (accountId === undefined || failed?.has(pair(accountId)) !== true);
        if (!serves) {
          passed.add(offeringKey(to));
          found = look();
          continue;
        }
        const fact = said("crewmateRoutedAgain", {
          left: this.host.modelName(from),
          model: this.host.modelName(to),
        });
        const commit = (opened: OpenedOn): Promise<RerouteOutcome> =>
          router.inOrder(async () => {
            // What serves there now, asked again after the open.
            const serving = pool ? await this.options.machines?.served(machine, true) : undefined;
            const preparedNow = await prepare(serving);
            if (stale()) {
              this.failedOpens.delete(taskId);
              return "stale";
            }
            // What Settings holds now, after the open: a level that took the
            // old model back keeps it, and a replacement that left its level
            // meanwhile gives way to the one routing picks now.
            // What it opened there takes no words, so nothing reattaches to it.
            const refuse = () => {
              this.refuseOpened(taskId, machine);
              return "again" as const;
            };
            if (!left(this.options.tasks.get(taskId), serving)) return refuse();
            const current = look(preparedNow);
            if (!current || offeringKey(current.to) !== offeringKey(to)) return refuse();
            // That computer's own account, as it says it bound it, which must
            // serve the model there now; here, the account picked, which must
            // still serve it.
            const served = pool ? opened.account : accountId;
            const onModel =
              opened.model !== undefined && offeringKey(opened.model) === offeringKey(to);
            const eligible = pool
              ? serving !== undefined &&
                servesOnComputer(serving, opened.account, to, this.host.now())
              : servesHere();
            if (!onModel || !eligible) {
              // The pair is passed over - the whole model only when no
              // account was asked for it - and the rest routing would pick,
              // a sibling account on the same model first, are tried before
              // the task waits.
              passOver(pool ? binding === undefined : accountId === undefined);
              return refuse();
            }
            const { accountId: _guessed, ...evaluated } = current.preview;
            this.options.tasks.atomic(
              () => {
                pick?.record();
                router.commit(taskId, served ? { ...evaluated, accountId: served } : evaluated);
                this.options.tasks.placement.recordMove(taskId, {
                  model: to,
                  accountId: accountId ?? null,
                  actor: "host",
                  text: englishOf(fact),
                  data: {
                    rerouted: { from: offeringKey(from), to: offeringKey(to) },
                    said: fact,
                    feedLine: true,
                  },
                });
              },
              () => pick?.selected(),
            );
            this.modelWaits.delete(taskId);
            this.failedOpens.delete(taskId);
            this.refused.delete(taskId);
            return "committed";
          });
        const level = now.preview.result.servedBucket ?? now.preview.result.bucket;
        const chosen =
          record.shape?.override_reasoning ?? router.reasoningChoice(to, level) ?? undefined;
        return {
          model: to,
          ...(accountId ? { accountId } : {}),
          ...(binding ? { binding } : {}),
          thinkingLevel: chosen ?? levelDefaultReasoning(level),
          ...(record.shape?.rigor === "quick" && !chosen ? { quick: true as const } : {}),
          providerName: this.providerName(to.provider),
          commit,
          passOver: () => passOver(pool ? binding === undefined : accountId === undefined),
        };
      }
      if (stale()) return "stale";
      if (!left(this.options.tasks.get(taskId))) return undefined;
      this.waitForModel(taskId, from, machine);
      return "wait";
    });
  }

  /**
   * Whether a task waits for a model to take it (`routeAgainIfLeft`): its
   * lane holds while it stays active and its routing choice, Settings, the
   * models here and what its computer last said it serves stay as they
   * were when the wait began, so a change to any lets it try again.
   */
  waitsForModel(taskId: string): boolean {
    const began = this.modelWaits.get(taskId);
    if (began === undefined) return false;
    if (
      this.options.tasks.get(taskId)?.status === "active" &&
      began === this.modelsNow(taskId, this.host.machineOf(taskId))
    )
      return true;
    this.modelWaits.delete(taskId);
    return false;
  }

  /** Why the task waits for a model, while it does (`waitsForModel`). */
  modelWaitCause(taskId: string): ModelWaitCause | undefined {
    return this.waitsForModel(taskId) ? (this.waitCauses.get(taskId) ?? "none") : undefined;
  }

  /** Why a reopen waiting for a model opens nothing, in the words it said once. */
  modelWaitWords(taskId: string): string {
    // i18n-exempt: an internal outcome; the wait for accounts says nothing to a person.
    if (this.modelWaitCause(taskId) === "unread") return UNREAD_ACCOUNTS_WAIT;
    const routed = this.options.router?.servedChoice(taskId);
    return englishOf(
      this.waitWords.get(taskId) ??
        said("crewmateWaitsForModel", {
          left: routed ? this.host.modelName(routed.model) : taskId,
        }),
    );
  }

  /**
   * Holds the task's lane for a model, and says why once, until it routes
   * again: no model can take it, or (`update`) an older computer holds its
   * conversation open, which only that computer's update lets move.
   */
  private waitForModel(
    taskId: string,
    from: { provider: string; id: string },
    machine: string,
    update = false,
  ) {
    this.modelWaits.set(taskId, this.modelsNow(taskId, machine));
    this.waitCauses.set(taskId, update ? "update" : "none");
    this.failedOpens.delete(taskId);
    const key = update ? `${offeringKey(from)}#update` : offeringKey(from);
    const fact = update
      ? said("crewmateWaitsForUpdate", {
          left: this.host.modelName(from),
          computer: this.computerName(machine),
        })
      : said("crewmateWaitsForModel", { left: this.host.modelName(from) });
    this.waitWords.set(taskId, fact);
    const last = this.options.tasks
      .timeline(taskId)
      .findLast(
        (event) => event.data?.rerouted !== undefined || event.data?.modelWait !== undefined,
      );
    if (last?.data?.modelWait === key) return;
    this.options.tasks.note(taskId, englishOf(fact), {
      news: true,
      feed: true,
      data: { feedLine: true, said: fact, modelWait: key },
    });
  }

  /**
   * What a wait for a model compares: where it opens, the task's newest
   * routing choice (a move writes a newer one), the routing settings, slot
   * record, levels, models and spent allowance here, and the accounts of
   * where it opens - this Mac's, or what that computer last said it serves,
   * whether it opens only what it holds, and whether it holds the task's
   * conversation open.
   */
  private modelsNow(taskId: string, machine: string): string {
    const routed = this.options.router?.servedChoice(taskId);
    return [
      machine,
      routed ? offeringKey(routed.model) : "",
      this.options.router?.routingState() ?? "",
      machine === LOCAL_MACHINE_ID
        ? (this.options.accounts?.servingState?.() ?? "")
        : [
            this.options.machines?.servedState?.(machine) ?? "",
            this.options.machines?.reattachOnly?.(machine) === true,
            this.options.machines?.conversationOpen?.(machine, taskId) === true,
          ].join("\n"),
    ].join("\n");
  }

  /**
   * The account a move to `model` on this Mac binds, the write that records
   * the pick, which the move makes in its own transaction, and the mark that
   * the account was selected, made once that transaction committed.
   */
  private async pickAccount(
    taskId: string,
    model: { provider: string; id: string },
    failed?: ReadonlySet<string>,
  ): Promise<{ accountId?: string; record(): void; selected(): void }> {
    const accounts = this.options.accounts;
    const none = () => {};
    if (!accounts) return { record: none, selected: none };
    // An account that already failed to open this model is passed over (provider/id@account).
    const prefix = `${offeringKey(model)}@`;
    const passing = [...(failed ?? [])]
      .filter((pair) => pair.startsWith(prefix))
      .map((pair) => pair.slice(prefix.length));
    if (accounts.pickForSpawn)
      return accounts.pickForSpawn(taskId, model.provider, {
        model: model.id,
        ...(passing.length > 0 ? { passing } : {}),
      });
    const accountId = await accounts.selectForSpawn(taskId, model.provider, { model: model.id });
    return { ...(accountId ? { accountId } : {}), record: none, selected: none };
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
    const away = this.isAway(from, record.id) ? await this.awayLine(record) : undefined;
    if (away && "refused" in away) return { ok: false, text: away.refused };
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
    return {
      ok: true,
      from: this.computerName(from),
      destinations,
      ...(away ? { leftBehind: away.line } : {}),
    };
  }

  /**
   * The computer a task runs on is out of reach - not catching up, not
   * being updated - so a move can only leave what it holds behind
   * (docs/helper.md, "Moving a task off a computer that is out of reach").
   */
  private isAway(from: string, taskId: string): boolean {
    if (from === RUNS_ON_THIS_MAC) return false;
    const machines = this.options.machines;
    return (
      machines?.ready(from, taskId) !== true &&
      machines?.catchingUpSince?.(from, taskId) === undefined &&
      !this.host.beingUpdated(from)
    );
  }

  /**
   * What a move off a computer out of reach continues from - the commit of
   * the task's branch this Mac holds - and what stays behind, in one line;
   * a refusal naming the ways out when this Mac holds none of its commits.
   */
  private async awayLine(
    record: TaskRecord,
  ): Promise<{ head: string; at?: number; line: string } | { refused: string }> {
    const from = this.computerName(this.computerOf(record));
    const home = await this.options.machines?.homeCopy?.(record.id).catch(() => undefined);
    if (!home)
      return {
        refused: `${record.key || record.id} "${record.title}" stays on ${from}: ${moveOutOfReach(from)} ${HERE.This} holds none of its commits, so nothing could continue elsewhere. Wait for ${from} to be back, or drop the task.`,
      };
    return {
      head: home.head,
      ...(home.at !== undefined ? { at: home.at } : {}),
      line: leftBehindLine(
        from,
        home.head,
        home.at !== undefined ? { at: home.at, now: this.host.now() } : undefined,
        HERE.this,
      ),
    };
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
    leaveBehind = false,
  ): Promise<{ ok: boolean; text: string }> {
    const record = this.options.tasks.get(taskId) ?? this.options.tasks.resolve(taskId);
    if (!record) return { ok: false, text: `Unknown task "${taskId}".` };
    const handle = `${record.key || record.id} "${record.title}"`;
    // A move waiting on a computer that went out of reach may go without it.
    const replacing = leaveBehind && this.waitsOnAwaySource(record);
    const refused = this.moveRefusal(record, replacing);
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
    const fromName = this.computerName(from);
    const toName = this.computerName(to);
    // Off a computer out of reach, it continues from what this Mac holds,
    // and only once what stays behind was said and the move leaves it.
    const away = this.isAway(from, record.id) ? await this.awayLine(record) : undefined;
    if (away && "refused" in away) return { ok: false, text: away.refused };
    if (away && !leaveBehind)
      return {
        ok: false,
        text: `${handle} did not move: ${moveOutOfReach(fromName)} ${away.line} Move it to ${toName} leaving that behind only on the captain's yes, or wait for ${fromName} to be back and it moves with everything.`,
      };
    if (away && kept.length)
      return {
        ok: false,
        text: `${handle} cannot move: keep names files in its working copy on ${fromName}, which is out of reach.`,
      };
    // The record may have moved on while the destination was read.
    const now = this.options.tasks.get(record.id);
    const again = now
      ? this.moveRefusal(now, replacing && this.waitsOnAwaySource(now))
      : `Unknown task "${taskId}".`;
    if (again) return { ok: false, text: again };
    const who = by === "captain" ? "the captain" : "the first mate";
    this.options.tasks.placement.setComputerMove(
      record.id,
      {
        from,
        to,
        by,
        at: this.host.now(),
        phase: "waiting",
        ...(kept.length ? { keep: kept } : {}),
        ...(away
          ? { away: { head: away.head, ...(away.at !== undefined ? { at: away.at } : {}) } }
          : {}),
      },
      {
        text: away
          ? `${who} asked to move it from ${fromName}, out of reach, to ${toName}, leaving behind what only ${fromName} holds`
          : `${who} asked to move it from ${fromName} to ${toName}`,
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
        : away
          ? `Moving ${handle} to ${toName} from commit ${away.head.slice(0, 7)}, which ${HERE.this} holds; it keeps its key, cards and branch, and what only ${fromName} holds stays there.`
          : `Moving ${handle} to ${toName}; it keeps its key, branch, working copy and files.`,
    };
  }

  /**
   * The crew line's word on a started task whose computer is out of reach
   * (docs/helper.md, "Moving a task off a computer that is out of reach"):
   * what this Mac holds of it, and that a move on the captain's yes
   * continues it elsewhere. Undefined while its computer is in reach, or
   * it cannot move at all. Never a wake: the first mate reads it when
   * the captain asks about the task.
   */
  awayFact(record: TaskRecord): string | undefined {
    const from = this.computerOf(record);
    if (!this.isAway(from, record.id)) return undefined;
    const waiting = this.waitsOnAwaySource(record);
    if (this.moveBlocker(record, waiting)) return undefined;
    const name = this.computerName(from);
    const home = record.shape?.home_copy;
    const held = home
      ? `${HERE.This} holds its commit ${home.sha.slice(0, 7)}, brought here ${agoWords(home.at, this.host.now())}.`
      : `${HERE.This} has no record of which of its commits it holds.`;
    return `${moveOutOfReach(name)} ${held} On the captain's yes, move_task with leave_behind continues it on another computer from what ${HERE.this} holds, leaving behind what only ${name} holds; without leave_behind, move_task says what that is and moves nothing.${waiting ? " Its move asked earlier waits for that computer meanwhile." : ""}`;
  }

  /** A move waits on the computer it leaves, which is out of reach now, and leaves nothing behind yet. */
  private waitsOnAwaySource(record: TaskRecord): boolean {
    const move = record.shape?.computer_move;
    return (
      move?.phase === "waiting" &&
      !move.away &&
      !this.computerMoving.has(record.id) &&
      this.isAway(move.from, record.id)
    );
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
      const home = move.phase === "waiting" ? record.shape?.home_copy : undefined;
      // A move waiting on a computer gone out of reach offers to go without it.
      const leftBehind =
        home && this.waitsOnAwaySource(record)
          ? leftBehindLine(
              this.computerName(move.from),
              home.sha,
              { at: home.at, now: this.host.now() },
              HERE.this,
            )
          : undefined;
      return {
        computerMove: {
          from: this.computerName(move.from),
          to: this.computerName(move.to),
          state: move.phase,
          waitingFor: move.phase === "waiting" ? this.pauseBlockers(record.id) : [],
          ...(move.problem ? { problem: move.problem } : {}),
          ...(leftBehind ? { leftBehind, toId: move.to } : {}),
        },
      };
    }
    if (this.moveBlocker(record)) return {};
    const from = this.computerOf(record);
    // Off a computer out of reach, only with a commit of it brought here to continue from.
    if (this.isAway(from, record.id) && !record.shape?.home_copy) return {};
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
  private moveRefusal(record: TaskRecord, replacing = false): string | undefined {
    return this.moveBlocker(record, replacing)?.();
  }

  /** The bulk view needs eligibility, not a refusal sentence for each row. */
  private moveBlocker(record: TaskRecord, replacing = false): (() => string) | undefined {
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
    const move = replacing ? undefined : record.shape?.computer_move;
    if (move?.phase === "waiting" || move?.phase === "moving")
      return () => `${handle()} is already moving to ${this.computerName(move.to)}.`;
    if (move) return () => `${handle()} is still finishing its last move; try again once it has.`;
    const from = this.computerOf(record);
    const machines = this.options.machines;
    // Out of reach, it moves leaving what that computer holds behind.
    if (this.isAway(from, record.id)) return undefined;
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
    const move = record.shape?.computer_move;
    // Off a computer out of reach, nothing there can be waited for: its
    // turn, its commands, its page and its review stay behind with it.
    if (move?.away && this.isAway(move.from, taskId)) {
      const blockers = record.pendingSettle ? ["its merge is settled"] : [];
      if (
        move.to !== RUNS_ON_THIS_MAC &&
        (this.host.beingUpdated(move.to) || this.options.machines?.ready(move.to, taskId) !== true)
      )
        blockers.push(`${this.computerName(move.to)} is in reach`);
      return blockers;
    }
    const runtime = this.host.runtime(taskId);
    const blockers: string[] = [];
    if (runtime && (runtime.turn.busy || runtime.session?.isStreaming() === true))
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
      else if (move.phase === "retiring" && (move.restartFrom !== undefined || move.preparing)) {
        // A reopen waiting for a model goes again once that wait ends.
        if (!this.waitsForModel(record.id)) void this.reopenMovedTask(record.id).catch(warnMove);
      } else if (move.phase === "retiring") await this.retireMovedSource(record.id);
      else await this.undoMovedDestination(record.id);
    }
    // A task closed meanwhile moves no further; what its move left goes with its close.
    for (const record of this.options.tasks.listWithComputerMove()) {
      if (!TaskService.isClosed(record)) continue;
      if (this.computerMoving.has(record.id)) continue;
      this.options.tasks.placement.setComputerMove(record.id, null);
    }
  }

  /**
   * A computer the task moved off while it was out of reach came back and
   * its copy was kept (`PlacedCopies.retireLeftover`): the task's crewmate
   * is told where, once per move, as guidance for its next turn.
   */
  tellAwayCopies(taskId: string): void {
    const record = this.options.tasks.get(taskId);
    if (!record) return;
    const copies = record.shape?.away_copies ?? [];
    if (!copies.some((copy) => copy.kept && !copy.told)) return;
    const here = this.computerOf(record);
    for (const copy of copies) {
      if (!copy.kept || copy.told) continue;
      this.options.inbox.enqueueSteerOnce(record.id, {
        facts: {
          kind: "away-copy-kept",
          computer: this.computerName(copy.from),
          ...(copy.kept.folder ? { folder: copy.kept.folder } : {}),
          ...(copy.kept.sha && copy.kept.ref
            ? { kept: { sha: copy.kept.sha, ref: copy.kept.ref } }
            : {}),
          here: here === RUNS_ON_THIS_MAC,
        },
        once: `away-copy-kept:${copy.from}:${copy.at}`,
      });
    }
    this.options.tasks.placement.setAwayCopies(
      record.id,
      copies.map((copy) => (copy.kept ? { ...copy, told: true as const } : copy)),
    );
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
    let move = record?.shape?.computer_move;
    if (!record || move?.phase !== "waiting") return;
    if (move.away && !this.isAway(move.from, taskId)) {
      // Back before its work crossed: the move carries everything it holds.
      const { away: _back, ...whole } = move;
      move = whole;
      this.options.tasks.placement.setComputerMove(taskId, whole, {
        text: `${this.computerName(whole.from)} is back before it moved, so it moves with everything it holds there`,
        actor: "host",
      });
    }
    const away = move.away;
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
        // A conversation on a computer out of reach closes there once it is back.
        if (!away) await runtime.session?.closed().catch(() => {});
      }
      // A copy it left there when it moved off that computer out of reach
      // goes first, its work saved here: its closed conversation there
      // takes no moved work.
      const leftThere = record.shape?.away_copies?.findLast((entry) => entry.from === move.to);
      if (leftThere && leftThere.kept?.removed === undefined) {
        try {
          if (!machines?.removeAwayCopy) throw new Error(`${HERE.this} cannot remove it`);
          await machines.removeAwayCopy(move.to, taskId);
        } catch (caught) {
          this.options.tasks.placement.setComputerMove(taskId, {
            ...move,
            problem: `the working copy it left on ${this.computerName(move.to)} could not be removed first: ${errorText(caught)}`,
          });
          this.host.broadcastCrewCounts();
          return;
        }
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
        if (away) {
          // What this Mac holds stands in for the working copy out of reach.
          const home = await machines?.homeCopy?.(taskId);
          if (!home) throw new Error(`${HERE.this} holds none of its commits`);
          if (home.head !== away.head)
            throw new Error(
              `the commit ${HERE.this} holds changed since the move was asked; ask again`,
            );
          if (move.to !== RUNS_ON_THIS_MAC)
            await packHomeCopy(
              home.repoDir,
              home.head,
              home.branch,
              this.localMoveFolders(taskId),
              pack,
            );
          out = { head: home.head, branch: home.branch, repoDir: home.repoDir };
        } else if (move.from === RUNS_ON_THIS_MAC) {
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
        const selecting = model
          ? this.options.accounts?.selectForSpawn(taskId, model.provider)
          : undefined;
        accountId = selecting instanceof Promise ? await selecting : selecting;
        if (model && this.options.accounts && !accountId)
          throw new Error(
            `${HERE.this} has no signed-in account that serves ${this.host.modelName(model)}`,
          );
        const workspace = await this.options.workspace.createTaskWorktree(
          taskId,
          out.repoDir,
          {
            headSha: out.head,
          },
          preparedPublicationRemote(record),
          out.branch,
        );
        // Its folders here are already the ones a move off a computer out of reach carries.
        if (!away) await unpackWork(workspace.cwd, pack, this.localMoveFolders(taskId));
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
        branch = copy.branch || out.branch;
      }
      if (move.from !== RUNS_ON_THIS_MAC) machines?.forgetExecution?.(taskId);
      const who = move.by === "captain" ? "the captain" : "the first mate";
      const fromName = this.computerName(move.from);
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
        text: away
          ? `${who} moved it from ${fromName}, out of reach, to ${toName}; it continues from commit ${out.head.slice(0, 7)}, which ${HERE.this} held, and keeps its key, cards and branch; what only ${fromName} held stays there`
          : `${who} moved it from ${fromName} to ${toName}; it keeps its key, branch, working copy and files`,
        ...(away ? { awayCopy: { from: move.from, head: out.head, at: this.host.now() } } : {}),
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
      // Its record names the destination: the next tick reopens it there,
      // and a wait for a model already said why once.
      if (caught instanceof ModelWaitError) return;
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
        // The branch here is the copy this Mac holds of a task on another
        // computer, and an away move's only one in reach: only the tree goes.
        if (existsSync(cwd) && cwd !== record.worktreeDir)
          await this.options.workspace.removeTaskWorktree(
            {
              taskId,
              cwd,
              branch: record.branch || defaultTaskBranch(taskId),
              repoDir: record.repoDir,
            },
            { keepBranch: move.from !== RUNS_ON_THIS_MAC },
          );
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
    // A copy left on a computer out of reach stays there; its return keeps
    // it by the leftover rule (`away_copies`, `PlacedCopies.retireLeftover`).
    if (move.away) {
      if (this.sameMove(taskId, move)) this.options.tasks.placement.setComputerMove(taskId, null);
      return;
    }
    this.clearingMoves.add(taskId);
    try {
      if (move.from === RUNS_ON_THIS_MAC) {
        if (move.fromDir && existsSync(move.fromDir))
          await this.options.workspace.removeTaskWorktree({
            taskId,
            cwd: move.fromDir,
            branch: record.branch || defaultTaskBranch(taskId),
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
