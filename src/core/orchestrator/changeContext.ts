import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ChangeRecord } from "@shared/change";
import { notSignedInText } from "@shared/forges";
import { acceptedValidation } from "@shared/liveValidation";
import { MERGE_REVIEW_CAP, type MergeReview } from "@shared/mergeReview";
import { deliveryForRecord, opensPullRequest, type RepoView } from "@shared/repos";
import type { NamingRule } from "../../shared/runbooks";
import { type Forge, type ForgeChange, ForgeError, type ForgePull, type ForgeRepo } from "../forge";
import type { TaskRecord } from "../storage/taskStore";
import type { TaskService } from "../tasks/taskService";
import { requireConventionalRange } from "../workspace/conventional";
import { git } from "../workspace/git";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { ChangePresentations } from "./changePresentations";
import type { LineageFacts, LineageQuestion } from "./mergeAuthorization";
import { reviewCoversHead } from "./reviewCarry";

/**
 * What every owner of a task's change shares (`./changeDelivery.ts`): the
 * task's project and the forge where it lives, the change it names, and the
 * words that name it. The owners read forge facts and record the crew's
 * version-bound declarations; merge identity, consent, host readiness and
 * send-once effects remain host-owned.
 */
export type ChangeDeliveryOptions = {
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
  /** Synchronous: kept proof is checked immediately before the forge send. */
  verifyValidationEvidence?: (taskId: string) => void;
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

/** The checked change, and the forge that answered, for the put-in that follows. */
export type CheckedChange = { change: ForgeChange; forge: Forge };

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
    on: "current" | "own" | { repoId?: string } = "current",
  ): { said: string } | Located {
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
    const review = on === "own" ? undefined : on === "current" ? record.delivery?.checkTarget : on;
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
      return {
        record,
        branch: record.branch,
        forge: this.options.forgeFor(other, other.path),
        repo: other,
        dir: other.path,
        elsewhere: true,
      };
    }
    return {
      record,
      branch: record.branch,
      forge: this.options.forgeFor(repo, dir),
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
    const named = changes.find(
      (item) =>
        item.head.branch === change.branch &&
        (change.number === undefined || item.handle?.number === change.number),
    );
    if (named) return named;
    return change.branch === record.branch ? this.options.tasks.changeFor(record.id) : undefined;
  }

  /**
   * Make the named pull request the task's current change (INF-2490,
   * `primitives/changes.md`): the slot's readings then follow it. The task's
   * own branch needs no selection; any other branch is selected by the
   * review that named it. The review is kept either way.
   */
  select(record: TaskRecord, review: MergeReview): void {
    const kept = [
      review,
      ...(record.delivery?.mergeReviews ?? []).filter((item) => item.id !== review.id),
    ].slice(0, MERGE_REVIEW_CAP);
    const own = review.branch === record.branch;
    this.options.tasks.recordPermissionRecords(record.id, {
      mergeReviews: kept,
      ...(own ? {} : { checkTarget: review }),
    });
    if (own) this.options.tasks.selectOwnChange(record.id, review);
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

  /** Checks the branch's own commit names in the project's folder, and answers that folder. */
  async validateRange(
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
}

/**
 * A new merge review of an open pull request at the version it was read,
 * under a fresh id. `more` carries what this kind of review adds, such as
 * its absence declaration or the rules it skips.
 */
export function reviewOf(
  forge: Forge,
  origin: { host: string; owner: string; name: string },
  pull: { number: number; headSha: string; base: string; branch: string; title?: string },
  at: number,
  more: Partial<Pick<MergeReview, "repoId" | "absentChecks" | "skips">> = {},
): MergeReview {
  const { repoId, ...added } = more;
  return {
    id: `mr${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    ...(repoId ? { repoId } : {}),
    kind: forge.kind === "gitlab" ? "gitlab" : "github",
    host: origin.host,
    owner: origin.owner,
    name: origin.name,
    number: pull.number,
    headSha: pull.headSha,
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

/** What a crewmate hears when the project's host needs the captain's sign-in. */
export function crewSignInText(fact: SignInFact): string {
  return `${notSignedInText(fact.name, fact.host)}. Report this as a blocker: the captain signs in to ${fact.name} in the app's Settings. Do not sign in yourself, and do not look for another way in.`;
}
