import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { OpenChangeInput, StagedChangePresentation } from "@shared/changePresentation";
import type { CheckChangeInput } from "@shared/checkRepair";
import {
  checkSnapshotSummary,
  currentCheckStatus,
  type MainCheckEvidence,
} from "@shared/checkSnapshot";
import { forgeOf, hasChangeRequests } from "@shared/forge";
import { notSignedInText } from "@shared/forges";
import { fixedHoldWords, overridePasses, softHoldWords } from "@shared/holds";
import { acceptedValidation } from "@shared/liveValidation";
import {
  type AbsentChecksDeclaration,
  MERGE_REVIEW_CAP,
  type MergeRelationship,
  type MergeReview,
  mergeRuleWords,
  type SkippedRule,
} from "@shared/mergeReview";
import { isMergeConflict } from "@shared/plainProblem";
import {
  hostedPresentation,
  type LocalPresentationDestination,
  type PresentationDestination,
} from "@shared/presentationDestination";
import { deliveryForRecord, type RepoView } from "@shared/repos";
import { effectiveTaskPolicies } from "@shared/taskPolicies";
import { NEVER_SENT_AGAIN } from "@shared/writeAsk";
import type { NamingRule } from "../../shared/runbooks";
import {
  AttachmentUploadError,
  allowanceResetOf,
  changeTitle,
  describeCheckState,
  type Forge,
  type ForgeChange,
  type ForgeCheck,
  type ForgeCheckState,
  ForgeError,
  type ForgePull,
  type ForgeReadiness,
  type ForgeRepo,
  type ForgeRuleset,
  ForgeWriteError,
  isRedCheckState,
  isSignInForgeFailure,
  isTransientForgeFailure,
  messageWithoutPresentation,
  PresentationAroundError,
  presentationLines,
} from "../forge";
import type { CiWatch, TaskDelivery, TaskRecord } from "../storage/taskStore";
import { earlyPublication } from "../tasks/liveValidation";
import type { TaskService } from "../tasks/taskService";
import { requireConventional, requireConventionalRange } from "../workspace/conventional";
import { git } from "../workspace/git";
import type { RepoRegistry } from "../workspace/repoRegistry";
import { readChangeReading } from "../workspace/workspaceService";
import type { ChangePresentations } from "./changePresentations";
import { declareCheckAction, observeCheckRepair } from "./checkRepair";
import { armWatch, type WatchedCheck, type WatchedReading } from "./checkWatch";
import type { MainBranchReading } from "./mainCheckWake";
import {
  candidateHead,
  declareMergeGuidance,
  declareMergeRepair,
  type LineageFacts,
  type LineageQuestion,
  MERGE_CHECKS_HOLD_REASON,
  outstandingGuidance,
  standingAuthorization,
} from "./mergeAuthorization";
import { carryPassedReview, reviewCoversHead } from "./reviewCarry";

/** Reads forge facts and records the crew's version-bound declarations.
 * Merge identity, consent, host readiness and send-once effects remain host-owned.
 */

/**
 * `merged`: no open change for the branch, and the pull request the task
 * names reads merged by its number - put in where the project lives
 * outside the app (FI3-213). Nothing is left to check or to merge.
 */
export type PrCiOverall = "green" | "red" | "pending" | "no-pr" | "merged";

/**
 * A merge or close outcome. `text` is the tool text the Firstmate reads;
 * `problem`, when set, is the raw failure it quotes (the host's or the
 * network's words), so a feed line can say what it means through
 * `plainProblem` while the raw words stay on the record; `plain`, when set,
 * is the reason in the app's own words where `text` carries the raw check
 * list.
 */
export type PrOutcome = {
  ok: boolean;
  text: string;
  problem?: string;
  plain?: string;
  /** The merge was refused because current readiness was not established (no sign-in or forge failure). */
  notGreen?: boolean;
  /**
   * Why a guarded merge stopped, as a typed fact (FI3-304): the settle path
   * keeps or ends the captain's approval on it, never on the words.
   */
  stop?: MergeStop;
  /** The merge GitHub confirmed, at the head it merged. */
  receipt?: { head: string; sha?: string; already?: boolean };
  /**
   * A merge's line in Activity: the result without its address or closing
   * period ("Merged #709 on GitHub", INF-1845).
   */
  line?: string;
  /**
   * The host refused who the app is (git integration PR 1.2): not signed
   * in to it here, or a sign-in it no longer accepts. The settle path
   * turns this into the not-signed-in refusal and its two ways.
   */
  signIn?: SignInFact;
};

/** Where a sign-in was missing, and the project it was for. */
export type SignInFact = { host: string; name: string; repoId?: string };

/**
 * Why a merge under the captain's kept approval stopped (FI3-304):
 * `conflict` / `behind` need the change brought up to date; `moved` is a
 * head the approval does not cover; `checks` the checks on the head;
 * `protected` GitHub's branch rules; `computing` GitHub not knowing yet;
 * `draft` a draft; `closed` a pull request no longer open; `identity` a
 * different pull request for the branch; `withdrawn` the approval ended
 * before the request went out; `sign-in` the app's sign-in; `transient` a
 * hiccup before anything was sent; `outcome` a request whose answer never
 * came and whose result could not be read back; `guidance` the captain's
 * newer words still wait for the crewmate's declaration (FI3-662).
 */
export type MergeStop =
  | "conflict"
  | "behind"
  | "moved"
  | "checks"
  | "protected"
  | "computing"
  | "draft"
  | "closed"
  | "identity"
  | "withdrawn"
  | "sign-in"
  | "transient"
  | "outcome"
  | "guidance";

/**
 * What a merge under the captain's kept approval holds to (FI3-304): the one
 * head and pull request it covers, whether the host runs it unattended
 * (GitHub must say the change may merge before anything is sent), and the
 * last look right before the request goes out - a refusal there stops it.
 */
export type MergeBoundary = {
  beforeDispatch: (head: string) => string | undefined;
  unattended: boolean;
};

export type MergeGuard = {
  head: string;
  prNumber: number;
  unattended: boolean;
  /** A hold on the approval right now: the merge waits on it and the approval stands. */
  held?: () => string | undefined;
  beforeDispatch: (head: string) => string | undefined;
};

/**
 * One check_pr_ci run: its text, whether it recorded a reading, and any raw
 * failure - with whether the forge typed it transient, the one kind a
 * put-in retries.
 */
type CheckRun = {
  text: string;
  recorded: boolean;
  problem?: string;
  transient?: boolean;
  signIn?: SignInFact;
};

/**
 * Who reads a check's text: the Firstmate's check_pr_ci, the crewmate's
 * check_change, or the host's own check watch (`./checkWatch.ts`).
 */
type Audience = "firstmate" | "crewmate" | "watch";

/** Backoff between put-in attempts retried for a transient host/network failure. */
const MERGE_RETRY_DELAYS_MS = [300, 900];

/**
 * The gaps between reads of a pull request the task did not open while
 * GitHub has not decided whether it can merge, after the captain's click
 * (INF-457). GitHub answers `mergeable: null` while a check it has just
 * started works out a test merge, often just after the default branch moved,
 * and asks to be read again shortly. Half a minute in all; still undecided
 * after the last read, the click is refused.
 */
const UNDECIDED_REREAD_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 11_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The checked change, and the forge that answered, for the put-in that follows. */
type CheckedChange = { change: ForgeChange; forge: Forge };

/** A merge's refusal on the saved story names the soft hold the captain's words pass (INF-1365). */
function storyHeld(caught: unknown): never {
  const message = caught instanceof Error ? caught.message : String(caught);
  throw new Error(`${message} ${softHoldWords("story", "firstmate")}`);
}

/** A pull request's number in the host's own words: `#N` on GitHub, `!N` on GitLab. */
function numberLabel(forge: Forge, number: number): string {
  return forge.label({ number, branch: "", headSha: "", url: null });
}

/** The words a change is named by in tool text: "pull request #N" (or `!N`), else the sent-up branch. */
function changeWords(forge: Forge, change: ForgeChange): string {
  const url = forge.url(change);
  return change.number !== undefined
    ? `pull request ${forge.label(change)}${url ? ` ${url}` : ""}`
    : `the pushed branch ${forge.label(change)}${url ? ` ${url}` : ""}`;
}

/** What open_change says of a body on a host whose pushed branch carries no description. */
function keepsNoDescription(forge: Forge): string {
  return `${forge.place ?? "The project's host"} keeps no description for a pushed branch, so body was not published.`;
}

/** Two descriptions alike as a host keeps them: line endings and trailing space aside. */
function sameDescription(held: string | undefined, body: string): boolean {
  const plain = (text: string) => text.replace(/\r\n?/g, "\n").trimEnd();
  return plain(held ?? "") === plain(body);
}

export class PrCiService {
  /** The checked change per task, for the put-in that follows a check. */
  private readonly checked = new Map<string, CheckedChange>();
  private readonly readinessInFlight = new Set<string>();
  /** The task's pull request as the last reading found it merged outside the app. */
  private readonly merged = new Map<string, { pull: ForgePull; forge: Forge }>();

  constructor(
    private readonly options: {
      namingRule?: () => NamingRule | null;
      tasks: TaskService;
      repos: RepoRegistry;
      presentations?: ChangePresentations;
      /** The forge for a task's repository (`createForgeResolver` in `src/core/forge/`). */
      forgeFor: (repo: ForgeRepo | undefined, fallbackDir?: string) => Forge;
      now?: () => number;
      /**
       * One feed line (a host refusing a change the app cannot fix itself),
       * naming the task it is about.
       */
      onNote?: (text: string, taskId: string) => void;
      /** Test seam for disposable forge fixtures without real remote heads. */
      validateRange?: (dir: string, branch: string, forge: Forge, head?: string) => Promise<void>;
      /** Test seam for a repair declaration's git facts (`lineageFacts`). */
      lineageFacts?: (dir: string, question: LineageQuestion) => Promise<LineageFacts>;
      /**
       * A task whose working copy is on a computer that runs work: its
       * branch is brought here from there before this Mac's own git reads
       * it, into the project's folder (docs/helper.md, "Its working
       * copies"). Never throws.
       */
      /** Synchronous: kept proof is checked immediately before the forge send. */
      verifyValidationEvidence?: (taskId: string) => void;
      bringBranchHome?: (taskId: string, strict?: boolean) => Promise<string | undefined>;
    },
  ) {}

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
   * completion-card CI gate (`CrewSupervisor.pendingCiGate`), which must
   * not let a stale or never-checked reading read as green. Answers
   * "pending" unless THIS call recorded a reading: an early return or a
   * failed forge call leaves an earlier reading on the record, and that
   * reading says nothing about the head the card is about now.
   */
  /**
   * INF-1793: whether the task's records complete no-mistakes' steps at a version - review and
   * document from an independent review that passed there (its brief also judges the documents),
   * test from live validation that review accepted. The care's name decides nothing: a review
   * happens at any care (INF-1875). A captain's override completes none.
   */
  private attestsAt(taskId: string): (head: string) => boolean {
    return (head) => {
      const current = this.options.tasks.get(taskId);
      if (!current) return false;
      return (
        reviewCoversHead(current.delivery, head) &&
        acceptedValidation(current.delivery?.liveValidation, head).ready
      );
    };
  }

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
   * The crewmate's check_change (git integration PR 1.2): the same reading
   * check_pr_ci takes and records - so the fact strip and check watch
   * see it - in words for the crewmate. A missing sign-in is the
   * captain's to fix: the crewmate reports it, never signs in itself.
   */
  async checkForCrew(taskId: string, input: CheckChangeInput = {}): Promise<string> {
    // The reading names the change it is of (INF-1873): a task reads only its own.
    if (input.change !== undefined) {
      const own = this.options.tasks.changeFor(taskId.trim());
      if (!own)
        return "check_change refused: this task has no change record yet; leave change out.";
      if (own.id !== input.change.trim())
        return `check_change refused: "${input.change}" is not this task's change; its change is ${own.id}.`;
    }
    if (input.pull !== undefined) {
      if (input.declaration) {
        const recorded = declareCheckAction(
          this.options.tasks,
          taskId,
          { declaration: input.declaration },
          this.now(),
        );
        if (!recorded.read) return recorded.text;
      }
      return input.skipRules
        ? this.prepareSkipReview(taskId, input.pull, input.skipRules)
        : this.prepareReview(taskId, input.pull, input.absentChecks);
    }
    if (input.skipRules) {
      return "Merge review refused: skipRules goes with pull, the pull request's number.";
    }
    // An absence declaration with no pull named is for this task's own pull
    // request (INF-1955): read against it, stored or refused in words,
    // never dropped.
    if (input.absentChecks) {
      const beside = (
        [
          "declaration",
          "diagnosis",
          "repair",
          "rerun",
          "conflictRepair",
          "captainGuidance",
        ] as const
      ).filter((field) => input[field] !== undefined);
      if (beside.length)
        return `Absence declaration refused: send absentChecks on its own, not beside ${beside.join(", ")}.`;
      return this.declareOwnAbsence(taskId, input.absentChecks);
    }
    const { conflictRepair, captainGuidance, ...checkInput } = input;
    let declared = "";
    // The captain's guidance is declared first: it may ride beside a repair.
    if (captainGuidance) {
      const located = this.locate(taskId);
      if ("said" in located) return located.said;
      const declaration = declareMergeGuidance(
        this.options.tasks,
        located.record.id,
        captainGuidance,
        this.now(),
      );
      if (!declaration.read) return declaration.text;
      declared = declaration.text;
    }
    if (conflictRepair) {
      if (checkInput.declaration || checkInput.diagnosis || checkInput.repair || checkInput.rerun) {
        return [
          declared,
          "Check declaration refused: send a conflictRepair on its own, not beside a diagnosis, repair or rerun.",
        ]
          .filter(Boolean)
          .join("\n");
      }
      const located = this.locate(taskId);
      if ("said" in located) return located.said;
      const { record } = located;
      const approvedHead = record.delivery?.mergeAuthorization?.approvedHead;
      const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
      const dir = repo?.path ?? record.repoDir;
      await this.branchHome(record);
      const facts: LineageFacts =
        !approvedHead || !dir
          ? { known: false, why: "no approved head or project folder" }
          : await (this.options.lineageFacts ?? lineageFacts)(dir, {
              approvedHead,
              fromHead: conflictRepair.fromHead,
              toHead: conflictRepair.toHead,
              newBase: conflictRepair.newBase,
            }).catch(
              (caught: unknown): LineageFacts => ({
                known: false,
                why: caught instanceof Error ? caught.message : String(caught),
              }),
            );
      const declaration = declareMergeRepair(
        this.options.tasks,
        record.id,
        conflictRepair,
        facts,
        this.now(),
      );
      if (!declaration.read) return [declared, declaration.text].filter(Boolean).join("\n");
      declared = [declared, declaration.text].filter(Boolean).join("\n");
    }
    if (checkInput.declaration || checkInput.diagnosis || checkInput.repair || checkInput.rerun) {
      const declaration = declareCheckAction(this.options.tasks, taskId, checkInput, this.now());
      if (!declaration.read) return declaration.text;
      declared = [declared, declaration.text].filter(Boolean).join("\n");
    }
    const run = await this.run(taskId, "crewmate");
    const reading = run.signIn ? crewSignInText(run.signIn) : run.text;
    // The approval's state rides the crewmate's reading, so the head a
    // repair starts from is never a guess.
    const kept = standingAuthorization(this.options.tasks.get(taskId.trim())?.delivery);
    const mark = kept ? outstandingGuidance(kept) : undefined;
    const repairAsk =
      kept?.waiting?.on === "conflict"
        ? " Declare a repair that brings the change up to date with conflictRepair from that head."
        : kept?.waiting?.on === "repair"
          ? " Declare the repair with conflictRepair from that head."
          : "";
    const keptLine = kept
      ? `The captain's merge approval is kept and covers ${candidateHead(kept)}${kept.waiting ? ` (the merge waits: ${kept.waiting.on})` : ""}.${repairAsk}${mark === undefined ? "" : ` Their guidance through mark ${mark} holds the merge until you declare its impact with captainGuidance.`}`
      : "";
    return [declared, reading, keptLine].filter(Boolean).join("\n");
  }

  /**
   * The crew's absence declaration for this task's own pull request, sent
   * with no pull named (INF-1955): matched to the pull request the task's
   * branch holds where the project lives, by its number, branch and the
   * declared version, and stored on an owned merge review exactly as one
   * named with pull is. A declaration the record cannot match is refused
   * in words; an empty hosted reading alone never registers it.
   */
  private async declareOwnAbsence(
    taskId: string,
    absent: NonNullable<CheckChangeInput["absentChecks"]>,
  ): Promise<string> {
    const located = this.locate(taskId);
    if ("said" in located) return located.said;
    const { record, branch, forge } = located;
    if (!forge.hasChecks)
      return `Absence declaration refused: ${forge.place ?? "where this project lives"} runs no checks, so there is nothing to declare; the reading already says so.`;
    let change: ForgeChange | null;
    try {
      change = await forge.changeFor(branch);
    } catch (caught) {
      if (isSignInForgeFailure(caught))
        return crewSignInText(this.signInFact(forge, record.repoId));
      const message = caught instanceof Error ? caught.message : String(caught);
      return `Absence declaration refused: could not read this task's pull request. ${message}`;
    }
    if (!change || change.number === undefined)
      return "Absence declaration refused: this task has no open pull request for its branch yet. Open it with open_change first, or name the pull request with pull.";
    if (absent.headSha !== change.headSha)
      return `Absence declaration refused: it names ${absent.headSha}, but this task's pull request ${forge.label(change)} is at ${change.headSha}. Declare that version, with the evidence and the local gate run at it.`;
    const answer = await this.prepareReview(taskId, change.number, absent);
    return answer.replace(/^Merge review refused:/, "Absence declaration refused:");
  }

  /**
   * Prepare a merge review of pull request `number` in the task's project.
   * The answer names the review id. Nothing is merged.
   */
  private async prepareReview(
    taskId: string,
    number: number,
    absent: CheckChangeInput["absentChecks"],
  ): Promise<string> {
    if (!Number.isInteger(number) || number < 1) {
      return "Merge review refused: pull must be the pull request's number.";
    }
    const located = this.locate(taskId);
    if ("said" in located) return located.said;
    const { record, forge } = located;
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    const origin = forgeOf(repo?.origin);
    if (!origin.owner || !origin.name || !origin.host) {
      return "Merge review refused: this project has no pull requests where it lives.";
    }
    if (!forge.pull) {
      return "Merge review refused: where this project lives has no pull requests to read.";
    }
    let pull: ForgePull;
    try {
      pull = await forge.pull(number);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (isSignInForgeFailure(caught))
        return crewSignInText(this.signInFact(forge, record.repoId));
      return `Merge review refused: could not read pull request ${number}. ${message}`;
    }
    if (pull.number !== number || pull.state !== "open" || pull.merged) {
      return `Merge review refused: pull request ${number} is not open.`;
    }
    if (!pull.branch || !pull.headSha || !pull.base) {
      return `Merge review refused: pull request ${number} did not name its branch, version and destination.`;
    }
    const project = `${origin.owner}/${origin.name}`;
    if (!pull.headRepo || pull.headRepo.toLowerCase() !== project.toLowerCase()) {
      return `Merge review refused: pull request ${number} is not a branch in ${project}. Forks are out of scope.`;
    }
    // A check reading names a PR; it does not transfer branch ownership.
    const owned = pull.branch === record.branch;
    const relationship: MergeRelationship = owned ? "owned" : "referenced";
    if (relationship === "referenced" && forge.kind !== "github") {
      return "Merge review refused: a pull request this task did not open is supported on GitHub, including GitHub Enterprise, not on this host.";
    }
    if (relationship === "referenced") {
      const destination = await forge.defaultBranch().catch(() => undefined);
      if (!destination || pull.base !== destination) {
        return `Merge review refused: pull request ${number} merges into ${pull.base}, not this project's default branch.`;
      }
    }
    let absentChecks: AbsentChecksDeclaration | undefined;
    if (absent) {
      const evidence = absent.evidence.trim();
      const localGate = absent.localGate.trim();
      if (!evidence || !localGate || absent.headSha !== pull.headSha) {
        return "Merge review refused: an absence declaration must name this pull request's current version, the workflow and changed-file evidence, and the local gate run at that version.";
      }
      absentChecks = { headSha: pull.headSha, evidence, localGate };
    }
    const review: MergeReview = {
      id: `mr${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      relationship,
      kind: forge.kind === "gitlab" ? "gitlab" : "github",
      host: origin.host,
      owner: origin.owner,
      name: origin.name,
      number,
      headSha: pull.headSha,
      base: pull.base,
      branch: pull.branch,
      method: "squash",
      title: pull.title ?? "",
      ...(absentChecks ? { absentChecks } : {}),
      at: this.now(),
    };
    const kept = [review, ...(record.delivery?.mergeReviews ?? [])].slice(0, MERGE_REVIEW_CAP);
    this.options.tasks.recordPermissionRecords(record.id, {
      mergeReviews: kept,
      checkTarget: relationship === "referenced" ? review : undefined,
    });
    const checks = await this.run(taskId, "crewmate");
    const where = forge.place ?? "where the project lives";
    const whose =
      relationship === "owned"
        ? "This is the task's own pull request. A confirmed merge finishes the task."
        : "This pull request is not the task's. A confirmed merge keeps the task and its working copy, and dropping the task does not close the pull request.";
    return [
      checks.text,
      `Merge review ${review.id} for ${forge.kind === "gitlab" ? "!" : "#"}${number} at ${pull.headSha} into ${pull.base} on ${where}.`,
      whose,
      "request_merge references this review. This request grants no approval and does not itself merge anything. With autonomy off, only the captain's merge button authorizes execution.",
      absentChecks
        ? "Absence evidence stored for this version. A merge offer expresses the crew's judgment; this evidence grants no merge permission."
        : "No absence declaration stored. An empty hosted reading alone does not establish that checks are absent.",
    ].join("\n");
  }

  /**
   * Whether a stored review may be shown to the captain now. Undefined when
   * it may; otherwise the refusal. Does not merge.
   */
  async reviewGate(taskId: string, reviewId: string): Promise<string | undefined> {
    const record = this.options.tasks.get(taskId);
    const review = record?.delivery?.mergeReviews?.find((item) => item.id === reviewId);
    if (!review) return `Card refused: merge review ${reviewId} is not on this task.`;
    if (review.skips) {
      // Marked sent before the send, so a merged one is sent too.
      if (review.sent) {
        return `Card refused: that merge was already sent once and is ${NEVER_SENT_AGAIN}. Prepare a new review to ask again. ${fixedHoldWords("sent-once")}`;
      }
      const fresh = await this.readSkipTarget(taskId, review);
      return fresh.ok ? undefined : `Card refused: ${fresh.text}`;
    }
    if (review.relationship === "owned") {
      const overall = await this.checkOverall(taskId);
      return overall === "green" || overall === "merged"
        ? undefined
        : `Card refused: the checks read ${overall}, not passed.`;
    }
    const fresh = await this.readReviewTarget(taskId, review);
    if (!fresh.ok) {
      return fresh.text === "already-merged"
        ? "Card refused: that pull request is already merged."
        : `Card refused: ${fresh.text}`;
    }
    return undefined;
  }

  /**
   * Merge the stored review after the captain's click. An owned review uses
   * the ordinary guarded merge. A referenced review uses the same send after
   * the same identity, check and readiness gates, and does not close the task.
   */
  async mergeReview(
    taskId: string,
    reviewId: string,
    guard?: MergeGuard,
  ): Promise<PrOutcome & { relationship?: MergeRelationship }> {
    const record = this.options.tasks.get(taskId);
    const approved = guard ? standingAuthorization(record?.delivery)?.review : undefined;
    const review =
      approved?.id === reviewId
        ? approved
        : record?.delivery?.mergeReviews?.find((item) => item.id === reviewId);
    if (!record || !review) {
      return { ok: false, text: `Cannot merge: merge review ${reviewId} is not on this task.` };
    }
    if (review.receipt) {
      return {
        ok: true,
        relationship: review.relationship,
        text: `Pull request #${review.number} was already merged at ${review.receipt.head}.`,
        receipt: {
          head: review.receipt.head,
          ...(review.receipt.sha ? { sha: review.receipt.sha } : {}),
          already: true,
        },
      };
    }
    if (review.skips) return this.mergeSkippingRules(taskId, review);
    if (review.relationship === "owned") {
      const outcome = await this.merge(
        taskId,
        guard ?? {
          head: review.headSha,
          prNumber: review.number,
          unattended: false,
          beforeDispatch: () => undefined,
        },
      );
      if (outcome.ok && outcome.receipt)
        this.storeReviewReceipt(taskId, review.id, outcome.receipt);
      return { ...outcome, relationship: "owned" };
    }
    return this.mergeReferenced(taskId, review, guard);
  }

  private storeReviewReceipt(
    taskId: string,
    reviewId: string,
    receipt: { head: string; sha?: string },
  ): void {
    const record = this.options.tasks.get(taskId);
    const reviews = record?.delivery?.mergeReviews;
    if (!reviews) return;
    this.options.tasks.recordPermissionRecords(taskId, {
      mergeReviews: reviews.map((item) =>
        item.id === reviewId
          ? {
              ...item,
              receipt: {
                head: receipt.head,
                ...(receipt.sha ? { sha: receipt.sha } : {}),
                at: this.now(),
              },
            }
          : item,
      ),
    });
  }

  /**
   * Prepare a merge past the branch rules (FI3-1571 piece 2): GitHub only,
   * squash only, at the version the crewmate read. It is stored only when
   * something holds the pull request - a rule, or a failed check - and
   * GitHub says this sign-in may skip every rule set holding the default
   * branch. The review names each rule and failed check; nothing is merged.
   */
  private async prepareSkipReview(
    taskId: string,
    number: number,
    skip: NonNullable<CheckChangeInput["skipRules"]>,
  ): Promise<string> {
    if (!Number.isInteger(number) || number < 1) {
      return "Merge review refused: pull must be the pull request's number.";
    }
    if (skip.method !== "squash") {
      return "Merge review refused: a merge that skips the branch rules uses squash only.";
    }
    const located = this.locate(taskId);
    if ("said" in located) return located.said;
    const { record, forge } = located;
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    const origin = forgeOf(repo?.origin);
    if (
      forge.kind !== "github" ||
      !forge.pull ||
      !forge.branchRules ||
      !forge.putInSkippingRules ||
      !origin.owner ||
      !origin.name ||
      !origin.host
    ) {
      return "Merge review refused: a merge that skips the branch rules is available on GitHub, including GitHub Enterprise, only.";
    }
    let pull: ForgePull;
    try {
      pull = await forge.pull(number);
    } catch (caught) {
      if (isSignInForgeFailure(caught))
        return crewSignInText(this.signInFact(forge, record.repoId));
      const message = caught instanceof Error ? caught.message : String(caught);
      return `Merge review refused: could not read pull request ${number}. ${message}`;
    }
    if (pull.number !== number || pull.state !== "open" || pull.merged) {
      return `Merge review refused: pull request ${number} is not open.`;
    }
    if (!pull.branch || !pull.headSha || !pull.base) {
      return `Merge review refused: pull request ${number} did not name its branch, version and destination.`;
    }
    if (pull.headSha !== skip.headSha) {
      return `Merge review refused: pull request ${number} is at ${pull.headSha}, not the version you named (${skip.headSha}). Read it again and prepare the review at the version you mean.`;
    }
    const project = `${origin.owner}/${origin.name}`;
    if (!pull.headRepo || pull.headRepo.toLowerCase() !== project.toLowerCase()) {
      return `Merge review refused: pull request ${number} is not a branch in ${project}. Forks are out of scope.`;
    }
    // A check reading names a PR; it does not transfer branch ownership.
    const owned = pull.branch === record.branch;
    const relationship: MergeRelationship = owned ? "owned" : "referenced";
    const read = await this.readSkipState(taskId, forge, pull);
    if (!read.ok) return `Merge review refused: ${read.text}`;
    const { rules, failedChecks } = read;
    if (pull.readiness === "clean" && failedChecks.length === 0) {
      return `Merge review refused: nothing holds pull request ${number}: GitHub reports no rule or terminal failure to skip. Prepare an ordinary review with pull alone.`;
    }
    const review: MergeReview = {
      id: `mr${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      relationship,
      kind: "github",
      host: origin.host,
      owner: origin.owner,
      name: origin.name,
      number,
      headSha: pull.headSha,
      base: pull.base,
      branch: pull.branch,
      method: "squash",
      title: pull.title ?? "",
      skips: { rules, failedChecks },
      at: this.now(),
    };
    const kept = [review, ...(record.delivery?.mergeReviews ?? [])].slice(0, MERGE_REVIEW_CAP);
    this.options.tasks.recordPermissionRecords(record.id, {
      mergeReviews: kept,
      checkTarget: relationship === "referenced" ? review : undefined,
    });
    const checks = await this.run(taskId, "crewmate");
    const where = forge.place ?? "GitHub";
    return [
      checks.text,
      `Merge review ${review.id} for #${number} at ${pull.headSha} into ${pull.base} on ${where}, skipping the branch rules.`,
      relationship === "owned"
        ? "This is the task's own pull request. A confirmed merge finishes the task."
        : "This pull request is not the task's. A confirmed merge keeps the task and its working copy.",
      rules.length
        ? `It may skip these rules, each of which ${where} says your sign-in may skip: ${rules.map((rule) => `${rule.rule} (${rule.ruleset})`).join("; ")}.`
        : "No branch rule holds it.",
      failedChecks.length
        ? `It merges with these checks failed: ${failedChecks.join(", ")}.`
        : "No terminal check failures were reported.",
      "request_merge references this review; the app names each rule and failed check on the card. Only the captain's click on that card sends it, once, at this version; the who-merges setting and every other path never do. A new version needs a new review.",
    ].join("\n");
  }

  /**
   * What a merge past the rules would skip, read fresh: the pull request
   * must be able to merge but for its rules and checks, every check must
   * have finished, and GitHub must say this sign-in may skip every rule set
   * holding the default branch, with squash allowed. Undefined text when it
   * may; otherwise why not, in the host's words.
   */
  private async readSkipState(
    taskId: string,
    forge: Forge,
    pull: ForgePull,
  ): Promise<
    | { ok: true; rules: SkippedRule[]; failedChecks: string[] }
    | { ok: false; text: string; stop?: MergeStop }
  > {
    const place = forge.place ?? "GitHub";
    const destination = await forge.defaultBranch().catch(() => undefined);
    if (!destination || pull.base !== destination) {
      return {
        ok: false,
        text: `pull request ${pull.number} merges into ${pull.base}, not this project's default branch.`,
        stop: "identity",
      };
    }
    if (
      pull.readiness === "conflict" ||
      pull.readiness === "draft" ||
      pull.readiness === "computing"
    ) {
      const { stop, plain } = readinessStops(place)[pull.readiness];
      return { ok: false, text: `${plain}. Skipping rules does not change that.`, stop };
    }
    const change: ForgeChange = {
      number: pull.number,
      url: null,
      branch: pull.branch ?? "",
      headSha: pull.headSha,
      title: pull.title ?? "",
      body: "",
    };
    let checks: Awaited<ReturnType<Forge["checks"]>>;
    let sets: ForgeRuleset[];
    try {
      checks = await forge.checks(change);
      sets = forge.branchRules ? await forge.branchRules(pull.base) : [];
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        ok: false,
        text: `the checks or the branch rules could not be read. ${message}`,
        stop: isSignInForgeFailure(caught) ? "sign-in" : "checks",
      };
    }
    // Captain F4: final results precede both bypass preparation and sending.
    if (checks.problem)
      return { ok: false, text: `The checks cannot be read. ${checks.problem}`, stop: "checks" };
    const record = this.options.tasks.get(taskId);
    const absent = record && this.absenceDeclared(record, { forge, change });
    if (
      checks.complete === false ||
      checks.items.some((item) => item.state === "pending") ||
      (checks.items.length === 0 && !absent)
    )
      return {
        ok: false,
        text: "The checks have not finished. Wait for their final results before preparing or sending a rule-bypass review.",
        stop: "checks",
      };
    const failedChecks = checks.items
      .filter((item) => isRedCheckState(item.state))
      .map((item) => item.name);
    const holding = sets.filter((set) => set.rules.some((rule) => mergeRuleWords(rule)));
    const locked = holding.filter((set) => set.bypass === null || set.bypass === "never");
    if (locked.length) {
      return {
        ok: false,
        text: `${place} says your sign-in may not skip ${locked.map((set) => `the rule set ${set.name}`).join(", ")}.`,
        stop: "protected",
      };
    }
    const noSquash = holding.find(
      (set) => set.mergeMethods && !set.mergeMethods.includes("squash"),
    );
    if (noSquash) {
      return {
        ok: false,
        text: `the rule set ${noSquash.name} allows no squash merge, the one method the app sends.`,
        stop: "protected",
      };
    }
    if ((pull.readiness === "blocked" || pull.readiness === "behind") && holding.length === 0) {
      return {
        ok: false,
        text: `${place} holds it by a rule outside its rule sets, such as classic branch protection, which the app cannot skip.`,
        stop: "protected",
      };
    }
    const rules = holding.flatMap((set) =>
      set.rules.flatMap((rule) => {
        const words = mergeRuleWords(rule);
        return words ? [{ ruleset: set.name, rule: words }] : [];
      }),
    );
    return { ok: true, rules, failedChecks };
  }

  /**
   * Re-read a merge past the rules before its card goes up and before the
   * click sends it: the same pull request at the reviewed version, and
   * nothing it would skip that the review did not name.
   */
  private async readSkipTarget(
    taskId: string,
    review: MergeReview,
  ): Promise<
    { ok: true; forge: Forge; pull: ForgePull } | { ok: false; text: string; stop?: MergeStop }
  > {
    const located = this.locate(taskId);
    if ("said" in located) return { ok: false, text: located.said };
    const { forge } = located;
    if (forge.kind !== "github" || !forge.pull || !forge.putInSkippingRules) {
      return { ok: false, text: "this host cannot merge past its branch rules." };
    }
    let pull: ForgePull;
    try {
      pull = await forge.pull(review.number);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        ok: false,
        text: `the pull request could not be read. ${message}`,
        stop: isSignInForgeFailure(caught)
          ? "sign-in"
          : isTransientForgeFailure(caught)
            ? "transient"
            : undefined,
      };
    }
    const project = `${review.owner}/${review.name}`;
    if (
      pull.number !== review.number ||
      pull.base !== review.base ||
      pull.branch !== review.branch ||
      !pull.headRepo ||
      pull.headRepo.toLowerCase() !== project.toLowerCase()
    ) {
      return {
        ok: false,
        text: "the pull request is not the one that was reviewed.",
        stop: "identity",
      };
    }
    if (pull.merged) return { ok: false, text: "already-merged", stop: "outcome" };
    if (pull.state !== "open") {
      return { ok: false, text: "the pull request was closed without merging.", stop: "closed" };
    }
    if (pull.headSha !== review.headSha) {
      return {
        ok: false,
        text: `the pull request is at ${pull.headSha}, and the review covers ${review.headSha}. Nothing merged. A new version needs a new review and a new click.`,
        stop: "moved",
      };
    }
    const read = await this.readSkipState(taskId, forge, pull);
    if (!read.ok) return read;
    const named = new Set(
      (review.skips?.rules ?? []).map((rule) => `${rule.ruleset}\u0000${rule.rule}`),
    );
    const newRule = read.rules.find((rule) => !named.has(`${rule.ruleset}\u0000${rule.rule}`));
    if (newRule) {
      return {
        ok: false,
        text: `it would now also skip ${newRule.rule} (${newRule.ruleset}), which the review did not name. Nothing merged. Prepare a new review.`,
        stop: "protected",
      };
    }
    const failed = new Set(review.skips?.failedChecks ?? []);
    const newFailure = read.failedChecks.find((name) => !failed.has(name));
    if (newFailure) {
      return {
        ok: false,
        text: `the check ${newFailure} failed after the review, which did not name it. Nothing merged. Prepare a new review.`,
        stop: "checks",
      };
    }
    return { ok: true, forge, pull };
  }

  /**
   * The captain's click on a merge past the rules: re-read it, mark it
   * sent, then send it once. A result the app cannot read is unknown and is
   * never sent again; a confirmed merge keeps its receipt like any review.
   */
  private async mergeSkippingRules(
    taskId: string,
    review: MergeReview,
  ): Promise<PrOutcome & { relationship: MergeRelationship }> {
    const relationship = review.relationship;
    const label = `#${review.number}`;
    if (review.sent) {
      return {
        ok: false,
        relationship,
        text:
          review.sent.outcome === "failed"
            ? `Cannot merge: that merge was sent once and GitHub did not merge it${review.sent.text ? ` (${review.sent.text})` : ""}. Nothing was sent again; prepare a new review to ask again. ${fixedHoldWords("sent-once")}`
            : `Cannot merge: that merge was already sent once and its outcome is unknown${review.sent.text ? ` (${review.sent.text})` : ""}. Nothing was sent again; read pull request ${label} to see whether it merged. ${fixedHoldWords("sent-once")}`,
        stop: "outcome",
      };
    }
    const fresh = await this.readSkipTarget(taskId, review);
    if (!fresh.ok) {
      if (fresh.text === "already-merged") {
        const located = this.locate(taskId);
        const pull =
          "said" in located
            ? undefined
            : await located.forge.pull?.(review.number).catch(() => undefined);
        if (pull?.merged) {
          const receipt = {
            head: review.headSha,
            ...(pull.mergedSha ? { sha: pull.mergedSha } : {}),
          };
          this.storeReviewReceipt(taskId, review.id, receipt);
          return {
            ok: true,
            relationship,
            text: `${label} is already merged on GitHub.`,
            receipt: { ...receipt, already: true },
          };
        }
      }
      return {
        ok: false,
        relationship,
        text: `Cannot merge: ${fresh.text}`,
        ...(fresh.stop ? { stop: fresh.stop } : {}),
      };
    }
    const { forge, pull } = fresh;
    const place = forge.place ?? "GitHub";
    let change: ForgeChange = {
      number: pull.number,
      url: null,
      branch: pull.branch ?? review.branch,
      headSha: pull.headSha,
      title: pull.title ?? review.title,
      body: "",
    };
    try {
      requireConventional(change.title ?? "", "pull request title", this.options.namingRule?.());
      if (relationship === "owned" && this.options.tasks.get(taskId)?.delivery?.presentation) {
        const current = await forge.changeFor(change.branch);
        if (
          !current ||
          current.number !== change.number ||
          current.headSha !== change.headSha ||
          !this.options.presentations
        )
          throw new Error("The current story cannot be checked for complete evidence.");
        // INF-1365: the captain's override on the saved story passes its publication at this
        // version, read after the last wait before the send.
        change = overridePasses(this.options.tasks.get(taskId)?.delivery, "story", change.headSha)
          ? { ...current, squashMessage: messageWithoutPresentation(current.body ?? "", taskId) }
          : await this.options.presentations
              .assertPublished(taskId, current, forge)
              .catch(storyHeld);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return { ok: false, relationship, text: `Cannot merge: ${message}`, problem: message };
    }
    // Marked before the send: whatever happens next, it is never sent twice.
    this.markSkipSent(taskId, review.id, {});
    const whose = relationship === "owned" ? "" : " The task stays open.";
    const confirmed = (sha?: string): PrOutcome & { relationship: MergeRelationship } => {
      const receipt = { head: review.headSha, ...(sha ? { sha } : {}) };
      this.storeReviewReceipt(taskId, review.id, receipt);
      return {
        ok: true,
        relationship,
        text: `Merged ${label} on ${place}, skipping the branch rules.${whose}`,
        receipt,
      };
    };
    const unknown = async (
      why: string,
    ): Promise<PrOutcome & { relationship: MergeRelationship }> => {
      const after = await forge.pull?.(review.number).catch(() => undefined);
      if (after?.merged && after.headSha === review.headSha) return confirmed(after.mergedSha);
      this.markSkipSent(taskId, review.id, { outcome: "unknown", text: why });
      return {
        ok: false,
        relationship,
        text: `The merge of ${label} was sent once, and its outcome is unknown: ${why}. It is not sent again; read pull request ${label} to see whether it merged.`,
        problem: why,
        stop: "outcome",
      };
    };
    try {
      const result = await (forge.putInSkippingRules as NonNullable<Forge["putInSkippingRules"]>)(
        change,
        review.headSha,
      );
      if (result.status === "merged") return confirmed(result.sha);
      if (result.status === "unknown") return unknown(result.message);
      this.markSkipSent(taskId, review.id, { outcome: "failed", text: result.message });
      return {
        ok: false,
        relationship,
        text: `Cannot merge: ${place} did not merge ${label}: ${result.message}. Nothing merged, and it is not sent again.`,
        problem: result.message,
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // A transport failure may have reached the host; any answer it gave did not merge.
      if (isTransientForgeFailure(caught)) return unknown(message);
      this.markSkipSent(taskId, review.id, { outcome: "failed", text: message });
      return {
        ok: false,
        relationship,
        text: `Cannot merge: ${message}. Nothing merged, and it is not sent again.`,
        problem: message,
        ...(isSignInForgeFailure(caught) ? { stop: "sign-in" as const } : {}),
      };
    }
  }

  /** A merge past the rules was sent, or its outcome is known: stored before and after the send. */
  private markSkipSent(
    taskId: string,
    reviewId: string,
    outcome: { outcome?: "failed" | "unknown"; text?: string },
  ): void {
    const reviews = this.options.tasks.get(taskId)?.delivery?.mergeReviews;
    if (!reviews) return;
    this.options.tasks.recordPermissionRecords(taskId, {
      mergeReviews: reviews.map((item) =>
        item.id === reviewId
          ? { ...item, sent: { at: item.sent?.at ?? this.now(), ...outcome } }
          : item,
      ),
    });
  }

  /**
   * Re-read a referenced review's target. `ok` means it still matches and may
   * merge. At the captain's click (`click`), a pull request GitHub has not
   * decided on yet is read again until it decides (`readDecided`).
   */
  private async readReviewTarget(
    taskId: string,
    review: MergeReview,
    click = false,
  ): Promise<
    { ok: true; forge: Forge; pull: ForgePull } | { ok: false; text: string; stop?: MergeStop }
  > {
    const located = this.locate(taskId);
    if ("said" in located) return { ok: false, text: located.said };
    const { forge } = located;
    const repo = located.record.repoId ? this.options.repos.get(located.record.repoId) : undefined;
    const origin = forgeOf(repo?.origin);
    if (
      origin.host !== review.host ||
      origin.owner !== review.owner ||
      origin.name !== review.name
    ) {
      return {
        ok: false,
        text: "where the reviewed pull request lives changed.",
        stop: "identity",
      };
    }
    if (forge.kind !== "github" || !forge.pull) {
      return { ok: false, text: "this host cannot merge a pull request the task did not open." };
    }
    const read = forge.pull.bind(forge);
    let pull: ForgePull;
    let waited = 0;
    try {
      ({ pull, waited } = await readDecided(
        () => read(review.number),
        review.headSha,
        click ? UNDECIDED_REREAD_MS : [],
      ));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        ok: false,
        text: `the pull request could not be read. ${message}`,
        stop: isSignInForgeFailure(caught)
          ? "sign-in"
          : isTransientForgeFailure(caught)
            ? "transient"
            : undefined,
      };
    }
    const project = `${review.owner}/${review.name}`;
    if (
      pull.number !== review.number ||
      pull.base !== review.base ||
      pull.branch !== review.branch ||
      !pull.headRepo ||
      pull.headRepo.toLowerCase() !== project.toLowerCase()
    ) {
      return {
        ok: false,
        text: "the pull request is not the one that was reviewed.",
        stop: "identity",
      };
    }
    if (pull.merged) {
      return { ok: false, text: "already-merged", stop: "outcome" };
    }
    if (pull.state !== "open") {
      return { ok: false, text: "the pull request was closed without merging.", stop: "closed" };
    }
    if (pull.headSha !== review.headSha) {
      return {
        ok: false,
        text: `the pull request is at ${pull.headSha}, and the review covers ${review.headSha}. Nothing merged. A new version needs a new review and a new click.`,
        stop: "moved",
      };
    }
    const destination = await forge.defaultBranch().catch(() => undefined);
    if (!destination || pull.base !== destination) {
      return {
        ok: false,
        text: "the pull request no longer merges into the default branch.",
        stop: "identity",
      };
    }
    const held = readinessStop(forge, pull, { head: review.headSha });
    if (held) {
      const plain = held.plain ?? held.text;
      return {
        ok: false,
        text:
          held.stop === "computing" && waited > 0
            ? `${plain}, after reading it again for ${Math.round(waited / 1_000)} seconds. Nothing merged.`
            : plain,
        stop: held.stop,
      };
    }
    const change: ForgeChange = {
      number: pull.number,
      url: null,
      branch: pull.branch ?? review.branch,
      headSha: pull.headSha,
      title: pull.title ?? review.title,
      body: "",
    };
    let checks: Awaited<ReturnType<Forge["checks"]>>;
    try {
      checks = await forge.checks(change);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        ok: false,
        text: `the checks could not be read. ${message}`,
        stop: isSignInForgeFailure(caught) ? "sign-in" : "checks",
      };
    }
    const record = this.options.tasks.get(taskId);
    if (
      checks.items.length === 0 &&
      (!record || !this.absenceDeclared(record, { forge, change })) &&
      !overridePasses(record?.delivery, "checks", pull.headSha)
    )
      return {
        ok: false,
        text: "No checks have registered and no positive absence declaration covers this version.",
        stop: "checks",
      };
    const status = checkSnapshotSummary({
      headSha: pull.headSha,
      items: checks.items,
      complete: checks.complete,
      problem: checks.problem,
      absenceDeclared: Boolean(record && this.absenceDeclared(record, { forge, change })),
    }).overall;
    if (
      status !== "green" &&
      status !== "none" &&
      !overridePasses(record?.delivery, "checks", pull.headSha)
    )
      return {
        ok: false,
        text: checks.problem
          ? `the checks cannot be read. ${checks.problem}`
          : status === "red"
            ? "the checks failed"
            : MERGE_CHECKS_HOLD_REASON,
        stop: "checks",
      };
    return { ok: true, forge, pull };
  }

  private async mergeReferenced(
    taskId: string,
    review: MergeReview,
    guard?: MergeGuard,
  ): Promise<PrOutcome & { relationship: "referenced" }> {
    const candidate = guard ? { ...review, headSha: guard.head } : review;
    const fresh = await this.readReviewTarget(taskId, candidate, !guard?.unattended);
    if (!fresh.ok) {
      if (fresh.text === "already-merged") {
        const located = this.locate(taskId);
        if (!("said" in located) && located.forge.pull) {
          const pull = await located.forge.pull(review.number).catch(() => undefined);
          if (pull?.merged && pull.headSha === candidate.headSha) {
            const receipt = {
              head: candidate.headSha,
              ...(pull.mergedSha ? { sha: pull.mergedSha } : {}),
            };
            this.storeReviewReceipt(taskId, review.id, receipt);
            return {
              ok: true,
              relationship: "referenced",
              text: `#${review.number} is already merged${located.forge.place ? ` on ${located.forge.place}` : ""}.`,
              receipt: { ...receipt, already: true },
            };
          }
        }
      }
      return {
        ok: false,
        relationship: "referenced",
        text:
          guard && fresh.stop === "moved"
            ? `Cannot merge: the pull request moved past the approved version. Declare its repair with check_change conflictRepair; the captain's approval is kept.`
            : `Cannot merge: ${fresh.text}`,
        ...(fresh.stop ? { stop: fresh.stop } : {}),
        ...(fresh.stop === "checks" ? { notGreen: true } : {}),
      };
    }
    const { forge, pull } = fresh;
    const change: ForgeChange = {
      number: pull.number,
      url: null,
      branch: pull.branch ?? review.branch,
      headSha: pull.headSha,
      title: pull.title ?? review.title,
      body: "",
    };
    let dispatched = false;
    try {
      if (hasChangeRequests(forge.kind))
        requireConventional(change.title ?? "", "pull request title", this.options.namingRule?.());
      const held = guard?.held?.();
      if (held) return { ok: false, relationship: "referenced", stop: "guidance", text: held };
      const stopped = guard?.beforeDispatch(candidate.headSha);
      if (stopped)
        return { ok: false, relationship: "referenced", stop: "withdrawn", text: stopped };
      dispatched = true;
      const sent = await forge.putIn(change, candidate.headSha);
      const receipt = { head: candidate.headSha, ...(sent?.sha ? { sha: sent.sha } : {}) };
      this.storeReviewReceipt(taskId, review.id, receipt);
      return {
        ok: true,
        relationship: "referenced",
        text: `Merged ${forge.label(change)}${forge.place ? ` on ${forge.place}` : ""}. The task stays open.`,
        receipt,
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const after = await forge.pull?.(review.number).catch(() => undefined);
      if (after?.merged && after.headSha === candidate.headSha) {
        const receipt = {
          head: candidate.headSha,
          ...(after.mergedSha ? { sha: after.mergedSha } : {}),
        };
        this.storeReviewReceipt(taskId, review.id, receipt);
        return {
          ok: true,
          relationship: "referenced",
          text: `Merged #${review.number}${forge.place ? ` on ${forge.place}` : ""}. The task stays open.`,
          receipt,
        };
      }
      return {
        ok: false,
        relationship: "referenced",
        text: `Cannot merge: ${message}`,
        problem: message,
        stop: guard
          ? ((await this.refusalStop(forge, guard, caught, message)) ??
            (dispatched ? "outcome" : undefined))
          : /409/.test(message)
            ? "moved"
            : undefined,
      };
    }
  }

  /**
   * The check watch's read (`./checkWatch.ts`): the forge calls a reading
   * makes, answered as a typed fact rather than tool text. A reading
   * records pending as well as settled checks, so every surface follows a
   * new head immediately. Pending readings spend no repair round.
   */
  async readWatched(taskId: string): Promise<WatchedReading> {
    const located = this.locate(taskId);
    if ("said" in located) return { kind: "failed", transient: false, problem: located.said };
    const { record, forge } = located;
    const branch = record.delivery?.checkTarget?.branch ?? located.branch;
    try {
      let change = await this.checkChange(record, branch, forge);
      if (!change) {
        const pull = await this.namedPull(
          forge,
          record.delivery?.checkTarget?.number ?? record.delivery?.prNumber,
        );
        this.assertCheckTarget(record);
        this.record(record.id, pull?.merged ? "merged" : "no-pr");
        if (pull?.merged) {
          this.options.tasks.recordChangeEvidence(record.id, { headSha: pull.headSha });
          this.merged.set(record.id, { pull, forge });
        }
        return { kind: "gone" };
      }
      change = await this.readyPrerequisite(taskId, forge, change);
      const checks = await forge.checks(change);
      const main = await this.mainEvidence(record, forge, change, checks);
      this.assertCheckTarget(record);
      const observationId = this.observeChecks(taskId, change.headSha, checks, false);
      const words = changeWords(forge, change);
      if (checks.problem) {
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
        return { kind: "failed", transient: false, problem: checks.problem, observationId };
      }
      if (this.checksPending(record, { change, forge }, checks)) {
        this.record(
          record.id,
          "pending",
          { change, forge },
          "watch",
          true,
          checks.items,
          checks.complete,
          checks.problem,
          main,
        );
        const failing = named(checks.items.filter((check) => isRedCheckState(check.state)));
        return {
          kind: "pending",
          observationId,
          head: change.headSha,
          change: words,
          pending: named(checks.items.filter((check) => check.state === "pending")),
          ...(failing.length > 0 ? { failing } : {}),
        };
      }
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
          problem: crewSignInText(this.signInFact(forge, record.repoId)),
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
        at: this.now(),
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

  /**
   * The crewmate's open_change (git integration PR 1.2): offer the task's
   * branch as a proposed change where the project lives - a pull request
   * on GitHub (the crewmate has pushed the branch), the branch sent up on a
   * plain host (the forge pushes it). A change already open for the branch
   * is answered, not opened twice, and a body replaces its description when
   * that is not a saved story (`redescribe`). Recorded like a reading's change:
   * `pr_opened` on the timeline, the label and link on the delivery facts.
   */
  async preparePresentation(taskId: string, staged: StagedChangePresentation): Promise<string> {
    try {
      const local = this.localStoryDestination(taskId);
      if (local) {
        if (!this.options.presentations) return "Saved change stories are unavailable.";
        const revision = await this.options.presentations.prepare(taskId, staged, local);
        return `Prepared presentation ${revision} for ${staged.head}. Nothing was uploaded and no card was shown. This work merges locally: pass presentation: ${revision} to emit_card; no open_change or host sign-in is needed.`;
      }
      const located = this.locate(taskId, "open");
      if ("said" in located) return located.said;
      if (!this.options.presentations) return "Saved change stories are unavailable.";
      try {
        // Only a pull request still open for the branch predates saved stories;
        // a recorded one that has closed is forgotten, as for any new task.
        if (
          !located.record.delivery?.presentation &&
          hasChangeRequests(located.forge.kind) &&
          (await located.forge.changeFor(located.branch))
        )
          return "This pull request predates saved stories and will not be rewritten into one. To replace its description, pass body to open_change.";
        const merged = await this.mergedBeforeStories(located.record, located.forge);
        if (merged) return merged;
        const revision = await this.options.presentations.prepare(taskId, staged, located.forge);
        const destination = this.options.tasks
          .changePresentation(taskId)
          ?.revisions.find((saved) => saved.revision === revision)?.destination;
        return `Prepared presentation ${revision} for ${staged.head}. ${destination ? `${storyAudience(destination)} ` : ""}No file was uploaded and no card was shown. Pass presentation: ${revision} to open_change after review and pushing; pass the same current published revision to emit_card after checks pass.`;
      } catch (caught) {
        if (isSignInForgeFailure(caught))
          return crewSignInText(this.signInFact(located.forge, located.record.repoId));
        return `Could not prepare the change story: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
    } catch (caught) {
      return `Could not prepare the change story: ${caught instanceof Error ? caught.message : String(caught)}`;
    } finally {
      await this.options.presentations?.discardStaged(taskId, staged);
    }
  }

  /**
   * The pull request a task recorded before saved stories, merged outside the
   * app: nothing more is opened for it, as for a merged published story. One
   * closed without merging is forgotten and the task starts a story.
   */
  private async mergedBeforeStories(
    record: {
      delivery?: {
        prNumber?: number;
        presentation?: { published?: unknown; reconciled?: unknown };
      } | null;
    },
    forge: Forge,
  ): Promise<string | undefined> {
    const story = record.delivery?.presentation;
    // Once a story is published or reconciled, #N is the story's own pull
    // request and its own stops decide. A failed read reaches the caller's
    // catch, so the check fails closed.
    if (story?.published || story?.reconciled) return undefined;
    const number = record.delivery?.prNumber;
    if (number === undefined) return undefined;
    const pull = await this.pullOf(forge, number);
    return pull.merged
      ? `${numberLabel(forge, pull.number)} was merged outside the app. Nothing more is opened for it; close this task or start a new one.`
      : undefined;
  }

  async presentationHead(taskId: string): Promise<string> {
    const record = this.options.tasks.get(taskId);
    if (!record?.branch) throw new Error("The task has no committed branch.");
    let dir = record.worktreeDir;
    if (record.deviceId) {
      dir = (await this.options.bringBranchHome?.(taskId, true)) ?? "";
    } else if (dir && (await git(dir, ["status", "--porcelain", "--untracked-files=no"])).trim()) {
      throw new Error(
        "Commit the task's changes before preparing or publishing its demonstrated version.",
      );
    }
    if (!dir) throw new Error("The current code version is unavailable.");
    return git(dir, ["rev-parse", `${record.branch}^{commit}`]);
  }

  /** Delivery, not the presence of an origin, decides whether a story reaches a host. */
  private localStoryDestination(taskId: string): LocalPresentationDestination | undefined {
    const record = this.options.tasks.get(taskId);
    if (!record) throw new Error("The task no longer exists.");
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    if (record.repoId && !repo) throw new Error("The task's project is no longer registered.");
    if (deliveryForRecord(record, repo?.delivery) !== "local-only") return undefined;
    return { kind: "local", project: record.repoId ?? record.repoDir };
  }

  async validateLocalStory(taskId: string): Promise<string> {
    const destination = this.localStoryDestination(taskId);
    if (!destination || !this.options.presentations)
      throw new Error("The local story cannot be checked.");
    const head = await this.presentationHead(taskId);
    if (overridePasses(this.options.tasks.get(taskId)?.delivery, "story", head)) return head;
    return this.options.presentations.assertLocal(taskId, destination);
  }

  async completionPresentation(taskId: string, revision: number) {
    if (this.localStoryDestination(taskId)) {
      if (!this.options.presentations) throw new Error("Saved change stories are unavailable.");
      const head = await this.validateLocalStory(taskId);
      return this.options.presentations.completion(taskId, revision, head);
    }
    const located = this.locate(taskId, "open");
    if ("said" in located) throw new Error(located.said);
    if (!this.options.presentations) throw new Error("Saved change stories are unavailable.");
    const change = await located.forge.changeFor(located.branch);
    if (!change) throw new Error("The story's pull request is not open.");
    await this.options.presentations.assertPublished(taskId, change, located.forge, revision);
    return this.options.presentations.completion(taskId, revision, change.headSha);
  }

  async open(taskId: string, input: OpenChangeInput): Promise<string> {
    const located = this.locate(taskId, "open");
    if ("said" in located) return located.said;
    const { record, branch, forge } = located;
    if (input.repository !== undefined) {
      const refused = this.foreignRepository(record, input.repository);
      if (refused) return refused;
    }
    try {
      requireConventional(input.title, "pull request title", this.options.namingRule?.());
      this.options.tasks.recordPermissionRecords(taskId, { checkTarget: undefined });
      await this.branchHome(record);
      const dir = await this.validateRange(record.repoId, record.repoDir, branch, forge);
      const existing = await forge.changeFor(branch);
      if (existing && hasChangeRequests(forge.kind))
        requireConventional(
          changeTitle(forge.kind, existing) ?? "",
          "existing pull request title",
          this.options.namingRule?.(),
        );
      const current = this.options.tasks.get(taskId);
      const policy =
        current &&
        effectiveTaskPolicies(
          current,
          current.repoId ? this.options.repos.get(current.repoId) : undefined,
        );
      if (!current || !policy || policy.delivery.value !== "direct-pr")
        return "Cannot open the change: its delivery policy changed. Read the current task record.";
      let prerequisite: string | undefined;
      let validationHead: string | undefined;
      if (
        !existing &&
        current.delivery?.liveValidation?.permissions.some(
          (item) =>
            item.request.kind === "effect" &&
            item.request.prerequisitePublication &&
            item.request.publication?.repoId === current.repoId &&
            item.request.publication.branch === branch &&
            (item.state === "started" || item.state === "unknown"),
        )
      )
        return "The earlier prerequisite publication has an unknown outcome. Reconcile it before another publication; a missing result does not prove it failed.";
      // A task with a review or a live-validation record carries it to the
      // version being opened, at any care: the care's name holds nothing
      // here, and a task with neither record has nothing to read. The
      // version is read where the range was checked: the project's folder,
      // where a branch from another computer came home.
      if (current.delivery?.reviewVerdict || current.delivery?.liveValidation) {
        const head = existing?.headSha ?? (await git(dir, ["rev-parse", branch]));
        await carryPassedReview({
          tasks: this.options.tasks,
          taskId,
          record: current,
          repoDir: dir,
          head,
        });
        validationHead = head;
        this.options.tasks.recordChangeEvidence(taskId, { validationHead: head });
        const early =
          earlyPublication(current.delivery?.liveValidation, head, Boolean(existing)) ??
          (existing
            ? current.delivery?.liveValidation?.permissions.find(
                (item) =>
                  item.request.kind === "effect" &&
                  item.request.prerequisitePublication &&
                  item.request.head === head &&
                  item.request.publication?.repoId === current.repoId &&
                  item.request.publication.branch === branch &&
                  ["started", "unknown", "succeeded"].includes(item.state),
              )
            : undefined);
        if (
          early?.request.kind === "effect" &&
          early.request.publication?.repoId === current.repoId &&
          early.request.publication.branch === branch
        )
          prerequisite = early.request.id;
      }
      const presentations = this.options.presentations;
      if (!existing && presentations && hasChangeRequests(forge.kind)) {
        const merged = await this.mergedBeforeStories(current, forge);
        if (merged) return merged;
      }
      // The captain's override on the saved story lets this task open its
      // pull request with a body; the default stays as he chose.
      const storyPassed =
        input.presentation === undefined &&
        current.delivery?.override?.holds.includes("story") === true &&
        overridePasses(
          current.delivery,
          "story",
          existing?.headSha ?? (await git(dir, ["rev-parse", branch])),
        );
      const usesStory =
        presentations &&
        (forge.storyDestination || forge.attachments) &&
        (!hasChangeRequests(forge.kind) || !existing || current.delivery?.presentation) &&
        !storyPassed;
      if (usesStory && (input.presentation === undefined || input.body !== undefined))
        return `Prepare the current change story with prepare_change, then pass its presentation revision, not body. Native media hosts confirm every selected attachment before publication; other description hosts receive text only. A plain branch keeps its story on the completion card. To change only the words around a published story, pass around. ${softHoldWords("story", "crewmate")}`;
      if (!usesStory && input.presentation !== undefined)
        return "This host or existing pull request does not use saved change stories. Keep its existing delivery.";
      if (!usesStory && input.around !== undefined)
        return "This pull request does not carry a saved story, so around has nothing to keep; pass body to replace its description.";
      if (
        input.around &&
        presentationLines(input.around.from) === presentationLines(input.around.to)
      )
        return "Nothing was sent: around.to is the same as around.from.";
      if (!usesStory && !existing && input.body === undefined)
        return "The pull request description is missing.";
      const beginPublication = (head: string) => {
        if (!validationHead || (prerequisite && existing)) return;
        const latest = this.options.tasks.get(taskId);
        if (
          head !== validationHead ||
          latest?.repoId !== current.repoId ||
          latest.branch !== branch
        )
          throw new Error(
            "The publication changed; nothing was sent. Read its current version and permission.",
          );
        if (!prerequisite) return;
        // The transition rechecks the current approval, code clearance and
        // scenario. For saved stories this runs after their preflight, before
        // any attachment leaves the computer, not before a possibly long read.
        this.options.tasks.recordLiveValidation(
          taskId,
          {
            kind: "effect-state",
            request: prerequisite,
            state: "started",
            evidence: "The approved prerequisite draft publication passed its execution gate.",
          },
          { head },
        );
        this.options.tasks.recordLiveValidation(
          taskId,
          {
            kind: "effect-state",
            request: prerequisite,
            state: "unknown",
            evidence:
              "The approved prerequisite publication is being sent; read the host before any repeat.",
          },
          { head },
        );
      };
      let change: ForgeChange;
      let described = "";
      if (usesStory) {
        change = await presentations.publish(
          taskId,
          input.presentation as number,
          forge,
          branch,
          input.title,
          current.delivery?.ci === "green" && current.delivery.headSha === existing?.headSha
            ? "passed"
            : "pending",
          input.recovery,
          input.around,
          {
            ...(validationHead
              ? {
                  beforePublish: beginPublication,
                  attests: this.attestsAt(taskId),
                  ...(prerequisite && !existing ? { draft: hasChangeRequests(forge.kind) } : {}),
                }
              : {}),
            ...(input.base ? { base: input.base } : {}),
          },
        );
        const place = forge.place ?? "the project's host";
        // INF-717: a renamed change says its new title, the story's.
        const renamed =
          existing && changeTitle(forge.kind, change) !== changeTitle(forge.kind, existing);
        described = [
          input.around
            ? `Changed the words around the story: ${place} shows them, and the story is as published.`
            : "",
          renamed ? `Its title now reads "${changeTitle(forge.kind, change)}", the story's.` : "",
        ]
          .filter(Boolean)
          .join(" ");
      } else if (existing) {
        ({ change, said: described } = await this.redescribe(forge, branch, existing, input));
      } else {
        beginPublication(validationHead ?? "");
        change = await forge.openChange({
          branch,
          title: input.title,
          body: input.body ?? "",
          ...(input.base ? { base: input.base } : {}),
          ...(prerequisite && hasChangeRequests(forge.kind) ? { draft: true } : {}),
        });
        if (!hasChangeRequests(forge.kind)) described = keepsNoDescription(forge);
      }
      if (
        prerequisite &&
        ["started", "unknown"].includes(
          this.options.tasks
            .get(taskId)
            ?.delivery?.liveValidation?.permissions.find((item) => item.request.id === prerequisite)
            ?.state ?? "",
        )
      )
        this.options.tasks.recordLiveValidation(
          taskId,
          {
            kind: "effect-state",
            request: prerequisite,
            state: "succeeded",
            evidence: `The host confirmed ${changeWords(forge, change)}.`,
          },
          { head: validationHead ?? "" },
        );
      change = await this.readyPrerequisite(record.id, forge, change);
      this.noteChange(record.id, { change, forge });
      const next = [
        "Read its checks with check_change. If the rest of your work needs this merged first, file it as Continue: … and end this task with the completion decision after the checks pass.",
        this.readinessProblem(taskId, change),
      ]
        .filter(Boolean)
        .join(" ");
      const said = described ? ` ${described}` : "";
      return existing
        ? `A pull request for ${branch} is already open: ${changeWords(forge, change)}.${said} ${next}`
        : `Opened ${changeWords(forge, change)} for ${branch}.${said} ${next}`;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (isSignInForgeFailure(caught)) {
        return crewSignInText(this.signInFact(forge, record.repoId));
      }
      // An evidence upload says what stopped it; the branch is already pushed (INF-290 F4).
      // A permission refusal keeps the write-access note and blocker words below (INF-290 G1).
      if (caught instanceof AttachmentUploadError && caught.failure !== "permission")
        return message;
      // INF-497: nothing was sent, or what the host shows; the words carry the current text.
      if (caught instanceof PresentationAroundError) return message;
      const place = forge.place ?? "the project's host";
      if (caught instanceof ForgeError && caught.failure === "permission") {
        const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
        this.options.onNote?.(
          `${place} did not allow the change on ${repo?.name ?? record.title} - ask its owner for write access.`,
          record.id,
        );
        return `${place} did not allow opening the change: ${message}. Report this as a blocker: the captain needs write access to the project there.`;
      }
      if (caught instanceof ForgeError && caught.failure === "refused") {
        return `${place} refused to open the change: ${message}. Push your branch first (git push) if you have not, then call open_change again.`;
      }
      return `Could not open the pull request: ${message}`;
    }
  }

  /**
   * An open change whose description is the crewmate's own words, not a
   * saved story (INF-291): a body replaces it whole through the forge's
   * conditional write, and the answer says what the host shows when read
   * back, never only that the change exists. A refused or uncertain write,
   * or a read-back that differs, is said as such; nothing is sent again.
   */
  private async redescribe(
    forge: Forge,
    branch: string,
    existing: ForgeChange,
    input: OpenChangeInput,
  ): Promise<{ change: ForgeChange; said: string }> {
    const { body } = input;
    // A title is never renamed here; say so rather than drop it quietly.
    const titled =
      existing.title !== undefined && existing.title !== input.title
        ? ` Its title stays "${existing.title}".`
        : "";
    const place = forge.place ?? "the project's host";
    const readBack = "Read it with github_read before calling open_change again.";
    if (!hasChangeRequests(forge.kind))
      return { change: existing, said: body === undefined ? "" : keepsNoDescription(forge) };
    if (body === undefined)
      return {
        change: existing,
        said: `Its description is unchanged; pass body to replace it.${titled}`,
      };
    if (sameDescription(existing.body, body))
      return {
        change: existing,
        said: `${place} already shows this description; nothing was sent.${titled}`,
      };
    if (!forge.updateChangeBody)
      return {
        change: existing,
        said: `Its description was not replaced: ${place} offers no way to replace it here.`,
      };
    try {
      await forge.updateChangeBody(existing, body);
    } catch (caught) {
      // A missing sign-in or write access keeps the blocker words open_change already gives.
      const denied =
        isSignInForgeFailure(caught) ||
        (caught instanceof ForgeError && caught.failure === "permission");
      if (!(caught instanceof ForgeWriteError) || denied) throw caught;
      return {
        change: existing,
        said:
          caught.outcome === "failed"
            ? `Its description was not replaced: ${caught.message}`
            : `Its description may or may not have been replaced: ${caught.message} ${readBack}`,
      };
    }
    let read: ForgeChange | null;
    try {
      read = await forge.changeFor(branch);
    } catch (caught) {
      if (isSignInForgeFailure(caught)) throw caught;
      const why = caught instanceof Error ? caught.message : String(caught);
      return {
        change: existing,
        said: `Sent the new description, but could not read it back: ${why}. ${readBack}`,
      };
    }
    if (read && read.number === existing.number && sameDescription(read.body, body))
      return {
        change: read,
        said: `Replaced its description: ${place} now shows the ${body.length}-character body you passed, at version ${read.headSha.slice(0, 7)}.${titled}`,
      };
    return {
      change: read ?? existing,
      said: `Sent the new description, but ${place} shows different words; someone may have edited it at the same time. ${readBack}`,
    };
  }

  /** Only a task-owned prerequisite draft graduates automatically after final proof and review. */
  private async readyPrerequisite(
    taskId: string,
    forge: Forge,
    change: ForgeChange,
  ): Promise<ForgeChange> {
    if (change.number === undefined || this.readinessInFlight.has(taskId)) return change;
    this.readinessInFlight.add(taskId);
    const allowed = () => {
      const task = this.options.tasks.get(taskId);
      return (
        task?.branch === change.branch &&
        reviewCoversHead(task.delivery, change.headSha) &&
        acceptedValidation(task.delivery?.liveValidation, change.headSha).ready &&
        task.delivery?.liveValidation?.permissions.some(
          (item) =>
            item.state === "succeeded" &&
            item.request.kind === "effect" &&
            item.request.prerequisitePublication &&
            item.request.publication?.repoId === task.repoId &&
            item.request.publication.branch === change.branch,
        )
      );
    };
    try {
      const readiness = this.options.tasks.get(taskId)?.delivery?.validationReadiness;
      // A person may restore draft after readiness applied. That holds this version;
      // only a newer version may graduate again with its own current proof and review.
      if (
        readiness?.state === "ready" &&
        readiness.number === change.number &&
        readiness.head === change.headSha
      )
        return change;
      if (readiness?.state === "unknown" && readiness.number === change.number && change.draft) {
        // Read after the earlier attempt settled locally, not an overlapping caller's old snapshot.
        const current = await forge.changeFor(change.branch);
        if (!current || current.number !== change.number || current.branch !== change.branch)
          throw new ForgeError(
            "refused",
            "The earlier draft-readiness request cannot be reconciled with this change.",
          );
        change = current;
        if (change.draft)
          this.options.tasks.recordChangeEvidence(
            taskId,
            {
              validationReadiness: {
                head: change.headSha,
                number: readiness.number,
                state: "not-applied",
              },
            },
            {
              kind: "note",
              text: "The host still reports a draft; the earlier readiness request did not apply.",
            },
          );
      }
      if (!change.draft) {
        if (readiness && readiness.number === change.number)
          this.options.tasks.recordChangeEvidence(taskId, {
            validationReadiness: { head: change.headSha, number: readiness.number, state: "ready" },
          });
        return change;
      }
      if (!allowed()) return change;
      if (!forge.markReady)
        throw new ForgeError("unsupported", "This host cannot mark the prerequisite draft ready.");
      if (
        !this.options.verifyValidationEvidence &&
        this.options.tasks.get(taskId)?.delivery?.liveValidation?.runs.at(-1)?.evidence.length
      )
        throw new ForgeError("refused", "Kept proof cannot be verified here.");
      const ready = await forge.markReady(change, () => {
        if (!allowed())
          throw new ForgeError(
            "refused",
            "Validation changed; the prerequisite draft stays held until review.",
          );
        this.options.verifyValidationEvidence?.(taskId);
        this.options.tasks.recordChangeEvidence(taskId, {
          validationReadiness: { head: change.headSha, number: change.number!, state: "unknown" },
        });
      });
      this.options.tasks.recordChangeEvidence(taskId, {
        validationReadiness: { head: ready.headSha, number: ready.number!, state: "ready" },
      });
      return ready;
    } catch (caught) {
      const previous = this.options.tasks.get(taskId)?.delivery?.validationReadiness;
      const problem = caught instanceof Error ? caught.message : String(caught);
      // Readiness is delivery bookkeeping, never a replacement for the host's check reading.
      this.options.tasks.recordChangeEvidence(
        taskId,
        {
          validationReadiness: {
            ...(previous && previous.number === change.number
              ? previous
              : {
                  head: change.headSha,
                  number: change.number!,
                  state: "not-applied" as const,
                }),
            problem,
          },
        },
        previous?.problem === problem
          ? undefined
          : {
              kind: "note",
              text: `Draft readiness is held: ${problem}`,
            },
      );
      return change;
    } finally {
      this.readinessInFlight.delete(taskId);
    }
  }

  private readinessProblem(taskId: string, change: ForgeChange): string {
    const readiness = this.options.tasks.get(taskId)?.delivery?.validationReadiness;
    return readiness && readiness.number === change.number && readiness.problem
      ? `Draft readiness is held: ${readiness.problem}`
      : "";
  }

  /** A placed task's branch, brought here before this Mac's git reads it. */
  private async branchHome(record: { id: string; deviceId?: string | null }): Promise<void> {
    if (record.deviceId) await this.options.bringBranchHome?.(record.id);
  }

  /** Checks the branch's own commit names in the project's folder, and answers that folder. */
  private async validateRange(
    repoId: string | null | undefined,
    repoDir: string | null | undefined,
    branch: string,
    forge: Forge,
    head = branch,
  ): Promise<string> {
    const repo = repoId ? this.options.repos.get(repoId) : undefined;
    const dir = repo?.path ?? repoDir;
    if (!dir) throw new Error("The project folder is unavailable.");
    if (this.options.validateRange) {
      await this.options.validateRange(dir, branch, forge, head);
      return dir;
    }
    // Measure from the fetched default branch: the task branch starts there
    // (dispatchBase), and the local one lags whenever this Mac has not
    // pulled, which would count merged commits as the branch's own.
    const name = await forge.defaultBranch();
    const fetched = `refs/remotes/origin/${name}`;
    const target = (await git(dir, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${fetched}^{commit}`,
    ]).catch(() => ""))
      ? fetched
      : name;
    const base = await git(dir, ["merge-base", head, target]);
    await requireConventionalRange(dir, base, head, this.options.namingRule?.());
    return dir;
  }

  private signInFact(forge: Forge, repoId: string | null | undefined): SignInFact {
    return {
      host: forge.host ?? "github.com",
      name: forge.place ?? forge.host ?? "the project's host",
      ...(repoId ? { repoId } : {}),
    };
  }

  /**
   * The task's direct-pr repository and the forge where it lives, or the
   * tool text that says why there is nothing to ask.
   */
  private locate(
    taskId: string,
    purpose: "check" | "open" = "check",
  ):
    | { said: string }
    | { record: NonNullable<ReturnType<TaskService["get"]>>; branch: string; forge: Forge } {
    const record = this.options.tasks.get(taskId.trim());
    if (!record) return { said: `Unknown task "${taskId}". Use a task id from crew_status.` };
    if (!record.branch) {
      return {
        said: `Task ${record.id} has no branch yet (still queued); there is no PR to check.`,
      };
    }
    const repo: RepoView | undefined = record.repoId
      ? this.options.repos.get(record.repoId)
      : undefined;
    if (record.repoId && !repo) {
      return { said: `Task ${record.id}'s repository is no longer registered; cannot check CI.` };
    }
    const delivery = deliveryForRecord(record, repo?.delivery);
    if (delivery !== "direct-pr") {
      return {
        said:
          purpose === "open"
            ? `Task ${record.id} ships ${delivery}; its work merges locally, so there is no pull request to open.`
            : `Task ${record.id} ships ${delivery}; its work never has a PR, so there is no CI to check.`,
      };
    }
    const dir = repo?.path ?? record.repoDir;
    if (!dir || !existsSync(dir)) {
      return { said: `Task ${record.id}'s working directory is gone; cannot check CI.` };
    }
    return { record, branch: record.branch, forge: this.options.forgeFor(repo, dir) };
  }

  /**
   * open_change names the project the change opens on (INF-1873): the task's
   * own, by its name, id, owner/name or origin where it lives. A task's
   * change opens on no other project, so any other name is refused in words.
   */
  private foreignRepository(record: TaskRecord, repository: string): string | undefined {
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
    const origin = forgeOf(repo?.origin);
    const full = origin.owner && origin.name ? `${origin.owner}/${origin.name}` : undefined;
    const asked = repository.trim().toLowerCase();
    const names = [repo?.id, repo?.name, full, repo?.origin]
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase());
    if (names.includes(asked)) return undefined;
    return `Cannot open the change on "${repository}": this task works in ${repo?.name ?? "its own project"}${full ? ` (${full})` : ""}, and a task's change opens only there. Name that project, or leave repository out.`;
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
  ): Promise<ForgeChange | null> {
    const target = record.delivery?.checkTarget;
    if (!target) return forge.changeFor(branch);
    const repo = record.repoId ? this.options.repos.get(record.repoId) : undefined;
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

  private async run(taskId: string, audience: Audience = "firstmate"): Promise<CheckRun> {
    const located = this.locate(taskId);
    if ("said" in located) return { text: located.said, recorded: false };
    const { record, forge } = located;
    const branch = record.delivery?.checkTarget?.branch ?? located.branch;
    try {
      let change = await this.checkChange(record, branch, forge);
      if (!change) {
        // The pull request the task names may have been merged or closed
        // outside the app: read it by its number, never guessed from its
        // absence among the open ones (FI3-213).
        const pull = await this.namedPull(
          forge,
          record.delivery?.checkTarget?.number ?? record.delivery?.prNumber,
        );
        this.assertCheckTarget(record);
        if (pull?.merged) {
          this.record(record.id, "merged");
          this.options.tasks.recordChangeEvidence(record.id, { headSha: pull.headSha });
          this.merged.set(record.id, { pull, forge });
          return { text: mergedWords(forge, pull, audience), recorded: true };
        }
        this.assertCheckTarget(record);
        this.record(record.id, "no-pr");
        return {
          text: hasChangeRequests(forge.kind)
            ? `overall: no-pr\nNo open PR found for branch ${branch}.${pull ? ` ${numberLabel(forge, pull.number)} was closed without merging.` : ""}`
            : `overall: no-pr\nNothing pushed for branch ${branch}${forge.place ? ` on ${forge.place}` : ""} yet.`,
          recorded: true,
        };
      }
      change = await this.readyPrerequisite(taskId, forge, change);
      const checks = await forge.checks(change);
      const main = await this.mainEvidence(record, forge, change, checks);
      const mergeability =
        change.number !== undefined && forge.pull ? await forge.pull(change.number) : undefined;
      this.assertCheckTarget(record);
      this.observeChecks(taskId, change.headSha, checks, audience === "crewmate");
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
      return {
        text: [
          `${changeWords(forge, change)} head ${change.headSha}`,
          `facts: ${JSON.stringify({
            change: {
              id: this.options.tasks.changeFor(record.id)?.id ?? null,
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
          ...(this.readinessProblem(taskId, change) ? [this.readinessProblem(taskId, change)] : []),
          ...(checks.items.length > 0 ? lines : ["- no checks reported on the head SHA"]),

          ...watchWords(forge, audience, watched, earlyOwed),
        ].join("\n"),
        recorded: true,
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return {
        text: `Could not check CI for task ${record.id}: ${message}`,
        recorded: false,
        problem: message,
        transient: isTransientForgeFailure(caught),
        ...(isSignInForgeFailure(caught) ? { signIn: this.signInFact(forge, record.repoId) } : {}),
      };
    }
  }

  /**
   * Put the task's change in where the project lives. Re-check the complete
   * head check suite at the moment of the click, then ask the forge to put
   * in that exact change at that exact head: an explicit squash with the
   * checked title on GitHub, a fast-forward on a plain Git host.
   *
   * A network/host hiccup on either the recheck or the put-in itself is not
   * a verdict about the change - it is retried a couple of times with a
   * short backoff before giving up. A durable refusal (checks actually
   * failed, a stale head, branch protection) is never retried here: it
   * returns straight away so the captain's own retry - after fixing
   * whatever is wrong - is the one that runs next.
   */
  async merge(taskId: string, guard?: MergeGuard, boundary?: MergeBoundary): Promise<PrOutcome> {
    let attempt: PrOutcome & { transient?: boolean; dispatched?: boolean } = {
      ok: false,
      text: "",
    };
    for (let i = 0; i < MERGE_RETRY_DELAYS_MS.length + 1; i++) {
      attempt = await this.mergeOnce(taskId, guard, boundary);
      if (attempt.ok || !attempt.transient) break;
      // A request that went out and whose answer never came may have merged:
      // read the pull request back before anything is sent again (FI3-304).
      if (guard && attempt.dispatched) {
        const after = await this.readBack(taskId, guard);
        if (after.merged) return after.merged;
        if (after.closed) return after.closed;
        if (after.open !== true) {
          return { ...stripAttempt(attempt), stop: after.open === false ? "moved" : "outcome" };
        }
      }
      const delay = MERGE_RETRY_DELAYS_MS[i];
      if (delay === undefined) break;
      await sleep(delay);
    }
    const outcome = stripAttempt(attempt);
    if (guard && !outcome.ok && attempt.transient && !outcome.stop) {
      return { ...outcome, stop: attempt.dispatched ? "outcome" : "transient" };
    }
    return outcome;
  }

  private async mergeOnce(
    taskId: string,
    guard?: MergeGuard,
    boundary?: MergeBoundary,
  ): Promise<PrOutcome & { transient?: boolean; dispatched?: boolean }> {
    // A stale earlier success must never survive a failed re-check.
    this.checked.delete(taskId);
    if (this.options.tasks.get(taskId)?.delivery?.checkTarget) {
      return {
        ok: false,
        stop: "identity",
        text: "Cannot settle a referenced pull request. Use its request_merge review; the task's own branch remains separate.",
      };
    }
    const status = await this.run(taskId);
    const reading = this.reading(taskId);
    const checked = this.checked.get(taskId);
    if (status.problem) {
      return {
        ok: false,
        text: `Cannot merge yet - the checks could not be read. ${status.text}`,
        problem: status.problem,
        ...(status.transient ? { transient: true } : {}),
        ...(status.signIn ? { signIn: status.signIn } : {}),
        ...(guard && status.signIn ? { stop: "sign-in" as const } : {}),
      };
    }
    // The pull request the task names was merged outside the app: nothing
    // is sent, and the merge is the one already made (FI3-213).
    const merged = this.merged.get(taskId);
    if (reading?.overall === "merged" && merged) return alreadyMerged(merged.forge, merged.pull);
    // The approval pins one pull request: no open one for the branch is
    // read back by its number, merged or closed, never taken as either.
    if (guard && reading?.overall === "no-pr") {
      const after = await this.readBack(taskId, guard);
      if (after.merged) return after.merged;
      if (after.closed) return after.closed;
    }
    if (guard && checked) {
      if (checked.change.number !== guard.prNumber) {
        return {
          ok: false,
          text: `Cannot merge: the branch's open pull request is ${checked.forge.label(checked.change)}, not the ${numberLabel(checked.forge, guard.prNumber)} the captain approved.`,
          plain: "its pull request is not the one you approved",
          stop: "identity",
        };
      }
      if (checked.change.headSha !== guard.head) {
        return {
          ok: false,
          text: `Cannot merge yet: the pull request is at ${checked.change.headSha}, and the captain's approval covers ${guard.head}. A repair of the approved change is declared with check_change conflictRepair.`,
          plain: "it changed after the version you approved",
          stop: "moved",
        };
      }
    }
    // Actual check results are a soft hold: the captain's override on
    // the checks passes them at the version it covers. GitHub's own rules
    // still decide whether it merges.
    const unfinished = reading?.overall === "red" || reading?.overall === "pending";
    const checksPassed =
      unfinished &&
      status.recorded &&
      checked !== undefined &&
      overridePasses(this.options.tasks.get(taskId)?.delivery, "checks", checked.change.headSha);
    if (!checked || (!checksPassed && (!status.recorded || reading?.overall !== "green"))) {
      const problem = this.options.tasks.get(taskId)?.delivery?.checks?.problem;
      const reason = problem
        ? `the checks cannot be read: ${problem}`
        : reading?.overall === "red"
          ? "the checks failed"
          : reading?.overall === "no-pr"
            ? "no open pull request was found for it"
            : MERGE_CHECKS_HOLD_REASON;
      return {
        ok: false,
        text: `Cannot merge yet - ${reason}. ${status.text}${unfinished ? ` ${softHoldWords("checks", "firstmate")}` : ""}`,
        notGreen: true,
        ...(guard ? { stop: "checks" as const } : {}),
        plain: reason,
      };
    }
    const { change, forge } = checked;
    let dispatched = false;
    try {
      const record = this.options.tasks.get(taskId);
      if (record && !record.delivery?.presentation) await this.branchHome(record);
      const dir = await this.validateRange(
        record?.repoId,
        record?.repoDir,
        change.branch,
        forge,
        change.headSha,
      );
      if (hasChangeRequests(forge.kind))
        requireConventional(change.title ?? "", "pull request title", this.options.namingRule?.());
      const fresh = this.options.tasks.get(taskId) ?? record;
      if (fresh) {
        await carryPassedReview({
          tasks: this.options.tasks,
          taskId,
          record: fresh,
          repoDir: dir,
          head: change.headSha,
        });
      }
      // A merge the host runs on the captain's kept approval goes only where
      // the host itself says the change may merge now: the app never leans on
      // a sign-in that could bypass the branch's rules (FI3-304 section 4).
      // Guidance is read after the carry, so a newer word during that wait
      // still stops the merge.
      if (hasChangeRequests(forge.kind) && (guard?.unattended || boundary?.unattended)) {
        if (change.number === undefined)
          return { ok: false, text: "Cannot merge: the pull request identity is missing." };
        const pull = await this.pullOf(forge, guard?.prNumber ?? change.number);
        const held = readinessStop(forge, pull, { head: guard?.head ?? change.headSha });
        if (held) return held;
      }
      let publishedChange = change;
      // INF-1365: the captain's override on the saved story passes its publication at this
      // version: nothing is marked published, uploaded or refreshed, and the squash carries the
      // description's own words, not an older story's. It is read after the last wait before the
      // send, so a withdrawn override holds this merge. Every other check above still applies.
      const storyPassed =
        record?.delivery?.presentation !== undefined &&
        overridePasses(this.options.tasks.get(taskId)?.delivery, "story", change.headSha);
      if (storyPassed) {
        publishedChange = {
          ...change,
          squashMessage: messageWithoutPresentation(change.body ?? "", taskId),
        };
      } else if (record?.delivery?.presentation) {
        if (!this.options.presentations)
          throw new Error("The current story cannot be checked for complete evidence.");
        const authorization = standingAuthorization(record.delivery);
        const publishedHead = record.delivery.presentation.published?.head;
        if (guard && authorization) {
          const offered = record.delivery.completionOffers?.find(
            (offer) =>
              offer.cardId === authorization.card.id &&
              offer.offerId === authorization.card.offerId,
          );
          if (
            !offered?.presentationContentHash ||
            offered.presentationContentHash !== record.delivery.presentation.published?.contentHash
          )
            throw new Error(
              "The published story differs from the approved story. Show a new completion offer before merging.",
            );
        }
        const beforeRefresh = guard?.held?.();
        if (beforeRefresh)
          return { ok: false, text: `Cannot merge yet: ${beforeRefresh}.`, stop: "guidance" };
        if (
          guard &&
          authorization &&
          candidateHead(authorization) === change.headSha &&
          publishedHead &&
          publishedHead !== change.headSha &&
          authorization.lineage.length > 0 &&
          (publishedHead === authorization.approvedHead ||
            authorization.lineage.some((step) => step.toHead === publishedHead))
        ) {
          await this.options.presentations.refreshConflictOnly(
            taskId,
            publishedHead,
            change.headSha,
            forge,
            change.branch,
            change.title ?? "",
            this.attestsAt(taskId),
          );
          const refreshed = await forge.changeFor(change.branch);
          if (
            !refreshed ||
            refreshed.number !== change.number ||
            refreshed.headSha !== change.headSha
          )
            throw new Error("The pull request changed during the story refresh.");
          publishedChange = refreshed;
        }
        publishedChange = await this.options.presentations
          .assertPublished(taskId, publishedChange, forge)
          .catch(storyHeld);
      }
      const held = guard?.held?.();
      if (held) return { ok: false, text: `Cannot merge yet: ${held}.`, stop: "guidance" };
      const withdrawn =
        guard?.beforeDispatch(change.headSha) ?? boundary?.beforeDispatch(change.headSha);
      if (withdrawn) {
        return {
          ok: false,
          text: `Cannot merge: ${withdrawn}${withdrawn.endsWith(".") ? "" : "."}`,
          stop: "withdrawn",
        };
      }
      dispatched = true;
      const receipt = await forge.putIn(publishedChange, publishedChange.headSha);
      return {
        ok: true,
        ...this.putInText(taskId, forge, change),
        ...(guard
          ? { receipt: { head: change.headSha, ...(receipt?.sha ? { sha: receipt.sha } : {}) } }
          : {}),
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const repoId = this.options.tasks.get(taskId)?.repoId;
      const stop = guard ? await this.refusalStop(forge, guard, caught, message) : undefined;
      return {
        ok: false,
        text: `Cannot merge: ${message}`,
        problem: message,
        ...(isTransientForgeFailure(caught) ? { transient: true } : {}),
        ...(dispatched ? { dispatched: true } : {}),
        ...(stop ? { stop } : {}),
        ...(isSignInForgeFailure(caught) ? { signIn: this.signInFact(forge, repoId) } : {}),
      };
    }
  }

  /**
   * The pinned pull request read by its number (FI3-304): what a kept
   * approval's reconcile asks after a restart or an answer that never came.
   * Undefined where the host has no pull requests or the task no change.
   */
  async pullState(taskId: string, prNumber: number): Promise<ForgePull | undefined> {
    const record = this.options.tasks.get(taskId);
    const repo = record?.repoId ? this.options.repos.get(record.repoId) : undefined;
    if (!record || !repo || deliveryForRecord(record, repo.delivery) !== "direct-pr")
      return undefined;
    // Reading a named pull request needs the project's saved host identity,
    // not a local branch or folder (nor an in-reach work computer).
    const forge = this.options.forgeFor(repo);
    return forge.pull ? this.pullOf(forge, prNumber) : undefined;
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

  private async pullOf(forge: Forge, prNumber: number): Promise<ForgePull> {
    if (!forge.pull) {
      throw new ForgeError("unsupported", "this host has no pull requests to read");
    }
    return forge.pull(prNumber);
  }

  /**
   * After a request whose answer never came, or with no open pull request
   * for the branch: the pinned pull request as the host holds it now. A
   * merge at the approved head is the merge; a closed one ends the approval;
   * an open one at the approved head may be tried again.
   */
  private async readBack(
    taskId: string,
    guard: MergeGuard,
  ): Promise<{ merged?: PrOutcome; closed?: PrOutcome; open?: boolean }> {
    const located = this.locate(taskId);
    if ("said" in located) return {};
    let pull: ForgePull;
    try {
      pull = await this.pullOf(located.forge, guard.prNumber);
    } catch {
      return {};
    }
    if (pull.merged) return { merged: alreadyMerged(located.forge, pull) };
    if (pull.state !== "open") {
      return {
        closed: {
          ok: false,
          text: `Cannot merge: ${numberLabel(located.forge, pull.number)} was closed without merging.`,
          plain: "its pull request was closed without merging",
          stop: "closed",
        },
      };
    }
    return { open: pull.headSha === guard.head };
  }

  /**
   * Why GitHub refused a guarded merge request, read from its typed answer
   * and the pull request's own state - never from the words, but for the
   * merge endpoint's conflict refusal the feed already recognizes.
   */
  private async refusalStop(
    forge: Forge,
    guard: MergeGuard,
    caught: unknown,
    message: string,
  ): Promise<MergeStop | undefined> {
    if (isSignInForgeFailure(caught)) return "sign-in";
    if (isTransientForgeFailure(caught)) return undefined;
    if (!(caught instanceof ForgeError) || caught.failure !== "refused") return undefined;
    if (/^GitHub answered 409 to PUT \S+\/merge: Head branch was modified/i.test(message)) {
      return "moved";
    }
    try {
      const pull = await this.pullOf(forge, guard.prNumber);
      const held = readinessStop(forge, pull, guard);
      if (held?.stop && held.stop !== "computing") return held.stop;
    } catch {
      // The read is evidence only; the refusal itself still speaks.
    }
    return isMergeConflict(message) ? "conflict" : undefined;
  }

  /**
   * The merge result and its Activity line: GitHub's change by its number
   * ("Merged #N on GitHub"), a pushed branch by the task's title and the
   * host's name - the provider's name is the person's word, a host's
   * address is the thing itself. Only the result carries the change's
   * address; the line sits beside the task's key (INF-1845).
   */
  private putInText(
    taskId: string,
    forge: Forge,
    change: ForgeChange,
  ): { text: string; line: string } {
    const url = forge.url(change);
    const where = forge.place ? `on ${forge.place}` : "where the project lives";
    if (change.number !== undefined) {
      const line = `Merged ${forge.label(change)} ${where}`;
      return { text: `${line}.${url ? ` ${url}` : ""}`, line };
    }
    const title = this.options.tasks.get(taskId)?.title ?? forge.label(change);
    return { text: `Merged "${title}" ${where}.`, line: `Merged ${where}` };
  }

  /**
   * Discard's counterpart to merge: best-effort close of the task's open
   * change where the project lives without putting it in, so an abandoned
   * task never leaves one open behind it. Every "nothing to do" edge (no
   * branch, no change on the record, local-only, the folder already gone,
   * no open change) is silent success; only a forge failure once a change
   * is found is reported. A task that never opened a change asks the host
   * nothing at all: its record is where the host learns of one
   * (`pr_opened`), and a discard of one that has none must not fail on a
   * host it never needed.
   */
  async close(taskId: string): Promise<PrOutcome> {
    const record = this.options.tasks.get(taskId.trim());
    if (!record?.branch) return { ok: true, text: "" };
    const delivery = record.delivery;
    if (delivery?.prNumber === undefined && delivery?.changeLabel === undefined) {
      return { ok: true, text: "" };
    }
    const located = this.locate(record.id);
    if ("said" in located) return { ok: true, text: "" };
    const { forge, branch } = located;
    try {
      const change = await forge.changeFor(branch);
      if (!change) return { ok: true, text: "" };
      await forge.close(change);
      const url = forge.url(change);
      return {
        ok: true,
        text:
          change.number !== undefined
            ? `Closed PR ${forge.label(change)}${forge.place ? ` on ${forge.place}` : ""}.${url ? ` ${url}` : ""}`
            : `Deleted the pushed branch${forge.place ? ` on ${forge.place}` : ""}.`,
      };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return { ok: false, text: `Could not close PR: ${message}`, problem: message };
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
  private absenceDeclared(record: TaskRecord, checked: CheckedChange): boolean {
    if (!checked.forge.hasChecks) return true;
    const change = checked.change;
    const reviews = [
      ...(record.delivery?.mergeReviews ?? []),
      ...(record.delivery?.mergeAuthorization?.review
        ? [record.delivery.mergeAuthorization.review]
        : []),
    ];
    const origin = forgeOf(
      record.repoId ? this.options.repos.get(record.repoId)?.origin : undefined,
    );
    return reviews.some(
      (review) =>
        review.kind === checked.forge.kind &&
        review.host === origin.host &&
        review.owner === origin.owner &&
        review.name === origin.name &&
        review.number === change.number &&
        review.branch === change.branch &&
        review.headSha === change.headSha &&
        review.absentChecks?.headSha === change.headSha,
    );
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
    const at = this.now();
    const task = this.options.tasks.get(taskId);
    this.merged.delete(taskId);
    if (checked) {
      this.checked.set(taskId, checked);
    } else {
      this.checked.delete(taskId);
    }
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
    this.options.tasks.recordChangeEvidence(
      taskId,
      {
        ci: actual === "none" ? undefined : actual,
        ciAt: at,
        checks: snapshot,
        ...checksSpan(actual, checks),
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
  private noteChange(taskId: string, checked: CheckedChange): void {
    const task = this.options.tasks.get(taskId);
    if (!task) return;
    const { change, forge } = checked;
    const label = forge.label(change);
    const url = forge.url(change);
    const known =
      task.delivery?.changeLabel ??
      (task.delivery?.prNumber !== undefined ? `#${task.delivery.prNumber}` : undefined);
    if (known === label) return;
    this.options.tasks.recordChangeEvidence(
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
      this.options.tasks.recordChangeEvidence(taskId, { ciObservation: observation });
    return observation.id;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/**
 * When this version's checks started and finished, by the host's own times
 * (INF-587): the first check's start; once green the last check's finish,
 * once red the first failure's. Both keys are always written, so a reading
 * without them clears an earlier version's times.
 */
function checksSpan(
  overall: PrCiOverall | "none",
  items: readonly Pick<ForgeCheck, "state" | "startedAt" | "finishedAt">[],
): { ciStartedAt: number | undefined; ciFinishedAt: number | undefined } {
  const starts = items.flatMap((item) => (item.startedAt === undefined ? [] : [item.startedAt]));
  if (starts.length === 0) return { ciStartedAt: undefined, ciFinishedAt: undefined };
  const ends = (from: typeof items) =>
    from.flatMap((item) => (item.finishedAt === undefined ? [] : [item.finishedAt]));
  const finished =
    overall === "green"
      ? ends(items)
      : overall === "red"
        ? ends(items.filter((item) => isRedCheckState(item.state)))
        : [];
  return {
    ciStartedAt: Math.min(...starts),
    ciFinishedAt:
      finished.length === 0
        ? undefined
        : overall === "green"
          ? Math.max(...finished)
          : Math.min(...finished),
  };
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
      ? "Nothing is left to merge. Continue any remaining work, or report merge_completes_task with this PR number and head when its merge finishes the task. No second merge decision is needed."
      : "Nothing is left to merge. Read the task's remaining work before closing it; a merged PR alone does not mean its work is complete.";
  return [
    "overall: merged",
    `${numberLabel(forge, pull.number)} was merged ${placeWords(forge)} outside the app${pull.mergedSha ? ` as ${pull.mergedSha}` : ""}.`,
    `head: ${pull.headSha}`,
    next,
  ].join("\n");
}

/** Where the project lives, in tool text: "on GitHub", "on gitlab.example.com". */
function placeWords(forge: Forge): string {
  return forge.place ? `on ${forge.place}` : "where the project lives";
}

/** The merge already made: the outcome a put-in answers when nothing is left to send. */
function alreadyMerged(forge: Forge, pull: ForgePull): PrOutcome {
  return {
    ok: true,
    text: `${numberLabel(forge, pull.number)} is already merged ${placeWords(forge)}.`,
    receipt: {
      head: pull.headSha,
      ...(pull.mergedSha ? { sha: pull.mergedSha } : {}),
      already: true,
    },
  };
}

function stripAttempt(
  attempt: PrOutcome & { transient?: boolean; dispatched?: boolean },
): PrOutcome {
  const { transient: _transient, dispatched: _dispatched, ...outcome } = attempt;
  return outcome;
}

/** Why a readiness holds a merge, with where the project lives in the host's words. */
function readinessStops(
  place: string,
): Record<Exclude<ForgeReadiness, "clean">, { stop: MergeStop; plain: string }> {
  return {
    conflict: { stop: "conflict", plain: "it conflicts with newer work in the project" },
    behind: {
      stop: "behind",
      plain: "it is behind the main branch and must be brought up to date",
    },
    blocked: {
      stop: "protected",
      plain: `${place} holds it for a required review or another rule on the main branch`,
    },
    computing: { stop: "computing", plain: `${place} has not worked out whether it can merge yet` },
    draft: { stop: "draft", plain: "its pull request is a draft" },
  };
}

/**
 * A pull request read until GitHub decides whether it can merge `head`: while
 * it reads computing at that head and stays open, it is read again after each
 * of `gaps` in turn (INF-457). The last read comes back with how long the
 * gaps took, and the caller checks it as it would a single read, so a moved
 * head or a closed pull request still stops the merge. Throws as a read does.
 */
async function readDecided(
  read: () => Promise<ForgePull>,
  head: string,
  gaps: readonly number[],
): Promise<{ pull: ForgePull; waited: number }> {
  let pull = await read();
  let waited = 0;
  for (const gap of gaps) {
    if (
      pull.readiness !== "computing" ||
      pull.state !== "open" ||
      pull.merged ||
      pull.headSha !== head
    )
      break;
    await sleep(gap);
    waited += gap;
    pull = await read();
  }
  return { pull, waited };
}

/** What the pinned pull request's own state says about merging it now; undefined when it may. */
function readinessStop(
  forge: Forge,
  pull: ForgePull,
  guard: Pick<MergeGuard, "head">,
): PrOutcome | undefined {
  const label = numberLabel(forge, pull.number);
  const place = forge.place ?? "the project's host";
  if (pull.merged || pull.state !== "open") {
    return {
      ok: false,
      text: `Cannot merge: ${label} is no longer open.`,
      plain: "its pull request is no longer open",
      stop: "closed",
    };
  }
  if (pull.headSha !== guard.head) {
    return {
      ok: false,
      text: `Cannot merge yet: ${label} moved to ${pull.headSha}; the approval covers ${guard.head}.`,
      plain: "it changed after the version you approved",
      stop: "moved",
    };
  }
  if (pull.readiness === "clean") return undefined;
  const { stop, plain } = readinessStops(place)[pull.readiness];
  return {
    ok: false,
    text: `Cannot merge yet: ${place} reads ${label} as ${pull.readiness}. ${fixedHoldWords("host-rules")}`,
    plain,
    stop,
  };
}

/**
 * A repair declaration's closed facts, read with git in the project's own
 * repository - a crewmate's working copy shares its commits. Every read is
 * against the ORIGINAL approved head, so drift across repairs adds up.
 */
async function lineageFacts(dir: string, question: LineageQuestion): Promise<LineageFacts> {
  const { approvedHead, fromHead, toHead, newBase } = question;
  const commit = async (sha: string) =>
    git(dir, ["cat-file", "-e", `${sha}^{commit}`]).then(
      () => true,
      () => false,
    );
  if (!(await commit(toHead))) {
    return {
      known: true,
      toHeadHere: false,
      baseInTo: false,
      approvedPaths: [],
      repairedPaths: [],
    };
  }
  for (const sha of [approvedHead, fromHead, newBase]) {
    if (!(await commit(sha))) return { known: false, why: `${sha} is not a commit here` };
  }
  const ancestor = async (older: string, newer: string): Promise<boolean> => {
    try {
      await git(dir, ["merge-base", "--is-ancestor", older, newer]);
      return true;
    } catch (caught) {
      if ((caught as { code?: unknown }).code === 1) return false;
      throw caught;
    }
  };
  const paths = async (from: string, to: string) =>
    (await git(dir, ["diff", "--name-only", "--no-renames", from, to]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const approvedBase = await git(dir, ["merge-base", approvedHead, newBase]);
  // The branch is already home. Store both versions' readings with the
  // repair so a kept merge compares stored facts and does not read again.
  const [approvedReading, repairedReading] = await Promise.all([
    readChangeReading(dir, approvedHead).catch(() => null),
    readChangeReading(dir, toHead).catch(() => null),
  ]);
  return {
    known: true,
    toHeadHere: true,
    baseInTo: await ancestor(newBase, toHead),
    approvedPaths: await paths(approvedBase, approvedHead),
    repairedPaths: await paths(newBase, toHead),
    approvedReading,
    repairedReading,
  };
}

/** What a crewmate hears when the project's host needs the captain's sign-in. */
function crewSignInText(fact: SignInFact): string {
  return `${notSignedInText(fact.name, fact.host)}. Report this as a blocker: the captain signs in to ${fact.name} in the app's Settings. Do not sign in yourself, and do not look for another way in.`;
}

/**
 * Who reads a story, from the visibility the host read when it was prepared
 * (INF-2142's approved plan): the crewmate is told the audience it writes for.
 */
export function storyAudience(destination: PresentationDestination): string {
  if (hostedPresentation(destination))
    return destination.visibility === "public"
      ? `${destination.fullName} is public: anyone can read this story, so it names nothing personal or local.`
      : `${destination.fullName} is ${destination.visibility}: everyone with access can read this story, and the project can turn public, so it names nothing personal or local.`;
  return destination.kind === "branch"
    ? "Everyone who can reach the branch where the project lives can read its commits; write them for a stranger."
    : "";
}
