import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { type ForgeKind, forgeOf, type KnownForgeHost } from "@shared/forge";
import { AUTOMATIC_COMPUTER, placementRequirementsSchema } from "@shared/placement";
import {
  deliveryChoices,
  type ProjectsFolderView,
  QUEUE_HOST_REFUSAL,
  type QueuePause,
  type QueueWorkflow,
  queuePauseSchema,
  queueWorkflowSchema,
  type RepoDelivery,
  type RepoKind,
  type RepoPolicyPatch,
  type RepoSetupCheck,
  type RepoSetupKind,
  type RepoSetupResult,
  type RepoSetupSpec,
  type RepoView,
  repoHostFrom,
  runsHereOnly,
} from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import { z } from "zod";
import { PERSONAL_WORKSPACE_NAME } from "../paths";
import { CostLimitStore } from "../storage/costLimitStore";
import type { AppDatabase } from "../storage/db";
import { ensureRepoProject, ProjectStore } from "../storage/projectStore";
import type { SettingsStore } from "../storage/settingsStore";
import { prepared } from "../storage/statements";
import { APP_GIT_IDENTITY, git, isGitRepo } from "./git";

/**
 * The managed-repo registry (decision D-8, fleet-root revision): local git
 * repos crewmates work on, each task in its own worktree. Setup and policy
 * and removal share the Settings/Firstmate action catalog. SQLite-backed so it survives restarts.
 *
 * The fleet root (userData/fleet) is the app-owned canonical home/index:
 * clone and init create real directories in the projects folder - the
 * fleet root itself unless the person chose another folder in Settings ->
 * Projects, in which case the fleet root links each new directory the way
 * it links an adopted one; adopt keeps an existing folder in place and
 * creates a fleet-root symlink to it (captain's call - adopted data never
 * moves). `path` is always the real working directory, so worktrees and
 * display never care which kind a repo is or where it sits.
 */

export type RepoRegistryOptions = {
  /**
   * Where the person's choice of projects folder is kept. Without it every
   * new project goes in the fleet root and the choice is refused.
   */
  settings?: Pick<SettingsStore, "getProjectsFolder" | "setProjectsFolder">;
  /**
   * The app's own data folder (userData). A projects folder is never inside
   * it: its working copies, sessions and fleet entries are the app's.
   */
  appDataDir?: string;
  /**
   * The hosts on the person's own server the app knows, with each one's
   * kind (`ForgeSignIns.knownHosts`): a new project there is stamped that
   * kind, the way github.com's is GitHub (`docs/forge.md`, "Hosts on your
   * own server").
   */
  knownHosts?: () => readonly KnownForgeHost[];
};

export type { RepoSetupResult, RepoSetupSpec } from "@shared/repos";

type Row = {
  id: string;
  name: string;
  path: string;
  setup_kind: RepoSetupKind;
  kind: RepoKind;
  origin: string | null;
  forge_kind: ForgeKind | null;
  forge_host: string | null;
  delivery: RepoDelivery;
  autonomy: number;
  rigor: Rigor | null;
  scope: string | null;
  runs_on: string | null;
  placement_requirements_json?: string | null;
  queue_workflows_json?: string | null;
  queue_answered_at?: number | null;
  queue_pending_at?: number | null;
  queue_pause_json?: string | null;
};

const ROW_COLUMNS =
  "id, name, path, setup_kind, kind, origin, forge_kind, forge_host, delivery, autonomy, rigor, runs_on, placement_requirements_json, scope, queue_workflows_json, queue_answered_at, queue_pending_at, queue_pause_json";

function fromRow(row: Row): RepoView {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    path: row.path,
    setupKind: row.setup_kind,
    kind: row.kind,
    origin: row.origin,
    // Where the project lives is stamped at insert or approved address change; a row
    // written without it reads its origin the same way the stamp would.
    host: repoHostFrom(
      row.forge_kind ? { kind: row.forge_kind, host: row.forge_host } : forgeOf(row.origin),
    ),
    delivery: row.delivery,
    autonomy: row.autonomy === 1,
    rigor: row.rigor,
    runsOn: row.runs_on ?? null,
    ...(row.placement_requirements_json && row.placement_requirements_json !== "null"
      ? {
          placementRequirements: placementRequirementsSchema.parse(
            JSON.parse(row.placement_requirements_json),
          ),
        }
      : {}),
    ...(row.queue_workflows_json
      ? { queueWorkflows: queueWorkflowsOf(row.queue_workflows_json) }
      : {}),
    ...(typeof row.queue_answered_at === "number"
      ? { queueAnsweredAt: row.queue_answered_at }
      : {}),
    ...(typeof row.queue_pending_at === "number" ? { queuePendingAt: row.queue_pending_at } : {}),
    ...(row.queue_pause_json ? queuePauseOf(row.queue_pause_json) : {}),
  };
}

/** The saved pause; a garbled value reads as no pause. */
function queuePauseOf(json: string): { queuePause?: QueuePause } {
  try {
    const parsed = queuePauseSchema.safeParse(JSON.parse(json));
    return parsed.success ? { queuePause: parsed.data } : {};
  } catch {
    return {};
  }
}

/** The saved queue workflows; a garbled value reads as never read. */
function queueWorkflowsOf(json: string): QueueWorkflow[] | undefined {
  try {
    const parsed = z.array(queueWorkflowSchema).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A new project's row as `saveNewRepo` saves it; each absent policy takes the registry's default. */
export type NewRepoRow = {
  id: string;
  name: string;
  path: string;
  setupKind: RepoSetupKind;
  kind?: RepoKind | undefined;
  origin: string | null;
  delivery: RepoDelivery;
  /** Off when absent. */
  autonomy?: boolean | undefined;
  /** Standard when absent. */
  rigor?: Rigor | null | undefined;
  /** Automatic for a hosted project, else this computer, when absent. */
  runsOn?: string | null | undefined;
  /** When it was added; the list orders by it. Now when absent. */
  addedAt?: number | undefined;
  /** The task key chosen for it, checked free; derived from the name when absent. */
  projectKey?: string | undefined;
};

/**
 * The one writer of a new project's row: where it lives stamped from its
 * address, Runs on stamped for a hosted project, and its task project born
 * in the same transaction (design section 8). `RepoRegistry` saves every
 * project a person adds through it, and fixtures that need a fixed id seed
 * through it (`seedProject`), so a column the registry starts stamping
 * reaches both.
 */
export function saveNewRepo(
  db: AppDatabase,
  spec: NewRepoRow,
  knownHosts: readonly KnownForgeHost[] = [],
): RepoView {
  const kind = spec.kind ?? "project";
  const repo: RepoView = {
    id: spec.id,
    name: spec.name,
    scope: null,
    path: spec.path,
    setupKind: spec.setupKind,
    kind,
    origin: spec.origin,
    host: repoHostFrom(forgeOf(spec.origin, knownHosts)),
    delivery: spec.delivery,
    autonomy: spec.autonomy ?? false,
    rigor: spec.rigor === undefined ? "standard" : spec.rigor,
    runsOn:
      spec.runsOn === undefined
        ? spec.origin && kind !== "personal"
          ? AUTOMATIC_COMPUTER
          : null
        : spec.runsOn,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO repos (id, path, name, setup_kind, kind, origin, forge_kind, forge_host, delivery, autonomy, rigor, added_at, runs_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      repo.id,
      repo.path,
      repo.name,
      repo.setupKind,
      repo.kind,
      repo.origin,
      repo.host?.kind ?? "none",
      repo.host?.name ?? null,
      repo.delivery,
      repo.autonomy ? 1 : 0,
      repo.rigor,
      spec.addedAt ?? Date.now(),
      repo.runsOn,
    );
    ensureRepoProject(db, repo, Date.now(), spec.projectKey);
  })();
  return repo;
}

export class RepoRegistry {
  private projection: Map<string, RepoView | undefined> | undefined;

  /** Placement and policy facts share each project's row during a synchronous read. */
  readProjection<T>(read: () => T): T {
    if (this.projection) return read();
    this.projection = new Map();
    try {
      return read();
    } finally {
      this.projection = undefined;
    }
  }

  /** One project per managed repo (task-system D5), born and archived with the row. */
  private readonly projects: ProjectStore;
  private readonly costLimits: CostLimitStore;
  /** Who hears a project's Runs on change (`onRunsOn`). */
  private readonly runsOnListeners = new Set<(repo: RepoView) => void>();
  /** Who hears a project's queue facts change (`onQueue`). */
  private readonly queueListeners = new Set<(repo: RepoView) => void>();
  /** Who hears a project's delivery become the batched one (`onQueueChosen`). */
  private readonly queueChosenListeners = new Set<(repo: RepoView) => void>();

  constructor(
    private readonly db: AppDatabase,
    private readonly fleetRoot: string,
    private readonly options: RepoRegistryOptions = {},
  ) {
    this.projects = new ProjectStore(db);
    this.costLimits = new CostLimitStore(db);
  }

  /** Where new projects go: the folder the person chose, else the fleet root. */
  projectsFolder(): ProjectsFolderView {
    const chosen = this.options.settings?.getProjectsFolder() ?? null;
    return chosen ? { path: chosen, custom: true } : { path: this.fleetRoot, custom: false };
  }

  /**
   * Choose where new projects go; null, or the fleet root itself, puts it
   * back to the default. Projects already set up stay where they are. A
   * folder that is not there, one the app cannot write to, one inside the
   * app's own data, or one inside a managed project is refused with a
   * reason the person can read.
   */
  setProjectsFolder(raw: string | null): ProjectsFolderView {
    const settings = this.options.settings;
    if (!settings) throw new Error("New projects can only go in Infinitary's own folder here.");
    if (raw === null) {
      settings.setProjectsFolder(null);
      return this.projectsFolder();
    }
    const trimmed = raw.trim();
    if (!isAbsolute(trimmed)) {
      throw new Error(`Choose a folder by its full path; "${raw}" is not one.`);
    }
    const path = resolve(trimmed);
    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) throw new Error(`No folder exists at ${path}.`);
    const real = realPath(path);
    const fleetRoot = realPath(this.fleetRoot);
    if (real === fleetRoot) {
      settings.setProjectsFolder(null);
      return this.projectsFolder();
    }
    const appData = this.options.appDataDir ? realPath(this.options.appDataDir) : null;
    if (sameOrInside(real, fleetRoot) || (appData && sameOrInside(real, appData))) {
      throw new Error(`${path} is inside Infinitary's own data. Choose a folder outside it.`);
    }
    const project = this.list().find((repo) => sameOrInside(real, realPath(repo.path)));
    if (project) {
      throw new Error(
        `${path} is inside your project ${project.name}. Choose a folder outside your projects.`,
      );
    }
    try {
      accessSync(path, constants.W_OK);
    } catch {
      throw new Error(
        `Infinitary cannot add anything to ${path}. Choose a folder it can write to.`,
      );
    }
    settings.setProjectsFolder(path);
    return this.projectsFolder();
  }

  list(): RepoView[] {
    const rows = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM repos ORDER BY added_at`)
      .all() as Row[];
    return rows.map((row) => this.viewOf(row));
  }

  /**
   * A host on the person's own server became known (a key sign-in kept, or
   * the app's start): each project there stamped a plain Git host is
   * stamped the kind it runs - GitHub for a GitHub Enterprise host, or a
   * `.ghe.com` host known by its name. Nothing is ever stamped back: a
   * sign-out leaves the host what it is, the way a github.com project stays
   * GitHub. Says how many projects moved.
   */
  stampKnownHosts(known: readonly KnownForgeHost[]): number {
    // A row written without a stamp reads its origin; it is stamped here too.
    const rows = this.db
      .prepare("SELECT id, origin FROM repos WHERE forge_kind = 'git' OR forge_kind IS NULL")
      .all() as { id: string; origin: string | null }[];
    const stamp = this.db.prepare(
      "UPDATE repos SET forge_kind = ?, forge_host = ? WHERE id = ? AND (forge_kind = 'git' OR forge_kind IS NULL)",
    );
    let moved = 0;
    for (const row of rows) {
      const where = forgeOf(row.origin, known);
      if (where.kind === "git" || where.kind === "none" || !where.host) continue;
      moved += stamp.run(where.kind, where.host, row.id).changes;
      this.projection?.delete(row.id);
    }
    return moved;
  }

  get(id: string): RepoView | undefined {
    if (this.projection?.has(id)) return this.projection.get(id);
    const row = prepared(this.db, `SELECT ${ROW_COLUMNS} FROM repos WHERE id = ?`).get(id) as
      | Row
      | undefined;
    const repo = row ? this.viewOf(row) : undefined;
    this.projection?.set(id, repo);
    return repo;
  }

  private viewOf(row: Row): RepoView {
    const limit = row.kind === "personal" ? null : this.costLimits.limitOf("project", row.id);
    return { ...fromRow(row), ...(row.kind === "personal" ? {} : { costLimit: limit }) };
  }

  /** True only while this exact path remains a registered project checkout. */
  managesProjectPath(id: string, path: string): boolean {
    const repo = this.get(id);
    return !!repo && repo.kind === "project" && resolve(repo.path) === resolve(path);
  }

  /**
   * Add a project. A project already on the list is answered as it is, its
   * key unchanged; a chosen task key is checked before anything is cloned,
   * created or linked, so a refused key leaves nothing behind.
   */
  async setup(spec: RepoSetupSpec): Promise<RepoSetupResult> {
    mkdirSync(this.fleetRoot, { recursive: true });
    if (spec.kind === "clone") return this.clone(spec.origin, spec.name, spec.key);
    if (spec.kind === "init") return this.init(spec.name, spec.key);
    return this.adopt(spec.path, spec.name, spec.key);
  }

  /**
   * What `setup` would do with a spec, read without writing anything (the
   * setup card, docs/fleet.md "Asking the first mate to add a project"): the
   * project already on the list - the same folder, or another project with
   * the same origin - or the name it would get and where it lives. A spec
   * setup would refuse throws the same reason now.
   */
  async check(spec: RepoSetupSpec): Promise<RepoSetupCheck> {
    const sameOrigin = (origin: string | null) =>
      origin
        ? (this.db
            .prepare(`SELECT ${ROW_COLUMNS} FROM repos WHERE origin = ? AND kind = 'project'`)
            .get(origin) as Row | undefined)
        : undefined;
    const lives = (origin: string | null) =>
      repoHostFrom(forgeOf(origin, this.options.knownHosts?.() ?? []));
    if (spec.kind === "clone") {
      const origin = spec.origin.trim();
      if (!origin) throw new Error("clone needs a remote URL in origin.");
      const existing = sameOrigin(origin);
      if (existing) return { existing: fromRow(existing) };
      const name = this.uniqueName(spec.name ?? nameFromOrigin(origin), this.newProjectParent());
      return { name, origin, host: lives(origin), startsGit: false, ...this.chosenKey(spec.key) };
    }
    if (spec.kind === "init") {
      const name = spec.name.trim();
      if (!/^[\w][\w.-]*$/.test(name)) {
        throw new Error(
          `"${spec.name}" is not a usable project name; use letters, digits, dot, dash, underscore.`,
        );
      }
      if (this.nameTaken(name, this.newProjectParent())) {
        throw new Error(`A fleet entry named "${name}" already exists; pick another name.`);
      }
      return { name, origin: null, host: null, startsGit: false, ...this.chosenKey(spec.key) };
    }
    const abs = resolve(spec.path.trim());
    let isDirectory = false;
    try {
      isDirectory = statSync(abs).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) throw new Error(`No folder exists at ${abs}.`);
    if (abs === this.fleetRoot || abs.startsWith(this.fleetRoot + sep)) {
      throw new Error(`${abs} is already inside the fleet root; it needs no adoption.`);
    }
    const here = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM repos WHERE path = ?`).get(abs) as
      | Row
      | undefined;
    if (here) return { existing: fromRow(here) };
    const startsGit = !(await isGitRepo(abs));
    const origin = startsGit
      ? null
      : await git(abs, ["config", "--get", "remote.origin.url"])
          .then((url) => url || null)
          .catch(() => null);
    const existing = sameOrigin(origin);
    if (existing) return { existing: fromRow(existing) };
    return {
      name: this.uniqueName(spec.name ?? basename(abs)),
      origin,
      host: lives(origin),
      startsGit,
      ...this.chosenKey(spec.key),
    };
  }

  /** A chosen task key as a check reads it: normalized, or refused in words. */
  private chosenKey(key: string | undefined): { key?: string } {
    return key === undefined ? {} : { key: this.projects.freeKey(key) };
  }

  /**
   * The personal workspace as a managed repo (talk-to-personalize Step 4):
   * registered on first need, under the reserved name, at the directory the
   * seeder owns, as the one `personal` KIND with autonomy on - a crewmate
   * there builds in place and the host commits. Its delivery column is
   * written local-only and never read: where a change lands is not a
   * question a workspace that never ships one asks. Idempotent; never clones
   * or inits (the seeder made the repo), and never lands anywhere but that
   * path.
   */
  ensurePersonal(workspaceDir: string): RepoView {
    const existing = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM repos WHERE name = ?`)
      .get(PERSONAL_WORKSPACE_NAME) as Row | undefined;
    if (existing) return fromRow(existing);
    const repo = this.insert({
      name: PERSONAL_WORKSPACE_NAME,
      path: workspaceDir,
      setupKind: "init",
      kind: "personal",
      origin: null,
      delivery: "local-only",
    });
    this.db.prepare("UPDATE repos SET autonomy = 1 WHERE id = ?").run(repo.id);
    this.projection?.delete(repo.id);
    return { ...repo, autonomy: true };
  }

  /** The personal workspace's row, when it has been registered. */
  personal(): RepoView | undefined {
    const row = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM repos WHERE name = ?`)
      .get(PERSONAL_WORKSPACE_NAME) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /**
   * Change a repo's delivery posture, autonomy flag, and/or standing rigor
   * (delivery rigor phase 3). Standard is the standing default. The personal
   * workspace takes no policy at all: it is
   * a workspace kind rather than a posture, so every patch on it is refused
   * with one message.
   */
  configure(id: string, changes: RepoPolicyPatch): RepoView {
    const repo = this.checkConfigure(id, changes);
    const name = changes.name ?? repo.name;
    const path = changes.path === undefined ? repo.path : realpathSync(resolve(changes.path));
    const origin = changes.origin === undefined ? repo.origin : changes.origin;
    const where =
      changes.origin === undefined
        ? { kind: repo.host?.kind ?? "none", host: repo.host?.name ?? null }
        : forgeOf(origin, this.options.knownHosts?.());
    const oldLink = join(this.fleetRoot, repo.name);
    const nextLink = join(this.fleetRoot, name);
    let oldTarget: string | undefined;
    let created = false;
    if (name !== repo.name || path !== repo.path) {
      try {
        if (lstatSync(oldLink).isSymbolicLink()) oldTarget = readlinkSync(oldLink);
      } catch {
        /* A folder moved outside the app. */
      }
      if (join(realpathSync(this.fleetRoot), name) !== path) {
        if (nextLink === oldLink && oldTarget !== undefined) unlinkSync(oldLink);
        try {
          symlinkSync(path, nextLink);
          created = true;
        } catch (error) {
          if (nextLink === oldLink && oldTarget !== undefined) symlinkSync(oldTarget, oldLink);
          throw error;
        }
      }
    }
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE repos SET name = ?, path = ?, origin = ?, forge_kind = ?, forge_host = ?, delivery = ?, autonomy = ?, rigor = ?, runs_on = ?, placement_requirements_json = ?, scope = ? WHERE id = ?",
          )
          .run(
            name,
            path,
            origin,
            where.kind,
            where.host,
            changes.delivery ?? repo.delivery,
            (changes.autonomy ?? repo.autonomy) ? 1 : 0,
            changes.rigor === undefined ? repo.rigor : changes.rigor,
            origin && repo.kind === "project"
              ? repo.origin
                ? repo.runsOn
                : AUTOMATIC_COMPUTER
              : null,
            JSON.stringify(
              changes.placementRequirements === undefined
                ? (repo.placementRequirements ?? null)
                : changes.placementRequirements,
            ),
            changes.scope === undefined ? (repo.scope ?? null) : changes.scope,
            id,
          );
        // Any choice of delivery answers a batched choice that waited.
        if (changes.delivery !== undefined && repo.queuePendingAt !== undefined)
          this.db.prepare("UPDATE repos SET queue_pending_at = NULL WHERE id = ?").run(id);
        if (changes.costLimit !== undefined)
          this.costLimits.setLimit("project", id, changes.costLimit, Date.now());
        this.projects.renameForRepo(id, name);
      })();
    } catch (error) {
      if (created) unlinkSync(nextLink);
      if (nextLink === oldLink && oldTarget !== undefined) symlinkSync(oldTarget, oldLink);
      throw error;
    }
    this.projection?.delete(id);
    if (nextLink !== oldLink && oldTarget !== undefined) unlinkSync(oldLink);
    const next = this.get(id) as RepoView;
    if (next.runsOn !== repo.runsOn)
      for (const listener of [...this.runsOnListeners]) listener(next);
    if (changes.delivery === "queue-pr")
      for (const listener of [...this.queueChosenListeners]) listener(next);
    return next;
  }

  /**
   * Hears each choice of the batched delivery (`queue-pr`) on a project,
   * after it is written, whoever made it; answers its own unsubscribe.
   */
  onQueueChosen(listener: (repo: RepoView) => void): () => void {
    this.queueChosenListeners.add(listener);
    return () => {
      this.queueChosenListeners.delete(listener);
    };
  }

  /** Read the checkout's address, never trusting it as the approved destination. */
  async detectedOrigin(id: string): Promise<string | null> {
    const repo = this.get(id);
    if (!repo) throw new Error("That project is no longer here.");
    // A failed read is not proof that origin was removed.
    // Read the configured address, not an insteadOf transport rewrite.
    const remotes = await git(repo.path, ["remote"]);
    return remotes.split("\n").includes("origin")
      ? await git(repo.path, ["config", "--get", "remote.origin.url"])
      : null;
  }

  /** Check a patch without changing the registry, links, or git configuration. */
  checkConfigure(id: string, changes: RepoPolicyPatch): RepoView {
    const repo = this.get(id);
    if (!repo) throw new Error(`Unknown repo_id "${id}".`);
    if (repo.kind === "personal")
      throw new Error(
        changes.name !== undefined || changes.path !== undefined || changes.origin !== undefined
          ? "The personal workspace builds in place; its details and settings cannot change."
          : "The personal workspace builds in place; its delivery, autonomy and rigor cannot change.",
      );
    const name = changes.name ?? repo.name;
    let ownFolder = repo.path;
    if (changes.path !== undefined) {
      let path: string;
      try {
        if (!isAbsolute(changes.path) || !statSync(changes.path).isDirectory())
          throw new Error("Not a project folder.");
        path = realpathSync(changes.path);
      } catch {
        throw new Error("Choose an existing project folder with its full path.");
      }
      ownFolder = path;
      if (this.list().some((other) => other.id !== id && other.path === path))
        throw new Error("That folder already belongs to another project.");
      if (path !== repo.path && existsSync(repo.path))
        throw new Error("Move the project's folder first; changing its folder never moves files.");
    }
    // The delivery the project would have, against the host it would live on:
    // a new address can move a queue-pr project off GitHub too.
    const host =
      changes.origin === undefined
        ? repo.host
        : repoHostFrom(forgeOf(changes.origin, this.options.knownHosts?.()));
    if (
      (changes.delivery ?? repo.delivery) === "queue-pr" &&
      !deliveryChoices(host).includes("queue-pr")
    )
      throw new Error(QUEUE_HOST_REFUSAL);
    if (
      name !== repo.name &&
      (!/^[\w][\w.-]*$/.test(name) || this.nameTaken(name, undefined, ownFolder))
    )
      throw new Error(
        "Choose an unused project name with letters, digits, dot, dash or underscore.",
      );
    return repo;
  }

  /** Also check git for a new folder or address; failure never clears a saved address. */
  async checkDetails(id: string, changes: RepoPolicyPatch): Promise<void> {
    const repo = this.checkConfigure(id, changes);
    const path = changes.path ?? repo.path;
    if (changes.path !== undefined) {
      if (
        !(await isGitRepo(path)) ||
        realpathSync(await git(path, ["rev-parse", "--show-toplevel"])) !== realpathSync(path)
      )
        throw new Error("Choose the git project's main folder, not a folder inside it.");
    }
    if (changes.origin !== undefined) {
      if (changes.origin?.includes("://")) {
        const address = new URL(changes.origin);
        if (address.password || (address.username && address.protocol !== "ssh:"))
          throw new Error("Use a project address without sign-in material.");
      }
      const remotes = await git(path, ["remote"]);
      const current = remotes.split("\n").includes("origin")
        ? await git(path, ["config", "--get", "remote.origin.url"])
        : null;
      if (current !== changes.origin)
        throw new Error(
          "Where the folder points changed. Check its current address and ask again.",
        );
    }
  }

  /**
   * Choose where a project's next task starts (multi-machine piece 11,
   * docs/helper.md "Runs on"): a paired computer that runs work by its id,
   * or null for this Mac. The caller checks the device and the captain-held
   * gate; a project that can run only here is refused with its reason
   * (`runsHereOnly`). A task already started keeps the computer it started on.
   */
  setRunsOn(id: string, deviceId: string | null): RepoView {
    const repo = this.get(id);
    if (!repo) throw new Error(`Unknown repo_id "${id}".`);
    const here = runsHereOnly(repo);
    if (here && deviceId !== null) throw new Error(`${repo.name}: ${here}`);
    this.db.prepare("UPDATE repos SET runs_on = ? WHERE id = ?").run(deviceId, id);
    this.projection?.delete(id);
    const next = this.get(id) as RepoView;
    for (const listener of [...this.runsOnListeners]) listener(next);
    return next;
  }

  /**
   * A project's queue facts (docs/forge.md, "A project's queue"): the
   * workflow files that mention its queue status as just read, and when
   * anything but the app answered that status, kept as the latest such
   * time. Answers whether a fact changed; the listeners hear only a change.
   */
  recordQueue(
    id: string,
    facts: { workflows?: QueueWorkflow[]; answeredAt?: number; pause?: QueuePause | null },
  ): RepoView | undefined {
    const repo = this.get(id);
    if (!repo) return undefined;
    const pauseChanged =
      facts.pause !== undefined &&
      JSON.stringify(facts.pause ?? undefined) !== JSON.stringify(repo.queuePause);
    if (pauseChanged)
      this.db
        .prepare("UPDATE repos SET queue_pause_json = ? WHERE id = ?")
        .run(facts.pause ? JSON.stringify(facts.pause) : null, id);
    const workflows =
      facts.workflows === undefined
        ? undefined
        : [...facts.workflows].sort((a, b) => a.path.localeCompare(b.path));
    const workflowsChanged =
      workflows !== undefined && JSON.stringify(workflows) !== JSON.stringify(repo.queueWorkflows);
    const answeredChanged =
      facts.answeredAt !== undefined && facts.answeredAt > (repo.queueAnsweredAt ?? -1);
    if (!workflowsChanged && !answeredChanged && !pauseChanged) return repo;
    if (workflowsChanged)
      this.db
        .prepare("UPDATE repos SET queue_workflows_json = ? WHERE id = ?")
        .run(JSON.stringify(workflows), id);
    if (answeredChanged)
      this.db
        .prepare("UPDATE repos SET queue_answered_at = ? WHERE id = ?")
        .run(facts.answeredAt, id);
    this.projection?.delete(id);
    const next = this.get(id) as RepoView;
    for (const listener of [...this.queueListeners]) listener(next);
    return next;
  }

  /**
   * Keep a project's batched choice waiting from `at`, or end the wait with
   * null (docs/forge.md, "Choosing batched pull requests before a queue
   * exists"). The project's delivery is unchanged; the queue listeners hear
   * the change, so Settings reads the project again.
   */
  waitForQueue(id: string, at: number | null): RepoView | undefined {
    const repo = this.get(id);
    if (!repo || (repo.queuePendingAt ?? null) === at) return repo;
    this.db.prepare("UPDATE repos SET queue_pending_at = ? WHERE id = ?").run(at, id);
    this.projection?.delete(id);
    const next = this.get(id) as RepoView;
    for (const listener of [...this.queueListeners]) listener(next);
    return next;
  }

  /**
   * The shipped queue's version the first mate was last told to offer for
   * this project (an update, or replacing the project's own queue), so each
   * offer is made once; undefined when none was.
   */
  queueOffered(id: string): number | undefined {
    const row = this.db.prepare("SELECT queue_offered FROM repos WHERE id = ?").get(id) as
      | { queue_offered: number | null }
      | undefined;
    return typeof row?.queue_offered === "number" ? row.queue_offered : undefined;
  }

  /** Keep that the first mate was told to offer the shipped queue's `version` for this project. */
  recordQueueOffered(id: string, version: number): void {
    this.db.prepare("UPDATE repos SET queue_offered = ? WHERE id = ?").run(version, id);
  }

  /** Hears each change of a project's queue facts, after it is written; answers its own unsubscribe. */
  onQueue(listener: (repo: RepoView) => void): () => void {
    this.queueListeners.add(listener);
    return () => {
      this.queueListeners.delete(listener);
    };
  }

  /** Hears each change of a project's Runs on, after it is written; answers its own unsubscribe. */
  onRunsOn(listener: (repo: RepoView) => void): () => void {
    this.runsOnListeners.add(listener);
    return () => {
      this.runsOnListeners.delete(listener);
    };
  }

  /**
   * Drop the registration. Never deletes repo data: a repo outside the
   * fleet root - adopted, or cloned or created in a chosen projects folder -
   * loses only its fleet-root symlink; directories stay on disk.
   */
  unregister(id: string): void {
    const repo = this.get(id);
    if (repo?.name === PERSONAL_WORKSPACE_NAME) {
      throw new Error(
        "The personal workspace is the app's own and stays managed; remove a panel with personalize instead.",
      );
    }
    if (repo) {
      // Only ever a link: a project in the fleet root itself is a real
      // directory, and it stays.
      const link = join(this.fleetRoot, repo.name);
      try {
        if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
      } catch {
        // No link to clean (legacy row, or the user removed it) - fine.
      }
    }
    const drop = this.db.transaction(() => {
      this.db.prepare("DELETE FROM repos WHERE id = ?").run(id);
      this.projection?.delete(id);
      // The project archives, never deletes: its closed tasks stay readable.
      this.projects.archiveForRepo(id);
    });
    drop();
  }

  private async clone(originRaw: string, name?: string, key?: string): Promise<RepoSetupResult> {
    const origin = originRaw.trim();
    if (!origin) throw new Error("clone needs a remote URL in origin.");
    const existing = this.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM repos WHERE origin = ? AND setup_kind = 'clone'`)
      .get(origin) as Row | undefined;
    if (existing) return { repo: fromRow(existing), created: false };
    const { key: projectKey } = this.chosenKey(key);
    const parent = this.newProjectParent();
    const repoName = this.uniqueName(name ?? nameFromOrigin(origin), parent);
    const target = join(parent, repoName);
    // "--" so an origin starting with "-" can never be read as a git option.
    await git(parent, ["clone", "--", origin, repoName]);
    this.linkFromFleetRoot(parent, repoName);
    // An empty remote clones with an unborn HEAD; seed it like init so task
    // worktrees can branch.
    const createdInitialCommit = await this.ensureInitialCommit(target);
    const repo = this.insert({
      name: repoName,
      path: target,
      setupKind: "clone",
      origin,
      delivery: "direct-pr",
      projectKey,
    });
    return { repo, created: true, ...(createdInitialCommit ? { createdInitialCommit } : {}) };
  }

  private async init(nameRaw: string, key?: string): Promise<RepoSetupResult> {
    const name = nameRaw.trim();
    if (!/^[\w][\w.-]*$/.test(name)) {
      throw new Error(
        `"${nameRaw}" is not a usable project name; use letters, digits, dot, dash, underscore.`,
      );
    }
    const parent = this.newProjectParent();
    if (this.nameTaken(name, parent)) {
      throw new Error(`A fleet entry named "${name}" already exists; pick another name.`);
    }
    const { key: projectKey } = this.chosenKey(key);
    const target = join(parent, name);
    await git(parent, ["init", "-b", "main", name]);
    this.linkFromFleetRoot(parent, name);
    const createdInitialCommit = await this.ensureInitialCommit(target);
    const repo = this.insert({
      name,
      path: target,
      setupKind: "init",
      origin: null,
      delivery: "local-only",
      projectKey,
    });
    return { repo, created: true, ...(createdInitialCommit ? { createdInitialCommit } : {}) };
  }

  private async adopt(pathRaw: string, name?: string, key?: string): Promise<RepoSetupResult> {
    const abs = resolve(pathRaw.trim());
    let isDirectory = false;
    try {
      isDirectory = statSync(abs).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) throw new Error(`No folder exists at ${abs}.`);
    if (abs === this.fleetRoot || abs.startsWith(this.fleetRoot + sep)) {
      throw new Error(`${abs} is already inside the fleet root; it needs no adoption.`);
    }
    const existing = this.db.prepare(`SELECT ${ROW_COLUMNS} FROM repos WHERE path = ?`).get(abs) as
      | Row
      | undefined;
    if (existing) return { repo: fromRow(existing), created: false };
    const { key: projectKey } = this.chosenKey(key);

    const initializedGit = !(await isGitRepo(abs));
    if (initializedGit) await git(abs, ["init", "-b", "main"]);
    const createdInitialCommit = await this.ensureInitialCommit(abs);
    const origin = await git(abs, ["config", "--get", "remote.origin.url"])
      .then((url) => url || null)
      .catch(() => null);
    const repoName = this.uniqueName(name ?? basename(abs));
    // The linked reference (captain's call): the fleet root indexes the
    // repo, the data stays put.
    symlinkSync(abs, join(this.fleetRoot, repoName));
    const repo = this.insert({
      name: repoName,
      path: abs,
      setupKind: "adopt",
      origin,
      delivery: origin ? "direct-pr" : "local-only",
      projectKey,
    });
    return {
      repo,
      created: true,
      ...(initializedGit ? { initializedGit } : {}),
      ...(createdInitialCommit ? { createdInitialCommit } : {}),
    };
  }

  private insert(spec: {
    name: string;
    path: string;
    setupKind: RepoSetupKind;
    kind?: RepoKind;
    origin: string | null;
    delivery: RepoDelivery;
    /** The task key chosen for it, checked free; derived from the name when absent. */
    projectKey?: string | undefined;
  }): RepoView {
    const repo = saveNewRepo(
      this.db,
      { ...spec, id: randomUUID().slice(0, 8) },
      this.options.knownHosts?.() ?? [],
    );
    this.projection?.delete(repo.id);
    return repo;
  }

  /** Seed history for worktrees without including or consuming the person's staged files. */
  private async ensureInitialCommit(dir: string): Promise<boolean> {
    try {
      await git(dir, ["rev-parse", "--verify", "HEAD"]);
      return false;
    } catch {
      await git(dir, [
        ...APP_GIT_IDENTITY,
        "commit",
        // --allow-empty permits an empty commit but still includes the index.
        // --only with no paths ignores it, including when HEAD is unborn.
        "--only",
        "--allow-empty",
        "-m",
        "chore: initialize fleet project",
      ]);
      return true;
    }
  }

  /**
   * The folder a clone or init creates its directory in. A chosen folder
   * that is no longer there - a drive not plugged in, a folder removed -
   * refuses the setup rather than being made anew where nobody picked.
   */
  private newProjectParent(): string {
    const { path, custom } = this.projectsFolder();
    if (!custom) return this.fleetRoot;
    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      throw new Error(
        `The folder chosen for new projects, ${path}, is not there. Reconnect the drive it is on, or choose another folder in Settings under Projects.`,
      );
    }
    return path;
  }

  /** A new project outside the fleet root is indexed there by a link, like an adopted one. */
  private linkFromFleetRoot(parent: string, name: string): void {
    if (parent === this.fleetRoot) return;
    symlinkSync(join(parent, name), join(this.fleetRoot, name));
  }

  /**
   * Taken in the registry, in the fleet root's index, or - for a directory
   * about to be created in a chosen projects folder - already there.
   */
  private nameTaken(name: string, parent?: string, ownFolder?: string): boolean {
    // The personal workspace's name is reserved even before its directory
    // exists, so a clone or init never lands where the seeder will write.
    if (name === PERSONAL_WORKSPACE_NAME) return true;
    if (this.db.prepare("SELECT 1 FROM repos WHERE name = ?").get(name)) return true;
    return [this.fleetRoot, ...(parent && parent !== this.fleetRoot ? [parent] : [])].some(
      (dir) => {
        try {
          const entry = join(dir, name);
          const stat = lstatSync(entry);
          if (ownFolder && stat.isDirectory() && realpathSync(entry) === ownFolder) return false;
          return true;
        } catch {
          return false;
        }
      },
    );
  }

  private uniqueName(base: string, parent?: string): string {
    const cleaned = base.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "repo";
    for (let i = 0; ; i += 1) {
      const candidate = i === 0 ? cleaned : `${cleaned}-${i + 1}`;
      if (!this.nameTaken(candidate, parent)) return candidate;
    }
  }
}

/** The folder's real path, or its resolved one when it cannot be read. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True for `parent` itself and anything beneath it. */
function sameOrInside(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** "https://host/owner/repo.git" or "/local/path/repo" -> "repo". */
function nameFromOrigin(origin: string): string {
  const tail = origin.replace(/\/+$/, "").split(/[/:]/).at(-1) ?? "repo";
  return tail.replace(/\.git$/, "");
}
