import type { CheckChangeInput } from "@shared/checkRepair";
import { type ForgeChange, isSignInForgeFailure } from "../forge";
import { git } from "../workspace/git";
import { readChangeReading } from "../workspace/workspaceService";
import type { ChangeChecks } from "./changeChecks";
import { type ChangeContext, type ChangeDeliveryOptions, crewSignInText } from "./changeContext";
import { declareCheckAction } from "./checkRepair";
import {
  candidateHead,
  declareMergeGuidance,
  declareMergeRepair,
  type LineageFacts,
  type LineageQuestion,
  outstandingGuidance,
  standingAuthorization,
} from "./mergeAuthorization";
import type { MergeReviews } from "./mergeReviews";

/** What check_change records beside a reading, each declared on its own terms. */
const DECLARATIONS = [
  "declaration",
  "diagnosis",
  "repair",
  "rerun",
  "conflictRepair",
  "captainGuidance",
] as const;

/**
 * The crewmate's check_change (git integration PR 1.2): the same reading
 * check_pr_ci takes and records - so the fact strip and check watch see
 * it - in words for the crewmate, with the declarations the crew sends
 * beside it and the merge reviews it prepares.
 */
export class CheckChangeTool {
  private readonly options: ChangeDeliveryOptions;

  constructor(
    private readonly context: ChangeContext,
    private readonly checks: ChangeChecks,
    private readonly reviews: MergeReviews,
  ) {
    this.options = context.options;
  }

  /**
   * The crewmate's check_change: the reading in the crewmate's words. A
   * missing sign-in is the captain's to fix: the crewmate reports it, never
   * signs in itself.
   */
  async checkForCrew(taskId: string, input: CheckChangeInput = {}): Promise<string> {
    // The reading names the change it is of (INF-1873): one of this task's
    // own changes (INF-2490). Naming another pull request's change makes it
    // the current one, as naming its number does.
    if (input.change !== undefined) {
      const changes = this.options.tasks.changesFor(taskId.trim());
      if (changes.length === 0)
        return "check_change refused: this task has no change record yet; leave change out.";
      const named = changes.find((change) => change.id === input.change?.trim());
      if (!named)
        return `check_change refused: "${input.change}" is not one of this task's changes; its changes are ${changes.map((change) => change.id).join(", ")}.`;
      const record = this.options.tasks.get(taskId.trim());
      const review = record?.delivery?.mergeReviews
        ?.filter((item) => item.number === named.handle?.number && !item.skips)
        .sort((a, b) => b.at - a.at)[0];
      if (record && named.head.branch !== record.branch && !review && input.pull === undefined) {
        // Its review is no longer kept: the change is read again by its
        // number, never swapped for the current one.
        if (named.handle?.number === undefined)
          return `check_change refused: change "${named.id}" names no pull request to read; pass pull with its number.`;
        const beside = DECLARATIONS.filter((field) => input[field] !== undefined);
        if (beside.length)
          return `check_change refused: change "${named.id}" is not the current change; read it first with change alone, then send ${beside.join(", ")}.`;
        return this.reviews.prepareReview(taskId, named.handle.number, input.absentChecks, {
          repoId: named.repoId,
        });
      }
      if (record && named.head.branch !== record.branch && review)
        this.context.select(record, review);
      else if (record && named.head.branch === record.branch)
        this.options.tasks.delivery.selectOwnChange(record.id, {
          number: named.handle?.number,
          headSha: named.versions.at(-1)?.head,
          base: named.base ?? undefined,
        });
    }
    if (input.pull !== undefined) {
      if (input.declaration) {
        const recorded = declareCheckAction(
          this.options.tasks,
          taskId,
          { declaration: input.declaration },
          this.context.now(),
        );
        if (!recorded.read) return recorded.text;
      }
      return input.skipRules
        ? this.reviews.prepareSkipReview(taskId, input.pull, input.skipRules)
        : this.reviews.prepareReview(taskId, input.pull, input.absentChecks);
    }
    if (input.skipRules) {
      return "Merge review refused: skipRules goes with pull, the pull request's number.";
    }
    // An absence declaration with no pull named is for this task's own pull
    // request (INF-1955): read against it, stored or refused in words,
    // never dropped.
    if (input.absentChecks) {
      const beside = DECLARATIONS.filter((field) => input[field] !== undefined);
      if (beside.length)
        return `Absence declaration refused: send absentChecks on its own, not beside ${beside.join(", ")}.`;
      return this.declareOwnAbsence(taskId, input.absentChecks);
    }
    const { conflictRepair, captainGuidance, ...checkInput } = input;
    let declared = "";
    // The captain's guidance is declared first: it may ride beside a repair.
    if (captainGuidance) {
      const located = this.context.locate(taskId);
      if ("said" in located) return located.said;
      const declaration = declareMergeGuidance(
        this.options.tasks,
        located.record.id,
        captainGuidance,
        this.context.now(),
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
      const located = this.context.locate(taskId);
      if ("said" in located) return located.said;
      const { record, dir } = located;
      const approvedHead = record.delivery?.mergeAuthorization?.approvedHead;
      await this.context.branchHome(record);
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
        this.context.now(),
      );
      if (!declaration.read) return [declared, declaration.text].filter(Boolean).join("\n");
      declared = [declared, declaration.text].filter(Boolean).join("\n");
    }
    if (checkInput.declaration || checkInput.diagnosis || checkInput.repair || checkInput.rerun) {
      const declaration = declareCheckAction(
        this.options.tasks,
        taskId,
        checkInput,
        this.context.now(),
      );
      if (!declaration.read) return declaration.text;
      declared = [declared, declaration.text].filter(Boolean).join("\n");
    }
    const run = await this.checks.run(taskId, "crewmate");
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
    const located = this.context.locate(taskId, "check", "own");
    if ("said" in located) return located.said;
    const { record, branch, forge } = located;
    if (!forge.hasChecks)
      return `Absence declaration refused: ${forge.place ?? "where this project lives"} runs no checks, so there is nothing to declare; the reading already says so.`;
    let change: ForgeChange | null;
    try {
      change = await forge.changeFor(branch);
    } catch (caught) {
      if (isSignInForgeFailure(caught))
        return crewSignInText(this.context.signInFact(forge, record.repoId));
      const message = caught instanceof Error ? caught.message : String(caught);
      return `Absence declaration refused: could not read this task's pull request. ${message}`;
    }
    if (!change || change.number === undefined)
      return "Absence declaration refused: this task has no open pull request for its branch yet. Open it with open_change first, or name the pull request with pull.";
    if (absent.headSha !== change.headSha)
      return `Absence declaration refused: it names ${absent.headSha}, but this task's pull request ${forge.label(change)} is at ${change.headSha}. Declare that version, with the evidence and the local gate run at it.`;
    const answer = await this.reviews.prepareReview(taskId, change.number, absent, {});
    return answer.replace(/^Merge review refused:/, "Absence declaration refused:");
  }
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
