import { createHash, randomUUID } from "node:crypto";
import {
  checkSnapshotSummary,
  currentCheckStatus,
  type MainCheckEvidence,
} from "@shared/checkSnapshot";
import { checksTimes } from "@shared/checksSpan";
import { forgeOf, hasChangeRequests } from "@shared/forge";
import type { RepoView } from "@shared/repos";
import {
  allowanceResetOf,
  describeCheckState,
  type Forge,
  type ForgeChange,
  type ForgeCheck,
  type ForgeCheckState,
  type ForgePull,
  isRedCheckState,
  isSignInForgeFailure,
  isTransientForgeFailure,
  QUEUE_STATUS,
} from "../forge";
import { currentChange } from "../storage/changeProjection";
import type { CiWatch, TaskDelivery, TaskRecord } from "../storage/taskStore";
import type { TaskService } from "../tasks/taskService";
import {
  type ChangeContext,
  type ChangeDeliveryOptions,
  type CheckedChange,
  changeWords,
  crewSignInText,
  numberLabel,
  placeWords,
  type SignInFact,
} from "./changeContext";
import { observeCheckRepair } from "./checkRepair";
import { armWatch, type WatchedCheck, type WatchedReading } from "./checkWatch";
import type { DraftReadiness } from "./draftReadiness";
import type { MainBranchReading } from "./mainCheckWake";
import { type ProjectQueue, queueWakeWords } from "./projectQueue";

/**
 * `merged`: no open change for the branch, and the pull request the task
 * names reads merged by its number - put in where the project lives
 * outside the app (FI3-213). Nothing is left to check or to merge.
 */
export type PrCiOverall = "green" | "red" | "pending" | "no-pr" | "merged";

/**
 * One check_pr_ci run: its text, whether it recorded a reading, and any raw
 * failure - with whether the forge typed it transient, the one kind a
 * put-in retries. `checked` is the change this run read and recorded, and
 * `merged` the task's pull request it found merged outside the app: the
 * put-in that follows acts on this run's reading alone.
 */
export type CheckRun = {
  text: string;
  recorded: boolean;
  problem?: string;
  transient?: boolean;
  signIn?: SignInFact;
  checked?: CheckedChange;
  merged?: { pull: ForgePull; forge: Forge };
};

/**
 * Who reads a check's text: the Firstmate's check_pr_ci, the crewmate's
 * check_change, or the host's own check watch (`./checkWatch.ts`).
 */
type Audience = "firstmate" | "crewmate" | "watch";

/**
 * The checks on a task's change where the project lives: read, recorded on
 * the task's delivery facts, and said to whoever asked.
 */
export class ChangeChecks {
  private readonly options: ChangeDeliveryOptions;

  constructor(
    private readonly context: ChangeContext,
    private readonly readiness: DraftReadiness,
    private readonly queue?: ProjectQueue,
  ) {
    this.options = context.options;
  }

  /**
   * Exact-version check status at the last reading's time, not a separate
   * judgment of the work. The crew expresses that by making its merge offer.
   */
  reading(taskId: string): { overall: PrCiOverall; at: number } | undefined {
    const delivery = this.options.tasks.get(taskId)?.delivery;
    if (!delivery || delivery.ciAt === undefined) return undefined;
    const overall = currentCheckStatus(delivery);
    return overall ? { overall, at: delivery.ciAt } : undefined;
  }

  /**
   * check_pr_ci's verdict alone, for a caller that only needs the overall
   * reading rather than the tool's descriptive text - the crewmate
   * completion-card CI gate (`CrewmateCards.pendingCiGate`), which must
   * not let a stale or never-checked reading read as green. Answers
   * "pending" unless THIS call recorded a reading: an early return or a
   * failed forge call leaves an earlier reading on the record, and that
   * reading says nothing about the head the card is about now.
   */
  async checkOverall(taskId: string): Promise<PrCiOverall> {
    return (await this.readForOffer(taskId)).overall;
  }

  /** Whether this lookup obtained the proposed change, not a judgment of its readiness. */
  async readForOffer(taskId: string): Promise<{
    overall: PrCiOverall;
    recorded: boolean;
    problem?: string;
  }> {
    const run = await this.run(taskId);
    return {
      overall: run.recorded ? (this.reading(taskId)?.overall ?? "pending") : "pending",
      recorded: run.recorded,
      ...(run.problem ? { problem: run.problem } : {}),
    };
  }

  /**
   * The check watch's read (`./checkWatch.ts`): the forge calls a reading
   * makes, answered as a typed fact rather than tool text. A reading
   * records pending as well as settled checks, so every surface follows a
   * new head immediately. Pending readings spend no repair round.
   */
  async readWatched(taskId: string): Promise<WatchedReading> {
    const located = this.context.locate(taskId);
    if ("said" in located) return { kind: "failed", transient: false, problem: located.said };
    const { record, forge } = located;
    const current = currentChange(record.delivery, located.branch);
    const branch = current.branch;
    try {
      let change = await this.checkChange(record, branch, forge, located.repo);
      if (!change) {
        const pull = await this.namedPull(forge, current.number);
        this.assertCheckTarget(record);
        this.record(record.id, pull?.merged ? "merged" : "no-pr");
        if (pull?.merged)
          this.options.tasks.delivery.recordChangeEvidence(record.id, { headSha: pull.headSha });
        return { kind: "gone" };
      }
      change = await this.readiness.readyPrerequisite(taskId, forge, change);
      const checks = await forge.checks(change);
      const main = await this.mainEvidence(record, forge, change, checks);
      this.assertCheckTarget(record);
      const observationId = this.observeChecks(taskId, change.headSha, checks, false);
      this.queue?.observe(taskId, change.headSha, checks.items);
      const words = changeWords(forge, change);
      // The watch's own reading leaves the watch as it is (`watchAfter`),
      // whether its checks still run or not.
      this.record(
        record.id,
        "pending",
        { change, forge },
        "watch",
        false,
        checks.items,
        checks.complete,
        checks.problem,
        main,
      );
      if (checks.problem)
        return {
          kind: "failed",
          transient: false,
          problem: checks.problem,
          observationId,
          recorded: true,
        };
      if (this.checksPending(record, { change, forge }, checks)) {
        const failing = named(checks.items.filter((check) => isRedCheckState(check.state)));
        const queue = this.queueWake(taskId, change.headSha, checks.items);
        return {
          kind: "pending",
          observationId,
          head: change.headSha,
          change: words,
          pending: named(checks.items.filter((check) => check.state === "pending")),
          ...(failing.length > 0 ? { failing } : {}),
          ...(queue ? { queue } : {}),
        };
      }
      return {
        kind: "finished",
        observationId,
        head: change.headSha,
        change: words,
        checks: checks.items,
      };
    } catch (caught) {
      if (isSignInForgeFailure(caught)) {
        return {
          kind: "failed",
          transient: false,
          problem: crewSignInText(
            this.context.signInFact(forge, located.repo?.id ?? record.repoId),
          ),
          signIn: true,
        };
      }
      // A spent allowance is a wait until the host's reset (INF-2149).
      const retryAt = allowanceResetOf(caught);
      return {
        kind: "failed",
        transient: isTransientForgeFailure(caught) || retryAt !== undefined,
        problem: caught instanceof Error ? caught.message : String(caught),
        ...(retryAt !== undefined ? { retryAt } : {}),
      };
    }
  }

  /**
   * The default branch's newest run of each check a reading of the task's
   * own pull request found red (INF-1915 fix 1): evidence about the
   * failure's cause for the crew's diagnosis and the completion card, never
   * a merge input, though the card's checks hold reads it (a failure that
   * branch fails too lets the card up at once, stated from this fact). Kept
   * from the last reading while the same checks fail at
   * the same version; absent for a selected pull request, where the host
   * cannot read a branch's checks apart from a proposed change, when nothing
   * failed, or when that read itself failed.
   */
  private async mainEvidence(
    record: TaskRecord,
    forge: Forge,
    change: ForgeChange,
    checks: { items: readonly ForgeCheck[] },
  ): Promise<(MainCheckEvidence & { head: string }) | undefined> {
    if (record.delivery?.checkTarget || !forge.branchChecks) return undefined;
    const failedNames = (items: readonly Pick<ForgeCheck, "name" | "state">[]): string[] =>
      items.filter((check) => isRedCheckState(check.state)).map((check) => check.name);
    const failed = failedNames(checks.items);
    if (failed.length === 0) return undefined;
    const before = record.delivery;
    const kept = before?.mainChecks;
    if (
      kept?.head === change.headSha &&
      before?.checks?.headSha === change.headSha &&
      JSON.stringify([...failedNames(before.checks.items)].sort()) ===
        JSON.stringify([...failed].sort())
    )
      return kept;
    try {
      const main = await forge.branchChecks();
      return {
        head: change.headSha,
        sha: main.sha,
        at: this.context.now(),
        items: main.checks.items
          .filter((check) => failed.includes(check.name))
          .map(({ name, state }) => ({ name, state })),
      };
    } catch (caught) {
      console.warn("[crew] could not read the default branch's run of a failed check:", caught);
      return undefined;
    }
  }

  /**
   * The default branch's own checks (INF-833 Fix 4): the commit they were
   * read on, and each check as `checks()` names it. A host that cannot read
   * a branch's checks apart from a proposed change is unsupported, and the
   * named task's close remains the resume.
   */
  async readDefaultBranchChecks(repoId: string): Promise<MainBranchReading> {
    const repo = this.options.repos.get(repoId);
    if (!repo) return { kind: "unsupported" };
    const forge = this.options.forgeFor(repo);
    if (!forge.hasChecks || !forge.branchChecks) return { kind: "unsupported" };
    try {
      const read = await forge.branchChecks();
      return {
        kind: "read",
        sha: read.sha,
        items: read.checks.items,
        complete: read.checks.complete,
        problem: read.checks.problem,
      };
    } catch (caught) {
      console.warn("[crew] could not read the default branch's checks:", caught);
      const retryAt = allowanceResetOf(caught);
      return {
        kind: "failed",
        problem: caught instanceof Error ? caught.message : String(caught),
        ...(retryAt !== undefined ? { retryAt } : {}),
      };
    }
  }

  private assertCheckTarget(record: NonNullable<ReturnType<TaskService["get"]>>): void {
    if (
      this.options.tasks.get(record.id)?.delivery?.checkTarget?.id !==
      record.delivery?.checkTarget?.id
    )
      throw new Error("A newer pull request selection superseded this check reading.");
  }

  private async checkChange(
    record: NonNullable<ReturnType<TaskService["get"]>>,
    branch: string,
    forge: Forge,
    /** The project the change is in, as `locate` found it (INF-2510). */
    repo: RepoView | undefined,
  ): Promise<ForgeChange | null> {
    const target = record.delivery?.checkTarget;
    if (!target) return forge.changeFor(branch);
    const origin = forgeOf(repo?.origin);
    if (
      origin.host !== target.host ||
      origin.owner !== target.owner ||
      origin.name !== target.name
    ) {
      throw new Error(
        "The project no longer names the selected pull request's host and repository.",
      );
    }
    const change = await forge.changeFor(target.branch);
    if (change && (change.number !== target.number || change.branch !== target.branch)) {
      throw new Error(
        "The selected branch now names a different pull request; select the intended pull request again.",
      );
    }
    return change;
  }

  async run(taskId: string, audience: Audience = "firstmate"): Promise<CheckRun> {
    const located = this.context.locate(taskId);
    if ("said" in located) return { text: located.said, recorded: false };
    const { record, forge } = located;
    const current = currentChange(record.delivery, located.branch);
    const branch = current.branch;
    try {
      let change = await this.checkChange(record, branch, forge, located.repo);
      if (!change) {
        // The pull request the task names may have been merged or closed
        // outside the app: read it by its number, never guessed from its
        // absence among the open ones (FI3-213).
        const pull = await this.namedPull(forge, current.number);
        this.assertCheckTarget(record);
        if (pull?.merged) {
          this.record(record.id, "merged");
          this.options.tasks.delivery.recordChangeEvidence(record.id, { headSha: pull.headSha });
          return {
            text: mergedWords(forge, pull, audience),
            recorded: true,
            merged: { pull, forge },
          };
        }
        this.record(record.id, "no-pr");
        return {
          text: hasChangeRequests(forge.kind)
            ? `overall: no-pr\nNo open PR found for branch ${branch}.${pull ? ` ${numberLabel(forge, pull.number)} was closed without merging.` : ""}`
            : `overall: no-pr\nNothing pushed for branch ${branch}${forge.place ? ` on ${forge.place}` : ""} yet.`,
          recorded: true,
        };
      }
      change = await this.readiness.readyPrerequisite(taskId, forge, change);
      const checks = await forge.checks(change);
      const main = await this.mainEvidence(record, forge, change, checks);
      const mergeability =
        change.number !== undefined && forge.pull ? await forge.pull(change.number) : undefined;
      this.assertCheckTarget(record);
      this.observeChecks(taskId, change.headSha, checks, audience === "crewmate");
      this.queue?.observe(taskId, change.headSha, checks.items);
      const stillRunning = this.checksPending(record, { change, forge }, checks);
      this.record(
        record.id,
        "pending",
        { change, forge },
        audience,
        stillRunning,
        checks.items,
        checks.complete,
        checks.problem,
        main,
      );
      const lines = checks.items.map(
        (check) => `- ${check.name}: ${describeCheckState(check.state)}`,
      );
      const after = this.options.tasks.get(record.id)?.delivery;
      const watched = stillRunning && after?.ciWatch?.head === change.headSha;
      const earlyOwed = watched && after?.ciWatch?.failureSeen !== true;
      const held = this.readiness.readinessProblem(taskId, change);
      return {
        text: [
          `${changeWords(forge, change)} head ${change.headSha}`,
          `facts: ${JSON.stringify({
            // Passing the id back to check_change selects this same change (INF-2490).
            change: {
              id: this.context.changeRecordOf(record, change)?.id ?? null,
              base: mergeability?.base ?? change.base ?? null,
            },
            headSha: change.headSha,
            currentHead: mergeability?.headSha ?? change.headSha,
            moved:
              (record.delivery?.headSha !== undefined &&
                record.delivery.headSha !== change.headSha) ||
              (mergeability !== undefined && mergeability.headSha !== change.headSha),
            mergeable: mergeability?.mergeable ?? null,
            readiness: mergeability?.readiness ?? null,
            mergeableState: mergeability?.mergeableState ?? null,
            complete: checks.complete ?? null,
            problem: checks.problem ?? null,
            repairChecksNotInReading: (after?.ciRepair?.repairs ?? [])
              .filter(
                (repair) =>
                  !repair.outcome && !checks.items.some((check) => check.name === repair.check),
              )
              .map((repair) => ({ id: repair.id, headSha: repair.headSha, check: repair.check })),
            checks: checks.items.map((check) => ({
              ...check,
              run: check.run ?? null,
              workflow: check.workflow ?? null,
              event: check.event ?? null,
            })),
            // The default branch's newest run of each failed check: evidence
            // about the cause, never a merge input (INF-1915 fix 1).
            main: main ? { sha: main.sha, items: main.items } : null,
          })}`,
          ...(held ? [held] : []),
          ...(checks.items.length > 0 ? lines : ["- no checks reported on the head SHA"]),

          ...watchWords(forge, audience, watched, earlyOwed),
        ].join("\n"),
        recorded: true,
        checked: { change, forge },
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        text: `Could not check CI for task ${record.id}: ${message}`,
        recorded: false,
        problem: message,
        transient: isTransientForgeFailure(caught),
        ...(isSignInForgeFailure(caught)
          ? { signIn: this.context.signInFact(forge, located.repo?.id ?? record.repoId) }
          : {}),
      };
    }
  }

  /**
   * The pull request the task names, read by its number when the branch has
   * no open one. Undefined where there is no number, the host has no pull
   * requests, or the read fails: then the reading stays "no open change".
   */
  private async namedPull(
    forge: Forge,
    prNumber: number | undefined,
  ): Promise<ForgePull | undefined> {
    if (prNumber === undefined || !forge.pull) return undefined;
    try {
      const pull = await forge.pull(prNumber);
      return pull.number === prNumber ? pull : undefined;
    } catch {
      return undefined;
    }
  }

  private checksPending(
    record: TaskRecord,
    checked: CheckedChange,
    checks: Awaited<ReturnType<Forge["checks"]>>,
  ): boolean {
    return (
      !checks.problem &&
      (checks.complete === false ||
        running(checks.items) ||
        (checks.items.length === 0 && !this.absenceDeclared(record, checked)))
    );
  }

  /** Positive, exact-version absence evidence, never inferred from an empty result or history. */
  absenceDeclared(record: TaskRecord, checked: CheckedChange): boolean {
    if (!checked.forge.hasChecks) return true;
    const change = checked.change;
    const reviews = [
      ...(record.delivery?.mergeReviews ?? []),
      ...(record.delivery?.mergeAuthorization?.review
        ? [record.delivery.mergeAuthorization.review]
        : []),
    ];
    // Each review is matched against the project it is in (INF-2510).
    const originOf = (repoId: string | null | undefined) =>
      forgeOf(repoId ? this.options.repos.get(repoId)?.origin : undefined);
    return reviews.some((review) => {
      const origin = originOf(review.repoId ?? record.repoId);
      return (
        review.kind === checked.forge.kind &&
        review.host === origin.host &&
        review.owner === origin.owner &&
        review.name === origin.name &&
        review.number === change.number &&
        review.branch === change.branch &&
        review.headSha === change.headSha &&
        review.absentChecks?.headSha === change.headSha
      );
    });
  }

  /**
   * Store raw check facts. The merge offer carries the crew's judgment. Changed facts
   * create a ci event; an unchanged reading only refreshes its time. Raw
   * readings do not judge readiness or settle declared repairs.
   */
  private record(
    taskId: string,
    overall: PrCiOverall,
    checked?: CheckedChange,
    audience: Audience = "firstmate",
    stillRunning = false,
    checks: ForgeCheck[] = [],
    complete?: boolean,
    problem?: string,
    main?: MainCheckEvidence & { head: string },
  ): void {
    const at = this.context.now();
    const task = this.options.tasks.get(taskId);
    if (!task) return;
    const change = checked?.change;
    const label = checked ? checked.forge.label(checked.change) : undefined;
    if (checked) this.noteChange(taskId, checked);
    const round = change ? observeCheckRepair(task.delivery, change.headSha, checks, at) : {};
    // The reading names the pull request it is of: the change record binds
    // it by that number, never by its head alone (INF-1873).
    const snapshot = checked
      ? {
          headSha: checked.change.headSha,
          ...(checked.change.number !== undefined ? { prNumber: checked.change.number } : {}),
          items: checks.map(({ name, state }) => ({ name, state })),
          absenceDeclared: this.absenceDeclared(task, checked),
          ...(complete !== undefined ? { complete } : {}),
          ...(problem ? { problem } : {}),
        }
      : undefined;
    const actual = snapshot ? checkSnapshotSummary(snapshot).overall : overall;
    const where = change
      ? ` on ${change.number !== undefined ? "PR " : ""}${label} head ${change.headSha}`
      : "";

    // The head the reading saw rides beside it: a reviewer is briefed at
    // that head, and a review verdict names the head it read.
    const watch = watchAfter(
      task.delivery?.ciWatch,
      checked,
      audience,
      stillRunning,
      at,
      checks.some((check) => isRedCheckState(check.state)),
    );
    this.options.tasks.delivery.recordChangeEvidence(
      taskId,
      {
        ci: actual === "none" ? undefined : actual,
        ciAt: at,
        checks: snapshot,
        ...checksTimes(actual, checks),
        ...(change ? { headSha: change.headSha } : {}),
        ...(change?.base ? { prBase: change.base } : {}),
        mainChecks: main,
        ...round,
        ...watch,
      },
      changesCheckState(
        task.delivery,
        actual === "none" ? undefined : actual,
        change?.headSha,
        round,
      ) || JSON.stringify(task.delivery?.checks) !== JSON.stringify(snapshot)
        ? {
            kind: "ci",
            text: `CI ${actual}${where}`,
            data: { checks: snapshot },
            feed: false,
          }
        : undefined,
    );
  }

  /**
   * A change the record has not named yet: its label from the forge, its
   * number and link where the host has them, and one `pr_opened` event. The
   * slot's head and the checks read at it were the change it named before -
   * its own, or a selected pull request (`docs/forge.md`, "A requested
   * merge") - so the same write names the new change's head and drops that
   * reading; the number and the head never name two changes (INF-1884 R2).
   */
  noteChange(taskId: string, checked: CheckedChange): void {
    const task = this.options.tasks.get(taskId);
    if (!task) return;
    const { change, forge } = checked;
    const label = forge.label(change);
    const url = forge.url(change);
    const known =
      task.delivery?.changeLabel ??
      (task.delivery?.prNumber !== undefined ? `#${task.delivery.prNumber}` : undefined);
    if (known === label) return;
    this.options.tasks.delivery.recordChangeEvidence(
      taskId,
      {
        changeLabel: label,
        ...(url ? { prUrl: url } : {}),
        ...(change.number !== undefined ? { prNumber: change.number } : {}),
        ...(change.base ? { prBase: change.base } : {}),
        headSha: change.headSha,
        checks: undefined,
        ci: undefined,
        ciAt: undefined,
        ciStartedAt: undefined,
        ciFinishedAt: undefined,
        mainChecks: undefined,
      },
      {
        kind: "pr_opened",
        text:
          change.number !== undefined
            ? `PR ${label}${url ? ` ${url}` : ""}`
            : `Pushed the branch ${label}${forge.place ? ` to ${forge.place}` : ""}`,
        feed: true,
      },
    );
  }

  /** An unread observation survives a restart until it reaches the crew's durable inbox. */
  /**
   * What the check watch's wake says about a version still waiting on the
   * project's queue after the app marked it: undefined unless the queue
   * status there is still waiting on the app's own mark.
   */
  private queueWake(
    taskId: string,
    head: string,
    items: readonly { name: string; state: ForgeCheckState }[],
  ): string | undefined {
    if (!this.queue) return undefined;
    const mark = this.options.tasks.get(taskId)?.delivery?.queueMark;
    const waiting = items.some((item) => item.name === QUEUE_STATUS && item.state === "pending");
    if (mark?.head !== head || !waiting) return undefined;
    return queueWakeWords(this.queue.noteFacts(taskId));
  }

  private observeChecks(
    taskId: string,
    head: string,
    checks: { items: readonly ForgeCheck[]; complete?: boolean; problem?: string },
    forwarded: boolean,
  ): string {
    const previous = this.options.tasks.get(taskId)?.delivery?.ciObservation;
    const signature = createHash("sha256").update(JSON.stringify({ head, checks })).digest("hex");
    let observation =
      previous?.signature === signature
        ? previous
        : { id: randomUUID(), signature, forwarded: false };
    if (forwarded && !observation.forwarded) observation = { ...observation, forwarded: true };
    if (observation !== previous)
      this.options.tasks.delivery.recordChangeEvidence(taskId, { ciObservation: observation });
    return observation.id;
  }
}

/**
 * Whether a reading changes the check state the record already holds: its
 * reported result, the head it read, or durable repair observations.
 * Comparing a reading never settles a declared repair. The quiet
 * refresh reads an open pull request every five minutes, and a reading
 * that changes none of these writes no `ci` event (INF-721 friction 6:
 * 239 identical rows a day for one idle pull request).
 */
function changesCheckState(
  before: TaskDelivery | null | undefined,
  overall: PrCiOverall | undefined,
  headSha: string | undefined,
  round: Partial<TaskDelivery>,
): boolean {
  if (!before || before.ci !== overall) return true;
  if (headSha !== undefined && before.headSha !== headSha) return true;
  return (
    ("ciRounds" in round && round.ciRounds !== before.ciRounds) ||
    ("ciCapAt" in round && round.ciCapAt !== before.ciCapAt) ||
    ("ciRepair" in round && JSON.stringify(round.ciRepair) !== JSON.stringify(before.ciRepair))
  );
}

/** Some check is still queued or running: the only reading a watch waits on. */
function running(items: { state: ForgeCheckState }[]): boolean {
  return items.some((item) => item.state === "pending");
}

function named(items: { name: string; state: ForgeCheckState }[]): WatchedCheck[] {
  return items.map((item) => ({ name: item.name, state: item.state }));
}

/**
 * What a reading does to the check watch (docs/forge.md, "The check
 * watch"): checks still running on a host that has them arm it at the head
 * read; the crewmate's own reading of anything else ends it, since the
 * crewmate already knows; every other reading - the Firstmate's, the
 * watch's own - leaves it, so the crewmate is still woken.
 */
function watchAfter(
  existing: CiWatch | undefined,
  checked: CheckedChange | undefined,
  audience: Audience,
  stillRunning: boolean,
  at: number,
  sawRed = false,
): { ciWatch?: CiWatch } {
  if (!checked || audience === "watch") return {};
  if (stillRunning && checked.forge.hasChecks) {
    const armed = armWatch(existing, checked.change.headSha, at);
    // The crewmate already read the red check, so the early wake is dropped.
    if (audience === "crewmate" && sawRed) return { ciWatch: { ...armed, failureSeen: true } };
    return { ciWatch: armed };
  }
  return audience === "crewmate" && existing ? { ciWatch: undefined } : {};
}

/**
 * What a reading says about the watch: the crewmate is told to end its turn
 * and wait, or - on a host with no checks - that nothing will be watched;
 * the Firstmate that the crewmate will hear.
 */
function watchWords(
  forge: Forge,
  audience: Audience,
  watched: boolean,
  earlyOwed = false,
): string[] {
  if (audience === "crewmate" && !forge.hasChecks) {
    return [
      `${forge.place ?? "This project's host"} runs no checks the app can watch, so no wake will come: the local gate you ran is the evidence.`,
    ];
  }
  if (!watched) return [];
  if (audience !== "crewmate") {
    return [
      "The host is watching these checks and will wake the crewmate when the first check fails and when they finish.",
    ];
  }
  return earlyOwed
    ? [
        "The app is watching these checks and will wake you once when the first check fails, and once when they finish. End your turn now and wait for that message; do not call check_change again until it comes.",
      ]
    : [
        "The app is watching these checks and will wake you once when they finish. You already read a failed check, so that early wake will not come. End your turn now and wait; do not call check_change again until it comes.",
      ];
}

/** A reading that found the task's pull request merged outside the app, in its reader's words. */
function mergedWords(forge: Forge, pull: ForgePull, audience: Audience): string {
  const next =
    audience === "crewmate"
      ? "Nothing is left to merge. Continue any remaining work; when this merge finished all of it, put up your merge card for this pull request with after close, and the app closes the task as merged without merging again."
      : "Nothing is left to merge. Read the task's remaining work before closing it; a merged PR alone does not mean its work is complete.";
  return [
    "overall: merged",
    `${numberLabel(forge, pull.number)} was merged ${placeWords(forge)} outside the app${pull.mergedSha ? ` as ${pull.mergedSha}` : ""}.`,
    `head: ${pull.headSha}`,
    next,
  ].join("\n");
}
