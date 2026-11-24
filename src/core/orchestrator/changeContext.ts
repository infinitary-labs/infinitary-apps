import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ChangeRecord } from "@shared/change";
import { sameRequestLink } from "@shared/forge";
import { changeRequestKind } from "@shared/forgeKinds";
import { notSignedInText } from "@shared/forges";
import { acceptedValidation } from "@shared/liveValidation";
import { MERGE_REVIEW_CAP, type MergeReview } from "@shared/mergeReview";
import { deliveryForRecord, opensPullRequest, type RepoView } from "@shared/repos";
import type { NamingRule } from "../../shared/runbooks";
import type { Batches } from "../batches/batches";
import { fixBase } from "../batches/combine";
import { heldVersions } from "../batches/line";
import {
  type Forge,
  type ForgeChange,
  ForgeError,
  type ForgePull,
  type ForgeRepo,
  isForkReview,
} from "../forge";
import type { TaskRecord } from "../storage/taskRecords";
import type { TaskService } from "../tasks/taskService";
import { git } from "../workspace/git";
import { requireNamedRange } from "../workspace/naming";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { ChangePresentations } from "./changePresentations";
import type { LineageFacts, LineageQuestion } from "./mergeAuthorization";
import { publicationRepo, requestAtRepo, savedRequestAtRepo } from "./publicationRepo";
import { reviewCoversHead } from "./reviewCarry";
import type { TypedWake } from "./wakes";
import { mergesInOwnBatch } from "./workShape";

/**
 * What every owner of a task's change shares (`./changeDelivery.ts`): the
 * task's project and the forge where it lives, the change it names, and the
 * words that name it. The owners read forge facts and record the crew's
 * version-bound declarations; merge identity, consent, host readiness and
 * send-once effects remain host-owned.
 */
export type ChangeDeliveryOptions = {
  /** The active naming runbook's rule, read at each use; absent or null, no naming runbook is on. */
  namingRule?: () => NamingRule | null;
  prepareContribution?: (taskId: string) => Promise<string | undefined>;
  tasks: TaskService;
  repos: RepoRegistry;
  presentations?: ChangePresentations;
  /**
   * The line and open batch of projects whose approved changes combine in
   * batches of this person's own (docs/forge.md, "Batches of your own");
   * read late, since it is built after the owners that use it.
   */
  batches?: () => Batches | undefined;
  /** The forge for a task's repository (`createForgeResolver` in `src/core/forge/`). */
  forgeFor: (repo: ForgeRepo | undefined, fallbackDir?: string) => Forge;
  now?: () => number;
  /**
   * One feed line (a host refusing a change the app cannot fix itself),
   * naming the task it is about.
   */
  onNote?: (text: string, taskId: string) => void;
  /**
   * A steer to the task's crewmate through the durable inbox: a fact it has
   * to act on. A wake with `once` goes out once per task and name.
   */
  steer?: (taskId: string, wake: TypedWake) => void;
  /**
   * Whether an enabled runbook asks for the comment wake (docs/forge.md,
   * "Comments on a pull request"), read at each use. Absent or false, no
   * comment is read and a contribution's activity wakes as before.
   */
  commentsWatched?: () => boolean;
  /** Test seam for disposable forge fixtures without real remote heads. */
  validateRange?: (dir: string, branch: string, forge: Forge, head?: string) => Promise<void>;
  /** Test seam for a repair declaration's git facts (`lineageFacts`). */
  lineageFacts?: (dir: string, question: LineageQuestion) => Promise<LineageFacts>;
  /** Synchronous: kept proof is checked immediately before the forge send. */
  verifyValidationEvidence?: (taskId: string) => void;
  /**
   * The folder a task's kept proof lives in, so a takeover can carry an
   * earlier task's accepted proof into its own (`carryTakenOverReview`).
   * Absent, a takeover carries no review.
   */
  proofDir?: (taskId: string) => string;
  /**
   * A task whose working copy is on a computer that runs work: its
   * branch is brought here from there before this Mac's own git reads
   * it, into the project's folder (docs/helper.md, "Its working
   * copies"). Never throws.
   */
  bringBranchHome?: (
    taskId: string,
    strict?: boolean,
    branch?: string,
  ) => Promise<string | undefined>;
  /**
   * The branch a placed task's working copy has checked out there, null
   * when detached, and its commit (INF-2490); null when that computer is
   * out of reach or cannot say.
   */
  checkedOut?: (taskId: string) => Promise<{ branch: string | null; head: string } | null>;
};

/** Where a sign-in was missing, and the project it was for. */
export type SignInFact = { host: string; name: string; repoId?: string };

/**
 * The checked change, and the forge that answered, for the put-in that
 * follows. `project` is the managed project the change is in, whose saved
 * record may say it runs no checks (docs/forge.md, "A project with no
 * checks"); absent where the change lives in a project the app does not
 * manage, such as an upstream contribution's.
 */
export type CheckedChange = { change: ForgeChange; forge: Forge; project?: string };

/** The managed project a located change is in, as `CheckedChange.project` names it. */
export function projectOf(located: Located): { project?: string } {
  const own = located.elsewhere || !located.record.delivery?.publicationOrigin;
  return own && located.repo ? { project: located.repo.id } : {};
}

/** The task as `ChangeContext.locate` found it: its project, branch and forge. */
export type Located = {
  record: NonNullable<ReturnType<TaskService["get"]>>;
  branch: string;
  forge: Forge;
  /** The project the change is in: the task's own unless it opened one in another (INF-2510). */
  repo: RepoView | undefined;
  dir: string;
  elsewhere: boolean;
};

export class ChangeContext {
  constructor(readonly options: ChangeDeliveryOptions) {}

  /**
   * The project whose batches of this person's own the task's change joins
   * (docs/forge.md, "Batches of your own"): a task of a project on the
   * batched delivery; undefined for every other task. A pull request the
   * task names by number is never batched, and neither is a contribution
   * through a fork.
   */
  ownBatch(taskId: string): RepoView | undefined {
    const record = this.options.tasks.get(taskId);
    const repo = record?.repoId ? this.options.repos.get(record.repoId) : undefined;
    return mergesInOwnBatch(record, repo) ? repo : undefined;
  }

  /** The task's effective approved address, including an explicitly pinned publication route. */
  approvedOrigin(taskId: string): string | null {
    const record = this.options.tasks.get(taskId);
    const repo = record?.repoId ? this.options.repos.get(record.repoId) : undefined;
    return record && repo ? publicationRepo(record, repo).origin : null;
  }

  get batches(): Batches | undefined {
    return this.options.batches?.();
  }

  /**
   * A batched change's pushed branch as a change with no number, since it
   * takes no pull request of its own; null while nothing is pushed. Its
   * page is the host's compare page for the branch (INF-4196), read once
   * and then kept on the record: `known` is the record's change.
   */
  async pushedBranch(
    forge: Forge,
    branch: string,
    known?: TaskRecord["delivery"],
  ): Promise<ForgeChange | null> {
    if (!forge.branchHead) return null;
    try {
      const headSha = await forge.branchHead(branch);
      const kept =
        known?.prNumber === undefined && known?.changeLabel === branch ? known.prUrl : undefined;
      // A page the host could not name leaves the branch unlinked, never unread.
      const url = kept ?? (await forge.branchPage?.(branch).catch(() => null)) ?? null;
      return { branch, headSha, url };
    } catch (caught) {
      // The host's refusal is its answer for a branch that is not there yet.
      if (caught instanceof ForgeError && caught.failure === "refused") return null;
      throw caught;
    }
  }

  now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * INF-1793: whether the task's records complete no-mistakes' steps at a version - review and
   * document from an independent review that passed there (its brief also judges the documents),
   * test from live validation that review accepted. The care's name decides nothing: a review
   * happens at any care (INF-1875). A captain's override completes none.
   */
  attestsAt(taskId: string): (head: string) => boolean {
    return (head) => {
      const current = this.options.tasks.get(taskId);
      if (!current) return false;
      return (
        reviewCoversHead(current.delivery, head) &&
        acceptedValidation(current.delivery?.liveValidation, head).ready
      );
    };
  }

  /**
   * The task's direct-pr repository and the forge where it lives, or the
   * tool text that says why there is nothing to ask.
   */
  locate(
    taskId: string,
    purpose: "check" | "open" = "check",
    on: "current" | "own" | "new-request" | { repoId?: string } = "current",
  ): { said: string; stop?: "identity" } | Located {
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
    if (!opensPullRequest(delivery)) {
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
    // The change's own project: another managed project when the change
    // open_change opened there is the one asked for (INF-2510).
    const review =
      on === "own" || on === "new-request"
        ? undefined
        : on === "current"
          ? record.delivery?.checkTarget
          : on;
    const identity = review && "host" in review ? (review as MergeReview) : undefined;
    const moved = {
      stop: "identity" as const,
      // i18n-exempt: a tool answer served to the agent, not shown to a person
      said: "The saved pull request belongs to the project’s former address. Name a pull request at the current address explicitly.",
    };
    const elsewhereId =
      review?.repoId && review.repoId !== record.repoId ? review.repoId : undefined;
    if (elsewhereId) {
      const other = this.options.repos.get(elsewhereId);
      if (!other)
        return {
          said: "The project this task's change is in is no longer managed by the app; cannot read the change.",
        };
      if (!existsSync(other.path))
        return { said: `${other.name}'s folder is gone; cannot read this task's change there.` };
      if (identity && !requestAtRepo(other, identity)) return moved;
      return {
        record,
        branch: record.branch,
        forge: this.options.forgeFor(other, other.path),
        repo: other,
        dir: other.path,
        elsewhere: true,
      };
    }
    const destination = repo ? publicationRepo(record, repo) : repo;
    const ownHandle = this.options.tasks.changeFor(record.id)?.handle;
    const ownNumber = record.delivery?.checkTarget ? ownHandle?.number : record.delivery?.prNumber;
    const ownURL = record.delivery?.checkTarget ? ownHandle?.url : record.delivery?.prUrl;
    if (
      destination &&
      (identity
        ? !requestAtRepo(destination, identity)
        : purpose === "check" &&
          on !== "new-request" &&
          ownNumber !== undefined &&
          !savedRequestAtRepo(record, destination, ownNumber, record.branch, ownURL))
    )
      return moved;
    return {
      record,
      branch: record.branch,
      forge: this.options.forgeFor(destination, dir),
      repo,
      dir,
      elsewhere: false,
    };
  }

  signInFact(forge: Forge, repoId: string | null | undefined): SignInFact {
    return {
      host: forge.host ?? "github.com",
      name: forge.place ?? forge.host ?? "the project's host",
      ...(repoId ? { repoId } : {}),
    };
  }

  /**
   * The change record of one pull request the task names (INF-2490): the
   * one on the read branch that names the read pull request.
   */
  changeRecordOf(record: TaskRecord, change: ForgeChange): ChangeRecord | undefined {
    const changes = this.options.tasks.changesFor(record.id);
    const selected = record.delivery?.checkTarget;
    const candidates = changes.filter(
      (item) =>
        item.head.branch === change.branch &&
        (change.number === undefined || item.handle?.number === change.number),
    );
    const url = change.url;
    const named =
      (url ? candidates.find((item) => sameRequestLink(item.handle?.url, url)) : undefined) ??
      (selected && selected.number === change.number
        ? candidates.find((item) => {
            const repo = this.options.repos.get(selected.repoId ?? record.repoId ?? "");
            return (
              repo &&
              item.repoId === repo.id &&
              !!item.handle?.url &&
              savedRequestAtRepo(record, repo, selected.number, selected.branch, item.handle.url)
            );
          })
        : undefined) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (named) return named;
    return change.branch === record.branch ? this.options.tasks.changeFor(record.id) : undefined;
  }

  /**
   * Make the named pull request the task's current change (INF-2490,
   * `primitives/changes.md`): the slot's readings then follow it. The task's
   * own branch needs no selection; any other branch is selected by the
   * review that named it. The review is kept either way.
   */
  select(record: TaskRecord, review: MergeReview, readURL?: string | null): void {
    const kept = [
      review,
      ...(record.delivery?.mergeReviews ?? []).filter((item) => item.id !== review.id),
    ].slice(0, MERGE_REVIEW_CAP);
    const own = review.branch === record.branch && !isForkReview(review);
    this.options.tasks.delivery.recordPermissionRecords(record.id, {
      mergeReviews: kept,
      ...(own ? {} : { checkTarget: review }),
    });
    if (own) this.options.tasks.delivery.selectOwnChange(record.id, { ...review, url: readURL });
  }

  /** Saved own requests may be read only in the destination held with that request. */
  savedOwnNumber(located: Located): number | undefined {
    const { record, repo } = located;
    const handle = this.options.tasks.changeFor(record.id)?.handle;
    const number = record.delivery?.checkTarget ? handle?.number : record.delivery?.prNumber;
    const url = record.delivery?.checkTarget ? handle?.url : record.delivery?.prUrl;
    return number !== undefined &&
      repo &&
      savedRequestAtRepo(record, publicationRepo(record, repo), number, record.branch, url)
      ? number
      : undefined;
  }

  async pullOf(forge: Forge, prNumber: number): Promise<ForgePull> {
    if (!forge.pull) {
      throw new ForgeError("unsupported", "this host has no pull requests to read");
    }
    return forge.pull(prNumber);
  }

  /** A placed task's branch, brought here before this Mac's git reads it. */
  async branchHome(record: { id: string; deviceId?: string | null }): Promise<void> {
    if (record.deviceId) await this.options.bringBranchHome?.(record.id);
  }

  /** The project's folder, where this Mac's git reads a task's branch. */
  projectDir(repoId: string | null | undefined, repoDir: string | null | undefined): string {
    const repo = repoId ? this.options.repos.get(repoId) : undefined;
    const dir = repo?.path ?? repoDir;
    if (!dir) throw new Error("The project folder is unavailable.");
    return dir;
  }

  /** Checks the branch's own commit names in the project's folder, and answers that folder. */
  async validateRange(
    task: TaskRecord | undefined,
    branch: string,
    forge: Forge,
    head = branch,
    fixOf?: string,
  ): Promise<string> {
    return (await this.checkRange(task, branch, forge, head, fixOf)).dir;
  }

  /**
   * `validateRange`, answering also the held version a held batch's fix was measured from
   * (`heldBase`), so its approval can keep it with the repair.
   */
  async checkRange(
    task: TaskRecord | undefined,
    branch: string,
    forge: Forge,
    head = branch,
    fixOf?: string,
  ): Promise<{ dir: string; heldBase?: string }> {
    const repoId = task?.repoId;
    const dir = this.projectDir(repoId, task?.repoDir);
    if (this.options.validateRange) {
      await this.options.validateRange(dir, branch, forge, head);
      return { dir };
    }
    // A held batch's declared fix, on its own task's branch, names its own commits from the
    // held version the combine carries it from, never the members' it builds on; any other
    // change names every commit past the default branch (docs/forge.md, "A held batch").
    const record = repoId && fixOf ? this.batches?.record(repoId) : undefined;
    const entry = [...(record?.line ?? []), ...(record?.open?.members ?? [])].find(
      (change) => change.taskId === fixOf,
    );
    const found =
      record && fixOf && record.fixes?.includes(fixOf)
        ? await fixBase(
            dir,
            head,
            record.fixBases?.[fixOf] ?? entry?.heldBase,
            heldVersions(record),
          )
        : undefined;
    if (found && "lost" in found)
      throw new Error(
        `This change is the held batch's fix, and ${
          found.unread
            ? `the batch's version ${found.lost} it may be built on can no longer be read`
            : `its branch no longer builds on the batch's version ${found.lost} it was verified on`
        }, so its own commits cannot be told from the work it carries. This repair stays measured from that version: ${found.unread ? "once it can be read here again, publish or approve this version again" : "build the fix again on it"}, or leave the batch to a new repair built on its current version.`,
      );
    const base = found?.held ?? (await this.defaultRangeBase(dir, task, forge, head));
    await requireNamedRange(dir, base, head, this.options.namingRule?.() ?? null);
    return { dir, ...(found?.held ? { heldBase: found.held } : {}) };
  }

  /** Read the name and tip together, and only reuse a cached ref at that exact tip. */
  private async defaultRangeBase(
    dir: string,
    task: TaskRecord | undefined,
    forge: Forge,
    head: string,
  ): Promise<string> {
    const registry = task?.repoId ? this.options.repos.get(task.repoId) : undefined;
    const origin = task && registry ? publicationRepo(task, registry).origin : undefined;
    const trackedTip = (tracked: string) =>
      git(dir, ["rev-parse", "--verify", "--quiet", `${tracked}^{commit}`]).catch(() => "");
    if (!origin || !task) {
      const name = await forge.defaultBranch();
      const cached = await trackedTip(`refs/remotes/origin/${name}`);
      return git(dir, ["merge-base", head, cached || name]);
    }
    // A pinned route can outlive the registry address. Keep it out of the checkout's
    // settings and give its cache a separate ref; origin/main belongs to the checkout.
    const pin =
      origin !== registry?.origin ? createHash("sha256").update(origin).digest("hex") : undefined;
    const remote = pin ? `infinitary-range-${pin}` : "origin";
    const config = pin ? [`--config-env=remote.${remote}.url=INFINITARY_RANGE_ORIGIN`] : [];
    const assertOrigin = async () => {
      const configured = await git(
        dir,
        [...config, "config", "--get-all", `remote.${remote}.url`],
        {
          ...(pin ? { env: { INFINITARY_RANGE_ORIGIN: origin } } : {}),
        },
      ).catch(() => undefined);
      if (configured !== origin || this.approvedOrigin(task.id) !== origin)
        throw new Error(
          "The checkout does not use the approved project address. Update its origin and try again.",
        );
    };
    const readOrigin = (args: string[]) =>
      git(dir, [...config, ...args], {
        env: { GIT_TERMINAL_PROMPT: "0", ...(pin ? { INFINITARY_RANGE_ORIGIN: origin } : {}) },
        timeoutMs: 30_000,
      }).catch(() => {
        // Transport diagnostics may contain the configured URL and its sign-in.
        throw new Error("Could not refresh the approved project's default branch from origin.");
      });
    await assertOrigin();
    let name: string | undefined;
    let tip: string | undefined;
    if (pin) {
      const advertised = await readOrigin(["ls-remote", "--exit-code", "--symref", remote, "HEAD"]);
      const lines = advertised.split("\n");
      name = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(advertised)?.[1];
      tip = lines
        .find((line) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/.test(line))
        ?.split("\t")[0];
    } else {
      name = await forge.defaultBranch();
      await assertOrigin();
      const ref = `refs/heads/${name}`;
      const [sha, named] = (
        await readOrigin(["ls-remote", "--exit-code", "--refs", remote, ref])
      ).split("\t");
      if (named === ref && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha ?? "")) tip = sha;
    }
    if (!name || !tip)
      throw new Error("Could not read the approved project's default branch from origin.");
    const tracked = pin ? `refs/infinitary/range/${pin}/${name}` : `refs/remotes/origin/${name}`;
    const cached = await trackedTip(tracked);
    await assertOrigin();
    if (cached !== tip) {
      await readOrigin(["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${name}:${tracked}`]);
      await assertOrigin();
      if ((await trackedTip(tracked)) !== tip)
        throw new Error(
          "The approved project's default branch changed during the refresh. Try again.",
        );
    }
    return git(dir, ["merge-base", head, tip]);
  }
}

/**
 * A new merge review of an open pull request at the version it was read,
 * under a fresh id. `more` carries what this kind of review adds, such as
 * its absence declaration or the rules it skips.
 */
export function reviewOf(
  forge: Forge,
  origin: { host: string; owner: string; name: string },
  pull: {
    number: number;
    headSha: string;
    base: string;
    branch: string;
    title?: string;
    headRepo?: string;
    headRepoId?: number;
  },
  at: number,
  more: Partial<Pick<MergeReview, "repoId" | "absentChecks" | "skips">> = {},
): MergeReview {
  const { repoId, ...added } = more;
  return {
    id: `mr${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    ...(repoId ? { repoId } : {}),
    kind: changeRequestKind(forge.kind) ?? "github",
    host: origin.host,
    owner: origin.owner,
    name: origin.name,
    number: pull.number,
    headSha: pull.headSha,
    ...(pull.headRepo ? { headRepo: pull.headRepo } : {}),
    ...(pull.headRepoId !== undefined ? { headRepoId: pull.headRepoId } : {}),
    base: pull.base,
    branch: pull.branch,
    method: "squash",
    title: pull.title ?? "",
    ...added,
    at,
  };
}

/** A pull request's number in the host's own words: `#N` on GitHub, `!N` on GitLab. */
export function numberLabel(forge: Forge, number: number): string {
  return forge.label({ number, branch: "", headSha: "", url: null });
}

/** The words a change is named by in tool text: "pull request #N" (or `!N`), else the sent-up branch. */
export function changeWords(forge: Forge, change: ForgeChange): string {
  const url = forge.url(change);
  return change.number !== undefined
    ? `pull request ${forge.label(change)}${url ? ` ${url}` : ""}`
    : `the pushed branch ${forge.label(change)}${url ? ` ${url}` : ""}`;
}

/** Where the project lives, in tool text: "on GitHub", "on gitlab.example.com". */
export function placeWords(forge: Forge): string {
  return forge.place ? `on ${forge.place}` : "where the project lives";
}

export function crewSignInText(fact: SignInFact): string {
  return `${notSignedInText(fact.name, fact.host)}. Report this as a blocker: the captain signs in to ${fact.name} in the app's Settings. Do not sign in yourself, and do not look for another way in.`;
}
