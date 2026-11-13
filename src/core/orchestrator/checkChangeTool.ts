import type { CheckChangeInput } from "@shared/checkRepair";
import { type Forge, type ForgeChange, isSignInForgeFailure } from "../forge";
import type { TaskRecord } from "../storage/taskRecords";
import { git } from "../workspace/git";
import { readChangeReading } from "../workspace/workspaceService";
import type { ChangeChecks } from "./changeChecks";
import { type ChangeContext, type ChangeDeliveryOptions, crewSignInText } from "./changeContext";
import { declareCheckAction } from "./checkRepair";
import {
  candidateHead,
  declareMergeGuidance,
  declareMergeRepair,
  keptApprovalLine,
  type LineageFacts,
  type LineageQuestion,
  standInFront,
  standingAuthorization,
} from "./mergeAuthorization";
import type { MergeReviews } from "./mergeReviews";

/** What check_change answers a declaration about the project's held batch. */
export const BATCH_DECLARATION_WORDS = {
  none: "Batch declaration refused: no batch of approved changes is held in this task's project, so there is nothing to answer.",
  evidence:
    "Batch declaration refused: evidence is empty. Say how you accounted for every failed test against every change in the batch.",
  one: "Batch declaration refused: give fix true or sendBack, exactly one of them.",
  reason: (task: string) =>
    `Batch declaration refused: ${task} has no reason. Its crewmate reads the reason, so say what its change broke.`,
  notMember: (task: string, members: readonly string[]) =>
    `Batch declaration refused: ${task} is not in the held batch. It carries ${members.join(", ")}.`,
  fix: "Recorded: this task's change is the held batch's fix. Push it, confirm its story with open_change and show its merge card as usual: once approved, it joins the held batch behind the changes already there, the batch is combined again and its checks run again. Changes approved meanwhile keep waiting in line.",
  sentBack: (count: number) =>
    `Sent back ${count === 1 ? "one change" : `${count} changes`}: each lost its approval and its crewmate was told the reason. The rest of the batch is being combined again with the changes that waited in line, and its checks run again.`,
} as const;

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
    // An answer to the project's held batch is the repair's own declaration:
    // it reads no change and rides beside nothing.
    if (input.batch) {
      const beside = [...DECLARATIONS, "absentChecks" as const].filter(
        (field) => input[field] !== undefined,
      );
      if (beside.length)
        return `Batch declaration refused: send batch on its own, not beside ${beside.join(", ")}.`;
      return this.declareBatch(taskId, input.batch);
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
      // The repair is of the approval whose version it starts from (INF-2746).
      standInFront(
        this.options.tasks,
        taskId.trim(),
        (item) => candidateHead(item) === conflictRepair.fromHead,
      );
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
    const keptLine = kept ? keptApprovalLine(kept) : "";
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
    if (!change && this.context.ownBatch(taskId))
      return this.declareBranchAbsence(record, branch, forge, absent);
    if (!change || change.number === undefined)
      return "Absence declaration refused: this task has no open pull request for its branch yet. Open it with open_change first, or name the pull request with pull.";
    if (absent.headSha !== change.headSha)
      return `Absence declaration refused: it names ${absent.headSha}, but this task's pull request ${forge.label(change)} is at ${change.headSha}. Declare that version, with the evidence and the local gate run at it.`;
    const answer = await this.reviews.prepareReview(taskId, change.number, absent, {});
    return answer.replace(/^Merge review refused:/, "Absence declaration refused:");
  }

  /**
   * The repair's answer to its project's held batch (docs/forge.md,
   * "Batches of your own"): its own change is the batch's fix, or the
   * changes at fault go back, each with its reason. The host carries what
   * the repair declared; it judges neither the fault nor the fix.
   */
  private async declareBatch(
    taskId: string,
    batch: NonNullable<CheckChangeInput["batch"]>,
  ): Promise<string> {
    const record = this.options.tasks.get(taskId.trim());
    const batches = this.context.batches;
    const repoId = record?.repoId;
    const open = repoId && batches ? batches.record(repoId).open : undefined;
    if (!record || !repoId || !batches || !open?.hold) return BATCH_DECLARATION_WORDS.none;
    if (!batch.evidence.trim()) return BATCH_DECLARATION_WORDS.evidence;
    const back = batch.sendBack ?? [];
    if ((batch.fix === true) === back.length > 0) return BATCH_DECLARATION_WORDS.one;
    if (batch.fix === true) {
      const refused = await batches.declareFix(repoId, record.id);
      if (refused) return `Batch declaration refused: ${refused}`;
      this.options.tasks.note(
        record.id,
        `Declared this task's change the fix of the held batch: ${batch.evidence.trim()}`,
        { news: true },
      );
      return BATCH_DECLARATION_WORDS.fix;
    }
    const changes: { taskId: string; reason: string }[] = [];
    for (const item of back) {
      const named = this.options.tasks.resolve(item.task.trim());
      const reason = item.reason.trim();
      if (!named || !open.members.some((member) => member.taskId === named.id))
        return BATCH_DECLARATION_WORDS.notMember(
          item.task,
          open.members.map((member) => this.options.tasks.get(member.taskId)?.key ?? member.taskId),
        );
      if (!reason) return BATCH_DECLARATION_WORDS.reason(item.task);
      changes.push({ taskId: named.id, reason });
    }
    const refused = await batches.answer(repoId, {
      action: "send-back",
      head: open.hold.head,
      changes,
    });
    if (refused) return `Batch declaration refused: ${refused}`;
    this.options.tasks.note(
      record.id,
      `Sent ${changes.length === 1 ? "one change" : `${changes.length} changes`} back from the held batch: ${batch.evidence.trim()}`,
      { news: true },
    );
    return BATCH_DECLARATION_WORDS.sentBack(changes.length);
  }

  /**
   * The same declaration for a pushed branch with no pull request of its
   * own (docs/forge.md, "Batches of your own"): kept on the task at the
   * branch's exact version, and read by every check reading of it.
   */
  private async declareBranchAbsence(
    record: TaskRecord,
    branch: string,
    forge: Forge,
    absent: NonNullable<CheckChangeInput["absentChecks"]>,
  ): Promise<string> {
    const evidence = absent.evidence.trim();
    const localGate = absent.localGate.trim();
    if (!forge.branchHead)
      return "Absence declaration refused: where this project lives has no branch to read.";
    let head: string;
    try {
      head = await forge.branchHead(branch);
    } catch (caught) {
      if (isSignInForgeFailure(caught))
        return crewSignInText(this.context.signInFact(forge, record.repoId));
      const message = caught instanceof Error ? caught.message : String(caught);
      return `Absence declaration refused: could not read this task's pushed branch. ${message}`;
    }
    if (!evidence || !localGate || absent.headSha !== head)
      return `Absence declaration refused: it must name this task's pushed branch at its current version, ${head}, with the workflow and changed-file evidence and the local gate run at that version.`;
    this.options.tasks.delivery.recordChangeEvidence(record.id, {
      branchAbsence: { branch, headSha: head, evidence, localGate },
    });
    const checks = await this.checks.run(record.id, "crewmate");
    return [
      checks.text,
      "Absence evidence stored for this version. A merge offer expresses the crew's judgment; this evidence grants no merge permission.",
    ].join("\n");
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
