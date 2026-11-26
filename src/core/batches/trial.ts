import type { BatchChange, BatchRecord, BatchTrial, OpenBatch } from "@shared/batches";
import { type CheckItem, checkSnapshotSummary, isRedCheckState } from "@shared/checkSnapshot";
import type { RepoView } from "@shared/repos";
import type { Forge, ForgeChange, ForgePull } from "../forge";
import type { BatchesOptions } from "./batches";
import { combine as combineChanges, pushBatch } from "./combine";
import {
  declarationOf,
  declarationsOf,
  heldVersions,
  promoted,
  trialStands,
  withoutTrial,
} from "./line";
import { BATCH_WORDS } from "./words";

/**
 * A held batch's early run with its declared fix (docs/forge.md, "A held
 * batch"; `OpenBatch.trial`): once the fix's story is confirmed on its own
 * branch, the batch's own checks run at the held version plus the fix, so
 * a passing run merges at the fix's approval as it is, with no run after it.
 * `Batches` owns the record and its passes; these are the steps it hands over.
 */
export type TrialOwner = {
  options: BatchesOptions;
  record: (repoId: string) => BatchRecord;
  save: (repoId: string, record: BatchRecord) => BatchRecord;
  recombine: (repo: RepoView, record: BatchRecord, join: "none" | "line") => Promise<BatchRecord>;
  follow: (repo: RepoView, record: BatchRecord) => Promise<BatchRecord>;
  pushedHead: (forge: Forge, branch: string) => Promise<string | undefined>;
  read: (repoId: string, head: string, items: readonly CheckItem[]) => void;
  label: (repo: RepoView, open: OpenBatch) => string;
  atBatchAddress: (repo: RepoView, open: OpenBatch) => boolean;
  stillAt: (repo: RepoView) => boolean;
};

/** The fix's story as confirmed on its own branch, at its version. */
export type ConfirmedFix = Pick<BatchChange, "taskId" | "branch" | "head" | "title" | "body">;

/**
 * Start the early run for a fix whose story was just confirmed: the batch is held for its
 * checks at its version, no rerun is declared passed there, the version carries a declared
 * fix (after a send-back beside a fix, the awaited one) and is not approved yet. The held
 * members, less any sent back, and the fix's own difference from the newest held version are
 * combined, pushed to the batch's branch and pull request, and kept as the run; the line does
 * not join. Anything else starts nothing and pushes nothing: the batch goes on as without it.
 */
export async function startTrial(owner: TrialOwner, repoId: string, fix: ConfirmedFix) {
  const { options } = owner;
  const repo = options.repos.get(repoId);
  const record = owner.record(repoId);
  const open = record.open;
  const hold = open?.hold;
  if (!repo || !open || !hold || open.number === undefined) return;
  if (hold.reason !== "checks" || hold.head !== open.head || !owner.atBatchAddress(repo, open))
    return;
  if (open.passed?.head === open.head || open.unconfirmed || open.queued) return;
  const repair = declarationOf(record, fix);
  if (!repair || !options.live(fix.taskId)) return;
  if (open.awaits && !declarationsOf(record, fix).includes(open.awaits)) return;
  // Approved already at this version: it joins with the line as without a run.
  if (record.line.some((entry) => entry.taskId === fix.taskId && entry.head === fix.head)) return;
  const earlier = open.trial?.members.at(-1);
  if (
    open.trial?.task === fix.taskId &&
    open.trial.version === fix.head &&
    earlier?.title === fix.title &&
    earlier.body === fix.body
  )
    return;
  const forge = options.forgeFor(repo);
  const at = options.now();
  const heldBase = record.fixBases?.[repair];
  const changes: BatchChange[] = [
    ...open.members.map(({ commit: _commit, ...member }) => member),
    { ...fix, at, fix: true, ...(heldBase ? { heldBase } : {}) },
  ];
  const { merged, unmergedBase } = options;
  const result = await (options.combine ?? combineChanges)({
    repoDir: repo.path,
    defaultBranch: await forge.defaultBranch(),
    ...(repo.origin ? { remote: repo.origin } : {}),
    changes,
    at,
    ...(merged ? { merged } : {}),
    ...(unmergedBase ? { unmergedBase } : {}),
    held: heldVersions(record),
    excludeHeads: [open.head, ...(open.trial ? [open.trial.head] : [])],
    mergedWith: (taskId) =>
      record.receipts.find((entry) => entry.taskId === taskId)?.head ?? merged?.(taskId),
  });
  // Only every held member, plus the fix carried as its own difference from the version that
  // held: a run of anything else would answer for content the batch will not merge.
  const joined = result.members.at(-1);
  if (
    result.leftOut.length > 0 ||
    result.waiting?.length ||
    result.members.length !== changes.length ||
    joined?.taskId !== fix.taskId ||
    joined.heldBase !== hold.head
  )
    return;
  const expected = (await owner.pushedHead(forge, open.branch)) ?? open.trial?.head ?? open.head;
  if (!owner.stillAt(repo)) return;
  await (options.push ?? pushBatch)({
    repoDir: repo.path,
    branch: open.branch,
    ...(repo.origin ? { remote: repo.origin } : {}),
    head: result.head,
    expected,
  });
  if (!owner.stillAt(repo)) return;
  const trial: BatchTrial = {
    task: fix.taskId,
    version: fix.head,
    head: result.head,
    base: result.base,
    members: result.members,
    at,
  };
  owner.save(repoId, { ...record, open: { ...open, trial } });
  const label = owner.label(repo, open);
  options.note(BATCH_WORDS.trial(repo.name, label));
  options.taskNote(fix.taskId, BATCH_WORDS.trialTask(label));
}

/**
 * Follow the open batch's early run with its fix, from the host's reading of its pull
 * request and of the checks at the run's commit. Answers the record when the run decided
 * this pass, or undefined once the run no longer answers the batch: it is dropped, and the
 * batch goes on as without one.
 *
 * - The fix approved at the run's version with the run passed: the run's commit becomes the
 *   batch's version and merges as it is, after the same last look as any batch.
 * - Approved while the run still runs, at another version, or another fix approved: the batch
 *   combines with the line, as without a run.
 * - Failed: the hold stays at its version, approved or not, and the fix's crewmate and the
 *   batch's repair hear it once.
 * - The fix's task closed: the batch stays held, as without a run.
 */
export async function followTrial(
  owner: TrialOwner,
  repo: RepoView,
  record: BatchRecord,
  forge: Forge,
  pull: ForgePull,
): Promise<BatchRecord | undefined> {
  const { options } = owner;
  const open = record.open as OpenBatch;
  const trial = open.trial as BatchTrial;
  const drop = () => {
    owner.save(repo.id, withoutTrial(record));
    return undefined;
  };
  // A member left or was reworded, the hold ended, or a rerun was declared passed.
  if (!trialStands(record)) return drop();
  if (pull.headSha !== trial.head) {
    // A pull request can trail its branch for a moment after a push.
    if ((await owner.pushedHead(forge, open.branch)) === trial.head) return record;
    return drop();
  }
  const approved = record.line.find(
    (entry) => entry.taskId === trial.task && entry.head === trial.version,
  );
  const otherFix = record.line.some(
    (entry) => entry !== approved && (entry.fix || declarationsOf(record, entry).length > 0),
  );
  if (otherFix) return owner.recombine(repo, owner.save(repo.id, withoutTrial(record)), "line");
  if (!options.live(trial.task)) return record;
  if (!declarationsOf(record, { taskId: trial.task, head: trial.version }).length) return drop();
  const fix = trial.members.at(-1);
  const change: ForgeChange = {
    number: pull.number,
    url: open.url ?? null,
    branch: open.branch,
    headSha: trial.head,
    title: pull.title ?? "",
  };
  const checks = await forge.checks(change);
  owner.read(repo.id, trial.head, checks.items);
  const summary = checkSnapshotSummary({
    headSha: trial.head,
    items: checks.items,
    ...(checks.complete !== undefined ? { complete: checks.complete } : {}),
    ...(checks.problem ? { problem: checks.problem } : {}),
    absenceDeclared: trial.members.every((member) =>
      options.runsNoChecks(member.taskId, member.head),
    ),
  });
  if (summary.overall === "red") {
    const failed = checks.items
      .filter((item) => isRedCheckState(item.state))
      .map((item) => item.name);
    if (JSON.stringify(trial.failed) === JSON.stringify(failed)) return record;
    const saved = owner.save(repo.id, {
      ...record,
      open: { ...open, trial: { ...trial, failed } },
    });
    if (!trial.failed) {
      options.note(BATCH_WORDS.trialFailed(repo.name, owner.label(repo, open), failed));
      options.trialFailed?.({
        repo,
        open: saved.open as OpenBatch,
        trial: { ...trial, failed },
      });
      if (approved) options.settle([trial.task]);
    }
    return saved;
  }
  if (!approved) return record;
  // The approved words are the commit's: a story revised since the run combines again.
  if (summary.overall === "green" && approved.title === fix?.title && approved.body === fix.body)
    return owner.follow(repo, owner.save(repo.id, promoted(record, approved)));
  return owner.recombine(repo, owner.save(repo.id, withoutTrial(record)), "line");
}

/**
 * The record once the batch's pull request merged where the project lives at its early run's
 * commit, as a person may merge it by hand: that commit carried the fix, so the fix is the
 * batch's last member and gets its receipt. Undefined for any other commit.
 */
export function mergedAtTrial(record: BatchRecord, merged: string): BatchRecord | undefined {
  const trial = record.open?.trial;
  const fix = trial?.members.at(-1);
  if (!trial || !fix || trial.head !== merged) return undefined;
  const { commit: _commit, ...change } = fix;
  return promoted(
    record,
    record.line.find((entry) => entry.taskId === trial.task && entry.head === trial.version) ??
      change,
  );
}
