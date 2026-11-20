import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { git } from "./git";

/**
 * The warm worktree pool (scout fm3000-warm-worktree-pool-s1, captain's
 * board answer 2026-09-23: "Hybrid - Infinitary code, treehouse design"). A
 * closed task's working copy is not deleted: once its work is saved (the
 * kept ref, #270), it is reset clean - every tracked change and every
 * untracked or ignored file gone except `node_modules` - and parked here,
 * so the next task on the same repository starts from a tree whose
 * dependencies only need an incremental install instead of a full one.
 *
 * Treehouse's safety rules, not its binary:
 * - fail closed: a slot is handed out only when git proves it is a
 *   detached, pristine checkout of THIS repository; anything else is
 *   retired, never reused;
 * - anything on disk the pool cannot explain is retired, not trusted;
 * - stale git bookkeeping is pruned whenever a slot leaves.
 *
 * The filesystem is the state: a slot is a directory under
 * `<pool>/<repo key>/`, named `<parkedAtMs>-<id>` once it is proven clean,
 * or `returning-<id>` while its reset runs. Taking or parking one is a
 * `git worktree move` (a rename plus git's own bookkeeping), so a crash
 * leaves either the old or the new name, and boot finishes or retires
 * whatever it finds. The core is one process, so one in-process queue
 * serializes every pool change; there are no leases, PIDs or lock files.
 */

export type WorktreePoolOptions = {
  /** Idle slots kept per repository; the oldest beyond it are retired. */
  idlePerRepo?: number;
  /** Idle slots kept across every repository. */
  idleTotal?: number;
  /** An idle slot unused this long is retired. */
  maxIdleAgeMs?: number;
};

/** A slot costs ~370 MB of real disk on the app's own repository (scout measurement). */
const IDLE_PER_REPO = 3;
const IDLE_TOTAL = 8;
const MAX_IDLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const RETURNING_PREFIX = "returning-";

/** Dependency trees survive a return: the one thing the pool exists to keep. */
const KEPT_DIR = "node_modules";

type IdleSlot = { dir: string; key: string; parkedAt: number };

export class WorktreePool {
  /** Every pool change runs one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Resets running in the background after a park. */
  private readonly returns = new Set<Promise<void>>();

  constructor(
    private readonly poolDir: string,
    /** Removes a directory the pool gives up on (rename into the trash, delete in the background). */
    private readonly discard: (dir: string) => Promise<void>,
    private readonly options: WorktreePoolOptions = {},
  ) {}

  /**
   * Moves a warm slot of `repoDir`'s repository to `target` and answers
   * true, or false when none is idle (the caller creates a new tree). The
   * slot arrives detached on whatever commit it was parked at; the caller
   * checks the task branch out on the dispatch base.
   */
  acquire(repoDir: string, target: string): Promise<boolean> {
    return this.serial(async () => {
      const common = await commonDir(repoDir).catch(() => null);
      if (!common) return false;
      const key = repoKey(common);
      const now = Date.now();
      for (const slot of this.idleSlots(key)) {
        if (now - slot.parkedAt > this.maxIdleAgeMs) {
          await this.retire(slot.dir);
          continue;
        }
        if (!(await isPristineSlot(slot.dir, common))) {
          await this.retire(slot.dir);
          continue;
        }
        try {
          await mkdir(dirname(target), { recursive: true });
          await git(repoDir, ["worktree", "move", slot.dir, target]);
          return true;
        } catch (caught) {
          console.warn(`[worktree-pool] could not take ${slot.dir}:`, caught);
          if (existsSync(slot.dir)) await this.retire(slot.dir);
        }
      }
      return false;
    });
  }

  /**
   * Takes a closed task's tree into the pool instead of deleting it, and
   * answers whether it did. The caller has already saved (or deliberately
   * discarded) the work the tree holds. Only the fast part runs here - the
   * tree is detached so its branch can be deleted, and moved out of the
   * task's path - so a settle waits on a rename, as it did with the trash;
   * the reset runs in the background. False leaves the tree where it was.
   */
  park(cwd: string, repoDir: string): Promise<boolean> {
    return this.serial(async () => {
      try {
        const common = await commonDir(repoDir);
        await assertCheckoutOf(cwd, common);
        const staging = join(this.poolDir, repoKey(common), `${RETURNING_PREFIX}${slotId()}`);
        // Detaching keeps every file as it is; it only frees the branch.
        await git(cwd, ["checkout", "--quiet", "--detach"]);
        await mkdir(dirname(staging), { recursive: true });
        await git(repoDir, ["worktree", "move", cwd, staging]);
        this.inBackground(this.finishReturn(staging));
        return true;
      } catch (caught) {
        console.warn(`[worktree-pool] could not park ${cwd}:`, caught);
        return false;
      }
    });
  }

  /**
   * Boot: finishes the returns a quit interrupted and applies the budget
   * and age limit to what is idle. Anything under the pool that is not a
   * slot of its own is retired. Never throws.
   */
  async sweep(): Promise<void> {
    let keys: string[];
    try {
      keys = readdirSync(this.poolDir);
    } catch {
      return;
    }
    for (const key of keys) {
      let entries: string[];
      try {
        entries = readdirSync(join(this.poolDir, key));
      } catch {
        // A stray file where a repository's directory belongs.
        await this.serial(() => this.retire(join(this.poolDir, key)));
        continue;
      }
      for (const entry of entries) {
        const dir = join(this.poolDir, key, entry);
        if (entry.startsWith(RETURNING_PREFIX)) this.inBackground(this.finishReturn(dir));
        else if (parkedAt(entry) === null) await this.serial(() => this.retire(dir));
      }
    }
    await this.serial(() => this.enforceBudget());
  }

  /** Resolves once every background return started so far has finished. */
  async settled(): Promise<void> {
    while (this.returns.size > 0) await Promise.all([...this.returns]);
    await this.serial(async () => {});
  }

  /** The idle slots of every repository, for tests and the budget. */
  idle(): string[] {
    return this.allIdleSlots().map((slot) => slot.dir);
  }

  /**
   * The slow half of a return: everything but the dependency tree goes,
   * then the slot is proven pristine and renamed idle - or retired.
   */
  private async finishReturn(staging: string): Promise<void> {
    try {
      const common = await ownCheckout(staging);
      await git(staging, ["reset", "--hard", "--quiet"]);
      // -x: ignored files go too (build output, .env, reports from the last
      // task); -e keeps every node_modules, at any depth, out of the clean.
      await git(staging, ["clean", "-ffdxq", "-e", KEPT_DIR]);
      await this.serial(async () => {
        if (!(await isPristineSlot(staging, common))) {
          await this.retire(staging);
          return;
        }
        const idle = join(dirname(staging), `${Date.now()}-${slotId()}`);
        await git(repoOf(common), ["worktree", "move", staging, idle]);
        await this.enforceBudget();
      });
    } catch (caught) {
      console.warn(`[worktree-pool] could not reset ${staging}:`, caught);
      await this.serial(() => this.retire(staging));
    }
  }

  /** Newest first, per repository and across all; everything past a limit goes. */
  private async enforceBudget(): Promise<void> {
    const now = Date.now();
    const perRepo = new Map<string, number>();
    let total = 0;
    for (const slot of this.allIdleSlots()) {
      const count = perRepo.get(slot.key) ?? 0;
      const over =
        now - slot.parkedAt > this.maxIdleAgeMs ||
        count >= (this.options.idlePerRepo ?? IDLE_PER_REPO) ||
        total >= (this.options.idleTotal ?? IDLE_TOTAL);
      if (over) {
        await this.retire(slot.dir);
        continue;
      }
      perRepo.set(slot.key, count + 1);
      total += 1;
    }
  }

  /**
   * A slot leaves the pool for good: out of its path in one rename (the
   * caller's discard), then git forgets the worktree. Never throws.
   */
  private async retire(dir: string): Promise<void> {
    const common = await commonDir(dir).catch(() => null);
    await this.discard(dir).catch((caught) => {
      console.warn(`[worktree-pool] could not retire ${dir}:`, caught);
    });
    if (common) await git(repoOf(common), ["worktree", "prune"]).catch(() => {});
  }

  private idleSlots(key: string): IdleSlot[] {
    let entries: string[];
    try {
      entries = readdirSync(join(this.poolDir, key));
    } catch {
      return [];
    }
    return entries
      .map((entry) => ({ dir: join(this.poolDir, key, entry), key, parkedAt: parkedAt(entry) }))
      .filter((slot): slot is IdleSlot => slot.parkedAt !== null)
      .sort((a, b) => b.parkedAt - a.parkedAt);
  }

  private allIdleSlots(): IdleSlot[] {
    let keys: string[];
    try {
      keys = readdirSync(this.poolDir);
    } catch {
      return [];
    }
    return keys.flatMap((key) => this.idleSlots(key)).sort((a, b) => b.parkedAt - a.parkedAt);
  }

  private get maxIdleAgeMs(): number {
    return this.options.maxIdleAgeMs ?? MAX_IDLE_AGE_MS;
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step, step);
    this.queue = run.catch(() => {});
    return run;
  }

  private inBackground(work: Promise<void>): void {
    const tracked: Promise<void> = work.finally(() => {
      this.returns.delete(tracked);
    });
    this.returns.add(tracked);
  }
}

/**
 * Whether a slot may be handed out: the root of its own checkout, of the
 * expected repository, detached (no task branch rides along), and holding
 * nothing but dependency trees - no change, no untracked or ignored file.
 */
export async function isPristineSlot(dir: string, common: string): Promise<boolean> {
  try {
    await assertCheckoutOf(dir, common);
    // One status answers both questions: the branch header says whether HEAD
    // is detached, and the entries are everything the tree holds. Untracked
    // and ignored files are asked for explicitly, so a repository that hides
    // them in its config cannot make a dirty slot read as clean.
    const status = await git(dir, [
      "status",
      "--porcelain=v2",
      "--branch",
      "--ignored",
      "--untracked-files=normal",
    ]);
    const lines = status.split("\n").filter(Boolean);
    // Detached, as a parked slot must be: no task branch rides along.
    if (!lines.includes("# branch.head (detached)")) return false;
    return lines
      .filter((line) => !line.startsWith("# "))
      .every((line) => isKeptDependencyTree(line));
  } catch {
    return false;
  }
}

/** `! node_modules/` or `! packages/x/node_modules/` - an ignored dependency tree. */
function isKeptDependencyTree(line: string): boolean {
  if (!line.startsWith("! ")) return false;
  const path = line.slice(2).replace(/\/$/, "");
  return basename(path) === KEPT_DIR;
}

/** The repository's shared git directory, resolved: one pool per repository. */
async function commonDir(dir: string): Promise<string> {
  const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return realpathSync(common);
}

/**
 * The repository `dir` is the root of a checkout of, as its shared git
 * directory - or a refusal when it is not the root of its own checkout:
 * `git -C` walks up to any enclosing repository, and resetting THAT one
 * would destroy someone else's work. One git process answers both.
 */
async function ownCheckout(dir: string): Promise<string> {
  const [top, common] = (
    await git(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"])
  ).split("\n");
  if (!top || !common || realpathSync(top) !== realpathSync(dir)) {
    throw new Error(`${dir} is not a checkout of its own`);
  }
  return realpathSync(common);
}

/** Refuses a directory that is not the root of its own checkout of the given repository. */
async function assertCheckoutOf(dir: string, common: string): Promise<void> {
  if ((await ownCheckout(dir)) !== common) {
    throw new Error(`${dir} belongs to another repository`);
  }
}

/** Where git commands about the whole repository run: its main checkout, or the bare directory. */
function repoOf(common: string): string {
  return basename(common) === ".git" ? dirname(common) : common;
}

function repoKey(common: string): string {
  return createHash("sha256").update(resolve(common)).digest("hex").slice(0, 16);
}

function slotId(): string {
  return randomUUID().slice(0, 8);
}

/** The park time an idle slot's name carries, or null for anything else. */
function parkedAt(name: string): number | null {
  const match = /^(\d{13})-[0-9a-f]{8}$/.exec(name);
  return match ? Number(match[1]) : null;
}
