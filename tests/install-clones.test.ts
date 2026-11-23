import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import koffi from "koffi";
import { describe, expect, it } from "vitest";
import { cloneOrCopy } from "../scripts/clone-or-copy.ts";
import {
  ARCHES,
  type Arch,
  cachedTreeDir,
  ensureBundledGit,
  type ManifestEntry,
  unpackTree,
} from "../scripts/ensure-bundled-git.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * `pnpm install` places the app's git (vendor/git) and the ONNX runtime files
 * (src/renderer/src/generated/ort) in every working copy of this project. On
 * a Mac each one is an APFS clone, so the copies share those blocks instead
 * of each holding its own; where cloning cannot run, a plain copy lands.
 * These run the install steps against real files and, on a Mac, read APFS's
 * own count of the bytes a file shares with no clone.
 */

const repoRoot = join(__dirname, "..");
const isMac = process.platform === "darwin";
const MIB = 1024 * 1024;

let getattrlist: ((...args: unknown[]) => number) | undefined;

/** The bytes of `file` no clone shares: APFS's ATTR_CMNEXT_PRIVATESIZE (macOS only). */
function privateBytes(file: string): number {
  getattrlist ??= koffi
    .load("/usr/lib/libSystem.B.dylib")
    .func(
      "int getattrlist(const char *path, void *attrList, void *attrBuf, size_t attrBufSize, uint32_t options)",
    );
  // struct attrlist: bitmapcount, reserved, then common/vol/dir/file/fork groups.
  const request = Buffer.alloc(24);
  request.writeUInt16LE(5, 0);
  request.writeUInt32LE(0x8000_0000, 4); // ATTR_CMN_RETURNED_ATTRS
  request.writeUInt32LE(0x8, 20); // ATTR_CMNEXT_PRIVATESIZE, under FSOPT_ATTR_CMN_EXTENDED
  const reply = Buffer.alloc(64);
  // FSOPT_ATTR_CMN_EXTENDED | FSOPT_PACK_INVAL_ATTRS | FSOPT_NOFOLLOW
  const status = getattrlist(file, request, reply, reply.length, 0x20 | 0x8 | 0x1);
  if (status !== 0) throw new Error(`getattrlist ${file} answered ${status}`);
  // length (4), the returned attribute set (20), then the private size.
  return Number(reply.readBigUInt64LE(24));
}

function plantFolder(dir: string): Buffer {
  const program = randomBytes(MIB);
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "share"), { recursive: true });
  writeFileSync(join(dir, "bin", "tool"), program);
  chmodSync(join(dir, "bin", "tool"), 0o755);
  writeFileSync(join(dir, "share", "readme"), "nested\n");
  symlinkSync("../bin/tool", join(dir, "share", "tool"));
  return program;
}

function expectSameFolder(copy: string, program: Buffer): void {
  expect(readFileSync(join(copy, "bin", "tool")).equals(program)).toBe(true);
  expect(statSync(join(copy, "bin", "tool")).mode & 0o111).toBe(0o111);
  expect(readFileSync(join(copy, "share", "readme"), "utf8")).toBe("nested\n");
  expect(readlinkSync(join(copy, "share", "tool"))).toBe("../bin/tool");
}

describe("cloneOrCopy", () => {
  it("copies a folder whole, links kept as links, sharing the program's blocks on a Mac", () => {
    const dir = scratchDir("infinitary-clone-");
    const program = plantFolder(join(dir, "source"));

    cloneOrCopy(join(dir, "source"), join(dir, "copy"));

    expectSameFolder(join(dir, "copy"), program);
    if (isMac) expect(privateBytes(join(dir, "copy", "bin", "tool"))).toBe(0);
  });

  it("lands a plain copy when cloning cannot run", () => {
    const dir = scratchDir("infinitary-clone-");
    const program = plantFolder(join(dir, "source"));

    cloneOrCopy(join(dir, "source"), join(dir, "copy"), { cp: "/usr/bin/false" });

    expectSameFolder(join(dir, "copy"), program);
    if (isMac) expect(privateBytes(join(dir, "copy", "bin", "tool"))).toBeGreaterThan(0);
  });

  it("refuses a target that already exists", () => {
    const dir = scratchDir("infinitary-clone-");
    plantFolder(join(dir, "source"));
    mkdirSync(join(dir, "copy"));

    expect(() => cloneOrCopy(join(dir, "source"), join(dir, "copy"))).toThrow(/already exists/);
  });
});

/**
 * A stand-in for one of dugite's macOS archives: git's own programs, two it
 * prunes (git-lfs, Git Credential Manager) and a link between programs.
 */
function plantArchive(cacheDir: string, arch: Arch): ManifestEntry & { git: Buffer } {
  const tree = scratchDir("infinitary-git-archive-");
  const git = randomBytes(MIB);
  const core = join(tree, "libexec", "git-core");
  mkdirSync(join(tree, "bin"), { recursive: true });
  mkdirSync(core, { recursive: true });
  writeFileSync(join(tree, "bin", "git"), git);
  chmodSync(join(tree, "bin", "git"), 0o755);
  writeFileSync(join(core, "git-remote-http"), "remote\n");
  writeFileSync(join(core, "git-lfs"), "lfs\n");
  writeFileSync(join(core, "git-credential-manager"), "gcm\n");
  symlinkSync("../../bin/git", join(core, "git-upload-pack"));
  mkdirSync(cacheDir, { recursive: true });
  const name = `fixture-git-${arch}.tar.gz`;
  const packed = spawnSync("/usr/bin/tar", ["-czf", join(cacheDir, name), "-C", tree, "."]);
  expect(packed.status).toBe(0);
  const checksum = createHash("sha256")
    .update(readFileSync(join(cacheDir, name)))
    .digest("hex");
  // Nothing answers here: a download attempt fails the run instead of reaching out.
  return { name, url: "http://127.0.0.1:9/unreachable", checksum, git };
}

function plantArchives(cacheDir: string) {
  const archives = new Map(ARCHES.map((arch) => [arch, plantArchive(cacheDir, arch)]));
  const entryFor = (arch: Arch) => {
    const archive = archives.get(arch);
    if (!archive) throw new Error(`no archive for ${arch}`);
    return archive;
  };
  return { entryFor };
}

function expectPlacedGit(vendorDir: string, arch: Arch, entry: ManifestEntry & { git: Buffer }) {
  const tree = join(vendorDir, `darwin-${arch}`);
  expect(readFileSync(join(tree, "bin", "git")).equals(entry.git)).toBe(true);
  expect(statSync(join(tree, "bin", "git")).mode & 0o111).toBe(0o111);
  expect(readdirSync(join(tree, "libexec", "git-core")).sort()).toEqual([
    "git-remote-http",
    "git-upload-pack",
  ]);
  expect(readlinkSync(join(tree, "libexec", "git-core", "git-upload-pack"))).toBe("../../bin/git");
  expect(readFileSync(join(tree, ".infinitary-source"), "utf8")).toBe(
    `${entry.name} ${entry.checksum}\n`,
  );
}

describe("ensure-bundled-git.ts", () => {
  it("unpacks each archive once and clones its pruned tree into every working copy", async () => {
    const cacheDir = scratchDir("infinitary-git-cache-");
    const { entryFor } = plantArchives(cacheDir);
    const first = join(scratchDir("infinitary-copy-a-"), "vendor", "git");
    const second = join(scratchDir("infinitary-copy-b-"), "vendor", "git");

    await ensureBundledGit({ vendorDir: first, cacheDir, entryFor });
    // The second working copy needs neither the archive nor the network.
    for (const arch of ARCHES) rmSync(join(cacheDir, entryFor(arch).name));
    await ensureBundledGit({ vendorDir: second, cacheDir, entryFor });

    for (const arch of ARCHES) {
      expectPlacedGit(first, arch, entryFor(arch));
      expectPlacedGit(second, arch, entryFor(arch));
      expect(existsSync(join(cachedTreeDir(entryFor(arch), cacheDir), "bin", "git"))).toBe(true);
      if (isMac) {
        expect(privateBytes(join(first, `darwin-${arch}`, "bin", "git"))).toBe(0);
        expect(privateBytes(join(second, `darwin-${arch}`, "bin", "git"))).toBe(0);
      }
    }
  });

  it("leaves a placed tree alone and replaces one stamped for another archive", async () => {
    const cacheDir = scratchDir("infinitary-git-cache-");
    const { entryFor } = plantArchives(cacheDir);
    const vendorDir = join(scratchDir("infinitary-copy-"), "vendor", "git");
    await ensureBundledGit({ vendorDir, cacheDir, entryFor });
    const placed = statSync(join(vendorDir, "darwin-arm64", "bin", "git")).ino;
    writeFileSync(join(vendorDir, "darwin-x64", ".infinitary-source"), "an-older-archive 0\n");

    await ensureBundledGit({ vendorDir, cacheDir, entryFor });

    expect(statSync(join(vendorDir, "darwin-arm64", "bin", "git")).ino).toBe(placed);
    expectPlacedGit(vendorDir, "x64", entryFor("x64"));
    expect(readdirSync(vendorDir).sort()).toEqual(["darwin-arm64", "darwin-x64"]);
  });

  it("keeps the cached tree another install placed first", () => {
    const cacheDir = scratchDir("infinitary-git-cache-");
    const { entryFor } = plantArchives(cacheDir);
    const entry = entryFor("arm64");
    const tree = cachedTreeDir(entry, cacheDir);
    unpackTree(join(cacheDir, entry.name), entry, tree);
    const placed = statSync(join(tree, "bin", "git")).ino;

    unpackTree(join(cacheDir, entry.name), entry, tree);

    expect(statSync(join(tree, "bin", "git")).ino).toBe(placed);
    expect(readdirSync(join(cacheDir, "trees"))).toEqual([entry.name.replace(/\.tar\.gz$/, "")]);
  });
});

type OrtAssets = {
  FILES: string[];
  ortDist: () => string;
  copyOrtAssets: (options: { outDir: string }) => string;
};

describe("copy-ort-assets.mjs", () => {
  it("places the installed runtime files over the last run's, cloned on a Mac", async () => {
    const script = pathToFileURL(join(repoRoot, "scripts", "copy-ort-assets.mjs")).href;
    const { FILES, ortDist, copyOrtAssets } = (await import(script)) as OrtAssets;
    const outDir = join(scratchDir("infinitary-ort-"), "generated", "ort");

    copyOrtAssets({ outDir });
    copyOrtAssets({ outDir });

    expect(readdirSync(outDir).sort()).toEqual([...FILES].sort());
    for (const file of FILES) {
      expect(readFileSync(join(outDir, file)).equals(readFileSync(join(ortDist(), file)))).toBe(
        true,
      );
      if (isMac) expect(privateBytes(join(outDir, file))).toBe(0);
    }
  });
});
