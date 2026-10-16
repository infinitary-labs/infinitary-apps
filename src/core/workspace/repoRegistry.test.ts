import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PERSONAL_WORKSPACE_NAME } from "../paths";
import { openInMemoryDatabase } from "../storage/db";
import { ProjectStore } from "../storage/projectStore";
import { SettingsStore } from "../storage/settingsStore";
import { APP_GIT_IDENTITY, git } from "./git";
import { RepoRegistry } from "./repoRegistry";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * The personal workspace as a managed repo (talk-to-personalize Step 4):
 * registered on first need at the seeder's directory on the live posture
 * with autonomy on, born with its project, and guarded - its posture never
 * changes, no other repo takes it, and it is never unregistered.
 */
function setup() {
  const db = openInMemoryDatabase();
  const fleetRoot = scratchDir("infinitary-fleet-");
  const workspaceDir = join(fleetRoot, PERSONAL_WORKSPACE_NAME);
  mkdirSync(workspaceDir, { recursive: true });
  execFileSync("git", ["-C", workspaceDir, "init", "-q", "-b", "main"]);
  return { db, registry: new RepoRegistry(db, fleetRoot), workspaceDir, fleetRoot };
}

describe("RepoRegistry.setup initial history", () => {
  let db: ReturnType<typeof openInMemoryDatabase>;
  let registry: RepoRegistry;

  beforeEach(() => {
    vi.stubEnv("HOME", scratchDir("infinitary-git-home-"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    db = openInMemoryDatabase();
    registry = new RepoRegistry(db, scratchDir("infinitary-fleet-"));
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });

  it("adopts an unborn repo without committing or changing its staged files", async () => {
    const dir = scratchDir("infinitary-staged-");
    await git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "partial.txt"), "staged version\n");
    writeFileSync(join(dir, "removed.txt"), "staged but removed from working folder\n");
    await git(dir, ["add", "partial.txt", "removed.txt"]);
    writeFileSync(join(dir, "partial.txt"), "unstaged version\n");
    unlinkSync(join(dir, "removed.txt"));
    writeFileSync(join(dir, "untracked.txt"), "untracked content\n");
    const staged = await git(dir, ["ls-files", "--stage", "-z"], { trim: false });
    const status = await git(dir, ["status", "--short"], { trim: false });

    const result = await registry.setup({ kind: "adopt", path: dir });

    expect(result).toMatchObject({ created: true, createdInitialCommit: true });
    expect(result.initializedGit).toBeUndefined();
    expect(await git(dir, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("");
    expect(await git(dir, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(dir, ["ls-files", "--stage", "-z"], { trim: false })).toBe(staged);
    expect(await git(dir, ["status", "--short"], { trim: false })).toBe(status);
    expect(await git(dir, ["show", ":partial.txt"])).toBe("staged version");
    expect(readFileSync(join(dir, "partial.txt"), "utf8")).toBe("unstaged version\n");
    expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe("untracked content\n");

    // The initial history is usable, but the person's files stay out of a task checkout.
    const worktree = join(scratchDir("infinitary-checkout-"), "task");
    await git(dir, ["worktree", "add", "-b", "task", worktree, "HEAD"]);
    expect(readdirSync(worktree)).toEqual([".git"]);
    await git(dir, ["worktree", "remove", worktree]);
    const head = await git(dir, ["rev-parse", "HEAD"]);
    expect(await registry.setup({ kind: "adopt", path: dir })).toEqual({
      repo: result.repo,
      created: false,
    });
    expect(await git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(dir, ["ls-files", "--stage", "-z"], { trim: false })).toBe(staged);
  });

  it("initializes a plain folder without adding its existing files", async () => {
    const dir = scratchDir("infinitary-plain-");
    writeFileSync(join(dir, "notes.txt"), "existing notes\n");
    const result = await registry.setup({ kind: "adopt", path: dir });
    expect(result).toMatchObject({ initializedGit: true, createdInitialCommit: true });
    expect(await git(dir, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("");
    expect(await git(dir, ["ls-files", "--stage"])).toBe("");
    expect(await git(dir, ["status", "--short"])).toBe("?? notes.txt");
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("existing notes\n");
  });

  it("leaves existing history and pending changes untouched", async () => {
    const dir = scratchDir("infinitary-history-");
    await git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "notes.txt"), "committed notes\n");
    await git(dir, ["add", "notes.txt"]);
    await git(dir, [...APP_GIT_IDENTITY, "commit", "-m", "chore: existing history"]);
    writeFileSync(join(dir, "notes.txt"), "staged notes\n");
    await git(dir, ["add", "notes.txt"]);
    writeFileSync(join(dir, "notes.txt"), "unstaged notes\n");
    const head = await git(dir, ["rev-parse", "HEAD"]);
    const staged = await git(dir, ["ls-files", "--stage"]);
    const result = await registry.setup({ kind: "adopt", path: dir });
    expect(result.createdInitialCommit).toBeUndefined();
    expect(await git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(dir, ["ls-files", "--stage"])).toBe(staged);
    expect(await git(dir, ["show", "HEAD:notes.txt"])).toBe("committed notes");
    expect(await git(dir, ["show", ":notes.txt"])).toBe("staged notes");
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("unstaged notes\n");
  });

  it.each(["init", "clone"] as const)("seeds empty history for %s too", async (kind) => {
    const source = scratchDir("infinitary-empty-remote-");
    await git(source, ["init", "--bare", "-q", "-b", "main"]);
    const result = await registry.setup(
      kind === "init" ? { kind, name: "new-project" } : { kind, origin: source },
    );
    expect(result.createdInitialCommit).toBe(true);
    expect(await git(result.repo.path, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(result.repo.path, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe("");
    expect(await git(result.repo.path, ["status", "--short"])).toBe("");
  });
});

describe("RepoRegistry.ensurePersonal", () => {
  it("registers the workspace once, as the personal kind, autonomous, with a project of its own", () => {
    const { db, registry, workspaceDir } = setup();
    expect(registry.personal()).toBeUndefined();
    const repo = registry.ensurePersonal(workspaceDir);
    expect(repo).toMatchObject({
      name: PERSONAL_WORKSPACE_NAME,
      path: workspaceDir,
      setupKind: "init",
      origin: null,
      kind: "personal",
      delivery: "local-only",
      autonomy: true,
    });
    expect(registry.ensurePersonal(workspaceDir)).toEqual(repo);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get(repo.id)).toEqual(repo);
    expect(registry.personal()).toEqual(repo);
    const project = new ProjectStore(db).list().find((row) => row.repoId === repo.id);
    expect(project?.name).toBe(PERSONAL_WORKSPACE_NAME);
  });

  it("refuses every policy patch on the personal workspace and never unregisters it", async () => {
    const { registry, workspaceDir, fleetRoot } = setup();
    const personal = registry.ensurePersonal(workspaceDir);
    // One message for the whole patch: the personal workspace is a
    // workspace kind, so delivery, autonomy and rigor are not questions it
    // answers.
    for (const patch of [
      { delivery: "direct-pr" as const },
      { autonomy: false },
      { rigor: "standard" as const },
      { delivery: "local-only" as const, autonomy: true },
    ]) {
      expect(() => registry.configure(personal.id, patch)).toThrow(
        "The personal workspace builds in place; its delivery, autonomy and rigor cannot change.",
      );
    }
    expect(registry.get(personal.id)).toMatchObject({ kind: "personal", autonomy: true });
    expect(() => registry.unregister(personal.id)).toThrow(/personalize/);
    expect(registry.get(personal.id)).toBeDefined();

    // An ordinary repository is a project and takes every patch.
    const other = await registry.setup({ kind: "init", name: "notes" });
    expect(other.repo.path).toBe(join(fleetRoot, "notes"));
    expect(other.repo.kind).toBe("project");
    expect(registry.configure(other.repo.id, { delivery: "direct-pr" })).toMatchObject({
      kind: "project",
      delivery: "direct-pr",
    });
    await expect(registry.setup({ kind: "init", name: PERSONAL_WORKSPACE_NAME })).rejects.toThrow(
      /already exists/,
    );
  });
});

/**
 * A project's Runs on (docs/helper.md, "Runs on"): a computer that runs work
 * by its id, or null for this Mac, kept with the project; the personal
 * workspace and a project with no origin run only here.
 */
describe("RepoRegistry.setRunsOn", () => {
  it("keeps where a project with an origin runs, and refuses one that runs only here", async () => {
    const { registry, workspaceDir } = setup();
    const elsewhere = scratchDir("infinitary-runs-on-");
    const origin = join(elsewhere, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
    const website = join(elsewhere, "website");
    execFileSync("git", ["clone", "-q", origin, website]);
    const { repo } = await registry.setup({ kind: "adopt", path: website });
    expect(repo.runsOn).toBe(AUTOMATIC_COMPUTER);
    expect(registry.setRunsOn(repo.id, "mini-1")).toMatchObject({ runsOn: "mini-1" });
    expect(registry.get(repo.id)?.runsOn).toBe("mini-1");
    expect(registry.list().find((entry) => entry.id === repo.id)?.runsOn).toBe("mini-1");
    expect(registry.setRunsOn(repo.id, null).runsOn).toBeNull();

    const notes = await registry.setup({ kind: "init", name: "notes" });
    expect(() => registry.setRunsOn(notes.repo.id, "mini-1")).toThrow(
      "notes: Kept on this computer only, so its tasks run here.",
    );
    expect(registry.setRunsOn(notes.repo.id, null).runsOn).toBeNull();
    const personal = registry.ensurePersonal(workspaceDir);
    expect(() => registry.setRunsOn(personal.id, "mini-1")).toThrow(
      "The personal workspace stays on this computer.",
    );
    expect(registry.get(personal.id)?.runsOn).toBeNull();
  });
});

/**
 * A host on the person's own server (`docs/forge.md`, "Hosts on your own
 * server"): a project there is a plain Git host until the app knows the
 * host, then the kind it runs - stamped at setup once known, and stamped
 * once it becomes known, never back.
 */
describe("RepoRegistry on a host on the person's own server", () => {
  it("stamps a project there the host's kind once the app knows it, and never stamps it back", async () => {
    const db = openInMemoryDatabase();
    let known: { host: string; kind: "github" }[] = [];
    const registry = new RepoRegistry(db, scratchDir("infinitary-fleet-"), {
      knownHosts: () => known,
    });
    const adopt = async (name: string, origin: string) => {
      const dir = join(scratchDir("infinitary-known-host-"), name);
      execFileSync("git", ["init", "-q", "-b", "main", dir]);
      execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
      return (await registry.setup({ kind: "adopt", path: dir })).repo;
    };
    const meter = await adopt("meter", "https://github.corp.example/acme/meter.git");
    const ledger = await adopt("ledger", "https://octo.ghe.com/acme/ledger.git");
    const notes = await adopt("notes", "https://git.example.com/me/notes.git");
    expect(meter.host).toEqual({ kind: "git", name: "github.corp.example" });
    expect(ledger.host).toEqual({ kind: "github", name: "octo.ghe.com" });

    known = [{ host: "github.corp.example", kind: "github" }];
    expect(registry.stampKnownHosts(known)).toBe(1);
    expect(registry.get(meter.id)?.host).toEqual({ kind: "github", name: "github.corp.example" });
    expect(registry.get(notes.id)?.host).toEqual({ kind: "git", name: "git.example.com" });
    const website = await adopt("website", "git@github.corp.example:acme/website.git");
    expect(website.host).toEqual({ kind: "github", name: "github.corp.example" });

    // The host stays what it is once the app no longer holds a sign-in there.
    known = [];
    expect(registry.stampKnownHosts(known)).toBe(0);
    expect(registry.get(meter.id)?.host?.kind).toBe("github");
  });
});

/**
 * Where new projects go (Settings -> Projects): clone and init create their
 * directories in the folder the person chose, the fleet root indexes each
 * by a link the way it indexes an adopted folder, and projects already set
 * up never move. The choice is persisted in the settings rows, so another
 * registry over the same database - the next launch - reads it.
 */
describe("RepoRegistry projects folder", () => {
  let db: ReturnType<typeof openInMemoryDatabase>;
  let appData: string;
  let fleetRoot: string;
  let chosen: string;

  const registryOn = () =>
    new RepoRegistry(db, fleetRoot, { settings: new SettingsStore(db), appDataDir: appData });

  beforeEach(() => {
    vi.stubEnv("HOME", scratchDir("infinitary-git-home-"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    db = openInMemoryDatabase();
    appData = realpathSync(scratchDir("infinitary-app-data-"));
    fleetRoot = join(appData, "fleet");
    chosen = realpathSync(scratchDir("infinitary-projects-"));
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });

  it("starts at the fleet root, and new projects there are real directories", async () => {
    const registry = registryOn();
    expect(registry.projectsFolder()).toEqual({ path: fleetRoot, custom: false });
    const { repo } = await registry.setup({ kind: "init", name: "plain" });
    expect(repo.path).toBe(join(fleetRoot, "plain"));
    expect(lstatSync(repo.path).isDirectory()).toBe(true);
  });

  it("clones and creates new projects in the chosen folder, linked from the fleet root", async () => {
    const origin = scratchDir("infinitary-origin-");
    await git(origin, ["init", "-q", "-b", "main"]);
    await git(origin, [...APP_GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "chore: init"]);
    const registry = registryOn();
    const before = await registry.setup({ kind: "init", name: "older" });

    expect(registry.setProjectsFolder(chosen)).toEqual({ path: chosen, custom: true });
    // The next launch reads the same choice.
    expect(registryOn().projectsFolder()).toEqual({ path: chosen, custom: true });

    const created = await registryOn().setup({ kind: "init", name: "nebula" });
    const cloned = await registryOn().setup({ kind: "clone", origin });
    for (const repo of [created.repo, cloned.repo]) {
      expect(repo.path).toBe(join(chosen, repo.name));
      expect(lstatSync(repo.path).isDirectory()).toBe(true);
      expect(existsSync(join(repo.path, ".git"))).toBe(true);
      const link = join(fleetRoot, repo.name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(repo.path);
    }
    expect(created.repo.setupKind).toBe("init");
    expect(cloned.repo).toMatchObject({ setupKind: "clone", origin, delivery: "direct-pr" });
    // A project set up before the change stays where it was.
    expect(registry.get(before.repo.id)?.path).toBe(join(fleetRoot, "older"));
    expect(lstatSync(join(fleetRoot, "older")).isDirectory()).toBe(true);

    // Back to the default: new projects go in the fleet root again, and the
    // ones made in the chosen folder stay there.
    expect(registry.setProjectsFolder(null)).toEqual({ path: fleetRoot, custom: false });
    const after = await registry.setup({ kind: "init", name: "later" });
    expect(after.repo.path).toBe(join(fleetRoot, "later"));
    expect(registry.get(created.repo.id)?.path).toBe(join(chosen, "nebula"));
  });

  it("never takes a folder already in the chosen one, and adopting from it keeps the name", async () => {
    const registry = registryOn();
    registry.setProjectsFolder(chosen);
    mkdirSync(join(chosen, "taken"));
    writeFileSync(join(chosen, "taken", "mine.txt"), "the person's own\n");

    await expect(registry.setup({ kind: "init", name: "taken" })).rejects.toThrow(/already exists/);
    const origin = scratchDir("infinitary-origin-");
    await git(origin, ["init", "-q", "-b", "main"]);
    const cloned = await registry.setup({ kind: "clone", origin, name: "taken" });
    expect(cloned.repo.path).toBe(join(chosen, "taken-2"));
    expect(readFileSync(join(chosen, "taken", "mine.txt"), "utf8")).toBe("the person's own\n");

    // A folder already in the projects folder is adopted in place, as itself.
    mkdirSync(join(chosen, "sketches"));
    const adopted = await registry.setup({ kind: "adopt", path: join(chosen, "sketches") });
    expect(adopted.repo).toMatchObject({ name: "sketches", path: join(chosen, "sketches") });
  });

  it("unregistering drops only the fleet-root link and keeps the directory", async () => {
    const registry = registryOn();
    registry.setProjectsFolder(chosen);
    const { repo } = await registry.setup({ kind: "init", name: "keepme" });
    registry.unregister(repo.id);
    expect(existsSync(join(fleetRoot, "keepme"))).toBe(false);
    expect(lstatSync(join(chosen, "keepme")).isDirectory()).toBe(true);
    expect(existsSync(join(chosen, "keepme", ".git"))).toBe(true);
  });

  it("refuses a folder that is not there any more instead of making it anew", async () => {
    const registry = registryOn();
    const gone = join(chosen, "drive");
    mkdirSync(gone);
    registry.setProjectsFolder(gone);
    rmSync(gone, { recursive: true });
    await expect(registry.setup({ kind: "init", name: "lost" })).rejects.toThrow(
      `The folder chosen for new projects, ${gone}, is not there.`,
    );
    expect(existsSync(gone)).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it("refuses folders new projects cannot go in, with a reason, and keeps the choice", async () => {
    const registry = registryOn();
    registry.setProjectsFolder(chosen);
    const project = await registry.setup({ kind: "init", name: "home-base" });
    mkdirSync(join(appData, "worktrees"), { recursive: true });

    expect(() => registry.setProjectsFolder("code")).toThrow(/full path/);
    expect(() => registry.setProjectsFolder(join(chosen, "missing"))).toThrow(
      `No folder exists at ${join(chosen, "missing")}.`,
    );
    expect(() => registry.setProjectsFolder(join(appData, "worktrees"))).toThrow(
      "inside Infinitary's own data",
    );
    expect(() => registry.setProjectsFolder(appData)).toThrow("inside Infinitary's own data");
    const inside = join(project.repo.path, "nested");
    mkdirSync(inside);
    expect(() => registry.setProjectsFolder(inside)).toThrow(
      `${inside} is inside your project home-base.`,
    );
    if (process.getuid?.() !== 0) {
      const locked = join(chosen, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      try {
        expect(() => registry.setProjectsFolder(locked)).toThrow(/cannot add anything/);
      } finally {
        chmodSync(locked, 0o700);
      }
    }
    expect(registry.projectsFolder()).toEqual({ path: chosen, custom: true });

    // Choosing the fleet root itself is the default, not a custom folder.
    expect(registry.setProjectsFolder(fleetRoot)).toEqual({ path: fleetRoot, custom: false });
  });
});

/**
 * A task key chosen when a project is added (FI3-1787, step 4 of the
 * Infinitary rename): Settings' Add project and the setup card pass it, the
 * project's tasks are numbered with it, and a key that cannot be its is
 * refused in words before anything is cloned, created or linked.
 */
describe("RepoRegistry chosen task key", () => {
  let db: ReturnType<typeof openInMemoryDatabase>;
  let fleetRoot: string;
  let registry: RepoRegistry;
  let projects: ProjectStore;

  const keyOf = (repoId: string) => projects.forRepo(repoId)?.key;

  beforeEach(() => {
    vi.stubEnv("HOME", scratchDir("infinitary-git-home-"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    db = openInMemoryDatabase();
    fleetRoot = scratchDir("infinitary-fleet-");
    registry = new RepoRegistry(db, fleetRoot);
    projects = new ProjectStore(db);
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });

  it("numbers a new project's tasks with the key chosen for it, by every way of adding", async () => {
    const origin = scratchDir("infinitary-origin-");
    await git(origin, ["init", "-q", "-b", "main"]);
    await git(origin, [...APP_GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "chore: init"]);
    const folder = scratchDir("infinitary-adopt-");

    // Without a key, the name decides, as it always has.
    const derived = await registry.setup({ kind: "init", name: "infinitary" });
    expect(keyOf(derived.repo.id)).toBe("INFI");
    const created = await registry.setup({ kind: "init", name: "infinitary-app", key: " inf " });
    const cloned = await registry.setup({ kind: "clone", origin, key: "web" });
    const adopted = await registry.setup({ kind: "adopt", path: folder, key: "N0TE" });
    expect([created, cloned, adopted].map(({ repo }) => keyOf(repo.id))).toEqual([
      "INF",
      "WEB",
      "N0TE",
    ]);
    const project = projects.forRepo(created.repo.id);
    if (!project) throw new Error("No project for the new repo");
    expect(projects.allocateSeq(project.id).key).toBe("INF-1");
    expect(projects.allocateSeq(project.id).key).toBe("INF-2");

    // A project already on the list is answered as it is, its key unchanged.
    const again = await registry.setup({ kind: "adopt", path: folder, key: "ZZ" });
    expect(again).toMatchObject({ created: false, repo: { id: adopted.repo.id } });
    expect(keyOf(adopted.repo.id)).toBe("N0TE");
    expect(projects.byKey("ZZ")).toBeUndefined();
  });

  it("refuses a key a project already has, or one that is no key, before anything is made", async () => {
    const first = await registry.setup({ kind: "init", name: "first", key: "INF" });
    const origin = scratchDir("infinitary-origin-");
    await git(origin, ["init", "-q", "-b", "main"]);
    await git(origin, [...APP_GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "chore: init"]);
    const folder = scratchDir("infinitary-adopt-");
    const inUse = "INF is already the task key of first. Choose another.";

    await expect(registry.setup({ kind: "init", name: "second", key: "inf" })).rejects.toThrow(
      inUse,
    );
    await expect(registry.setup({ kind: "clone", origin, key: "INF" })).rejects.toThrow(inUse);
    await expect(registry.setup({ kind: "adopt", path: folder, key: "Inf" })).rejects.toThrow(
      inUse,
    );
    // Nothing was created, cloned, linked or started in git.
    expect(readdirSync(fleetRoot).sort()).toEqual(["first"]);
    expect(existsSync(join(folder, ".git"))).toBe(false);
    expect(registry.list().map((repo) => repo.name)).toEqual(["first"]);

    // The setup card's check reads the same refusal, and a free key normalized.
    await expect(registry.check({ kind: "init", name: "second", key: "INF" })).rejects.toThrow(
      inUse,
    );
    await expect(registry.check({ kind: "clone", origin, key: "dev" })).resolves.toMatchObject({
      key: "DEV",
    });

    // Scratch's key, and a removed project's, still name their tasks.
    await expect(registry.setup({ kind: "init", name: "third", key: "scr" })).rejects.toThrow(
      "SCR is already the task key of Scratch. Choose another.",
    );
    registry.unregister(first.repo.id);
    await expect(registry.setup({ kind: "init", name: "third", key: "INF" })).rejects.toThrow(
      "INF is already the task key of first, a project you removed. Choose another.",
    );
    for (const key of ["I", "INFIN", "IN-F"]) {
      await expect(registry.setup({ kind: "init", name: "third", key })).rejects.toThrow(
        `A task key is 2-4 letters or digits; "${key}" is not one.`,
      );
    }
    expect(existsSync(join(fleetRoot, "third"))).toBe(false);
  });
});
