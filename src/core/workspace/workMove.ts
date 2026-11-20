import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { z } from "zod";
import { sha256Of } from "./bundles";
import { git } from "./git";

/**
 * A started task's work, packed to move to another computer (docs/helper.md,
 * "Moving a started task"). Git's bundle carries the branch's commits; this
 * pack carries what a bundle does not: what is staged and what is not, as
 * two binary patches against the commit the checkout is at, the files git
 * does not track and does not ignore, and the files in the task's own
 * folders (its evidence, card bodies, source cards, handed files and
 * conversations). No commit is made to carry them.
 *
 * The pack is one file: its manifest as one JSON line, then each part's
 * bytes in the manifest's order. The side that unpacks it checks each
 * part's digest, and then checks the restored checkout against the two
 * trees the packing side read - the index and the whole working tree - so
 * what arrives is what left, whatever either side's git version prints.
 * Links are kept as links and never followed; anything else that is not a
 * plain file is refused.
 */

/** The task's own folders a pack carries, by name. */
export const MOVED_FOLDERS = [
  "evidence",
  "card-bodies",
  "source-cards",
  "sessions",
  "handover",
] as const;
export type MovedFolder = (typeof MOVED_FOLDERS)[number];
export type MovedFolders = Partial<Record<MovedFolder, string>>;

const digestSchema = z.object({
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const entrySchema = z.object({
  /** `work` for a file git does not track; else the task folder it sits in. */
  area: z.enum(["work", ...MOVED_FOLDERS]),
  path: z.string().min(1),
  /** The file's mode bits; a link's are ignored. */
  mode: z.number().int().nonnegative(),
  /** Where a link points, as written; a link carries no bytes. */
  link: z.string().optional(),
  /** A `work` file git ignores, carried because the move's `keep` named it. */
  ignored: z.literal(true).optional(),
  ...digestSchema.shape,
});
export type MoveEntry = z.infer<typeof entrySchema>;

export const moveManifestSchema = z.object({
  v: z.literal(1),
  /** The commit the checkout is at, on `branch`. */
  head: z.string().regex(/^[0-9a-f]{40,64}$/),
  branch: z.string().min(1),
  /** The index's tree, and the whole working tree's (untracked files included). */
  indexTree: z.string().regex(/^[0-9a-f]{40,64}$/),
  workTree: z.string().regex(/^[0-9a-f]{40,64}$/),
  staged: digestSchema,
  unstaged: digestSchema,
  entries: z.array(entrySchema),
  /**
   * The submodules checked out where it was packed, by path: the receiving
   * side checks each out at the commit the tree names, from where it lives.
   */
  submodules: z.array(z.string().min(1)).optional(),
});
export type MoveManifest = z.infer<typeof moveManifestSchema>;

/** A move refused for what the working copy holds: the reason is for the captain. */
export class UnsupportedWork extends Error {}

/**
 * Packs the working copy at `cwd` and the task's folders into `out`.
 * Refuses a checkout off `branch`, or in the middle of a merge, rebase,
 * cherry-pick, revert or bisect. Files git ignores stay out, except under
 * the paths `keep` names in the working copy, each of which must be there.
 * Answers the manifest and the pack's digest.
 */
export async function packWork(
  cwd: string,
  branch: string,
  folders: MovedFolders,
  out: string,
  keep: readonly string[] = [],
): Promise<{ manifest: MoveManifest; pack: { size: number; sha256: string } }> {
  const current = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  if (current !== branch)
    throw new UnsupportedWork(
      current
        ? `its working copy is on ${current}, not its own branch ${branch}`
        : `its working copy is not on its own branch ${branch}`,
    );
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
  ]) {
    const path = await git(cwd, ["rev-parse", "--git-path", marker]);
    if (existsSync(isAbsolute(path) ? path : join(cwd, path)))
      throw new UnsupportedWork("its working copy is in the middle of a merge, rebase or similar");
  }
  // Git's trees name a submodule by its commit, never by the edits inside
  // it, so a submodule with edits of its own cannot be checked on arrival.
  const submodules = await gitlinks(cwd);
  if (submodules.length) {
    const changed = await git(
      cwd,
      ["status", "--porcelain", "--ignore-submodules=none", "--", ...submodules],
      { trim: false },
    );
    if (changed.trim())
      throw new UnsupportedWork(
        "its working copy has changes inside a submodule, which a move cannot carry",
      );
  }
  // A checked-out submodule crosses as its commit, fetched again on the
  // other side, so that commit must be one where the submodule lives has.
  const checkedOut = submodules.length
    ? await checkedOutSubmodules(cwd).catch((caught: unknown) => {
        throw new UnsupportedWork(
          `its submodules could not be read: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      })
    : [];
  for (const path of checkedOut) {
    const known = await git(join(cwd, path), [
      "for-each-ref",
      "--count=1",
      "--contains",
      "HEAD",
      "--format=%(refname)",
      "refs/remotes",
    ]).catch(() => "");
    if (!known)
      throw new UnsupportedWork(
        `its submodule ${path} is at a commit only this computer has, which a move cannot carry`,
      );
  }
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const trees = await treesOf(cwd);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  const stagedFile = `${out}.staged`;
  const unstagedFile = `${out}.unstaged`;
  try {
    await git(cwd, [...DIFF, "--cached", `--output=${stagedFile}`, "HEAD"]);
    await git(cwd, [...DIFF, `--output=${unstagedFile}`]);
    const entries: MoveEntry[] = [];
    const untracked = (
      await git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"], { trim: false })
    )
      .split("\0")
      .filter(Boolean);
    for (const path of untracked) entries.push(await entryOf("work", cwd, path));
    for (const path of await keptIgnored(cwd, keep))
      entries.push({ ...(await entryOf("work", cwd, path)), ignored: true });
    for (const area of MOVED_FOLDERS) {
      const dir = folders[area];
      if (!dir || !existsSync(dir)) continue;
      for (const path of await walk(dir)) entries.push(await entryOf(area, dir, path));
    }
    const manifest: MoveManifest = {
      v: 1,
      head,
      branch,
      ...trees,
      staged: await digestOf(stagedFile),
      unstaged: await digestOf(unstagedFile),
      entries,
      ...(checkedOut.length ? { submodules: checkedOut } : {}),
    };
    await rm(out, { force: true });
    const handle = await open(out, "w", 0o600);
    try {
      await writeAll(handle, Buffer.from(`${JSON.stringify(manifest)}\n`));
      await copyInto(handle, stagedFile);
      await copyInto(handle, unstagedFile);
      for (const entry of entries) {
        if (entry.link !== undefined) continue;
        const root = entry.area === "work" ? cwd : (folders[entry.area] as string);
        await copyInto(handle, join(root, entry.path), entry);
      }
    } finally {
      await handle.close();
    }
    return { manifest, pack: await digestOf(out) };
  } finally {
    await rm(stagedFile, { force: true });
    await rm(unstagedFile, { force: true });
  }
}

/**
 * Packs what this Mac holds of a task whose computer is out of reach
 * (docs/helper.md, "Moving a task off a computer that is out of reach"):
 * the commit `head` of the repository at `repoDir` stands in for the
 * working copy, so the pack carries no staged or unstaged edits and no
 * untracked files, only the task's folders here. The receiving side checks
 * its fresh checkout against that commit's tree. Answers the manifest and
 * the pack's digest.
 */
export async function packHomeCopy(
  repoDir: string,
  head: string,
  branch: string,
  folders: MovedFolders,
  out: string,
): Promise<{ manifest: MoveManifest; pack: { size: number; sha256: string } }> {
  const commit = await git(repoDir, ["rev-parse", "--verify", `${head}^{commit}`]);
  const tree = await git(repoDir, ["rev-parse", "--verify", `${commit}^{tree}`]);
  const entries: MoveEntry[] = [];
  for (const area of MOVED_FOLDERS) {
    const dir = folders[area];
    if (!dir || !existsSync(dir)) continue;
    for (const path of await walk(dir)) entries.push(await entryOf(area, dir, path));
  }
  const empty = { size: 0, sha256: EMPTY_SHA256 };
  const manifest: MoveManifest = {
    v: 1,
    head: commit,
    branch,
    indexTree: tree,
    workTree: tree,
    staged: empty,
    unstaged: empty,
    entries,
  };
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await rm(out, { force: true });
  const handle = await open(out, "w", 0o600);
  try {
    await writeAll(handle, Buffer.from(`${JSON.stringify(manifest)}\n`));
    for (const entry of entries) {
      if (entry.link !== undefined) continue;
      await copyInto(handle, join(folders[entry.area as MovedFolder] as string, entry.path), entry);
    }
  } finally {
    await handle.close();
  }
  return { manifest, pack: await digestOf(out) };
}

/** The pack's manifest, read from its first line. */
export function readManifest(pack: string): { manifest: MoveManifest; offset: number } {
  const fd = openSync(pack, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, position);
      if (read === 0) throw new Error("The moved work's pack has no manifest.");
      const end = buffer.subarray(0, read).indexOf(10);
      if (end >= 0) {
        chunks.push(Buffer.from(buffer.subarray(0, end)));
        const line = Buffer.concat(chunks).toString("utf8");
        return {
          manifest: moveManifestSchema.parse(JSON.parse(line)),
          offset: position + end + 1,
        };
      }
      chunks.push(Buffer.from(buffer.subarray(0, read)));
      position += read;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Unpacks `pack` into the working copy at `cwd`, which must be a clean
 * checkout of the manifest's commit, and into the task's folders: the
 * staged patch into the index and the files, the unstaged one into the
 * files, each untracked file and folder file where it was. A folder file
 * or kept ignored file already here is replaced by the moved one; nothing
 * else here is touched.
 * Then the index and working tree must read as the trees the packing side
 * read, or it throws.
 */
export async function unpackWork(
  cwd: string,
  pack: string,
  folders: MovedFolders,
  expected?: { size: number; sha256: string },
): Promise<MoveManifest> {
  if (expected) {
    const got = await digestOf(pack);
    if (got.size !== expected.size || got.sha256 !== expected.sha256)
      throw new Error("The moved work that arrived is not what was sent.");
  }
  const { manifest, offset } = readManifest(pack);
  // Nothing is written into a folder that is itself a link here.
  for (const root of [cwd, ...Object.values(folders)])
    if (root && isLink(root))
      throw new Error(`The moved work's folder ${root} is a link here; nothing was unpacked.`);
  if ((await git(cwd, ["rev-parse", "HEAD"])) !== manifest.head)
    throw new Error("The new working copy is not at the moved work's commit.");
  const already = await treesOf(cwd);
  if (already.indexTree === manifest.indexTree && already.workTree === manifest.workTree) {
    // Unpacked already, say before an answer was lost: only the folders again.
    await unpackFiles(
      cwd,
      pack,
      folders,
      manifest,
      offset + manifest.staged.size + manifest.unstaged.size,
      false,
    );
    await checkOutSubmodules(cwd, manifest);
    return manifest;
  }
  if (await git(cwd, ["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("The new working copy already holds other edits; nothing was unpacked.");
  let position = offset;
  const fd = await open(pack, "r");
  try {
    for (const [patch, index] of [
      [manifest.staged, true],
      [manifest.unstaged, false],
    ] as const) {
      if (patch.size > 0) {
        const file = `${pack}.patch`;
        await extract(fd, position, patch, file);
        try {
          await git(cwd, [
            "apply",
            "--binary",
            "--whitespace=nowarn",
            ...(index ? ["--index"] : []),
            file,
          ]);
        } finally {
          await rm(file, { force: true });
        }
      }
      position += patch.size;
    }
  } finally {
    await fd.close();
  }
  await unpackFiles(cwd, pack, folders, manifest, position, true);
  const now = await treesOf(cwd);
  if (now.indexTree !== manifest.indexTree || now.workTree !== manifest.workTree)
    throw new Error("The moved work does not match what left the other computer.");
  await checkOutSubmodules(cwd, manifest);
  return manifest;
}

/** Each file the pack carries, its bytes from `start`; `work` files only with `withWork`. */
async function unpackFiles(
  cwd: string,
  pack: string,
  folders: MovedFolders,
  manifest: MoveManifest,
  start: number,
  withWork: boolean,
): Promise<void> {
  let position = start;
  const fd = await open(pack, "r");
  try {
    for (const entry of manifest.entries) {
      const carried = entry.link === undefined ? entry.size : 0;
      const skip = entry.area === "work" && !entry.ignored && !withWork;
      if (!skip) {
        const root = entry.area === "work" ? cwd : folders[entry.area];
        if (root) {
          const target = inside(root, entry.path);
          refuseLinkAbove(root, target, entry.path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          if (existsSync(target) || isLink(target)) {
            if (entry.area === "work" && !entry.ignored)
              throw new Error(`${entry.path} is already in the new working copy.`);
            await rm(target, { force: true, recursive: true });
          }
          if (entry.link !== undefined) await symlink(entry.link, target);
          else {
            await extract(fd, position, entry, target);
            await chmod(target, entry.mode & 0o777);
          }
        }
      }
      position += carried;
    }
  } finally {
    await fd.close();
  }
}

/** The submodules the index at `cwd` names, by path. */
async function gitlinks(cwd: string): Promise<string[]> {
  return (await git(cwd, ["ls-files", "-z", "--stage"], { trim: false }))
    .split("\0")
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.slice(line.indexOf("\t") + 1));
}

/**
 * Every submodule checked out under `cwd`, nested ones too, by path from
 * `cwd`. Throws when git cannot list them or names one in a way this does
 * not read, so a submodule nobody could read is never taken as none.
 */
async function checkedOutSubmodules(cwd: string): Promise<string[]> {
  const listed = await git(cwd, ["submodule", "status", "--recursive"], { trim: false });
  return listed
    .split("\n")
    .filter((line) => line && !line.startsWith("-"))
    .map((line) => {
      const path = /^[ +U][0-9a-f]+ (.+?)(?: \(.*\))?$/.exec(line)?.[1];
      if (!path)
        throw new Error(`git named a submodule as "${line.trim()}", which is not read here.`);
      return path;
    });
}

/**
 * Checks out each submodule the packing side had checked out, at the
 * commit the tree names, and throws unless every one is there: a move
 * never retires a submodule's checkout its destination does not hold.
 */
async function checkOutSubmodules(cwd: string, manifest: MoveManifest): Promise<void> {
  if (!manifest.submodules?.length) return;
  const wanted = manifest.submodules;
  const top = (await gitlinks(cwd)).filter((path) => wanted.includes(path));
  await git(cwd, ["submodule", "update", "--init", "--recursive", "--", ...top]).catch(
    (caught: unknown) => {
      throw new Error(
        `A submodule of the moved work could not be checked out here: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    },
  );
  const here = await checkedOutSubmodules(cwd);
  const missing = manifest.submodules.find((path) => !here.includes(path));
  if (missing) throw new Error(`The moved work's submodule ${missing} is not checked out here.`);
  if (await git(cwd, ["submodule", "status", "--recursive"]).then((out) => /^[+U]/m.test(out)))
    throw new Error("A submodule of the moved work is not at the commit that left.");
}

/** git diff that reads the same on any computer: binary, full index, no renames or colours. */
const DIFF = [
  "-c",
  "core.quotepath=off",
  "diff",
  "--binary",
  "--full-index",
  "--no-color",
  "--no-ext-diff",
  "--no-renames",
  "--no-textconv",
];

/**
 * The index's tree, and the whole working tree's - tracked and untracked,
 * never ignored - written through a throwaway index, so the checkout's own
 * index is left as it was.
 */
async function treesOf(cwd: string): Promise<{ indexTree: string; workTree: string }> {
  const indexTree = await git(cwd, ["write-tree"]);
  const gitDir = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
  const scratch = join(gitDir, `infinitary-move-index-${process.pid}-${Date.now()}`);
  try {
    const env = { GIT_INDEX_FILE: scratch };
    await git(cwd, ["read-tree", indexTree], { env });
    await git(cwd, ["add", "--all", "--", "."], { env });
    return { indexTree, workTree: await git(cwd, ["write-tree"], { env }) };
  } finally {
    await rm(scratch, { force: true });
  }
}

async function entryOf(area: MoveEntry["area"], root: string, path: string): Promise<MoveEntry> {
  const file = join(root, path);
  const info = await lstat(file);
  if (info.isSymbolicLink())
    return { area, path, mode: 0o777, link: await readlink(file), size: 0, sha256: EMPTY_SHA256 };
  if (!info.isFile())
    throw new UnsupportedWork(
      `${area === "work" ? "its working copy" : `its ${area} folder`} holds ${path}, which is neither a file nor a link`,
    );
  return { area, path, mode: info.mode & 0o777, ...(await digestOf(file)) };
}

/**
 * The ignored files under each path `keep` names, relative to `cwd`. A path
 * outside the working copy, through a link, or not there is refused.
 */
async function keptIgnored(cwd: string, keep: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const path of keep) {
    let target: string;
    try {
      target = inside(cwd, path);
      refuseLinkAbove(cwd, target, path);
    } catch {
      throw new UnsupportedWork(`${path}, named to move with it, is not inside its working copy`);
    }
    if (!existsSync(target) && !isLink(target))
      throw new UnsupportedWork(`${path}, named to move with it, is not in its working copy`);
    const ignored = await git(
      cwd,
      [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        relative(cwd, target) || ".",
      ],
      { trim: false },
    );
    for (const file of ignored.split("\0").filter(Boolean)) found.add(file);
  }
  return [...found].sort();
}

/** Every file and link under `dir`, relative to it; links are never followed. */
async function walk(dir: string, under = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(dir, under), { withFileTypes: true })) {
    const path = under ? `${under}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await walk(dir, path)));
    else found.push(path);
  }
  return found.sort();
}

/** A path the pack names, kept inside `root`. */
function inside(root: string, path: string): string {
  const relative = normalize(path);
  if (isAbsolute(relative) || relative === ".." || relative.startsWith(`..${sep}`))
    throw new Error(`The moved work names a path outside its folder: ${path}`);
  return join(root, relative);
}

/**
 * Refuses a path under `root` that passes through a link already there, so
 * nothing the pack writes or replaces lands outside the task's folders.
 */
function refuseLinkAbove(root: string, target: string, path: string): void {
  let dir = root;
  for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    dir = join(dir, part);
    if (isLink(dir)) throw new Error(`The moved work names a path through a link: ${path}`);
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const EMPTY_SHA256 = createHash("sha256").digest("hex");

async function digestOf(file: string): Promise<{ size: number; sha256: string }> {
  return { size: (await stat(file)).size, sha256: await sha256Of(file) };
}

/** How much of a file is read at a time while packing or unpacking. */
const MOVE_PIECE_BYTES = 1024 * 1024;

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length)
    written += (await handle.write(bytes, written, bytes.length - written)).bytesWritten;
}

/** Appends `file` to the pack, a piece at a time, checking it is still the file the manifest names. */
async function copyInto(
  out: FileHandle,
  file: string,
  expected?: { size: number; sha256: string },
): Promise<void> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(MOVE_PIECE_BYTES);
  let size = 0;
  const input = await open(file, "r");
  try {
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const piece = buffer.subarray(0, bytesRead);
      hash.update(piece);
      await writeAll(out, piece);
      size += bytesRead;
    }
  } finally {
    await input.close();
  }
  if (expected && (size !== expected.size || hash.digest("hex") !== expected.sha256))
    throw new UnsupportedWork(`${file} changed while its work was being packed`);
}

/** Writes the pack's bytes for one part to `target`, a piece at a time, checking its digest. */
async function extract(
  pack: FileHandle,
  position: number,
  expected: { size: number; sha256: string },
  target: string,
): Promise<void> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(Math.min(MOVE_PIECE_BYTES, Math.max(expected.size, 1)));
  const out = await open(target, "w", 0o600);
  let whole = false;
  try {
    let read = 0;
    while (read < expected.size) {
      const want = Math.min(buffer.length, expected.size - read);
      const { bytesRead } = await pack.read(buffer, 0, want, position + read);
      if (bytesRead === 0) throw new Error("The moved work's pack ends early.");
      const piece = buffer.subarray(0, bytesRead);
      hash.update(piece);
      await writeAll(out, piece);
      read += bytesRead;
    }
    if (hash.digest("hex") !== expected.sha256)
      throw new Error("A part of the moved work does not match what left the other computer.");
    whole = true;
  } finally {
    await out.close();
    // A part that ends early or does not match leaves nothing behind.
    if (!whole) await rm(target, { force: true });
  }
}
