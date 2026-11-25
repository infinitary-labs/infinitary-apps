import { recoveryWay, waitStall } from "@shared/recovery";
import { capWithOverflow } from "../overflow";
import { startedProgramBranches } from "../program/programRunner";
import { builtOnRows } from "../tasks/taskQuery";
import { boundedRecoveryOf, type ReportDeclaration } from "../tasks/taskTurns";
import { ciFactOf } from "./ciFact";
import type { CrewCore } from "./crewCore";
import type { RelayWoken, TaskRuntime } from "./crewRuntime";
import { type IdleRule, type ReportSortRule, sortReport } from "./reportSort";
import { wakeBuiltOn } from "./reportWakes";
import { earlierPassOf } from "./reviewCarry";
import { renderWake, type TypedWake } from "./wakes";

/** What a turn did that its report wake names beside the report. */
export type TurnActs = {
  filed: TaskRuntime["filedThisTurn"];
  withdrawn: TaskRuntime["withdrawnThisTurn"];
  /** The relay this turn already woke the first mate for (`TaskRuntime.relayWoken`). */
  relayed?: RelayWoken;
  /**
   * The report is the turn's closing text: the crewmate made no report
   * call this turn (INF-4667's finding 2).
   */
  closingText?: boolean;
};

/**
 * The wait and recovery facts a relay's wake carried, as one comparable
 * key: the bounded facts the record keeps. Facts past their band are
 * undefined, since the relay cannot carry their full text, which the
 * record's overflow file holds, so the turn's end sends it.
 */
export function relayRecovery(declared: ReportDeclaration | undefined): string | undefined {
  const { overflowed, ...facts } = boundedRecoveryOf(declared);
  return overflowed ? undefined : JSON.stringify(facts);
}

/** The idle ladder's rule ids: its wakes are the host's own, never a report's. */
const IDLE_RULES: ReadonlySet<string> = new Set<IdleRule>([
  "idle-nudge",
  "idle-wake",
  "idle-repeat",
  "idle-card",
  "job-bound",
  "provider-cut-off",
  "provider-back",
  "next-move-wake",
  "next-move-card",
]);

/**
 * A crewmate's report sorted: whose turn it is next, the wake the first
 * mate hears when it is nobody's, and the ledger row that records each sort
 * (docs/report-sort.md). Shares the crew's state through `CrewCore`.
 */
export class ReportSorting {
  constructor(private readonly core: CrewCore) {}

  /**
   * Whose turn is it now (S7c, captain call C7 A; the restated rule at the
   * end of the scout report's R4.8)? The decision itself is `sortReport`
   * (`reportSort.ts`), pure and table-tested; this reads the witnesses the
   * idle ladder gathers for both readers (`IdleLadder.witnesses`), records
   * the sort, and wakes the
   * Firstmate only when the answer is "nobody's". No word of the report is
   * read - the retired supervision session was the only thing that ever
   * did that, and 103 of its last 120 wakes went to a task whose card was
   * already on the captain's screen.
   *
   * Routine review returns use the existing review's durable lane before
   * the sort. A report declaring a decision, recovery or other work still
   * goes through the ordinary sorter, and a failed handoff asks for recovery.
   */
  async sortReport(
    task: TaskRuntime,
    report: string,
    turn: TurnActs,
    declared: ReportDeclaration | undefined,
  ): Promise<void> {
    const builder = this.core.options.tasks.get(task.id);
    // Keep ordinary reports synchronous: their sort must precede draining
    // pending guidance at this idle boundary.
    let handed = false;
    if (builder && this.core.openReviewOf(builder.id)) {
      try {
        handed = await this.core.reviews.returnToReview(builder, report);
        if (
          handed &&
          !declared?.needsFirstmate &&
          !declared?.finished &&
          !declared?.wait &&
          !declared?.workWait &&
          !declared?.recoveryWays &&
          !declared?.waitsOn?.length &&
          !declared?.files?.length &&
          !declared?.result &&
          !declared?.firstRelease &&
          turn.filed.length === 0 &&
          turn.withdrawn.length === 0
        )
          return;
      } catch (caught) {
        // The builder's computer went mid-read: the return waits for it and
        // goes again by itself, the whole report with it (INF-5142).
        const lost = this.core.reviews.waitForLostReturn(builder, caught, () =>
          this.sortReport(task, report, turn, declared),
        );
        if (lost?.kind === "waiting") return;
        const problem =
          lost?.kind === "twice"
            ? lost.words
            : caught instanceof Error
              ? caught.message
              : String(caught);
        declared = {
          ...declared,
          needsFirstmate: `The host could not return the fix to its reviewer: ${problem}`,
        };
      }
    }
    this.core.options.tasks.readProjection(() =>
      this.sortReportInProjection(task, report, turn, declared, handed),
    );
  }

  /**
   * The report wake's typed facts, and the witnesses the sort reads beside
   * them: one builder for the turn's end and for a relay sent when it is
   * made (`relayNow`), so both say the same.
   */
  reportWake(
    task: TaskRuntime,
    report: string,
    { filed, withdrawn }: TurnActs,
    declared: ReportDeclaration | undefined,
    pending = false,
  ) {
    const finished = declared?.finished === true;
    const needsFirstmate = declared?.needsFirstmate;
    // Read what the report owner normalized and kept, never the uncapped
    // declaration. A relay sent as it is made (`pending`) is not on the
    // record yet: its own words stand, and its wait and recovery facts are
    // bounded by the same owner the record uses (`boundedRecoveryOf`), so
    // the relay carries them and the turn's end has nothing new to send.
    const reports = this.core.options.tasks.lastReportEntries(task.id);
    const kept = !pending && report ? reports.at(-1) : undefined;
    const previous = pending ? reports.at(-1) : reports.at(-2);
    const bounded = pending ? boundedRecoveryOf(declared) : undefined;
    const workWait = bounded ? bounded.workWait : kept?.declared.workWait;
    const record = this.core.options.tasks.get(task.id);
    // F3 of INF-1554 (R1 of INF-1644): the ladder's one rule, a check-back
    // with no claimed job owns no wait; its witnesses already leave it out.
    const unownedTimer =
      !pending &&
      declared?.checkBack !== undefined &&
      record !== undefined &&
      this.core.ladder.unownedTimer(record);
    const stall = workWait
      ? waitStall(workWait, previous?.declared.workWait)
      : unownedTimer && declared?.checkBack
        ? { kind: "wait-without-owner" as const, observation: declared.checkBack.waitingFor }
        : undefined;
    const recoveryWays = bounded
      ? bounded.recoveryWays?.map(recoveryWay)
      : kept?.declared.recoveryWays;
    const refused = record?.delivery?.cardRefusal;
    const ci = ciFactOf(record?.delivery, this.core.now());
    const waits = (record ? this.core.ladder.unstartedWaits(record) : []).map((wait) => ({
      key: wait.key || wait.id,
      title: wait.title,
      state: wait.status === "dropped" ? ("dropped" as const) : ("not-started" as const),
    }));
    // A hold on this task's finding ends when it reports, not when it
    // closes (INF-735): the work held on it is named on every wake.
    const waiting = (record ? this.core.ladder.heldOn(record) : []).map((held) => ({
      id: held.id,
      key: held.key || held.id,
      title: held.title,
    }));
    const review = record ? this.core.reviewToReread(record) : undefined;
    // A pass that does not cover the version now on offer is named, so an
    // earlier review never reads as covering later work (INF-3141).
    const earlierPass = earlierPassOf(record?.delivery);
    const builtOn = wakeBuiltOn(builtOnRows(this.core.options.tasks, task.id));
    const programBranches = startedProgramBranches(this.core.options.tasks, task.id);
    const witnesses = this.core.ladder.witnesses(task.id, this.core.now());
    // A wait it declared with nothing on the captain's screen to answer is
    // the card the Firstmate owes (INF-11): the wake says what he must decide.
    const unseenWait = witnesses.decisionCardOpen ? undefined : record?.delivery?.captainWait;
    const wake: TypedWake = {
      facts: {
        kind: "report",
        task: { id: task.id, title: task.title },
        crewmate: task.crewmate,
        excerpt: capWithOverflow(kept?.text ?? report, "task-report"),
        filed: filed.map(({ key, title, blocks, program }) => ({
          key,
          title,
          blocks,
          ...(program ? { program } : {}),
        })),
        ...(waits.length > 0 ? { waits } : {}),
        ...(waiting.length > 0 ? { waiting } : {}),
        ...this.core.cards.threads.wakeCards(task.id),
        ...(refused ? { refused } : {}),
        ...(withdrawn.length > 0 ? { withdrawn } : {}),
        ...(unseenWait ? { captainWait: unseenWait.reason } : {}),
        ...(finished ? { finished: true } : {}),
        ...(needsFirstmate ? { needsFirstmate } : {}),
        ...(declared?.captainWords
          ? {
              captainWords: {
                text: declared.captainWords.text,
                at: declared.captainWords.at,
                ...(declared.captainWords.line !== undefined
                  ? { line: declared.captainWords.line }
                  : {}),
              },
            }
          : {}),
        ...(stall ? { stall } : {}),
        ...(recoveryWays ? { recoveryWays } : {}),
        ...(workWait ? { workWait } : {}),
        ...(builtOn ? { builtOn } : {}),
        ...(programBranches.length > 0 ? { programBranches } : {}),
        ...(declared?.result ? { result: declared.result } : {}),
        ...(ci ? { ci } : {}),
        ...(review ? { review } : {}),
        ...(earlierPass ? { earlierPass } : {}),
        ...(witnesses.proofUnread ? { proofUnread: witnesses.proofUnread } : {}),
      },
    };
    return { wake, record, witnesses, stall, recoveryWays, waiting, review };
  }

  private sortReportInProjection(
    task: TaskRuntime,
    report: string,
    turn: TurnActs,
    declared: ReportDeclaration | undefined,
    handed: boolean,
  ): void {
    const { filed, relayed } = turn;
    const needsFirstmate = declared?.needsFirstmate;
    // The relay already woke the first mate when it was made (INF-3926's
    // finding 2): the same report with nothing new since sends no second
    // wake. Its wait and recovery facts rode that wake (INF-4497's finding
    // 5), so only facts the relay did not carry wake again.
    if (
      relayed &&
      needsFirstmate === relayed.request &&
      report === relayed.report &&
      filed.length === relayed.filed &&
      turn.withdrawn.length === relayed.withdrawn &&
      relayed.recovery !== undefined &&
      relayRecovery(declared) === relayed.recovery &&
      !declared?.checkBack
    )
      return;
    const finished = declared?.finished === true;
    const { wake, record, witnesses, stall, recoveryWays, waiting, review } = this.reportWake(
      task,
      report,
      turn,
      declared,
    );
    // A program's part answering its call is the program's to read (INF-799);
    // one that names a check-back says its work still runs (INF-2037).
    const programPart =
      this.core.programs.awaits(task.id) &&
      !declared?.checkBack &&
      (declared?.result !== undefined ||
        (!record?.shape?.result_schema && !declared?.wait && !declared?.needsFirstmate));
    if (this.core.bypassesSupervision(task.id) && !programPart) {
      this.core.hooks().notifyOp(wake, "crewmate-report", task.id);
      return;
    }
    const sort = sortReport({
      ...witnesses,
      filedFollowups: filed.length > 0,
      internalStep: record?.shape?.internal_step === true,
      finished,
      needsFirstmate: needsFirstmate !== undefined,
      recovery: stall !== undefined || recoveryWays !== undefined,
      waitedOn: waiting.length > 0,
      closingText: turn.closingText === true,
      // A builder waiting on its reviewer's question card waits on the
      // captain (INF-5004); a plain report is still re-read.
      reviewReread:
        review !== undefined &&
        !handed &&
        !(declared?.wait !== undefined && witnesses.decisionCardOpen),
      programPart,
      // A session that is gone cannot prove anything either; the record
      // keeps that the host could not tell, and the report still wakes.
      workObservable: task.session?.controlProfile.backgroundWork === "host",
    });
    this.recordSort(task.id, task.title, wake, sort.verdict, sort.reason, sort.rule, () => {
      if (sort.wake) this.core.hooks().notifyOp(wake, "crewmate-report", task.id);
    });
    // Follow-ups it filed wake the first mate; the program still reads its answer.
    if (programPart && (sort.rule === "program-part" || sort.rule === "filed-followups"))
      void this.core.crewPrograms.closeProgramPart(task.id);
  }

  /**
   * One row per sort, with the rule that sorted it (R4.4) and the wake's
   * typed facts beside its served text (P6), so `flag_missed_escalation`,
   * the miss deriver, the supervision extractor and the replay scorer keep
   * reading one ledger. The wake rides the store's own transaction: the
   * record of a decision and its effect still commit together.
   */
  recordSort(
    taskId: string,
    title: string,
    wake: string | TypedWake,
    verdict: "routine" | "captain",
    reason: string,
    rule: ReportSortRule | IdleRule,
    effect: () => void,
  ): void {
    const record = this.core.options.recordSort;
    if (!record) {
      effect();
      return;
    }
    record({
      taskId,
      ...(typeof wake === "string" ? { wake } : { wake: renderWake(wake), facts: wake.facts }),
      verdict,
      summary: `"${title}": ${reason}`,
      rule,
      wakeKind: IDLE_RULES.has(rule) ? "agent" : "crewmate-report",
      effect,
    });
  }
}
