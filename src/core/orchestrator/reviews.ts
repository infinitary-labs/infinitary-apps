import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardPictureFiles } from "@shared/cardPictures";
import { isRepairAssessment, REPAIR_ASSESSMENT_SOURCE } from "@shared/checkRepair";
import { standingOverride } from "@shared/holds";
import type { KeptValidationInput } from "@shared/liveValidation";
import { REVIEW_VERDICT_OF_CODE, renderFinding } from "@shared/rigor";
import { RISK_DIMENSIONS, RISK_WORDS } from "@shared/risk";
import { capWithOverflow } from "../overflow";
import { crewmateCardPicturesDir, crewmateEvidenceDir, crewmateSourceCardsDir } from "../paths";
import { verifyKeptValidationEvidence } from "../pi/validationEvidence";
import { tierFor } from "../routing/policy";
import type { RouteResult } from "../routing/router";
import type { MergeRepairAssessment, TaskRecord } from "../storage/taskStore";
import { TaskService } from "../tasks/taskService";
import type { CardService } from "./cardService";
import type { TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions, FirstmateHooks } from "./crewSupervisorOptions";
import {
  type CaptainCardFacts,
  type ReviewBriefFacts,
  renderRepairAssessmentBrief,
} from "./intentBrief";
import {
  ASSESSMENT_BOUND_MS,
  decideMergeRepair,
  parseRepairAssessment,
  standingAuthorization,
} from "./mergeAuthorization";
import type { ReviewVerdictFacts } from "./reportWakes";
import { earlierHistory, reviewHistory } from "./reviewHistory";
import type { SettleOwners } from "./settleOwners";
import type { TypedWake } from "./wakes";
import { withBasisVerdict } from "./workShape";

/** What reviews and repair assessments reach of the supervisor beyond its options. */
export type ReviewsHost = {
  now(): number;
  /** The card stack, for the cards a reviewer showed. */
  readonly cards: CardService;
  /** Settling and closing: the kept merge, and closing a review or an assessment. */
  readonly settling: SettleOwners;
  /** Queue an operational message for the first mate (`FirstmateHooks.notifyOp`). */
  notifyOp: FirstmateHooks["notifyOp"];
  /** Steer a task as the host, answering no message or card. */
  steer(taskId: string, wake: TypedWake): Promise<unknown>;
  /** Start a task the host filed. */
  startTask(spec: {
    taskId: string;
    title: string;
    brief: string;
    repoId: string | null;
    routed: RouteResult | undefined;
    fresh: boolean;
  }): Promise<unknown>;
  /** The builder a review task reads: its parent, the one stored join. */
  reviewBuilderOf(record: TaskRecord | undefined): TaskRecord | undefined;
};

/**
 * An independent review's reads and verdict, and the independent assessment
 * of a repair its crewmate declared unknown (delivery rigor phase 2,
 * FI3-663): what a reviewer is briefed with, how its typed verdict lands on
 * the builder, and how an assessment's verdict decides the kept merge.
 */
export class Reviews {
  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: ReviewsHost,
  ) {}

  /**
   * The review target and evidence are read where the builder actually runs.
   * The target is that computer's committed branch head, even when an older
   * pull request already records a different head (INF-288).
   */
  async reviewFacts(builder: TaskRecord): Promise<ReviewBriefFacts> {
    const prUrl = builder.delivery?.prUrl;
    const machines = this.options.machines;
    const device = builder.deviceId;
    let headSha: string | null;
    let changedFiles: string[] | null;
    let changeReading: string | undefined;
    let evidenceDir: string;
    if (device) {
      const folders = machines?.folders(device, builder.id);
      if (!machines?.ready(device, builder.id) || !folders)
        throw new Error(
          "The builder's computer is out of reach; the review must wait for it, not run here instead.",
        );
      ({ headSha, changedFiles, changeReading } = await machines.revision(device, builder.id));
      evidenceDir = folders.evidence;
    } else {
      headSha = builder.branch
        ? await this.options.workspace.branchHead(builder.repoDir, builder.branch)
        : null;
      changedFiles = headSha
        ? await this.options.workspace.reviewChangedFiles(builder.repoDir, headSha)
        : null;
      changeReading = headSha
        ? ((await this.options.workspace.reviewChangeReading(builder.repoDir, headSha)) ??
          undefined)
        : undefined;
      evidenceDir = crewmateEvidenceDir(this.options.paths, builder.id);
    }
    if (!headSha)
      throw new Error(
        `${builder.key || builder.id} has no commits on its branch to review yet. Steer the crewmate to commit its work and report first.`,
      );
    const captainCard = this.captainCardFacts(builder);
    const standing = standingOverride(builder.delivery, headSha);
    const proof = builder.delivery?.liveValidation?.runs.at(-1);
    if (proof)
      await verifyKeptValidationEvidence(
        proof.evidence,
        crewmateCardPicturesDir(this.options.paths, builder.id),
        builder.id,
      );
    const keptFile = async (name: string): Promise<string> => {
      const file = join(crewmateCardPicturesDir(this.options.paths, builder.id), name);
      if (!device) return file;
      if (!machines?.sourceFile)
        throw new Error("The kept proof cannot be copied to the reviewer's computer.");
      return machines.sourceFile(device, builder.id, `proof-${name}`, file);
    };
    const proofFiles = await Promise.all(
      (proof?.evidence ?? []).map(async (item) => ({
        id: item.id,
        file: await keptFile(item.file),
        ...(item.posterFile ? { poster: await keptFile(item.posterFile) } : {}),
      })),
    );
    const validation = builder.delivery?.liveValidation;
    return {
      builderTitle: builder.title,
      branch: builder.branch,
      headSha,
      ...(prUrl ? { prUrl } : {}),
      builderReport: builder.outcome ?? "The builder has not reported yet.",
      evidenceDir,
      changedFiles,
      ...(changeReading ? { changeReading } : {}),
      ...(captainCard ? { captainCard } : {}),
      history: reviewHistory(this.options.tasks, builder),
      ...(standing ? { override: standing } : {}),
      proofFiles,
      validation: validation
        ? {
            ...validation,
            runs: proof
              ? [{ ...proof, evidence: proof.evidence.map(({ text: _text, ...item }) => item) }]
              : [],
          }
        : undefined,
    };
  }

  /**
   * The merge card the captain pressed Review carefully on (INF-562), as
   * the stage showed it: the newest card on the builder whose chosen action
   * set care. Saved whole beside the builder's other source cards when the
   * work runs here; quoted in the brief when it runs on another computer.
   */
  private captainCardFacts(builder: TaskRecord): CaptainCardFacts | undefined {
    const [raised] = this.options.cardStore.resolvedSince(
      0,
      1,
      ({ card, offer, action }) =>
        (offer?.actions ?? card.actions).some((entry) => entry.id === action && entry.care),
      builder.id,
    );
    if (!raised) return undefined;
    const shown = raised.offer ?? raised.card;
    const declared = shown.risk?.declared;
    const risk = declared
      ? RISK_DIMENSIONS.map(
          (dimension) =>
            `- ${RISK_WORDS[dimension].label}: ${declared[dimension].level} - ${declared[dimension].why}`,
        )
      : undefined;
    const files = cardPictureFiles(shown.body, this.options.paths.crewmatesDir);
    const facts: CaptainCardFacts = {
      title: shown.title,
      ...(files.pictures.length && !builder.deviceId ? { pictures: files.pictures } : {}),
      ...(risk ? { risk } : {}),
    };
    if (!builder.deviceId) {
      const dir = crewmateSourceCardsDir(this.options.paths, builder.id);
      const file = join(dir, `merge-card-${raised.card.id.replace(/[^A-Za-z0-9_-]/g, "-")}.html`);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, files.body, "utf8");
        return { ...facts, file };
      } catch {
        // A card that cannot be saved rides in the brief whole.
      }
    }
    return { ...facts, body: files.body };
  }

  /**
   * A repair its crewmate declared unknown gets one independent assessment
   * (FI3-663; FI3-304's guard = builder: "uncertainty receives an
   * independent bounded assessment"). The kept merge calls this whenever it
   * reads the undecided repair - at the builder's idle boundary, on the
   * tick and at boot - so the assessment starts once the builder's turn is
   * over, and only once per repair. One still working is left to answer
   * within its bound; one that stopped without answering, ran past the
   * bound, or could not start ends the approval, so the merge never waits
   * on it forever and never runs on an unknown.
   */
  assessRepair(builderId: string): void {
    const builder = this.options.tasks.get(builderId);
    const authorization = standingAuthorization(builder?.delivery);
    const undecided = authorization?.undecided;
    if (!builder || !authorization || !undecided || TaskService.isClosed(builder)) return;
    const open = undecided.assessment;
    if (open) {
      const assessor = this.options.tasks.get(open.taskId);
      const live = assessor !== undefined && !TaskService.isClosed(assessor);
      if (live && this.host.now() - open.at <= ASSESSMENT_BOUND_MS) return;
      this.repairDecided(builderId, open.taskId, "failed");
      if (live) void this.retireAssessments(builderId, "it ran past its time");
      return;
    }
    // One still reading a repair the crewmate has since replaced answers nothing.
    void this.retireAssessments(builderId, "a newer repair replaced the one it read");
    const assessorId = randomUUID().slice(0, 8);
    // Recorded before it exists, so a second read finds it and starts none,
    // and one that cannot be made ends the approval like one that cannot finish.
    this.options.tasks.delivery.recordPermissionRecords(builder.id, {
      mergeAuthorization: {
        ...authorization,
        undecided: { ...undecided, assessment: { taskId: assessorId, at: this.host.now() } },
      },
    });
    const title = `Assess repair: ${builder.title}`.slice(0, 64);
    let brief: string;
    let routed: RouteResult | undefined;
    try {
      const delivery = builder.delivery;
      brief = renderRepairAssessmentBrief({
        builderTitle: builder.title,
        change: `${delivery?.changeLabel ?? `#${authorization.target.prNumber}`}${
          delivery?.prUrl ? ` ${delivery.prUrl}` : ""
        }`,
        ...(builder.intent?.userWords ? { userWords: builder.intent.userWords } : {}),
        approvedHead: authorization.approvedHead,
        fromHead: undecided.fromHead,
        toHead: undecided.toHead,
        newBase: undecided.newBase,
        paths: undecided.paths ?? { approved: [], repaired: undecided.changedPaths },
        evidence: undecided.evidence,
        validation: undecided.validation,
      });
      // The host establishes the kind, the way it does a review's: never
      // classified, its basis the builder, delivery machinery under it.
      const shape = withBasisVerdict(this.options.tasks, {
        kind: "review",
        kind_source: REPAIR_ASSESSMENT_SOURCE,
        basis: builder.id,
      });
      // Independent: the ladder prefers a provider other than the builder's.
      const avoidProvider = this.options.router?.servedProvider(builder.id);
      routed = this.options.router?.decide(
        assessorId,
        brief,
        shape,
        avoidProvider ? { avoidProvider } : {},
      );
      this.options.tasks.create({
        id: assessorId,
        kind: "work",
        title,
        prompt: brief,
        intent: {
          goal: `Assess whether bringing "${builder.title}" up to date kept the approved change.`,
          userWords: builder.intent?.userWords ?? "",
          constraints: [],
        },
        repoId: builder.repoId,
        difficulty: routed?.bucket ?? tierFor(shape).bucket ?? null,
        shape,
        status: "active",
        parentId: builder.id,
        actor: "host",
      });
    } catch (caught) {
      console.warn("[crew] a repair assessment could not be made:", caught);
      this.repairDecided(builderId, assessorId, "failed");
      return;
    }
    this.options.tasks.note(
      builder.id,
      `An independent assessment of the repair to ${undecided.toHead} started: ${title}.`,
      { news: true, data: { repairAssessment: assessorId } },
    );
    void this.host
      .startTask({
        taskId: assessorId,
        title,
        brief,
        repoId: builder.repoId,
        routed,
        fresh: true,
      })
      .catch((caught: unknown) => {
        console.warn("[crew] a repair assessment could not start:", caught);
        this.repairDecided(builderId, assessorId, "failed");
      });
  }

  /**
   * An independent assessment's verdict on its builder's undecided repair
   * (FI3-663). Accepted, the kept merge runs again under every gate; any
   * other verdict ended the approval with a hold, and the builder is told
   * so once, to put up a new completion card - the captain decides again.
   */
  private repairDecided(
    builderId: string,
    assessorId: string,
    verdict: NonNullable<MergeRepairAssessment["verdict"]>,
    excerpt?: string,
  ): void {
    const decided = decideMergeRepair(
      this.options.tasks,
      builderId,
      assessorId,
      verdict,
      this.host.now(),
    );
    if (decided.decided === "accepted") {
      void this.host.settling.kept.runMergeAuthorization(builderId).catch((caught: unknown) => {
        console.warn("[crew] kept merge could not run:", caught);
      });
      return;
    }
    if (decided.decided !== "ended" || verdict === "none") return;
    const wake: TypedWake = {
      facts: {
        kind: "repair-assessed",
        head: decided.head,
        verdict,
        ...(excerpt ? { excerpt } : {}),
      },
      once: `repair-assessed:${assessorId}`,
    };
    void this.host.steer(builderId, wake).catch((caught: unknown) => {
      // The record and the feed already say the approval ended.
      console.warn("[crew] the repair assessment's steer was not delivered:", caught);
    });
  }

  /** Stop a builder's live repair assessments, silently: their verdict would answer nothing. */
  private async retireAssessments(builderId: string, why: string): Promise<void> {
    const live = this.options.tasks.graph
      .children(builderId)
      .filter((child) => !TaskService.isClosed(child) && isRepairAssessment(child.shape));
    for (const child of live) {
      await this.host.settling.closing
        .closeTask(child.id, {
          status: "dropped",
          reason: "superseded",
          actor: "host",
          text: `superseded - ${why}`,
          feed: false,
        })
        .catch(() => {});
    }
  }

  /**
   * An independent repair assessment reported (FI3-663): its first line is
   * its verdict, and its first report is its only one - the host records
   * the verdict on the builder's approval, then closes the assessment.
   */
  async settleRepairAssessment(task: TaskRuntime, report: string): Promise<void> {
    const builderId = this.options.tasks.get(task.id)?.parentId;
    const verdict = parseRepairAssessment(report);
    if (builderId) {
      this.repairDecided(builderId, task.id, verdict, capWithOverflow(report, "task-report"));
    }
    await this.host.settling.closing
      .closeTask(task.id, {
        status: "done",
        reason: "finished",
        actor: "host",
        text: `assessed the repair: ${verdict}`,
        feed: false,
      })
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        if (this.options.tasks.get(task.id)) {
          this.options.tasks.note(task.id, `could not close the assessment: ${message}`, {
            news: true,
            data: { closeFailed: message },
          });
        }
      });
  }

  /**
   * A review task reported (delivery rigor phase 2; verdict semantics
   * revised by the captain 2026-09-19; the typed record, INF-1875). The
   * verdict is the typed review record the turn reported on
   * report.validation at the assigned head: its code judgment maps to the
   * verdict, its findings and risk ride along, and nothing is read off the
   * report's words. A report with no typed record, or one at another head,
   * records nothing and spends no round: a reviewer's acknowledgment is not
   * a review, and the review stays open regardless. Info findings never
   * block (the no-mistakes rule), so they ride a clear review; the record
   * itself refuses a contradiction, and the code judgment is the verdict
   * as typed at every care.
   * The verdict lands on the BUILDER's delivery facts as a `review`
   * timeline event, the risk beside CI and never a hold (Q4). A pass
   * closes the review task done - the one feed line is the builder's own
   * "review passed" event, the close itself is silent; the wake to the
   * Firstmate then refs the builder, because the next move is on it and
   * a wake naming a closed task would be purged with it. Findings and
   * blocked leave the reviewer idle and steerable for a re-review, and
   * the wake refs the review task.
   */
  async settleReview(
    task: TaskRuntime,
    report: string,
    typed: Extract<KeptValidationInput, { kind: "review" }> | undefined,
  ): Promise<void> {
    const review = this.options.tasks.get(task.id);
    const builder = this.host.reviewBuilderOf(review);
    const excerpt = capWithOverflow(report, "task-report");
    const reviewTask = { id: task.id, title: task.title };
    if (!review || !builder) {
      this.host.notifyOp(
        {
          facts: { kind: "review-orphan", task: reviewTask, crewmate: task.crewmate, excerpt },
        },
        "crewmate-report",
        task.id,
      );
      return;
    }
    const builderTask = { id: builder.id, title: builder.title };
    const unstated = (words = excerpt) =>
      this.host.notifyOp(
        {
          facts: {
            kind: "review-unstated",
            task: reviewTask,
            builder: builderTask,
            crewmate: task.crewmate,
            excerpt: words,
          },
        },
        "crewmate-report",
        task.id,
      );
    // The typed review record on the turn's report is the verdict
    // (INF-1875). A report without one states nothing (captain ruling,
    // 2026-09-19): a reviewer's acknowledgment - "standing by", "no new
    // head yet" - is a plain report, never a verdict and never a round.
    // The merge stays held either way, so this still fails toward the
    // human.
    if (!typed) {
      unstated();
      return;
    }
    // A verdict belongs to the commit assigned before this turn, not a
    // newer builder commit that happened to arrive while the reviewer read.
    const sha = review.delivery?.headSha;
    if (!sha) {
      unstated(
        "No assigned review commit is recorded. Steer the reviewer for a new review before accepting a verdict.",
      );
      return;
    }
    if (typed.head !== sha) {
      unstated(
        `The typed review names ${typed.head.slice(0, 7)}, not the assigned commit ${sha.slice(0, 7)}. Steer the reviewer to review the assigned commit.`,
      );
      return;
    }
    // The typed code judgment is the verdict as typed, at every care: the
    // live proof beside it is a typed fact the record keeps and the
    // reviewer reads, never a hold the host converts a pass into.
    const verdict = REVIEW_VERDICT_OF_CODE[typed.code];
    const findings = (typed.findings ?? []).map(renderFinding);
    const risk = typed.risk?.level;
    const riskNote = typed.risk?.why;
    const shortSha = sha.slice(0, 7);
    const at = this.host.now();
    const riskText = risk ? `risk ${risk}${riskNote ? `: ${riskNote}` : ""}` : "risk unstated";
    const facts = {
      reviewVerdict: verdict,
      reviewSha: sha,
      reviewChange: review.delivery?.reviewChange,
      reviewCarrySha: undefined,
      ...(risk ? { reviewRisk: risk } : {}),
      ...(riskNote ? { reviewRiskNote: riskNote } : {}),
      reviewedAt: at,
    };
    if (verdict === "pass") {
      this.options.tasks.delivery.recordChangeEvidence(builder.id, facts, {
        kind: "review",
        text: `review passed at ${shortSha}, ${riskText}`,
        feed: true,
        data: { reviewTaskId: task.id },
      });
      try {
        await this.host.settling.closing.closeTask(task.id, {
          status: "done",
          reason: "finished",
          actor: "host",
          text: `review passed - ${builder.title}`,
          feed: false,
        });
      } catch (caught) {
        // The verdict is on the record either way; a close that failed
        // (a worktree that would not go) is a timeline fact, never a lost
        // pass - the wake below still says the review passed.
        const message = caught instanceof Error ? caught.message : String(caught);
        if (this.options.tasks.get(task.id)) {
          this.options.tasks.note(task.id, `could not close the review: ${message}`, {
            news: true,
            data: { closeFailed: message },
          });
        }
      }
      this.host.notifyOp(
        {
          facts: {
            kind: "review-passed",
            task: builderTask,
            reviewKey: task.key,
            crewmate: task.crewmate,
            head: sha,
            ...(risk ? { risk } : {}),
            ...(riskNote ? { riskNote } : {}),
            excerpt,
          },
        },
        "crewmate-report",
        builder.id,
      );
      return;
    }
    // The verdict is recorded without a host-owned review allowance.
    this.options.tasks.delivery.recordChangeEvidence(builder.id, facts, {
      kind: "review",
      text: `review ${verdict} at ${shortSha}, ${riskText}`,
      feed: false,
      data: { reviewTaskId: task.id },
    });
    const history = earlierHistory(
      reviewHistory(this.options.tasks, this.options.tasks.get(builder.id) ?? builder),
    );
    const verdictFacts: ReviewVerdictFacts = {
      kind: "review-verdict",
      task: reviewTask,
      builder: builderTask,
      crewmate: task.crewmate,
      verdict,
      excerpt,
      ...(findings.length > 0 ? { findings } : {}),
      cards: this.host.cards.shownCards(task.id),
      ...(history.length > 0 ? { history } : {}),
    };
    this.host.notifyOp({ facts: verdictFacts }, "crewmate-report", task.id);
  }
}
