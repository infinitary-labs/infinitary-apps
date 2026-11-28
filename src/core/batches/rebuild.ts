import type { BatchChange, BatchRecord } from "@shared/batches";
import type { RepoView } from "@shared/repos";
import type { BatchesOptions } from "./batches";
import { batchVersionIn, clashesWithBatch, LEFT_OUT_WORDS } from "./combine";
import { builtOnBatch, declarationsOf, rebuildStands, rebuildTold, toldRebuild } from "./line";
import { BATCH_WORDS } from "./words";

/**
 * A change rebuilt on an open batch (docs/forge.md, "A change rebuilt on an
 * open batch"): each change in line built on a batch version is marked so,
 * each other one is tried against the open batch's version, and a change that
 * clashes with it has its crewmate told once to rebuild on it. `Batches` owns
 * the record and its passes; these are the steps it hands over.
 */
export type RebuildOwner = {
  options: Pick<
    BatchesOptions,
    "builtOnVersion" | "clashes" | "now" | "rebuild" | "settle" | "taskNote"
  >;
  record: (repoId: string) => BatchRecord;
  save: (repoId: string, record: BatchRecord) => BatchRecord;
  stillAt: (repo: RepoView) => boolean;
};

export class BatchRebuilds {
  /**
   * The changes in line each project's passes already tried against its
   * open batch's version, by task, version and batch version, kept in
   * memory alone: after a restart each is tried once again.
   */
  private readonly tried = new Map<string, { at: string; keys: Set<string> }>();

  /** The keys tried for a project's open batch version `at`; a new version starts afresh. */
  private triedAt(repoId: string, at: string): Set<string> {
    const kept = this.tried.get(repoId);
    if (kept?.at === at) return kept.keys;
    const keys = new Set<string>();
    this.tried.set(repoId, { at, keys });
    return keys;
  }

  constructor(private readonly host: RebuildOwner) {}

  /**
   * Each ordinary change in line whose branch builds on an open batch
   * version, the one its crewmate was told to rebuild on or the open batch's
   * version now, read from git's history whatever repair was declared, is
   * marked as built on it (`onBatch`, docs/forge.md, "A change rebuilt on an
   * open batch"), so it goes behind that batch's changes and is carried as
   * its own difference from that version. Each version is read once per set
   * of batch versions; one that cannot be read now is read again next pass.
   */
  async markRebuilt(repo: RepoView, record: BatchRecord): Promise<BatchRecord> {
    // A held batch's version is its repair's to build on: a version built on it is a fix,
    // carried from the held version, never a change rebuilt on the batch.
    const open = record.open?.members.length && !record.open.hold ? record.open.head : undefined;
    const tried = this.triedAt(repo.id, record.open?.head ?? "");
    let next = record;
    for (const change of record.line) {
      if (change.onBatch || change.fix || change.after || change.base) continue;
      if (declarationsOf(record, change).length) continue;
      const told = record.rebuilds?.find((entry) => entry.taskId === change.taskId)?.on;
      const versions = [...new Set([told, open].filter((version) => version !== undefined))];
      if (versions.length === 0) continue;
      const key = `built:${change.taskId}:${change.head}:${versions.join(",")}`;
      if (tried.has(key)) continue;
      const on = await (this.host.options.builtOnVersion ?? batchVersionIn)({
        repoDir: repo.path,
        ...(repo.origin ? { remote: repo.origin } : {}),
        branch: change.branch,
        head: change.head,
        versions,
      }).catch(() => null);
      if (on === null) continue;
      tried.add(key);
      const onBatch = on ? builtOnBatch(next, change.taskId, on) : undefined;
      if (!onBatch) continue;
      next = {
        ...next,
        line: next.line.map((entry) =>
          entry.taskId === change.taskId && entry.head === change.head
            ? { ...entry, onBatch }
            : entry,
        ),
      };
    }
    return next === record || !this.host.stillAt(repo) ? record : this.host.save(repo.id, next);
  }

  /**
   * While a batch is open and checked, each change waiting in line is tried
   * once against its version with `merge-tree`, which writes no ref a
   * person sees (docs/forge.md, "A change rebuilt on an open batch"): one
   * that no longer combines with it has its crewmate told to rebuild it on
   * that version now, once per version of the change and set of changes in
   * the batch, rather than when the next batch leaves it out.
   */
  async tryLine(repo: RepoView): Promise<void> {
    const record = this.host.record(repo.id);
    const open = record.open;
    if (!open || open.hold || open.stale || open.members.length === 0 || !this.host.options.rebuild)
      return;
    const tried = this.triedAt(repo.id, open.head);
    for (const change of record.line) {
      // A version rebuilt on a batch whose changes no longer stand in the open batch at their
      // versions, nor merged at them, is told once to rebuild on the open batch as it is now.
      if (change.onBatch && !change.fix) {
        if (!this.batchStands(record, change.onBatch) && !rebuildTold(record, change))
          this.tellRebuild(repo.id, change, LEFT_OUT_WORDS.batchChanged(change.onBatch.head));
        continue;
      }
      // A fix, a part built on another's version and a stacked change each have their own
      // place; the combine judges them.
      if (change.fix || change.after || change.base) continue;
      const key = `${change.taskId}:${change.head}:${open.head}`;
      if (tried.has(key) || rebuildTold(record, change) || rebuildStands(record, change)) continue;
      const clashes = await (this.host.options.clashes ?? clashesWithBatch)({
        repoDir: repo.path,
        ...(repo.origin ? { remote: repo.origin } : {}),
        branch: change.branch,
        head: change.head,
        batch: open.head,
      });
      // One that cannot be read at this version, as a moved branch, is tried again only once
      // the batch's version or the change's version moves.
      tried.add(key);
      if (!clashes || !this.host.stillAt(repo)) continue;
      this.tellRebuild(repo.id, change, LEFT_OUT_WORDS.clashesBatch);
    }
  }

  /**
   * Whether every change a rebuilt version was built on still stands where
   * the combine carries it: in the open batch at that version, or merged at it.
   */
  private batchStands(record: BatchRecord, onBatch: NonNullable<BatchChange["onBatch"]>): boolean {
    return onBatch.members.every(
      (carried) =>
        record.open?.members.some(
          (member) => member.taskId === carried.taskId && member.head === carried.head,
        ) ||
        record.receipts.some(
          (receipt) => receipt.taskId === carried.taskId && receipt.head === carried.head,
        ),
    );
  }

  /**
   * The left-out changes whose crewmate was told to rebuild on the batch on
   * `branch`, which just ended, merged or not: their merge reads their place
   * again, which no longer asks them to rebuild on it.
   */
  toldOn(record: BatchRecord, branch: string): string[] {
    return record.leftOut
      .filter((entry) => entry.rebuild?.branch === branch)
      .map((entry) => entry.taskId);
  }

  /** Settle the left-out changes told to rebuild on the batch on `branch`, which ended unmerged. */
  settleTold(record: BatchRecord, branch: string): void {
    const told = this.toldOn(record, branch);
    if (told.length) this.host.options.settle(told);
  }

  /**
   * Tell a change's crewmate to rebuild it on the open batch's version, once
   * per version of the change and set of changes in the batch, and keep
   * that on the record (`toldRebuild`).
   */
  tellRebuild(repoId: string, change: Pick<BatchChange, "taskId" | "head">, reason: string): void {
    const told = toldRebuild(this.host.record(repoId), change, this.host.options.now());
    if (!told.told) return;
    const saved = this.host.save(repoId, told.record);
    if (!told.fresh || !saved.open) return;
    this.host.options.taskNote(change.taskId, BATCH_WORDS.rebuild(reason, told.told.on));
    this.host.options.rebuild?.({ change, reason, told: told.told, open: saved.open });
  }
}
