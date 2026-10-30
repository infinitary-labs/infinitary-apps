import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { git } from "./git";
import { packWork, readManifest, UnsupportedWork, unpackWork } from "./workMove";

// Integration budget (docs/test-cohorts.md): real git, the slowest test
// (ignored files kept) 1.920 s on the Mac mini.
vi.setConfig({ testTimeout: 10_000 });

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * A started task's work, packed on one computer and unpacked on another
 * (INF-1713: a moved task "keeps its key, branch, files and record"). The
 * pack carries what a branch's commits do not: what is staged and what is
 * not, the files git does not track, and the task's own folders.
 */

const author = ["-c", "user.name=T", "-c", "user.email=t@l"];
const BRANCH = "fm/task-meter";

/** A project with one commit, and a task's working copy on its branch with work of every kind. */
async function startedWork() {
  const root = scratchDir("infinitary-work-move-");
  const project = join(root, "project");
  mkdirSync(project);
  await git(project, ["init", "--quiet", "--initial-branch=main"]);
  writeFileSync(join(project, "meter.ts"), "export const unit = 'kWh';\n");
  writeFileSync(join(project, "header.ts"), "export const header = 'Meter';\n");
  writeFileSync(join(project, ".gitignore"), "dist/\n");
  await git(project, ["add", "."]);
  await git(project, [...author, "commit", "--quiet", "-m", "chore: start"]);
  const cwd = join(root, "here");
  await git(project, ["worktree", "add", "--quiet", "-b", BRANCH, cwd]);
  // A commit on the branch, then what is staged and what is not on top of it.
  writeFileSync(join(cwd, "meter.ts"), "export const unit = 'Wh';\n");
  await git(cwd, [...author, "commit", "--quiet", "-am", "fix: meter unit"]);
  writeFileSync(join(cwd, "staged.ts"), "export const staged = true;\n");
  writeFileSync(join(cwd, "header.ts"), "export const header = 'Power';\n");
  await git(cwd, ["add", "staged.ts", "header.ts"]);
  // The same file staged and then edited again: both layers must arrive.
  writeFileSync(join(cwd, "header.ts"), "export const header = 'Power meter';\n");
  writeFileSync(join(cwd, "meter.ts"), "export const unit = 'mWh';\n");
  // Untracked: a note, a script that runs, a picture's bytes and a link; an ignored build.
  mkdirSync(join(cwd, "notes"));
  writeFileSync(join(cwd, "notes", "plan.md"), "untracked notes\n");
  writeFileSync(join(cwd, "run.sh"), "#!/bin/sh\necho run\n");
  chmodSync(join(cwd, "run.sh"), 0o755);
  writeFileSync(join(cwd, "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
  symlinkSync("notes/plan.md", join(cwd, "plan-link"));
  mkdirSync(join(cwd, "dist"));
  writeFileSync(join(cwd, "dist", "bundle.js"), "built\n");
  // The task's own folders.
  const evidence = join(root, "evidence-here");
  mkdirSync(join(evidence, "shots"), { recursive: true });
  writeFileSync(join(evidence, "shots", "before.png"), Buffer.from([1, 2, 3]));
  const sessions = join(root, "sessions-here");
  mkdirSync(sessions);
  writeFileSync(join(sessions, "s1.jsonl"), '{"type":"message"}\n');
  return { root, project, cwd, folders: { evidence, sessions } };
}

/** The other computer's side: a clean checkout of the project at the moved commit, on the branch. */
async function checkoutThere(
  project: string,
  root: string,
  head: string,
  name = "there",
): Promise<string> {
  const there = join(root, name);
  await git(root, ["clone", "--quiet", project, there]);
  await git(there, ["checkout", "--quiet", "-B", BRANCH, head]);
  return there;
}

describe("moving a started task's work to another computer (INF-1713)", () => {
  it("carries the commits' checkout, staged and unstaged edits, untracked files and task folders", async () => {
    const w = await startedWork();
    const pack = join(w.root, "move.pack");
    const { manifest, pack: digest } = await packWork(w.cwd, BRANCH, w.folders, pack);
    expect(manifest.head).toBe(await git(w.cwd, ["rev-parse", "HEAD"]));
    expect(manifest.branch).toBe(BRANCH);
    // Packing leaves the working copy it read as it was.
    expect(await git(w.cwd, ["diff", "--cached", "--name-only"])).toBe("header.ts\nstaged.ts");

    const there = await checkoutThere(w.project, w.root, manifest.head);
    const folders = {
      evidence: join(w.root, "evidence-there"),
      sessions: join(w.root, "sessions-there"),
    };
    await unpackWork(there, pack, folders, digest);

    expect(await git(there, ["log", "-1", "--format=%s"])).toBe("fix: meter unit");
    expect(await git(there, ["diff", "--cached", "--name-only"])).toBe("header.ts\nstaged.ts");
    expect(await git(there, ["show", ":header.ts"])).toBe("export const header = 'Power';");
    expect(readFileSync(join(there, "header.ts"), "utf8")).toBe(
      "export const header = 'Power meter';\n",
    );
    expect(readFileSync(join(there, "meter.ts"), "utf8")).toBe("export const unit = 'mWh';\n");
    expect(readFileSync(join(there, "notes", "plan.md"), "utf8")).toBe("untracked notes\n");
    expect(statSync(join(there, "run.sh")).mode & 0o777).toBe(0o755);
    expect([...readFileSync(join(there, "chart.png"))]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255,
    ]);
    expect(readlinkSync(join(there, "plan-link"))).toBe("notes/plan.md");
    // What git ignores is the build's, and stays behind.
    expect(manifest.entries.map((entry) => entry.path)).not.toContain("dist/bundle.js");
    expect([...readFileSync(join(folders.evidence, "shots", "before.png"))]).toEqual([1, 2, 3]);
    expect(readFileSync(join(folders.sessions, "s1.jsonl"), "utf8")).toBe('{"type":"message"}\n');
    // Both sides read the same status.
    expect(await git(there, ["status", "--porcelain", "--untracked-files=all"])).toBe(
      await git(w.cwd, ["status", "--porcelain", "--untracked-files=all"]),
    );
  });

  it("unpacks only the task folders again when the work already arrived", async () => {
    const w = await startedWork();
    const pack = join(w.root, "move.pack");
    const { manifest } = await packWork(w.cwd, BRANCH, w.folders, pack);
    const there = await checkoutThere(w.project, w.root, manifest.head);
    const evidence = join(w.root, "evidence-there");
    await unpackWork(there, pack, { evidence });
    writeFileSync(join(evidence, "shots", "before.png"), "half-written");
    // A second unpack, as after an answer that was lost, refuses nothing and restores the folder file.
    await unpackWork(there, pack, { evidence });
    expect([...readFileSync(join(evidence, "shots", "before.png"))]).toEqual([1, 2, 3]);
    expect(readFileSync(join(there, "meter.ts"), "utf8")).toBe("export const unit = 'mWh';\n");
  });

  it("refuses a working copy off its own branch or in the middle of a rebase", async () => {
    const w = await startedWork();
    const pack = join(w.root, "move.pack");
    await expect(packWork(w.cwd, "fm/task-other", w.folders, pack)).rejects.toThrow(
      new UnsupportedWork(`its working copy is on ${BRANCH}, not its own branch fm/task-other`),
    );
    const rebasing = await git(w.cwd, ["rev-parse", "--git-path", "rebase-merge"]);
    mkdirSync(rebasing.startsWith("/") ? rebasing : join(w.cwd, rebasing), { recursive: true });
    await expect(packWork(w.cwd, BRANCH, w.folders, pack)).rejects.toThrow(
      "its working copy is in the middle of a merge, rebase or similar",
    );
  });

  it("refuses a pack that changed on the way, and a checkout that is not clean or not at its commit", async () => {
    const w = await startedWork();
    const pack = join(w.root, "move.pack");
    const { manifest, pack: digest } = await packWork(w.cwd, BRANCH, w.folders, pack);
    const there = await checkoutThere(w.project, w.root, manifest.head);

    const bytes = readFileSync(pack);
    bytes.writeUInt8((bytes.at(-1) ?? 0) ^ 0xff, bytes.length - 1);
    const damaged = join(w.root, "damaged.pack");
    writeFileSync(damaged, bytes);
    await expect(unpackWork(there, damaged, {}, digest)).rejects.toThrow(
      "The moved work that arrived is not what was sent.",
    );
    // Without the sent digest, the damaged part's own digest still catches it.
    const elsewhere = await checkoutThere(w.project, w.root, manifest.head, "elsewhere");
    await expect(
      unpackWork(elsewhere, damaged, { sessions: join(w.root, "sessions-elsewhere") }),
    ).rejects.toThrow("A part of the moved work does not match what left the other computer.");

    writeFileSync(join(there, "stray.txt"), "someone else's edit\n");
    await expect(unpackWork(there, pack, {})).rejects.toThrow(
      "The new working copy already holds other edits; nothing was unpacked.",
    );

    await git(there, ["checkout", "--quiet", "HEAD~1"]);
    await expect(unpackWork(there, pack, {})).rejects.toThrow(
      "The new working copy is not at the moved work's commit.",
    );
    expect(readManifest(pack).manifest).toEqual(manifest);
  });

  it("carries the ignored files the move names to keep, and leaves every other ignored file", async () => {
    // Review INF-1772 R7, the captain's answer: "Build the planned way to name ignored files that must move".
    const w = await startedWork();
    mkdirSync(join(w.cwd, "dist", "fonts"));
    writeFileSync(
      join(w.cwd, "dist", "fonts", "meter.woff2"),
      Buffer.from([0x77, 0x4f, 0x46, 0x32]),
    );
    writeFileSync(join(w.cwd, ".gitignore"), "dist/\n.env.local\n");
    writeFileSync(join(w.cwd, ".env.local"), "METER_KEY=local\n");
    await git(w.cwd, [...author, "commit", "--quiet", "-am", "chore: ignore env"]);
    const pack = join(w.root, "move.pack");
    const { manifest, pack: digest } = await packWork(w.cwd, BRANCH, w.folders, pack, [
      "dist/fonts",
      ".env.local",
    ]);
    const kept = manifest.entries.filter((entry) => entry.ignored).map((entry) => entry.path);
    expect(kept).toEqual([".env.local", "dist/fonts/meter.woff2"]);

    const there = await checkoutThere(w.project, w.root, manifest.head);
    await unpackWork(there, pack, {}, digest);
    expect(readFileSync(join(there, ".env.local"), "utf8")).toBe("METER_KEY=local\n");
    expect([...readFileSync(join(there, "dist", "fonts", "meter.woff2"))]).toEqual([
      0x77, 0x4f, 0x46, 0x32,
    ]);
    expect(existsSync(join(there, "dist", "bundle.js"))).toBe(false);
    // A second unpack, as after a lost answer, puts the kept file back as it left.
    writeFileSync(join(there, ".env.local"), "half");
    await unpackWork(there, pack, {});
    expect(readFileSync(join(there, ".env.local"), "utf8")).toBe("METER_KEY=local\n");

    await expect(packWork(w.cwd, BRANCH, w.folders, pack, ["dist/missing"])).rejects.toThrow(
      new UnsupportedWork("dist/missing, named to move with it, is not in its working copy"),
    );
    await expect(packWork(w.cwd, BRANCH, w.folders, pack, ["../project/meter.ts"])).rejects.toThrow(
      new UnsupportedWork(
        "../project/meter.ts, named to move with it, is not inside its working copy",
      ),
    );
  });

  it("refuses to write through a link that is already on the other computer", async () => {
    // Review INF-1772 R1: a moved file must never land outside the task's folders.
    const w = await startedWork();
    const pack = join(w.root, "move.pack");
    const { manifest } = await packWork(w.cwd, BRANCH, w.folders, pack);
    const there = await checkoutThere(w.project, w.root, manifest.head);
    const outside = join(w.root, "outside");
    mkdirSync(outside);
    const evidence = join(w.root, "evidence-there");
    mkdirSync(evidence);
    symlinkSync(outside, join(evidence, "shots"));
    await expect(unpackWork(there, pack, { evidence })).rejects.toThrow(
      "The moved work names a path through a link: shots/before.png",
    );
    expect(readdirSync(outside)).toEqual([]);
    // The folder itself a link: refused before anything is written, the patches included.
    const linked = join(w.root, "evidence-linked");
    symlinkSync(outside, linked);
    const fresh = await checkoutThere(w.project, w.root, manifest.head, "fresh");
    await expect(unpackWork(fresh, pack, { evidence: linked })).rejects.toThrow(
      `The moved work's folder ${linked} is a link here; nothing was unpacked.`,
    );
    expect(readdirSync(outside)).toEqual([]);
    expect(await git(fresh, ["status", "--porcelain"])).toBe("");
  });

  it("checks a clean submodule out again on the other side, and refuses one it could not fetch there", async () => {
    // Review INF-1772 R2: git's trees name a submodule by its commit alone, so
    // its edits, and a commit only this computer has, cannot cross.
    const w = await startedWork();
    // The submodule lives in a folder, as a project on a disk does; git fetches it from there.
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "protocol.file.allow");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "always");
    try {
      const library = join(w.root, "library");
      mkdirSync(library);
      await git(library, ["init", "--quiet", "--initial-branch=main"]);
      writeFileSync(join(library, "units.ts"), "export const units = ['kWh'];\n");
      await git(library, ["add", "."]);
      await git(library, [...author, "commit", "--quiet", "-m", "chore: units"]);
      await git(w.cwd, ["submodule", "add", "--quiet", library, "vendor/library"]);
      await git(w.cwd, [
        ...author,
        "commit",
        "--quiet",
        "-m",
        "chore: add library",
        "--",
        ".gitmodules",
        "vendor/library",
      ]);
      const pack = join(w.root, "move.pack");
      const { manifest, pack: digest } = await packWork(w.cwd, BRANCH, w.folders, pack);
      expect(manifest.submodules).toEqual(["vendor/library"]);
      const there = await checkoutThere(w.project, w.root, manifest.head);
      await unpackWork(there, pack, {}, digest);
      expect(readFileSync(join(there, "vendor", "library", "units.ts"), "utf8")).toBe(
        "export const units = ['kWh'];\n",
      );
      // Where it lives is gone on the other side: the move does not finish.
      const elsewhere = await checkoutThere(w.project, w.root, manifest.head, "elsewhere");
      await git(elsewhere, ["submodule", "init", "--quiet"]);
      await git(elsewhere, ["config", "submodule.vendor/library.url", join(w.root, "gone")]);
      await expect(unpackWork(elsewhere, pack, {}, digest)).rejects.toThrow(
        "A submodule of the moved work could not be checked out here",
      );

      // Review INF-1772 round 3 R2: a submodule git cannot list, its mapping
      // gone from .gitmodules, is never read as no submodule at all.
      const mapping = readFileSync(join(w.cwd, ".gitmodules"), "utf8");
      writeFileSync(join(w.cwd, ".gitmodules"), "");
      await expect(packWork(w.cwd, BRANCH, w.folders, pack)).rejects.toThrow(
        "its submodules could not be read",
      );
      writeFileSync(join(w.cwd, ".gitmodules"), mapping);

      // A commit made inside the submodule and never pushed stays.
      await git(join(w.cwd, "vendor", "library"), [
        ...author,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "chore: local units",
      ]);
      await git(w.cwd, [
        ...author,
        "commit",
        "--quiet",
        "-m",
        "chore: bump library",
        "--",
        "vendor/library",
      ]);
      await expect(packWork(w.cwd, BRANCH, w.folders, pack)).rejects.toThrow(
        new UnsupportedWork(
          "its submodule vendor/library is at a commit only this computer has, which a move cannot carry",
        ),
      );
      // An edit inside it stays too.
      writeFileSync(join(w.cwd, "vendor", "library", "units.ts"), "export const units = ['Wh'];\n");
      await expect(packWork(w.cwd, BRANCH, w.folders, pack)).rejects.toThrow(
        new UnsupportedWork(
          "its working copy has changes inside a submodule, which a move cannot carry",
        ),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("carries a file larger than one piece byte for byte", async () => {
    // Review INF-1772 R10: packing and unpacking read a piece at a time, never a whole file.
    const w = await startedWork();
    const recording = randomBytes(3 * 1024 * 1024 + 123);
    writeFileSync(join(w.folders.evidence, "demo.mp4"), recording);
    const pack = join(w.root, "move.pack");
    const { manifest, pack: digest } = await packWork(w.cwd, BRANCH, w.folders, pack);
    const there = await checkoutThere(w.project, w.root, manifest.head);
    const evidence = join(w.root, "evidence-there");
    await unpackWork(there, pack, { evidence }, digest);
    expect(readFileSync(join(evidence, "demo.mp4")).equals(recording)).toBe(true);
  });
});
