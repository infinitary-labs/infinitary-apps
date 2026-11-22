import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardPictureFiles } from "@shared/cardPictures";
import { isRepairAssessment, REPAIR_ASSESSMENT_SOURCE } from "@shared/checkRepair";
import { COMPUTER } from "@shared/deviceNames";
import { standingOverride } from "@shared/holds";
import {
  acceptedValidation,
  type KeptValidationInput,
  validationRevision,
  validationStateRevision,
} from "@shared/liveValidation";
import { REVIEW_VERDICT_OF_CODE, renderFinding } from "@shared/rigor";
import { RISK_DIMENSIONS, RISK_WORDS } from "@shared/risk";
import { shortTaskTitle } from "@shared/taskTitle";
import { DeviceOutOfReachError } from "../connection/connection";
import { capWithOverflow } from "../overflow";
import { crewmateCardPicturesDir, crewmateEvidenceDir, crewmateSourceCardsDir } from "../paths";
import { verifyKeptValidationEvidence } from "../pi/validationEvidence";
import { tierFor } from "../routing/policy";
import type { RouteResult } from "../routing/router";
import type { MergeRepairAssessment, TaskRecord } from "../storage/taskRecords";
import { alreadyAllowed } from "../tasks/alreadyAllowed";
import { TaskService } from "../tasks/taskService";
import { approvedChangeBase, followBase, recordedBases } from "./baseFollow";
import type { CardService } from "./cardService";
import { briefCarriesPictures } from "./crewBrief";
import type { TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions, FirstmateHooks } from "./crewSupervisorOptions";
import {
  type CaptainCardFacts,
  type ReviewBriefFacts,
  renderRepairAssessmentBrief,
} from "./intentBrief";
import { lostComputer } from "./lostStarts";
import {
  ASSESSMENT_BOUND_MS,
  decideMergeRepair,
  parseRepairAssessment,
  standingAuthorization,
} from "./mergeAuthorization";
import type { ReviewVerdictFacts } from "./reportWakes";
import { earlierHistory, isCaptainAnswer, reviewHistory } from "./reviewHistory";
import { type ReviewPick, reviewPick, reviewPickLine } from "./reviewPick";
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
  notifyOp: FirstmateHooks["notifyOp"];
  /** Steer a task as the host, answering no message or card. */
  steer(taskId: string, wake: TypedWake): Promise<unknown>;
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
  private readonly preparingAssessments = new Set<string>();
  /**
   * A builder's report whose return to its reviewer lost the builder's
   * computer (INF-5142): by builder, the computer it waits for and the
   * return to try again once that computer is back.
   */
  private readonly lostReturns = new Map<string, { device: string; retry: () => Promise<void> }>();
  /** A return being tried again after a loss, by builder: the computer it lost. */
  private readonly retriedReturns = new Map<string, string>();
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
    // Only a pull request's page: a batched branch's compare page (INF-4196)
    // is no pull request, and the brief calls this one.
    const prUrl = builder.delivery?.prNumber !== undefined ? builder.delivery.prUrl : undefined;
    const machines = this.options.machines;
    const device = builder.deviceId;
    let headSha: string | null;
    let changedFiles: string[] | null;
    let changeReading: string | undefined;
    let evidenceDir: string;
    // The approved version the builder started on, named only where the read used it.
    let builtOn = this.options.tasks.graph.startedOn(builder);
    let builtOnHead: string | undefined;
    // The default branch read in place of origin's, named only where that computer read one.
    let base: string | undefined;
    if (device) {
      const folders = machines?.folders(device, builder.id);
      if (!machines?.ready(device, builder.id) || !folders)
        throw new DeviceOutOfReachError(
          "The builder's computer is out of reach; the review must wait for it, not run here instead.",
          { deviceId: device },
        );
      const read = await machines.revision(device, builder.id, undefined, builtOn?.head);
      ({ headSha, changedFiles, changeReading } = read);
      // Named only where that computer read from it: an older one reads from the default branch.
      builtOnHead = read.builtOn;
      base = read.base;
      evidenceDir = folders.evidence;
    } else {
      headSha = builder.branch
        ? await this.options.workspace.branchHead(builder.repoDir, builder.branch)
        : null;
      // A head that holds a newer approved version of the part under it reads from that version.
      if (headSha && builtOn) {
        await followBase(this.options.tasks, builder.id, headSha);
        builtOn = this.options.tasks.graph.startedOn(this.options.tasks.get(builder.id));
      }
      // Only while the head still builds on it and took in nothing newer from the default branch.
      builtOnHead =
        headSha && builtOn
          ? await this.options.workspace.builtOnAt(builder.repoDir, builtOn.head, headSha)
          : undefined;
      changedFiles = headSha
        ? await this.options.workspace.reviewChangedFiles(
            builder.repoDir,
            headSha,
            ...(builtOnHead ? [builtOnHead] : []),
          )
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
      builderGoal: builder.goal?.trim() || builder.title,
      branch: builder.branch,
      headSha,
      ...(base ? { base } : {}),
      ...(builtOnHead && builtOn
        ? { builtOn: { task: builtOn.task.key || builtOn.task.id, head: builtOn.head } }
        : {}),
      ...(prUrl ? { prUrl } : {}),
      builderReport: builder.outcome ?? "The builder has not reported yet.",
      evidenceDir,
      changedFiles,
      ...(changeReading ? { changeReading } : {}),
      ...(captainCard ? { captainCard } : {}),
      history: reviewHistory(this.options.tasks, builder),
      ...(standing ? { override: standing } : {}),
      allowed: alreadyAllowed(this.options.tasks, builder, headSha).allowances,
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
      if (
        (live || this.preparingAssessments.has(open.taskId)) &&
        this.host.now() - open.at <= ASSESSMENT_BOUND_MS
      )
        return;
      this.repairDecided(builderId, open.taskId, "failed");
      if (live) void this.retireAssessments(builderId, "it ran past its time");
      return;
    }
    // One still reading a repair the crewmate has since replaced answers nothing.
    void this.retireAssessments(builderId, "a newer repair replaced the one it read");
    const assessorId = randomUUID().slice(0, 8);
    this.preparingAssessments.add(assessorId);
    void (async () => {
      const title = shortTaskTitle(`Assess repair: ${builder.title}`);
      let brief: string;
      let routed: RouteResult | undefined;
      let preferred: ReviewPick | undefined;
      try {
        // Recorded before it exists, so a second read finds it and starts none,
        // and one that cannot be made ends the approval like one that cannot finish.
        this.options.tasks.delivery.recordPermissionRecords(builder.id, {
          mergeAuthorization: {
            ...authorization,
            undecided: { ...undecided, assessment: { taskId: assessorId, at: this.host.now() } },
          },
        });

        const delivery = builder.delivery;
        // A part repaired onto the newest approved version of the part under it is read from
        // the version it was approved on, as its paths were (docs/task-graph.md).
        const recorded = recordedBases(this.options.tasks, builder, undecided.newBase);
        const found =
          recorded && builder.repoDir
            ? await approvedChangeBase(
                builder.repoDir,
                authorization.approvedHead,
                undecided.newBase,
                recorded,
              ).catch(() => undefined)
            : undefined;
        const approvedBase = found && recorded?.includes(found) ? found : undefined;
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
          ...(approvedBase ? { approvedBase } : {}),
          paths: undecided.paths ?? { approved: [], repaired: undecided.changedPaths },
          evidence: undecided.evidence,
          validation: undecided.validation,
        });
        // The host establishes the kind, the way it does a review's: never
        // classified, its basis the builder, delivery machinery under it.
        const asked = withBasisVerdict(this.options.tasks, {
          kind: "review",
          kind_source: REPAIR_ASSESSMENT_SOURCE,
          basis: builder.id,
        });
        // Independent: the ladder prefers a provider other than the builder's.
        const avoidProvider = this.options.router?.servedProvider(builder.id);
        // The builder's pictures ride its brief (its basis): a model that takes text only is skipped.
        const images = briefCarriesPictures(this.options.tasks, assessorId, asked);
        // A model a standing direction calls for reviews it (INF-5021). It
        // runs on this Mac, and never waits: a wait would end the approval.
        const router = this.options.router;
        const pick = await reviewPick(
          this.options,
          {
            reviewerModels: async (prompt, shape, _machine, route) =>
              router
                ? router.reviewerModels(prompt, shape, await router.prepare(route))
                : undefined,
          },
          {
            builder,
            reviewId: assessorId,
            brief,
            shape: asked,
            route: { ...(avoidProvider ? { avoidProvider } : {}), images },
            started: "repair",
          },
        );
        // A repair never waits: a model the direction says to wait for is
        // kept as a preference, which routing passes over with its reason.
        preferred = pick && { ...pick, mode: "prefer" };
        const shape = preferred ? { ...asked, review_model: preferred.key } : asked;
        const create = async () => {
          const router = this.options.router;
          const prepared = await router?.prepare({
            ...(avoidProvider ? { avoidProvider } : {}),
            images,
          });
          const current = this.options.tasks.get(builder.id);
          if (
            !current ||
            TaskService.isClosed(current) ||
            standingAuthorization(current.delivery)?.undecided?.assessment?.taskId !== assessorId
          )
            return;
          routed =
            router && prepared ? router.decide(assessorId, brief, shape, prepared) : undefined;
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
        };
        if (router) await router.inOrder(create);
        else await create();
        if (!this.options.tasks.get(assessorId)) return;
      } catch (caught) {
        console.warn("[crew] a repair assessment could not be made:", caught);
        this.repairDecided(builderId, assessorId, "failed");
        return;
      } finally {
        this.preparingAssessments.delete(assessorId);
      }
      if (preferred)
        this.options.tasks.note(
          assessorId,
          reviewPickLine(preferred, routed, this.options.router),
          { news: true },
        );
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
    })();
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
      // The accepted repair follows the part under it at its version, as a declared one does.
      void followBase(this.options.tasks, builderId, decided.head)
        .catch((caught: unknown) => {
          console.warn("[crew] the part under a repaired change could not be followed:", caught);
        })
        .then(() => this.host.settling.kept.runMergeAuthorization(builderId))
        .catch((caught: unknown) => {
          console.warn("[crew] kept merge could not run:", caught);
        });
      return;
    }
    // The task's other approvals end with it, and its crewmate hears which (INF-2746).
    if (decided.decided === "ended") this.host.settling.approvals.promoteQueued(builderId);
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
      // While the reviewer's own card is up, a report with no record is its
      // card's turn or an answer under it, at the version its verdict read.
      // A declared needs_firstmate still reaches the first mate, and a turn
      // assigned a newer version that ends with no verdict is unstated.
      const needsFirstmate = this.options.tasks.lastReportEntries(task.id).at(-1)
        ?.declared.needsFirstmate;
      if (needsFirstmate)
        this.host.notifyOp(
          {
            facts: {
              kind: "report",
              task: builderTask,
              crewmate: task.crewmate,
              excerpt,
              filed: [],
              cards: this.host.cards.shownCards(task.id),
              needsFirstmate,
            },
          },
          "crewmate-report",
          builder.id,
        );
      else if (!this.reviewCardOpen(task.id) || !this.assignedAsRead(review, builder)) unstated();
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
    const needsFirstmate = this.options.tasks.lastReportEntries(task.id).at(-1)
      ?.declared.needsFirstmate;
    if (needsFirstmate) {
      this.options.tasks.delivery.recordChangeEvidence(builder.id, facts, {
        kind: "review",
        text: `review ${verdict} at ${shortSha}, ${riskText}`,
        feed: false,
        data: { reviewTaskId: task.id },
      });
      this.host.notifyOp(
        {
          facts: {
            kind: "report",
            task: builderTask,
            crewmate: task.crewmate,
            excerpt,
            filed: [],
            cards: this.host.cards.shownCards(task.id),
            needsFirstmate,
          },
        },
        "crewmate-report",
        builder.id,
      );
      return;
    }
    if (verdict === "pass") {
      // INF-2672: whether the builder's live proof is accepted here decides
      // the next step the wake names - prove once, read it, or push.
      const validation = this.options.tasks.get(builder.id)?.delivery?.liveValidation;
      this.options.tasks.delivery.recordChangeEvidence(builder.id, facts, {
        kind: "review",
        text: `review passed at ${shortSha}, ${riskText}`,
        feed: true,
        data: { reviewTaskId: task.id },
      });
      // Keep this independent reader for the proof read after the code pass.
      // The assignment records the pass so that turn reads only proof or the repair's difference.
      if (validation?.scenarioRevision && !acceptedValidation(validation, sha).ready) {
        this.options.tasks.delivery.recordChangeEvidence(task.id, { passedHead: sha });
        await this.deliverToBuilder(builder, {
          facts: { kind: "review-handoff", from: task.key, head: sha, stage: "proof", excerpt },
          once: `review-proof:${task.id}:${sha}:${typed.revision}`,
        });
        return;
      }
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
      await this.deliverToBuilder(builder, {
        facts: { kind: "review-handoff", from: task.key, head: sha, stage: "ship", excerpt },
        once: `review-pass:${task.id}:${sha}:${typed.revision}`,
      });
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
    const fixes = (typed.findings ?? [])
      .filter((finding) => finding.action === "auto-fix" && finding.severity !== "info")
      .map(renderFinding);
    if (fixes.length > 0)
      await this.deliverToBuilder(builder, {
        facts: {
          kind: "review-handoff",
          from: task.key,
          head: sha,
          stage: "fix",
          excerpt,
          findings: fixes,
          history,
        },
        once: `review-fix:${task.id}:${sha}:${typed.revision}`,
      });
    // A finding for the captain goes back to the reviewer that read the
    // change, which puts it to them on its own card (INF-4338's direction
    // D); the first mate is not on that path.
    const asks = (typed.findings ?? [])
      .filter((finding) => finding.action === "ask-user")
      .map(renderFinding);
    if (asks.length > 0)
      await this.deliverTo(builder, task.id, {
        facts: {
          kind: "review-handoff",
          from: builder.key || builder.id,
          head: sha,
          stage: "card",
          excerpt: `Your review of "${builder.title}" holds ${asks.length === 1 ? "a finding" : `${asks.length} findings`} for the captain.`,
          findings: asks,
          history,
        },
        once: `review-card:${task.id}:${sha}:${typed.revision}`,
      });
    // The first mate makes decisions, not routine deliveries. The complete
    // verdict and its summary remain on the builder's record for its next read.
    if (
      verdict === "blocked" ||
      typed.findings?.some((finding) => finding.action === "no-op" && finding.severity !== "info")
    )
      this.host.notifyOp({ facts: verdictFacts }, "crewmate-report", task.id);
  }

  /**
   * Whether a review's own Review finding card is up (INF-4338's direction
   * D): a report its reviewer makes while one is, without a review record,
   * is the card's turn or an answer under it, never an unstated verdict.
   */
  private reviewCardOpen(reviewId: string): boolean {
    for (const card of this.host.cards.values())
      if (card.taskId === reviewId && card.reviewTaskId) return true;
    return false;
  }

  /**
   * Whether the review's assignment is what its last verdict read: the head
   * that verdict recorded and the evidence and state revisions its kept
   * review entry judged. Every reviewer turn moves the assignment
   * (`refreshReview`), so a card or reply turn takes newer facts without
   * reading them.
   */
  private assignedAsRead(review: TaskRecord, builder: TaskRecord): boolean {
    const assigned = review.delivery?.validationAssignment;
    const read = this.lastRead(review, builder);
    return (
      review.delivery?.headSha === read.head &&
      (assigned?.revision ?? 0) === read.revision &&
      (assigned?.stateRevision ?? 0) === read.stateRevision
    );
  }

  /**
   * The head, evidence revision and state revision this review's last verdict
   * read, from its own kept entry; before its first verdict, its assignment.
   */
  private lastRead(review: TaskRecord, builder: TaskRecord) {
    const kept = builder.delivery?.liveValidation?.reviews.findLast(
      (entry) => entry.reviewer === review.id,
    );
    const assigned = review.delivery?.validationAssignment;
    return {
      head: kept ? kept.head : review.delivery?.headSha,
      revision: kept ? kept.revision : (assigned?.revision ?? 0),
      stateRevision: kept ? (kept.stateRevision ?? 0) : (assigned?.stateRevision ?? 0),
    };
  }

  /** A failed delivery is a decision for the first mate, never a lost verdict. */
  private async deliverToBuilder(builder: TaskRecord, wake: TypedWake): Promise<void> {
    await this.deliverTo(builder, builder.id, wake);
  }

  private async deliverTo(builder: TaskRecord, taskId: string, wake: TypedWake): Promise<void> {
    try {
      await this.host.steer(taskId, wake);
    } catch (caught) {
      const problem = caught instanceof Error ? caught.message : String(caught);
      this.host.notifyOp(
        {
          facts: {
            kind: "report",
            task: { id: builder.id, title: builder.title },
            crewmate: "The host",
            excerpt: `Review handoff failed: ${problem}`,
            filed: [],
            cards: this.host.cards.shownCards(builder.id),
            needsFirstmate: "Recover the review handoff; the verdict remains on the task's record",
          },
        },
        "crewmate-report",
        builder.id,
      );
    }
  }

  /** Return a builder's new facts to its existing reader, once per assignment. */
  async returnToReview(builder: TaskRecord, excerpt: string): Promise<boolean> {
    const review = this.options.tasks.graph
      .openChildren(builder.id)
      .find((child) => child.shape?.kind === "review" && !isRepairAssessment(child.shape));
    if (!review || !builder.delivery?.reviewedAt) return false;
    const facts = await this.reviewFacts(builder);
    this.lostReturns.delete(builder.id);
    const validation = builder.delivery?.liveValidation;
    const revision = validationRevision(validation);
    const state = validationStateRevision(validation);
    // The captain's answer on the reviewer's own card since its verdict is
    // new to the reviewer too, even when the builder changed nothing (an
    // As built answer): the reviewer reads it at the same version.
    const read = this.lastRead(review, builder);
    const answer = this.options.tasks
      .timeline(review.id)
      .findLast(
        (event) => isCaptainAnswer(event) && event.at > (builder.delivery?.reviewedAt ?? 0),
      );
    if (
      !answer &&
      // What the last verdict read: a card or reply turn takes the builder's
      // newest commit and evidence as its assignment without reading them.
      facts.headSha === read.head &&
      revision === read.revision &&
      state === read.stateRevision
    )
      return false;
    await this.host.steer(review.id, {
      facts: {
        kind: "review-handoff",
        from: builder.key || builder.id,
        head: facts.headSha,
        stage: "reread",
        excerpt,
      },
      once: `review-return:${review.id}:${facts.headSha}:${revision}:${state}${answer ? `:${answer.id}` : ""}`,
    });
    return true;
  }

  /**
   * A builder's report whose return to its reviewer lost the builder's
   * computer mid-read (INF-5142, as a lost start does): the return waits
   * for that computer and is tried again by itself once it is back
   * (`resumeLostReturns`), with nothing for the first mate. Lost again on
   * that try, it is news a retry does not change: `twice`, and the caller
   * tells the first mate with these words. Anything else is no loss.
   */
  waitForLostReturn(
    builder: TaskRecord,
    caught: unknown,
    retry: () => Promise<void>,
  ): { kind: "waiting" } | { kind: "twice"; words: string } | undefined {
    const loss = lostComputer(caught);
    const device = loss ? (loss.deviceId ?? builder.deviceId ?? undefined) : undefined;
    if (!device) return undefined;
    const who = this.options.machines?.nameOf(device) ?? `the builder's ${COMPUTER.one}`;
    const message = caught instanceof Error ? caught.message : String(caught);
    if (this.retriedReturns.get(builder.id) === device) {
      this.lostReturns.delete(builder.id);
      return {
        kind: "twice",
        words: `${who} went out of reach twice while the fix was read for its reviewer (${message})`,
      };
    }
    this.lostReturns.set(builder.id, { device, retry });
    this.options.tasks.note(
      builder.id,
      `${who} went out of reach while the fix was read for its reviewer; it goes to the reviewer once ${who} is back`,
      { news: false },
    );
    return { kind: "waiting" };
  }

  /**
   * Try again each return that lost its builder's computer, once that
   * computer is back in reach or the builder no longer runs there; a closed
   * builder's wait just ends (the sweep that starts ready work, run as a
   * computer catches up and once a minute).
   */
  async resumeLostReturns(): Promise<void> {
    const machines = this.options.machines;
    for (const [builderId, lost] of [...this.lostReturns]) {
      const builder = this.options.tasks.get(builderId);
      const open =
        builder !== undefined && builder.status !== "done" && builder.status !== "dropped";
      const there =
        open &&
        builder.deviceId === lost.device &&
        (machines?.computers().includes(lost.device) ?? false);
      if (there && machines?.ready(lost.device, builderId) !== true) continue;
      this.lostReturns.delete(builderId);
      // A closed builder has no reviewer left to return to.
      if (!open) continue;
      this.retriedReturns.set(builderId, lost.device);
      try {
        await lost.retry();
      } catch (caught) {
        console.warn("[crew] a lost review return could not be tried again:", caught);
      } finally {
        this.retriedReturns.delete(builderId);
      }
    }
  }
}
