import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  writeSync,
} from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { forgeOf } from "@shared/forge";
import {
  type BundledRef,
  PLACED_COPY_CHUNK_BYTES,
  placedTaskIdSchema,
  type ReadableRef,
  type WorkingCopyBase,
  type WorkOrderRequest,
  type WorkOrderResponse,
  worktreesDirOf,
} from "@shared/work";
import { writeArtifact } from "../workspace/artifacts";
import { bundleRef, commitOf, sha256Of, takeBundle } from "../workspace/bundles";
import { forgeAuthRequired } from "../workspace/forgeAuth";
import { git, inheritWorktreeRemotes } from "../workspace/git";
import { type MovedFolders, packWork, readManifest, unpackWork } from "../workspace/workMove";
import {
  type DependencyInstall,
  type DispatchBase,
  keptRefFor,
  keptRefsFor,
  OLDER_SEEDED_REF,
  SEEDED_REF,
  sourceRefPatterns,
  TASK_BRANCH_PREFIX,
  type TaskWorkspace,
  WorkspaceService,
  type WorkspaceServiceOptions,
} from "../workspace/workspaceService";

function checkPushOrigin(project: { origin: string; pushOrigin?: string } | undefined): void {
  if (project?.pushOrigin) {
    const https = project.pushOrigin.startsWith("https://");
    const ssh = project.pushOrigin.startsWith("ssh://") || /^[^/]+@[^:]+:/.test(project.pushOrigin);
    const source =
      https || project.pushOrigin.startsWith("ssh://") ? new URL(project.pushOrigin) : undefined;
    const target = forgeOf(project.origin);
    if (
      (!https && !ssh) ||
      (https &&
        project.origin.startsWith("https://") &&
        source?.origin !== new URL(project.origin).origin) ||
      (https && source?.username) ||
      source?.password ||
      forgeOf(project.pushOrigin).host !== target.host
    )
      throw new Error("The fork's push address must stay on the project's own host.");
  }
}

/**
 * The working copies a computer that runs work keeps for its home
 * (docs/helper.md, "Its working copies"), the one writer over `repos/`,
 * `worktrees/`, `worktree-pool/`, `worktree-trash/`, `default-workspace/`,
 * `bundles/` and `artifacts/` in its data folder.
 *
 * A project is cloned here once, from where it lives, with this computer's
 * own git and sign-in: a bare clone in `repos/` that knows only `origin`'s
 * default branch. Each task then gets a working copy of its own on
 * `fm/task-<id>`, made exactly as the home makes one (`WorkspaceService`):
 * from `origin`'s default branch, fetched first, or a warm working copy
 * from the pool; its dependencies installed the same way. The crewmate
 * pushes from it with this computer's own sign-in.
 *
 * Its work goes home as a git bundle over the connection, never through
 * where the project lives: the branch when the home reads it, and, when
 * the task closes, one commit holding whatever never merged, on the task's
 * kept ref. The working copy is deleted only once the home holds that
 * commit (`retire`).
 */

/** A working copy made or found here, as `inf:working-copy:prepare` answers it when nothing refused. */
export type PreparedCopy = Extract<WorkOrderResponse<"inf:working-copy:prepare">, { dir: string }>;

export type WorkingCopiesOptions = Pick<WorkspaceServiceOptions, "pnpm" | "pool"> & {
  /** Bound on a clone's and a dispatch's fetch. */
  fetchTimeoutMs?: number;
  /**
   * Whether this computer holds its own sign-in for a host where projects
   * live (`../helper/forges.ts`), which its git answers that host with.
   */
  signedInTo?: (host: string) => boolean;
};

/** A slow or silent remote must not hold the home's start for long. */
const FETCH_TIMEOUT_MS = 2 * 60 * 1000;

/** Git never waits on a terminal nobody sees here. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" } as const;

/** One artifact's pieces as they arrive, before it is whole. */
type Arriving = { file: string; size: number };

export class WorkingCopies {
  readonly worktreesDir: string;
  private readonly reposDir: string;
  private readonly bundlesDir: string;
  private readonly artifactsDir: string;
  private readonly workspace: WorkspaceService;
  private readonly fetchTimeoutMs: number;
  /** One clone of a project at a time. */
  private readonly cloning = new Map<string, Promise<{ dir: string; cloned: boolean }>>();
  /** One change to a task's working copy at a time, in order. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly arriving = new Map<string, Arriving>();
  private readonly signedInTo: (host: string) => boolean;

  constructor(dataDir: string, options: WorkingCopiesOptions = {}) {
    this.signedInTo = options.signedInTo ?? (() => false);
    this.worktreesDir = worktreesDirOf(dataDir);
    this.reposDir = join(dataDir, "repos");
    this.bundlesDir = join(dataDir, "bundles");
    this.artifactsDir = join(dataDir, "artifacts");
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    this.workspace = new WorkspaceService(
      {
        worktreesDir: this.worktreesDir,
        worktreeTrashDir: join(dataDir, "worktree-trash"),
        worktreePoolDir: join(dataDir, "worktree-pool"),
        defaultWorkspaceDir: join(dataDir, "default-workspace"),
      },
      {
        ...(options.pnpm ? { pnpm: options.pnpm } : {}),
        ...(options.pool !== undefined ? { pool: options.pool } : {}),
        fetchTimeoutMs: this.fetchTimeoutMs,
      },
    );
  }

  /** Every task with a working copy here, by the folder it is in. */
  list(): string[] {
    try {
      return readdirSync(this.worktreesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && placedTaskIdSchema.safeParse(entry.name).success)
        .map((entry) => entry.name)
        .sort();
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw caught;
    }
  }

  /** The task's working copy is here. */
  has(task: string): boolean {
    try {
      lstatSync(this.dir(task));
      return true;
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw caught;
    }
  }

  /** Where the task's working copy is, whether or not it is there yet. */
  dir(task: string): string {
    return join(this.worktreesDir, checked(task));
  }

  /**
   * Boot: finish what a quit left of the pool and the trash, and forget
   * pieces of an artifact that never arrived whole.
   */
  sweep(): void {
    this.workspace.sweepPool();
    this.workspace.sweepTrash();
    void rm(this.artifactsDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Resolves once every pool return started so far has finished (tests). */
  async poolSettled(): Promise<void> {
    await this.workspace.poolSettled();
  }

  // ---- making one -----------------------------------------------------------

  /**
   * The task's working copy, made now or found as it was
   * (`inf:working-copy:prepare`). A clone the host refuses for want of this
   * computer's own sign-in throws `ForgeAuthRequiredError`, which the
   * order's answer carries home typed (`SessionHost`).
   */
  prepare(
    task: string,
    project: { origin: string; pushOrigin?: string } | undefined,
    seed?: string,
    base?: WorkingCopyBase,
  ): Promise<PreparedCopy> {
    return this.serial(task, async () => {
      if (base?.task === task) throw new Error("A working copy must be separate from its source.");
      const source = base ? await this.workspaceOf(base.task) : undefined;
      if (base && !source) throw new Error("The source task has no working copy here.");
      const repo = source
        ? { dir: source.repoDir, cloned: false }
        : project
          ? await this.clone(project.origin)
          : undefined;
      checkPushOrigin(project);
      // Ordinary projectless work starts from the home's seeded workspace.
      // A review instead uses its builder's local repository and exact commit.
      const startAt = !base && !project && seed ? await this.seededBase(seed) : undefined;
      const made = await this.workspace.createTaskWorktree(
        checked(task),
        repo?.dir,
        base ?? startAt,
        project?.pushOrigin ? project : undefined,
      );
      const host = project ? forgeOf(project.origin).host : null;
      return {
        dir: made.cwd,
        branch: made.branch,
        ...(base ? { headSha: await git(made.cwd, ["rev-parse", "HEAD"]) } : {}),
        cloned: repo?.cloned ?? false,
        ...(repo?.cloned && host && this.signedInTo(host) ? { signedIn: true } : {}),
        ...(made.acquired ? { acquired: made.acquired } : {}),
      };
    });
  }

  /**
   * The home's default workspace as this computer keeps it
   * (`inf:working-copy:seed`): the commit named is asked for first, then the
   * bundle's pieces gather outside the working copy and, once whole and
   * matching its digest, are fetched into `SEEDED_REF` of this computer's
   * own default workspace, never its checked-out branch.
   */
  seed(
    request: WorkOrderRequest<"inf:working-copy:seed">[0],
  ): Promise<WorkOrderResponse<"inf:working-copy:seed">> {
    const { task, sha, piece } = request;
    return this.serial(`${task}:seed`, async () => {
      const repo = await this.workspace.ensureDefaultRepo();
      if (!piece) {
        const seeded = await commitOf(repo, SEEDED_REF);
        if (seeded === sha) return { outcome: "have" as const };
        // What it holds may be under Firstmate 3000's name, from before an update.
        const held = seeded ?? (await commitOf(repo, OLDER_SEEDED_REF));
        // Held already, say as a part of an earlier one: only the ref moves.
        if (await commitOf(repo, sha)) {
          await git(repo, ["update-ref", SEEDED_REF, sha]);
          return { outcome: "have" as const };
        }
        return { outcome: "need" as const, ...(held ? { have: [held] } : {}) };
      }
      const file = join(this.bundlesDir, `${checked(task)}-seed.bundle`);
      if (piece.offset === 0) {
        await mkdir(this.bundlesDir, { recursive: true, mode: 0o700 });
        await rm(file, { force: true });
      }
      const bytes = Buffer.from(piece.data, "base64");
      if (piece.offset + bytes.length > piece.size)
        throw new Error("The workspace's pieces run past its size.");
      const fd = openSync(file, "a+", 0o600);
      closeSync(fd);
      const handle = openSync(file, "r+");
      try {
        let written = 0;
        while (written < bytes.length)
          written += writeSync(
            handle,
            bytes,
            written,
            bytes.length - written,
            piece.offset + written,
          );
      } finally {
        closeSync(handle);
      }
      if ((await stat(file)).size < piece.size) return { outcome: "partial" as const };
      try {
        await takeBundle(
          repo,
          file,
          { size: piece.size, sha256: piece.sha256 },
          "HEAD",
          SEEDED_REF,
          sha,
        );
      } finally {
        await rm(file, { force: true });
      }
      return { outcome: "ready" as const };
    });
  }

  /** Where a seeded task starts: the commit the home sent, which must be here. */
  private async seededBase(seed: string): Promise<DispatchBase> {
    const repo = await this.workspace.ensureDefaultRepo();
    if ((await commitOf(repo, SEEDED_REF)) !== seed)
      throw new Error("The home's workspace did not arrive here before the working copy.");
    return { sha: seed, ref: `main (${seed.slice(0, 7)})`, fetch: "none" };
  }

  /** The working copy's dependencies, as a new one's are installed at the home. */
  install(task: string): Promise<DependencyInstall> {
    return this.serial(task, async () => {
      if (!this.has(task))
        return { outcome: "failed", ms: 0, error: "no working copy is here for this task" };
      return this.workspace.installDependencies(this.dir(task));
    });
  }

  /**
   * The project's clone here: made once per origin, as a bare repository
   * that knows only `origin`'s default branch, under a temporary name that
   * becomes its own only once it is whole.
   */
  private clone(origin: string): Promise<{ dir: string; cloned: boolean }> {
    const key = createHash("sha256").update(origin).digest("hex").slice(0, 16);
    const known = this.cloning.get(key);
    if (known) return known.then(({ dir }) => ({ dir, cloned: false }));
    const run = this.cloneOnce(origin, join(this.reposDir, key));
    this.cloning.set(key, run);
    run.catch(() => this.cloning.delete(key));
    return run;
  }

  /**
   * The repository here for a project the home keeps only on itself: empty
   * at first, so the home's bundle carries every commit a moved task needs.
   */
  private async localProject(repoId: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(repoId)) throw new Error(`No project is named ${repoId}.`);
    const dir = join(this.reposDir, `local-${repoId}`);
    if (!existsSync(dir)) {
      await mkdir(this.reposDir, { recursive: true, mode: 0o700 });
      await git(this.reposDir, ["init", "--quiet", "--bare", dir]);
    }
    return dir;
  }

  /**
   * A project's repository here that began empty starts on the home's
   * branch at the commit the task's branch left it at, so the task's work
   * is read against it as against a clone's, and the copy can go after.
   */
  private async startOn(repoDir: string, base: { branch: string; sha: string }): Promise<void> {
    if (await git(repoDir, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")) return;
    await git(repoDir, ["check-ref-format", "--branch", base.branch]);
    if (!(await commitOf(repoDir, base.sha)))
      throw new Error("The moved work's starting commit did not arrive here.");
    await git(repoDir, ["update-ref", `refs/heads/${base.branch}`, base.sha, ""]);
    await git(repoDir, ["symbolic-ref", "HEAD", `refs/heads/${base.branch}`]);
  }

  private async cloneOnce(origin: string, dir: string): Promise<{ dir: string; cloned: boolean }> {
    if (existsSync(dir)) {
      const url = await git(dir, ["remote", "get-url", "origin"]).catch(() => "");
      if (url !== origin)
        throw new Error("This computer's clone of the project names another origin.");
      return { dir, cloned: false };
    }
    await mkdir(this.reposDir, { recursive: true, mode: 0o700 });
    const making = join(this.reposDir, `.cloning-${randomUUID().slice(0, 8)}`);
    try {
      await git(this.reposDir, ["init", "--quiet", "--bare", making]);
      await git(making, ["remote", "add", "origin", origin]);
      const remote = { timeoutMs: this.fetchTimeoutMs, env: NO_PROMPT };
      // The default branch, as origin declares it.
      const head = await git(making, ["ls-remote", "--symref", "origin", "HEAD"], remote);
      const name = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1];
      if (!name) throw new Error("The project's origin declares no default branch.");
      await git(
        making,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          `+refs/heads/${name}:refs/remotes/origin/${name}`,
        ],
        remote,
      );
      await git(making, ["symbolic-ref", "HEAD", `refs/heads/${name}`]);
      await git(making, ["update-ref", `refs/heads/${name}`, `refs/remotes/origin/${name}`]);
      await git(making, [
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        `refs/remotes/origin/${name}`,
      ]);
      await rename(making, dir);
      return { dir, cloned: true };
    } catch (caught) {
      await rm(making, { recursive: true, force: true }).catch(() => undefined);
      throw forgeAuthRequired(origin, caught) ?? caught;
    }
  }

  // ---- what it holds ---------------------------------------------------------

  /** A named commit, or the task branch's head, read where the working copy lives. */
  async revision(
    task: string,
    headSha?: string,
  ): Promise<WorkOrderResponse<"inf:working-copy:revision">> {
    const workspace = await this.workspaceOf(task);
    if (!workspace) throw new Error("The source task has no working copy here.");
    const head = headSha ?? (await this.workspace.branchHead(workspace.repoDir, workspace.branch));
    if (!head) throw new Error("The task has no committed revision here.");
    const changedFiles = await this.workspace.reviewChangedFiles(workspace.repoDir, head);
    if (!changedFiles) throw new Error("The requested commit is not on this computer.");
    const changeReading = await this.workspace.reviewChangeReading(workspace.repoDir, head);
    const changeLines = await this.workspace.changeLines(workspace.repoDir, head);
    return {
      headSha: head,
      changedFiles,
      ...(changeReading ? { changeReading } : {}),
      ...(changeLines ? { changeLines } : {}),
    };
  }

  /**
   * Whether the working copy holds edits or commits that never merged, and
   * where the project it was cloned from lives (`inf:working-copy:status`):
   * null for one of this computer's own local workspace, which has none.
   */
  async status(task: string): Promise<WorkOrderResponse<"inf:working-copy:status">> {
    const workspace = await this.workspaceOf(task);
    if (!workspace) return { present: false, dirty: false, unlandedCommits: 0 };
    const held = await this.workspace.taskWorkStatus(workspace, { strict: true });
    const origin = await git(workspace.repoDir, ["remote", "get-url", "origin"]).catch(() => "");
    // The checkout itself, as the home's own working copy reads it for a
    // story: the task's branch, or another the crewmate checked out (INF-2490).
    const branch = await git(workspace.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
      () => "",
    );
    const head = await git(workspace.cwd, ["rev-parse", "HEAD^{commit}"]).catch(() => "");
    return {
      present: true,
      ...held,
      origin: origin || null,
      ...(head ? { checkedOut: { branch: branch || null, head } } : {}),
    };
  }

  /**
   * One of the task's refs as a bundle for the home, leaving out what it
   * has (`inf:working-copy:bundle`): the bundle stays in `bundles/` for the
   * home to read until the next one of that ref, or until the task retires.
   */
  bundle(
    task: string,
    ref: BundledRef,
    have: readonly string[],
    branch?: string,
  ): Promise<WorkOrderResponse<"inf:working-copy:bundle">> {
    return this.serial(task, async () => {
      const workspace = await this.workspaceOf(task);
      if (!workspace) return { sha: null };
      // Another branch the crewmate checked out to deliver (INF-2490).
      if (ref === "branch" && branch !== undefined)
        await git(workspace.repoDir, ["check-ref-format", "--branch", branch]);
      const own = branch ?? workspace.branch;
      if (ref === "branch" && !own) return { sha: null };
      const name =
        ref === "branch"
          ? `refs/heads/${own}`
          : ((await keptRefHere(workspace.repoDir, task)) ?? keptRefFor(task));
      return bundleRef(workspace.repoDir, name, have, this.bundleFile(task, ref));
    });
  }

  /** The bundle (or move pack) made last for that ref, from `offset` (`inf:working-copy:read`). */
  read(task: string, ref: ReadableRef, offset: number): WorkOrderResponse<"inf:working-copy:read"> {
    const fd = openSync(this.bundleFile(task, ref), "r");
    try {
      const size = fstatSync(fd).size;
      const from = Math.min(offset, size);
      const bytes = Buffer.alloc(Math.min(PLACED_COPY_CHUNK_BYTES, size - from));
      let read = 0;
      while (read < bytes.length) {
        const got = readSync(fd, bytes, read, bytes.length - read, from + read);
        if (got === 0) break;
        read += got;
      }
      return { size, offset: from, data: bytes.subarray(0, read).toString("base64") };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Saves what the working copy holds that never merged as one commit on
   * the task's kept ref (`inf:working-copy:keep`), as the home saves its
   * own: uncommitted edits and branch commits, null when there is nothing.
   */
  keep(task: string): Promise<WorkOrderResponse<"inf:working-copy:keep">> {
    return this.serial(task, async () => {
      const workspace = await this.workspaceOf(task);
      if (!workspace) return { kept: null };
      const kept = await this.workspace.keepUnlandedWork(workspace);
      if (kept) return { kept };
      // Nothing is unmerged now, say once the default branch took the
      // task's commits, but work an earlier keep saved here comes home first.
      const name = await keptRefHere(workspace.repoDir, task);
      const sha = name ? await commitOf(workspace.repoDir, name) : null;
      return { kept: name && sha ? { ref: name, sha, dirty: false, unlandedCommits: 0 } : null };
    });
  }

  /**
   * Deletes the task's working copy once the home holds its kept work
   * (`inf:working-copy:retire`): `kept` must be the commit the kept ref
   * points at here and hold every commit of the checkout and the branch
   * that never merged, and with none, nothing may be unmerged. The copy goes
   * to the pool or the trash as the home's does, its branch and kept ref
   * go, and so do its bundles.
   */
  retire(task: string, kept: string | null): Promise<void> {
    return this.serial(task, async () => {
      const workspace = await this.workspaceOf(task);
      if (workspace) {
        // Even a kept ref does not prove an unreadable copy is safe to remove.
        const status = await this.workspace.taskWorkStatus(workspace, { strict: true });
        const keptName = await keptRefHere(workspace.repoDir, task);
        const here = keptName ? await commitOf(workspace.repoDir, keptName) : null;
        if (kept !== null && here !== kept)
          throw new Error("The home does not hold this task's kept work yet, so it stays here.");
        if (kept === null && here !== null)
          throw new Error("This task's work was kept here; the home must take it first.");
        // A keep from before this computer read the branch of a checkout
        // that left it holds the checkout's commits alone.
        if (
          (kept === null && status.dirty) ||
          (await this.workspace.unkeptCommits(workspace, here)) > 0
        )
          throw new Error("This task's working copy holds unmerged work the home has not kept.");
        const sources = await git(workspace.repoDir, [
          "for-each-ref",
          "--format=%(refname)",
          ...sourceRefPatterns(task),
        ]);
        for (const ref of sources.split("\n").filter(Boolean))
          await git(workspace.repoDir, ["update-ref", "-d", ref]);
        await this.workspace.removeTaskWorktree(workspace);
        if (here !== null)
          for (const name of keptRefsFor(task))
            await git(workspace.repoDir, ["update-ref", "-d", name]).catch(() => {});
      }
      for (const ref of ["branch", "kept", "move"] as const)
        await rm(this.bundleFile(task, ref), { force: true });
    });
  }

  /**
   * Packs the task's work to move it to another computer
   * (`inf:working-copy:move-out`): the pack waits in `bundles/` for the
   * home to read with `move`, until the next one or until the task retires.
   * Its conversation must already be idle and let go (`SessionHost`).
   */
  moveOut(
    task: string,
    folders: MovedFolders,
    keep: readonly string[] = [],
  ): Promise<WorkOrderResponse<"inf:working-copy:move-out">> {
    return this.serial(task, async () => {
      const workspace = await this.workspaceOf(task);
      if (!workspace) throw new Error("No working copy is here for this task.");
      const branch = `${TASK_BRANCH_PREFIX}${task}`;
      const { manifest, pack } = await packWork(
        workspace.cwd,
        branch,
        folders,
        this.bundleFile(task, "move"),
        keep,
      );
      return { head: manifest.head, branch, pack };
    });
  }

  /**
   * The working copy of a task that moves here (`inf:working-copy:move-in`):
   * the commits a bundle may leave out first; then the branch's commits
   * from the bundle the home sent, a working copy at `head` on the task's
   * branch, and its work unpacked from the pack, checked against what left.
   * A working copy already here at `head` holding exactly that work is the
   * answer again; one holding anything else is refused, never replaced.
   */
  moveIn(
    request: WorkOrderRequest<"inf:working-copy:move-in">[0],
    files: { bundle?: string; pack?: string },
    folders: MovedFolders,
  ): Promise<WorkOrderResponse<"inf:working-copy:move-in">> {
    const { task, project, seed, head } = request;
    return this.serial(task, async () => {
      const remote = project && "origin" in project && project.pushOrigin ? project : undefined;
      checkPushOrigin(remote);

      const repoDir = !project
        ? await this.workspace.ensureDefaultRepo()
        : "origin" in project
          ? (await this.clone(project.origin)).dir
          : await this.localProject(project.local);
      if (seed && (await commitOf(repoDir, SEEDED_REF)) !== seed)
        throw new Error("The home's workspace did not arrive here before the moved work.");
      if (!request.pack) {
        if (await commitOf(repoDir, head)) return { outcome: "need" as const, have: [head] };
        const tips = await git(repoDir, [
          "for-each-ref",
          "--count=64",
          "--sort=-committerdate",
          "--format=%(objectname)",
          "refs/heads",
          "refs/remotes",
          SEEDED_REF,
        ]);
        return {
          outcome: "need" as const,
          have: [...new Set(tips.split("\n").filter(Boolean))].slice(0, 64),
        };
      }
      const branch = `${TASK_BRANCH_PREFIX}${checked(task)}`;
      if (request.bundle && files.bundle && !(await commitOf(repoDir, head))) {
        const to = `refs/infinitary/sources/${checked(task)}-move`;
        await takeBundle(repoDir, files.bundle, request.bundle, `refs/heads/${branch}`, to, head);
        await git(repoDir, ["update-ref", "-d", to]).catch(() => {});
      }
      if (!(await commitOf(repoDir, head)))
        throw new Error("The moved work's commits did not arrive here.");
      if (project && "local" in project) await this.startOn(repoDir, project.base);
      if (!files.pack) throw new Error("The moved work's pack did not arrive here.");
      const pack = files.pack;
      if (readManifest(pack).manifest.head !== head)
        throw new Error("The moved work's pack is for another commit.");
      // A working copy already here - made before an answer was lost - takes
      // the work only when it is at `head` and holds that work or nothing.
      let dir: string;
      if (this.has(task)) {
        dir = this.dir(task);
        if (remote) await inheritWorktreeRemotes(repoDir, dir, remote, branch);
      } else {
        dir = (
          await this.workspace.createTaskWorktree(checked(task), repoDir, { headSha: head }, remote)
        ).cwd;
      }
      await unpackWork(dir, pack, folders, request.pack);
      if (files.bundle) await rm(files.bundle, { force: true });
      await rm(pack, { force: true });
      return { outcome: "ready" as const, dir, branch };
    });
  }

  /** Fetch starting work into a private ref; leave the new task branch untouched. */
  sourceRef(
    input: WorkOrderRequest<"inf:working-copy:source-ref">[0],
    file: string,
  ): Promise<WorkOrderResponse<"inf:working-copy:source-ref">> {
    return this.serial(input.task, async () => {
      const workspace = await this.workspaceOf(input.task);
      if (!workspace) throw new Error("The destination task has no working copy.");
      if ((await commitOf(workspace.repoDir, input.to)) !== input.sha)
        await takeBundle(workspace.repoDir, file, input, input.from, input.to, input.sha);
      await rm(file, { force: true });
      return { ref: input.to };
    });
  }

  /**
   * One piece of an artifact the home downloaded for the task
   * (`inf:working-copy:artifact`): pieces gather outside the working copy,
   * and once every byte is there and its digest matches, it is written into
   * the working copy as the home writes one (`writeArtifact`).
   */
  artifact(
    request: WorkOrderRequest<"inf:working-copy:artifact">[0],
  ): Promise<WorkOrderResponse<"inf:working-copy:artifact">> {
    const { task, runId, artifactId, part, size, sha256, offset } = request;
    return this.serial(`${task}:artifact`, async () => {
      if (!this.has(task)) throw new Error("No working copy is here for this task.");
      const key = `${checked(task)}-run-${runId}-artifact-${artifactId}${part ? `-${part}` : ""}`;
      let arriving = this.arriving.get(key);
      if (!arriving || arriving.size !== size) {
        await mkdir(this.artifactsDir, { recursive: true, mode: 0o700 });
        arriving = { file: join(this.artifactsDir, `${key}.part`), size };
        await rm(arriving.file, { force: true });
        this.arriving.set(key, arriving);
      }
      const bytes = Buffer.from(request.data, "base64");
      if (offset + bytes.length > size) throw new Error("The artifact's pieces run past its size.");
      const fd = openSync(arriving.file, "a+", 0o600);
      closeSync(fd);
      const handle = openSync(arriving.file, "r+");
      try {
        let written = 0;
        while (written < bytes.length)
          written += writeSync(handle, bytes, written, bytes.length - written, offset + written);
      } finally {
        closeSync(handle);
      }
      if ((await stat(arriving.file)).size < size) return { outcome: "partial" as const };
      this.arriving.delete(key);
      try {
        if ((await sha256Of(arriving.file)) !== sha256)
          throw new Error("The artifact that arrived is not the one the home downloaded.");
        await writeArtifact(this.dir(task), runId, artifactId, await readFile(arriving.file), part);
        return { outcome: "written" as const };
      } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === "EEXIST")
          return { outcome: "exists" as const };
        throw caught;
      } finally {
        await rm(arriving.file, { force: true });
      }
    });
  }

  // ---- inside -------------------------------------------------------------------

  /** Null only when the folder is absent; unreadable existing work refuses every consumer. */
  private async workspaceOf(task: string): Promise<TaskWorkspace | null> {
    if (!this.has(task)) return null;
    const workspace = await this.workspace.workspaceAt(checked(task));
    if (!workspace)
      throw new Error(
        `Infinitary cannot read the work history in ${this.dir(task)}. The working copy stays here until its history can be read.`,
      );
    // Every working copy here was made on its task's branch, which stays the
    // task's wherever its checkout points now, as a reviewer's checks out the
    // version it reads: its work is kept with the copy's, and it goes with it.
    const branch = `${TASK_BRANCH_PREFIX}${task}`;
    if (!workspace.branch && (await commitOf(workspace.repoDir, `refs/heads/${branch}`)))
      return { ...workspace, branch };
    return workspace;
  }

  private bundleFile(task: string, ref: ReadableRef): string {
    return join(this.bundlesDir, `${checked(task)}-${ref}.${ref === "move" ? "pack" : "bundle"}`);
  }

  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(run, run);
    const settled = next.catch(() => undefined);
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }
}

/** A task id names a folder: anything but a minted one is refused before a path is built. */
function checked(task: string): string {
  if (!placedTaskIdSchema.safeParse(task).success) throw new Error(`No task is named ${task}.`);
  return task;
}

/**
 * The name a task's kept work is under in this repository: Infinitary's, or
 * Firstmate 3000's for work kept before this computer was updated; null
 * when there is none.
 */
async function keptRefHere(repoDir: string, task: string): Promise<string | null> {
  for (const name of keptRefsFor(task)) if (await commitOf(repoDir, name)) return name;
  return null;
}
