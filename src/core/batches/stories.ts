import type { BatchChange, BatchMember, OpenBatch } from "@shared/batches";
import type { RepoView } from "@shared/repos";
import type { NamingRule } from "@shared/runbooks";
import {
  BATCH_STORIES_MARKER,
  type Forge,
  type ForgeChange,
  ForgeWriteError,
  isSignInForgeFailure,
  isTransientForgeFailure,
  presentationBodyLimit,
  presentationCommentLimit,
} from "../forge";
import { composedName } from "../workspace/naming";
import type { BatchesOptions } from "./batches";
import { type BatchLimits, batchDescription } from "./description";
import { BATCH_WORDS } from "./words";

/**
 * A batch pull request's words (docs/forge.md, "Batches of your own"): its
 * title, its description and the app's own comments that carry the stories
 * past it, written again at the version just read once its members change.
 * `Batches` owns the record and its passes; these are the steps it hands
 * over.
 */
export type StoriesOwner = {
  options: Pick<BatchesOptions, "naming" | "note" | "story">;
  label: (repo: RepoView, open: OpenBatch) => string;
};

/** A host on which the app can read, write and delete its own comments, to keep a batch's stories there. */
type CommentingForge = Forge &
  Required<Pick<Forge, "ownComments" | "writeComment" | "deleteComment">>;
const keepsComments = (forge: Forge): forge is CommentingForge =>
  Boolean(forge.ownComments && forge.writeComment && forge.deleteComment);

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

/**
 * The described mark for an early run's words at its commit (`followTrial`): that commit becomes
 * the batch's version once promoted, and its words then name the fix as not approved yet, so
 * the batch's own mark differs and the promoted batch is described again before it merges.
 */
export function trialMark(head: string): string {
  return `trial ${head}`;
}

export class BatchStories {
  /**
   * The version of each project's open batch whose pull request this run
   * read carrying the batch's own title and description, or an early run's
   * commit carrying the run's words (`trialMark`). Nothing is kept
   * across a restart, so the first pass after one reads it again.
   */
  readonly described = new Map<string, string>();
  /** The changes of each project whose missing story this run already said, by task and version. */
  private readonly storyless = new Map<string, Set<string>>();

  constructor(private readonly host: StoriesOwner) {}

  async openRequest(
    open: OpenBatch,
    forge: Forge,
  ): Promise<{ change: ForgeChange; comments: string[]; missing: BatchMember[] }> {
    const { body, comments, missing } = await this.body(open, forge);
    const change = await forge.openChange({
      branch: open.branch,
      title: this.title(open.members),
      body,
    });
    return { change, comments, missing };
  }

  /**
   * Give the open pull request the batch's own title and description once
   * its members changed, and the comments that carry the stories past it.
   * A host replaces a description only at the version, words and title just
   * read, so the pull request is read first; a rewrite the host did not take
   * is sent again on the next pass.
   */
  async describe(
    repo: RepoView,
    open: OpenBatch,
    forge: Forge,
    /** `open` is the early run with the held batch's fix (`followTrial`), its last member the fix. */
    trial = false,
  ): Promise<void> {
    if (!forge.updateChangeBody || open.number === undefined) return;
    const held = await forge.changeFor(open.branch);
    if (!held || held.number !== open.number || held.headSha !== open.head) return;
    const { body, comments, missing } = await this.body(open, forge, trial);
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
    if (await this.continueIn(forge, open.number, comments, false))
      this.wrote(repo, open, missing, trial ? trialMark(open.head) : open.head);
  }

  /**
   * Keep the app's own comments that carry the stories past the batch's
   * description equal to `comments`, in order: a changed one is rewritten,
   * a missing one posted and one left over deleted, so none still carries a
   * story the batch no longer holds. A pull request just opened has none to
   * read. Answers whether they are in step: one the host refused is tried
   * again on a later pass, from a fresh reading, and the batch goes on.
   */
  async continueIn(
    forge: Forge,
    number: number,
    comments: readonly string[],
    opened: boolean,
  ): Promise<boolean> {
    if (!keepsComments(forge)) return true;
    if (opened && comments.length === 0) return true;
    try {
      const held = opened ? [] : await forge.ownComments(number, BATCH_STORIES_MARKER);
      for (const [index, body] of comments.entries()) {
        const kept = held[index];
        if (kept?.body !== body) await forge.writeComment(number, body, kept?.id);
      }
      for (const left of held.slice(comments.length)) await forge.deleteComment(number, left.id);
      return true;
    } catch (caught) {
      // A sign-in, the network or a busy host: the pass reads again.
      if (isSignInForgeFailure(caught) || isTransientForgeFailure(caught)) throw caught;
      console.warn(
        "[batches] could not write the comments that carry the batch's stories:",
        caught instanceof Error ? caught.message : caught,
      );
      return false;
    }
  }

  /**
   * The pull request holds the batch's words at this version. With every
   * story in them, nothing is written again until the batch changes. A story
   * that could not be written is said once for that version of its change,
   * and the description is written again on each pass until it is there.
   */
  wrote(
    repo: RepoView,
    open: OpenBatch,
    missing: readonly BatchMember[],
    mark: string = open.head,
  ): void {
    if (missing.length === 0) {
      this.described.set(repo.id, mark);
      this.storyless.delete(repo.id);
      return;
    }
    const told = this.storyless.get(repo.id) ?? new Set<string>();
    const fresh = missing.filter((member) => !told.has(`${member.taskId} ${member.head}`));
    if (fresh.length === 0) return;
    for (const member of fresh) told.add(`${member.taskId} ${member.head}`);
    this.storyless.set(repo.id, told);
    this.host.options.note(
      BATCH_WORDS.noStory(
        repo.name,
        this.host.label(repo, open),
        fresh.map((member) => member.title),
      ),
    );
  }

  /**
   * The pull request's description, the comments that carry the stories it
   * cannot hold, and the changes whose story could not be written into
   * either this time. A batch of one reads as that change's own pull request
   * does: the words around its story, then the story. A batch of several
   * lists its changes, then carries each one's story under its title, within
   * the host's limits (`batchDescription`).
   */
  private async body(
    open: OpenBatch,
    forge: Forge,
    trial = false,
  ): Promise<{ body: string; comments: string[]; missing: BatchMember[] }> {
    const stories = await Promise.all(
      open.members.map((member) => this.host.options.story(member, forge).catch(() => undefined)),
    );
    if (open.members.length === 1)
      return {
        body: [stories[0]?.projectText, stories[0]?.region].filter(Boolean).join("\n\n"),
        comments: [],
        missing: stories[0] ? [] : open.members,
      };
    const { body, comments, unplaced } = batchDescription(
      open.members.map((member, index) => ({
        title: member.title,
        region: stories[index]?.region,
      })),
      this.limits(forge),
      trial ? open.members.at(-1)?.title : undefined,
    );
    return {
      body,
      comments,
      missing: open.members.filter((_member, index) => !stories[index] || unplaced.includes(index)),
    };
  }

  /** What the project's host keeps: a description, and a comment where the app can write one. */
  private limits(forge: Forge): BatchLimits {
    return {
      description: presentationBodyLimit(forge.kind),
      comment: keepsComments(forge) ? presentationCommentLimit(forge.kind) : 0,
    };
  }

  title(members: readonly BatchMember[]): string {
    return batchTitle(members, this.host.options.naming());
  }
}
