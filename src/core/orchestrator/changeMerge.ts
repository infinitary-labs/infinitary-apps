import { queueAnswer } from "@shared/checkRepair";
import { CONTRIBUTION_MERGE_REFUSAL } from "@shared/contributions";
import { hasChangeRequests } from "@shared/forge";
import { fixedHoldWords, overridePasses, softHoldWords } from "@shared/holds";
import { isMergeConflict } from "@shared/plainProblem";
import { deliveryForRecord, opensPullRequest, queueShipped, type RepoView } from "@shared/repos";
import {
  type Forge,
  ForgeBaseMoved,
  type ForgeChange,
  type ForgeCheckState,
  ForgeError,
  type ForgePull,
  type ForgeQueueMark,
  type ForgeReadiness,
  forgeLocationOf,
  isRedCheckState,
  isSignInForgeFailure,
  isTransientForgeFailure,
  messageWithoutPresentation,
  QUEUE_REMOVED_WORDS,
  QUEUE_STATUS,
  QUEUE_WAITING_WORDS,
} from "../forge";
import type { QueueApprovalRemoval, TaskRecord } from "../storage/taskRecords";
import { requireNamed } from "../workspace/naming";
import type { ChangeChecks } from "./changeChecks";
import {
  type ChangeContext,
  type ChangeDeliveryOptions,
  numberLabel,
  placeWords,
  type SignInFact,
} from "./changeContext";
import {
  candidateHead,
  MERGE_CHECKS_HOLD_REASON,
  standingAuthorization,
} from "./mergeAuthorization";
import { type ProjectQueue, queueMerges } from "./projectQueue";
import { publicationRepo } from "./publicationRepo";
import { carryPassedReview } from "./reviewCarry";
import { taskContributesUpstream } from "./workShape";

/** A check state that lets a merge through: passed, or not run on purpose. */
const PASSED_STATES = new Set<ForgeCheckState>(["success", "skipped", "neutral"]);

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
  | "guidance"
  | "queue";

/**
 * What a merge under the captain's kept approval holds to (FI3-304): the one
 * head and pull request it covers, whether the host runs it unattended
 * (GitHub must say the change may merge before anything is sent), and the
 * last look right before the request goes out - a refusal there stops it.
 */
export type MergeBoundary = {
  /**
   * `mark` true is the same look before a queue-pr version is marked for
   * the project's queue: nothing is recorded, since no merge request goes out.
   */
  beforeDispatch: (head: string, mark?: boolean) => string | undefined;
  unattended: boolean;
};

export type MergeGuard = {
  head: string;
  prNumber: number;
  unattended: boolean;
  /** A hold on the approval right now: the merge waits on it and the approval stands. */
  held?: () => string | undefined;
  /** Revoke an interrupted publication through its durable approval owner. */
  queueInterrupted?: () => Promise<void>;
  beforeDispatch: (head: string, mark?: boolean) => string | undefined;
};

/**
 * Backoff between put-in attempts retried for a transient host/network
 * failure, or for a refusal because the main branch moved while it merged.
 */
export const MERGE_RETRY_DELAYS_MS = [300, 900];

/**
 * The gaps between reads of a pull request while GitHub has not decided
 * whether it can merge (INF-457): after the captain's click on a pull
 * request the task did not open, and before a merge GitHub refused because
 * the main branch moved is sent again. GitHub answers `mergeable: null`
 * while a check it has just started works out a test merge, often just
 * after the default branch moved, and asks to be read again shortly. Half a
 * minute in all; still undecided after the last read, nothing is sent.
 */
export const UNDECIDED_REREAD_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 11_000];

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A merge attempt with what decides whether it is tried again: `transient`
 * a hiccup, `dispatched` a request that went out, `baseMoved` a refusal
 * because the main branch moved while it merged, with nothing else read
 * that stops it. None of them leaves the merge.
 */
export type MergeAttempt = PrOutcome & {
  transient?: boolean;
  dispatched?: boolean;
  baseMoved?: boolean;
};

/** A merge's refusal on the saved story names the soft hold the captain's words pass (INF-1365). */
function storyHeld(caught: unknown): never {
  const message = caught instanceof Error ? caught.message : String(caught);
  throw new Error(`${message} ${softHoldWords("story", "firstmate")}`);
}

/**
 * The task's change merged, or closed, where the project lives: through the
 * project's queue where it has one, under the captain's kept approval when
 * the host runs it.
 */
export class ChangeMerge {
  private readonly options: ChangeDeliveryOptions;
  /** The story changes after a click already noted on their task's record. */
  private readonly storyNoted = new Set<string>();

  constructor(
    private readonly context: ChangeContext,
    private readonly checks: ChangeChecks,
    private readonly queue?: ProjectQueue,
  ) {
    this.options = context.options;
  }

  /**
   * Put the task's change in where the project lives. Re-check the complete
   * head check suite at the moment of the click, then ask the forge to put
   * in that exact change at that exact head: an explicit squash with the
   * checked title on GitHub, a fast-forward on a plain Git host.
   *
   * A network/host hiccup on either the recheck or the put-in itself is not
   * a verdict about the change - it is retried a couple of times with a
   * short backoff before giving up. So is a refusal because the main branch
   * moved while the host merged: each try after it reads the pull request
   * until the host has decided, and sends only where it says the change may
   * merge. A durable refusal (checks actually failed, a stale head, branch
   * protection, a conflict) is never retried here: it returns straight away
   * so the captain's own retry - after fixing whatever is wrong - is the one
   * that runs next.
   */
  async merge(taskId: string, guard?: MergeGuard, boundary?: MergeBoundary): Promise<PrOutcome> {
    const record = this.options.tasks.get(taskId);
    if (
      taskContributesUpstream(
        record,
        record?.repoId ? this.options.repos.get(record.repoId) : undefined,
      )
    )
      return {
        ok: false,
        text: CONTRIBUTION_MERGE_REFUSAL,
      };
    let attempt: MergeAttempt = { ok: false, text: "" };
    let settle = false;
    for (let i = 0; i < MERGE_RETRY_DELAYS_MS.length + 1; i++) {
      attempt = await this.mergeOnce(taskId, guard, boundary, settle);
      if (attempt.ok || !(attempt.transient || attempt.baseMoved)) break;
      settle ||= attempt.baseMoved === true;
      // A request that went out and whose answer never came may have merged:
      // read the pull request back before anything is sent again (FI3-304).
      if (guard && attempt.dispatched && attempt.transient) {
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

  /**
   * One try. `settle` follows a refusal because the main branch moved: the
   * pull request is read until the host decides, and only a change it says
   * may merge is sent, the captain's own click included.
   */
  private async mergeOnce(
    taskId: string,
    guard?: MergeGuard,
    boundary?: MergeBoundary,
    settle = false,
  ): Promise<MergeAttempt> {
    // The change this re-check read, never an earlier one: a stale earlier
    // success must never survive a failed re-check.
    const status = await this.checks.run(taskId);
    const reading = this.checks.reading(taskId);
    const checked = status.checked;
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
    const merged = status.merged;
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
    // A queue-pr project's batch check is waiting at this version while the
    // pull request's own checks passed: the merge waits on the queue, which
    // no checks override passes (docs/forge.md, "A project's queue").
    const queued = this.queued(taskId);
    // The crewmate answered the queue's failure at this version (INF-3190):
    // with the pull request's own checks passed, the version is marked
    // waiting again once, as a version with no status is.
    let answered = false;
    let restoring = false;
    if (queued && checked) {
      const items = this.queueItems(taskId, checked.change);
      const queue = items?.find((item) => item.name === QUEUE_STATUS);
      const othersPassed =
        items?.every((item) => item.name === QUEUE_STATUS || PASSED_STATES.has(item.state)) ===
        true;
      restoring = queue?.detail === QUEUE_REMOVED_WORDS && othersPassed && status.recorded;
      answered =
        queue !== undefined &&
        isRedCheckState(queue.state) &&
        othersPassed &&
        status.recorded &&
        queueAnswer(this.options.tasks.get(taskId)?.delivery, checked.change.headSha) !== undefined;
      if (queue?.state === "pending" && othersPassed && status.recorded) {
        if (!guard?.unattended && !boundary?.unattended) this.restartQueue(taskId, checked.forge);
        return {
          ok: false,
          text: `Cannot merge yet - ${QUEUE_WAITING_WORDS}: the project's queue has not passed ${checked.change.headSha} (${QUEUE_STATUS} is pending). ${status.text}`,
          plain: QUEUE_WAITING_WORDS.toLowerCase(),
          stop: "queue",
        };
      }
    }
    // Actual check results are a soft hold: the captain's override on
    // the checks passes them at the version it covers. GitHub's own rules
    // still decide whether it merges.
    const unfinished = reading?.overall === "red" || reading?.overall === "pending";
    const checksPassed =
      answered ||
      restoring ||
      (unfinished &&
        status.recorded &&
        checked !== undefined &&
        overridePasses(this.options.tasks.get(taskId)?.delivery, "checks", checked.change.headSha));
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
      // The task's own branch is checked where it was made, commit by
      // commit. Any other change the task names was opened elsewhere or
      // checked when the task opened it; its title is checked below.
      const own = change.branch === record?.branch;
      if (own && record && !record.delivery?.presentation) await this.context.branchHome(record);
      // Another change is read in the project it is in (INF-2510).
      const elsewhere =
        !own && record && change.number !== undefined
          ? this.projectOfNumber(record, change.number)
          : undefined;
      const repo =
        elsewhere ?? (record?.repoId ? this.options.repos.get(record.repoId) : undefined);
      const dir = own
        ? await this.context.validateRange(
            record?.repoId,
            record?.repoDir,
            change.branch,
            forge,
            change.headSha,
          )
        : (repo?.path ?? record?.repoDir ?? "");
      if (hasChangeRequests(forge.kind))
        requireNamed(change.title ?? "", "pull request title", this.options.namingRule?.() ?? null);
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
      const queueWait =
        answered || restoring
          ? { state: undefined }
          : this.queueWait(taskId, this.queueItems(taskId, change));
      if (hasChangeRequests(forge.kind) && (guard?.unattended || boundary?.unattended || settle)) {
        if (change.number === undefined)
          return { ok: false, text: "Cannot merge: the pull request identity is missing." };
        const number = guard?.prNumber ?? change.number;
        const head = guard?.head ?? change.headSha;
        const { pull } = await readDecided(
          () => this.context.pullOf(forge, number),
          head,
          settle ? UNDECIDED_REREAD_MS : [],
        );
        const held = readinessStop(forge, pull, { head });
        if (held && !(queueWait && held.stop === "protected")) return held;
      }
      // The change's saved story, the same way a continuing merge reads it.
      const storied = await this.withPublishedStory(taskId, forge, change, guard);
      if ("held" in storied)
        return { ok: false, text: `Cannot merge yet: ${storied.held}.`, stop: "guidance" };
      const publishedChange = storied.change;
      const held = guard?.held?.();
      if (held) return { ok: false, text: `Cannot merge yet: ${held}.`, stop: "guidance" };
      if (queueWait)
        return await this.enqueue(
          taskId,
          forge,
          publishedChange,
          queueWait.state,
          () =>
            guard?.beforeDispatch(change.headSha, true) ??
            boundary?.beforeDispatch(change.headSha, true),
          !guard?.unattended && !boundary?.unattended,
          answered,
          guard?.held,
          guard?.queueInterrupted,
        );
      // Queue version 10 introduced queue-owned merges on both hosts. Older
      // queues still depend on the approving app, so keep that compatibility.
      if (queued && queueMerges(repo)) {
        return {
          ok: false,
          text: "The batch passed; the project's queue is merging this version.",
          plain: "the project's queue is merging this version",
          stop: "queue",
        };
      }
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
      this.startNextBatch(taskId, "merge");
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
      // The main branch moved while the host merged: tried again unless the
      // pull request's own state already says why it cannot merge.
      const baseMoved =
        caught instanceof ForgeBaseMoved && (stop === undefined || stop === "computing");
      return {
        ok: false,
        text: `Cannot merge: ${message}`,
        problem: message,
        ...(isTransientForgeFailure(caught) ? { transient: true } : {}),
        ...(dispatched ? { dispatched: true } : {}),
        ...(baseMoved ? { baseMoved: true } : {}),
        ...(stop ? { stop } : {}),
        ...(isSignInForgeFailure(caught) ? { signIn: this.context.signInFact(forge, repoId) } : {}),
      };
    }
  }

  /**
   * The pull request as it merges with its change's saved story - each
   * change keeps its own (INF-2490) - for both merges, the finishing one and
   * a continuing one: the published story at this version, or the
   * description's own words under the captain's override on the story
   * (INF-1365). A pull request with no story of this task merges as it is.
   * On the captain's kept approval of a merge card's offer the newest story
   * merges, even one revised after the click: approval follows the code
   * (INF-3623). A pull request that moved past the published version
   * has the story republished at its version first, words unchanged
   * (INF-2509): on a kept approval only at the version it covers, and a
   * repair the host accepted keeps its own words (FI3-304). The captain's
   * guidance that holds the merge is answered instead, read before that
   * refresh.
   */
  async withPublishedStory(
    taskId: string,
    forge: Forge,
    change: ForgeChange,
    guard?: MergeGuard,
  ): Promise<{ change: ForgeChange } | { held: string }> {
    const ledger = this.options.tasks.delivery.changePresentation(taskId, change.branch);
    const published = ledger?.published ?? ledger?.publication;
    // A publication names the pull request it went to.
    if (!ledger || (published?.number !== undefined && published.number !== change.number))
      return { change };
    const read = await forge.changeFor(change.branch);
    if (
      !read ||
      read.number !== change.number ||
      read.headSha !== change.headSha ||
      !this.options.presentations
    )
      throw new Error("The current story cannot be checked for complete evidence.");
    const record = this.options.tasks.get(taskId);
    // INF-1365: the captain's override on the saved story passes its publication at this
    // version: nothing is marked published, uploaded or refreshed, and the squash carries the
    // description's own words, not an older story's. It is read after the last wait before the
    // send, so a withdrawn override holds this merge.
    if (overridePasses(record?.delivery, "story", change.headSha))
      return {
        change: { ...read, squashMessage: messageWithoutPresentation(read.body ?? "", taskId) },
      };
    const authorization = guard ? standingAuthorization(record?.delivery) : undefined;
    // Approval follows the code, never the story's words (INF-3623): a story
    // revised after the click merges as the newest one, noted once.
    if (authorization && !authorization.review) {
      const offered = record?.delivery?.completionOffers?.find(
        (offer) =>
          offer.cardId === authorization.card.id && offer.offerId === authorization.card.offerId,
      );
      const now = ledger.published?.contentHash;
      const seen = `${taskId}:${offered?.offerId}:${now}`;
      if (offered && now && offered.presentationContentHash !== now && !this.storyNoted.has(seen)) {
        this.storyNoted.add(seen);
        this.options.tasks.note(
          taskId,
          "The story changed after the merge click; the merge carries the newest story.",
          { news: false, data: { storyChangedAfterClick: now } },
        );
      }
    }
    const held = guard?.held?.();
    if (held) return { held };
    let current = read;
    const publishedHead = ledger.published?.head;
    const moved =
      publishedHead !== undefined &&
      publishedHead !== change.headSha &&
      (!authorization || candidateHead(authorization) === change.headSha);
    const repaired =
      moved &&
      authorization !== undefined &&
      authorization.lineage.length > 0 &&
      (publishedHead === authorization.approvedHead ||
        authorization.lineage.some((step) => step.toHead === publishedHead));
    if (moved) {
      // INF-2509: any other move past the published story republishes it
      // too, words unchanged; a newer story its author prepared stays theirs.
      if (repaired)
        await this.options.presentations.refreshConflictOnly(
          taskId,
          publishedHead,
          change.headSha,
          forge,
          change.branch,
          change.title ?? "",
          this.context.attestsAt(taskId),
        );
      else
        await this.options.presentations.republishMoved(
          taskId,
          change,
          forge,
          this.context.attestsAt(taskId),
        );
      const refreshed = await forge.changeFor(change.branch);
      if (!refreshed || refreshed.number !== change.number || refreshed.headSha !== change.headSha)
        throw new Error("The pull request changed during the story refresh.");
      current = refreshed;
    }
    return {
      change: await this.options.presentations
        .assertPublished(taskId, current, forge)
        .catch(storyHeld),
    };
  }

  /**
   * After the app marks a version waiting on a host whose mark starts
   * nothing, or after a batched change merges, through the merge card or a
   * merge review, start the shipped queue again where the project lives, so
   * the next batch forms: neither the mark nor the merge's own push starts a
   * workflow there (docs/forge.md, "The shipped queue"). A start that fails
   * is tried once more; a second failure is noted on the task and wakes the
   * crewmate of a task still waiting in that queue - this one after a mark,
   * another after a merge, since a merged task closes and its wakes with it
   * - or, with none, the first mate, since no batch forms until something
   * starts one.
   */
  startNextBatch(taskId: string, after: "mark" | "merge"): void {
    if (!this.queued(taskId)) return;
    const record = this.options.tasks.get(taskId);
    const repoId = record?.delivery?.checkTarget?.repoId ?? record?.repoId;
    const repo = repoId ? this.options.repos.get(repoId) : undefined;
    if (!repo || queueShipped(repo) === undefined) return;
    const forge = this.options.forgeFor(repo);
    if (!forge.startQueue) return;
    const start = (): Promise<void> => forge.startQueue?.({ action: "form" }) ?? Promise.resolve();
    void start()
      .catch(start)
      .catch((error: unknown) => {
        const why = error instanceof Error ? error.message : String(error);
        this.options.tasks.note(taskId, `The project's queue did not start: ${why}`, {
          news: true,
        });
        const waiting = this.options.tasks
          .listLive()
          .filter(
            (task) =>
              (after === "mark" || task.id !== taskId) &&
              (task.delivery?.checkTarget?.repoId ?? task.repoId) === repo.id &&
              task.delivery?.queueMark !== undefined,
          )
          .sort((a, b) => Number(a.id !== taskId) - Number(b.id !== taskId));
        const crewmate = waiting[0];
        if (crewmate)
          this.options.steer?.(crewmate.id, { facts: { kind: "queue-start-failed", why } });
        else
          this.options.tell?.({
            kind: "queue-stalled",
            project: { id: repo.id, name: repo.name },
            why,
          });
      });
  }

  /**
   * The captain's own merge click on a version already waiting, on a host
   * whose mark starts nothing: start the queue again, since only a start
   * reads a change the queue held, such as one waiting for a Maintainer's
   * approval. A kept approval's unattended retry starts nothing.
   */
  private restartQueue(taskId: string, forge: Forge): void {
    if (!forge.markStartsQueue) this.startNextBatch(taskId, "mark");
  }

  /** Whether the task merges through its project's queue (`queue-pr`). */
  queued(taskId: string): boolean {
    const record = this.options.tasks.get(taskId);
    // A change opened in another managed project merges by that project's
    // delivery (INF-2510); the task's own decides its own.
    const target = record?.delivery?.checkTarget;
    if (record && target?.repoId && target.repoId !== record.repoId)
      return this.options.repos.get(target.repoId)?.delivery === "queue-pr";
    const repo = record?.repoId ? this.options.repos.get(record.repoId) : undefined;
    return record !== undefined && deliveryForRecord(record, repo?.delivery) === "queue-pr";
  }

  queueOwnsMerge(taskId: string, number: number | undefined): boolean {
    if (!this.queued(taskId)) return false;
    const record = this.options.tasks.get(taskId);
    if (!record) return false;
    const elsewhere = number === undefined ? undefined : this.projectOfNumber(record, number);
    const repo = elsewhere ?? (record.repoId ? this.options.repos.get(record.repoId) : undefined);
    return queueMerges(repo ?? undefined);
  }

  /** Remove the eligibility of the exact approval head; an already sent merge cannot be undone. */
  async removeQueuedApproval(taskId: string, removal: QueueApprovalRemoval): Promise<void> {
    const record = this.options.tasks.get(taskId);
    if (!record) return;
    const elsewhere = this.projectOfNumber(record, removal.target.prNumber);
    if (elsewhere === null) throw new Error("The queued change's project is no longer registered.");
    const registered =
      elsewhere ?? this.options.repos.get(removal.review?.repoId ?? removal.target.repoId);
    if (!registered) throw new Error("The queued change's project is no longer registered.");
    const repo = publicationRepo(record, registered);
    const location = forgeLocationOf(repo);
    if (
      location.host !== removal.target.host ||
      location.owner !== removal.target.owner ||
      location.name !== removal.target.name
    )
      throw new Error(
        "The project no longer matches the queued approval's destination; its removal is not confirmed.",
      );
    if (!queueMerges(repo)) return;
    const forge = this.options.forgeFor(repo, repo.path);
    if (!forge.removeQueued) throw new Error("This project's host cannot remove its queue mark.");
    const pull = await forge.pull?.(removal.target.prNumber);
    if (!pull)
      throw new Error("The queued change cannot be read, so its removal is not confirmed.");
    if (pull.merged) return;
    await forge.removeQueued(removal.head, removal.target.prNumber);
  }

  /**
   * Where a version of a queue-pr task stands with the project's queue:
   * undefined when the task does not merge through a queue or the queue
   * passed that version, otherwise the queue status's state there, absent
   * before the host marks it. Until it passes, a required queue status is
   * what holds the pull request, so GitHub's rules wait on the mark rather
   * than stop it (docs/forge.md, "A project's queue").
   */
  queueWait(
    taskId: string,
    items: { name: string; state: ForgeCheckState; detail?: string }[] | undefined,
  ): { state: ForgeCheckState | undefined } | undefined {
    if (!this.queued(taskId)) return undefined;
    const item = items?.find((item) => item.name === QUEUE_STATUS);
    const state = item?.detail === QUEUE_REMOVED_WORDS ? undefined : item?.state;
    return state === "success" ? undefined : { state };
  }

  /**
   * The checks the change record holds at the merged pull request's version:
   * that pull request's own change, whichever branch it is on (INF-2490).
   */
  private queueItems(
    taskId: string,
    change: ForgeChange,
  ): { name: string; state: ForgeCheckState; detail?: string }[] | undefined {
    const record = this.options.tasks.get(taskId);
    const head = change.headSha;
    const version = record
      ? this.context.changeRecordOf(record, change)?.versions.find((item) => item.head === head)
      : undefined;
    const snapshot = version?.checks?.snapshot;
    if (snapshot?.headSha !== head) return undefined;
    const status = record?.delivery?.queueStatus;
    return snapshot.items.map((item) =>
      item.name === QUEUE_STATUS && status?.head === head
        ? { ...item, detail: status.words }
        : item,
    );
  }

  /**
   * A queue-pr merge whose batch check has not passed at this version: after
   * the same last look a merge request takes (`look`, which records
   * nothing), the host marks the version waiting with `infinitary/queue`
   * once, reads the checks again so the watch follows the queue's answer,
   * and stops on the queue. Nothing is merged; a failed batch stops on the
   * checks.
   */
  async enqueue(
    taskId: string,
    forge: Forge,
    change: ForgeChange,
    state: ForgeCheckState | undefined,
    look: () => string | undefined,
    attended: boolean,
    answered = false,
    held?: () => string | undefined,
    queueInterrupted?: () => Promise<void>,
  ): Promise<PrOutcome> {
    if (state !== undefined && state !== "pending") {
      return {
        ok: false,
        text: `Cannot merge yet - the project's queue did not pass ${change.headSha} (${QUEUE_STATUS} is ${state}).`,
        plain: "the batch check failed",
        notGreen: true,
        stop: "checks",
      };
    }
    if (!forge.markQueued)
      throw new Error("This project's host cannot mark a version for its queue.");
    const guidance = held?.();
    const withdrawn = guidance ?? look();
    if (withdrawn) {
      return {
        ok: false,
        text: `Cannot merge: ${withdrawn}${withdrawn.endsWith(".") ? "" : "."}`,
        stop: guidance ? "guidance" : "withdrawn",
      };
    }
    if (state === undefined) {
      // Each click that marks a version reads the project's workflows
      // again, so its waiting note says what is there now.
      const repoId = this.options.tasks.get(taskId)?.repoId;
      if (repoId) await this.queue?.readWorkflows(repoId);
      const record = this.options.tasks.get(taskId);
      const targetRepo =
        record && change.number !== undefined
          ? this.projectOfNumber(record, change.number)
          : undefined;
      const repo =
        targetRepo ?? (record?.repoId ? this.options.repos.get(record.repoId) : undefined);
      const owned = queueMerges(repo ?? undefined);
      const naming = this.options.namingRule?.() ?? null;
      // Evaluate the captured active rule here, not in a public queue packet or a copied grammar.
      if (owned && change.number !== undefined)
        requireNamed(change.title ?? "", "pull request title", naming);
      const removeIfInterrupted = async (): Promise<PrOutcome | undefined> => {
        const guidance = held?.();
        const interrupted = guidance ?? look();
        if (!interrupted) return undefined;
        if (queueInterrupted) await queueInterrupted();
        else {
          if (change.number === undefined)
            throw new Error("The queued change has no pull request identity.");
          await forge.removeQueued?.(change.headSha, change.number);
        }
        return {
          ok: false,
          text: `Cannot merge: ${interrupted}.`,
          stop: guidance ? "guidance" : "withdrawn",
        };
      };
      let mark: ForgeQueueMark;
      try {
        mark = await forge.markQueued(
          change.headSha,
          owned && change.number !== undefined
            ? {
                number: change.number,
                title: change.title ?? "",
                message: change.squashMessage ?? (change.body || undefined),
                naming: naming ? { pattern: naming.pattern } : null,
                beforeDispatch: () => held?.() ?? look(),
              }
            : undefined,
        );
      } catch (error) {
        const interrupted = await removeIfInterrupted();
        if (interrupted) return interrupted;
        throw error;
      }
      this.queue?.marked(taskId, change.headSha, mark.id);
      const interrupted = await removeIfInterrupted();
      if (interrupted) return interrupted;
      this.options.tasks.note(
        taskId,
        `Marked ${change.headSha} with ${QUEUE_STATUS}, waiting for the project's queue.`,
        { news: false, data: { queue: change.headSha } },
      );
      if (answered) {
        const title = this.options.tasks.get(taskId)?.title;
        this.options.tasks.note(
          taskId,
          `${title ? `"${title}"` : "The change"} is back in the project's queue: its crewmate answered the queue's send-back of this version.`,
          { news: true, feed: true, data: { queueAnswered: change.headSha } },
        );
      }
    }
    // A host whose mark starts nothing has the queue started here: on the
    // mark, and on the captain's own click on a version already waiting
    // (`restartQueue`), never on a kept approval's unattended retry.
    if (state === undefined && !forge.markStartsQueue) this.startNextBatch(taskId, "mark");
    else if (attended) this.restartQueue(taskId, forge);
    if (state === undefined) await this.checks.run(taskId);
    return {
      ok: false,
      text: `Cannot merge yet - ${QUEUE_WAITING_WORDS}: the host marked ${change.headSha} with ${QUEUE_STATUS}, waiting; the project's queue sets it to success or failure.`,
      plain: QUEUE_WAITING_WORDS.toLowerCase(),
      stop: "queue",
    };
  }

  /**
   * The pinned pull request read by its number (FI3-304): what a kept
   * approval's reconcile asks after a restart or an answer that never came.
   * Undefined where the host has no pull requests or the task no change.
   */
  async pullState(taskId: string, prNumber: number): Promise<ForgePull | undefined> {
    const record = this.options.tasks.get(taskId);
    const repo = record?.repoId ? this.options.repos.get(record.repoId) : undefined;
    if (!record || !repo || !opensPullRequest(deliveryForRecord(record, repo.delivery)))
      return undefined;
    // Reading a named pull request needs the project's saved host identity,
    // not a local branch or folder (nor an in-reach work computer): the
    // task's own project, or the other managed one the task opened that
    // number in (INF-2510).
    const elsewhere = this.projectOfNumber(record, prNumber);
    if (elsewhere === null) return undefined;
    const forge = this.options.forgeFor(elsewhere ?? repo);
    return forge.pull ? this.context.pullOf(forge, prNumber) : undefined;
  }

  /**
   * The other managed project a pull request number of this task is in
   * (INF-2510): the one its current change, its approved review, a kept
   * review or a change record names for that number, in that order.
   * Undefined for the task's own project; null when that project is no
   * longer managed.
   */
  private projectOfNumber(record: TaskRecord, number: number): RepoView | undefined | null {
    const delivery = record.delivery;
    const reviews = [
      delivery?.checkTarget,
      delivery?.mergeAuthorization?.review,
      ...[...(delivery?.mergeReviews ?? [])].sort((a, b) => b.at - a.at),
    ];
    const review = reviews.find((item) => item?.number === number);
    const repoId = review
      ? review.repoId
      : this.options.tasks
          .changesFor(record.id)
          .find((change) => change.handle?.number === number && change.repoId !== record.repoId)
          ?.repoId;
    if (!repoId || repoId === record.repoId) return undefined;
    return this.options.repos.get(repoId) ?? null;
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
    const located = this.context.locate(taskId);
    if ("said" in located) return {};
    let pull: ForgePull;
    try {
      pull = await this.context.pullOf(located.forge, guard.prNumber);
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
   * merge endpoint's conflict refusal the feed already recognizes. A refusal
   * because the main branch moved, with nothing in the pull request's state
   * that stops it, waits on the host: the app reads it again on its own.
   */
  async refusalStop(
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
      const pull = await this.context.pullOf(forge, guard.prNumber);
      const held = readinessStop(forge, pull, guard);
      if (held?.stop && held.stop !== "computing") return held.stop;
    } catch {
      // The read is evidence only; the refusal itself still speaks.
    }
    if (caught instanceof ForgeBaseMoved) return "computing";
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
    // The task's own branch: a change it opened elsewhere stays as it is.
    const located = this.context.locate(record.id, "check", "own");
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
}

/** The merge already made: the outcome a put-in answers when nothing is left to send. */
function alreadyMerged(forge: Forge, pull: ForgePull): PrOutcome {
  return {
    ok: true,
    text: `${numberLabel(forge, pull.number)} is already merged ${placeWords(forge)}.`,
    receipt: mergedReceipt(pull),
  };
}

/** The receipt of a pull request found already merged: the head it merged at, and its commit. */
export function mergedReceipt(pull: ForgePull): NonNullable<PrOutcome["receipt"]> {
  return {
    head: pull.headSha,
    ...(pull.mergedSha ? { sha: pull.mergedSha } : {}),
    already: true,
  };
}

export function stripAttempt(attempt: MergeAttempt): PrOutcome {
  const {
    transient: _transient,
    dispatched: _dispatched,
    baseMoved: _baseMoved,
    ...outcome
  } = attempt;
  return outcome;
}

/**
 * A pull request read until GitHub decides whether it can merge `head`: while
 * it reads computing at that head and stays open, it is read again after each
 * of `gaps` in turn (INF-457). The last read comes back with how long the
 * gaps took, and the caller checks it as it would a single read, so a moved
 * head or a closed pull request still stops the merge. Throws as a read does.
 */
export async function readDecided(
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

/** Why a readiness holds a merge, with where the project lives in the host's words. */
export function readinessStops(
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

/** What the pinned pull request's own state says about merging it now; undefined when it may. */
export function readinessStop(
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
