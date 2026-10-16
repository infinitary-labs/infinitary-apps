import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { configureBundledGit, hostEnv } from "../hostEnv";
import { type BundledGitApp, bundledGitLocation, resolveBundledGit } from "./bundledGit";
import { git } from "./git";

/**
 * The app's own git (git integration phase 2, `docs/forge.md` "The app's
 * own git"): every host git runs it when the build carries it, a
 * crewmate's shell finds it first on its search path through
 * `resources/git-bin/git`, and a checkout without it runs the system git.
 */

const REPO_ROOT = join(__dirname, "../../..");
const SHIM = join(REPO_ROOT, "resources", "git-bin", "git");
/** The three variables the app's git is told where its parts are with. */
const PARTS = ["GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG_SYSTEM"] as const;

/**
 * A checkout-shaped app whose git tree is a stand-in: `bin/git` prints the
 * arguments it was given and the three variables, so a test can see which
 * git ran and what it was told.
 */
function standInApp(): BundledGitApp & { dir: string } {
  const appDir = scratchDir("infinitary-app-git-");
  const { dir, shimDir } = bundledGitLocation({ packaged: false, appDir, resourcesDir: "" });
  mkdirSync(join(dir, "bin"), { recursive: true });
  const binary = join(dir, "bin", "git");
  writeFileSync(
    binary,
    `#!/bin/sh\necho "app-git $*"\necho "parts $GIT_EXEC_PATH|$GIT_TEMPLATE_DIR|$GIT_CONFIG_SYSTEM"\n`,
  );
  chmodSync(binary, 0o755);
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "git"), readFileSync(SHIM));
  chmodSync(join(shimDir, "git"), 0o755);
  return { packaged: false, appDir, resourcesDir: "", dir };
}

afterEach(() => configureBundledGit(undefined));

describe("resolving the app's git", () => {
  it("finds the tree for this architecture and the environment dugite gives it", () => {
    const app = standInApp();
    const resolved = resolveBundledGit(app, {});
    expect(resolved).toBeDefined();
    expect(resolved?.dir).toBe(app.dir);
    expect(resolved?.binary).toBe(join(app.dir, "bin", "git"));
    expect(resolved?.env.GIT_EXEC_PATH).toBe(join(app.dir, "libexec", "git-core"));
    expect(resolved?.env.GIT_TEMPLATE_DIR).toBe(`${app.dir}/share/git-core/templates`);
    expect(resolved?.env.GIT_CONFIG_SYSTEM).toBe(join(app.dir, "etc", "gitconfig"));
    expect(resolved?.env).not.toHaveProperty("LOCAL_GIT_DIRECTORY");
  });

  it("is packaged next to the archive, never inside it", () => {
    const location = bundledGitLocation(
      { packaged: true, appDir: "/Apps/F.app/Contents/Resources/app.asar", resourcesDir: "/R" },
      "arm64",
    );
    expect(location).toEqual({ dir: "/R/git/darwin-arm64", shimDir: "/R/git-bin" });
  });

  it("is nothing for a checkout that has not vendored it, or when a test asks for the system git", () => {
    const bare = scratchDir("infinitary-app-nogit-");
    expect(resolveBundledGit({ packaged: false, appDir: bare, resourcesDir: "" }, {})).toBe(
      undefined,
    );
    const app = standInApp();
    expect(resolveBundledGit(app, { INFINITARY_SYSTEM_GIT: "1" })).toBeUndefined();
  });

  it("ignores the system-git switch in a packaged app", () => {
    const app = standInApp();
    const resourcesDir = join(app.appDir, "packaged");
    const { dir, shimDir } = bundledGitLocation({ ...app, packaged: true, resourcesDir });
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "git"), readFileSync(join(app.dir, "bin", "git")));
    chmodSync(join(dir, "bin", "git"), 0o755);
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "git"), readFileSync(SHIM));
    chmodSync(join(shimDir, "git"), 0o755);
    const packaged = { ...app, packaged: true, resourcesDir };
    expect(resolveBundledGit(packaged, { INFINITARY_SYSTEM_GIT: "1" })?.dir).toBe(dir);
  });
});

describe("the host's git calls", () => {
  it("run the app's git, told where its parts are", async () => {
    const app = standInApp();
    const resolved = resolveBundledGit(app, {});
    configureBundledGit(resolved);
    const out = await git(scratchDir("infinitary-repo-"), ["status", "--short"], {
      env: { GIT_EXEC_PATH: "/somewhere/else" },
    });
    const [ran, parts] = out.split("\n");
    expect(ran).toMatch(/^app-git -C .* status --short$/);
    expect(parts).toBe(`parts ${PARTS.map((key) => resolved?.env[key]).join("|")}`);
  });

  it("run the git on the search path when the build carries none", async () => {
    configureBundledGit(undefined);
    const repo = scratchDir("infinitary-repo-");
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    expect(await git(repo, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
  });
});

describe("a crewmate's shell", () => {
  it("finds the app's git first, with every other program still behind it", () => {
    const app = standInApp();
    const resolved = resolveBundledGit(app, {});
    configureBundledGit(resolved);
    const env = hostEnv();
    const entries = (env.PATH ?? "").split(delimiter);
    expect(entries[0]).toBe(resolved?.shimDir);
    expect(entries.filter((entry) => entry === resolved?.shimDir)).toHaveLength(1);
    for (const entry of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      expect(entries).toContain(entry);
    }
    const run = spawnSync("/bin/sh", ["-c", "git log --oneline"], { env, encoding: "utf8" });
    expect(run.stdout.split("\n")[0]).toBe("app-git log --oneline");
  });

  it("tells the app's git the same parts the host's calls do", () => {
    const app = standInApp();
    const resolved = resolveBundledGit(app, {});
    const run = spawnSync(SHIM, ["--version"], {
      env: { INFINITARY_GIT_DIR: app.dir, PATH: "/nowhere" },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout.split("\n")[1]).toBe(
      `parts ${PARTS.map((key) => resolved?.env[key]).join("|")}`,
    );
    if (process.platform === "darwin") {
      // On macOS those three are everything dugite sets.
      expect(Object.keys(resolved?.env ?? {}).sort()).toEqual([...PARTS].sort());
    }
  });

  it("steps aside for the next git on the search path when no app git is named", () => {
    const app = standInApp();
    const { shimDir } = bundledGitLocation(app);
    const other = scratchDir("infinitary-other-git-");
    writeFileSync(join(other, "git"), '#!/bin/sh\necho "other-git $*"\n');
    chmodSync(join(other, "git"), 0o755);
    const run = spawnSync(join(shimDir, "git"), ["status"], {
      env: { PATH: [shimDir, other].join(delimiter) },
      encoding: "utf8",
    });
    expect(run.stdout.trim()).toBe("other-git status");
  });

  it("says git is missing, once, when nothing else on the search path is git", () => {
    const app = standInApp();
    const { shimDir } = bundledGitLocation(app);
    const run = spawnSync(join(shimDir, "git"), ["status"], {
      env: { PATH: shimDir },
      encoding: "utf8",
    });
    expect(run.status).toBe(127);
  });
});

/**
 * The real tree `pnpm install` vendors on a Mac (scripts/ensure-bundled-git.ts),
 * run the two ways the app runs it, with nothing else on the search path.
 */
const vendored = bundledGitLocation({ packaged: false, appDir: REPO_ROOT, resourcesDir: "" });
describe.skipIf(!existsSync(join(vendored.dir, "bin", "git")))("the vendored git", () => {
  it("runs from the host, templates and all", async () => {
    const resolved = resolveBundledGit(
      { packaged: false, appDir: REPO_ROOT, resourcesDir: "" },
      {},
    );
    configureBundledGit(resolved);
    expect(await git(REPO_ROOT, ["--version"])).toMatch(/^git version \d+\.\d+\.\d+/);
    const repo = scratchDir("infinitary-vendored-");
    await git(repo, ["init", "--quiet", "--initial-branch=main"]);
    // The template tree the app's git was pointed at is what `init` laid down.
    expect(existsSync(join(repo, ".git", "info", "exclude"))).toBe(true);
    writeFileSync(join(repo, "a.txt"), "a\n");
    await git(repo, ["add", "a.txt"]);
    await git(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "--quiet",
      "-m",
      "first",
    ]);
    expect(await git(repo, ["log", "--format=%s"])).toBe("first");
  });

  it("runs in a crewmate's shell whose search path holds no other git", () => {
    const resolved = resolveBundledGit(
      { packaged: false, appDir: REPO_ROOT, resourcesDir: "" },
      {},
    );
    configureBundledGit(resolved);
    const repo = scratchDir("infinitary-vendored-shell-");
    const env = { ...hostEnv(), PATH: `${resolved?.shimDir}${delimiter}/bin` };
    const run = spawnSync(
      "/bin/sh",
      ["-c", "git init --quiet --initial-branch=main && git status --short --branch"],
      { cwd: repo, env, encoding: "utf8" },
    );
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe("## No commits yet on main");
  });
});
