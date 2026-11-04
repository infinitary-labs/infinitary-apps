import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PLACED_COPY_CHUNK_BYTES } from "@shared/work";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { bundleRef, takeBundle } from "../workspace/bundles";
import * as gitModule from "../workspace/git";
import { git } from "../workspace/git";
import { packWork } from "../workspace/workMove";
import { keptRefFor, keptRefsFor, WorkspaceService } from "../workspace/workspaceService";
import { WorkingCopies } from "./workingCopies";

/**
 * The working copies a computer that runs work keeps for its home
 * (docs/helper.md, "Its working copies"), against a real project: a bare
 * repository on disk stands where the project lives, and a clone of it
 * stands for the home's own repository. Everything is real git; nothing
 * reaches the network or a sign-in.
 */

// Integration budget (docs/test-cohorts.md): real git, the slowest test
// (unmerged work kept and the copy deleted) 1.24 s at its fastest of five
// runs in a batch of twenty git-heavy files at the project's own worker
// count, on an Apple silicon Mac with git unclamped as below; five times
// that rounds up to 10 s. Alone with ten busy processes beside it, the same
// test took 2.7 to 3.5 s.
vi.setConfig({ testTimeout: 10_000 });

// On a Mac the product runs every git below the UI (`taskpolicy -c
// utility`, utilityQos.ts), where it yields to every busier process. A case
// here runs up to about a hundred gits one after another, so on a Mac
// loaded by other runs it waited on that load rather than its own work and
// ran past its budget. This file is about working copies, not that clamp
// (utilityQos.test.ts holds it), so its git runs as on a Mac without
// taskpolicy, at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** A project where it lives, with one commit on `main`, and the home's clone of it. */
async function project() {
  const root = scratchDir("infinitary-copies-project-");
  const origin = join(root, "origin.git");
  await git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  const seed = join(root, "seed");
  await git(root, ["clone", "--quiet", origin, seed]);
  writeFileSync(join(seed, "README.md"), "# website\n");
  await commitAll(seed, "chore: start the website");
  await git(seed, ["push", "--quiet", "origin", "HEAD:main"]);
  const home = join(root, "home");
  await git(root, ["clone", "--quiet", origin, home]);
  return { origin, seed, home, main: await git(seed, ["rev-parse", "HEAD"]) };
}

async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  await git(dir, [
    "-c",
    "user.name=Crewmate",
    "-c",
    "user.email=crew@localhost",
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** The computer's data folder and its working copies, with no pool unless asked. */
function computer(pool = false) {
  const dataDir = scratchDir("infinitary-copies-computer-");
  return { dataDir, copies: new WorkingCopies(dataDir, pool ? {} : { pool: false }) };
}

/** A bundle read whole through the order the home reads it with. */
function readBundle(copies: WorkingCopies, task: string, ref: "branch" | "kept", into: string) {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const piece = copies.read(task, ref, offset);
    const bytes = Buffer.from(piece.data, "base64");
    parts.push(bytes);
    offset += bytes.length;
    if (offset >= piece.size || bytes.length === 0) break;
  }
  writeFileSync(into, Buffer.concat(parts));
  return into;
}

describe("the working copies a computer that runs work keeps", () => {
  it("clones a project once, and gives each task a working copy on its branch from the origin's default branch", async () => {
    const { origin, main } = await project();
    const { dataDir, copies } = computer();

    const first = await copies.prepare("t-one", { origin });
    expect(first).toMatchObject({
      dir: join(dataDir, "worktrees", "t-one"),
      branch: "fm/task-t-one",
      cloned: true,
      acquired: { source: "new", base: { sha: main, ref: "origin/main", fetch: "fetched" } },
    });
    expect(await git(first.dir, ["rev-parse", "HEAD"])).toBe(main);
    expect(await git(first.dir, ["symbolic-ref", "--short", "HEAD"])).toBe("fm/task-t-one");
    // The crewmate's own git there knows where the project lives.
    expect(await git(first.dir, ["remote", "get-url", "origin"])).toBe(origin);

    const second = await copies.prepare("t-two", { origin });
    expect(second.cloned).toBe(false);
    expect(readdirSync(join(dataDir, "repos"))).toHaveLength(1);
    // Asked again, a working copy already there is answered as it is.
    const again = await copies.prepare("t-one", { origin });
    expect(again).toEqual({ dir: first.dir, branch: "fm/task-t-one", cloned: false });
    expect(copies.list()).toEqual(["t-one", "t-two"]);
  });

  it("returns host-measured lines for the requested remote revision, not its newer branch (INF-1235)", async () => {
    // Captain chose “Fix remote-task line counts”: real git on the work computer owns the numbers.
    const { origin, main } = await project();
    const { copies } = computer();
    const { dir } = await copies.prepare("t-lines", { origin });
    writeFileSync(join(dir, "README.md"), "# website\nA footer for the website.\n");
    const first = await commitAll(dir, "fix: describe the footer");
    writeFileSync(join(dir, "README.md"), "# revised website\n");
    const second = await commitAll(dir, "fix: revise the website");
    expect(await copies.revision("t-lines", first)).toMatchObject({
      headSha: first,
      changeLines: { base: main, added: 1, deleted: 0 },
    });
    expect(await copies.revision("t-lines")).toMatchObject({
      headSha: second,
      changeLines: { base: main, added: 1, deleted: 1 },
    });
    await expect(copies.revision("t-lines", "f".repeat(40))).rejects.toThrow();
  });

  it("starts a later task from the origin's newest commit, fetched first", async () => {
    const { origin, seed } = await project();
    const { copies } = computer();
    await copies.prepare("t-early", { origin });
    writeFileSync(join(seed, "footer.html"), "<footer></footer>\n");
    const newer = await commitAll(seed, "feat: add the footer");
    await git(seed, ["push", "--quiet", "origin", "HEAD:main"]);

    const later = await copies.prepare("t-later", { origin });
    expect(later.acquired?.base).toMatchObject({ sha: newer, fetch: "fetched" });
    expect(await git(later.dir, ["rev-parse", "HEAD"])).toBe(newer);
  });

  it("refuses a project it cannot clone, and leaves nothing half made", async () => {
    const { copies, dataDir } = computer();
    const missing = join(scratchDir("infinitary-copies-missing-"), "nowhere.git");
    await expect(copies.prepare("t-nowhere", { origin: missing })).rejects.toThrow();
    expect(readdirSync(join(dataDir, "repos"))).toEqual([]);
    expect(copies.has("t-nowhere")).toBe(false);
  });

  it("pushes the task's branch to where the project lives from its working copy", async () => {
    const { origin } = await project();
    const { copies } = computer();
    const { dir } = await copies.prepare("t-push", { origin });
    writeFileSync(join(dir, "footer.html"), "<footer>blue</footer>\n");
    const tip = await commitAll(dir, "feat: a blue footer");
    await git(dir, ["push", "--quiet", "origin", "fm/task-t-push"]);
    expect(await git(origin, ["rev-parse", "refs/heads/fm/task-t-push"])).toBe(tip);
  });

  it("bundles the branch for the home with only the commits it lacks", async () => {
    const { origin, home, main } = await project();
    const { dataDir, copies } = computer();
    const { dir } = await copies.prepare("t-branch", { origin });
    writeFileSync(join(dir, "footer.html"), "<footer></footer>\n");
    const tip = await commitAll(dir, "feat: add the footer");

    const made = await copies.bundle("t-branch", "branch", [main]);
    expect(made.sha).toBe(tip);
    if (!made.bundle) throw new Error("expected a bundle");
    const file = readBundle(copies, "t-branch", "branch", join(dataDir, "home.bundle"));
    await takeBundle(
      home,
      file,
      made.bundle,
      "refs/heads/fm/task-t-branch",
      "refs/heads/fm/task-t-branch",
      tip,
    );
    expect(await git(home, ["show", `${tip}:footer.html`])).toBe("<footer></footer>");
    // Only the commit the home lacked crossed.
    expect(await git(home, ["rev-list", "--count", `${main}..${tip}`])).toBe("1");

    // The home has the tip: nothing more crosses.
    expect(await copies.bundle("t-branch", "branch", [tip])).toEqual({ sha: tip });
  });

  it("keeps unmerged work, and deletes the working copy only once the home holds it", async () => {
    const { origin, home, main } = await project();
    const { dataDir, copies } = computer();
    const { dir } = await copies.prepare("t-keep", { origin });
    writeFileSync(join(dir, "footer.html"), "<footer></footer>\n");
    const tip = await commitAll(dir, "feat: add the footer");
    writeFileSync(join(dir, "draft.txt"), "not committed yet\n");
    // It says where the project it was cloned from lives, for a home that
    // no longer records the task to find that project by, and which branch
    // and commit its checkout is on (INF-2546).
    expect(await copies.status("t-keep")).toEqual({
      present: true,
      dirty: true,
      unlandedCommits: 1,
      origin,
      checkedOut: { branch: "fm/task-t-keep", head: tip },
    });

    const { kept } = await copies.keep("t-keep");
    expect(kept).toMatchObject({ ref: keptRefFor("t-keep"), dirty: true, unlandedCommits: 1 });
    if (!kept) throw new Error("expected kept work");
    // Never deleted before the home holds what was kept.
    await expect(copies.retire("t-keep", null)).rejects.toThrow("the home must take it first");
    await expect(copies.retire("t-keep", main)).rejects.toThrow(
      "does not hold this task's kept work",
    );
    expect(copies.has("t-keep")).toBe(true);

    const made = await copies.bundle("t-keep", "kept", [main]);
    if (!made.bundle) throw new Error("expected a bundle");
    const file = readBundle(copies, "t-keep", "kept", join(dataDir, "kept.bundle"));
    await takeBundle(home, file, made.bundle, keptRefFor("t-keep"), keptRefFor("t-keep"), kept.sha);
    // The home holds the commit and the edit that was never committed.
    expect(await git(home, ["show", `${kept.sha}:draft.txt`])).toBe("not committed yet");

    await copies.retire("t-keep", kept.sha);
    expect(copies.has("t-keep")).toBe(false);
    expect(await copies.status("t-keep")).toEqual({
      present: false,
      dirty: false,
      unlandedCommits: 0,
    });
    const clone = join(dataDir, "repos", readdirSync(join(dataDir, "repos"))[0] ?? "");
    await expect(
      git(clone, ["rev-parse", "--verify", "--quiet", keptRefFor("t-keep")]),
    ).rejects.toThrow();
    await expect(
      git(clone, ["rev-parse", "--verify", "--quiet", "refs/heads/fm/task-t-keep"]),
    ).rejects.toThrow();
    expect(readdirSync(join(dataDir, "bundles"))).toEqual([]);
  });

  // DOP-121: a reviewer checks out the version it reads, so its checkout
  // leaves its task's branch. On Kun's Mac mini 34 closed tasks' working
  // copies stayed for good, every one with its checkout off its branch.
  it("keeps both a checkout that left its task's branch and that branch, and retires the copy once the home holds them", async () => {
    const { origin, home, main } = await project();
    const { dataDir, copies } = computer();
    const task = "t-review";
    const { dir } = await copies.prepare(task, { origin });
    writeFileSync(join(dir, "footer.html"), "<footer></footer>\n");
    const onBranch = await commitAll(dir, "feat: add the footer");
    await git(dir, ["checkout", "--quiet", "--detach", main]);
    writeFileSync(join(dir, "notes.txt"), "what the review found\n");
    const checkedOut = await commitAll(dir, "docs: note what the review found");
    expect(await copies.status(task)).toEqual({
      present: true,
      dirty: false,
      unlandedCommits: 1,
      origin,
      checkedOut: { branch: null, head: checkedOut },
    });

    const { kept } = await copies.keep(task);
    if (!kept) throw new Error("expected kept work");
    // Asked again, the copy holds nothing more, so the same commit answers.
    expect((await copies.keep(task)).kept?.sha).toBe(kept.sha);
    const made = await copies.bundle(task, "kept", [main]);
    if (!made.bundle) throw new Error("expected a bundle");
    const file = readBundle(copies, task, "kept", join(dataDir, "kept.bundle"));
    await takeBundle(home, file, made.bundle, keptRefFor(task), keptRefFor(task), kept.sha);
    for (const commit of [onBranch, checkedOut])
      await git(home, ["merge-base", "--is-ancestor", commit, kept.sha]);

    await copies.retire(task, kept.sha);
    expect(copies.has(task)).toBe(false);
    const clone = join(dataDir, "repos", readdirSync(join(dataDir, "repos"))[0] ?? "");
    await expect(
      git(clone, ["rev-parse", "--verify", "--quiet", `refs/heads/fm/task-${task}`]),
    ).rejects.toThrow();
  });

  // DOP-121: the copies stuck on Kun's Mac mini were kept by a version that
  // read no branch for a checkout off it, and two of those kept commits miss
  // 18 and 48 of their branch's commits.
  it("never deletes a copy whose kept commit misses its branch's commits, and keeps them when asked again", async () => {
    const { origin, home, main } = await project();
    const { dataDir, copies } = computer();
    const task = "t-older-keep";
    const { dir } = await copies.prepare(task, { origin });
    writeFileSync(join(dir, "footer.html"), "<footer></footer>\n");
    const onBranch = await commitAll(dir, "feat: add the footer");
    await git(dir, ["checkout", "--quiet", "--detach", main]);
    writeFileSync(join(dir, "notes.txt"), "what the review found\n");
    await commitAll(dir, "docs: note what the review found");
    const clone = join(dataDir, "repos", readdirSync(join(dataDir, "repos"))[0] ?? "");
    // What that version kept: the checkout alone.
    const older = await new WorkspaceService(
      {
        worktreesDir: join(dataDir, "worktrees"),
        worktreeTrashDir: join(dataDir, "worktree-trash"),
        worktreePoolDir: join(dataDir, "worktree-pool"),
        defaultWorkspaceDir: join(dataDir, "default-workspace"),
      },
      { pool: false },
    ).keepUnlandedWork({ taskId: task, cwd: dir, branch: "", repoDir: clone });
    if (!older) throw new Error("expected the older kept work");
    const take = async (sha: string) => {
      const made = await copies.bundle(task, "kept", [main]);
      if (!made.bundle) throw new Error("expected a bundle");
      const file = readBundle(copies, task, "kept", join(dataDir, `${sha}.bundle`));
      await takeBundle(home, file, made.bundle, keptRefFor(task), keptRefFor(task), sha);
    };
    await take(older.sha);
    await expect(copies.retire(task, older.sha)).rejects.toThrow(
      "holds unmerged work the home has not kept",
    );
    expect(copies.has(task)).toBe(true);

    const { kept } = await copies.keep(task);
    if (!kept) throw new Error("expected kept work");
    await take(kept.sha);
    for (const commit of [onBranch, older.sha])
      await git(home, ["merge-base", "--is-ancestor", commit, kept.sha]);
    await copies.retire(task, kept.sha);
    expect(copies.has(task)).toBe(false);
  });

  // The Infinitary rename (step 8 of FI3-1780's plan): work this computer
  // kept as Firstmate 3000, before it was updated, is still found.
  it("bundles work kept under Firstmate 3000's name before an update, and retires once the home holds it", async () => {
    const { origin, home, main } = await project();
    const { dataDir, copies } = computer();
    const { dir } = await copies.prepare("t-older", { origin });
    writeFileSync(join(dir, "older.txt"), "kept before the update\n");
    await commitAll(dir, "feat: kept before the update");
    const { kept } = await copies.keep("t-older");
    if (!kept) throw new Error("expected kept work");
    const [newer, older] = keptRefsFor("t-older") as [string, string];
    const clone = join(dataDir, "repos", readdirSync(join(dataDir, "repos"))[0] ?? "");
    await git(clone, ["update-ref", older, kept.sha]);
    await git(clone, ["update-ref", "-d", newer]);

    const made = await copies.bundle("t-older", "kept", [main]);
    expect(made.sha).toBe(kept.sha);
    if (!made.bundle) throw new Error("expected a bundle");
    const file = readBundle(copies, "t-older", "kept", join(dataDir, "older.bundle"));
    expect(await git(home, ["bundle", "list-heads", file])).toContain(older);
    await takeBundle(home, file, made.bundle, older, keptRefFor("t-older"), kept.sha);
    expect(await git(home, ["show", `${keptRefFor("t-older")}:older.txt`])).toBe(
      "kept before the update",
    );
    await expect(copies.retire("t-older", main)).rejects.toThrow(
      "does not hold this task's kept work",
    );
    await copies.retire("t-older", kept.sha);
    expect(copies.has("t-older")).toBe(false);
    await expect(git(clone, ["rev-parse", "--verify", "--quiet", older])).rejects.toThrow();
  });

  it("refuses to call unreadable existing work absent, keep nothing, bundle nothing or retire it, and recovers after repair", async () => {
    const { origin, home, main } = await project();
    const { dataDir, copies } = computer();
    const task = "t-unreadable";
    const { dir } = await copies.prepare(task, { origin });
    writeFileSync(join(dir, "only-copy.txt"), "unique uncommitted work\n");
    const metadata = readFileSync(join(dir, ".git"), "utf8");
    writeFileSync(join(dir, ".git"), `gitdir: ${join(dataDir, "missing")}\n`);
    for (const read of [
      () => copies.status(task),
      () => copies.keep(task),
      () => copies.bundle(task, "branch", [main]),
      () => copies.retire(task, null),
      () => copies.retire(task, main),
    ])
      await expect(read()).rejects.toThrow("cannot read the work history");
    expect(readFileSync(join(dir, "only-copy.txt"), "utf8")).toBe("unique uncommitted work\n");
    expect(copies.has(task)).toBe(true);
    writeFileSync(join(dir, ".git"), metadata);
    expect(await copies.status(task)).toEqual({
      present: true,
      dirty: true,
      unlandedCommits: 0,
      origin,
      checkedOut: { branch: `fm/task-${task}`, head: main },
    });
    const { kept } = await copies.keep(task);
    if (!kept) throw new Error("expected kept work");
    const made = await copies.bundle(task, "kept", [main]);
    if (!made.bundle) throw new Error("expected bundle");
    await takeBundle(
      home,
      readBundle(copies, task, "kept", join(dataDir, "repaired.bundle")),
      made.bundle,
      keptRefFor(task),
      keptRefFor(task),
      kept.sha,
    );
    expect(await git(home, ["show", `${kept.sha}:only-copy.txt`])).toBe("unique uncommitted work");
    await copies.retire(task, kept.sha);
    expect(copies.has(task)).toBe(false);
  });

  it("keeps a copy with an unreadable index even when the home already holds its kept commit", async () => {
    const { origin } = await project();
    const { copies } = computer();
    const { dir } = await copies.prepare("t-index", { origin });
    writeFileSync(join(dir, "only-copy.txt"), "unique work\n");
    const { kept } = await copies.keep("t-index");
    if (!kept) throw new Error("expected kept work");
    const index = await git(dir, ["rev-parse", "--git-path", "index"]);
    const metadata = readFileSync(index);
    writeFileSync(index, "unreadable index");
    await expect(copies.status("t-index")).rejects.toThrow();
    await expect(copies.keep("t-index")).rejects.toThrow();
    await expect(copies.retire("t-index", kept.sha)).rejects.toThrow();
    expect(readFileSync(join(dir, "only-copy.txt"), "utf8")).toBe("unique work\n");
    writeFileSync(index, metadata);
    await copies.retire("t-index", kept.sha);
    expect(copies.has("t-index")).toBe(false);
  });

  it("refuses to treat an existing plain folder as an absent working copy", async () => {
    const { copies } = computer();
    mkdirSync(copies.dir("t-plain"), { recursive: true });
    writeFileSync(join(copies.dir("t-plain"), "only-copy.txt"), "work");
    await expect(copies.status("t-plain")).rejects.toThrow("cannot read the work history");
    await expect(copies.retire("t-plain", null)).rejects.toThrow("cannot read the work history");
    expect(readFileSync(join(copies.dir("t-plain"), "only-copy.txt"), "utf8")).toBe("work");
    expect(await copies.keep("t-absent")).toEqual({ kept: null });
    await copies.retire("t-absent", null);
  });

  it("retires a working copy that holds nothing unmerged with nothing kept, and parks it warm for the next task", async () => {
    const { origin } = await project();
    const { dataDir, copies } = computer(true);
    await copies.prepare("t-clean", { origin });
    expect(await copies.keep("t-clean")).toEqual({ kept: null });
    await copies.retire("t-clean", null);
    expect(copies.has("t-clean")).toBe(false);
    await copies.poolSettled();
    expect(readdirSync(join(dataDir, "worktree-pool"))).toHaveLength(1);
    const next = await copies.prepare("t-next", { origin });
    expect(next.acquired?.source).toBe("pool");
  });

  it("does not mistake a returning pool directory for a warm copy while reset is paused", async () => {
    const { origin } = await project();
    const { dataDir, copies } = computer(true);
    await copies.prepare("t-delayed", { origin });
    let markResetting!: () => void;
    const resetting = new Promise<void>((resolve) => {
      markResetting = resolve;
    });
    let releaseReset!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const realGit = gitModule.git;
    const spy = vi.spyOn(gitModule, "git").mockImplementation(async (dir, args, options) => {
      if (args[0] === "reset" && dir.includes("returning-")) {
        markResetting();
        await release;
      }
      return realGit(dir, args, options);
    });
    try {
      await copies.retire("t-delayed", null);
      await resetting;
      expect(copies.has("t-delayed")).toBe(false);
      // The old poll is already satisfied, though reset has not even run.
      const pool = join(dataDir, "worktree-pool");
      expect(readdirSync(pool)).toHaveLength(1);
      const [key] = readdirSync(pool) as [string];
      expect(readdirSync(join(pool, key))[0]).toMatch(/^returning-/);
      const early = await copies.prepare("t-early", { origin });
      expect(early.acquired?.source).toBe("new");
      releaseReset();
      await copies.poolSettled();
      const next = await copies.prepare("t-after-reset", { origin });
      expect(next.acquired?.source).toBe("pool");
    } finally {
      releaseReset();
      await copies.poolSettled();
      spy.mockRestore();
    }
  });

  it("takes a moved task whose project is kept on the home only, from a bundle of its whole branch, and lets it go after", async () => {
    // Review INF-1772 R8, the captain: "we should try to support all projects, except for when
    // the project is on a forge that isn't signed in on the destination machine".
    const root = scratchDir("infinitary-copies-local-");
    const home = join(root, "meter");
    mkdirSync(home);
    await git(home, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(home, "meter.ts"), "export const unit = 'kWh';\n");
    const start = await commitAll(home, "chore: start the meter");
    const cwd = join(root, "task");
    await git(home, ["worktree", "add", "--quiet", "-b", "fm/task-t-meter", cwd]);
    writeFileSync(join(cwd, "meter.ts"), "export const unit = 'Wh';\n");
    const head = await commitAll(cwd, "fix: meter unit");
    writeFileSync(join(cwd, "meter.ts"), "export const unit = 'mWh';\n");
    writeFileSync(join(cwd, "notes.md"), "untracked notes\n");
    const packFile = join(root, "move.pack");
    const { pack } = await packWork(cwd, "fm/task-t-meter", {}, packFile);
    const { copies } = computer();

    // This computer holds none of its commits, so it asks for all of them.
    const project = { local: "repo-meter", base: { branch: "main", sha: start } };
    expect(
      await copies.moveIn({ orderId: "move-in:t-meter:1", task: "t-meter", project, head }, {}, {}),
    ).toEqual({
      outcome: "need",
      have: [],
    });
    const bundleFile = join(root, "move.bundle");
    const made = await bundleRef(home, "refs/heads/fm/task-t-meter", [], bundleFile);
    if (!made.bundle) throw new Error("The home made no bundle.");
    const ready = await copies.moveIn(
      {
        orderId: "move-in:t-meter:2",
        task: "t-meter",
        project,
        head,
        bundle: { name: "move.bundle", ...made.bundle },
        pack: { name: "move.pack", ...pack },
      },
      { bundle: bundleFile, pack: packFile },
      {},
    );
    expect(ready).toMatchObject({ outcome: "ready", branch: "fm/task-t-meter" });
    const dir = ready.outcome === "ready" ? ready.dir : "";
    expect(await git(dir, ["log", "--format=%s"])).toBe("fix: meter unit\nchore: start the meter");
    expect(readFileSync(join(dir, "meter.ts"), "utf8")).toBe("export const unit = 'mWh';\n");
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("untracked notes\n");

    // Review INF-1772 round 2 R8: once the task moves on again, its copy here
    // is read against the home's branch and goes, as a clone's copy does.
    expect(await copies.status("t-meter")).toEqual({
      present: true,
      dirty: true,
      unlandedCommits: 1,
      origin: null,
      checkedOut: { branch: "fm/task-t-meter", head },
    });
    const { kept } = await copies.keep("t-meter");
    expect(kept).toMatchObject({ dirty: true, unlandedCommits: 1 });
    await copies.retire("t-meter", kept?.sha ?? null);
    expect(copies.has("t-meter")).toBe(false);
    expect(existsSync(dir)).toBe(false);
    await expect(
      copies.moveIn(
        {
          orderId: "move-in:t-other:1",
          task: "t-other",
          project: { local: "../meter", base: { branch: "main", sha: start } },
          head,
        },
        {},
        {},
      ),
    ).rejects.toThrow("No project is named ../meter.");
  });

  it("gives a task with no project a working copy of the computer's own local workspace", async () => {
    const { dataDir, copies } = computer();
    const made = await copies.prepare("t-local", undefined);
    expect(made).toMatchObject({ branch: "fm/task-t-local", cloned: false });
    expect(
      realpathSync(
        await git(made.dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      ),
    ).toBe(realpathSync(join(dataDir, "default-workspace", ".git")));
    // The computer's own local workspace lives nowhere else.
    expect(await copies.status("t-local")).toMatchObject({ present: true, origin: null });
  });

  it("writes an artifact into the working copy once every piece is there, and never over one already there", async () => {
    const { origin } = await project();
    const { copies } = computer();
    const { dir } = await copies.prepare("t-artifact", { origin });
    const bytes = Buffer.alloc(PLACED_COPY_CHUNK_BYTES + 10, 7);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const piece = (offset: number, end: number) => ({
      task: "t-artifact",
      runId: 41,
      artifactId: 9,
      size: bytes.length,
      sha256,
      offset,
      data: bytes.subarray(offset, end).toString("base64"),
    });
    const path = join(dir, ".infinitary-artifacts", "run-41", "artifact-9.zip");
    expect(await copies.artifact(piece(0, PLACED_COPY_CHUNK_BYTES))).toEqual({
      outcome: "partial",
    });
    expect(existsSync(path)).toBe(false);
    expect(await copies.artifact(piece(PLACED_COPY_CHUNK_BYTES, bytes.length))).toEqual({
      outcome: "written",
    });
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(await copies.artifact(piece(0, bytes.length))).toEqual({ outcome: "exists" });
    // A digest that does not match is refused, and nothing is written.
    await expect(
      copies.artifact({ ...piece(0, bytes.length), artifactId: 10, sha256: "0".repeat(64) }),
    ).rejects.toThrow("not the one the home downloaded");
    expect(existsSync(join(dir, ".infinitary-artifacts", "run-41", "artifact-10.zip"))).toBe(false);
  });
});
