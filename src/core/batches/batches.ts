import { randomBytes } from "node:crypto";
import {
  BATCH_BRANCH_PREFIX,
  type BatchAnswer,
  type BatchChange,
  type BatchMember,
  type BatchRecord,
  type BatchStatus,
  EMPTY_BATCH_RECORD,
  keepsCommits,
  type MergeWays,
  mergeWayFor,
  type OpenBatch,
  SQUASH_ONLY_WORDS,
} from "@shared/batches";
import { checkSnapshotSummary, isRedCheckState } from "@shared/checkSnapshot";
import type { RepoView } from "@shared/repos";
import type { NamingRule } from "@shared/runbooks";
import {
  type Forge,
  type ForgeChange,
  ForgeError,
  ForgeWriteError,
  isSignInForgeFailure,
  isTransientForgeFailure,
} from "../forge";
import { gitFailure } from "../workspace/git";
import { composedName } from "../workspace/naming";
import type { RepoRegistry } from "../workspace/repoRegistry";
import {
  type Combined,
  type CombineInput,
  combine as combineChanges,
  landedCommits,
  pushBatch,
} from "./combine";
import {
  batchStatus,
  carried,
  combined,
  enqueue,
  fixWaits,
  forms,
  hold,
  merged,
  pruned,
  release,
  reopened,
  reworded,
  type Standing,
  standing,
  withdraw,
} from "./line";

/** The words a batch puts on the Activity feed and its tasks, from one owner. */
export const BATCH_WORDS = {
  formed: (name: string, label: string, changes: number) =>
    changes === 1
      ? `${name}: an approved change went up as ${label}.`
      : `${name}: ${changes} approved changes went up as one batch, ${label}.`,
  merged: (name: string, label: string, changes: number) =>
    changes === 1
      ? `${name}: ${label} merged.`
      : `${name}: ${label} merged with ${changes} changes, one commit each.`,
  held: (name: string, label: string, checks: readonly string[]) =>
    `${name}: ${label} is held because ${checks.length ? `${checks.join(", ")} failed` : "its checks failed"}. Changes approved meanwhile wait for it.`,
  noWay: (name: string, label: string) =>
    `${name}: ${label} is held because the project allows no merge that keeps one commit for each change.`,
  refused: (name: string, label: string, detail: string) =>
    `${name}: ${label} is held because the merge was refused where the project lives: ${detail}`,
  queued: (name: string, label: string, place: string) =>
    `${name}: ${place} took ${label} into the main branch's merge queue. It merges there once the queue's checks pass.`,
  removed: (place: string) =>
    `${place} removed the pull request from its merge queue without merging it; its page there says why.`,
  blocked: (name: string, label: string, place: string) =>
    `${name}: ${label} passed its checks, and ${place} holds it for a required review or another rule on the main branch. It merges once that rule lets it through.`,
  retried: (name: string, label: string) =>
    `${name}: ${label} was combined again and its checks run again.`,
  noStory: (name: string, label: string, titles: readonly string[]) =>
    `${name}: ${label} is open without the story of ${titles.map((title) => `"${title}"`).join(" and ")}, which could not be added to its description. It is added as soon as it can be.`,
  sentBack: (name: string, title: string, reason: string) =>
    `${name}: "${title}" was sent back from its batch: ${reason}`,
  leftOut: (reason: string) =>
    `This change was left out of its batch because ${reason}. Bring the branch up to date and show a new version; the other changes went on.`,
  sentBackTask: (reason: string) =>
    `This change was sent back from its batch and is no longer approved: ${reason}`,
  superseded: (label: string, link: string | null) =>
    `This change merged as part of ${label}${link ? ` (${link})` : ""}, so this pull request is closed.`,
  ended:
    "That batch is no longer held at that version, so nothing was done; Settings shows it as it is now.",
  notMember: (task: string) => `${task} is not in the held batch, so nothing was sent back.`,
} as const;

/**
 * The batch pull request's title. A batch of one carries its change's own.
 * A batch of several says how many it carries in the app's plain words, in
 * the form the active naming runbook gives a name the app writes itself; the
 * app holds no naming form of its own (docs/runbooks.md, "Built-ins").
 */
export function batchTitle(
  members: readonly Pick<BatchChange, "title">[],
  naming: NamingRule | null,
): string {
  return members.length === 1
    ? (members[0] as Pick<BatchChange, "title">).title
    : composedName(`merge ${members.length} approved changes`, naming);
}

export type BatchHeld = {
  repo: RepoView;
  batch: OpenBatch;
};

export type BatchesOptions = {
  repos: Pick<RepoRegistry, "get" | "list" | "recordBatch">;
  forgeFor: (repo: RepoView) => Forge;
  now: () => number;
  /** The active naming runbook's rule, read at each use; null when no naming runbook is on. */
  naming: () => NamingRule | null;
  /** Whether a task's approval still stands at this version: only approved work merges. */
  approved: (taskId: string, head: string) => boolean;
  /** Whether the task's crew declared that this version runs no checks at all. */
  runsNoChecks: (taskId: string, head: string) => boolean;
  /** Whether a task is still open: a closed task's receipts and notes are dropped. */
  live: (taskId: string) => boolean;
  /** A member's story as the batch's pull request shows it, with the words around it. */
  story: (
    member: BatchChange,
    forge: Forge,
  ) => Promise<{ region: string; projectText: string } | undefined>;
  /**
   * These tasks' standing changed (merged, left out, the only change of a
   * failed batch): each one's kept merge runs again and reads it.
   */
  settle: (taskIds: string[]) => void;
  /** A change was sent back with a reason: it loses its approval and its crewmate hears why. */
  sentBack: (change: BatchMember, reason: string) => void;
  /** A batch of several is held: the first mate hears it once. */
  held: (held: BatchHeld) => void;
  note: (text: string) => void;
  taskNote: (taskId: string, text: string) => void;
  combine?: (input: CombineInput) => Promise<Combined>;
  push?: typeof pushBatch;
  landed?: typeof landedCommits;
  /** A new batch branch's name; injectable for a test. */
  branchName?: () => string;
};

/**
 * Batches of your own (docs/forge.md, "Batches of your own"): the one
 * writer of a project's line of approved changes and its one open batch.
 * An approved change is a pushed branch with no pull request of its own.
 * When the line holds a change and no batch of this home's is open, the
 * whole line is combined at home, one commit per change, pushed to a
 * branch the app owns and opened as one pull request with the captain's
 * sign-in. The host's own reading decides what happens next: checks passed
 * and mergeable merges it; behind or conflicting combines it again; failed
 * checks hold it until a change is sent back, a declared fix is approved,
 * or its checks run again. The app reruns nothing and files nothing.
 */
export class Batches {
  /** One pass per project at a time; a pass asked for meanwhile runs after it. */
  private readonly passes = new Map<string, Promise<void>>();
  /**
   * The version of each project's open batch whose pull request this run
   * read carrying the batch's own title and description. Nothing is kept
   * across a restart, so the first pass after one reads it again.
   */
  private readonly described = new Map<string, string>();
  /** The changes of each project whose missing story this run already said, by task and version. */
  private readonly storyless = new Map<string, Set<string>>();

  constructor(private readonly options: BatchesOptions) {}

  record(repoId: string): BatchRecord {
    return this.options.repos.get(repoId)?.batch ?? EMPTY_BATCH_RECORD;
  }

  /** What a change's own merge reads of its place; undefined when it has none at that version. */
  standing(repoId: string, taskId: string, head: string): Standing | undefined {
    return standing(this.record(repoId), taskId, head);
  }

  /** A change's place as its batch check says it; undefined when it has none at that version. */
  status(repoId: string, taskId: string, head: string): BatchStatus | undefined {
    const place = this.standing(repoId, taskId, head);
    return place ? batchStatus(place) : undefined;
  }

  /** Put an approved change in line and start a pass. */
  async enqueue(repoId: string, change: BatchChange): Promise<void> {
    await this.write(repoId, (record) => {
      const fix = Boolean(record.open?.hold) && (record.fixes ?? []).includes(change.taskId);
      return enqueue(record, fix ? { ...change, fix: true } : change);
    });
    void this.pass(repoId);
  }

  /** A task's approval ended, or the task closed: its change leaves the line and the batch. */
  async withdraw(repoId: string, taskId: string): Promise<void> {
    const changed = await this.write(repoId, (record) => {
      const next = withdraw(record, taskId);
      return JSON.stringify(next) === JSON.stringify(record) ? record : next;
    });
    if (changed) void this.pass(repoId);
  }

  /**
   * A change's story was confirmed on its pushed branch at `head`, as a
   * story revised under a kept approval is. The version already waiting
   * keeps its place and takes the story's title and words, and the pull
   * request that carries it is described again from the story as it reads
   * now; any other version of the task leaves the line and the batch.
   */
  async revise(
    repoId: string,
    change: Pick<BatchChange, "taskId" | "head" | "title" | "body">,
  ): Promise<void> {
    let member = false;
    const changed = await this.write(repoId, (record) => {
      const next = reworded(record, change);
      member = Boolean(next.open?.members.some((entry) => entry.taskId === change.taskId));
      // A story can read differently under the same title and words.
      if (member) this.described.delete(repoId);
      return JSON.stringify(next) === JSON.stringify(record) ? record : next;
    });
    if (changed || member) void this.pass(repoId);
  }

  /**
   * A repair declares its own change the held batch's fix: once approved,
   * it joins that batch and ends the hold. Refused in words when no batch
   * of this project is held.
   */
  async declareFix(repoId: string, taskId: string): Promise<string | undefined> {
    let refused: string | undefined;
    await this.write(repoId, (record) => {
      if (!record.open?.hold) {
        refused = "No batch of this project is held, so there is nothing to fix.";
        return record;
      }
      return (record.fixes ?? []).includes(taskId)
        ? record
        : { ...record, fixes: [...(record.fixes ?? []), taskId] };
    });
    return refused;
  }

  /**
   * A by-hand answer to a held batch, from Settings or a repair. Try again
   * combines the batch again at a new version, so its checks run again; a
   * send-back takes each named change out with its reason, and the rest
   * combine again with the line. Answers the refusal in words, or nothing.
   */
  async answer(repoId: string, answer: BatchAnswer): Promise<string | undefined> {
    return this.serial(repoId, async () => {
      const repo = this.options.repos.get(repoId);
      const record = this.record(repoId);
      const open = record.open;
      if (!repo || !open?.hold || open.hold.head !== answer.head) return BATCH_WORDS.ended;
      const label = this.label(repo, open);
      if (answer.action === "try-again") {
        await this.recombine(repo, release(record), "none");
        this.options.note(BATCH_WORDS.retried(repo.name, label));
        return undefined;
      }
      const missing = answer.changes.find(
        (change) => !open.members.some((member) => member.taskId === change.taskId),
      );
      if (missing) return BATCH_WORDS.notMember(missing.taskId);
      let next = record;
      for (const change of answer.changes) {
        const member = open.members.find((entry) => entry.taskId === change.taskId) as BatchMember;
        next = withdraw(next, change.taskId);
        this.options.note(BATCH_WORDS.sentBack(repo.name, member.title, change.reason));
        this.options.taskNote(change.taskId, BATCH_WORDS.sentBackTask(change.reason));
        this.options.sentBack(member, change.reason);
      }
      this.save(repoId, next);
      await this.recombine(repo, next, "line");
      return undefined;
    });
  }

  /** The same answer for Settings, where a refusal fails the request with its words. */
  async answerOrThrow(repoId: string, answer: BatchAnswer): Promise<{ ok: true }> {
    const refused = await this.answer(repoId, answer);
    if (refused) throw new Error(refused);
    return { ok: true };
  }

  /** Every project with a line, a batch or receipts takes one pass. */
  async sweep(): Promise<void> {
    await Promise.all(
      this.options.repos
        .list()
        .filter((repo) => repo.batch !== undefined)
        .map((repo) => this.pass(repo.id)),
    );
  }

  /** One step of a project's line and batch, from what the host reads now. */
  pass(repoId: string): Promise<void> {
    return this.serial(repoId, () => this.step(repoId)).catch((caught: unknown) => {
      // A sign-in, the network or a busy host: the next pass reads again.
      if (!isSignInForgeFailure(caught) && !isTransientForgeFailure(caught))
        console.warn(
          `[batches] ${repoId}: ${caught instanceof ForgeError ? caught.message : gitFailure(caught)}`,
        );
    });
  }

  /**
   * One change to a project's record, in turn with its passes. A pass
   * carries the record it read through its work where the project lives
   * and saves what it derived, so a change written beside a running pass
   * would be lost at that save: every writer takes its turn instead.
   * Answers whether the record changed.
   */
  private write(repoId: string, change: (record: BatchRecord) => BatchRecord): Promise<boolean> {
    return this.serial(repoId, async () => {
      const record = this.record(repoId);
      const next = change(record);
      if (next === record) return false;
      this.save(repoId, next);
      return true;
    });
  }

  private async serial<T>(repoId: string, run: () => Promise<T>): Promise<T> {
    const prior = this.passes.get(repoId) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(run);
    const settled = next.then(
      () => {},
      () => {},
    );
    this.passes.set(repoId, settled);
    try {
      return await next;
    } finally {
      if (this.passes.get(repoId) === settled) this.passes.delete(repoId);
    }
  }

  private async step(repoId: string): Promise<void> {
    const repo = this.options.repos.get(repoId);
    if (!repo) return;
    let record = pruned(this.record(repoId), this.options.live);
    // A member whose approval ended since it joined is carried no further.
    for (const entry of [...record.line, ...(record.open?.members ?? [])])
      if (!this.options.approved(entry.taskId, entry.head)) record = withdraw(record, entry.taskId);
    this.save(repoId, record);
    if (record.open) record = await this.follow(repo, record);
    if (forms(record)) await this.recombine(repo, record, "none");
  }

  /** The open batch, from the host's reading of its pull request and checks. */
  private async follow(repo: RepoView, record: BatchRecord): Promise<BatchRecord> {
    const forge = this.options.forgeFor(repo);
    let open = record.open as OpenBatch;
    // Every member left: the line takes the batch's branch and pull request, or it ends.
    if (open.members.length === 0)
      return record.line.length
        ? this.recombine(repo, record, "line")
        : this.abandon(repo, record, forge);
    if (open.number === undefined) {
      // A crash between the push and the pull request's confirmation: read before writing.
      const found = await forge.changeFor(open.branch);
      const opened = found ? undefined : await this.openRequest(open, forge);
      const change = found ?? (opened as { change: ForgeChange }).change;
      if (change.number === undefined) return record;
      open = { ...open, number: change.number, url: forge.url(change) };
      record = this.save(repo.id, { ...record, open });
      this.options.note(BATCH_WORDS.formed(repo.name, this.label(repo, open), open.members.length));
      // A pull request this pass opened carries the batch's words as sent.
      if (opened) this.wrote(repo, open, opened.missing);
    }
    if (!forge.pull) return record;
    const pull = await forge.pull(open.number as number);
    if (pull.merged) return this.finish(repo, record, pull.mergedSha);
    if (pull.state === "closed") {
      // Closed where the project lives without a merge: the changes go back in line.
      await forge.deleteBranch?.(open.branch).catch(() => {});
      return this.save(repo.id, reopened(record));
    }
    if (open.stale) return this.recombine(repo, record, "none");
    if (pull.headSha !== open.head) {
      // A pull request can trail its branch for a moment after a push: the
      // next pass reads on. A branch that itself is elsewhere carries a
      // version this record never kept (a push whose record was lost, or a
      // commit that is no approved change), so the batch is combined again
      // over what the host holds now.
      const pushed = await this.pushedHead(forge, open.branch);
      if (pushed === open.head) return record;
      return this.recombine(repo, record, "none", pushed);
    }
    if (open.queued === open.head && forge.inHostQueue) {
      // The host's own merge queue took this version: it is read there, never sent again.
      if (await forge.inHostQueue(open.number as number)) return record;
      // The host may have merged or closed it between the two reads.
      const after = await forge.pull(open.number as number);
      if (after.merged) return this.finish(repo, record, after.mergedSha);
      if (after.state !== "open") return record;
      // Removed without a merge: held with the host's verdict until a person answers.
      const { queued: _queued, ...left } = open;
      const detail = BATCH_WORDS.removed(forge.place ?? "The project's host");
      const held = hold(
        { ...record, open: left },
        { at: this.options.now(), head: open.head, reason: "merge-way", checks: [], detail },
      );
      this.save(repo.id, held.record);
      if (held.fresh)
        this.options.note(BATCH_WORDS.refused(repo.name, this.label(repo, open), detail));
      return held.record;
    }
    if (fixWaits(record)) return this.recombine(repo, record, "fixes");
    if (this.described.get(repo.id) !== open.head) await this.describe(repo, open, forge);
    const change: ForgeChange = {
      number: pull.number,
      url: open.url ?? null,
      branch: open.branch,
      headSha: open.head,
      title: pull.title ?? this.title(open.members),
    };
    const checks = await forge.checks(change);
    // The same reading a change's own pull request takes: every check passed
    // or skipped is green, and a reading where no check ran - none at all, or
    // only skipped ones - is green only where every member's own version was
    // declared to run none.
    const summary = checkSnapshotSummary({
      headSha: open.head,
      items: checks.items,
      ...(checks.complete !== undefined ? { complete: checks.complete } : {}),
      ...(checks.problem ? { problem: checks.problem } : {}),
      absenceDeclared: open.members.every((member) =>
        this.options.runsNoChecks(member.taskId, member.head),
      ),
    });
    const failed = checks.items.filter((item) => isRedCheckState(item.state));
    if (summary.overall === "red") {
      const held = hold(record, {
        at: this.options.now(),
        head: open.head,
        reason: "checks",
        checks: failed.map((item) => item.name),
      });
      if (held.fresh) this.heldNow(repo, this.save(repo.id, held.record));
      return held.record;
    }
    // Checks that run again end a hold of failed checks: the repair judged a flake.
    if (open.hold?.reason === "checks") record = this.save(repo.id, release(record));
    if (summary.overall === "pending") return record;
    // The host's own reading of a moved default branch, with no rule of the app's.
    if (pull.readiness === "behind" || pull.readiness === "conflict")
      return this.recombine(repo, record, "none");
    // A merge the host refused at this version is never sent again: Try again makes a new one.
    if (open.hold?.reason === "merge-way" && open.hold.head === open.head && open.hold.detail)
      return record;
    // A rule of the default branch holds it, such as a required review or
    // signed commits: nothing is sent, and the batch says so once.
    if (pull.readiness === "blocked") {
      const held = hold(record, {
        at: this.options.now(),
        head: open.head,
        reason: "rules",
        checks: [],
      });
      if (held.fresh) {
        this.save(repo.id, held.record);
        this.options.note(
          BATCH_WORDS.blocked(
            repo.name,
            this.label(repo, open),
            forge.place ?? "the project's host",
          ),
        );
      }
      return held.record;
    }
    // The host lets it through again: a hold of its rules ends by itself.
    if (open.hold?.reason === "rules") record = this.save(repo.id, release(record));
    if (pull.readiness !== "clean") return record;
    return this.merge(repo, record, forge, change);
  }

  /** Merge at the batch's version, keeping one commit per change. */
  private async merge(
    repo: RepoView,
    followed: BatchRecord,
    forge: Forge,
    change: ForgeChange,
  ): Promise<BatchRecord> {
    const open = followed.open as OpenBatch;
    const ways = await this.ways(repo, forge);
    // The read keeps the allowed merges on the saved record; this pass's copy carries them too.
    const record = ways ? { ...followed, ways } : followed;
    const way = ways ? mergeWayFor(ways, open.members.length) : undefined;
    if (!way) {
      const held = hold(record, {
        at: this.options.now(),
        head: open.head,
        reason: "merge-way",
        checks: [],
      });
      if (held.fresh) {
        this.save(repo.id, held.record);
        this.options.note(BATCH_WORDS.noWay(repo.name, this.label(repo, open)));
      }
      return held.record;
    }
    // The last look: every member is still approved at the version the batch carries.
    if (open.members.some((member) => !this.options.approved(member.taskId, member.head))) {
      let next = record;
      for (const member of open.members)
        if (!this.options.approved(member.taskId, member.head))
          next = withdraw(next, member.taskId);
      return this.recombine(repo, this.save(repo.id, next), "none");
    }
    const only = open.members.length === 1 ? (open.members[0] as BatchMember) : undefined;
    let sha: string | undefined;
    try {
      const answer = await forge.putIn(
        {
          ...change,
          title: only ? only.title : this.title(open.members),
          squashMessage: only ? only.body : this.listed(open.members),
        },
        open.head,
        way,
      );
      if (answer?.queued) {
        // The branch's own merge queue took it: the host merges or removes it, and the passes read which.
        const { hold: _hold, ...waiting } = open;
        const next = this.save(repo.id, { ...record, open: { ...waiting, queued: open.head } });
        this.options.note(
          BATCH_WORDS.queued(
            repo.name,
            this.label(repo, open),
            forge.place ?? "the project's host",
          ),
        );
        return next;
      }
      sha = answer?.sha;
    } catch (caught) {
      if (!(caught instanceof ForgeError) || caught.failure !== "refused") throw caught;
      // The host's verdict on the merge itself: held with its own words, never sent again.
      const held = hold(record, {
        at: this.options.now(),
        head: open.head,
        reason: "merge-way",
        checks: [],
        detail: caught.message,
      });
      if (held.fresh) {
        this.save(repo.id, held.record);
        this.options.note(BATCH_WORDS.refused(repo.name, this.label(repo, open), caught.message));
      }
      return held.record;
    }
    return this.finish(repo, record, sha, way === "squash" ? sha : undefined);
  }

  /** The batch merged: receipts, superseded pull requests, the batch branch, then the tasks. */
  private async finish(
    repo: RepoView,
    record: BatchRecord,
    mergedSha: string | undefined,
    squashed?: string,
  ): Promise<BatchRecord> {
    const open = record.open as OpenBatch;
    const forge = this.options.forgeFor(repo);
    const landed =
      squashed && open.members.length === 1
        ? new Map([[(open.members[0] as BatchMember).taskId, squashed]])
        : await (this.options.landed ?? landedCommits)({
            repoDir: repo.path,
            defaultBranch: await forge.defaultBranch(),
            members: open.members,
            ...(mergedSha ? { merged: mergedSha } : {}),
          });
    const label = this.label(repo, open);
    const { fixes: _fixes, ...next } = merged(record, landed, this.options.now());
    const saved = this.save(repo.id, next);
    this.options.note(BATCH_WORDS.merged(repo.name, label, open.members.length));
    for (const member of open.members) {
      if (member.number === undefined || !forge.closeWithNote) continue;
      // The change's own pull request carries commits the batch rewrote, so the host leaves it open.
      await forge
        .closeWithNote(
          { number: member.number, branch: member.branch, headSha: member.head, url: null },
          BATCH_WORDS.superseded(label, open.url ?? null),
        )
        .catch((caught: unknown) =>
          console.warn(`[batches] closing ${member.branch}'s pull request: ${String(caught)}`),
        );
    }
    await forge.deleteBranch?.(open.branch).catch(() => {});
    this.options.settle(open.members.map((member) => member.taskId));
    return saved;
  }

  /** Every member was withdrawn: close the pull request and drop the branch. */
  private async abandon(repo: RepoView, record: BatchRecord, forge: Forge): Promise<BatchRecord> {
    const open = record.open as OpenBatch;
    if (open.number !== undefined)
      await forge.close({
        number: open.number,
        branch: open.branch,
        headSha: open.head,
        url: open.url ?? null,
      });
    await forge.deleteBranch?.(open.branch).catch(() => {});
    const { open: _open, fixes: _fixes, ...rest } = record;
    return this.save(repo.id, rest);
  }

  /**
   * Combine onto the freshly fetched default branch and push the batch
   * branch: a new batch from the whole line, or the open batch again, with
   * the declared fixes or the line behind it.
   */
  private async recombine(
    repo: RepoView,
    record: BatchRecord,
    join: "none" | "fixes" | "line",
    /** The batch branch's version as the host holds it now, where that is not the recorded one. */
    pushed?: string,
  ): Promise<BatchRecord> {
    const forge = this.options.forgeFor(repo);
    const changes = carried(record, join);
    if (changes.length === 0) return record.open ? this.abandon(repo, record, forge) : record;
    const at = this.options.now();
    const result = await (this.options.combine ?? combineChanges)({
      repoDir: repo.path,
      defaultBranch: await forge.defaultBranch(),
      changes,
      at,
    });
    const branch =
      record.open?.branch ??
      (
        this.options.branchName ?? (() => `${BATCH_BRANCH_PREFIX}${randomBytes(4).toString("hex")}`)
      )();
    if (result.members.length)
      await (this.options.push ?? pushBatch)({
        repoDir: repo.path,
        branch,
        head: result.head,
        expected: pushed ?? record.open?.head ?? null,
      });
    const { fixes: _fixes, ...kept } = release(record);
    let next = this.save(repo.id, combined(kept, result, { branch, at }));
    for (const left of result.leftOut)
      this.options.taskNote(left.change.taskId, BATCH_WORDS.leftOut(left.reason));
    if (result.leftOut.length)
      this.options.settle(result.leftOut.map((left) => left.change.taskId));
    if (!next.open) {
      // Nothing combined: an open batch has nothing left to carry.
      if (record.open)
        next = await this.abandon(repo, { ...next, open: { ...record.open, members: [] } }, forge);
      return next;
    }
    return this.follow(repo, next);
  }

  /** Open the batch's pull request with the captain's sign-in. */
  private async openRequest(
    open: OpenBatch,
    forge: Forge,
  ): Promise<{ change: ForgeChange; missing: BatchMember[] }> {
    const { body, missing } = await this.body(open, forge);
    const change = await forge.openChange({
      branch: open.branch,
      title: this.title(open.members),
      body,
    });
    return { change, missing };
  }

  /** The batch branch's version where the project lives; undefined when it is not there. */
  private async pushedHead(forge: Forge, branch: string): Promise<string | undefined> {
    if (!forge.branchHead) return undefined;
    try {
      return await forge.branchHead(branch);
    } catch (caught) {
      // The host's refusal is its answer for a branch that is gone.
      if (caught instanceof ForgeError && caught.failure === "refused") return undefined;
      throw caught;
    }
  }

  /**
   * Give the open pull request the batch's own title and description once
   * its members changed. A host replaces a description only at the version,
   * words and title just read, so the pull request is read first; a rewrite
   * the host did not take is sent again on the next pass.
   */
  private async describe(repo: RepoView, open: OpenBatch, forge: Forge): Promise<void> {
    if (!forge.updateChangeBody || open.number === undefined) return;
    const held = await forge.changeFor(open.branch);
    if (!held || held.number !== open.number || held.headSha !== open.head) return;
    const { body, missing } = await this.body(open, forge);
    const title = this.title(open.members);
    if ((held.body ?? "") !== body || held.title !== title) {
      try {
        await forge.updateChangeBody(held, body, title);
      } catch (caught) {
        // The pull request changed between the read and the write: the next pass reads it again.
        if (
          caught instanceof ForgeWriteError &&
          caught.outcome === "failed" &&
          caught.failure === "refused"
        )
          return;
        throw caught;
      }
    }
    this.wrote(repo, open, missing);
  }

  /**
   * The pull request holds the batch's words at this version. With every
   * story in them, nothing is written again until the batch changes. A story
   * that could not be written is said once for that version of its change,
   * and the description is written again on each pass until it is there.
   */
  private wrote(repo: RepoView, open: OpenBatch, missing: readonly BatchMember[]): void {
    if (missing.length === 0) {
      this.described.set(repo.id, open.head);
      this.storyless.delete(repo.id);
      return;
    }
    const said = this.storyless.get(repo.id) ?? new Set<string>();
    const fresh = missing.filter((member) => !said.has(`${member.taskId} ${member.head}`));
    if (fresh.length === 0) return;
    for (const member of fresh) said.add(`${member.taskId} ${member.head}`);
    this.storyless.set(repo.id, said);
    this.options.note(
      BATCH_WORDS.noStory(
        repo.name,
        this.label(repo, open),
        fresh.map((member) => member.title),
      ),
    );
  }

  /**
   * The pull request's description, and the changes whose story could not
   * be written into it this time. A batch of one reads as that change's own
   * pull request does: the words around its story, then the story. A batch
   * of several lists its changes, then carries each one's story.
   */
  private async body(
    open: OpenBatch,
    forge: Forge,
  ): Promise<{ body: string; missing: BatchMember[] }> {
    const stories = await Promise.all(
      open.members.map((member) => this.options.story(member, forge).catch(() => undefined)),
    );
    const missing = open.members.filter((_member, index) => !stories[index]);
    if (open.members.length === 1)
      return {
        body: [stories[0]?.projectText, stories[0]?.region].filter(Boolean).join("\n\n"),
        missing,
      };
    return {
      body: [
        `This pull request carries ${open.members.length} approved changes as one batch. Each merges as its own commit, in this order:`,
        this.listed(open.members),
        ...stories.flatMap((story) => (story ? [story.region] : [])),
      ].join("\n\n"),
      missing,
    };
  }

  private title(members: readonly BatchMember[]): string {
    return batchTitle(members, this.options.naming());
  }

  private listed(members: readonly BatchMember[]): string {
    return members.map((member) => `- ${member.title}`).join("\n");
  }

  /** The merges the project allows, read now within a pass and kept for Settings. */
  private async ways(repo: RepoView, forge: Forge): Promise<MergeWays | undefined> {
    if (!forge.mergeWays) return undefined;
    const ways = await forge.mergeWays();
    const record = this.record(repo.id);
    if (JSON.stringify(record.ways) !== JSON.stringify(ways))
      this.save(repo.id, { ...record, ways });
    return ways;
  }

  /** Read a project's allowed merges where it lives and keep them, for the choice in Settings. */
  async readWays(repoId: string): Promise<MergeWays | undefined> {
    const repo = this.options.repos.get(repoId);
    const forge = repo ? this.options.forgeFor(repo) : undefined;
    if (!forge?.mergeWays) return undefined;
    const ways = await forge.mergeWays();
    await this.write(repoId, (record) =>
      JSON.stringify(record.ways) === JSON.stringify(ways) ? record : { ...record, ways },
    );
    return ways;
  }

  /**
   * Refuses the choice of batched pull requests for a project that allows
   * only squash merges, with its reason: a batch keeps one commit for each
   * change. A project whose merges cannot be read is not refused here.
   */
  async refuseSquashOnly(repoId: string): Promise<void> {
    const ways = await this.readWays(repoId).catch(() => undefined);
    if (ways && !keepsCommits(ways)) throw new Error(SQUASH_ONLY_WORDS);
  }

  /** A fresh hold of failed checks: its one change's own crewmate, or the first mate once. */
  private heldNow(repo: RepoView, record: BatchRecord): void {
    const open = record.open as OpenBatch;
    this.options.note(BATCH_WORDS.held(repo.name, this.label(repo, open), open.hold?.checks ?? []));
    if (open.members.length === 1) this.options.settle([(open.members[0] as BatchMember).taskId]);
    else this.options.held({ repo, batch: open });
  }

  private label(repo: RepoView, open: OpenBatch): string {
    const forge = this.options.forgeFor(repo);
    return open.number === undefined
      ? "a batch"
      : forge.label({ number: open.number, branch: open.branch, headSha: open.head, url: null });
  }

  private save(repoId: string, record: BatchRecord): BatchRecord {
    this.options.repos.recordBatch(repoId, record);
    return record;
  }
}
