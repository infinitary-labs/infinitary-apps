/**
 * The universal merge's file listing, as `patches/@electron__universal@2.0.3.patch`
 * leaves it (INF-1418, the captain's "Approve and build" on "Cut repeated file
 * inspection from universal packaging"): it asks `file` only for a file whose
 * first four bytes could start a Mach-O or cannot be read, and gives every
 * file the type the unpatched listing gives it, which spawns `file` for every
 * file and is written out below as the merger's 2.0.3 release has it.
 *
 * The trees are the package's own: Electron's distribution, the dependency's
 * own scripts, and darwin prebuilds with thin and fat Mach-O binaries, which
 * pnpm installs on every platform (`supportedArchitectures`).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";

vi.setConfig({ testTimeout: 15_000 });

const require = createRequire(import.meta.url);

interface AppFile {
  relativePath: string;
  type: number;
}

interface FileUtils {
  AppFileType: Record<"MACHO" | "PLAIN" | "INFO_PLIST" | "SNAPSHOT" | "APP_CODE", number>;
  getAllAppFiles(appPath: string): Promise<AppFile[]>;
}

/** The merger electron-builder runs, reached through its own dependency graph. */
function universalRequire(): NodeJS.Require {
  const electronBuilder = createRequire(require.resolve("electron-builder/package.json"));
  const appBuilderLib = createRequire(electronBuilder.resolve("app-builder-lib/package.json"));
  return createRequire(appBuilderLib.resolve("@electron/universal/package.json"));
}

const universal = universalRequire();
const fileUtils = universal("./dist/cjs/file-utils.js") as FileUtils;

function packageDir(...chain: string[]): string {
  let from = require;
  let dir = "";
  for (const name of chain) {
    dir = dirname(from.resolve(`${name}/package.json`));
    from = createRequire(join(dir, "package.json"));
  }
  return dir;
}

const ESBUILD_ARM64 = packageDir("vite", "esbuild", "@esbuild/darwin-arm64");
const ESBUILD_X64 = packageDir("vite", "esbuild", "@esbuild/darwin-x64");
const FSEVENTS = packageDir("vite", "fsevents");
const UNIVERSAL = dirname(universal.resolve("./package.json"));

const FILE = execFileSync("sh", ["-c", "command -v file"], { encoding: "utf8" }).trim();

function countingFile(): () => string[] {
  const bin = scratchDir("infinitary-universal-file-");
  const log = join(bin, "launches.log");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "file"),
    `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' "$last" >> '${log}'\nexec '${FILE}' "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  return () => readFileSync(log, "utf8").split("\n").filter(Boolean);
}

/** The 2.0.3 listing's own classification: `file` for every file. */
function unpatchedType(path: string): number {
  const { AppFileType } = fileUtils;
  let output = "";
  try {
    output = execFileSync(FILE, ["--brief", "--no-pad", path], { encoding: "utf8" });
  } catch {
    // The listing accepts `file`'s error codes silently.
  }
  if (path.endsWith(".asar")) return AppFileType.APP_CODE;
  if (output.startsWith("Mach-O ")) return AppFileType.MACHO;
  if (path.endsWith(".bin")) return AppFileType.SNAPSHOT;
  if (basename(path) === "Info.plist") return AppFileType.INFO_PLIST;
  return AppFileType.PLAIN;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the patched universal file listing", () => {
  const trees = [
    { name: "Electron's distribution", tree: join(packageDir("electron"), "dist") },
    { name: "@electron/universal", tree: UNIVERSAL },
    { name: "@esbuild/darwin-arm64", tree: ESBUILD_ARM64 },
    { name: "@esbuild/darwin-x64", tree: ESBUILD_X64 },
    { name: "fsevents", tree: FSEVENTS },
  ];

  it.each(trees)("types every file of $name as the unpatched listing does", async ({ tree }) => {
    const launches = countingFile();
    const files = await fileUtils.getAllAppFiles(tree);
    expect(files.length).toBeGreaterThan(0);

    const machO = files.filter((file) => file.type === fileUtils.AppFileType.MACHO);
    for (const file of files) {
      expect(file.type, file.relativePath).toBe(unpatchedType(join(tree, file.relativePath)));
    }
    const inspected = launches().map((path) => relative(tree, path));
    // Every Mach-O is still asked about, and not every file is.
    for (const file of machO) expect(inspected).toContain(file.relativePath);
    expect(inspected.length).toBeLessThan(files.length);
  });

  it("finds thin and fat Mach-O binaries among the prebuilds", async () => {
    const types = async (tree: string) =>
      (await fileUtils.getAllAppFiles(tree)).map((file) => file.type);
    expect(await types(ESBUILD_ARM64)).toContain(fileUtils.AppFileType.MACHO);
    expect(await types(FSEVENTS)).toContain(fileUtils.AppFileType.MACHO);
  });

  // Root reads a file its mode refuses, so only another user sees the refusal.
  it.skipIf(process.getuid?.() === 0)(
    "asks `file` about a file whose header cannot be read",
    async () => {
      const tree = scratchDir("infinitary-universal-unreadable-");
      copyFileSync(join(FSEVENTS, "fsevents.node"), join(tree, "fsevents.node"));
      copyFileSync(join(UNIVERSAL, "package.json"), join(tree, "Info.plist"));
      copyFileSync(join(UNIVERSAL, "package.json"), join(tree, "unreadable.json"));
      chmodSync(join(tree, "unreadable.json"), 0o000);
      try {
        const launches = countingFile();
        const files = await fileUtils.getAllAppFiles(tree);
        expect(files).toHaveLength(3);
        for (const file of files) {
          expect(file.type, file.relativePath).toBe(unpatchedType(join(tree, file.relativePath)));
        }
        expect(
          launches()
            .map((path) => basename(path))
            .sort(),
        ).toEqual(["fsevents.node", "unreadable.json"]);
      } finally {
        chmodSync(join(tree, "unreadable.json"), 0o644);
      }
    },
  );
});
