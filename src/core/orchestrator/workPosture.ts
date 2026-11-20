import { BATCH_CHECK } from "@shared/batches";
import { waitingForMaintainers } from "@shared/contributions";
import type { AccountHold, WorkPosture } from "@shared/workPosture";
import type { TaskRecord } from "../storage/taskRecords";
import type { TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import type { IdleLadder } from "./idleLadder";
import type { Witnesses } from "./reportSort";

/** The live facts a posture reads; gathering them reads the database and the card stack. */
export type PostureFacts = Witnesses & {
  turnRunning: boolean;
  liveJobs: boolean;
  clientJobs: number | undefined;
  observable: boolean;
  blocked: boolean;
  /** The typed cut-off behind `accountHeld`, as the waiting line names it. */
  hold?: AccountHold;
  /** Its lane is failing at the provider: retried on its own, or stuck (docs/inbox.md). */
  atProvider?: "retrying" | "stuck";
};

/**
 * Unlike supervision, live jobs outrank a question and have no inspection bound.
 * Only active work has a live posture, so `gather` runs for active work alone:
 * every other row - most of a long record - is inactive without a fact read.
 */
export function deriveWorkPosture(record: TaskRecord, gather: () => PostureFacts): WorkPosture {
  if (record.status !== "active") return { state: "idle", reason: "inactive" };
  const facts = gather();
  if (facts.turnRunning) return { state: "active", reason: "turn" };
  if (facts.liveJobs || (facts.clientJobs ?? 0) > 0) return { state: "active", reason: "job" };
  if (facts.pendingSettle) return { state: "active", reason: "settlement" };
  // A held lane is not evidence that its queued delivery can proceed.
  if (facts.accountHeld || record.gate?.kind === "quota-reset")
    return {
      state: "paused",
      reason: "access",
      ...(facts.accountHeld && facts.hold ? { hold: facts.hold } : {}),
    };
  // Stuck at its provider: nothing moves until the first mate answers.
  if (facts.atProvider === "stuck")
    return { state: "idle", reason: "inactive", atProvider: "stuck" };
  if (facts.checksWatched && waitingForMaintainers(record.delivery))
    return { state: "active", reason: "checks", maintainers: true };
  const batch = pendingBatch(record);
  if (batch) return { state: "active", reason: "checks", batch };
  if (facts.checksWatched) return { state: "active", reason: "checks" };
  if (facts.deliverable || facts.threadAwaitingAuthor)
    return {
      state: "active",
      reason: "guidance",
      ...(facts.deliverable && facts.atProvider === "retrying"
        ? { atProvider: "retrying" as const }
        : {}),
    };
  if (facts.timedWait && Number.isFinite(record.gate?.until))
    return { state: "active", reason: "timed-wait" };
  if (facts.decisionCardOpen || facts.captainGateOwed || facts.putOff === "word")
    return { state: "idle", reason: "captain" };
  // A blocks edge holding its close, or a wait it declared on other work
  // (FI3-671, FI3-250): either way it waits on another task. A put-off an
  // Automation rule raises waits on its moment the same way (INF-3846 piece 3).
  if (facts.blocked || facts.waitsOnUnderway || facts.waitsOnUnstarted || facts.putOff === "wait")
    return { state: "idle", reason: "dependency" };
  if (!facts.observable && facts.clientJobs === undefined)
    return { state: "unknown", reason: "unobserved" };
  return { state: "idle", reason: "inactive" };
}

/** A change's place in its batch while it waits there, read from the batch check its reading carries. */
function pendingBatch(record: TaskRecord): WorkPosture["batch"] {
  const delivery = record.delivery;
  const head = delivery?.headSha;
  if (!head) return undefined;
  const snapshot = delivery.checks?.headSha === head ? delivery.checks : undefined;
  const status = snapshot?.items.find((item) => item.name === BATCH_CHECK);
  if (status?.state !== "pending") return undefined;
  const kept = delivery.queueStatus?.head === head ? delivery.queueStatus : undefined;
  const kind = kept?.kind ?? "waiting";
  return kind === "waiting" || kind === "in-batch" || kind === "paused" ? kind : undefined;
}

/** What a posture reads of the supervisor beyond its options. */
export type WorkPostureHost = {
  now(): number;
  /** The idle ladder's typed facts for a task (`IdleLadder.witnesses`). */
  witnesses: IdleLadder["witnesses"];
  /** The account and cut-off a task's lane is held on (`IdleLadder.heldBy`). */
  heldBy: IdleLadder["heldBy"];
  /** A task's crewmate running here, when one runs. */
  runtime(taskId: string): TaskRuntime | undefined;
};

/**
 * Each task's posture - what its dot shows - and the wait facts read from
 * the same snapshot, projected once per record change.
 */
export class WorkPostures {
  private readonly postureFact = Symbol("work posture");
  private readonly postureInputs = Symbol("work posture inputs");

  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: WorkPostureHost,
  ) {}

  /** Shared visual answer; deliberately independent of turn control and recovery. */
  workPosture(record: TaskRecord) {
    return this.options.tasks.projectedFact(record, this.postureFact, () =>
      this.readWorkPosture(record),
    );
  }

  private readWorkPosture(record: TaskRecord) {
    return deriveWorkPosture(record, () => this.workPostureInputs(record));
  }

  /** The wait view shares the posture snapshot, including facts its precedence hides. */
  workWaitFacts(record: TaskRecord) {
    if (record.status !== "active") return { job: false, timerOwned: false };
    const facts = this.workPostureInputs(record);
    return {
      job: facts.liveJobs || (facts.clientJobs ?? 0) > 0,
      timerOwned: facts.timedWait,
      ...(facts.hold ? { hold: facts.hold } : {}),
    };
  }

  private workPostureInputs(record: TaskRecord): PostureFacts {
    return this.options.tasks.projectedFact(record, this.postureInputs, () => {
      const runtime = this.host.runtime(record.id);
      const hold = this.holdOf(record);
      const atProvider = this.options.inbox.stuck(record.id)
        ? ("stuck" as const)
        : this.options.inbox.outage(record.id).failures > 0
          ? ("retrying" as const)
          : undefined;
      return {
        ...this.host.witnesses(record.id, this.host.now()),
        turnRunning: runtime !== undefined && runtime.turn.busy,
        liveJobs: this.options.hasRunningJobs?.(record.id) === true,
        clientJobs: runtime?.session ? runtime.clientJobs : undefined,
        observable: runtime?.session?.controlProfile.backgroundWork === "host",
        blocked: this.options.tasks.graph.flagsOf(record).blocked,
        ...(hold ? { hold } : {}),
        ...(atProvider ? { atProvider } : {}),
      };
    });
  }

  /**
   * The typed cut-off on the account the hold witness reads
   * (`IdleLadder.cutOffHolds`), as a card thread's waiting line names it:
   * its class, the provider, and a spent allowance's reset.
   */
  private holdOf(record: TaskRecord): AccountHold | undefined {
    const held = this.host.heldBy(record);
    if (!held) return undefined;
    const { account, cutOff } = held;
    // A task on another computer waits on that computer's own sign-in, and
    // the line says where (docs/helper.md, "Its own sign-ins").
    const place = this.options.machines?.accountPlace(account);
    return {
      class: cutOff.class,
      provider:
        place?.provider ?? this.options.serveability?.providerName(account) ?? "the provider",
      ...(cutOff.class === "no_headroom" && cutOff.resetsAt !== undefined
        ? { resetsAt: cutOff.resetsAt }
        : {}),
      ...(place ? { where: place.where } : {}),
    };
  }
}
