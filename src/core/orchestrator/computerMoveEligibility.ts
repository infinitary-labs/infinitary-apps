import { COMPUTER, HERE } from "@shared/deviceNames";
import { offeringKey, parseOfferingKey } from "@shared/modelSlots";
import { leftBehindLine, moveOutOfReach } from "@shared/recordBar";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import type { TaskView } from "@shared/tasks";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import type { TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { describeStatus } from "./settleService";

type EligibilityHost = {
  now(): number;
  runtime(taskId: string): TaskRuntime | undefined;
  isPersonalTask(taskId: string): boolean;
  clientJobStart(taskId: string): number | undefined;
  modelName(model: { provider: string; id: string }): string;
  beingUpdated(deviceId: string): boolean;
  waitsOnAwaySource(record: TaskRecord): boolean;
};

export class ComputerMoveEligibility {
  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: EligibilityHost,
  ) {}

  /**
   * The computer a task runs on is out of reach - not catching up, not
   * being updated - so a move can only leave what it holds behind
   * (docs/helper.md, "Moving a task off a computer that is out of reach").
   */
  isAway(from: string, taskId: string): boolean {
    if (from === RUNS_ON_THIS_MAC) return false;
    const machines = this.options.machines;
    return (
      machines?.ready(from, taskId) !== true &&
      machines?.catchingUpSince?.(from, taskId) === undefined &&
      !this.host.beingUpdated(from)
    );
  }

  readComputerMoveFacts(record: TaskRecord): Pick<TaskView, "movable" | "computerMove"> {
    const move = record.shape?.computer_move;
    if (move) {
      if (move.phase === "undoing") return {};
      const home = move.phase === "waiting" ? record.shape?.home_copy : undefined;
      // A move waiting on a computer gone out of reach offers to go without it.
      const leftBehind =
        home && this.host.waitsOnAwaySource(record)
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

  computerOf(record: TaskRecord): string {
    return record.deviceId ?? RUNS_ON_THIS_MAC;
  }

  computerName(id: string): string {
    return id === RUNS_ON_THIS_MAC
      ? HERE.this
      : (this.options.machines?.nameOf(id) ?? `the other ${COMPUTER.one}`);
  }

  /** The bulk view needs eligibility, not a refusal sentence for each row. */
  moveBlocker(record: TaskRecord, replacing = false): (() => string) | undefined {
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

  async destinationRefusal(record: TaskRecord, to: string): Promise<string | undefined> {
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

  modelOfTask(record: TaskRecord): { provider: string; id: string } | undefined {
    const routed = this.options.router?.servedChoice(record.id)?.model;
    if (routed) return { provider: routed.provider, id: routed.id };
    if (!record.model) return undefined;
    const parsed = parseOfferingKey(record.model);
    return parsed.provider ? { provider: parsed.provider, id: parsed.id } : undefined;
  }

  pauseBlockers(taskId: string): string[] {
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
}
