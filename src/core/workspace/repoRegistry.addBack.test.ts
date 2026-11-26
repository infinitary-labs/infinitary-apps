import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { PERSONAL_WORKSPACE_NAME } from "../paths";
import { openInMemoryDatabase } from "../storage/db";
import { SettingsStore } from "../storage/settingsStore";
import { APP_GIT_IDENTITY, git } from "./git";
import { RepoRegistry } from "./repoRegistry";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * Adding back a removed project (docs/fleet.md, "Adding a removed project
 * back"): removing a project leaves its folder in the projects folder, and
 * adding it again - by its address, or by picking that folder - links the
 * folder where it is, under the name it had, instead of cloning a second
 * copy beside it named with -2.
 */
describe("RepoRegistry adding back a removed project", () => {
  let db: ReturnType<typeof openInMemoryDatabase>;
  let appData: string;
  let fleetRoot: string;

  const registryOn = () =>
    new RepoRegistry(db, fleetRoot, { settings: new SettingsStore(db), appDataDir: appData });

  /** A remote with one commit, whose clone is named `name`. */
  async function remote(name = "field-notes"): Promise<string> {
    const origin = join(scratchDir("infinitary-origin-"), name);
    mkdirSync(origin);
    await git(origin, ["init", "-q", "-b", "main"]);
    await git(origin, [...APP_GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "chore: init"]);
    return origin;
  }

  beforeEach(() => {
    vi.stubEnv("HOME", scratchDir("infinitary-git-home-"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    db = openInMemoryDatabase();
    appData = realpathSync(scratchDir("infinitary-app-data-"));
    fleetRoot = join(appData, "fleet");
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });

  it("links the folder a removed project left in the projects folder when its address is added again", async () => {
    const registry = registryOn();
    const origin = await remote();
    const first = await registry.setup({ kind: "clone", origin });
    const folder = join(fleetRoot, "field-notes");
    expect(first.repo.path).toBe(folder);
    writeFileSync(join(folder, "draft.md"), "work not yet committed\n");
    registry.unregister(first.repo.id);
    expect(lstatSync(folder).isDirectory()).toBe(true);

    expect(await registry.check({ kind: "clone", origin })).toMatchObject({
      name: "field-notes",
      origin,
      leftFolder: folder,
    });
    const again = await registry.setup({ kind: "clone", origin });

    expect(again).toMatchObject({
      created: true,
      leftFolder: folder,
      repo: { name: "field-notes", path: folder, origin, setupKind: "clone" },
    });
    expect(again.repo.id).not.toBe(first.repo.id);
    expect(readFileSync(join(folder, "draft.md"), "utf8")).toBe("work not yet committed\n");
    expect(readdirSync(fleetRoot).sort()).toEqual(["field-notes"]);
    // Asked once more, it is the project it now is.
    expect(await registry.check({ kind: "clone", origin })).toMatchObject({
      existing: { id: again.repo.id },
    });
  });

  it("matches the address however the same project on its host is spelled", async () => {
    const registry = registryOn();
    const folder = join(fleetRoot, "field-notes");
    mkdirSync(folder, { recursive: true });
    await git(folder, ["init", "-q", "-b", "main"]);
    await git(folder, [...APP_GIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "chore: init"]);
    await git(folder, ["remote", "add", "origin", "git@github.com:Octo/field-notes.git"]);

    // Checked only: a clone of the spelling that does not match would reach the network.
    expect(
      await registry.check({ kind: "clone", origin: "https://github.com/octo/field-notes" }),
    ).toMatchObject({
      name: "field-notes",
      origin: "git@github.com:Octo/field-notes.git",
      leftFolder: folder,
    });
    expect(
      await registry.check({ kind: "clone", origin: "https://github.com/octo/other-notes" }),
    ).not.toHaveProperty("leftFolder");
    expect(
      await registry.check({ kind: "clone", origin: "https://gitlab.com/octo/field-notes" }),
    ).toMatchObject({ name: "field-notes-2" });
  });

  it("links the folder in place when the captain picks it in the projects folder", async () => {
    const registry = registryOn();
    const origin = await remote();
    const first = await registry.setup({ kind: "clone", origin });
    registry.unregister(first.repo.id);
    const folder = join(fleetRoot, "field-notes");

    expect(await registry.check({ kind: "adopt", path: folder })).toMatchObject({
      name: "field-notes",
      origin,
      leftFolder: folder,
    });
    const again = await registry.setup({ kind: "adopt", path: folder });

    expect(again).toMatchObject({
      created: true,
      leftFolder: folder,
      repo: { name: "field-notes", path: folder, origin, setupKind: "adopt" },
    });
    expect(lstatSync(folder).isDirectory()).toBe(true);
    expect(readdirSync(fleetRoot).sort()).toEqual(["field-notes"]);
    expect(await registry.setup({ kind: "adopt", path: folder })).toMatchObject({
      created: false,
      repo: { id: again.repo.id },
    });
  });

  it("keeps a picked folder's own name in the fleet root and links the one asked for", async () => {
    const registry = registryOn();
    const origin = await remote();
    const first = await registry.setup({ kind: "clone", origin });
    registry.unregister(first.repo.id);
    const folder = join(fleetRoot, "field-notes");

    const again = await registry.setup({ kind: "adopt", path: folder, name: "notes" });

    expect(again.repo).toMatchObject({ name: "notes", path: folder });
    expect(readlinkSync(join(fleetRoot, "notes"))).toBe(folder);
    registry.unregister(again.repo.id);
    expect(readdirSync(fleetRoot).sort()).toEqual(["field-notes"]);
  });

  it("links the folder left in a chosen projects folder, and links it from the fleet root again", async () => {
    const registry = registryOn();
    const chosen = realpathSync(scratchDir("infinitary-projects-"));
    registry.setProjectsFolder(chosen);
    const origin = await remote();
    const first = await registry.setup({ kind: "clone", origin });
    registry.unregister(first.repo.id);
    expect(existsSync(join(fleetRoot, "field-notes"))).toBe(false);

    const again = await registry.setup({ kind: "clone", origin });

    expect(again.repo).toMatchObject({ name: "field-notes", path: join(chosen, "field-notes") });
    expect(again.leftFolder).toBe(join(chosen, "field-notes"));
    expect(readlinkSync(join(fleetRoot, "field-notes"))).toBe(join(chosen, "field-notes"));
    expect(readdirSync(chosen)).toEqual(["field-notes"]);
  });

  it("finds the folder a project left in the app's own folder after another folder was chosen", async () => {
    const registry = registryOn();
    const origin = await remote();
    const first = await registry.setup({ kind: "clone", origin });
    registry.unregister(first.repo.id);
    const chosen = realpathSync(scratchDir("infinitary-projects-"));
    registry.setProjectsFolder(chosen);

    const again = await registry.setup({ kind: "clone", origin });

    expect(again.repo.path).toBe(join(fleetRoot, "field-notes"));
    expect(readdirSync(chosen)).toEqual([]);
  });

  it("takes the next numbered folder a removed project left, past one of another address", async () => {
    const registry = registryOn();
    const other = await remote();
    const origin = await remote();
    const theirs = await registry.setup({ kind: "clone", origin: other });
    const mine = await registry.setup({ kind: "clone", origin });
    expect(mine.repo.name).toBe("field-notes-2");
    registry.unregister(theirs.repo.id);
    registry.unregister(mine.repo.id);

    const again = await registry.setup({ kind: "clone", origin });

    expect(again.repo).toMatchObject({
      name: "field-notes-2",
      path: join(fleetRoot, "field-notes-2"),
    });
    expect(readdirSync(fleetRoot).sort()).toEqual(["field-notes", "field-notes-2"]);
  });

  it("never takes a folder of another address, a plain folder or a folder a project still has", async () => {
    const registry = registryOn();
    const origin = await remote();
    mkdirSync(join(fleetRoot, "field-notes"), { recursive: true });
    writeFileSync(join(fleetRoot, "field-notes", "mine.txt"), "the person's own\n");

    const cloned = await registry.setup({ kind: "clone", origin });
    expect(cloned.repo.path).toBe(join(fleetRoot, "field-notes-2"));
    expect(cloned).not.toHaveProperty("leftFolder");
    expect(readdirSync(join(fleetRoot, "field-notes"))).toEqual(["mine.txt"]);

    // A project renamed keeps its folder; that folder is still its own.
    registry.configure(cloned.repo.id, { name: "renamed" });
    expect(await registry.check({ kind: "clone", origin })).toMatchObject({
      existing: { id: cloned.repo.id },
    });
    expect(await registry.check({ kind: "adopt", path: cloned.repo.path })).toMatchObject({
      existing: { id: cloned.repo.id },
    });
  });

  it("still refuses a link, a folder inside a project and the personal workspace in the fleet root", async () => {
    const registry = registryOn();
    const elsewhere = scratchDir("infinitary-elsewhere-");
    mkdirSync(fleetRoot, { recursive: true });
    symlinkSync(elsewhere, join(fleetRoot, "pointer"));
    const origin = await remote();
    const { repo } = await registry.setup({ kind: "clone", origin });
    mkdirSync(join(repo.path, "nested"));
    mkdirSync(join(fleetRoot, PERSONAL_WORKSPACE_NAME));

    for (const path of [
      fleetRoot,
      join(fleetRoot, "pointer"),
      join(repo.path, "nested"),
      join(fleetRoot, PERSONAL_WORKSPACE_NAME),
    ]) {
      const refusal = `${path} is already inside the fleet root; it needs no adoption.`;
      await expect(registry.check({ kind: "adopt", path })).rejects.toThrow(refusal);
      await expect(registry.setup({ kind: "adopt", path })).rejects.toThrow(refusal);
    }
    expect(registry.list().map((one) => one.name)).toEqual(["field-notes"]);
  });
});
