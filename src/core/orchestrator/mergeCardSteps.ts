import type { StagedChangePresentation } from "@shared/changePresentation";
import { hasChangeRequests } from "@shared/forge";
import { overridePasses, softHoldWords } from "@shared/holds";
import { acceptedValidation } from "@shared/liveValidation";
import {
  type Forge,
  type ForgeChange,
  ForgeError,
  isForkReview,
  isSignInForgeFailure,
} from "../forge";
import { currentChange } from "../storage/changeProjection";
import { type ChangeContext, changeWords, crewSignInText, numberLabel } from "./changeContext";
import type { ChangePublication } from "./changePublication";
import { type MergedStory, mergedAheadWords, mergedStory } from "./mergedStory";
import { carryTakenOverReview } from "./takeoverCarry";

/**
 * The steps show_merge_card walks, in their fixed order (INF-3717 piece 2):
 * the crewmate's commit, story words and push, the review and live proof at
 * this version, the pull request open and its story published and read
 * back, the checks passed, no open work the task waits on, then the card.
 * `sign-in` stands wherever a read of where the project lives needs the
 * captain's sign-in.
 */
export type MergeCardStep =
  | "commit"
  | "story"
  | "push"
  | "proof"
  | "pull"
  | "publish"
  | "checks"
  | "waits"
  | "card"
  | "sign-in";

/** Who supplies a missing step: someone other than the app, or the app when its own step failed. */
export type MergeCardSupplier =
  | "crewmate"
  | "reviewer"
  | "first-mate"
  | "captain"
  | "checks"
  | "app";

/** The first step not yet true, in words, and who supplies it. */
export type MergeCardStop = { step: MergeCardStep; missing: string; by: MergeCardSupplier };

export type MergeCardWalk = {
  did: string[];
  stop?: MergeCardStop;
  /** The committed version the walk verified pushed: the one the card offers (INF-4018). */
  ready?: { revision: number; title: string; head: string };
};

const SUPPLIER_WORDS: Record<MergeCardSupplier, string> = {
  crewmate: "you",
  reviewer:
    "the independent reviewer, through the first mate: report the gap, then call show_merge_card again once it is recorded",
  "first-mate":
    "the first mate: report under the five headings; it clears the wait and tells you when to call show_merge_card again",
  captain: "the captain: report it as a blocker",
  checks:
    "the checks: end your turn; the app wakes you when they finish, then call show_merge_card again",
  app: "the app could not finish its own step; do what its words say, or report them as a blocker",
};

/** What the walk says it did where its words are its own. */
export const MERGE_CARD_WORDS = {
  /** A change that joins a batch of the person's own (docs/forge.md, "Batches of your own"). */
  batchConfirmed: (branch: string) =>
    `Confirmed the story on the pushed branch ${branch}, the change itself: this project merges approved changes together, so the change opens no pull request of its own, and its story is published on its batch's pull request once the change is approved.`,
} as const;

export function mergeCardAnswer(walk: Pick<MergeCardWalk, "did" | "stop">, shown?: string): string {
  const did = walk.did.length ? `Did: ${walk.did.join(" ")}` : "Nothing new was needed before it.";
  if (shown !== undefined) return `${did} ${shown}`;
  const stop = walk.stop;
  if (!stop) return did;
  return `${did} Missing (${stop.step}): ${stop.missing} Supplied by: ${SUPPLIER_WORDS[stop.by]}. Called again, show_merge_card repeats nothing already done.`;
}

function wordsOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * show_merge_card's steps up to the card (INF-3717 piece 2): resolves the
 * change once, on the branch the working copy has checked out, does each
 * step that is the app's own - preparing the story it was given, preparing
 * the same words again once live proof was accepted since, opening the pull
 * request and publishing the story there - and stops at the first step
 * someone else supplies. Called again it repeats nothing: the same words add
 * no revision, and a published story is not sent again.
 * Selected contributor reviews use the explicit publisher path, not this own-project walk.
 */
export class MergeCardSteps {
  constructor(
    private readonly context: ChangeContext,
    private readonly publication: ChangePublication,
  ) {}

  async walk(taskId: string, given?: StagedChangePresentation): Promise<MergeCardWalk> {
    let staged = given;
    const presentations = this.context.options.presentations;
    try {
      return await this.steps(taskId, () => {
        const taken = staged;
        staged = undefined;
        return taken;
      });
    } finally {
      // A story the walk stopped before preparing leaves no staged copy behind.
      if (staged) await presentations?.discardStaged(taskId, staged);
    }
  }

  private async steps(
    taskId: string,
    takeStory: () => StagedChangePresentation | undefined,
  ): Promise<MergeCardWalk> {
    const did: string[] = [];
    const stop = (step: MergeCardStep, missing: string, by: MergeCardSupplier): MergeCardWalk => ({
      did,
      stop: { step, missing, by },
    });
    const { options } = this.context;
    const selected = options.tasks.get(taskId)?.delivery?.checkTarget;
    if (selected && isForkReview(selected))
      return stop(
        "story",
        "A selected contributor review uses prepare_change, then open_change with presentation, then emit_card with presentation and asks_first on its merge effect. Do not use show_merge_card for this review.",
        "crewmate",
      );
    const presentations = options.presentations;
    if (!presentations) return stop("story", "Saved change stories are unavailable here.", "app");
    const contribution = await options.prepareContribution?.(taskId);
    if (contribution)
      return stop(
        "story",
        `${contribution} This task contributes to a project upstream, whose maintainers merge it: use prepare_change, open_change and emit_card for it.`,
        "crewmate",
      );

    // 1. Work committed.
    let head: string;
    try {
      head = await this.publication.presentationHead(taskId);
    } catch (caught) {
      return stop("commit", wordsOf(caught), "crewmate");
    }
    // A takeover at the very commit an earlier task's review passed shows
    // that pass, and the proof accepted with it (INF-6536 finding 3).
    const carried = options.proofDir
      ? carryTakenOverReview({ tasks: options.tasks, taskId, head, proofDir: options.proofDir })
      : undefined;
    if (carried)
      // i18n-exempt: served to the crewmate in show_merge_card's answer
      did.push(
        `This task carries the review ${carried.key} passed at this same commit${carried.proof ? ", with the proof accepted there" : ""}.`,
      );

    // The change, resolved once: the branch the working copy has checked out.
    const local = this.publication.localStoryDestination(taskId) !== undefined;
    let forge: Forge | undefined;
    let branch: string | undefined;
    let repoId: string | null | undefined;
    let ownBranch: string | undefined;
    if (local) {
      branch = await this.publication.presentationBranch(taskId).catch(() => undefined);
    } else {
      const located = this.context.locate(taskId, "open", "own");
      if ("said" in located) return stop("pull", located.said, "app");
      forge = located.forge;
      repoId = located.record.repoId;
      ownBranch = located.record.branch;
      branch =
        (await this.publication.presentationBranch(taskId).catch(() => undefined)) ??
        currentChange(located.record.delivery, located.branch).branch;
    }
    const ledger = () => options.tasks.delivery.changePresentation(taskId, branch);
    const signIn = (where: Forge, after = "") =>
      stop(
        "sign-in",
        `${crewSignInText(this.context.signInFact(where, repoId))}${after}`,
        "captain",
      );

    // The pull request a published story went to, read once: merged outside
    // the app (INF-3799), its merge card shows the story it merged with, at
    // the version that merged, and nothing is prepared, pushed or published
    // for it again, since its branch may be gone.
    let open: ForgeChange | null | undefined;
    if (forge && branch && hasChangeRequests(forge.kind) && ledger()?.published) {
      let merged: MergedStory | undefined;
      try {
        open = await forge.changeFor(branch);
        if (!open) merged = await mergedStory(options.tasks, taskId, forge, branch);
      } catch (caught) {
        // A failed read stops the walk before the story step: words saved
        // while a merged pull request cannot be read would be a newer
        // revision than the one it merged with, which refuses its merge card
        // for good. The crewmate passes them again.
        const given = takeStory();
        if (given) await presentations.discardStaged(taskId, given);
        const unsaved = given ? " The story words you passed were not saved: pass them again." : "";
        if (isSignInForgeFailure(caught)) return signIn(forge, unsaved);
        return stop("pull", `${wordsOf(caught)}${unsaved}`, "app");
      }
      if (merged && "refused" in merged) return stop("pull", merged.refused, "crewmate");
      if (merged) {
        const { pull, revision } = merged;
        if (head !== pull.headSha)
          return stop("commit", mergedAheadWords(forge, pull, head), "crewmate");
        const given = takeStory();
        if (given) await presentations.discardStaged(taskId, given);
        did.push(
          `${numberLabel(forge, pull.number)} was merged outside the app at ${pull.headSha}, so its merge card shows story revision ${revision}, the story it merged with${given ? "; the story words you passed were not saved, since a merged pull request takes no new story" : ""}.`,
        );
        const title = ledger()?.revisions.find((saved) => saved.revision === revision)?.title ?? "";
        return { did, ready: { revision, title, head: pull.headSha } };
      }
    }

    // 2. Story words: the ones given, or the newest saved.
    const story = takeStory();
    if (story) {
      const before = ledger()?.revisions.at(-1)?.revision;
      const prepared = await this.publication.prepareStory(taskId, story, { reuseSame: true });
      if (prepared.revision === undefined) return stop("story", prepared.said, "crewmate");
      did.push(
        prepared.revision === before
          ? `Story revision ${prepared.revision} already says these words at this version, so no revision was added.`
          : `Prepared story revision ${prepared.revision} at the committed version.`,
      );
    }
    const record = ledger();
    const newest = record?.revisions.at(-1);
    if (!record || !newest) {
      // INF-3995: the current change on another branch keeps the story.
      const elsewhere = local ? undefined : this.publication.currentStoryWords(taskId, branch);
      return stop(
        "story",
        `${branch ?? "This change"} has no prepared story. ${elsewhere ? `${elsewhere} To deliver ${branch} instead, pass story with its words.` : "Pass story with its words."}`,
        "crewmate",
      );
    }
    // A published story follows a later push on its own (INF-2509); one
    // never published, or a local one, needs words at this version.
    const followsPush =
      !local &&
      record.published?.revision === newest.revision &&
      record.publication?.state === "confirmed";
    if (newest.head !== head && !followsPush)
      return stop(
        "story",
        `Story revision ${newest.revision} was prepared at another version than the committed one. Pass story again at this version, keeping its base and title.`,
        "crewmate",
      );

    // 3. Branch pushed at that version, where the host keeps pull requests.
    if (forge && branch && hasChangeRequests(forge.kind) && forge.branchHead) {
      let pushed: string | undefined;
      try {
        pushed = await forge.branchHead(branch);
      } catch (caught) {
        if (isSignInForgeFailure(caught)) return signIn(forge);
        if (!(caught instanceof ForgeError)) return stop("push", wordsOf(caught), "app");
      }
      if (pushed !== head)
        return stop(
          "push",
          pushed
            ? `${branch} is pushed at another version than the committed one. Push it (git push).`
            : `${branch} is not pushed where the project lives. Push it (git push).`,
          "crewmate",
        );
    }

    // 4. Review and live proof at this version, when the task has them.
    // The captain's recorded override that passes the proof hold at this
    // version passes this step too (INF-3883): the first mate declared it on
    // their words, so the card no longer waits for proof they let go.
    const delivery = options.tasks.get(taskId)?.delivery;
    const validation = delivery?.liveValidation;
    let shown = newest.revision;
    if (validation) {
      const acceptance = acceptedValidation(validation, head);
      if (!acceptance.ready && !overridePasses(delivery, "proof", head))
        return stop(
          "proof",
          `${acceptance.missing ?? acceptance.reason} ${softHoldWords("proof", "crewmate")}`,
          acceptance.by ?? "crewmate",
        );
      // Proof accepted after the story, with the same scenarios: the same
      // words again, with the summary accepted now.
      try {
        const refreshed = await presentations.refreshValidation(taskId, branch);
        if (refreshed !== undefined) {
          shown = refreshed;
          did.push(
            `Prepared story revision ${refreshed} with the same words and the live validation accepted since.`,
          );
        }
      } catch (caught) {
        return stop(
          "story",
          `${wordsOf(caught)} The scenarios changed since the story: pass story with a validation row for each current scenario.`,
          "crewmate",
        );
      }
    }
    const title = newest.title;
    if (local || !forge || !branch) return { did, ready: { revision: shown, title, head } };

    // 5 and 6. Pull request open, story published and read back. A change
    // that joins a batch of the person's own opens none: its pushed branch
    // is the change, read as the card call and check_change read it
    // (docs/forge.md, "Batches of your own"; INF-4153). Whether the project
    // gets batches of its own is read after open_change's own step, which
    // learns it where the project's files were never read.
    const hosted = hasChangeRequests(forge.kind);
    const host = forge;
    const changeBranch = branch;
    const changeFor = async (): Promise<ForgeChange | null> =>
      (await host.changeFor(changeBranch)) ??
      (hosted && changeBranch === ownBranch && this.context.ownBatch(taskId)
        ? await this.context.pushedBranch(host, changeBranch)
        : null);
    if (open === undefined) {
      try {
        open = await changeFor();
      } catch (caught) {
        if (isSignInForgeFailure(caught)) return signIn(forge);
        return stop("pull", wordsOf(caught), "app");
      }
    }
    const current = ledger();
    if (!open && current?.published)
      return stop(
        "pull",
        `The pull request that carried this story for ${branch} is no longer open. Publication stops; the app does not reopen or replace it. Reopen it where the project lives, or close this task.`,
        "captain",
      );
    // A change with no pull request keeps the story on its pushed branch,
    // done once opening it saved the story's completion there and nothing
    // is published: on a host that keeps no pull requests the story stays
    // on the card (INF-3730's plain journey), and in a batch it is
    // published on the batch's pull request once approved.
    const onBranch = (read: ForgeChange | null) => !hosted || read?.number === undefined;
    const done = (ledgered: typeof current, read: ForgeChange | null) =>
      onBranch(read)
        ? ledgered?.completion?.revision === shown && ledgered.completion.head === head
        : ledgered?.published?.revision === shown && ledgered.publication?.state === "confirmed";
    const published = open !== null && done(current, open);
    if (!published) {
      const answer = await this.publication.open(taskId, {
        title,
        presentation: shown,
        branch,
      });
      let read: ForgeChange | null;
      try {
        read = await changeFor();
      } catch (caught) {
        if (isSignInForgeFailure(caught)) return signIn(forge);
        return stop(
          "publish",
          `${answer} Reading the pull request back failed: ${wordsOf(caught)}`,
          "app",
        );
      }
      const after = ledger();
      if (!read || !done(after, read)) return stop(read ? "publish" : "pull", answer, "app");
      did.push(
        !hosted
          ? `Recorded ${changeWords(forge, read)} as the change; ${forge.place ?? "where the project lives"} keeps no pull requests, so the story stays on the merge card.`
          : onBranch(read)
            ? MERGE_CARD_WORDS.batchConfirmed(branch)
            : `${open ? "Published the story on" : "Opened"} ${changeWords(forge, read)}${open ? "" : " with the story"} and read it back.`,
      );
    }
    return { did, ready: { revision: shown, title, head } };
  }
}
