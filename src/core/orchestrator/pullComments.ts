import { createHash } from "node:crypto";
import type { BatchMember, OpenBatch } from "@shared/batches";
import {
  type CommentCursor,
  PULL_REQUEST_COMMENTS_WAKE,
  type PullCommentFact,
} from "@shared/pullComments";
import type { RepoView } from "@shared/repos";
import type { Forge, ForgePull, ForgePullComment } from "../forge";
import { currentChange } from "../storage/changeProjection";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { type ChangeContext, numberLabel } from "./changeContext";

/**
 * Comments on a pull request (docs/forge.md, "Comments on a pull request"):
 * while a runbook that asks for the comment wake is on, the quiet refresh
 * reads new comments on each live task's pull request, and each pass of a
 * batch reads its batch's, only when the host's last-changed time moved.
 * New comments by others reach the crewmate as one wake per reading,
 * naming each one's id, kind, author, the author's relation and place,
 * never its words. Every judgment about them is the runbook's.
 */
export class PullComments {
  constructor(
    private readonly context: ChangeContext,
    /** Whether an enabled runbook asks for the comment wake, read at each use. */
    private readonly watched: () => boolean,
  ) {}

  private get options() {
    return this.context.options;
  }

  /** One reading of the task's own current pull request, from the quiet refresh. */
  async readTask(taskId: string): Promise<void> {
    if (!this.watched()) return;
    const record = this.options.tasks.get(taskId);
    if (!record || TaskService.isClosed(record) || !told(record)) return;
    const located = this.context.locate(taskId);
    if ("said" in located) return;
    const { forge } = located;
    const number = currentChange(record.delivery, located.branch).number;
    if (number === undefined || !forge.pull || !forge.pullComments) return;
    const pull = await forge.pull(number);
    if (pull.merged || pull.state !== "open") return;
    const before = record.delivery?.commentCursor;
    const cursor = before?.number === number ? before : undefined;
    const read = await this.newComments(
      forge,
      pull,
      cursor,
      () => new Set(this.options.tasks.get(taskId)?.delivery?.sentComments),
    );
    if (!read) return;
    if (read.fresh.length > 0)
      this.wake(taskId, numberLabel(forge, number), number, read.fresh.map(factOf));
    this.options.tasks.delivery.recordChangeEvidence(taskId, { commentCursor: read.cursor });
  }

  /**
   * One reading of a batch's pull request, from the batch's pass: each new
   * comment goes to the changes whose commit touches the file it is on, or
   * to every change of the batch when it names no file or none matches.
   * The batch's cursor is kept on each of its changes' tasks.
   */
  async readBatch(input: {
    repo: RepoView;
    open: OpenBatch;
    pull: ForgePull;
    forge: Forge;
  }): Promise<void> {
    const { open, pull, forge } = input;
    if (!this.watched() || !forge.pullComments || open.number === undefined) return;
    if (pull.merged || pull.state !== "open") return;
    const number = open.number;
    const members = open.members.filter((member) => {
      const record = this.options.tasks.get(member.taskId);
      return record !== undefined && told(record);
    });
    if (members.length === 0) return;
    const cursor = open.members
      .map((member) => this.options.tasks.get(member.taskId)?.delivery?.commentCursor)
      .find((kept) => kept?.number === number);
    const own = () =>
      new Set(
        open.members.flatMap(
          (member) => this.options.tasks.get(member.taskId)?.delivery?.sentComments ?? [],
        ),
      );
    const read = await this.newComments(forge, pull, cursor, own);
    if (!read) return;
    const files = new Map<string, Promise<string[]>>();
    const touched = (member: BatchMember): Promise<string[]> => {
      let found = files.get(member.commit);
      if (!found) {
        found = forge.commitFiles
          ? forge.commitFiles(member.commit).catch(() => [])
          : Promise.resolve([]);
        files.set(member.commit, found);
      }
      return found;
    };
    const given = new Map<string, PullCommentFact[]>();
    for (const comment of read.fresh) {
      let to = open.members;
      if (comment.path && open.members.length > 1) {
        const path = comment.path;
        const about: BatchMember[] = [];
        for (const member of open.members)
          if ((await touched(member)).includes(path)) about.push(member);
        // A file no change of the batch touched is about every change.
        if (about.length > 0) to = about;
      }
      for (const member of to)
        given.set(member.taskId, [...(given.get(member.taskId) ?? []), factOf(comment)]);
    }
    const change = numberLabel(forge, number);
    for (const member of members) {
      const comments = given.get(member.taskId);
      if (comments)
        this.wake(member.taskId, change, number, comments, {
          commit: member.commit,
          changes: open.members.length,
        });
      this.options.tasks.delivery.recordChangeEvidence(member.taskId, {
        commentCursor: read.cursor,
      });
    }
  }

  /**
   * The comments new since the cursor, left out the task's own and the
   * app's story comment, read after GitHub answers so a reply sent during
   * the reading counts as the task's own; undefined while the pull request has not changed
   * since the cursor's reading, so no comment is asked for.
   */
  private async newComments(
    forge: Forge,
    pull: ForgePull,
    cursor: CommentCursor | undefined,
    sent: () => ReadonlySet<number>,
  ): Promise<{ fresh: ForgePullComment[]; cursor: CommentCursor } | undefined> {
    if (!forge.pullComments) return undefined;
    if (cursor && pull.updatedAt !== undefined && cursor.updatedAt === pull.updatedAt)
      return undefined;
    const comments = await forge.pullComments(pull.number, cursor?.updatedAt);
    const own = sent();
    const seen = new Set(cursor?.seen);
    const fresh = comments.filter(
      (comment) =>
        !seen.has(comment.id) &&
        !own.has(comment.id) &&
        !(comment.reviewId !== undefined && own.has(comment.reviewId)) &&
        !comment.story &&
        !comment.empty,
    );
    for (const comment of comments) seen.add(comment.id);
    return {
      fresh,
      cursor: {
        number: pull.number,
        ...(pull.updatedAt !== undefined ? { updatedAt: pull.updatedAt } : {}),
        seen: [...seen],
      },
    };
  }

  /** One wake per reading, named by the comments it carries so the inbox queues it once. */
  private wake(
    taskId: string,
    change: string,
    number: number,
    comments: PullCommentFact[],
    batch?: { commit: string; changes: number },
  ): void {
    const ids = comments.map((comment) => comment.id).join(",");
    const once = `pull-comments:${number}:${createHash("sha256").update(ids).digest("hex").slice(0, 16)}`;
    this.options.steer?.(taskId, {
      facts: { kind: "pull-comments", change, comments, ...(batch ? { batch } : {}) },
      once,
    });
  }
}

/** Whether the guidance the task's crewmate was served asks for the comment wake. */
export function told(record: TaskRecord): boolean {
  return record.delivery?.servedWakes?.includes(PULL_REQUEST_COMMENTS_WAKE) === true;
}

function factOf(comment: ForgePullComment): PullCommentFact {
  return {
    id: comment.id,
    kind: comment.kind,
    author: comment.author,
    relation: comment.relation,
    ...(comment.path !== undefined ? { path: comment.path } : {}),
    ...(comment.line !== undefined ? { line: comment.line } : {}),
    ...(comment.replyTo !== undefined ? { replyTo: comment.replyTo } : {}),
  };
}
