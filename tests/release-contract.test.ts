import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ARCHES, manifestEntry } from "../scripts/ensure-bundled-git.ts";
import { PUBLIC_RELEASE_NAMES } from "../src/core/update/releaseSource";
import { BUNDLE_ID, HOMEPAGE, renderCask } from "../src/core/update/tapPublication";
import {
  buildDownloadUrl,
  buildUpdateTarget,
  CASK_TOKENS,
  FIRSTMATE_TAP,
  TAP,
  targetProblem,
  upgradeCommandFor,
} from "../src/core/update/updateChannels";
import { packagedFlavor } from "../src/main/userDataDir";
import { isPseudoLanguage } from "../src/shared/i18n/languages";
import { CATALOG_LANGUAGES } from "../src/shared/i18n/messages.generated";
import { electronBinary } from "./helpers/electronBundle";
import { loadYamlFile } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

// Eight-worker Mac measurement: slowest default-budget case 1.854 s; brew keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/**
 * The release-contract test (docs/architecture.md, in the
 * style of pi-launcher's check-release-contract.py and baby-menu's
 * release-config.test.ts): the packaging, signing, and release files ARE
 * the shipping contract, so their invariants are asserted from the real
 * files. A failed check here is the gate working.
 */

const root = join(__dirname, "..");

const read = (path: string) => readFileSync(join(root, path), "utf8");

const require = createRequire(import.meta.url);

/**
 * The matcher @electron/universal uses for x64ArchFiles (matchBase: true).
 * Reaching it through electron-builder's own dependency graph keeps the
 * guard on the merger's contract, not a reimplementation.
 */
function universalMinimatch(): (path: string, pattern: string) => boolean {
  const electronBuilder = createRequire(require.resolve("electron-builder/package.json"));
  const appBuilderLib = createRequire(electronBuilder.resolve("app-builder-lib/package.json"));
  const electronUniversal = createRequire(
    appBuilderLib.resolve("@electron/universal/package.json"),
  );
  const { minimatch } = electronUniversal("minimatch") as {
    minimatch: (path: string, pattern: string, options?: { matchBase?: boolean }) => boolean;
  };
  return (path, pattern) => minimatch(path, pattern, { matchBase: true });
}

function macX64ArchFiles(config: Record<string, unknown>): string {
  const mac = config.mac;
  if (mac === null || typeof mac !== "object" || Array.isArray(mac)) {
    throw new Error("electron-builder.yml mac: is not a mapping");
  }
  const pattern = (mac as { x64ArchFiles?: unknown }).x64ArchFiles;
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("electron-builder.yml mac.x64ArchFiles is missing");
  }
  return pattern;
}

function asarUnpackPatterns(config: Record<string, unknown>): string[] {
  const unpack = config.asarUnpack;
  if (typeof unpack === "string") return [unpack];
  if (!Array.isArray(unpack)) return [];
  return unpack.filter((entry): entry is string => typeof entry === "string");
}

function optionalDarwinPackages(resolvedFrom: string, prefix: string): string[] {
  const pkg = JSON.parse(
    readFileSync(join(dirname(require.resolve(resolvedFrom)), "package.json"), "utf8"),
  ) as { optionalDependencies?: Record<string, string> };
  const names = Object.keys(pkg.optionalDependencies ?? {}).filter((name) =>
    name.startsWith(prefix),
  );
  if (names.length === 0) {
    throw new Error(`${resolvedFrom} listed no optional packages starting with ${prefix}`);
  }
  return names.sort();
}

function claudeDarwinAgentSdkPackages(): string[] {
  return optionalDarwinPackages(
    "@anthropic-ai/claude-agent-sdk",
    "@anthropic-ai/claude-agent-sdk-darwin-",
  );
}

function koffiDarwinPackages(): string[] {
  return optionalDarwinPackages("koffi", "@koromix/koffi-darwin-");
}

describe("version pins", () => {
  const pkg = JSON.parse(read("package.json"));

  it("pins electron-builder at or above the pnpm-dedupe-safe floor", () => {
    const version = String(pkg.devDependencies["electron-builder"]).replace(/^[^\d]*/, "");
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    // The asar dedupe bug documented in baby-menu; never downgrade.
    expect(major > 26 || (major === 26 && (minor > 8 || (minor === 8 && patch >= 2)))).toBe(true);
  });

  it("does not depend on quota-axi", () => {
    expect(pkg.dependencies["quota-axi"]).toBeUndefined();
    expect(pkg.devDependencies["quota-axi"]).toBeUndefined();
  });

  /**
   * The app's own git (docs/forge.md): dugite's manifest is the pin, and
   * NOTICE - the file that carries git's GPLv2 notice and its source - names
   * exactly the release that manifest ships.
   */
  it("ships the git dugite pins, named in NOTICE, fetched by our postinstall alone", () => {
    expect(pkg.dependencies.dugite).toMatch(/^\d/);
    const notice = read("NOTICE");
    for (const arch of ARCHES) {
      const { url } = manifestEntry(arch);
      const release = url.match(/\/releases\/download\/(v(\d+\.\d+\.\d+)-\d+)\//);
      expect(release, url).not.toBeNull();
      expect(notice).toContain(
        `git ${release?.[2]} from the dugite-native ${release?.[1]} release`,
      );
      expect(notice).toContain(`https://github.com/git/git/tree/v${release?.[2]}`);
    }
    expect(notice).toContain("GNU General Public");
    expect(notice).toContain("dugite (https://github.com/desktop/dugite)");
    // dugite's own postinstall would fetch one architecture into node_modules.
    const workspace = loadYamlFile("pnpm-workspace.yaml") as {
      allowBuilds?: Record<string, unknown>;
    };
    expect(workspace.allowBuilds?.dugite).toBe(false);
  });

  it("pins every dependency exactly (no ranges in the first-commit pin set)", () => {
    for (const [name, version] of Object.entries({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    })) {
      expect(String(version), `${name} must be exactly pinned`).toMatch(/^\d/);
    }
  });
});

describe("electron-builder configuration", () => {
  const configText = read("electron-builder.yml");
  const parsed = loadYamlFile("electron-builder.yml");

  it("carries the D-15 naming", () => {
    expect(parsed.appId).toBe("com.getinfinitary.infinitary");
    expect(parsed.productName).toBe("Infinitary");
  });

  it("targets macOS universal only (D-1)", () => {
    const mac = parsed.mac as { target?: Array<{ arch?: string[] }> };
    const arches = (mac.target ?? []).flatMap((target) => target.arch ?? []);
    expect(arches.length).toBeGreaterThan(0);
    expect(arches.every((arch) => arch === "universal")).toBe(true);
    expect(parsed.win).toBeUndefined();
    expect(parsed.linux).toBeUndefined();
  });

  it("keeps exactly the catalog's languages in the macOS bundle", () => {
    // INF-3683: macOS lists an app's languages from its .lproj folders, named
    // in macOS's own form, so each catalog language but the pseudo-languages keeps its folder.
    const lproj = (tag: string) =>
      ({ "zh-Hans": "zh_CN", "zh-Hant": "zh_TW" })[tag] ?? tag.replace("-", "_");
    const mac = parsed.mac as { electronLanguages?: string[] };
    expect([...(mac.electronLanguages ?? [])].sort()).toEqual(
      CATALOG_LANGUAGES.filter((tag) => !isPseudoLanguage(tag))
        .map(lproj)
        .sort(),
    );
  });

  it("keeps the section 4 electron fuses", () => {
    const fuses = parsed.electronFuses as Record<string, unknown>;
    expect(fuses.runAsNode).toBe(false);
    expect(fuses.enableNodeOptionsEnvironmentVariable).toBe(false);
    expect(fuses.enableNodeCliInspectArguments).toBe(false);
    expect(fuses.enableEmbeddedAsarIntegrityValidation).toBe(true);
    expect(fuses.onlyLoadAppFromAsar).toBe(true);
  });

  it("covers every per-arch native tree in x64ArchFiles", () => {
    const pattern = macX64ArchFiles(parsed);
    const matches = universalMinimatch();
    const unpacked = (pkg: string) =>
      `Contents/Resources/app.asar.unpacked/node_modules/${pkg}/native.bin`;
    for (const pkg of [
      "koffi",
      "@koromix/koffi-darwin-arm64",
      "@koromix/koffi-darwin-x64",
      "@earendil-works/pi-tui/native",
      "@mariozechner/clipboard-darwin-arm64",
      "@mariozechner/clipboard-darwin-x64",
      "better-sqlite3/prebuilds",
      "onnxruntime-node/bin",
    ]) {
      expect(matches(unpacked(pkg), pattern), `${pkg} must match x64ArchFiles`).toBe(true);
    }
  });

  /**
   * The voice helper (docs/architecture.md section 8) loads onnxruntime-node's
   * N-API addon and the library beside it, which cannot load from inside
   * app.asar. The package ships one Apple silicon build, the same copy in
   * both universal slices, and every other platform's build stays out.
   */
  it("unpacks the voice helper's ONNX Runtime and ships only its macOS build", () => {
    const matches = universalMinimatch();
    const unpack = asarUnpackPatterns(parsed);
    const archPattern = macX64ArchFiles(parsed);
    // The shared list and the Mac's own, which electron-builder adds to it.
    const macFiles = (parsed.mac as { files?: unknown[] }).files ?? [];
    const exclusions = [...(parsed.files as unknown[]), ...macFiles]
      .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("!"))
      .map((glob) => glob.slice(1));
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies["onnxruntime-node"]).toMatch(/^\d/);
    const bin = "node_modules/onnxruntime-node/bin/napi-v6";
    for (const file of ["onnxruntime_binding.node", "libonnxruntime.dylib"]) {
      const packed = `${bin}/darwin/arm64/${file}`;
      expect(
        unpack.some((glob) => matches(packed, glob)),
        `${packed} must be unpacked`,
      ).toBe(true);
      expect(
        exclusions.some((glob) => matches(packed, glob)),
        `${packed} must ship`,
      ).toBe(false);
      expect(
        matches(`Contents/Resources/app.asar.unpacked/${packed}`, archPattern),
        `${packed} must match x64ArchFiles`,
      ).toBe(true);
    }
    for (const other of ["linux/x64/libonnxruntime.so.1", "win32/arm64/onnxruntime.dll"]) {
      expect(
        exclusions.some((glob) => matches(`${bin}/${other}`, glob)),
        `${other} must be excluded by files`,
      ).toBe(true);
    }
  });

  /**
   * F14 (captain lock 2026-09-20): the app ships no Claude client. A Claude
   * account runs the Claude Code the person installed, so the SDK's
   * platform packages - one ~300 MB binary each, both darwin arches in the
   * universal tree - are excluded from the package outright: not copied,
   * not unpacked, and nothing of theirs for the universal merge to take.
   */
  it("ships no Claude client: every SDK platform package is excluded from the package", () => {
    const names = claudeDarwinAgentSdkPackages();
    expect(names).toEqual([
      "@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "@anthropic-ai/claude-agent-sdk-darwin-x64",
    ]);
    const files = (parsed.files as unknown[]).filter(
      (entry): entry is string => typeof entry === "string",
    );
    const exclusions = files.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
    const matches = universalMinimatch();
    const unpack = asarUnpackPatterns(parsed);
    const archPattern = macX64ArchFiles(parsed);
    for (const name of names) {
      const packedPath = `node_modules/${name}/claude`;
      expect(
        exclusions.some((glob) => matches(packedPath, glob)),
        `${packedPath} must be excluded by files`,
      ).toBe(true);
      expect(
        unpack.some((glob) => matches(packedPath, glob)),
        `${packedPath} must not be unpacked`,
      ).toBe(false);
      const unpackedPath = `Contents/Resources/app.asar.unpacked/${packedPath}`;
      expect(
        matches(unpackedPath, archPattern),
        `${unpackedPath} must not be named by x64ArchFiles`,
      ).toBe(false);
    }
    // The SDK's own JavaScript is what the app imports; only its binaries go.
    expect(
      exclusions.some((glob) =>
        matches("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", glob),
      ),
    ).toBe(false);
  });

  /**
   * Pi 0.87 pulls esbuild through `@earendil-works/chord`, and only the
   * chord bundler entry imports it. A packaged app that keeps the binary
   * unpacks one Mach-O into both universal slices and the merge aborts.
   */
  it("ships no esbuild binary: chord's bundler is not a runtime import", () => {
    const files = (parsed.files as unknown[]).filter(
      (entry): entry is string => typeof entry === "string",
    );
    const exclusions = files.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
    const matches = universalMinimatch();
    const unpack = asarUnpackPatterns(parsed);
    const archPattern = macX64ArchFiles(parsed);
    for (const packedPath of [
      "node_modules/esbuild/bin/esbuild",
      "node_modules/@esbuild/darwin-arm64/bin/esbuild",
      "node_modules/@esbuild/darwin-x64/bin/esbuild",
    ]) {
      expect(
        exclusions.some((glob) => matches(packedPath, glob)),
        `${packedPath} must be excluded by files`,
      ).toBe(true);
      expect(
        unpack.some((glob) => matches(packedPath, glob)),
        `${packedPath} must not be unpacked`,
      ).toBe(false);
      expect(
        matches(`Contents/Resources/app.asar.unpacked/${packedPath}`, archPattern),
        `${packedPath} must not be named by x64ArchFiles`,
      ).toBe(false);
    }
    expect(
      exclusions.some((glob) => matches("node_modules/@earendil-works/chord/dist/index.js", glob)),
    ).toBe(false);
  });

  /**
   * koffi's N-API addon cannot dlopen from inside app.asar. The JS lives
   * in `koffi`; the Mach-O is in `@koromix/koffi-darwin-*`. A universal
   * merge that lists only `koffi` aborts: the platform packages are
   * identical in both slices and must match x64ArchFiles.
   */
  it("unpacks koffi so the host Keychain FFI can load", () => {
    const patterns = asarUnpackPatterns(parsed);
    const matches = universalMinimatch();
    expect(
      patterns.some((glob) => matches("node_modules/koffi/index.js", glob)),
      "node_modules/koffi must match asarUnpack",
    ).toBe(true);
  });

  it("covers koffi's darwin addons so the universal merge can skip-lipo them", () => {
    const pattern = macX64ArchFiles(parsed);
    const matches = universalMinimatch();
    const names = koffiDarwinPackages();
    expect(names).toEqual(["@koromix/koffi-darwin-arm64", "@koromix/koffi-darwin-x64"]);
    const unpack = asarUnpackPatterns(parsed);
    for (const name of names) {
      const arch = name.endsWith("arm64") ? "arm64" : "x64";
      const relativePath = `Contents/Resources/app.asar.unpacked/node_modules/${name}/darwin_${arch}/koffi.node`;
      expect(matches(relativePath, pattern), `${relativePath} must match x64ArchFiles`).toBe(true);
      const packedPath = `node_modules/${name}/darwin_${arch}/koffi.node`;
      expect(
        unpack.some((glob) => matches(packedPath, glob)),
        `${packedPath} must match asarUnpack`,
      ).toBe(true);
    }
  });

  it("signs with the hardened runtime and the team identity", () => {
    const mac = parsed.mac as {
      hardenedRuntime?: unknown;
      identity?: unknown;
      entitlements?: unknown;
    };
    expect(mac.hardenedRuntime).toBe(true);
    expect(mac.identity).toBe("Kun Chen (9T2J7MNUP9)");
    expect(mac.entitlements).toBe("packaging/entitlements.plist");
  });

  it("never lets local signing leak into the release config", () => {
    const mac = parsed.mac as { sign?: unknown };
    expect(mac.sign).toBeUndefined();
    expect(configText).not.toContain("sign-local-mac");
    expect(configText).not.toContain("local-codesign");
  });

  it("ships the self-source tree and self-map.json via extraResources", () => {
    const extra = parsed.extraResources;
    expect(Array.isArray(extra)).toBe(true);
    const entries = (extra as Array<{ from?: unknown; to?: unknown }>).map((entry) => ({
      from: entry.from,
      to: entry.to,
    }));
    expect(entries).toContainEqual({
      from: "packaging/generated/self-source",
      to: "self-source",
    });
    expect(entries).toContainEqual({
      from: "packaging/generated/self-map.json",
      to: "self-map.json",
    });
  });

  it("ships the offline release-notes catalog and its hero pictures beside the self-source tree", () => {
    const entries = (parsed.extraResources as Array<{ from?: unknown; to?: unknown }>).map(
      (entry) => ({ from: entry.from, to: entry.to }),
    );
    expect(entries).toContainEqual({
      from: "packaging/generated/release-notes.json",
      to: "release-notes.json",
    });
    // Resources/release-notes/pictures, where the startup note and verify-package look.
    expect(entries).toContainEqual({
      from: "packaging/generated/release-notes",
      to: "release-notes",
    });
  });

  it("ships the app's own git for both architectures outside the archive, with its search-path directory", () => {
    const entries = (parsed.extraResources as Array<{ from?: unknown; to?: unknown }>).map(
      (entry) => ({ from: entry.from, to: entry.to }),
    );
    expect(entries).toContainEqual({ from: "vendor/git", to: "git" });
    expect(entries).toContainEqual({ from: "vendor/git-bin", to: "git-bin" });
    if (process.platform === "darwin") {
      // `pnpm install` built the launcher there, an executable for both chips
      // (scripts/build-git-launcher.ts).
      expect(statSync(join(root, "vendor/git-bin/git")).mode & 0o111).toBe(0o111);
    }
    const pattern = macX64ArchFiles(parsed);
    const matches = universalMinimatch();
    expect(ARCHES).toEqual(["arm64", "x64"]);
    for (const arch of ARCHES) {
      for (const file of ["bin/git", "libexec/git-core/git-remote-https", "bin/scalar"]) {
        const path = `Contents/Resources/git/darwin-${arch}/${file}`;
        expect(matches(path, pattern), `${path} must match x64ArchFiles`).toBe(true);
      }
    }
    // Nothing else in Resources rides the allowance.
    expect(matches("Contents/Resources/git-bin/git", pattern)).toBe(false);
    expect(matches("Contents/Resources/gitx/darwin-arm64/bin/git", pattern)).toBe(false);
  });

  it("ships the task commands' launcher outside the archive, executable, with each command an identical copy of it", () => {
    // A crewmate's shell runs infinitary-browser-axi by path; a file inside app.asar cannot be run.
    const entries = (parsed.extraResources as Array<{ from?: unknown; to?: unknown }>).map(
      (entry) => ({ from: entry.from, to: entry.to }),
    );
    expect(entries).toContainEqual({ from: "resources/axi-bin", to: "axi-bin" });
    // Copies, not links: a Windows checkout writes a link as a text file, and
    // the build's copy of the source cannot make one there (INF-1238).
    const launcher = readFileSync(join(root, "resources/axi-bin/infinitary-axi"));
    for (const name of [
      // INF-1894's command, which the person runs from any shell of theirs.
      "infinitary-axi",
      "infinitary-browser-axi",
      "infinitary-integrations-axi",
      // INF-2468's files command, which reads a file on another of the captain's computers.
      "infinitary-files-axi",
      // INF-1214's inbox command, now infinitary-axi's old name for one release (INF-1894).
      "infinitary-inbox-axi",
      // INF-1085's command ships even while its production grant remains unavailable.
      "infinitary-secrets-axi",
      // INF-3447 piece 1's stops command, which registers how to stop what a task leaves running.
      "infinitary-stops-axi",
      // Firstmate 3000's name for the command stays, for a crewmate told it before the rename.
      "fm-browser-axi",
    ]) {
      const path = join(root, "resources/axi-bin", name);
      expect(lstatSync(path).isFile(), name).toBe(true);
      expect(statSync(path).mode & 0o111, name).toBe(0o111);
      expect(readFileSync(path).equals(launcher), name).toBe(true);
    }
  });

  it("ships the app's own git helper outside the archive, executable", () => {
    // Git runs GIT_ASKPASS by path; a file inside app.asar cannot be spawned.
    const entries = (parsed.extraResources as Array<{ from?: unknown; to?: unknown }>).map(
      (entry) => ({ from: entry.from, to: entry.to }),
    );
    expect(entries).toContainEqual({ from: "resources/git-askpass", to: "git-askpass" });
    expect(statSync(join(root, "resources/git-askpass")).mode & 0o111).toBe(0o111);
  });
});

describe("local packaging identity (electron-builder.dev.yml)", () => {
  const dev = loadYamlFile("electron-builder.dev.yml");
  const mac = dev.mac as Record<string, unknown>;

  it("keeps the distinct local app identity so it cannot collide with the cask app", () => {
    expect(dev.extends).toBe("./electron-builder.yml");
    expect(dev.appId).toBe("com.getinfinitary.infinitary.dev");
    expect(dev.productName).toBe("Infinitary Dev");
    expect((mac.extendInfo as Record<string, unknown>).CFBundleDisplayName).toBe("Infinitary Dev");
  });

  /**
   * The local package used to be ad-hoc signed, which gave it a designated
   * requirement of `cdhash H"..."` - a new one per rebuild - so the captain's
   * Keychain "Always Allow" died with every build (docs/local-code-signing.md).
   * `identity: "-"` may now survive only as electron-builder's identity
   * DISCOVERY placeholder: it searches with `security find-identity -v`, which
   * lists trusted certificates only, and the local certificate is deliberately
   * untrusted. The `sign` hook is what actually signs.
   */
  it("signs the local package with the local certificate, never ad-hoc", () => {
    expect(mac.sign).toBe("./scripts/sign-local-mac.mjs");
    expect(existsSync(join(root, "scripts", "sign-local-mac.mjs"))).toBe(true);
  });

  /**
   * `sign` and not `afterPack`: electron-builder flips the electron fuses
   * between the universal merge and signing, so anything signed earlier is
   * invalidated by the fuse edit - the reason the overlay re-signed at all.
   */
  /**
   * macOS shows this sentence when it first asks for the microphone
   * (docs/composer.md, "Voice"). electron-builder deep-merges the local
   * config over the one it `extends`, so the local app keeps the release's
   * sentence unless it names its own.
   */
  it("asks for the microphone in our own words, in the release and the local app", () => {
    const release = loadYamlFile("electron-builder.yml").mac as Record<string, unknown>;
    expect((release.extendInfo as Record<string, unknown>).NSMicrophoneUsageDescription).toBe(
      "Infinitary hears you only while you talk to it. What you say becomes text on this computer and is never stored.",
    );
    expect(dev.extends).toBe("./electron-builder.yml");
    expect(mac.extendInfo as Record<string, unknown>).not.toHaveProperty(
      "NSMicrophoneUsageDescription",
    );
  });

  /**
   * macOS shows this sentence if it asks about the local network, which
   * listing Macs nearby uses (docs/devices.md, "Macs nearby"). It is a
   * sentence, not a permission: no Bonjour service list comes with it.
   */
  it("says in our own words why it uses the local network, and asks for nothing more", () => {
    const release = loadYamlFile("electron-builder.yml").mac as Record<string, unknown>;
    const info = release.extendInfo as Record<string, unknown>;
    expect(info.NSLocalNetworkUsageDescription).toBe(
      "Infinitary lists the computers on your network that have Remote Login on, so you can add one, reaches the computers you added, and lets your phone find this Mac.",
    );
    expect(info).not.toHaveProperty("NSBonjourServices");
    expect(mac.extendInfo as Record<string, unknown>).not.toHaveProperty(
      "NSLocalNetworkUsageDescription",
    );
  });

  /**
   * macOS shows this sentence when a crewmate's search reaches another
   * app's data (INF-1217: the captain chose "Build A: fewer searches,
   * explain and record"; docs/macos-privacy.md). Without it macOS shows
   * only its own words, which never say why Infinitary asks.
   */
  it("says in our own words why a search reaches other apps' data, in the release and the local app", () => {
    const release = loadYamlFile("electron-builder.yml").mac as Record<string, unknown>;
    const info = release.extendInfo as Record<string, unknown>;
    expect(info.NSAppDataUsageDescription).toBe(
      "A crewmate's search reached files that another app keeps. Infinitary's work rarely needs them, so Don't Allow is usually fine.",
    );
    expect(mac.extendInfo as Record<string, unknown>).not.toHaveProperty(
      "NSAppDataUsageDescription",
    );
  });

  it("signs after the fuse flip rather than in an earlier hook", () => {
    expect(dev.afterPack).toBeUndefined();
    expect(mac.afterPack).toBeUndefined();
  });

  /**
   * The dev bundle keeps its state beside `pnpm dev`'s, never in the
   * installed release's folder. electron-builder merges `extraMetadata`
   * into the packaged package.json, which main reads back at boot
   * (src/main/userDataDir.ts); scripts/check-user-data-dir.sh proves the
   * built bundle end to end in verify.yml.
   */
  it("stamps the local package as the dev flavor, and only the local package", () => {
    const packageJson = JSON.parse(read("package.json")) as Record<string, unknown>;
    const release = loadYamlFile("electron-builder.yml");
    const packaged = (config: Record<string, unknown>) => () =>
      JSON.stringify({ ...packageJson, ...(config.extraMetadata as object | undefined) });
    expect(packagedFlavor(packaged(dev))).toBe("dev");
    expect(packagedFlavor(packaged(release))).toBe("release");
  });

  it("keeps the local overlay off the hardened runtime and off the release identity", () => {
    expect(mac.hardenedRuntime).toBe(false);
    expect(read("electron-builder.dev.yml")).not.toContain("9T2J7MNUP9");
  });

  it("wires the local signing setup into install, dev, and packaging", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    // `pnpm install` only checks (an install stage never signs,
    // tests/local-codesign.test.ts); `pnpm dev` signs an Electron that a
    // clone, an upgrade or a reinstall left unsigned; `pnpm package:mac`
    // proves what it built.
    expect(scripts.postinstall).toContain("scripts/prepare-local-codesign.mjs");
    expect(scripts.predev).toContain("scripts/prepare-local-codesign.mjs");
    expect(scripts["package:mac"]).toContain("scripts/verify-local-codesign.mjs --packaged");
    expect(scripts["codesign:local"]).toContain("scripts/prepare-local-codesign.mjs");
    expect(scripts["codesign:verify"]).toContain("scripts/verify-local-codesign.mjs");
  });
});

/**
 * The v0.1.0 release signed its universal app and then failed its own
 * signed gate on @koromix/koffi-darwin-x64's koffi.node: electron-builder.yml
 * told the universal merge to keep that tree single-arch, and verify-app.sh
 * kept a second, hand-copied list that did not name it. The gate now has no
 * list of its own - it asks scripts/x64-arch-files.mjs, which reads
 * mac.x64ArchFiles and matches it the way @electron/universal does - so the
 * two cannot diverge. These run the real gate, not its source text.
 */
/**
 * The app's own git as a bundle carries it: each architecture's real `git`
 * from the tree `pnpm install` vendored (scripts/ensure-bundled-git.ts),
 * enough for `git --version`, and the directory that runs it.
 */
function plantAppGit(contents: string): void {
  for (const arch of ARCHES) {
    const bin = join(contents, "Resources", "git", `darwin-${arch}`, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "git"),
      readFileSync(join(root, "vendor", "git", `darwin-${arch}`, "bin", "git")),
    );
    chmodSync(join(bin, "git"), 0o755);
  }
  const shimDir = join(contents, "Resources", "git-bin");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "git"), readFileSync(join(root, "vendor", "git-bin", "git")));
  chmodSync(join(shimDir, "git"), 0o755);
}

describe("verify-app single-arch allowance is mac.x64ArchFiles", () => {
  const unpacked = "Contents/Resources/app.asar.unpacked/node_modules";
  const uncovered = (paths: string[]) =>
    execFileSync("node", [join(root, "scripts", "x64-arch-files.mjs"), "uncovered", ...paths], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

  it("allows exactly what the universal merge was told to keep single-arch", () => {
    const pattern = macX64ArchFiles(loadYamlFile("electron-builder.yml"));
    const matches = universalMinimatch();
    const perArch = [
      // The v0.1.0 failure.
      `${unpacked}/@koromix/koffi-darwin-x64/darwin_x64/koffi.node`,
      `${unpacked}/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node`,
      `${unpacked}/@earendil-works/pi-tui/native/darwin-arm64/pty.node`,
      `${unpacked}/@mariozechner/clipboard-darwin-x64/clipboard.darwin-x64.node`,
      `${unpacked}/better-sqlite3/prebuilds/darwin-arm64/better_sqlite3.node`,
      "Contents/Resources/git/darwin-x64/libexec/git-core/git",
      "Contents/Resources/git/darwin-arm64/bin/git",
    ];
    const mustBeUniversal = [
      "Contents/MacOS/Infinitary",
      "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      "Contents/Frameworks/Infinitary Helper.app/Contents/MacOS/Infinitary Helper",
      `${unpacked}/better-sqlite3/build/Release/better_sqlite3.node`,
      // F14: no Claude client ships, so none may pass as single-arch.
      `${unpacked}/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
    ];
    // One run of the gate answers for every path, each judged on its own.
    const all = [...perArch, ...mustBeUniversal];
    const left = uncovered(all);
    expect(left).toEqual(mustBeUniversal);
    for (const path of all) {
      expect(!left.includes(path), path).toBe(matches(path, pattern));
    }
  });

  const darwin = process.platform === "darwin";

  /**
   * A bundle shaped like the release's: a universal main executable (lipo'd
   * from koffi's two real addons) and koffi's two single-arch addons exactly
   * where electron-builder unpacks them.
   */
  function fixtureApp(): string {
    const app = join(scratchDir("infinitary-verify-app-"), "Infinitary.app");
    const contents = join(app, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });
    writeFileSync(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.getinfinitary.infinitary</string>
<key>CFBundleExecutable</key><string>Infinitary</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
</dict></plist>
`,
    );
    writeFileSync(join(contents, "Resources", "app.asar"), "");
    // The app's own git helper ships outside the archive, executable.
    const askpass = join(contents, "Resources", "git-askpass");
    writeFileSync(askpass, readFileSync(join(root, "resources", "git-askpass")));
    chmodSync(askpass, 0o755);
    plantAppGit(contents);
    const koffi = createRequire(require.resolve("koffi"));
    const addons: string[] = [];
    for (const name of koffiDarwinPackages()) {
      const arch = name.endsWith("arm64") ? "arm64" : "x64";
      const source = join(dirname(koffi.resolve(`${name}/package.json`)), `darwin_${arch}`);
      const target = join(contents, "Resources", "app.asar.unpacked", "node_modules", name);
      mkdirSync(join(target, `darwin_${arch}`), { recursive: true });
      const addon = join(target, `darwin_${arch}`, "koffi.node");
      writeFileSync(addon, readFileSync(join(source, "koffi.node")));
      addons.push(addon);
    }
    const main = join(contents, "MacOS", "Infinitary");
    execFileSync("lipo", ["-create", ...addons, "-output", main]);
    chmodSync(main, 0o755);
    return app;
  }

  const verifyApp = (app: string) =>
    spawnSync(join(root, "scripts", "verify-app.sh"), [app], { encoding: "utf8" });

  it.skipIf(!darwin)(
    "passes a universal bundle carrying koffi's single-arch addons, the app's two gits and their two-chip launcher",
    () => {
      const result = verifyApp(fixtureApp());
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("6 Mach-O files, 4 single-arch under mac.x64ArchFiles");
      expect(result.stdout).toMatch(/, git version \d+\.\d+\.\d+\)$/m);
    },
  );

  it.skipIf(!darwin)("fails a bundle missing one architecture's git, naming it", () => {
    const app = fixtureApp();
    rmSync(join(app, "Contents/Resources/git/darwin-x64"), { recursive: true });
    const result = verifyApp(app);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "the app's git for x64 (Contents/Resources/git/darwin-x64/bin/git) is missing or not executable",
    );
  });

  it.skipIf(!darwin)("fails a bundle whose git is the wrong architecture", () => {
    const app = fixtureApp();
    const resources = join(app, "Contents/Resources/git");
    writeFileSync(
      join(resources, "darwin-x64/bin/git"),
      readFileSync(join(resources, "darwin-arm64/bin/git")),
    );
    const result = verifyApp(app);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the app's git for x64 is not a x86_64 Mach-O");
  });

  it.skipIf(!darwin)("fails a bundle without the directory that runs the app's git", () => {
    const app = fixtureApp();
    rmSync(join(app, "Contents/Resources/git-bin"), { recursive: true });
    const result = verifyApp(app);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "the app's git directory (Contents/Resources/git-bin/git) is missing or not executable",
    );
  });

  it.skipIf(!darwin)(
    "fails a bundle whose git launcher is a script, not a program for both chips",
    () => {
      // INF-2173: macOS 26 keeps a kernel buffer for every #! script a
      // script-started tool runs, so the launcher ships compiled.
      const app = fixtureApp();
      const launcher = join(app, "Contents/Resources/git-bin/git");
      writeFileSync(launcher, '#!/bin/sh\nexec "$INFINITARY_GIT_DIR/bin/git" "$@"\n');
      chmodSync(launcher, 0o755);
      const result = verifyApp(app);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "the app's git launcher (Contents/Resources/git-bin/git) is not a program for both arm64 and x86_64",
      );
    },
  );

  it.skipIf(!darwin)(
    "fails a single-arch Mach-O outside mac.x64ArchFiles, naming it, with no broken-pipe noise",
    () => {
      const app = fixtureApp();
      const stray = join(app, "Contents", "Frameworks", "stray.dylib");
      mkdirSync(dirname(stray), { recursive: true });
      const koffi = join(
        app,
        "Contents/Resources/app.asar.unpacked/node_modules/@koromix/koffi-darwin-x64/darwin_x64/koffi.node",
      );
      writeFileSync(stray, readFileSync(koffi));
      const result = verifyApp(app);
      expect(result.status).toBe(1);
      expect(result.stderr.trim().split("\n")).toEqual([
        expect.stringMatching(
          /^verify-app: single-arch Mach-O outside mac\.x64ArchFiles: .*\/Contents\/Frameworks\/stray\.dylib \(Mach-O 64-bit .*x86_64\)$/,
        ),
        "verify-app: FAIL: Mach-O missing an arm64 or x86_64 slice outside mac.x64ArchFiles (electron-builder.yml)",
      ]);
    },
  );
});

describe("verify-app and the git helper", () => {
  it.skipIf(process.platform !== "darwin")(
    "fails a bundle whose git helper is missing or not executable",
    () => {
      const app = join(scratchDir("infinitary-verify-askpass-"), "Infinitary.app");
      const contents = join(app, "Contents");
      mkdirSync(join(contents, "MacOS"), { recursive: true });
      mkdirSync(join(contents, "Resources"), { recursive: true });
      writeFileSync(
        join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.getinfinitary.infinitary</string>
<key>CFBundleExecutable</key><string>Infinitary</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
</dict></plist>
`,
      );
      writeFileSync(join(contents, "Resources", "app.asar"), "");
      const main = join(contents, "MacOS", "Infinitary");
      writeFileSync(main, "#!/bin/sh\n");
      chmodSync(main, 0o755);
      const askpass = join(contents, "Resources", "git-askpass");
      writeFileSync(askpass, readFileSync(join(root, "resources", "git-askpass")));
      chmodSync(askpass, 0o644);
      const result = spawnSync(join(root, "scripts", "verify-app.sh"), [app], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "the git helper (Contents/Resources/git-askpass) is missing or not executable",
      );
    },
  );
});

describe("entitlements", () => {
  it("allows exactly jit and microphone, nothing else", () => {
    const plist = read("packaging/entitlements.plist");
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
    expect(keys.sort()).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.device.audio-input",
    ]);
    expect(plist.match(/<true\/>/g)).toHaveLength(2);
    expect(plist).not.toContain("<false/>");
  });
});

describe("the signed channel workflow", () => {
  it.skipIf(process.platform !== "darwin")(
    "refuses a bundle whose version fields are not the release's numeric core, before launching it",
    () => {
      const standIn = (short: string, build: string) => {
        const app = join(scratchDir("infinitary-launch-gate-"), "Infinitary.app");
        mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
        const entries = { CFBundleShortVersionString: short, CFBundleVersion: build };
        writeFileSync(
          join(app, "Contents", "Info.plist"),
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<plist version="1.0"><dict>',
            ...Object.entries({ ...entries, CFBundleExecutable: "never-launched" }).map(
              ([key, value]) => `<key>${key}</key><string>${value}</string>`,
            ),
            "</dict></plist>",
          ].join("\n"),
        );
        return app;
      };
      const gate = (app: string, version: string) =>
        spawnSync(join(root, "scripts", "check-app-launch.sh"), [app, version], {
          encoding: "utf8",
        });
      for (const [app, version, reason] of [
        [
          standIn("0.1.25-alpha.7", "0.1.25"),
          "0.1.25-alpha.7",
          "CFBundleShortVersionString is 0.1.25-alpha.7, not 0.1.25",
        ],
        [standIn("0.1.25", "0.1.24"), "0.1.25-alpha.7", "CFBundleVersion is 0.1.24, not 0.1.25"],
        [standIn("0.1.25", "0.1.25"), "0.1.25-beta.1", "neither X.Y.Z nor X.Y.Z-alpha.N"],
      ] as const) {
        const result = gate(app, version);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(reason);
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "stops the launched app and everything writing into its profile before removing the profile",
    { timeout: 50_000 },
    async () => {
      // INF-1768: stable 0.6.1's publication stopped after this gate printed
      // OK, when removing its throwaway profile raced processes the app had
      // started that were still writing into it ("Directory not empty").
      // The stand-in is Electron's own process tree with the app's quit
      // shape and a child that outlives it (tests/fixtures/launch-gate-app).
      const { app, version } = launchGateApp();
      const profiles = scratchDir("infinitary-launch-gate-profiles-");
      const home = scratchDir("infinitary-launch-gate-home-");
      const witness = scratchDir("infinitary-launch-gate-witness-");
      const gate = await runGate(join(root, "scripts", "check-app-launch.sh"), [app, version], {
        ...process.env,
        TMPDIR: profiles,
        HOME: home,
        CFFIXED_USER_HOME: home,
        LAUNCH_GATE_WITNESS: witness,
      });
      const running = stopLeftovers(witness);
      expect(readdirSync(witness).sort()).toEqual(["app.pid", "child.pid"]);
      expect(gate.status, gate.stderr).toBe(0);
      expect(gate.stdout).toContain(`the running app reports ${version}`);
      expect(running).toEqual([]);
      expect(readdirSync(profiles)).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "stops the app and every process it started before removing the data-folder check's home",
    { timeout: 50_000 },
    async () => {
      // INF-2110: alpha 0.6.2-alpha.46's Mac lane failed after the
      // data-folder check printed OK, when removing its throwaway home raced
      // processes the app had started that were still writing into it
      // ("Directory not empty"). Besides the launch gate's child, the
      // stand-in starts one in a session of its own that names the home only
      // in its environment, as the core starts the login shell.
      const { app } = launchGateApp();
      const homes = scratchDir("infinitary-data-folder-homes-");
      const witness = scratchDir("infinitary-data-folder-witness-");
      const check = await runGate(
        join(root, "scripts", "check-user-data-dir.sh"),
        [app, "launch-gate-app"],
        {
          ...process.env,
          TMPDIR: homes,
          LAUNCH_GATE_WITNESS: witness,
          LAUNCH_GATE_DETACHED_CHILD: "1",
        },
      );
      const running = stopLeftovers(witness);
      expect(readdirSync(witness).sort()).toEqual(["app.pid", "child.pid", "detached.pid"]);
      expect(check.status, check.stderr).toBe(0);
      expect(check.stdout).toContain("Infinitary.app opens <appData>/launch-gate-app");
      expect(running).toEqual([]);
      expect(readdirSync(homes)).toEqual([]);
    },
  );
});

/**
 * The release gates' stand-in app (tests/fixtures/launch-gate-app) in a
 * packaged app's shape: Electron's own bundle with the fixture as its app,
 * both bundle version fields its version's numeric core.
 */
function launchGateApp(): { app: string; version: string } {
  const fixture = join(root, "tests", "fixtures", "launch-gate-app");
  const version: string = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8")).version;
  const app = join(scratchDir("infinitary-launch-gate-"), "Infinitary.app");
  cpSync(join(dirname(electronBinary()), "..", ".."), app, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  cpSync(fixture, join(app, "Contents", "Resources", "app"), { recursive: true });
  const core = version.split("-")[0];
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :CFBundleShortVersionString ${core}`,
    "-c",
    `Set :CFBundleVersion ${core}`,
    join(app, "Contents", "Info.plist"),
  ]);
  return { app, version };
}

/** A release gate's run to its end, with what it printed. */
function runGate(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const run = spawn(script, args, { env });
    let stdout = "";
    let stderr = "";
    run.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    run.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    run.on("error", reject);
    run.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * The stand-in's processes a gate left running, by the process ids they
 * wrote into the witness folder. Each is stopped here, so a failure leaves
 * nothing behind.
 */
function stopLeftovers(witness: string): number[] {
  const running = readdirSync(witness)
    .map((name) => Number(readFileSync(join(witness, name), "utf8")))
    .filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  for (const pid of running) process.kill(pid, "SIGKILL");
  return running;
}

/** A valid checksum: the generator refuses anything but 64 lowercase hex digits. */
const CASK_SHA256 = "ab".repeat(32);

/**
 * The generator's environment for one cask: exactly the fields given. A
 * shell that exports CHANNEL and VERSION, as the release workflow's signing
 * job does for its own steps, must not let the ambient cask inputs ride along.
 */
function generatorEnv(fields: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["CHANNEL", "VERSION", "SHA256", "DOWNLOAD_URL"]) delete env[name];
  return { ...env, ...fields };
}

describe("homebrew cask", () => {
  // The workflow's own interface: no CHANNEL, so the default stable cask.
  const cask = execFileSync(join(root, "scripts", "generate-cask.sh"), {
    env: generatorEnv({
      VERSION: "1.2.3",
      SHA256: CASK_SHA256,
      DOWNLOAD_URL:
        "https://github.com/infinitary-labs/homebrew-tap/releases/download/infinitary-v1.2.3/Infinitary-1.2.3-universal.zip",
    }),
  }).toString();

  it("carries the D-15 naming and the release artifact", () => {
    expect(cask).toContain('cask "infinitary" do');
    expect(cask).toContain('version "1.2.3"');
    expect(cask).toContain('app "Infinitary.app"');
    expect(cask).toContain('uninstall quit: "com.getinfinitary.infinitary"');
    expect(cask).toContain("depends_on macos:");
    expect(cask).toContain('conflicts_with cask: "infinitary@alpha"');
  });

  it("quits and zaps the bundle electron-builder builds", () => {
    expect(BUNDLE_ID).toBe(loadYamlFile("electron-builder.yml").appId);
  });

  it("zaps the app's real on-disk paths", () => {
    // Electron's userData is the package.json name, not the productName
    // (src/shared/userDataFolders.ts); the dev flavor's folder is not the
    // cask's to remove.
    expect(cask).toContain('"~/Library/Application Support/infinitary"');
    expect(cask).not.toContain("infinitary-dev");
    expect(cask).toContain('"~/Library/Preferences/com.getinfinitary.infinitary.plist"');
  });
});

describe("the private alpha (roadmap 1.2)", () => {
  // The product repository is private through the beta gate; the cask's
  // artifact is a release on the public tap itself, under the app-prefixed
  // tag, where Homebrew fetches it without a credential (docs/alpha.md).
  const PUBLIC_URL =
    "https://github.com/infinitary-labs/homebrew-tap/releases/download/infinitary-v1.2.3/Infinitary-1.2.3-universal.zip";
  const notice = read("packaging/alpha-notice.txt").trim();

  function generate(downloadUrl: string, channel?: string, version = "1.2.3"): string {
    return execFileSync(join(root, "scripts", "generate-cask.sh"), {
      env: generatorEnv({
        VERSION: version,
        SHA256: CASK_SHA256,
        DOWNLOAD_URL: downloadUrl,
        ...(channel && { CHANNEL: channel }),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  }
  const ALPHA_URL =
    "https://github.com/infinitary-labs/homebrew-tap/releases/download/infinitary-alpha-v1.2.4-alpha.7/Infinitary-1.2.4-alpha.7-universal.zip";
  // The workflow's interface writes each channel's cask once; the
  // generator's rules run in-process through the producer the wrapper calls
  // (each wrapper run starts Node and Vite, about a second on hosted Linux).
  const stableCask = generate(PUBLIC_URL);
  const alphaCask = generate(ALPHA_URL, "alpha", "1.2.4-alpha.7");
  const render = (downloadUrl: string, channel: "stable" | "alpha" = "stable", version = "1.2.3") =>
    renderCask(channel, { version, sha256: CASK_SHA256, downloadUrl }, notice);

  it("refuses a download URL on the private product repository, a foreign host, or another release on the tap", () => {
    for (const url of [
      // The private product repository.
      "https://github.com/infinitary-labs/infinitary/releases/download/v1.2.3/Infinitary-1.2.3-universal.zip",
      // A foreign host.
      "https://example.com/Infinitary-1.2.3-universal.zip",
      "https://example.com/infinitary-labs/homebrew-tap/releases/download/infinitary-v1.2.3/Infinitary-1.2.3-universal.zip",
      // The tap, but not this app's release of this version.
      "https://github.com/infinitary-labs/homebrew-tap/archive/infinitary-v1.2.3.zip",
      "https://github.com/infinitary-labs/homebrew-tap/releases/download/v1.2.3/Infinitary-1.2.3-universal.zip",
      "https://github.com/infinitary-labs/homebrew-tap/releases/download/other-tool-v1.2.3/Infinitary-1.2.3-universal.zip",
      "https://github.com/infinitary-labs/homebrew-tap/releases/download/infinitary-v1.2.2/Infinitary-1.2.3-universal.zip",
      // The retired separate releases repository.
      "https://github.com/infinitary-labs/infinitary-releases/releases/download/v1.2.3/Infinitary-1.2.3-universal.zip",
    ]) {
      expect(() => render(url), url).toThrow(/public release asset/);
    }
    // The workflow's wrapper refuses the same way, before printing a cask.
    expect(() =>
      generate(
        "https://github.com/infinitary-labs/infinitary/releases/download/v1.2.3/Infinitary-1.2.3-universal.zip",
      ),
    ).toThrow(/public release asset/);
    // The URL is written with Homebrew's version interpolation and reads back exact.
    expect(stableCask).toContain(
      'url "https://github.com/infinitary-labs/homebrew-tap/releases/download/infinitary-v#{version}/Infinitary-#{version}-universal.zip"',
    );
  });

  it("writes the alpha cask on request, and refuses what neither channel carries", () => {
    expect(alphaCask).toContain('cask "infinitary@alpha" do');
    expect(alphaCask).toContain('conflicts_with cask: "infinitary"');
    expect(alphaCask).toContain(String.raw`"{\"schemaVersion\":1,\"channel\":\"alpha\"}\n",`);
    // The alpha cask may carry the stable artifact handed to it.
    expect(render(PUBLIC_URL, "alpha")).toContain('cask "infinitary@alpha" do');
    // Stable never carries an alpha version; an alpha version lives only under its own tag.
    expect(() => render(ALPHA_URL, "stable", "1.2.4-alpha.7")).toThrow(/not a stable version/);
    expect(() =>
      render(ALPHA_URL.replaceAll("infinitary-alpha-v", "infinitary-v"), "alpha", "1.2.4-alpha.7"),
    ).toThrow(/public release asset/);
    // What only the wrapper reads: the channel and checksum from the environment.
    expect(() => generate(PUBLIC_URL, "beta")).toThrow(/not stable or alpha/);
    expect(() =>
      execFileSync(join(root, "scripts", "generate-cask.sh"), {
        env: generatorEnv({ VERSION: "1.2.3", SHA256: "abc123", DOWNLOAD_URL: PUBLIC_URL }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow(/sha256/);
  });

  // The captain's site address (FI3-1780's question 4, INF-12): every cask,
  // on Infinitary's tap and Firstmate 3000's, links to Infinitary's website,
  // never a repository.
  it("points the cask's homepage at Infinitary's website, never a repository", () => {
    const oldCask = renderCask(
      "stable",
      {
        version: "1.2.3",
        sha256: CASK_SHA256,
        downloadUrl: `https://github.com/${FIRSTMATE_TAP.repo}/releases/download/${FIRSTMATE_TAP.stableTagPrefix}1.2.3/Infinitary-1.2.3-universal.zip`,
      },
      notice,
      FIRSTMATE_TAP,
    );
    for (const cask of [stableCask, alphaCask, oldCask]) {
      expect(/^ {2}homepage "([^"]*)"$/m.exec(cask)?.[1]).toBe(HOMEPAGE);
    }
    expect(HOMEPAGE).toMatch(/^https:\/\/getinfinitary\.com\/$/);
  });

  it("carries the one-paragraph alpha notice as the cask's caveats, before the channel paragraph", () => {
    for (const cask of [stableCask, alphaCask]) {
      const caveats = /caveats <<~EOS\n([\s\S]*?)\n {2}EOS/.exec(cask)?.[1] ?? "";
      const [first, ...channel] = caveats.split("\n\n");
      // Folded for the terminal, but the same words in the same order.
      expect((first ?? "").replace(/\s+/g, " ").trim()).toBe(notice.replace(/\s+/g, " "));
      expect(channel.join(" ")).toMatch(/This is the (stable|alpha) channel/);
      // Approved company-operator wording: people reading either cask see
      // the company, not its founder, and the product's feedback channel.
      const disclosure = (first ?? "").replace(/\s+/g, " ").trim();
      expect(disclosure).toContain("so Infinitary Labs, Inc. can see");
      expect(disclosure).toMatch(
        /Feedback is welcome on Discord: https:\/\/discord\.gg\/Wsy2NpnZDu$/,
      );
    }
    expect(notice).toMatch(/^Infinitary is in private alpha/);
    expect(notice).toContain("no warranty");
    // Diagnostics is disclosed - the events, the install ID and its reset -
    // with its opt-out (docs/sharing.md).
    expect(notice).toContain(
      "the app opening, a first mate turn finishing or failing, and how far first-time setup has come",
    );
    // A paired phone's events go through its computer (INF-2631, the captain:
    // "update the notice, Settings summary, alpha notice and draft terms").
    expect(notice).toContain(
      "from an iPhone or iPad paired to it, the phone app opening, being set up, sending a message and answering a card",
    );
    expect(notice).toContain(
      "a random install ID that is tied to nothing about you and resets whenever Diagnostics is turned off and back on",
    );
    expect(notice).toContain("never anything you typed");
    expect(notice).toContain("the Diagnostics switch in Settings turns it off");
    expect(notice).toContain("license follow at the public beta");
    // The rendered disclosure above keeps the feedback invite at the end,
    // with no trailing punctuation riding into the link.
  });

  const brew = (() => {
    try {
      execFileSync("brew", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!brew)(
    "passes Homebrew's own style cops (the real consumer's read of both casks)",
    () => {
      // Homebrew reads a file as a cask by its place under Casks/, as in the tap.
      const dir = join(scratchDir("infinitary-cask-"), "Casks");
      mkdirSync(dir);
      const stable = join(dir, "infinitary.rb");
      const alpha = join(dir, "infinitary@alpha.rb");
      writeFileSync(stable, stableCask);
      writeFileSync(alpha, alphaCask);
      expect(() =>
        execFileSync("brew", ["style", "--except-cops=Cask/InstallSteps", stable, alpha], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
        }),
      ).not.toThrow();
    },
    180_000,
  );
});

describe("update indicator alignment", () => {
  it("points each channel's upgrade command at the cask the generator writes for it", () => {
    for (const [channel, version] of [
      ["stable", "1.2.3"],
      ["alpha", "1.2.4-alpha.7"],
    ] as const) {
      const target = buildUpdateTarget({
        version,
        assetName: `Infinitary-${version}-universal.zip`,
        sha256: CASK_SHA256,
        sourceCommit: "c".repeat(40),
      });
      const cask = execFileSync(join(root, "scripts", "generate-cask.sh"), {
        env: generatorEnv({
          CHANNEL: channel,
          VERSION: version,
          SHA256: target.sha256,
          DOWNLOAD_URL: target.downloadUrl,
        }),
      }).toString();
      const token = /^cask "([^"]+)" do$/m.exec(cask)?.[1];
      expect(token).toBe(CASK_TOKENS[channel]);
      // INF-1913: the offered command must name the tap as well as the generated
      // cask, so pre-trust installations can upgrade on Homebrew 6 and later.
      expect(upgradeCommandFor(channel)).toBe(
        `brew update && brew upgrade --cask ${TAP.tap}/${token}`,
      );
      // The download the cask carries, version interpolated as Homebrew
      // reads it, is the target the update reader accepts for that channel.
      const url = (/^ {2}url "([^"]+)"$/m.exec(cask)?.[1] ?? "").replaceAll("#{version}", version);
      expect(url).toBe(target.downloadUrl);
      expect(targetProblem(channel, target)).toBeNull();
    }
  });
});

describe("the Linux packages", () => {
  const linuxConfig = loadYamlFile("electron-builder.linux.yml");
  const linux = linuxConfig.linux as {
    target: Array<{ target: string; arch: string[] }>;
    executableName: string;
    executableArgs: unknown;
    asarUnpack: string[];
    files: string[];
    desktop: { entry: Record<string, string> };
  };
  const pkgbuild = read("packaging/linux/aur/PKGBUILD.in");
  const nix = read("packaging/linux/nix/package.nix.in");

  it("extends the release configuration and publishes nothing", () => {
    expect(linuxConfig.extends).toBe("./electron-builder.yml");
    expect(linuxConfig.publish).toBeUndefined();
    expect(loadYamlFile("electron-builder.yml").publish).toBeNull();
    expect(linuxConfig.appId).toBeUndefined();
  });

  it("builds an Ubuntu package, a Fedora package and an AppImage for x64 only", () => {
    expect(linux.target).toEqual([
      { target: "deb", arch: ["x64"] },
      { target: "rpm", arch: ["x64"] },
      { target: "AppImage", arch: ["x64"] },
    ]);
  });

  it("installs to a folder whose path holds no space, so Chromium's sandbox helper runs", () => {
    expect(linuxConfig.productName).toBe("infinitary");
    expect(linux.executableName).toBe("infinitary");
    expect(linux.desktop.entry.Name).toBe("Infinitary");
    expect(linux.desktop.entry.Exec).toBeUndefined();
  });

  // FI3-1780 step 10: Infinitary's packages take Firstmate 3000's place, and
  // the rpm makes its links again once the obsoleted package is gone.
  it("replaces, conflicts with and provides Firstmate 3000's package", () => {
    for (const format of ["deb", "rpm"]) {
      const fpm = (linuxConfig[format] as { fpm: string[] }).fpm;
      expect(fpm, format).toEqual(
        expect.arrayContaining([
          "--replaces=firstmate-3000",
          "--conflicts=firstmate-3000",
          "--provides=firstmate-3000",
        ]),
      );
    }
    expect((linuxConfig.rpm as { fpm: string[] }).fpm.join(" ")).toContain("--rpm-posttrans");
  });

  it("keeps Chromium's sandbox on in every package and desktop entry", () => {
    expect(linux.executableArgs).toEqual([]);
    // electron-builder's AppImage default is --no-sandbox; the empty list replaces it.
    expect((linuxConfig.appImage as { executableArgs: unknown }).executableArgs).toEqual([]);
    for (const text of [read("electron-builder.linux.yml"), pkgbuild, nix]) {
      expect(text.split("\n").filter((line) => !line.trim().startsWith("#"))).not.toEqual(
        expect.arrayContaining([expect.stringContaining("--no-sandbox")]),
      );
    }
  });

  it("requires the system's git in every package that can, and the Nix package wraps its own", () => {
    for (const format of ["deb", "rpm"]) {
      expect((linuxConfig[format] as { depends: string[] }).depends, format).toContain("git");
    }
    expect(/^depends=\(([^)]*)\)/m.exec(pkgbuild)?.[1]?.split(/\s+/)).toContain("'git'");
    expect(nix).toMatch(/--prefix PATH : \$\{\s*lib\.makeBinPath \[\s*git\b/);
  });

  it("ships only Linux x64's speech library and unpacks koffi's Linux addon", () => {
    const matches = universalMinimatch();
    const bin = "node_modules/onnxruntime-node/bin/napi-v6";
    const shared = loadYamlFile("electron-builder.yml").files as string[];
    const exclusions = [...shared, ...linux.files]
      .filter((glob) => glob.startsWith("!"))
      .map((glob) => glob.slice(1));
    const excluded = (path: string) => exclusions.some((glob) => matches(path, glob));
    expect(excluded(`${bin}/linux/x64/libonnxruntime.so.1`)).toBe(false);
    for (const other of ["linux/arm64", "darwin/arm64", "win32/x64"]) {
      expect(excluded(`${bin}/${other}/onnxruntime_binding.node`), other).toBe(true);
    }
    expect(
      linux.asarUnpack.some((glob) =>
        matches("node_modules/@koromix/koffi-linux-x64/koffi.node", glob),
      ),
    ).toBe(true);
  });

  it("renders the Arch recipe and the Nix package for each channel from the Ubuntu package", async () => {
    const { renderRecipes, tapUrl } = await import("../scripts/linux-recipes.ts");
    const sha256 = "ab".repeat(32);
    const render = (version: string) => {
      const debName = `infinitary-${version}-linux-amd64.deb`;
      return renderRecipes({ version, debName, sha256, url: tapUrl(version, debName) });
    };
    const alpha = render("0.4.0-alpha.3");
    expect(alpha.pkgbuild).toMatch(/^pkgname=infinitary-alpha-bin$/m);
    expect(alpha.pkgbuild).toMatch(/^pkgver=0\.4\.0_alpha\.3$/m);
    expect(alpha.pkgbuild).toMatch(
      /^conflicts=\('infinitary' 'firstmate-3000' 'infinitary-bin'\)$/m,
    );
    expect(alpha.pkgbuild).toMatch(/^replaces=\('firstmate-3000' 'firstmate-3000-alpha-bin'\)$/m);
    expect(alpha.pkgbuild).toContain(
      buildDownloadUrl(
        "0.4.0-alpha.3",
        "infinitary-0.4.0-alpha.3-linux-amd64.deb",
        PUBLIC_RELEASE_NAMES,
      ),
    );
    expect(alpha.pkgbuild).toContain(`sha256sums=('${sha256}')`);
    expect(alpha.nix).toContain('pname = "infinitary-alpha";');
    expect(alpha.nix).toContain(
      `hash = "sha256-${Buffer.from(sha256, "hex").toString("base64")}";`,
    );
    const stable = render("0.4.0");
    expect(stable.pkgbuild).toMatch(/^pkgname=infinitary-bin$/m);
    expect(stable.pkgbuild).toMatch(
      /^conflicts=\('infinitary' 'firstmate-3000' 'infinitary-alpha-bin'\)$/m,
    );
    expect(stable.pkgbuild).toMatch(/^replaces=\('firstmate-3000' 'firstmate-3000-bin'\)$/m);
    expect(stable.nix).toContain('pname = "infinitary";');
    for (const rendered of [alpha.pkgbuild, alpha.nix, stable.pkgbuild, stable.nix]) {
      expect(rendered).not.toMatch(/@[A-Z0-9]+@/);
    }
    expect(() =>
      renderRecipes({ version: "0.4.0", debName: "a.deb", sha256, url: "http://x/a.deb" }),
    ).toThrow(/https/);
  });

  // The captain's site address (FI3-1780's question 4, INF-12): every Linux
  // package links to Infinitary's website, as the casks do. electron-builder
  // names the repository, which is private, when the metadata has none.
  it("names Infinitary's website as every package's homepage", async () => {
    const { renderRecipes, tapUrl } = await import("../scripts/linux-recipes.ts");
    const debName = "infinitary-0.4.0-linux-amd64.deb";
    const recipes = renderRecipes({
      version: "0.4.0",
      debName,
      sha256: "ab".repeat(32),
      url: tapUrl("0.4.0", debName),
    });
    expect((linuxConfig.extraMetadata as { homepage?: string }).homepage).toBe(HOMEPAGE);
    expect(/^url="([^"]*)"$/m.exec(recipes.pkgbuild)?.[1]).toBe(HOMEPAGE);
    expect(/^ {4}homepage = "([^"]*)";$/m.exec(recipes.nix)?.[1]).toBe(HOMEPAGE);
  });
});
