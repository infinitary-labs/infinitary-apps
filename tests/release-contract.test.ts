import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import type { PlaywrightTestConfig } from "@playwright/test";
import type {
  JSONReport,
  JSONReportError,
  JSONReportSpec,
  JSONReportTest,
  JSONReportTestResult,
} from "@playwright/test/reporter";
import { describe, expect, it, vi } from "vitest";
import { ALONE_RESULTS } from "../scripts/e2e-alone.ts";
import { ARCHES, manifestEntry } from "../scripts/ensure-bundled-git.ts";
import { MAC_UNIT_FILES } from "../scripts/mac-unit-tests.ts";
import { presentationCommitMessage } from "../src/core/forge";
import { PUBLIC_RELEASE_NAMES, releaseSource } from "../src/core/update/releaseSource";
import { compareSemver, isAlphaVersion } from "../src/core/update/semver";
import { BUNDLE_ID, HOMEPAGE, renderCask } from "../src/core/update/tapPublication";
import {
  buildDownloadUrl,
  buildUpdateTarget,
  CASK_TOKENS,
  FIRSTMATE_TAP,
  publicTagFor,
  targetProblem,
  upgradeCommandFor,
} from "../src/core/update/updateChannels";
import { packagedFlavor } from "../src/main/userDataDir";
import vitestConfig from "../vitest.config";
import { MAC_ONLY_TAG } from "./e2e/tags.ts";
import { electronBinary } from "./helpers/electronBundle";
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

/** YAML parser electron-builder uses for electron-builder.yml. */
function loadYamlFile(path: string): Record<string, unknown> {
  const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml") as {
    load: (input: string) => unknown;
  };
  const parsed = yaml.load(read(path));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} did not parse as a mapping`);
  }
  return parsed as Record<string, unknown>;
}

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
    expect(entries).toContainEqual({ from: "resources/git-bin", to: "git-bin" });
    expect(statSync(join(root, "resources/git-bin/git")).mode & 0o111).toBe(0o111);
    const pattern = macX64ArchFiles(parsed);
    const matches = universalMinimatch();
    expect(ARCHES).toEqual(["arm64", "x64"]);
    for (const arch of ARCHES) {
      for (const file of ["bin/git", "libexec/git-core/git-remote-https", "bin/scalar"]) {
        const path = `Contents/Resources/git/darwin-${arch}/${file}`;
        expect(matches(path, pattern), `${path} must match x64ArchFiles`).toBe(true);
      }
    }
    // The package smoke checks the dev bundle's git the way the release gate does.
    expect(read(".github/workflows/verify.yml")).toContain(
      'scripts/check-bundled-git.sh "dist/mac-universal/Infinitary Dev.app"',
    );
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
      "infinitary-axi",
      "infinitary-browser-axi",
      "infinitary-integrations-axi",
      // INF-1214's inbox command, which a person's own script runs.
      "infinitary-inbox-axi",
      // INF-1085's command ships even while its production grant remains unavailable.
      "infinitary-secrets-axi",
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
    expect(read(".github/workflows/verify.yml")).toContain(
      'scripts/check-user-data-dir.sh "dist/mac-universal/Infinitary Dev.app" infinitary-dev',
    );
  });

  /**
   * The app runs work for another Mac with no window (docs/helper.md):
   * scripts/check-helper.sh starts the built app as `<app> work` on the dev
   * bundle in verify.yml and on the signed app in release.yml, and both say
   * how it went.
   */
  it("starts the built app to run work, on the dev bundle and on the signed app", () => {
    expect(read(".github/workflows/verify.yml")).toContain(
      'scripts/check-helper.sh "dist/mac-universal/Infinitary Dev.app"',
    );
    // Each workflow's summary names the stage by its step id.
    expect(read(".github/workflows/verify.yml")).toContain(`helper=\${{ steps.helper.outcome }}`);
    const release = read(".github/workflows/release.yml");
    expect(release).toContain('scripts/check-helper.sh "dist/mac-universal/$APP_NAME"');
    expect(release).toContain(`work-mode=\${{ steps.work-mode.outcome }}`);
  });

  it("keeps the local overlay off the hardened runtime and off the release identity", () => {
    expect(mac.hardenedRuntime).toBe(false);
    expect(read("electron-builder.dev.yml")).not.toContain("9T2J7MNUP9");
  });

  /**
   * electron-builder refuses to sign pull-request builds unless told
   * otherwise, so without the flag the smoke job would build a fuse-flipped
   * app and never re-sign it - the one step that has to work, and the step
   * this overlay exists for.
   */
  it("makes the macOS package smoke really sign, then check what it signed", () => {
    const verify = read(".github/workflows/verify.yml");
    expect(verify).toContain("--config electron-builder.dev.yml");
    expect(verify).toContain('CSC_FOR_PULL_REQUEST: "true"');
    expect(verify).toContain("pnpm codesign:verify");
  });

  /**
   * Captain decision B (2026-09-15, scout fm3000-ci-release-only-s1): the
   * full macOS work is paid for at release time and on demand, never per PR
   * or per push, and never on a schedule. ci.yml is the Linux jobs alone.
   * Decision B was reversed for pull requests in part on 2026-10-08
   * (FI3-1305): journeys.yml runs only the journey files a change can break,
   * on the Mac mini, and never the full suite.
   */
  it("keeps the full macOS work out of PR CI and off any schedule", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/macos|MAC_RUNNER|test:e2e|electron-builder/);

    const verify = read(".github/workflows/verify.yml");
    expect(verify).toContain("workflow_call:");
    expect(verify).toContain("workflow_dispatch:");
    expect(verify).not.toMatch(/^\s*(schedule|pull_request|push):/m);
    expect(verify).toContain("pnpm exec playwright test");
    expect(verify).toContain("pnpm replay:gate");
    expect(verify).toContain("vars.MAC_RUNNER || 'macos-15'");
  });

  it("runs only the affected journeys on a pull request, on the Mac mini", () => {
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      on: { pull_request: unknown; push?: unknown; schedule?: unknown };
      jobs: Record<string, { "runs-on": string; steps: Step[] }>;
    };
    expect(journeys.on).toHaveProperty("pull_request", null);
    expect(journeys.on).not.toHaveProperty("schedule");
    expect(journeys.on).not.toHaveProperty("push");
    const job = journeys.jobs["affected-journeys"];
    // INF-869: run the virtual side on an isolated label without changing shared vars.
    const runner = (requested: string, configured: string) =>
      workflowValue(job?.["runs-on"] ?? "", {
        inputs: { mac_runner: requested },
        vars: { MAC_RUNNER: configured },
      });
    expect(runner("", "mini-mac-any")).toBe("mini-mac-any");
    expect(runner("", "")).toBe("macos-15");
    expect(runner("mini-mac-inf906-019d7865-virtual", "mini-mac-any")).toBe(
      "mini-mac-inf906-019d7865-virtual",
    );
    const runs = (job?.steps ?? []).flatMap((step) => (step.run ? [step.run] : []));
    // The choice comes from the diff, and the suite is never started whole.
    const choices = (journeys.jobs["choose-journeys"]?.steps ?? []).flatMap((step) =>
      step.run ? [step.run] : [],
    );
    expect(choices.some((run) => run.includes("scripts/affected-journeys.ts"))).toBe(true);
    expect(runs.join("\n")).not.toMatch(/test:e2e|e2e-alone|replay:gate|electron-builder/);
    expect(runs.some((run) => /playwright test --no-deps \$ONLY \$FILES/.test(run))).toBe(true);
  });

  /**
   * The captain's principle of 2026-10-28 (INF-1763, docs/principles.md): a
   * test runs on the Mac only when it needs a Mac. A pull request's Mac job,
   * a request for journeys and a requested full check run only the tests
   * tagged MAC_ONLY_TAG, since Linux runs every other one; the nightly check
   * and every alpha run every journey there, and a request can ask for every
   * named journey.
   */
  it("runs on the Mac only the tests that need a Mac, except in an alpha or when asked for all", () => {
    type Job = { if?: string; steps: Step[] };
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      on: { workflow_dispatch: { inputs: Record<string, { default?: unknown }> } };
      jobs: Record<string, Job>;
    };
    expect(journeys.on.workflow_dispatch.inputs.mac_all?.default).toBe(false);
    const mac = journeys.jobs["affected-journeys"]?.steps.find((step) => step.id === "e2e");
    const only = (inputs: Record<string, unknown>) =>
      workflowString(mac?.env?.ONLY ?? "", { inputs });
    // A pull request has no inputs; a request names its files and may ask for all.
    expect(only({})).toBe(`--grep ${MAC_ONLY_TAG}`);
    expect(only({ files: "window-wash", mac_all: false })).toBe(`--grep ${MAC_ONLY_TAG}`);
    expect(only({ files: "window-wash", mac_all: true })).toBe("");
    for (const command of (mac?.run ?? "")
      .split("\n")
      .filter((line) => /playwright test/.test(line)))
      expect(command).toMatch(/--no-deps \$ONLY \$FILES$/);
    // The chooser puts every chosen file on the Mac only when the request asks.
    const select = journeys.jobs["choose-journeys"]?.steps.find((step) => step.id === "select");
    expect(select?.run).toContain("scripts/journey-budget.ts");
    expect(select?.run).toContain("$EVERY");
    const every = (inputs: Record<string, unknown>) =>
      workflowString(select?.env?.EVERY ?? "", { inputs });
    expect([every({}), every({ mac_all: false }), every({ mac_all: true })]).toEqual([
      "",
      "",
      "--every-on-mac",
    ]);

    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      on: Record<
        "workflow_call" | "workflow_dispatch",
        { inputs: Record<string, { default?: unknown }> }
      >;
      jobs: { lane: Job };
    };
    // An alpha calls verify with no say; a request runs only the tagged tests unless it asks.
    expect(verify.on.workflow_call.inputs.all_journeys?.default).toBe(true);
    expect(verify.on.workflow_dispatch.inputs.all_journeys?.default).toBe(false);
    const release = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { verify: { with?: Record<string, unknown> } };
    };
    expect(release.jobs.verify.with ?? {}).not.toHaveProperty("all_journeys");
    const steps = verify.jobs.lane.steps;
    const e2e = steps.find((step) => step.id === "e2e");
    expect(e2e?.run).toBe("pnpm exec playwright test --workers=50% $ONLY");
    const verifyOnly = (all_journeys: boolean) =>
      workflowString(e2e?.env?.ONLY ?? "", { inputs: { all_journeys } });
    expect(verifyOnly(false)).toBe(`--grep ${MAC_ONLY_TAG}`);
    expect(verifyOnly(true)).toBe("");
    // Only a run of every journey supplies the chooser's journey times.
    const kept = steps.find((step) => step.name === "Keep the e2e result");
    const keptAs = (all_journeys: boolean) =>
      workflowString(String(kept?.with?.name ?? ""), { inputs: { all_journeys } });
    expect(keptAs(true)).toBe("e2e-results");
    expect(keptAs(false)).not.toBe("e2e-results");
  });

  /**
   * Linux runs every test it can (INF-1763): a test that skips on Linux
   * without MAC_ONLY_TAG runs on no pull request's Mac either, so every
   * Linux journey job refuses one, whether its journeys passed or failed.
   */
  it("refuses a test that skipped on Linux without the Mac tag in every Linux journey job", () => {
    const source = loadYamlFile(".github/workflows/source-journeys.yml") as {
      jobs: { "source-desktop": { steps: Step[] } };
    };
    const steps = source.jobs["source-desktop"].steps;
    const journeys = steps.findIndex((step) => step.env?.PLAYWRIGHT_JSON_OUTPUT_FILE);
    const result = steps[journeys]?.env?.PLAYWRIGHT_JSON_OUTPUT_FILE;
    const refuse = steps.find((step) => step.run?.startsWith("node scripts/untagged-skips.ts"));
    expect(refuse?.run).toBe(`node scripts/untagged-skips.ts ${result}`);
    expect(steps.indexOf(refuse as Step)).toBeGreaterThan(journeys);
    const runs = (os: string, lane: string, status: Partial<Record<"failure", boolean>> = {}) =>
      workflowValue(
        refuse?.if ?? "",
        { runner: { os }, matrix: { lane } },
        {
          success: !status.failure,
          failure: Boolean(status.failure),
          always: true,
          cancelled: false,
        },
      );
    for (const lane of ["parallel", "desktop"]) {
      expect(runs("Linux", lane)).toBe(true);
      expect(runs("Linux", lane, { failure: true })).toBe(true);
      expect(runs("macOS", lane)).toBe(false);
    }
    // The run-alone pass refuses an untagged skip itself (scripts/e2e-alone.ts).
    expect(runs("Linux", "alone")).toBe(false);
  });

  /**
   * INF-800: a computer in CI mode sends its heavy checks through CI, so the
   * journeys a branch names and the replay gate alone each run on request.
   * Neither runs on a pull request it did not already, or on a schedule.
   */
  it("runs named journeys and the replay gate alone on request", () => {
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      on: { workflow_dispatch: { inputs: Record<string, { required?: boolean }> } };
      jobs: Record<string, { if?: string; steps?: Step[] }>;
    };
    expect(journeys.on.workflow_dispatch.inputs.files?.required).toBe(true);
    const select = journeys.jobs["choose-journeys"]?.steps?.find((step) => step.id === "select");
    expect(select?.run).toContain('scripts/affected-journeys.ts --named "$NAMED"');
    expect(select?.env).toMatchObject({ NAMED: "${{ inputs.files }}" });
    // The pull request's starter coverage does not ride along with a request.
    for (const event of ["pull_request", "workflow_dispatch"])
      expect(
        workflowValue(journeys.jobs["linux-source"]?.if ?? "", { github: { event_name: event } }),
      ).toBe(event === "pull_request");

    const replay = loadYamlFile(".github/workflows/replay.yml") as {
      on: Record<string, unknown>;
      jobs: Record<string, { "runs-on": string; steps: Step[] }>;
    };
    expect(Object.keys(replay.on)).toEqual(["workflow_dispatch"]);
    const gate = replay.jobs["replay-gate"];
    expect(gate?.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm replay:gate",
    ]);
  });

  /**
   * INF-941: on 2026-10-22 another task's request for journeys on main
   * (run 39867018455) cancelled INF-933's request (run 39865801314) in the
   * shared group journeys-refs/heads/main, before keyboard-routing ran. A
   * newer push to a pull request still replaces its older run, as PR #341's
   * run 39862278380 replaced 39861114356 that day.
   */
  it("lets a newer push replace its pull request's journeys, and no request cancel another", () => {
    const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
      concurrency: { group: string; "cancel-in-progress": boolean };
    };
    const group = (event_name: string, ref: string, run_id: string) =>
      workflowString(journeys.concurrency.group, { github: { event_name, ref, run_id } });
    expect(journeys.concurrency["cancel-in-progress"]).toBe(true);
    expect(group("pull_request", "refs/pull/341/merge", "39861114356")).toBe(
      group("pull_request", "refs/pull/341/merge", "39862278380"),
    );
    const requests = [
      group("workflow_dispatch", "refs/heads/main", "39865801314"),
      group("workflow_dispatch", "refs/heads/main", "39867018455"),
    ];
    expect(new Set(requests).size).toBe(2);
    // Nor does a request share a group with a pull request's push.
    expect(requests).not.toContain(group("pull_request", "refs/pull/341/merge", "39862278380"));
  });

  /**
   * INF-850: on 2026-10-22 GitHub answered no verify.yml run to a search by
   * result while its plain list held passing ones, and every pull request's
   * chooser failed. INF-1443: on 2026-10-26 the plain list answered 502
   * while GitHub worked out each run's pull requests, and answered every run
   * without them. INF-1578: on 2026-10-27 a passing installer-only run
   * supplied no e2e-results. The step's own script runs against each day's
   * answers and the artifact metadata, including across run-list pages.
   */
  it.each(["2026-10-22", "2026-10-26", "2026-10-27"])(
    "finds the newest passing verify run with journey times in the plain list read on %s",
    async (day) => {
      const journeys = loadYamlFile(".github/workflows/journeys.yml") as {
        jobs: Record<string, { steps: Step[] }>;
      };
      const script = journeys.jobs["choose-journeys"]?.steps.find(
        (step) => step.id === "timing-run",
      )?.with?.script;
      expect(typeof script).toBe("string");
      type Run = { id: number; conclusion: string | null; html_url: string };
      const readings = JSON.parse(read(`tests/fixtures/verify-runs/${day}.json`)) as {
        filtered?: Record<string, { total_count: number; workflow_runs: Run[] }>;
        withPullRequests?: { status: number; data: { message: string } };
        runs: Run[];
      };
      type Artifact = { id: number; name: string; expired: boolean };
      const artifacts = JSON.parse(read("tests/fixtures/verify-runs/timing-artifacts.json")) as {
        runs: Record<string, Artifact[]>;
      };
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      const execute = new AsyncFunction("core", "github", "context", script);
      const choose = async (
        runs: Run[],
        options: { pageSize?: number; expired?: boolean; artifactError?: Error } = {},
      ) => {
        const outputs: Record<string, string> = {};
        const summaries: string[] = [];
        const summary = {
          addRaw: (text: string) => {
            summaries.push(text);
            return summary;
          },
          write: async () => {},
        };
        // GitHub as it answered: a filtered query its recorded answer, the plain list by page,
        // and its recorded failure when asked to work out each run's pull requests.
        // Leaving the pull requests out filters no run.
        const listWorkflowRuns = async ({
          owner,
          repo,
          workflow_id,
          per_page = 30,
          page = 1,
          exclude_pull_requests = false,
          ...filters
        }: Record<string, string | number | boolean>) => {
          expect({ owner, repo, workflow_id }).toEqual({
            owner: "example",
            repo: "project",
            workflow_id: "verify.yml",
          });
          const query = Object.entries(filters).map(([key, value]) => `${key}=${value}`);
          if (query.length > 0) {
            const answer = readings.filtered?.[query.join("&")];
            if (!answer) throw new Error(`No recorded answer for ${query.join("&")}`);
            return { data: answer };
          }
          const failure = readings.withPullRequests;
          if (failure && exclude_pull_requests !== true) {
            throw Object.assign(new Error(failure.data.message), failure);
          }
          const from = (Number(page) - 1) * Number(per_page);
          const workflow_runs = runs.slice(from, from + Number(per_page));
          return { data: { total_count: runs.length, workflow_runs } };
        };
        const listWorkflowRunArtifacts = vi.fn(async (parameters: Record<string, unknown>) => {
          expect(parameters).toMatchObject({ owner: "example", repo: "project" });
          const runId = Number(parameters.run_id);
          expect(runs.find((run) => run.id === runId)?.conclusion).toBe("success");
          if (options.artifactError) throw options.artifactError;
          const recorded = artifacts.runs[String(runId)];
          if (!recorded) throw new Error(`No recorded artifacts for ${runId}`);
          return recorded
            .filter((artifact) => !parameters.name || artifact.name === parameters.name)
            .map((artifact) => ({
              ...artifact,
              expired: options.expired ?? artifact.expired,
            }));
        });
        // Octokit's pagination hands each page's runs over as the page's data.
        // A smaller page replays the same readings across a page boundary.
        const iterator = async function* (
          method: typeof listWorkflowRuns,
          parameters: Record<string, string | number | boolean>,
        ) {
          for (let page = 1; ; page++) {
            const { data } = await method({
              ...parameters,
              per_page: options.pageSize ?? parameters.per_page ?? 30,
              page,
            });
            if (data.workflow_runs.length === 0) return;
            yield { data: data.workflow_runs };
          }
        };
        const paginate = Object.assign(
          async (method: typeof listWorkflowRunArtifacts, parameters: Record<string, unknown>) =>
            method(parameters),
          { iterator },
        );
        await execute(
          { setOutput: (name: string, value: string) => (outputs[name] = value), summary },
          { rest: { actions: { listWorkflowRuns, listWorkflowRunArtifacts } }, paginate },
          { repo: { owner: "example", repo: "project" } },
        );
        return { outputs, summaries };
      };

      // Newer runs failed, are still going, or passed without journey times.
      const passing = readings.runs.find(
        (run) =>
          run.conclusion === "success" &&
          artifacts.runs[String(run.id)]?.some((artifact) => artifact.name === "e2e-results"),
      );
      expect(readings.runs.indexOf(passing as Run)).toBeGreaterThan(0);
      for (const pageSize of [undefined, 1]) {
        const found = await choose(readings.runs, { pageSize });
        expect(found.outputs.id).toBe(passing?.id);
        expect(found.summaries.join("")).toContain(passing?.html_url);
      }

      // Without a passing run there are no journey times: the chooser fails, never guesses.
      await expect(
        choose(readings.runs.filter((run) => run.conclusion !== "success")),
      ).rejects.toThrow("No passing verify run supplies journey times");
      // The same metadata with its retention elapsed cannot supply downloadable times.
      const throughPassing = readings.runs.slice(0, readings.runs.indexOf(passing as Run) + 1);
      await expect(choose(throughPassing, { expired: true })).rejects.toThrow(
        "No passing verify run supplies journey times",
      );
      // An unreadable artifact list is not evidence that the run has no artifact.
      await expect(
        choose(readings.runs, { artifactError: new Error("Artifact API unavailable") }),
      ).rejects.toThrow("Artifact API unavailable");
      if (day === "2026-10-27") {
        await expect(choose(readings.runs.slice(0, -1))).rejects.toThrow(
          "No passing verify run supplies journey times",
        );
      }
    },
  );

  /**
   * FI3-262: a successful verify run cannot replace a skipped PR check.
   * Exercise the actual job condition with GitHub's expression evaluator,
   * including a release's own notes pull request, rather than looking for a
   * string. No upstream jobs: the implicit success() condition is true here.
   */
  it.each([
    ["main push", "push", "", "refs/heads/main"],
    ["ordinary proposal", "pull_request", "fm/task-ci-contract", "refs/pull/42/merge"],
    ["release notes and record", "pull_request", "fm/task-release-alpha", "refs/pull/471/merge"],
  ])("runs the real Linux gate for %s", (_name, eventName, headRef, ref) => {
    const ci = loadYamlFile(".github/workflows/ci.yml") as {
      on: { push: { branches: string[] }; pull_request: unknown };
      jobs: Record<string, CiJob>;
    };
    // The event must reach every job, not disappear behind a branch/path filter.
    expect(ci.on.push.branches).toEqual(["main"]);
    expect(ci.on).toHaveProperty("pull_request", null);
    const github = new data.Dictionary(
      { key: "event_name", value: new data.StringData(eventName) },
      { key: "head_ref", value: new data.StringData(headRef) },
      { key: "base_ref", value: new data.StringData(eventName === "pull_request" ? "main" : "") },
      { key: "ref", value: new data.StringData(ref) },
    );
    for (const [id, job] of Object.entries(ci.jobs)) {
      expect(job.needs, id).toBeUndefined();
      const expression = (job.if ?? "true").replace(/^\$\{\{\s*|\s*\}\}$/g, "");
      const ast = new Parser(new Lexer(expression).lex().tokens, ["github"], []).parse();
      const eligible = new Evaluator(ast, new data.Dictionary({ key: "github", value: github }));
      expect(eligible.evaluate().coerceString(), id).toBe("true");
      // A no-op success would not solve the problem: keep the real gate and
      // fail on any gate step's failure, without introducing step-level skips.
      // INI-9's plan: every job runs where LINUX_RUNNER sends it, the
      // placement service's shell-pc-linux places, and back on GitHub's
      // hosted Linux when the variable is unset.
      expect(workflowString(job["runs-on"], { vars: {} }), id).toBe("ubuntu-latest");
      expect(workflowString(job["runs-on"], { vars: { LINUX_RUNNER: "shell-pc-linux" } }), id).toBe(
        "shell-pc-linux",
      );
      expect(job["continue-on-error"], id).toBeFalsy();
      expect(
        job.steps.every((step) => !step.if && !step["continue-on-error"]),
        id,
      ).toBe(true);
    }
    // Every machine installs from the lockfile before it runs anything, and
    // the jobs together run each check once; the tests are the next case's.
    for (const { name, runs } of ciJobs())
      expect(runs[0], name).toBe("pnpm install --frozen-lockfile");
    const checks = ciJobs()
      .flatMap(({ runs }) => runs.slice(1))
      .filter((run) => !run.startsWith("pnpm test"));
    expect(checks.toSorted()).toEqual([
      "pnpm build",
      "pnpm check",
      "pnpm lint:adherence",
      "pnpm typecheck",
    ]);
  });

  // DOP-66 fix 1: the rebuilt shell PC image owns the pnpm store;
  // hosted runners still need setup-node's cache. Evaluate the real inputs.
  it.each([
    ["hosted Linux", {}, "pnpm"],
    ["shell PC", { LINUX_RUNNER: "shell-pc-linux" }, ""],
  ])("selects the pnpm cache for %s", (_name, vars, expected) => {
    const ci = loadYamlFile(".github/workflows/ci.yml") as { jobs: Record<string, CiJob> };
    for (const [id, job] of Object.entries(ci.jobs)) {
      const setup = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
      expect(setup, id).toBeDefined();
      expect(workflowString(setup?.with?.cache ?? "", { vars }), id).toBe(expected);
    }
  });

  /**
   * FI3-1204: the PR gate runs its tests on several machines at once, and
   * split it must still run every test: each vitest project in exactly one
   * job, or in shards of one count that together cover it. The probe project
   * is the one exception (FI3-1756's plan): one job runs it through its
   * chooser, only the probes whose paths the change edits.
   */
  it("runs every vitest project once across the PR jobs, a sharded one in shards that cover it", () => {
    const projects = (vitestConfig.test?.projects ?? []).map((project) => {
      const name =
        typeof project === "object" && "test" in project ? project.test?.name : undefined;
      if (typeof name !== "string") throw new Error("every vitest project is named");
      return name;
    });
    expect(projects).toEqual(
      expect.arrayContaining(["pure", "unit", "unit-isolated", "integration", "probe"]),
    );
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["test:probes"]).toBe("node scripts/affected-probes.ts --run");
    const shardsOf = new Map<string, string[]>();
    for (const { name, runs } of ciJobs()) {
      for (const run of runs) {
        const [tool, script, ...args] = run.split(/\s+/);
        if (tool === "pnpm" && script === "test:probes") {
          shardsOf.set("probe", [...(shardsOf.get("probe") ?? []), "affected"]);
          continue;
        }
        if (tool !== "pnpm" || script !== "test") continue;
        const selected: string[] = [];
        let shard = "whole";
        for (let index = 0; index < args.length; index++) {
          const arg = args[index] ?? "";
          if (arg === "--project") selected.push(args[++index] ?? "");
          else if (arg.startsWith("--shard=")) shard = arg.slice("--shard=".length);
          else throw new Error(`${name} passes vitest an argument this check cannot read: ${arg}`);
        }
        for (const project of selected.length > 0 ? selected : projects) {
          shardsOf.set(project, [...(shardsOf.get(project) ?? []), shard]);
        }
      }
    }
    expect([...shardsOf.keys()].toSorted()).toEqual(projects.toSorted());
    expect(shardsOf.get("probe")).toEqual(["affected"]);
    for (const [project, shards] of shardsOf) {
      const whole = shards.length === 1 && (shards[0] === "whole" || shards[0] === "affected");
      const cover = shards.map((_, index) => `${index + 1}/${shards.length}`);
      expect(whole || shards.toSorted().join() === cover.toSorted().join(), project).toBe(true);
    }
  });

  type Step = {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string | number>;
    "continue-on-error"?: boolean;
  };

  /**
   * Whether Actions runs a step in a lane (the mac lane unless named) once
   * the earlier steps ended with these outcomes: its condition through
   * GitHub's own evaluator, with the status functions the job's state gives,
   * and a condition naming none of them runs only on success().
   */
  const stepRuns = (
    step: Step | undefined,
    outcomes: Record<string, string>,
    lane: "mac" | "linux-checks" = "mac",
  ) => {
    const failed = Object.values(outcomes).includes("failure");
    const status: Array<[string, boolean]> = [
      ["success", !failed],
      ["failure", failed],
      ["always", true],
      ["cancelled", false],
    ];
    const functions = status.map(([name, value]) => ({
      name,
      minArgs: 0,
      maxArgs: 0,
      call: () => new data.BooleanData(value),
    }));
    const condition = (step?.if ?? "").replace(/^\$\{\{\s*|\s*\}\}$/g, "") || "true";
    const expression = /\b(success|failure|always|cancelled)\(\)/.test(condition)
      ? condition
      : `success() && (${condition})`;
    const ast = new Parser(
      new Lexer(expression).lex().tokens,
      ["steps", "matrix"],
      functions,
    ).parse();
    const steps = new data.Dictionary(
      ...Object.entries(outcomes).map(([id, outcome]) => ({
        key: id,
        value: new data.Dictionary({ key: "outcome", value: new data.StringData(outcome) }),
      })),
    );
    const matrix = new data.Dictionary({ key: "lane", value: new data.StringData(lane) });
    const context = new data.Dictionary(
      { key: "steps", value: steps },
      { key: "matrix", value: matrix },
    );
    const evaluator = new Evaluator(ast, context, new Map(functions.map((f) => [f.name, f])));
    return evaluator.evaluate().coerceString() === "true";
  };

  /**
   * Runs verify's Summarize step as Actions would (bash -e, the stages'
   * outcomes filled in) in a checked-out workspace holding the files `write`
   * names, by their path in the working copy.
   */
  const summarizeRun = (
    summarize: Step | undefined,
    outcomes: Record<string, string>,
    write?: (dir: string) => Record<string, unknown>,
  ) => {
    const stages = summarize?.env?.STAGES ?? "";
    const git = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const workspace = scratchDir("infinitary-verify-summary-");
    const identity = ["-c", "user.name=verify", "-c", "user.email=verify@localhost"];
    execFileSync("git", ["init", "-q", workspace], { env: git });
    execFileSync(
      "git",
      ["-C", workspace, ...identity, "commit", "-q", "--allow-empty", "-m", "c"],
      {
        env: git,
      },
    );
    for (const [path, contents] of Object.entries(write?.(workspace) ?? {})) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), JSON.stringify(contents));
    }
    const summary = join(workspace, "summary.md");
    const run = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", summarize?.run ?? ""], {
      cwd: workspace,
      env: {
        ...git,
        REQUESTED: "refs/heads/main",
        STAGES: stages.replace(
          /\$\{\{ steps\.([\w-]+)\.outcome \}\}/g,
          (_, id: string) => outcomes[id] ?? "skipped",
        ),
        GITHUB_STEP_SUMMARY: summary,
      },
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    const sha = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: git,
    }).trim();
    return { sha, summary: readFileSync(summary, "utf8") };
  };

  /**
   * A red verify has to be readable where it ran (scout
   * fm3000-e2e-rigidity-s2, I5; docs/testing.md "A red verify's
   * evidence"): the suite keeps zero retries and captures a failed journey
   * itself, and verify keeps Playwright's JSON result whenever the suite
   * ran and the result directories when it failed, for a bounded time -
   * neither upload able to fail the job, nor running when an earlier stage
   * kept e2e from starting. The summary reports; it never gates.
   */
  it("keeps a red e2e run's evidence without a retry, a secret or a new gate", async () => {
    // The config as Playwright loads it (no tsconfig project lists the file).
    const config = (
      (await import(join(root, "playwright.config.ts"))) as { default: PlaywrightTestConfig }
    ).default;
    expect(config.retries ?? 0).toBe(0);
    expect(config.use).toMatchObject({ trace: "retain-on-failure", screenshot: "only-on-failure" });
    const reporters = Array.isArray(config.reporter) ? config.reporter : [];
    expect(reporters.map(([name]) => name)).toEqual([process.env.CI ? "dot" : "list", "json"]);
    // Each local run keeps its JSON result beside its result directories
    // (tests/e2e/runEvidence.ts); verify names the fixed path it keeps.
    const json = reporters.find(([name]) => name === "json")?.[1] as { outputFile?: string };
    expect(json?.outputFile ?? "").not.toBe("");

    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: { lane: { steps: Step[] } };
    };
    const steps = verify.jobs.lane.steps;
    const e2e = steps.findIndex((step) => step.id === "e2e");
    // Half the processor: both Mac runner slots share it (INF-741).
    expect(steps[e2e]?.run).toBe("pnpm exec playwright test --workers=50% $ONLY");
    const result = steps[e2e]?.env?.PLAYWRIGHT_JSON_OUTPUT_FILE ?? "";
    expect(result).not.toBe("");
    const upload = (path: string) =>
      steps.find(
        (step) =>
          step.uses === "actions/upload-artifact@v4" &&
          step.with?.path === `Application Support/firstmate/${path}`,
      );
    const kept = upload(result);
    const failures = upload("test-results/");
    const demos = upload("test-results/runs/*/*/demo/");
    const runsAfter = (step: Step | undefined, e2eOutcome: string) =>
      stepRuns(step, { e2e: e2eOutcome });
    const outcomes = ["success", "failure", "skipped"];
    expect(outcomes.map((outcome) => runsAfter(kept, outcome))).toEqual([true, true, false]);
    expect(outcomes.map((outcome) => runsAfter(failures, outcome))).toEqual([false, true, false]);
    // A requested demo is kept whether the suite passed or failed.
    expect(outcomes.map((outcome) => runsAfter(demos, outcome))).toEqual([true, true, false]);
    for (const step of [kept, failures, demos]) {
      expect(step?.with?.["if-no-files-found"]).toBe("ignore");
      expect(Number(step?.with?.["retention-days"])).toBeGreaterThan(0);
      expect(Number(step?.with?.["retention-days"])).toBeLessThanOrEqual(30);
      // Right after the suite: no later stage stands between it and them.
      expect(steps.indexOf(step as Step) - e2e).toBeGreaterThan(0);
      expect(steps.indexOf(step as Step) - e2e).toBeLessThanOrEqual(3);
    }
    // The graded perf rerun writes its own result, never over the suite's.
    const perf = steps.find((step) => step.id === "perf")?.env?.PLAYWRIGHT_JSON_OUTPUT_FILE;
    expect(perf).toBeTruthy();
    expect(perf).not.toBe(result);
    // Nothing verify runs holds a secret: release.yml passes it none.
    expect(JSON.stringify(verify)).not.toContain("secrets.");
    const release = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { verify: Record<string, unknown> };
    };
    expect(release.jobs.verify.secrets).toBeUndefined();

    const summarize = steps.find((step) => step.name === "Summarize");
    expect(summarize).toMatchObject({
      if: "always() && matrix.lane == 'mac'",
      "continue-on-error": true,
    });
    expect(summarize?.run).toContain(result);
    // Every stage the job names is reported, by its own outcome, in the job's order.
    const stages = summarize?.env?.STAGES ?? "";
    const reported = [...stages.matchAll(/([\w-]+)=\$\{\{ steps\.([\w-]+)\.outcome \}\}/g)];
    expect(reported.map(([, name, id]) => (name === id ? id : `${name}!=${id}`))).toEqual(
      steps.flatMap((step) => (step.id ? [step.id] : [])),
    );

    // A red suite: the failures listed by when they started, not by file order.
    const outcome = (
      status: "passed" | "failed" | "skipped",
      startTime: string,
      error?: JSONReportError,
    ): JSONReportTestResult => ({
      workerIndex: 0,
      parallelIndex: 0,
      status,
      duration: 1,
      error: error ? { message: error.message } : undefined,
      errors: error ? [error] : [],
      stdout: [],
      stderr: [],
      retry: 0,
      startTime,
      attachments: [],
      annotations: [],
    });
    const spec = (
      title: string,
      line: number,
      status: JSONReportTest["status"],
      results: JSONReportTestResult[],
    ): JSONReportSpec => ({
      tags: [],
      title,
      ok: status !== "unexpected",
      id: title,
      file: "rows.spec.ts",
      line,
      column: 1,
      tests: [
        {
          timeout: 60_000,
          annotations: [],
          expectedStatus: "passed",
          projectName: "desktop",
          projectId: "desktop",
          results,
          status,
        },
      ],
    });
    const red = (dir: string): Pick<JSONReport, "stats" | "suites" | "errors"> => ({
      stats: {
        startTime: "2026-09-30T00:00:00.000Z",
        duration: 9,
        expected: 1,
        unexpected: 2,
        flaky: 0,
        skipped: 1,
      },
      errors: [],
      suites: [
        {
          title: "rows.spec.ts",
          file: "rows.spec.ts",
          line: 0,
          column: 0,
          specs: [],
          suites: [
            {
              title: "the rows",
              file: "rows.spec.ts",
              line: 3,
              column: 1,
              specs: [
                spec("paints", 5, "expected", [outcome("passed", "2026-09-30T00:00:01.000Z")]),
                spec("moves", 20, "unexpected", [
                  outcome("failed", "2026-09-30T00:00:03.000Z", {
                    message: "Error: expect(locator).toBeVisible() failed",
                  }),
                ]),
                spec("docks", 12, "unexpected", [
                  outcome("failed", "2026-09-30T00:00:02.000Z", {
                    message:
                      "\u001b[31mError: expect(received).toBe(expected)\u001b[39m\n\nExpected: 2",
                    location: {
                      file: join(realpathSync(dir), "tests/e2e/rows.spec.ts"),
                      line: 14,
                      column: 5,
                    },
                  }),
                ]),
                spec("folds", 30, "skipped", []),
              ],
            },
          ],
        },
      ],
    });
    const failed = summarizeRun(
      summarize,
      { install: "success", unit: "success", e2e: "failure" },
      (dir) => ({ [result]: red(dir) }),
    );
    expect(failed.summary).toContain(`\`refs/heads/main\` at \`${failed.sha}\``);
    expect(failed.summary).toContain("First failed stage: **e2e**.");
    expect(failed.summary).toContain("E2E: 1 passed, 2 failed, 0 flaky, 1 skipped or not run.");
    expect(failed.summary).toContain(
      "First to fail: **the rows › docks** (`rows.spec.ts:12`, desktop), at `tests/e2e/rows.spec.ts:14`",
    );
    expect(failed.summary).toContain(
      "```\nError: expect(received).toBe(expected)\n\nExpected: 2\n```",
    );
    expect(failed.summary).toContain(
      "- `rows.spec.ts:12` the rows › docks (desktop)\n- `rows.spec.ts:20` the rows › moves (desktop)",
    );

    // A failed stage is named, and an e2e suite that left no result claims none.
    const early = summarizeRun(summarize, { install: "success", unit: "failure" });
    expect(early.summary).toContain("First failed stage: **unit**.");
    expect(early.summary).toContain("No e2e result: the suite did not run to its end.");
  });

  /**
   * INF-663 (the captain asked whether the full check discovers every
   * failure or only the first): each stage waits only on the stages it
   * needs, so a red unit test no longer skips the e2e suite, the client
   * check, the replay gate or the package smoke. The job still ends red on
   * any failure, so release.yml still refuses to sign ("signs only after
   * full verification", below).
   */
  it("runs each stage when its own inputs passed, whatever else failed, and still ends red", () => {
    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: { lane: { steps: Step[] } };
    };
    const steps = verify.jobs.lane.steps;
    const stage = (id: string) => steps.find((step) => step.id === id);
    const ids = steps.flatMap((step) => (step.id ? [step.id] : []));
    const needs: Record<string, string[]> = {
      "dev-signing": ["install"],
      unit: ["install"],
      build: ["install"],
      recorder: ["install"],
      e2e: ["build", "dev-signing", "recorder"],
      "claude-client": ["install"],
      replay: ["install"],
      package: ["build", "dev-signing"],
      codesign: ["package"],
      "data-folder": ["package"],
      "bundled-git": ["package"],
      helper: ["package"],
    };
    const upstream = (id: string): string[] =>
      (needs[id] ?? []).flatMap((input) => [input, ...upstream(input)]);
    for (const [id, inputs] of Object.entries(needs)) {
      // Every earlier stage it does not stand on failed: it still runs.
      const earlier = ids.slice(0, ids.indexOf(id));
      const unrelatedRed = Object.fromEntries(
        earlier.map((other) => [other, upstream(id).includes(other) ? "success" : "failure"]),
      );
      expect(stepRuns(stage(id), unrelatedRed), `${id} after unrelated failures`).toBe(true);
      // Any input red or skipped: it does not.
      for (const input of inputs)
        for (const outcome of ["failure", "skipped"])
          expect(
            stepRuns(stage(id), { ...unrelatedRed, [input]: outcome }),
            `${id} after ${input} ${outcome}`,
          ).toBe(false);
    }

    // The failure INF-663 read on main (release run 39337627117): a red unit
    // stage skipped every later stage. Now each one runs.
    const unitRed = Object.fromEntries(
      ids.map((id) => [id, id === "unit" ? "failure" : "success"]),
    );
    const later = ids.slice(ids.indexOf("unit") + 1).filter((id) => id !== "perf");
    expect(later.filter((id) => !stepRuns(stage(id), unitRed))).toEqual([]);

    // The linux-checks lane the same way: a red check skips none of the others.
    const linux = steps.filter(
      (step) => step.run?.startsWith("pnpm ") && step.if?.includes("linux-checks"),
    );
    expect(linux.map((step) => step.run)).toEqual([
      "pnpm typecheck",
      "pnpm check",
      "pnpm lint:adherence",
      "pnpm test",
    ]);
    for (const step of [...linux, stage("build")]) {
      const afterRed = { install: "success", "an earlier check": "failure" };
      expect(stepRuns(step, afterRed, "linux-checks"), step?.run).toBe(true);
      expect(stepRuns(step, { install: "failure" }, "linux-checks"), step?.run).toBe(false);
    }

    // A red stage still fails the job: only the summary, a report, may not.
    expect(
      steps.filter((step) => step["continue-on-error"]).map((step) => step.name ?? step.id),
    ).toEqual(["Summarize"]);
  });

  /**
   * The run-alone pass (docs/testing.md "Each test owns its prerequisites"):
   * the mac lane runs each later Mac-only test of a spec file that shares
   * one app by itself (INF-873: the rest run alone on Linux), on the suite's
   * build, whether the suite passed or failed and after every other stage,
   * keeps its result, and the summary lists its failures apart from the
   * suite's.
   */
  it("runs each later Mac-only test of a file that shares one app alone, and lists its failures apart", () => {
    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: { lane: { steps: Step[] } };
    };
    const steps = verify.jobs.lane.steps;
    const alone = steps.find((step) => step.id === "alone");
    const [, tag, out] =
      /^node scripts\/e2e-alone\.ts --tag (\S+) --out (\S+)$/.exec(alone?.run ?? "") ?? [];
    expect(tag, "the mac lane runs the tests that skip on Linux").toBe(MAC_ONLY_TAG);
    expect(out, "the pass writes its result where the job keeps it").toBeTruthy();
    // After every other stage, so a test failing alone hides none of them.
    expect(steps.flatMap((step) => (step.id ? [step.id] : [])).at(-1)).toBe("alone");
    const outcomes = ["success", "failure", "skipped"];
    expect(outcomes.map((e2e) => stepRuns(alone, { e2e }))).toEqual([true, true, false]);
    expect(stepRuns(alone, { e2e: "success", package: "failure" })).toBe(true);
    const kept = steps.find(
      (step) =>
        step.uses === "actions/upload-artifact@v4" &&
        step.with?.path === `Application Support/firstmate/${out}/`,
    );
    expect(steps.indexOf(kept as Step)).toBeGreaterThan(steps.indexOf(alone as Step));
    expect(outcomes.map((outcome) => stepRuns(kept, { e2e: "success", alone: outcome }))).toEqual([
      true,
      true,
      false,
    ]);

    const summarize = steps.find((step) => step.name === "Summarize");
    const result = (title: string, line: number, status: "passed" | "failed") => ({
      file: "rows.spec.ts",
      line,
      lane: "application",
      title,
      status,
      seconds: 4,
      ...(status === "failed" ? { error: "Error: expect(locator).toBeVisible() failed" } : {}),
    });
    const { summary } = summarizeRun(
      summarize,
      { install: "success", unit: "success", e2e: "success", alone: "failure" },
      () => ({
        [`${out}/${ALONE_RESULTS}`]: {
          results: [
            result("the rows › moves", 20, "failed"),
            result("the rows › folds", 30, "passed"),
          ],
        },
      }),
    );
    expect(summary).toContain("First failed stage: **alone**.");
    expect(summary).toContain("Run alone: 1 passed, 1 failed");
    expect(summary).toContain("- `rows.spec.ts:20` the rows › moves (application)");
    expect(summary).not.toContain("rows.spec.ts:30");
  });

  it("holds one job-lifetime macOS sleep assertion for verify and signing", async () => {
    const actionPath = ".github/actions/keep-mac-awake/action.yml";
    const actionRef = "./.github/actions/keep-mac-awake";
    const action = loadYamlFile(actionPath) as {
      runs: { using: string; steps: Array<{ run?: string; shell?: string }> };
    };
    expect(action.runs.using).toBe("composite");
    const assertion = action.runs.steps.find((step) => step.run?.includes("caffeinate"));
    expect(assertion?.shell).toBe("bash");
    // One definition. Neither workflow copies the command.
    expect(read(".github/workflows/verify.yml")).not.toContain("caffeinate");
    expect(read(".github/workflows/release.yml")).not.toContain("caffeinate");

    type Step = {
      name?: string;
      uses?: string;
      run?: string;
      with?: Record<string, string>;
    };
    const verify = loadYamlFile(".github/workflows/verify.yml") as {
      jobs: {
        lane: {
          defaults: { run: { "working-directory": string } };
          steps: Step[];
        };
      };
    };
    const mac = verify.jobs.lane;
    expect(mac.defaults.run["working-directory"]).toBe("Application Support/firstmate");
    // The default working directory does not exist yet, so the action is
    // fetched on its own and the assertion starts before the real checkout -
    // on the mac lane, the only one on a Mac.
    expect(mac.steps[0]).toMatchObject({ if: "matrix.lane == 'mac'" });
    expect(mac.steps[1]).toMatchObject({ if: "matrix.lane == 'mac'" });
    expect(mac.steps[0]?.uses).toBe("actions/checkout@v4");
    expect(mac.steps[0]?.with?.["sparse-checkout"]).toBe(".github/actions/keep-mac-awake");
    expect(mac.steps[1]?.uses).toBe(actionRef);
    expect(mac.steps[2]).toMatchObject({
      uses: "actions/checkout@v4",
      with: { path: "Application Support/firstmate" },
    });
    const awakeAt = (steps: Step[]) => steps.findIndex((step) => step.uses === actionRef);
    expect(awakeAt(mac.steps)).toBeLessThan(
      mac.steps.findIndex((step) => step.run?.includes("pnpm test")),
    );

    const release = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { release: { steps: Step[] } };
    };
    const signing = release.jobs.release.steps;
    expect(signing[0]?.uses).toBe("actions/checkout@v4");
    expect(signing[1]?.uses).toBe(actionRef);
    expect(awakeAt(signing)).toBeLessThan(
      signing.findIndex((step) => step.name === "Restore Developer ID Application certificate"),
    );
    expect(awakeAt(signing)).toBeLessThan(
      signing.findIndex((step) => step.name === "Package and sign the universal app"),
    );

    // Execute the shared step as Actions would (bash -eo pipefail), in an
    // empty workspace with a stand-in caffeinate, and observe the assertion
    // and the worker it ties to. $PPID is this process, as the runner worker
    // is the parent of a job step. The step leaves the assertion in the
    // background; the shell then waits for that job, so the stand-in has
    // written its arguments by the time the shell exits - an order, not a
    // guess at how long a loaded runner takes to start it.
    const workspace = scratchDir("infinitary-runner-awake-");
    const bin = join(workspace, "bin");
    const args = join(workspace, "assertion-args");
    mkdirSync(bin);
    writeFileSync(join(bin, "caffeinate"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ASSERTION_ARGS"\n');
    chmodSync(join(bin, "caffeinate"), 0o755);
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", `${assertion?.run ?? "exit 1"}\nwait`],
      {
        cwd: workspace,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASSERTION_ARGS: args },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(args, "utf8")).toBe(`-is\n-w\n${process.pid}\n`);
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
  writeFileSync(join(shimDir, "git"), readFileSync(join(root, "resources", "git-bin", "git")));
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
    "passes a universal bundle carrying koffi's single-arch addons and the app's two gits",
    () => {
      const result = verifyApp(fixtureApp());
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("5 Mach-O files, 4 single-arch under mac.x64ArchFiles");
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

describe("signed release workflow", () => {
  const workflow = read(".github/workflows/release.yml");

  it("enforces the pinned identity", () => {
    expect(workflow).toContain('SIGN_IDENTITY: "Developer ID Application: Kun Chen (9T2J7MNUP9)"');
    expect(workflow).toContain("TEAM_ID: 9T2J7MNUP9");
  });

  it("resolves the documented signing and publication credentials through the workflow's expressions", () => {
    // Revised INF-643: independent credentials preserve both publication destinations.
    const names = [
      "MAC_DEVELOPER_ID_CERT_P12",
      "MAC_DEVELOPER_ID_CERT_PASSWORD",
      "APP_STORE_CONNECT_KEY_ID",
      "APP_STORE_CONNECT_ISSUER_ID",
      "APP_STORE_CONNECT_API_KEY",
      "R2_ENDPOINT",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "HOMEBREW_TAP_TOKEN",
      "OLD_TAP_TOKEN",
    ];
    const secrets = Object.fromEntries(names.map((name) => [name, `fixture-${name}`]));
    const parsed = loadYamlFile(".github/workflows/release.yml") as {
      jobs: Record<string, { steps?: { id?: string; env?: Record<string, string> }[] }>;
    };
    const expressions = Object.values(parsed.jobs)
      .flatMap((job) => (job.steps ?? []).flatMap((step) => Object.values(step.env ?? {})))
      .filter((value) => /^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/.test(value));
    expect(
      new Set(expressions.map((expression) => workflowValue(expression, { secrets }))),
    ).toEqual(new Set(Object.values(secrets)));
    // Storage credentials belong only to the upload/switch recipients, never rehearsal or public fetch-back,
    // all in the publication job since INF-1716.
    const publication = (id: string) => {
      const found = parsed.jobs.publish?.steps?.find((step) => step.id === id);
      if (!found) throw new Error(`release.yml's publication job has no step "${id}"`);
      return found;
    };
    for (const id of ["public", "feeds"]) {
      const environment = publication(id).env;
      for (const name of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
        expect(workflowValue(environment?.[name] ?? "", { secrets })).toBe(secrets[name]);
      }
    }
    for (const id of ["feed-rehearsal", "public-fetch-back"]) {
      const environment = publication(id).env ?? {};
      expect(Object.keys(environment)).not.toContain("R2_ENDPOINT");
      expect(Object.keys(environment)).not.toContain("R2_ACCESS_KEY_ID");
      expect(Object.keys(environment)).not.toContain("R2_SECRET_ACCESS_KEY");
    }
  });

  it("runs every gate: verify, launch, notarize, staple, re-download", () => {
    expect(workflow).toContain("scripts/verify-app.sh");
    expect(workflow).toContain("--signed --gatekeeper");
    expect(workflow).toContain("scripts/check-app-launch.sh");
    expect(workflow).toContain("xcrun notarytool submit");
    expect(workflow).toContain("xcrun stapler staple");
    expect(workflow).toContain("gh release download");
    expect(workflow).toContain("shasum -a 256 -c");
  });

  it("takes the umami config from repository variables, not secrets", () => {
    expect(workflow).toContain("vars.INFINITARY_UMAMI_HOST");
    expect(workflow).toContain("vars.INFINITARY_UMAMI_WEBSITE_ID");
    expect(workflow).not.toContain("secrets.INFINITARY_UMAMI");
  });
});

/** A workflow `if:` or `${{ }}` value, evaluated as GitHub Actions does, as plain JSON. */
function workflowValue(
  value: string,
  contexts: Record<string, unknown>,
  status: Record<"success" | "failure" | "always" | "cancelled", boolean> = {
    success: true,
    failure: false,
    always: true,
    cancelled: false,
  },
): unknown {
  const expression = value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  const functions = Object.entries(status).map(([name, result]) => ({
    name,
    minArgs: 0,
    maxArgs: 0,
    call: () => new data.BooleanData(result),
  }));
  const ast = new Parser(
    new Lexer(expression).lex().tokens,
    Object.keys(contexts),
    functions,
  ).parse();
  const context = JSON.parse(JSON.stringify(contexts), data.reviver) as data.Dictionary;
  const result = new Evaluator(ast, context, new Map(functions.map((f) => [f.name, f]))).evaluate();
  return JSON.parse(JSON.stringify(result, data.replacer));
}

/** A string carrying `${{ }}` expressions, interpolated as GitHub Actions does. */
function workflowString(template: string, contexts: Record<string, unknown>): string {
  return template.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, expression: string) => {
    const value = workflowValue(expression, contexts);
    return value === null ? "" : String(value);
  });
}

type CiJob = {
  name?: string;
  if?: string;
  needs?: unknown;
  "runs-on": string;
  "continue-on-error"?: boolean;
  strategy?: { matrix: Record<string, unknown[]> };
  steps: Array<{
    run?: string;
    uses?: string;
    with?: Record<string, string>;
    if?: string;
    "continue-on-error"?: boolean;
  }>;
};

/**
 * The PR gate's machines: one per ci.yml job and matrix entry, each with
 * its name and its steps' commands interpolated as GitHub Actions does.
 */
function ciJobs(): { name: string; runs: string[] }[] {
  const ci = loadYamlFile(".github/workflows/ci.yml") as { jobs: Record<string, CiJob> };
  return Object.entries(ci.jobs).flatMap(([id, job]) => {
    const matrix = Object.entries(job.strategy?.matrix ?? {});
    if (matrix.some(([, values]) => !Array.isArray(values))) {
      throw new Error(`${id}: only a matrix of plain lists is read here`);
    }
    const entries = matrix.reduce<Record<string, unknown>[]>(
      (combos, [key, values]) =>
        combos.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value }))),
      [{}],
    );
    return entries.map((entry, index) => {
      const contexts = {
        matrix: entry,
        strategy: { "job-index": index, "job-total": entries.length },
      };
      return {
        name: workflowString(job.name ?? id, contexts),
        runs: job.steps.flatMap((step) => (step.run ? [workflowString(step.run, contexts)] : [])),
      };
    });
  });
}

/**
 * The release's one source commit and its names (docs/alpha.md "The signed
 * channel workflow"), by running the resolve job's own script on stand-in
 * clones: an alpha releases its reviewed candidate, a stable promotes a
 * published alpha's own commit, and both are numbered from the newest
 * stable tag.
 */
describe("resolving a release", () => {
  const script = join(root, "scripts", "resolve-release.sh");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const release = loadYamlFile(".github/workflows/release.yml") as { env: Record<string, string> };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=resolve", "-c", "user.email=resolve@localhost", ...args],
      { cwd, env: gitEnv, encoding: "utf8" },
    ).trim();

  /**
   * A stand-in clone on main: stable v0.1.25, a fix, alpha v0.1.26-alpha.12
   * on it, another fix and alpha v0.1.26-alpha.13, and a last commit nothing
   * was built from. origin/main is main's head, as the resolve job's full
   * checkout has it.
   */
  function fixture() {
    const clone = join(scratchDir("infinitary-release-resolve-"), "clone");
    mkdirSync(clone);
    git(clone, "init", "-q", "-b", "main");
    const commit = (subject: string, files: Record<string, string> = {}) => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(clone, path)), { recursive: true });
        writeFileSync(join(clone, path), content);
      }
      git(clone, "add", "-A");
      git(clone, "commit", "-q", "--allow-empty", "-m", subject);
      return git(clone, "rev-parse", "HEAD");
    };
    commit("chore: first", { "src.txt": "0", "release-notes/changes/first.json": "{}" });
    git(clone, "tag", "v0.1.25");
    commit("fix: one", { "src.txt": "1" });
    git(clone, "tag", "v0.1.26-alpha.12");
    commit("chore: two");
    const alpha13 = commit("fix: three", { "src.txt": "3" });
    git(clone, "tag", "v0.1.26-alpha.13");
    const head = commit("fix: after the alpha", { "src.txt": "4" });
    git(clone, "update-ref", "refs/remotes/origin/main", head);
    return { clone, commit, alpha13, head };
  }

  it("keeps a promoted source's download destination when main selects a different host", () => {
    // INF-640: an updater and the publication it reads must use the same selected destination.
    const f = fixture();
    const configuration = read("packaging/release-source.json");
    const source = f.commit("feat: select the download host", {
      "packaging/release-source.json": configuration,
    });
    f.commit("chore: select a different future host", {
      "packaging/release-source.json": JSON.stringify({
        ...JSON.parse(configuration),
        downloadBase: "https://future-downloads.example/",
      }),
    });
    const workflow = loadYamlFile(".github/workflows/release.yml") as {
      jobs: { resolve: { steps: { id?: string; run?: string }[] } };
    };
    const body = workflow.jobs.resolve.steps.find((step) => step.id === "destination")?.run;
    if (!body) throw new Error("The source destination reader is missing");
    const output = join(scratchDir("inf-release-source-output-"), "output");
    const result = spawnSync("bash", ["-c", body], {
      cwd: f.clone,
      encoding: "utf8",
      env: { ...gitEnv, SOURCE_COMMIT: source, GITHUB_OUTPUT: output },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(
      `repository=${JSON.parse(configuration).repository}\ndownload_base=${JSON.parse(configuration).downloadBase}\n`,
    );
  });

  /** Runs the resolver in a clone, returning its outputs. */
  function resolve(clone: string, env: Record<string, string>) {
    const output = join(scratchDir("infinitary-release-resolve-output-"), "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", [script], {
      cwd: clone,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        ...gitEnv,
        TAP_REPO: release.env.TAP_REPO ?? "",
        TAP_TAG_PREFIX: release.env.TAP_TAG_PREFIX ?? "",
        OLD_TAP_REPO: release.env.OLD_TAP_REPO ?? "",
        OLD_TAP_TAG_PREFIX: release.env.OLD_TAP_TAG_PREFIX ?? "",
        GITHUB_OUTPUT: output,
        CHANNEL: "alpha",
        DRY_RUN: "false",
        REF: "refs/heads/main",
        RUN_NUMBER: "7",
        CANDIDATE: "",
        PROMOTE: "",
        HIGHLIGHTS: "",
        ...env,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { status: result.status, stderr: result.stderr, outputs };
  }

  /** The names a version's release carries, as the update reader builds them. */
  const publicNames = (version: string, commit: string) => {
    const target = buildUpdateTarget({
      version,
      assetName: `Infinitary-${version}-universal.zip`,
      sha256: CASK_SHA256,
      sourceCommit: commit,
    });
    return {
      zip_name: `Infinitary-${version}-universal.zip`,
      release_url: target.releaseUrl,
      download_url: target.downloadUrl,
      public_tag: target.releaseUrl.slice(target.releaseUrl.lastIndexOf("/") + 1),
    };
  };

  /**
   * The names the old-cask switch would publish the same version under, as
   * an installed Firstmate 3000's reader builds them (FI3-1780 step 10).
   */
  const oldNames = (version: string) => ({
    old_public_tag: publicTagFor(version, FIRSTMATE_TAP),
    old_download_url: buildDownloadUrl(
      version,
      `Infinitary-${version}-universal.zip`,
      FIRSTMATE_TAP,
    ),
  });

  const refusedWith = (result: ReturnType<typeof resolve>, reason: RegExp) => {
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(reason);
    expect(result.outputs).toEqual({});
  };

  it("releases the reviewed candidate: main's own commit or a notes-only commit off it, never a code change", () => {
    const { clone, commit, head } = fixture();
    // A main commit.
    const onMain = resolve(clone, { CANDIDATE: head });
    expect(onMain.status, onMain.stderr).toBe(0);
    expect(onMain.outputs.source_commit).toBe(head);
    // The release crewmate's review, committed on its own branch, while main moves on.
    git(clone, "checkout", "-q", "-b", "fm/release-review");
    const review = commit("docs(release-notes): review the next alpha", {
      "release-notes/changes/first.json": '{"reviewed": true}',
      "release-notes/releases/0.1.26-alpha.13.json": "{}",
    });
    git(clone, "checkout", "-q", "main");
    const moved = commit("feat: merged during the review", { "src.txt": "5" });
    git(clone, "update-ref", "refs/remotes/origin/main", moved);
    const notesOnly = resolve(clone, { CANDIDATE: review });
    expect(notesOnly.status, notesOnly.stderr).toBe(0);
    expect(notesOnly.outputs).toMatchObject({ source_commit: review, version: "0.1.26-alpha.7" });
    // A candidate that changes code is refused, and so is anything but a pushed commit id.
    git(clone, "checkout", "-q", "-b", "fm/sneaky", review);
    const code = commit("docs(release-notes): review, and a fix", { "src.txt": "6" });
    git(clone, "checkout", "-q", "main");
    refusedWith(
      resolve(clone, { CANDIDATE: code }),
      /changes more than release notes since main's [0-9a-f]{40} \(src\.txt\)/,
    );
    git(clone, "checkout", "-q", "fm/sneaky");
    const wide = commit("chore: and much more", {
      ...Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [`${name}.txt`, name])),
    });
    git(clone, "checkout", "-q", "main");
    refusedWith(
      resolve(clone, { CANDIDATE: wide }),
      /\(a\.txt b\.txt c\.txt d\.txt e\.txt and 1 more\)/,
    );
    refusedWith(resolve(clone, { CANDIDATE: review.slice(0, 12) }), /not a full commit id/);
    refusedWith(resolve(clone, { CANDIDATE: "fm/release-review" }), /not a full commit id/);
    refusedWith(resolve(clone, { CANDIDATE: "f".repeat(40) }), /on no branch of the repository/);
    // A live alpha needs one; a rehearsal may build the checked-out commit.
    refusedWith(resolve(clone, {}), /a live alpha releases a candidate/);
    expect(resolve(clone, { DRY_RUN: "true" }).outputs.source_commit).toBe(moved);
  });

  it("numbers an alpha from the newest stable tag and the run, the next minor after a breaking change", () => {
    const { clone, commit, head } = fixture();
    const alpha = resolve(clone, { CANDIDATE: head, RUN_NUMBER: "312" });
    expect(alpha.status, alpha.stderr).toBe(0);
    expect(alpha.outputs).toEqual({
      channel: "alpha",
      dry_run: "false",
      source_commit: head,
      version: "0.1.26-alpha.312",
      bundle_version: "0.1.26",
      tag_name: "v0.1.26-alpha.312",
      ...publicNames("0.1.26-alpha.312", head),
      cask_token: CASK_TOKENS.alpha,
      old_cask: "false",
      ...oldNames("0.1.26-alpha.312"),
      prerelease: "true",
      promoted_from: "",
      highlights: "",
    });
    expect(alpha.outputs.public_tag).toBe("infinitary-alpha-v0.1.26-alpha.312");
    expect(isAlphaVersion(alpha.outputs.version as string)).toBe(true);
    // Later runs sort later: alpha.10 is newer than alpha.9.
    const ninth = resolve(clone, { CANDIDATE: head, RUN_NUMBER: "9" });
    const tenth = resolve(clone, { CANDIDATE: head, RUN_NUMBER: "10" });
    expect(
      compareSemver(tenth.outputs.version as string, ninth.outputs.version as string),
    ).toBeGreaterThan(0);
    // Only bare stable tags number a release.
    git(clone, "tag", "v9.9.9-beta.1");
    git(clone, "tag", "infinitary-v9.0.0");
    expect(resolve(clone, { CANDIDATE: head }).outputs.version).toBe("0.1.26-alpha.7");
    // A newer stable moves the line; a breaking change since it takes the next minor.
    git(clone, "tag", "v0.1.26", head);
    expect(resolve(clone, { CANDIDATE: head }).outputs.version).toBe("0.1.27-alpha.7");
    const breaking = commit("feat(cards)!: drop the old card shape", { "src.txt": "7" });
    git(clone, "update-ref", "refs/remotes/origin/main", breaking);
    expect(resolve(clone, { CANDIDATE: breaking }).outputs.version).toBe("0.2.0-alpha.7");
    // INF-228 F2: the actual squash-summary owner keeps the release reader's footer reachable.
    const footer = commit(
      `fix: x\n\n${presentationCommitMessage({
        whatChanged: ["Move saved data to the new folder."],
        projectText: "BREAKING CHANGE: saved data moves",
      })}`,
      { "src.txt": "8" },
    );
    git(clone, "tag", "v0.2.0", breaking);
    git(clone, "update-ref", "refs/remotes/origin/main", footer);
    expect(resolve(clone, { CANDIDATE: footer }).outputs.version).toBe("0.3.0-alpha.7");
    // A rehearsal may run from any branch; a live alpha comes from main.
    expect(
      resolve(clone, { DRY_RUN: "true", REF: "refs/heads/fm/x", RUN_NUMBER: "8" }).outputs.version,
    ).toBe("0.3.0-alpha.8");
    for (const [env, reason] of [
      [{ CANDIDATE: footer, REF: "refs/heads/fm/x" }, /a live alpha is requested from main/],
      [{ CANDIDATE: footer, PROMOTE: "0.1.26-alpha.13" }, /promote is for stable/],
      [{ CANDIDATE: footer, HIGHLIGHTS: "lead-change" }, /highlights are for stable/],
      [{ CANDIDATE: footer, RUN_NUMBER: "0" }, /not a positive whole number/],
      [{ CHANNEL: "beta" }, /neither stable nor alpha/],
    ] as const) {
      refusedWith(resolve(clone, env), reason);
    }
  });

  // The old-cask switch (FI3-1780 step 10; steps 13 and 14 list a channel):
  // only a channel the workflow commit's switch file lists also publishes
  // under Firstmate 3000's cask.
  it("switches Firstmate 3000's cask only for a channel the switch file lists", () => {
    const { clone, head } = fixture();
    expect(resolve(clone, { CANDIDATE: head }).outputs.old_cask).toBe("false");
    mkdirSync(join(clone, "packaging"), { recursive: true });
    writeFileSync(
      join(clone, "packaging", "old-cask-switch.json"),
      JSON.stringify({ schemaVersion: 1, channels: ["alpha"] }),
    );
    const alpha = resolve(clone, { CANDIDATE: head });
    expect(alpha.status, alpha.stderr).toBe(0);
    expect(alpha.outputs).toMatchObject({ old_cask: "true", ...oldNames("0.1.26-alpha.7") });
    expect(alpha.outputs.old_public_tag).toBe("firstmate-3000-alpha-v0.1.26-alpha.7");
    expect(resolve(clone, { CHANNEL: "stable", DRY_RUN: "true" }).outputs.old_cask).toBe("false");
    // The repository's own switch file lists alpha (step 13, INF-35) and
    // stable (step 14, INF-36): both of Firstmate 3000's casks move to Infinitary.
    expect(
      JSON.parse(readFileSync(join(root, "packaging", "old-cask-switch.json"), "utf8")),
    ).toEqual({ schemaVersion: 1, channels: ["alpha", "stable"] });
  });

  it("promotes a published alpha newer than the latest stable on the alpha's own commit, with the captain's picks and no pull request", () => {
    const HIGHLIGHTS = "lead-change, second-change,third-change";
    for (const alpha of ["0.1.26-alpha.13", "0.1.26-alpha.12"]) {
      const { clone } = fixture();
      const commit = git(clone, "rev-parse", `v${alpha}^{commit}`);
      const promoted = resolve(clone, { CHANNEL: "stable", PROMOTE: alpha, HIGHLIGHTS });
      expect(promoted.status, promoted.stderr).toBe(0);
      expect(promoted.outputs).toEqual({
        channel: "stable",
        dry_run: "false",
        source_commit: commit,
        version: "0.1.26",
        bundle_version: "0.1.26",
        tag_name: "v0.1.26",
        ...publicNames("0.1.26", commit),
        cask_token: CASK_TOKENS.stable,
        old_cask: "false",
        ...oldNames("0.1.26"),
        prerelease: "false",
        promoted_from: alpha,
        highlights: "lead-change,second-change,third-change",
      });
      expect(promoted.outputs.public_tag).toBe("infinitary-v0.1.26");
      // The release tags that same commit; promoting it again retries the
      // same promotion, and any other alpha of that version is refused.
      git(clone, "tag", "v0.1.26", commit);
      expect(
        resolve(clone, { CHANNEL: "stable", PROMOTE: alpha, HIGHLIGHTS }).outputs.source_commit,
      ).toBe(commit);
      const other = alpha.endsWith(".13") ? "0.1.26-alpha.12" : "0.1.26-alpha.13";
      refusedWith(
        resolve(clone, { CHANNEL: "stable", PROMOTE: other, HIGHLIGHTS }),
        /already released/,
      );
    }
    // A stable rehearsal may build the checked-out commit as the next stable,
    // and keep the alpha reviews' ranks.
    const { clone, head } = fixture();
    expect(resolve(clone, { CHANNEL: "stable", DRY_RUN: "true" }).outputs).toMatchObject({
      source_commit: head,
      version: "0.1.26",
      promoted_from: "",
      highlights: "",
    });
  });

  it.each([
    [{ REF: "refs/heads/fm/x" }, /a promotion is requested from main/],
    [{ PROMOTE: "0.1.26" }, /not an alpha version/],
    [{ PROMOTE: "0.1.26-alpha.99" }, /is not published/],
    [{ PREPARE: "newer-stable" }, /not newer than the latest stable, 0\.1\.27/],
    [{ PREPARE: "no-feat-fix" }, /nothing to release/],
    [{ PROMOTE: "" }, /a stable promotes a published alpha/],
    [{ CANDIDATE: "c".repeat(40) }, /candidate is for alpha/],
    [{ HIGHLIGHTS: "" }, /a stable ships the highlights the captain picked on its card/],
    [{ HIGHLIGHTS: "lead-change,Second" }, /not one to three entry ids/],
    [{ HIGHLIGHTS: "one-a,two-b,three-c,four-d" }, /not one to three entry ids/],
    [{ HIGHLIGHTS: "one-a,two-b,one-a" }, /name a change twice/],
  ])("refuses the stable promotion %j", (env, reason) => {
    const { clone, commit } = fixture();
    const { PREPARE, ...rest } = {
      HIGHLIGHTS: "lead-change,second-change,third-change",
      ...env,
    } as Record<string, string>;
    let promote = "0.1.26-alpha.13";
    if (PREPARE === "newer-stable") {
      git(clone, "tag", "v0.1.27");
    } else if (PREPARE === "no-feat-fix") {
      git(clone, "tag", "-f", "v0.1.25");
      commit("chore: x");
      git(clone, "tag", "v0.1.26-alpha.14");
      promote = "0.1.26-alpha.14";
    }
    refusedWith(resolve(clone, { CHANNEL: "stable", PROMOTE: promote, ...rest }), reason);
  });

  /**
   * Step 7 of the Infinitary rename (FI3-1780's plan): a repository that
   * starts again from one parentless commit has no tag to number from, so it
   * numbers from the record of past releases, above every version either
   * channel published, until it tags a stable of its own.
   */
  it("numbers a fresh history above every version its record of past releases names", () => {
    const clone = join(scratchDir("infinitary-release-resolve-"), "clone");
    mkdirSync(clone);
    git(clone, "init", "-q", "-b", "main");
    const commit = (subject: string, files: Record<string, string> = {}) => {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(clone, path)), { recursive: true });
        writeFileSync(join(clone, path), content);
      }
      git(clone, "add", "-A");
      git(clone, "commit", "-q", "--allow-empty", "-m", subject);
      const head = git(clone, "rev-parse", "HEAD");
      git(clone, "update-ref", "refs/remotes/origin/main", head);
      return head;
    };
    const archive = (stable: string, alpha: string) =>
      JSON.stringify({ schema: 1, repository: "owner/archived", stable, alpha, releases: {} });
    const root = commit("chore: initialize from the archived tree", {
      "src.txt": "0",
      "release-notes/archive.json": archive("0.4.1", "0.4.1-alpha.78"),
    });
    expect(git(clone, "rev-list", "--count", "--all")).toBe("1");
    // Run numbers start again in a new repository, and still sort above the archive.
    const first = resolve(clone, { CANDIDATE: root, RUN_NUMBER: "1" });
    expect(first.status, first.stderr).toBe(0);
    expect(first.outputs).toMatchObject({ source_commit: root, version: "0.4.2-alpha.1" });
    // An alpha the archived history cut past its last stable lifts the line too.
    commit("chore: an alpha past the stable", {
      "release-notes/archive.json": archive("0.4.1", "0.4.2-alpha.80"),
    });
    const past = commit("fix: something");
    expect(resolve(clone, { CANDIDATE: past, RUN_NUMBER: "2" }).outputs.version).toBe(
      "0.4.3-alpha.2",
    );
    // A breaking change anywhere in this history takes the next minor.
    const breaking = commit("feat(cards)!: a new card shape");
    expect(resolve(clone, { CANDIDATE: breaking, RUN_NUMBER: "3" }).outputs.version).toBe(
      "0.5.0-alpha.3",
    );
    // A stable promotes past the archived stable, with no tag of it here.
    git(clone, "tag", "v0.5.0-alpha.3", breaking);
    const promoted = resolve(clone, {
      CHANNEL: "stable",
      PROMOTE: "0.5.0-alpha.3",
      HIGHLIGHTS: "lead-change",
    });
    expect(promoted.status, promoted.stderr).toBe(0);
    expect(promoted.outputs).toMatchObject({ source_commit: breaking, version: "0.5.0" });
    // Once this history tags its own stable, it numbers from that.
    git(clone, "tag", "v0.5.0", breaking);
    const after = commit("fix: after the first stable");
    expect(resolve(clone, { CANDIDATE: after, RUN_NUMBER: "4" }).outputs.version).toBe(
      "0.5.1-alpha.4",
    );
    // A version at or below an archived one is refused, whatever tag says otherwise.
    git(clone, "tag", "-d", "v0.5.0");
    git(clone, "tag", "-d", "v0.5.0-alpha.3");
    const stray = commit("chore: back to the archived line", {
      "release-notes/archive.json": archive("0.4.1", "0.4.1-alpha.78"),
    });
    git(clone, "tag", "v0.4.0", stray);
    const low = commit("fix: numbered from a stray old tag");
    refusedWith(
      resolve(clone, { CANDIDATE: low, RUN_NUMBER: "5" }),
      /0\.4\.1-alpha\.5 is not newer than 0\.4\.1, which the archived history already published/,
    );
  });

  it("opens no pull request: no release proposal workflow, its configuration or its branch script remains", () => {
    for (const retired of [
      ".github/workflows/release-please.yml",
      "release-please-config.json",
      ".release-please-manifest.json",
      "scripts/promote-alpha.sh",
    ]) {
      expect(existsSync(join(root, retired)), retired).toBe(false);
    }
    for (const name of [
      "ci.yml",
      "release.yml",
      "mac-installer.yml",
      "mac-update.yml",
      "verify.yml",
    ]) {
      const workflow = loadYamlFile(`.github/workflows/${name}`) as {
        on: Record<string, unknown>;
        permissions?: Record<string, string>;
      };
      expect(workflow.permissions?.["pull-requests"], name).toBeUndefined();
      expect(read(`.github/workflows/${name}`), name).not.toMatch(
        /gh pr create|create-pull-request/,
      );
    }
  });
});

/**
 * The signed channel workflow (docs/alpha.md "The signed channel
 * workflow"): one source commit through two verify profiles and one signing
 * job, and a dry run of either profile that publishes nothing - so a release
 * is never the first time its later stages execute (v0.1.0 signed, then
 * failed the first gate after signing that had never run). Read from the
 * parsed workflows through GitHub's own expression evaluator.
 */
describe("the signed channel workflow", () => {
  type Step = {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  };
  type Job = {
    if?: string;
    needs?: string | string[];
    uses?: string;
    with?: Record<string, string>;
    secrets?: unknown;
    "runs-on"?: string;
    strategy?: { matrix: Record<string, string> };
    env?: Record<string, string>;
    outputs?: Record<string, string>;
    permissions?: Record<string, string>;
    steps?: Step[];
  };
  type Workflow = {
    on: Record<string, { inputs?: Record<string, Record<string, unknown>> } | null>;
    concurrency: { group: string; "cancel-in-progress": string };
    env: Record<string, string>;
    permissions: Record<string, string>;
    jobs: Record<string, Job>;
  };
  const release = loadYamlFile(".github/workflows/release.yml") as Workflow;
  const verify = loadYamlFile(".github/workflows/verify.yml") as Workflow;
  const jobOf = (workflow: Workflow, id: string): Job => {
    const job = workflow.jobs[id];
    if (!job) throw new Error(`no job "${id}"`);
    return job;
  };
  // INF-1716: the signing job ends at the checked disk image, and the
  // publication job continues from its handoff; a release's operations are
  // the signing job's steps followed by the publication job's.
  const signingSteps = jobOf(release, "release").steps ?? [];
  const publishSteps = jobOf(release, "publish").steps ?? [];
  const steps = [...signingSteps, ...publishSteps];
  const step = (id: string) => {
    const found = steps.find((candidate) => (candidate.id ?? candidate.name) === id);
    if (!found) throw new Error(`release.yml's signing and publication jobs have no step "${id}"`);
    return found;
  };
  const lane = jobOf(verify, "lane");
  /** The lanes verify runs for a profile, through its own matrix expression. */
  const lanes = (profile?: string) =>
    workflowValue(lane.strategy?.matrix.lane ?? "", { inputs: profile ? { profile } : {} });

  // INF-621: prove the full Mac job on a disposable runner without moving
  // the live MAC_RUNNER variable or changing Linux's placement.
  it("routes an isolated verification to its requested Mac without changing normal runs", () => {
    for (const event of ["workflow_call", "workflow_dispatch"]) {
      expect(verify.on[event]?.inputs?.mac_runner).toMatchObject({
        required: false,
        type: "string",
      });
    }
    const runner = (name: string, macRunner: string, configuredRunner: string) =>
      workflowValue(lane["runs-on"] ?? "", {
        matrix: { lane: name },
        inputs: { mac_runner: macRunner },
        vars: { MAC_RUNNER: configuredRunner },
      });
    expect(runner("mac", "mini-mac-inf621-proof", "mini-mac")).toBe("mini-mac-inf621-proof");
    expect(runner("mac", "", "mini-mac")).toBe("mini-mac");
    expect(runner("mac", "", "")).toBe("macos-15");
    expect(runner("linux-checks", "mini-mac-inf621-proof", "mini-mac")).toBe("ubuntu-latest");
  });

  it("runs each profile's lanes as one matrix, so an omitted lane is absent from the run, never skipped", () => {
    expect(Object.keys(verify.jobs)).toEqual(["linux-e2e", "installer", "lane"]);
    expect(verify.jobs["linux-e2e"]).toMatchObject({
      uses: "./.github/workflows/source-journeys.yml",
      with: { ref: "${{ inputs.ref || github.ref }}", suite: "full" },
    });
    expect(lanes("stable")).toEqual(["linux-checks", "mac"]);
    expect(lanes()).toEqual(["linux-checks", "mac"]);
    expect(lanes("alpha")).toEqual(["linux-checks", "mac"]);
    // Only the reusable verification call and its downstream signing job are
    // conditional. The lane jobs themselves never turn a skip into a pass.
    expect(jobOf(release, "resolve").if).toBeUndefined();
    expect(workflowValue(lane.if ?? "", { inputs: {} })).toBe(true);
    expect(workflowValue(lane.if ?? "", { inputs: { installer_only: true } })).toBe(false);
    expect(workflowValue(jobOf(verify, "installer").if ?? "", { inputs: {} })).toBe(false);
    expect(
      workflowValue(jobOf(verify, "installer").if ?? "", { inputs: { installer_only: true } }),
    ).toBe(true);
    expect(Object.keys(release.jobs)).toEqual([
      "resolve",
      "notes",
      "verify",
      "linux",
      "phone",
      "rehearse",
      "release",
      "update",
      "publish",
    ]);
    const runner = (name: string) =>
      workflowValue(lane["runs-on"] ?? "", { matrix: { lane: name }, inputs: {}, vars: {} });
    expect(runner("linux-checks")).toBe("ubuntu-latest");
    expect(runner("mac")).toBe("macos-15");
    // What each lane runs, by its own step conditions on a passing run: the
    // linux-checks lane is exactly the PR gate, every probe included where
    // the PR gate runs only those a change reaches; the mac lane the full suite.
    const runsIn = (name: string) =>
      (lane.steps ?? [])
        .filter(
          (candidate) =>
            candidate.run &&
            (candidate.if === undefined ||
              workflowValue(candidate.if, {
                matrix: { lane: name },
                inputs: {},
                steps: Object.fromEntries(
                  (lane.steps ?? []).flatMap(({ id }) =>
                    id ? [[id, { outcome: "success" }]] : [],
                  ),
                ),
              }) === true),
        )
        .map((candidate) => candidate.run);
    const prGate = ciJobs().flatMap(({ runs }) =>
      runs.map((run) => (/^pnpm test(:probes)? /.test(run) ? "pnpm test" : run)),
    );
    expect(runsIn("linux-checks").toSorted()).toEqual([...new Set(prGate)].toSorted());
    expect(runsIn("mac")).toEqual(
      expect.arrayContaining([
        'mac_tests="$(node scripts/mac-unit-tests.ts)"\npnpm test $mac_tests\n',
        "pnpm build",
        "pnpm exec playwright test --workers=50% $ONLY",
        "pnpm replay:gate",
      ]),
    );
    expect(runsIn("mac")).not.toContain("pnpm typecheck");
    // The release's summary names each profile's lanes and what it omits,
    // from the same profiles.
    const summary = step("Summarize").env ?? {};
    for (const required of ["true", "false"]) {
      const context = { needs: { resolve: { outputs: { verify_required: required } } } };
      expect(workflowValue(summary.LANES ?? "", context)).toBe(
        required === "true" ? "linux-checks, linux-e2e, mac" : "none",
      );
      expect(workflowValue(summary.OMITTED ?? "", context)).toMatch(
        required === "true" ? /^none$/ : /inherited from the published alpha, not passed/,
      );
    }
  });

  // Captain's accepted INF-1258 mac-unit-only option: all files still run
  // on Linux, and Mac retains every reviewed native/mixed file. Discover via
  // the real runner rather than matching strings in test source. --filesOnly
  // never imports a test or enables the opt-in Keychain probes.
  it("keeps the complete Linux suite and selects only the reviewed Mac files", () => {
    const unit = (lane.steps ?? []).find((candidate) => candidate.id === "unit");
    expect(unit?.run).toBe('mac_tests="$(node scripts/mac-unit-tests.ts)"\npnpm test $mac_tests\n');
    const linuxTests = (lane.steps ?? []).filter(
      (candidate) =>
        candidate.run === "pnpm test" &&
        workflowValue(candidate.if ?? "", {
          matrix: { lane: "linux-checks" },
          steps: { install: { outcome: "success" } },
        }) === true,
    );
    expect(linuxTests).toHaveLength(1);
    const filters = execFileSync(process.execPath, ["scripts/mac-unit-tests.ts"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    expect(filters).toEqual([...MAC_UNIT_FILES]);
    const discover = (files: string[]) => {
      const result = spawnSync(
        "pnpm",
        ["exec", "vitest", "list", "--filesOnly", ...files, "--json"],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      return (JSON.parse(result.stdout) as { file: string; projectName: string }[]).map(
        ({ file, projectName }) => ({ file: file.slice(root.length + 1), projectName }),
      );
    };
    const linux = discover([]);
    const mac = discover(filters);
    expect(mac.map(({ file }) => file).sort()).toEqual([...MAC_UNIT_FILES].sort());
    expect(new Set(mac.map(({ file }) => file)).size).toBe(MAC_UNIT_FILES.length);
    // Every Mac file stays in its existing cohort and also runs on Linux;
    // Linux has no filter, so new platform-independent files need no list edit.
    expect(linux).toEqual(expect.arrayContaining(mac));
    expect(linux.length).toBeGreaterThan(mac.length);
  }, 15_000);

  it("signs only after full verification or explicitly inherited verification, never after a failed lane", () => {
    for (const required of ["true", "false", ""]) {
      for (const result of ["success", "failure", "cancelled", "skipped"]) {
        const needs = {
          resolve: { result: "success", outputs: { verify_required: required } },
          notes: { result: "success" },
          verify: { result },
          linux: { result: "success" },
          rehearse: { result: required === "true" ? "success" : "skipped" },
          phone: { result: "success" },
        };
        expect(workflowValue(jobOf(release, "verify").if ?? "", { needs })).toBe(
          required === "true",
        );
        expect(workflowValue(jobOf(release, "release").if ?? "", { needs })).toBe(
          (required === "true" && result === "success") ||
            (required === "false" && result === "skipped"),
        );
        // INF-1900: a failed update rehearsal stops the release before signing.
        for (const rehearse of ["failure", "cancelled", ""]) {
          expect(
            workflowValue(jobOf(release, "release").if ?? "", {
              needs: { ...needs, rehearse: { result: rehearse } },
            }),
          ).toBe(false);
        }
        // INF-1649: a release with no phone build that keeps changing things on it never signs.
        for (const phone of ["failure", "cancelled", "skipped"]) {
          expect(
            workflowValue(jobOf(release, "release").if ?? "", {
              needs: { ...needs, phone: { result: phone } },
            }),
          ).toBe(false);
        }
        // A release whose notes were not checked never signs, whatever else passed.
        for (const notes of ["failure", "cancelled", "skipped"]) {
          expect(
            workflowValue(jobOf(release, "release").if ?? "", {
              needs: { ...needs, notes: { result: notes } },
            }),
          ).toBe(false);
        }
      }
    }
  });

  // INF-1716, the captain's "After the disk-image check": the real Mac signs
  // through the checked disk image, and one existing virtual Mac publishes
  // from the signing job's handoff, only once that job succeeded.
  it("publishes only after the signing job succeeded, in one virtual Mac, from its handoff", () => {
    const publish = jobOf(release, "publish");
    expect(publish.needs).toEqual(["resolve", "release", "update"]);
    expect(publish["runs-on"]).toBe("mini-mac-virtual");
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      for (const cancelled of [false, true]) {
        // INF-1900: an alpha publishes only after its update check passed on
        // both chips; a stable inherits its alpha's and skips it.
        for (const [required, update, publishes] of [
          ["true", "success", true],
          ["true", "failure", false],
          ["true", "skipped", false],
          ["false", "skipped", true],
          ["false", "success", false],
        ] as const) {
          const needs = {
            resolve: { result: "success", outputs: { verify_required: required } },
            release: { result },
            update: { result: update },
          };
          expect(
            workflowValue(
              publish.if ?? "",
              { needs },
              { success: result === "success", failure: false, always: true, cancelled },
            ),
            `${result}${cancelled ? ", run cancelled" : ""}, verify ${required}, update ${update}`,
          ).toBe(result === "success" && !cancelled && publishes);
        }
      }
    }
    // The update check runs on the signing job's handoff once it succeeded,
    // only where verification is required.
    const update = jobOf(release, "update");
    expect(update.needs).toEqual(["resolve", "release"]);
    for (const required of ["true", "false"]) {
      for (const result of ["success", "failure", "skipped"]) {
        const needs = {
          resolve: { result: "success", outputs: { verify_required: required } },
          release: { result },
        };
        expect(
          workflowValue(
            update.if ?? "",
            { needs },
            { success: result === "success", failure: false, always: true, cancelled: false },
          ),
        ).toBe(required === "true" && result === "success");
      }
    }
    // Its checkout keeps no credential, and it holds only the access its moves need.
    expect(publishSteps[0]).toMatchObject({
      uses: "actions/checkout@v4",
      with: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        ref: "${{ needs.resolve.outputs.source_commit }}",
        "persist-credentials": false,
      },
    });
    expect(publish.permissions).toEqual({ contents: "write", actions: "read" });
    // The handoff is stored as is, one artifact per producer attempt, and
    // fetched by the immutable id the signing job recorded.
    const upload = step("handoff-upload");
    expect(upload).toMatchObject({
      uses: "actions/upload-artifact@v4",
      with: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        name: "${{ steps.handoff.outputs.name }}",
        "compression-level": 0,
        "if-no-files-found": "error",
      },
    });
    const fetch = publishSteps.find((candidate) => candidate.name === "Fetch the checked files");
    expect(fetch).toMatchObject({
      uses: "actions/download-artifact@v4",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      with: { "artifact-ids": "${{ needs.release.outputs.handoff_id }}" },
    });
    expect(publishSteps.indexOf(fetch as Step)).toBeLessThan(
      publishSteps.indexOf(step("handoff-check")),
    );
    // Nothing that publishes or holds a publication credential comes before the validation.
    const checked = publishSteps.indexOf(step("handoff-check"));
    for (const candidate of publishSteps.slice(0, checked))
      expect(
        PUBLISHES.test(candidate.run ?? "") ||
          PUBLICATION_TOKEN.test(JSON.stringify(candidate.env ?? {})),
        candidate.name,
      ).toBe(false);
    const outputs = jobOf(release, "release").outputs ?? {};
    expect(outputs).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      handoff_id: "${{ steps.handoff-upload.outputs.artifact-id }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      handoff_name: "${{ steps.handoff.outputs.name }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      handoff_manifest: "${{ steps.handoff.outputs.manifest }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      sha256: "${{ steps.handoff.outputs.sha256 }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      direct: "${{ steps.handoff.outputs.direct }}",
    });
    // The signing job keeps its keychain cleanup on every exit, after its handoff.
    const cleanup = signingSteps.at(-1);
    expect(cleanup?.name).toBe("Remove the signing keychain");
    expect(cleanup?.if).toBe("always()");
    expect(signingSteps.indexOf(step("handoff-upload"))).toBeLessThan(signingSteps.length - 1);
  });

  /**
   * The handoff's two ends as Actions runs them: the signing job's step
   * writes the files and manifest, the artifact carries them unchanged, and
   * the publication job's step accepts them or refuses before any effect.
   * Readings from release run 40651382197, alpha 0.6.1-alpha.30, whose
   * Linux files the release's own renderer lays out here.
   */
  describe("the handoff between the signing and publication jobs", () => {
    const version = "0.6.1-alpha.30";
    const source = "2e1588dc71ecc13f6695114b0c852049c4d3fe7c";
    const workflowSha = "28d2fcb16ddcd5bffe26db7587e084d212d253b6";
    const runId = "40651382197";
    const bytes = readFileSync(join(root, "packaging/build/icon.png"));
    const resolveOutputs = (overrides: Record<string, string> = {}) => ({
      channel: "alpha",
      dry_run: "false",
      source_commit: source,
      version,
      tag_name: `v${version}`,
      zip_name: `Infinitary-${version}-universal.zip`,
      old_cask: "true",
      ...overrides,
    });
    const run = (script: string, env: Record<string, string>) =>
      spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...env },
      });
    const outputsOf = (file: string) =>
      Object.fromEntries(
        readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
    const jobEnv = (id: string, resolve: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(jobOf(release, id).env ?? {}).map(([name, value]) => [
          name,
          workflowString(value, { needs: { resolve: { outputs: resolve } } }),
        ]),
      );
    const stepEnv = (found: Step, contexts: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(found.env ?? {}).map(([name, value]) => [
          name,
          workflowString(value, contexts),
        ]),
      );

    /** The signing job's handoff step on a run's files; its outputs and the job's. */
    const produce = (options: {
      dryRun?: boolean;
      direct?: boolean;
      adopted?: boolean;
      attempt?: string;
    }) => {
      const { dryRun = false, direct = true, adopted = false, attempt = "1" } = options;
      const temp = scratchDir("infinitary-handoff-signing-");
      const resolve = resolveOutputs({ dry_run: String(dryRun) });
      const env = jobEnv("release", resolve);
      mkdirSync(join(temp, "dist"));
      const distZip = join(temp, "dist", env.ZIP_NAME ?? "");
      writeFileSync(distZip, bytes);
      // A retry's record keeps the bytes published first, which differ from its rebuild.
      const recorded = adopted
        ? join(temp, "private-release", "published", env.ZIP_NAME ?? "")
        : distZip;
      if (adopted) {
        mkdirSync(dirname(recorded), { recursive: true });
        writeFileSync(recorded, Buffer.concat([bytes, Buffer.from("published first")]));
      }
      const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
      const packages = join(temp, "linux-packages");
      mkdirSync(packages);
      for (const name of [
        `infinitary-${version}-linux-amd64.deb`,
        `infinitary-${version}-linux-x86_64.rpm`,
        `Infinitary-${version}-linux-x86_64.AppImage`,
      ])
        writeFileSync(join(packages, name), bytes);
      execFileSync(process.execPath, [
        join(root, "scripts/linux-recipes.ts"),
        "release",
        "--version",
        version,
        "--packages",
        packages,
        "--out",
        join(temp, "linux-release"),
      ]);
      const builtDmg = dryRun || direct;
      const dmg = join(temp, "dmg", env.DMG_NAME ?? "");
      if (builtDmg) {
        mkdirSync(dirname(dmg));
        writeFileSync(dmg, Buffer.concat([bytes, Buffer.from("disk image")]));
      }
      const steps = {
        private: dryRun ? {} : { outputs: { zip: recorded, sha256: sha(recorded) } },
        checksum: { outputs: { sha256: sha(distZip) } },
        dmg: { outputs: builtDmg ? { path: dmg } : {} },
        visibility: { outputs: dryRun ? {} : { direct: String(direct) } },
      };
      const output = join(temp, "output");
      const result = run(step("handoff").run ?? "", {
        ...env,
        ...stepEnv(step("handoff"), {
          steps,
          needs: { resolve: { outputs: resolve } },
          github: { run_id: runId, run_attempt: attempt, sha: workflowSha },
        }),
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
        dist_zip: distZip,
      });
      expect(result.status, result.stderr).toBe(0);
      const handoff = outputsOf(output);
      const job = Object.fromEntries(
        Object.entries(jobOf(release, "release").outputs ?? {}).map(([name, value]) => [
          name,
          workflowString(value, {
            steps: {
              handoff: { outputs: handoff },
              "handoff-upload": { outputs: { "artifact-id": "4711" } },
            },
          }),
        ]),
      );
      return { temp, handoff, job, resolve, recorded, dmg, linux: join(temp, "linux-release") };
    };

    /** The artifact as the publication job fetches it, then its validation step. */
    const consume = (
      produced: ReturnType<typeof produce>,
      options: {
        alter?: (download: string) => void;
        resolve?: Record<string, string>;
        job?: Record<string, string>;
        github?: Record<string, string>;
      } = {},
    ) => {
      const temp = scratchDir("infinitary-handoff-publication-");
      const download = join(temp, "handoff-download");
      cpSync(produced.handoff.path ?? "", download, { recursive: true });
      options.alter?.(download);
      const resolve = options.resolve ?? produced.resolve;
      const contexts = {
        needs: {
          resolve: { outputs: resolve },
          release: { outputs: { ...produced.job, ...options.job } },
        },
        github: { run_id: runId, run_attempt: "1", sha: workflowSha, ...options.github },
      };
      const output = join(temp, "output");
      const result = run(step("handoff-check").run ?? "", {
        ...jobEnv("publish", resolve),
        ...stepEnv(step("handoff-check"), contexts),
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
      });
      return { temp, result, outputs: existsSync(output) ? outputsOf(output) : {} };
    };
    const accepted = (consumed: ReturnType<typeof consume>) => {
      expect(consumed.result.status, consumed.result.stderr).toBe(0);
      return consumed.outputs;
    };
    const refused = (consumed: ReturnType<typeof consume>, reason: RegExp) => {
      expect(consumed.result.status).not.toBe(0);
      expect(consumed.result.stderr).toMatch(/Refusing the handoff: /);
      expect(consumed.result.stderr).toMatch(reason);
      // Nothing was laid out for publication to read.
      expect(consumed.outputs).toEqual({});
      expect(existsSync(join(consumed.temp, "handoff"))).toBe(false);
    };

    it("hands publication the record's zip, the checked image and the finalized Linux files, byte for byte", () => {
      const produced = produce({ adopted: true });
      expect(produced.job.handoff_id).toBe("4711");
      expect(produced.job.handoff_name).toBe("release-handoff-1");
      expect(produced.job.direct).toBe("true");
      const outputs = accepted(consume(produced));
      // The previously published zip wins over the retry's rebuild.
      expect(readFileSync(outputs.zip ?? "")).toEqual(readFileSync(produced.recorded));
      expect(produced.job.sha256).toBe(
        createHash("sha256").update(readFileSync(produced.recorded)).digest("hex"),
      );
      expect(readFileSync(outputs.dmg ?? "")).toEqual(readFileSync(produced.dmg));
      const linux = join(dirname(outputs.zip ?? ""), "..", "linux-release");
      expect(readdirSync(linux).sort()).toEqual(readdirSync(produced.linux).sort());
      for (const name of readdirSync(produced.linux))
        expect(readFileSync(join(linux, name)), name).toEqual(
          readFileSync(join(produced.linux, name)),
        );
      // Only the allowlist travels: no app, workspace or environment.
      expect(readdirSync(produced.handoff.path ?? "").sort()).toEqual([
        "dmg",
        "linux",
        "manifest.json",
        "zip",
      ]);
      expect(readFileSync(join(produced.handoff.path ?? "", "manifest.json"), "utf8")).not.toMatch(
        /secret|TOKEN|KEY/,
      );
    });

    it("hands no disk image without direct downloads, and a rehearsal's checked zip and image", () => {
      const homebrewOnly = accepted(consume(produce({ direct: false })));
      expect(homebrewOnly.dmg).toBe("");
      const rehearsal = produce({ dryRun: true });
      expect(rehearsal.job.direct).toBe("false");
      expect(accepted(consume(rehearsal)).dmg).toMatch(/mac-universal\.dmg$/);
    });

    it("lets a publication-only rerun reuse an earlier attempt's handoff, and refuses one from a later attempt", () => {
      const produced = produce({ attempt: "1" });
      expect(accepted(consume(produced, { github: { run_attempt: "2" } })).attempt).toBe("1");
      const rerun = produce({ attempt: "3" });
      expect(rerun.job.handoff_name).toBe("release-handoff-3");
      refused(consume(rerun, { github: { run_attempt: "2" } }), /attempt 3 is not of this run/);
      refused(consume(produced, { job: { handoff_name: "release-handoff-2" } }), /not attempt 1's/);
    });

    it.each([
      [
        "an altered zip",
        (dir: string) =>
          writeFileSync(join(dir, "zip", `Infinitary-${version}-universal.zip`), "altered"),
        /zip\/Infinitary-.* is not the file the signing job checked/,
      ],
      [
        "an altered image",
        (dir: string) =>
          writeFileSync(join(dir, "dmg", `Infinitary-${version}-mac-universal.dmg`), "altered"),
        /dmg\/.* is not the file/,
      ],
      [
        "a missing Linux file",
        (dir: string) => rmSync(join(dir, "linux", "SHA256SUMS")),
        /missing \["linux\/SHA256SUMS"\]/,
      ],
      [
        "an extra file",
        (dir: string) => writeFileSync(join(dir, "zip", "unlisted.zip"), "extra"),
        /extra \["zip\/unlisted\.zip"\]/,
      ],
      [
        "an edited manifest",
        (dir: string) =>
          writeFileSync(
            join(dir, "manifest.json"),
            readFileSync(join(dir, "manifest.json"), "utf8").replace(
              '"channel": "alpha"',
              '"channel": "stable"',
            ),
          ),
        /manifest is not the one the signing job recorded/,
      ],
    ])("refuses %s before any effect", (_name, alter, reason) => {
      refused(consume(produce({}), { alter }), reason);
    });

    it("refuses a handoff from another release, run or workflow revision", () => {
      const produced = produce({});
      refused(
        consume(produced, {
          resolve: resolveOutputs({
            version: "0.6.1-alpha.31",
            zip_name: "Infinitary-0.6.1-alpha.31-universal.zip",
          }),
        }),
        /its version is "0\.6\.1-alpha\.30"/,
      );
      refused(
        consume(produced, { resolve: resolveOutputs({ source_commit: "f".repeat(40) }) }),
        /its source is/,
      );
      refused(
        consume(produced, { resolve: resolveOutputs({ channel: "stable" }) }),
        /its channel is "alpha", not "stable"/,
      );
      refused(
        consume(produced, { resolve: resolveOutputs({ old_cask: "false" }) }),
        /its oldCask is true, not false/,
      );
      refused(consume(produced, { github: { run_id: "40651382198" } }), /its run is "40651382197"/);
      refused(consume(produced, { github: { sha: "e".repeat(40) } }), /its workflow is/);
      refused(consume(produced, { job: { direct: "false" } }), /its direct is true, not false/);
      refused(consume(produced, { job: { sha256: "0".repeat(64) } }), /its sha256 is/);
      refused(consume(produced, { job: { handoff_manifest: "" } }), /manifest is not the one/);
    });
  });

  it("holds every job that holds signing material behind the phone (INF-1649 review R3)", () => {
    const jobs = (release as { jobs: Record<string, { needs?: string | string[] }> }).jobs;
    const needsOf = (name: string): string[] => {
      const needs = jobs[name]?.needs ?? [];
      return typeof needs === "string" ? [needs] : needs;
    };
    const waitsFor = (name: string, target: string): boolean =>
      needsOf(name).some((need) => need === target || waitsFor(need, target));
    const signing = Object.keys(jobs).filter((name) =>
      /secrets: ?inherit|"secrets":"inherit"|secrets\.(MAC_DEVELOPER_ID|CSC_)/.test(
        JSON.stringify(jobs[name]),
      ),
    );
    expect(signing).toEqual(expect.arrayContaining(["release"]));
    for (const name of signing) expect(waitsFor(name, "phone"), name).toBe(true);
    // INF-1900: the update check and its rehearsal hold no signing material.
    expect(signing).not.toContain("rehearse");
    expect(signing).not.toContain("update");
  });

  it("inherits the published alpha's run, found by its number, only when both lanes passed in its latest attempt, and refuses the stable otherwise", async () => {
    const script = (jobOf(release, "resolve").steps ?? []).find(
      (candidate) => candidate.id === "verification",
    )?.with?.script;
    expect(typeof script).toBe("string");
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const execute = new AsyncFunction("core", "exec", "github", "context", "process", script);
    const url = "https://github.com/example/project/actions/runs/123";
    for (const scenario of [
      "alpha",
      "stable rehearsal without promotion",
      "eligible stable",
      "eligible stable from before the update check",
      "failed mac",
      "skipped mac",
      "pending mac",
      "legacy alpha without mac",
      "alpha without installed-update proof",
      "failed Intel proof from before the update check",
      "pending Apple silicon proof",
      "failed alpha run",
      "missing alpha run",
    ]) {
      const outputs: Record<string, string> = {};
      const failures: string[] = [];
      const summaries: string[] = [];
      const summary = {
        addHeading: () => summary,
        addRaw: (text: string) => {
          summaries.push(text);
          return summary;
        },
        write: async () => {},
      };
      // INF-1900: an alpha's update check on Apple silicon alone (Intel is
      // best effort), or the five-copy check on both chips an alpha released
      // before it passed instead.
      const legacy = scenario.endsWith("from before the update check");
      const updateCheck = legacy
        ? "Verify signed installer and updater"
        : "Update from the last published alpha";
      const jobs = [
        "verify / linux-checks",
        "verify / linux-e2e / journeys (1/2)",
        "verify / linux-e2e / journeys (2/2)",
        "verify / mac",
        `${updateCheck} / Apple silicon`,
        ...(legacy ? [`${updateCheck} / Intel`] : []),
      ]
        .filter(
          (name) =>
            scenario !== "alpha without installed-update proof" || !name.startsWith(updateCheck),
        )
        .filter((name) => scenario !== "legacy alpha without mac" || name !== "verify / mac")
        .map((name) => ({
          name,
          status:
            (scenario === "pending mac" && name.endsWith("mac")) ||
            (scenario === "pending Apple silicon proof" && name.endsWith("Apple silicon"))
              ? "in_progress"
              : "completed",
          conclusion:
            scenario === "failed Intel proof from before the update check" && name.endsWith("Intel")
              ? "failure"
              : name.endsWith("mac") && scenario === "failed mac"
                ? "failure"
                : name.endsWith("mac") && scenario === "skipped mac"
                  ? "skipped"
                  : "success",
        }));
      const listRuns = Symbol("runs");
      const listJobs = Symbol("jobs");
      await execute(
        {
          setOutput: (name: string, value: string) => {
            outputs[name] = value;
          },
          setFailed: (message: string) => failures.push(message),
          info: () => {},
          summary,
        },
        {},
        {
          rest: { actions: { listWorkflowRuns: listRuns, listJobsForWorkflowRun: listJobs } },
          paginate: async (method: symbol, parameters: Record<string, unknown>) => {
            if (method === listRuns) {
              // Dispatched from main, the alpha's run records main's commit, never
              // the candidate it built: it is found by number, not by commit.
              expect(parameters).toMatchObject({
                workflow_id: "release.yml",
                event: "workflow_dispatch",
                branch: "main",
              });
              expect(parameters.head_sha).toBeUndefined();
              const other = {
                id: 99,
                head_sha: "d".repeat(40),
                run_number: 14,
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/example/project/actions/runs/99",
              };
              if (scenario === "missing alpha run") return [other];
              return [
                other,
                {
                  id: 123,
                  head_sha: "c".repeat(40),
                  run_number: 13,
                  status: "completed",
                  conclusion: scenario === "failed alpha run" ? "failure" : "success",
                  html_url: url,
                },
              ];
            }
            expect(parameters.filter).toBe("latest");
            expect(parameters.run_id).toBe(123);
            return jobs;
          },
        },
        { repo: { owner: "example", repo: "project" } },
        {
          env: {
            CHANNEL: scenario === "alpha" ? "alpha" : "stable",
            PROMOTED_FROM:
              scenario === "alpha" || scenario === "stable rehearsal without promotion"
                ? ""
                : "1.2.3-alpha.13",
          },
        },
      );
      const inherited = scenario.startsWith("eligible stable");
      const refused =
        !inherited && !["alpha", "stable rehearsal without promotion"].includes(scenario);
      expect(outputs.required, scenario).toBe(inherited ? "false" : "true");
      expect(outputs.alpha_run, scenario).toBe(inherited ? url : "");
      expect(summaries.length, scenario).toBe(inherited ? 1 : 0);
      if (inherited) expect(summaries[0]).toContain("omitted, not passed here");
      expect(failures.length, scenario).toBe(refused ? 1 : 0);
      if (refused) expect(failures[0]).toContain("Alpha 1.2.3-alpha.13 cannot be promoted");
      console.log(
        JSON.stringify({
          scenario,
          verification: outputs.required === "true" ? ["linux-checks", "linux-e2e", "mac"] : [],
          alphaRun: outputs.alpha_run,
          refused: failures,
        }),
      );
    }
  });

  it("verifies, packages and publishes one source commit, and signs only after both lanes, starting at the build", () => {
    const resolve = jobOf(release, "resolve");
    // The resolver runs from the workflow's own commit, with every branch and
    // tag, and reads the candidate or the promoted alpha from git.
    expect(resolve.steps?.[0]).toMatchObject({
      uses: "actions/checkout@v4",
      with: { "fetch-depth": 0, "persist-credentials": false },
    });
    expect(resolve.steps?.[0]?.with?.ref).toBeUndefined();
    expect(resolve.steps?.find((candidate) => candidate.id === "resolve")?.run).toBe(
      "scripts/resolve-release.sh",
    );
    // The resolver reads the promoted alpha's run.
    expect(release.permissions.actions).toBe("read");
    const call = jobOf(release, "verify");
    const signing = jobOf(release, "release");
    expect(JSON.stringify(resolve)).not.toContain("secrets.");
    expect(call).toMatchObject({
      needs: ["resolve", "notes"],
      uses: "./.github/workflows/verify.yml",
      with: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        ref: "${{ needs.resolve.outputs.source_commit }}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        profile: "${{ needs.resolve.outputs.channel }}",
      },
    });
    // Nothing verify runs holds a secret.
    expect(call.secrets).toBeUndefined();
    expect(signing.needs).toEqual(["resolve", "notes", "verify", "linux", "rehearse", "phone"]);
    expect(steps[0]).toMatchObject({
      uses: "actions/checkout@v4",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      with: { ref: "${{ needs.resolve.outputs.source_commit }}" },
    });
    // Both profiles run the hosted Linux checks, which the signing job waits for.
    for (const profile of ["stable", "alpha"]) expect(lanes(profile)).toContain("linux-checks");
    // The signing job repeats none of the checks the lanes it waits for already
    // ran: after the install, and the live alpha's read of the tap, it builds.
    const commands = steps.flatMap((candidate) => (candidate.run ? [candidate] : []));
    for (const candidate of commands)
      expect(candidate.run, candidate.name).not.toMatch(
        /\bpnpm (typecheck|check|lint:adherence|test)\b/,
      );
    const afterInstall = commands
      .slice(
        commands.findIndex((candidate) => candidate.run === "pnpm install --frozen-lockfile") + 1,
      )
      .filter((candidate) => !["visibility", "capability"].includes(candidate.id ?? ""));
    expect(afterInstall[0]?.id).toBe("build");
    expect(afterInstall[0]?.run).toBe("pnpm build");
    const firstSecret = steps.findIndex((candidate) =>
      /secrets\.(MAC_DEVELOPER_ID|APP_STORE_CONNECT)/.test(JSON.stringify(candidate)),
    );
    expect(steps[firstSecret]?.name).toBe("Restore App Store Connect API key");
    expect(steps.indexOf(step("build"))).toBeLessThan(firstSecret);
    // Apple signing material stays in the signing job; publication holds none.
    expect(JSON.stringify(jobOf(release, "publish"))).not.toMatch(
      /secrets\.(MAC_DEVELOPER_ID|APP_STORE_CONNECT)|CSC_KEYCHAIN|keychain/,
    );
  });

  it("checks the release notes before anything verifies or signs, and packages exactly that catalog", () => {
    const notes = jobOf(release, "notes");
    const noteSteps = notes.steps ?? [];
    // Declarations only, with no secret and no install: node's type stripping.
    expect(JSON.stringify(notes)).not.toContain("secrets.");
    expect(notes.needs).toBe("resolve");
    expect(noteSteps[0]).toMatchObject({
      uses: "actions/checkout@v4",
      with: { "fetch-depth": 0 },
    });
    const check = noteSteps.find(
      (candidate) => candidate.name === "Check the notes cover this release",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own shell, matched literally.
    expect(check?.run).toContain('node scripts/release-notes.ts "${ARGS[@]}"');
    // The candidate is a typed dispatch input, handed to the check as the reviewed source.
    const input = release.on.workflow_dispatch?.inputs?.candidate;
    expect(input).toMatchObject({ type: "string", required: false });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
    expect(check?.env?.CANDIDATE).toBe("${{ inputs.candidate }}");
    expect(check?.run).toContain('ARGS+=(--reviewed "$CANDIDATE")');
    // Neither verification nor signing starts without it.
    expect(jobOf(release, "verify").needs).toContain("notes");
    expect(jobOf(release, "release").needs).toContain("notes");
    // The signing job packages the notes job's catalog and verifies the
    // packaged copy's identity before notarizing, signing-gate checks or launch.
    const order = steps.map((candidate) => candidate.id ?? candidate.name);
    const place = order.indexOf("Place the release notes catalog");
    expect(place).toBeGreaterThan(order.indexOf("build"));
    expect(place).toBeLessThan(order.indexOf("package"));
    expect(order.indexOf("packaged-notes")).toBeGreaterThan(order.indexOf("package"));
    expect(order.indexOf("packaged-notes")).toBeLessThan(order.indexOf("signed-app"));
    expect(step("packaged-notes").run).toContain("verify-package");
    expect(step("packaged-notes").run).toContain("Contents/Resources/release-notes.json");
    // The hero pictures travel with the catalog: generated into one folder,
    // kept as one artifact, and placed where electron-builder ships them.
    const generate = noteSteps.find(
      (candidate) => candidate.name === "Generate the offline catalog",
    );
    expect(generate?.run).toContain('--out "$RUNNER_TEMP/release-notes/release-notes.json"');
    const keep = noteSteps.find((candidate) => candidate.name === "Keep the catalog for packaging");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
    expect(keep?.with?.path).toBe("${{ runner.temp }}/release-notes/");
    const placed = steps.find((candidate) => candidate.name === "Place the release notes catalog");
    expect(placed?.run).toContain("packaging/generated/release-notes.json");
    expect(placed?.run).toContain("packaging/generated/release-notes/pictures");
  });

  it("writes a stable's picked highlights with the workflow's own tooling, after the alpha's catalog and before it is kept", () => {
    const input = release.on.workflow_dispatch?.inputs?.highlights;
    expect(input).toMatchObject({ type: "string", required: false });
    const resolveStep = (jobOf(release, "resolve").steps ?? []).find(
      (candidate) => candidate.id === "resolve",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
    expect(resolveStep?.env?.HIGHLIGHTS).toBe("${{ inputs.highlights }}");
    const noteSteps = jobOf(release, "notes").steps ?? [];
    const order = noteSteps.map((candidate) => candidate.name);
    const tooling = noteSteps.find(
      (candidate) => candidate.name === "Check out the workflow's own notes tooling",
    );
    const write = noteSteps.find((candidate) => candidate.name === "Write the picked highlights");
    // The promoted alpha's commit may predate the pick, so it comes from the
    // workflow's own commit, beside the source checkout.
    expect(tooling).toMatchObject({
      uses: "actions/checkout@v4",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      with: { ref: "${{ github.sha }}", path: ".release-tooling" },
    });
    expect(write?.run).toContain(
      'node .release-tooling/scripts/release-notes.ts stable-highlights --repo . --catalog "$CATALOG" --picks "$HIGHLIGHTS"',
    );
    // The alpha's own check then proves its app reads the result.
    expect(write?.run).toMatch(
      /\nnode scripts\/release-notes\.ts verify-package --catalog "\$CATALOG"/,
    );
    expect(order.indexOf("Write the picked highlights")).toBeGreaterThan(
      order.indexOf("Generate the offline catalog"),
    );
    expect(order.indexOf("Write the picked highlights")).toBeLessThan(
      order.indexOf("Keep the catalog for packaging"),
    );
    // Both run only for picks; without them the catalog is the alpha's as generated.
    for (const step of [tooling, write])
      for (const [highlights, runs] of [
        ["lead-change,second-change,third-change", true],
        ["", false],
      ] as const)
        expect(
          workflowValue(step?.if ?? "", { needs: { resolve: { outputs: { highlights } } } }),
        ).toBe(runs);
  });

  it("never cancels a real release, and gives a rehearsal its own group", () => {
    const group = (inputs: Record<string, unknown>, runId: string) =>
      workflowString(release.concurrency.group, {
        inputs,
        github: { ref_name: "main", run_id: runId },
      });
    const cancels = (inputs: Record<string, unknown>) =>
      workflowValue(release.concurrency["cancel-in-progress"], { inputs });
    // Real releases: a stable promotion and an alpha's candidate, both requested from main.
    const candidate = "c".repeat(40);
    for (const [inputs, runId] of [
      [{ channel: "stable", promote: "1.2.3-alpha.13", dry_run: false }, "101"],
      [{ channel: "alpha", candidate, dry_run: false }, "102"],
    ] as const) {
      expect(group(inputs, runId)).toBe(`release-${runId}`);
      expect(cancels(inputs)).toBe(false);
    }
    // Rehearsals: one group per channel and what it builds, a newer one replacing an older.
    expect(group({ channel: "alpha", dry_run: true }, "103")).toBe("release-dry-run-alpha-main");
    expect(group({ channel: "alpha", candidate, dry_run: true }, "104")).toBe(
      `release-dry-run-alpha-${candidate}`,
    );
    expect(group({ channel: "stable", promote: "1.2.3-alpha.13", dry_run: true }, "105")).toBe(
      "release-dry-run-stable-1.2.3-alpha.13",
    );
    expect(cancels({ channel: "alpha", dry_run: true })).toBe(true);
    // Verify inside a release belongs to that run; on demand, a newer verify
    // of the same ref and profile replaces an older one.
    const verifyGroup = (workflow: string, inputs: Record<string, unknown>) =>
      workflowString(verify.concurrency.group, {
        github: { workflow, ref: "refs/heads/main", run_id: "77" },
        inputs,
      });
    const verifyCancels = (workflow: string) =>
      workflowValue(verify.concurrency["cancel-in-progress"], { github: { workflow } });
    expect(verifyGroup("release", { ref: "c".repeat(40), profile: "alpha" })).toBe("verify-77");
    expect(verifyCancels("release")).toBe(false);
    expect(verifyGroup("verify", { profile: "alpha" })).toBe("verify-refs/heads/main-alpha");
    expect(verifyCancels("verify")).toBe(true);
  });

  it("is requested by hand alone: defaults to stable, takes alpha on request, an alpha's candidate and a stable's promotion", () => {
    expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(release.on.workflow_dispatch?.inputs ?? {})).toEqual([
      "channel",
      "candidate",
      "promote",
      "highlights",
      "dry_run",
    ]);
    for (const input of ["candidate", "promote", "highlights"])
      expect(release.on.workflow_dispatch?.inputs?.[input]).toMatchObject({
        type: "string",
        required: false,
      });
    expect(release.on.workflow_dispatch?.inputs?.channel).toMatchObject({
      type: "choice",
      options: ["stable", "alpha"],
      default: "stable",
    });
    expect(release.on.workflow_dispatch?.inputs?.dry_run).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(verify.on.workflow_call?.inputs?.profile?.default).toBe("stable");
    expect(verify.on.workflow_dispatch?.inputs?.profile).toMatchObject({ default: "stable" });
  });

  const PUBLISHES =
    /gh release (create|upload)|publish-release-asset\.sh|publish-(?:tap|feeds)\.sh live|publish-downloads\.ts|git push/;
  const PUBLICATION_TOKEN =
    /secrets\.(GITHUB_TOKEN|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|HOMEBREW_TAP_TOKEN|OLD_TAP_TOKEN)/;
  /**
   * The steps of a passing run of a channel, live or rehearsed, in order:
   * the signing job's, then the publication job's when it starts after them.
   */
  const ranSteps = (channel: string, dryRun: boolean, oldCask = false, direct = true) => {
    const needs = {
      resolve: {
        result: "success",
        outputs: {
          channel,
          dry_run: String(dryRun),
          old_cask: String(oldCask),
          release_repository: releaseSource.repository,
          verify_required: "true",
        },
      },
      // The signing job hands on what its visibility step chose.
      release: { result: "success", outputs: { direct: String(dryRun ? false : direct) } },
      update: { result: "success" },
    };
    const ran = (jobSteps: Step[]) =>
      jobSteps.filter(
        (candidate) =>
          candidate.if === undefined ||
          workflowValue(candidate.if, {
            needs,
            github: { repository: releaseSource.repository },
            steps: Object.fromEntries(
              jobSteps.flatMap((each) =>
                each.id
                  ? [[each.id, { outcome: "success", outputs: { direct: String(direct) } }]]
                  : [],
              ),
            ),
          }) === true,
      );
    const publishes = workflowValue(jobOf(release, "publish").if ?? "", { needs }) === true;
    return [...ran(signingSteps), ...(publishes ? ran(publishSteps) : [])];
  };

  it.each(["stable", "alpha"])("rehearses %s's whole profile and publishes nothing", (channel) => {
    const ran = ranSteps(channel, true);
    for (const candidate of ran) {
      expect(candidate.run ?? "", candidate.name).not.toMatch(PUBLISHES);
      if (candidate.id !== "feed-rehearsal")
        expect(JSON.stringify(candidate.env ?? {}), candidate.name).not.toMatch(PUBLICATION_TOKEN);
    }
    expect(ran.map((candidate) => candidate.id ?? candidate.name)).toEqual(
      expect.arrayContaining([
        "build",
        "package",
        "signed-app",
        "launch",
        "data-folder",
        "notarize",
        "zip",
        "checksum",
        "dmg",
        "handoff",
        "handoff-upload",
        "handoff-check",
        "tap-rehearsal",
        "old-tap-rehearsal",
        "feed-rehearsal",
        "Keep the rehearsed release metadata",
        "Summarize",
        "Summarize the publication",
      ]),
    );
    // A rehearsal's feeds are written from the checked image it handed over.
    expect(step("feed-rehearsal").run).toContain(
      'DIST_ZIP="${{ steps.handoff-check.outputs.zip }}" DIST_DMG="${{ steps.handoff-check.outputs.dmg }}"',
    );
    // The feed rehearsal may read a not-yet-public repository, but cannot publish.
    expect(step("feed-rehearsal").run).toContain("scripts/publish-feeds.sh rehearsal");
    // electron-builder never publishes on its own either.
    expect(step("package").run).toContain("--publish never");
  });

  it.each(["stable", "alpha"])(
    "publishes %s through both Homebrew and direct feeds only after their downloads verify",
    (channel) => {
      // INF-1613: exercise both configured storage and the approved Homebrew/Linux-only fallback.
      for (const direct of [false, true]) {
        const ran = ranSteps(channel, false, false, direct).map(
          (candidate) => candidate.id ?? candidate.name,
        );
        const publication = [
          "private",
          ...(direct ? ["recorded-dmg"] : []),
          "private-fetch-back",
          ...(direct ? ["public", "public-fetch-back", "feeds"] : []),
        ];
        expect(
          ran.filter((id) =>
            [
              "private",
              "recorded-dmg",
              "private-fetch-back",
              "public",
              "public-fetch-back",
              "feeds",
            ].includes(id ?? ""),
          ),
        ).toEqual(publication);
        expect(ran.indexOf("visibility")).toBeLessThan(ran.indexOf("developer_id_cert"));
        if (direct) {
          expect(ran.indexOf("dmg")).toBeGreaterThan(ran.indexOf("private"));
          expect(ran.indexOf("dmg")).toBeLessThan(ran.indexOf("recorded-dmg"));
        } else {
          expect(ran).not.toContain("dmg");
        }
        expect(ran).not.toContain("feed-rehearsal");
        expect(ran).toEqual(
          expect.arrayContaining(["homebrew-public", "homebrew-fetch-back", "tap"]),
        );
        // The signing job ends after the image and its handoff; publication
        // starts by validating that handoff, before any effect.
        expect(ran.indexOf("handoff")).toBeGreaterThan(ran.indexOf(direct ? "dmg" : "private"));
        expect(ran.indexOf("handoff-check")).toBeGreaterThan(ran.indexOf("handoff-upload"));
        expect(ran.indexOf("handoff-check")).toBeLessThan(
          ran.indexOf(direct ? "recorded-dmg" : "private-fetch-back"),
        );
        expect(ran.indexOf("homebrew-fetch-back")).toBeGreaterThan(ran.indexOf("homebrew-public"));
        expect(ran.indexOf("tap")).toBeGreaterThan(ran.indexOf("homebrew-fetch-back"));
        expect(ran).not.toContain("tap-rehearsal");
      }
      expect(JSON.stringify(step("public-fetch-back").env)).not.toContain("secrets.");
      // Publication reads the validated handoff's zip, the record's own (INF-1716).
      expect(step("public").env?.DIST_ZIP).toBe("${{ steps.handoff-check.outputs.zip }}");
      expect(step("public").env?.DIST_DMG).toBe("${{ steps.recorded-dmg.outputs.zip }}");
      for (const id of ["private-fetch-back", "public-fetch-back"])
        expect(step(id).env?.ARTIFACT_SHA256).toBe("${{ needs.release.outputs.sha256 }}");
      expect(
        steps
          .filter(
            (candidate) =>
              PUBLISHES.test(candidate.run ?? "") ||
              PUBLICATION_TOKEN.test(JSON.stringify(candidate.env ?? {})),
          )
          .map((candidate) => candidate.id),
      ).toEqual([
        "visibility",
        "private",
        "recorded-dmg",
        "private-fetch-back",
        "public",
        "homebrew-public",
        "tap",
        "old-public",
        "old-tap",
        "feeds",
      ]);
    },
  );

  it.each(["stable", "alpha"])(
    "keeps %s old-cask publication gated by explicit channel activation",
    (channel) => {
      // Revised INF-643: retain both paths, including the already-activated old-cask bridge.
      const inactive = ranSteps(channel, false, false).map((step) => step.id);
      const active = ranSteps(channel, false, true).map((step) => step.id);
      for (const id of ["old-public", "old-public-fetch-back", "old-tap"]) {
        expect(inactive).not.toContain(id);
        expect(active).toContain(id);
      }
      expect(active.indexOf("old-public-fetch-back")).toBeGreaterThan(active.indexOf("old-public"));
      expect(active.indexOf("old-tap")).toBeGreaterThan(active.indexOf("old-public-fetch-back"));
      for (const id of ["homebrew-fetch-back", "old-public-fetch-back"])
        expect(JSON.stringify(step(id).env)).not.toContain("secrets.");
      expect(step("tap").env?.DOWNLOAD_URL).toBe("${{ needs.resolve.outputs.download_url }}");
      expect(step("old-tap").env?.DOWNLOAD_URL).toBe(
        "${{ needs.resolve.outputs.old_download_url }}",
      );
    },
  );

  it("packages the logical version as the app's metadata and its numeric core as both bundle fields", () => {
    const packaging = step("package").run ?? "";
    expect(packaging).toContain('-c.extraMetadata.version="$VERSION"');
    expect(packaging).toContain('-c.mac.bundleShortVersion="$BUNDLE_VERSION"');
    expect(packaging).toContain('-c.mac.bundleVersion="$BUNDLE_VERSION"');
    // Every launch gate holds the app to the logical version: the gate reads
    // both fields as its numeric core and asks the running app for the rest.
    const launches = steps.flatMap((candidate) =>
      [...(candidate.run ?? "").matchAll(/scripts\/check-app-launch\.sh "[^"]+" "([^"]+)"/g)].map(
        (match) => match[1],
      ),
    );
    const launchStages = [
      "launch",
      "zip",
      "private-fetch-back",
      "public-fetch-back",
      "homebrew-fetch-back",
    ];
    expect(launches).toEqual(launchStages.map(() => "$VERSION"));
    for (const id of launchStages) expect(step(id).run).toContain("scripts/check-app-launch.sh");
  });

  it("launches the app only through the workflow's own launch gate, after packaging", () => {
    // INF-1768: a stable checks out an older alpha's commit, whose scripts
    // call the gate beside them, so a repair to the gate reaches that
    // release only when the workflow puts its own copy there first.
    const gate = ["scripts/check-app-launch.sh", "scripts/app-runtime-version.mjs"];
    const launches = (candidate: Step) =>
      /(^|\s)scripts\/(check-app-launch|verify-mac-dmg)\.sh /m.test(candidate.run ?? "");
    for (const [job, jobSteps] of [
      ["release", signingSteps],
      ["publish", publishSteps],
    ] as const) {
      const fetched = jobSteps.findIndex(
        (candidate) => candidate.with?.path === ".release-tooling",
      );
      expect(jobSteps[fetched]?.uses, job).toBe("actions/checkout@v4");
      expect(jobSteps[fetched]?.with?.ref, job).toBe("${{ github.sha }}");
      expect(String(jobSteps[fetched]?.with?.["sparse-checkout"]).trim().split("\n"), job).toEqual(
        gate,
      );
      const placed = jobSteps.findIndex(
        (candidate) =>
          candidate.run ===
          `cp ${gate.map((file) => `.release-tooling/${file}`).join(" ")} scripts/`,
      );
      expect(placed, job).toBeGreaterThan(fetched);
      // Both run in every profile, before the job's first launch.
      expect([jobSteps[fetched]?.if, jobSteps[placed]?.if], job).toEqual([undefined, undefined]);
      expect(jobSteps.findIndex(launches), job).toBeGreaterThan(placed);
    }
    // The app it launches is the source's, packaged before the gate moves in.
    expect(signingSteps.findIndex((candidate) => candidate.id === "launch-gate")).toBeGreaterThan(
      signingSteps.findIndex((candidate) => candidate.id === "package"),
    );
  });

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
      const fixture = join(root, "tests", "fixtures", "launch-gate-app");
      const version: string = JSON.parse(
        readFileSync(join(fixture, "package.json"), "utf8"),
      ).version;
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
      const profiles = scratchDir("infinitary-launch-gate-profiles-");
      const home = scratchDir("infinitary-launch-gate-home-");
      const witness = scratchDir("infinitary-launch-gate-witness-");
      const gate = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const run = spawn(join(root, "scripts", "check-app-launch.sh"), [app, version], {
            env: {
              ...process.env,
              TMPDIR: profiles,
              HOME: home,
              CFFIXED_USER_HOME: home,
              LAUNCH_GATE_WITNESS: witness,
            },
          });
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
        },
      );
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
      // Whatever the gate left running stops here, so a failure leaves nothing behind.
      for (const pid of running) process.kill(pid, "SIGKILL");
      expect(readdirSync(witness).sort()).toEqual(["app.pid", "child.pid"]);
      expect(gate.status, gate.stderr).toBe(0);
      expect(gate.stdout).toContain(`the running app reports ${version}`);
      expect(running).toEqual([]);
      expect(readdirSync(profiles)).toEqual([]);
    },
  );
});

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

/**
 * The captain's INF-603 answer to question 7: production signing (the TestFlight
 * upload and release) runs on the real Mac through one configured label.
 * INF-643 separately authorizes disposable signing for installer verification,
 * and INF-816 moves its build/arm64 jobs into placement-service virtual Macs.
 * Neither publishes. Until REAL_MAC_RUNNER is set, production signing does not move.
 */
describe("the jobs that ask for the real Mac", () => {
  type Job = { "runs-on"?: string };
  const workflows = readdirSync(join(root, ".github/workflows")).filter((name) =>
    name.endsWith(".yml"),
  );
  const runsOn = (file: string, id: string) => {
    const jobs = (loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> }).jobs;
    return jobs[id]?.["runs-on"] ?? "";
  };

  it("is exactly the release's signing job and the TestFlight upload", () => {
    const asking = workflows.flatMap((file) =>
      Object.entries(
        (loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> }).jobs,
      ).flatMap(([id, job]) =>
        (job["runs-on"] ?? "").includes("REAL_MAC_RUNNER") ? [`${file}:${id}`] : [],
      ),
    );
    expect(asking.sort()).toEqual(["ios-release.yml:testflight", "release.yml:release"]);
  });

  it.each([
    ["release.yml", "release", "macos-15"],
    ["ios-release.yml", "testflight", "mini-mac"],
  ])("%s's %s job runs where it did until the switch sets the label", (file, id, fallback) => {
    const runner = (vars: Record<string, string>) => workflowValue(runsOn(file, id), { vars });
    expect(runner({})).toBe(fallback);
    expect(runner({ MAC_RUNNER: "mini-mac" })).toBe("mini-mac");
    expect(runner({ MAC_RUNNER: "mini-mac-any", REAL_MAC_RUNNER: "mini-mac-real" })).toBe(
      "mini-mac-real",
    );
  });
});

/**
 * INF-1720's approved plan: every Linux job of every workflow runs where the
 * repository variable LINUX_RUNNER sends it, the PC's shell-pc-linux places,
 * as ci.yml's already did, and on GitHub's hosted Ubuntu when it is unset.
 * The package check's Ubuntu 26.04 leg takes the PC's 26.04 image's label.
 * DOP-157's approved plan (direction A): the gate jobs - the three that open
 * a pull request's phone and journeys runs and the four Linux jobs that open
 * a release - take the PC's gate label, LINUX_RUNNER plus -gate, whose
 * runners take no other job, so a runner started for one runs one.
 * Each job's runner is evaluated both ways, for every matrix entry.
 */
it("sends every Linux job to LINUX_RUNNER, and hosted Ubuntu when it is unset", () => {
  const gate = [
    "phone.yml:cancel-replaced",
    "phone.yml:choose-phone",
    "journeys.yml:choose-journeys",
    "release.yml:resolve",
    "release.yml:notes",
    "release.yml:phone",
    "ios-release.yml:resolve",
  ];
  type Job = { "runs-on"?: string; strategy?: { matrix?: Record<string, unknown> } };
  const evaluate = (value: string, contexts: Record<string, unknown>) =>
    value.includes("${{") ? workflowValue(value, contexts) : value;
  const linux: string[] = [];
  for (const file of readdirSync(join(root, ".github/workflows")).filter((name) =>
    name.endsWith(".yml"),
  )) {
    const { jobs } = loadYamlFile(`.github/workflows/${file}`) as { jobs: Record<string, Job> };
    for (const [id, job] of Object.entries(jobs)) {
      if (!job["runs-on"]) continue;
      const matrix = job.strategy?.matrix ?? {};
      const include = Array.isArray(matrix.include) ? (matrix.include as object[]) : [];
      const lanes = typeof matrix.lane === "string" ? evaluate(matrix.lane, { inputs: {} }) : [];
      const entries: object[] = include.length
        ? include
        : Array.isArray(lanes) && lanes.length
          ? lanes.map((lane) => ({ lane }))
          : [{}];
      for (const entry of entries) {
        const runner = (vars: Record<string, string>) =>
          evaluate(job["runs-on"] ?? "", { vars, matrix: entry, inputs: {} });
        const hosted = runner({});
        if (typeof hosted !== "string" || !hosted.startsWith("ubuntu-")) continue;
        const name = `${file}:${id} ${JSON.stringify(entry)}`;
        linux.push(name);
        if (gate.includes(`${file}:${id}`)) expect(hosted, name).toBe("ubuntu-latest");
        expect(runner({ LINUX_RUNNER: "shell-pc-linux" }), name).toBe(
          gate.includes(`${file}:${id}`)
            ? "shell-pc-linux-gate"
            : hosted === "ubuntu-26.04"
              ? "shell-pc-linux-2604"
              : "shell-pc-linux",
        );
      }
    }
  }
  // The jobs the plan named, so a job the check could not read is not missed.
  for (const job of [
    "ci.yml:unit-tests",
    "journeys.yml:choose-journeys",
    "source-journeys.yml:source-desktop",
    "verify.yml:lane",
    "phone.yml:choose-phone",
    "replay.yml:replay-gate",
    "linux-startup.yml:runtime-facts",
    "linux-packages.yml:build",
    "linux-packages.yml:check",
    "release.yml:notes",
    "ios-release.yml:availability",
    ...gate,
  ])
    expect(
      linux.some((name) => name.startsWith(`${job} `)),
      job,
    ).toBe(true);
});

describe("the cask republication workflow", () => {
  type Step = {
    id?: string;
    name?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
  };
  const workflow = loadYamlFile(".github/workflows/republish-casks.yml") as {
    on: {
      push?: { branches: string[]; paths: string[] };
      pull_request?: unknown;
      workflow_dispatch?: { inputs: Record<string, Record<string, unknown>> };
    };
    permissions: Record<string, string>;
    concurrency: Record<string, unknown>;
    jobs: Record<string, { if: string; "runs-on": string; steps: Step[] }>;
  };
  const job = workflow.jobs.republish as { if: string; "runs-on": string; steps: Step[] };
  /** The steps a passing run on `ref` with `inputs` takes, in order; null when the job does not start. */
  const ranSteps = (
    ref: string,
    inputs: Record<string, unknown>,
    repository = "infinitary-labs/infinitary",
  ): Step[] | null => {
    const contexts = { github: { ref, repository }, inputs };
    if (workflowValue(job.if, contexts) !== true) return null;
    const outcomes: Record<string, { outcome: string }> = {};
    const ran: Step[] = [];
    for (const candidate of job.steps) {
      const runs =
        candidate.if === undefined ||
        workflowValue(candidate.if, { ...contexts, steps: outcomes }) === true;
      if (candidate.id) outcomes[candidate.id] = { outcome: runs ? "success" : "skipped" };
      if (runs) ran.push(candidate);
    }
    return ran;
  };
  const names = (steps: Step[] | null) => (steps ?? []).map((each) => each.id ?? each.name);
  const PUSHES = /publish-tap\.sh (live|republish)\b(?!-)|git push/;
  const TOKEN = /secrets\./;

  it("runs when what the casks are written from reaches main, and on demand, never on a pull request", () => {
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(workflow.on.push?.paths).toEqual(
      expect.arrayContaining([
        ".github/workflows/republish-casks.yml",
        "packaging/alpha-notice.txt",
        "scripts/publish-tap.sh",
        "scripts/tap-publication.ts",
        "src/core/update/tapPublication.ts",
        "src/core/update/updateChannels.ts",
      ]),
    );
    for (const path of workflow.on.push?.paths ?? []) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
    expect(workflow.on.workflow_dispatch?.inputs.dry_run).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "republish-casks", "cancel-in-progress": false });
  });

  // INF-621: a cask proof may use the disposable image, but the override
  // must never move a publishing job away from its normal runner.
  it("allows an isolated runner only for a dry run", () => {
    expect(workflow.on.workflow_dispatch?.inputs.mac_runner).toMatchObject({
      type: "string",
      required: false,
    });
    const runner = (inputs: Record<string, unknown>, vars: Record<string, string>) =>
      workflowValue(job["runs-on"], { inputs, vars });
    expect(
      runner({ dry_run: true, mac_runner: "mini-mac-inf621-proof" }, { MAC_RUNNER: "mini-mac" }),
    ).toBe("mini-mac-inf621-proof");
    expect(
      runner({ dry_run: false, mac_runner: "mini-mac-inf621-proof" }, { MAC_RUNNER: "mini-mac" }),
    ).toBe("mini-mac");
    expect(runner({}, { MAC_RUNNER: "mini-mac" })).toBe("mini-mac");
    expect(runner({ dry_run: true }, {})).toBe("macos-15");
  });

  it("republishes only from main, with the tap token in one step, and a dry run anywhere pushes nothing", () => {
    // A push to main carries no inputs; a live run on demand says dry_run false.
    for (const inputs of [{}, { dry_run: false }]) {
      const ran = ranSteps("refs/heads/main", inputs);
      expect(names(ran)).toContain("tap");
      expect(names(ran)).not.toContain("tap-rehearsal");
      expect(
        names((ran ?? []).filter((each) => TOKEN.test(JSON.stringify(each.env ?? {})))),
      ).toEqual(["tap"]);
      expect((ran ?? []).find((each) => each.id === "tap")?.run).toMatch(
        /scripts\/publish-tap\.sh republish \|/,
      );
    }
    for (const ref of ["refs/heads/main", "refs/heads/a-branch"]) {
      const ran = ranSteps(ref, { dry_run: true });
      expect(names(ran)).toEqual(
        expect.arrayContaining(["tap-rehearsal", "Keep the rehearsed casks", "Summarize"]),
      );
      expect(names(ran)).not.toContain("tap");
      for (const each of ran ?? []) {
        expect(each.run ?? "", each.name).not.toMatch(PUSHES);
        expect(JSON.stringify(each.env ?? {}), each.name).not.toMatch(TOKEN);
      }
    }
    // Any other ref may only rehearse: a live run there does not start.
    expect(ranSteps("refs/heads/a-branch", { dry_run: false })).toBeNull();
    expect(ranSteps("refs/heads/a-branch", {})).toBeNull();
    // Nor does a push to the Firstmate 3000 repository's main, before it is
    // archived (FI3-1780 step 11): only Infinitary's own repository writes
    // Infinitary's tap, and Firstmate 3000's casks move only with a release.
    expect(ranSteps("refs/heads/main", {}, "kunchenguid/firstmate-3000")).toBeNull();
    expect(
      names(ranSteps("refs/heads/main", { dry_run: true }, "kunchenguid/firstmate-3000")),
    ).toContain("tap-rehearsal");
  });
});

// Captain's "Prepare reuse": selecting old copies must skip the signing job,
// not skip either installed-check job or silently select a fresh build.
it("selects only the complete installed checks for reuse, without a signing job", () => {
  type Job = {
    if?: string;
    with?: Record<string, string>;
    steps?: { id?: string; if?: string; run?: string; uses?: string }[];
  };
  const installer = loadYamlFile(".github/workflows/mac-installer.yml") as {
    jobs: Record<string, Job>;
  };
  const verify = loadYamlFile(".github/workflows/verify.yml") as { jobs: Record<string, Job> };
  const selected = (job: Job | undefined, contexts: Record<string, unknown>) => {
    if (!job) throw new Error("The verification job is missing");
    return Boolean(workflowValue(job.if ?? "${{ true }}", contexts));
  };
  for (const reuse of ["", "reviewed declaration"]) {
    const inputs = { reuse };
    expect(selected(installer.jobs.build, { inputs })).toBe(!reuse);
    expect(
      selected(installer.jobs.installed, {
        inputs,
        needs: { build: { result: reuse ? "skipped" : "success" } },
      }),
    ).toBe(true);
    expect(
      selected(installer.jobs.installed, { inputs, needs: { build: { result: "failure" } } }),
    ).toBe(false);
    const steps = installer.jobs.installed?.steps ?? [];
    expect(selected(steps.find((step) => step.id === "reuse") as Job, { inputs })).toBe(
      Boolean(reuse),
    );
    expect(
      selected(steps.find((step) => step.uses === "actions/download-artifact@v4") as Job, {
        inputs,
      }),
    ).toBe(!reuse);
  }
  for (const installer_only of [false, true]) {
    const reused = {
      inputs: { installer_only, installer_reuse: "reviewed declaration", ref: "reviewed source" },
    };
    for (const name of ["lane", "linux-e2e"])
      expect(selected(verify.jobs[name], reused)).toBe(false);
    expect(selected(verify.jobs.installer, reused)).toBe(true);
    expect(workflowValue(verify.jobs.installer?.with?.reuse ?? "", reused)).toBe(
      reused.inputs.installer_reuse,
    );
  }
});

// DOP-42 supplies the virtual-only label for INF-643's approved signed rerun.
// INF-818 owns any later move of Intel. A real-Mac setting cannot redirect these.
it("keeps installer verification on the selected disposable runners", () => {
  const { jobs } = loadYamlFile(".github/workflows/mac-installer.yml") as {
    jobs: {
      build: { "runs-on": string };
      installed: {
        name: string;
        "runs-on": string;
        strategy: { matrix: { chip: string } };
      };
    };
  };
  const vars = { MAC_RUNNER: "mini-mac-real", REAL_MAC_RUNNER: "mini-mac-real" };
  expect(workflowString(jobs.build["runs-on"], { vars })).toBe("mini-mac-virtual");
  const chips = workflowValue(jobs.installed.strategy.matrix.chip, {
    inputs: { chip: "both" },
  }) as string[];
  const assigned = chips.map((chip) => ({
    chip,
    runner: workflowString(jobs.installed["runs-on"], { vars, matrix: { chip } }),
  }));
  // The check names PR readings and diagnoses are keyed to.
  expect(chips.map((chip) => workflowString(jobs.installed.name, { matrix: { chip } }))).toEqual([
    "Apple silicon",
    "Intel",
  ]);
  expect(assigned).toEqual([
    { chip: "arm64", runner: "mini-mac-virtual" },
    { chip: "x64", runner: "macos-15-intel" },
  ]);
});

// INF-1900 direction D: the release's update check runs in a disposable
// Apple silicon Mac, rehearsing before signing and updating after it. The
// captain: Intel is a best-effort side effect, with no hosted Mac runs. The
// promotion gate reads its job by this name.
it("runs the update check on Apple silicon only, rehearsing before signing and updating from the handoff", () => {
  const { jobs } = loadYamlFile(".github/workflows/mac-update.yml") as {
    jobs: Record<string, { name: string; "runs-on": string; strategy?: unknown }>;
  };
  expect(Object.values(jobs).map((job) => [job.name, job["runs-on"], job.strategy])).toEqual([
    ["Apple silicon", "mini-mac-virtual", undefined],
  ]);
  const release = loadYamlFile(".github/workflows/release.yml") as {
    jobs: Record<
      "rehearse" | "update",
      { name: string; uses?: string; secrets?: unknown; with?: Record<string, string> }
    >;
  };
  const { rehearse, update } = release.jobs;
  for (const job of [rehearse, update]) {
    expect(job.uses).toBe("./.github/workflows/mac-update.yml");
    expect(job.secrets).toBeUndefined();
  }
  expect(rehearse.with?.handoff_id).toBeUndefined();
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
  expect(update.with?.handoff_id).toBe("${{ needs.release.outputs.handoff_id }}");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
  expect(update.with?.zip_sha256).toBe("${{ needs.release.outputs.sha256 }}");
  expect(update.name).toBe("Update from the last published alpha");
});

// INF-1539: the captain approved "Add logging and recheck once" for Apple silicon
// alone. A one-chip recheck must drop the other Mac from the run, and a release
// (which passes no chip) must still check both.
it("runs only the requested Mac type's installed checks", () => {
  type Matrix = { chip: string };
  const installer = loadYamlFile(".github/workflows/mac-installer.yml") as {
    on: { workflow_call: { inputs: { chip: { default: string } } } };
    jobs: { installed: { strategy: { matrix: Matrix } } };
  };
  const verify = loadYamlFile(".github/workflows/verify.yml") as {
    jobs: { installer: { with: Record<string, string> } };
  };
  const matrix = installer.jobs.installed.strategy.matrix;
  const chipsFor = (dispatched: string | undefined) => {
    const chip = workflowString(verify.jobs.installer.with.chip ?? "", {
      inputs: { installer_chip: dispatched },
    });
    // A matrix include entry would add an excluded chip back, so the chip list itself is chosen.
    expect(matrix).not.toHaveProperty("include");
    return workflowValue(matrix.chip, { inputs: { chip } }) as string[];
  };
  expect(installer.on.workflow_call.inputs.chip.default).toBe("both");
  expect(chipsFor(undefined)).toEqual(["arm64", "x64"]);
  expect(chipsFor("both")).toEqual(["arm64", "x64"]);
  expect(chipsFor("arm64")).toEqual(["arm64"]);
  expect(chipsFor("x64")).toEqual(["x64"]);
});

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
    }
    expect(notice).toMatch(/^Infinitary is in private alpha/);
    expect(notice).toContain("no warranty");
    // Diagnostics is disclosed - the events, the install ID and its reset -
    // with its opt-out (docs/sharing.md).
    expect(notice).toContain(
      "the app opening, a first mate turn finishing or failing, and how far first-time setup has come",
    );
    expect(notice).toContain(
      "a random install ID that is tied to nothing about you and resets whenever Diagnostics is turned off and back on",
    );
    expect(notice).toContain("never anything you typed");
    expect(notice).toContain("the Diagnostics switch in Settings turns it off");
    expect(notice).toContain("license follow at the public beta");
    // Feedback goes to the captain's Discord; the invite ends the notice, so
    // no trailing punctuation rides into the link.
    expect(notice).toMatch(
      /Feedback is welcome on Kun's Discord: https:\/\/discord\.gg\/Wsy2NpnZDu$/,
    );
  });

  it("publishes the selected source's finalized downloads and verifies them without a sign-in", () => {
    const workflow = loadYamlFile(".github/workflows/release.yml") as {
      jobs: Record<
        "release" | "publish",
        { env: Record<string, string>; steps: { id?: string; env?: Record<string, string> }[] }
      >;
    };
    const job = workflow.jobs.release;
    const publication = workflow.jobs.publish;
    const context = {
      needs: {
        resolve: {
          outputs: {
            release_repository: releaseSource.repository,
            tag_name: "v1.2.3",
            zip_name: "Infinitary-1.2.3-universal.zip",
          },
        },
      },
    };
    expect(workflowValue(job.env.PUBLIC_TAG ?? "", context)).toBe("v1.2.3");
    expect(workflowValue(job.env.RELEASE_REPOSITORY ?? "", context)).toBe(releaseSource.repository);
    // The publication job publishes under the same names (INF-1716).
    expect(publication.env).toEqual(job.env);
    const publicRead = publication.steps.find((step) => step.id === "public-fetch-back");
    expect(Object.keys(publicRead?.env ?? {})).toEqual(["ARTIFACT_SHA256"]);
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
      expect(upgradeCommandFor(channel)).toBe(`brew update && brew upgrade --cask ${token}`);
      // The download the cask carries, version interpolated as Homebrew
      // reads it, is the target the update reader accepts for that channel.
      const url = (/^ {2}url "([^"]+)"$/m.exec(cask)?.[1] ?? "").replaceAll("#{version}", version);
      expect(url).toBe(target.downloadUrl);
      expect(targetProblem(channel, target)).toBeNull();
    }
  });
});

/**
 * The Linux packages (docs/linux-packages.md): x64 Ubuntu, Fedora and
 * AppImage packages from electron-builder.linux.yml, and the Arch recipe and
 * the Nix package rendered from the Ubuntu package. Every one requires git
 * (or, the AppImage, asks for it), keeps Chromium's sandbox on and is
 * built and checked without being published.
 */
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

  it("checks each package on a clean copy of its system and keeps the files on the run alone", () => {
    const workflow = loadYamlFile(".github/workflows/linux-packages.yml") as {
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          strategy?: { matrix: { include: Array<Record<string, string>> } };
          steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
        }
      >;
    };
    expect(workflow.permissions).toEqual({ contents: "read" });
    const text = read(".github/workflows/linux-packages.yml");
    expect(text).not.toMatch(/gh release|softprops|--publish always|publish-release-asset/);
    const upload = workflow.jobs.build?.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact"),
    );
    // INF-1838: keep the same-run package handoff, not weeks of large binaries.
    expect(upload?.with).toMatchObject({ name: "linux-packages", "retention-days": 3 });
    const systems = (workflow.jobs.check?.strategy?.matrix.include ?? []).map(
      (entry) => `${entry.system} ${entry.image ?? entry.runner}`,
    );
    expect(systems).toEqual([
      "ubuntu-host ubuntu-24.04",
      "ubuntu-host ubuntu-26.04",
      "ubuntu ubuntu:24.04",
      "ubuntu ubuntu:26.04",
      "fedora fedora:latest",
      "arch archlinux:latest",
      "appimage fedora:latest",
      "nix ubuntu-24.04",
    ]);
  });
});

// INF-658's approved plan: execute the actual Linux journey command, not a
// source-text pin. Disposable command stand-ins record the selected interface.
describe("budgeted pull-request journey workflow (INF-658)", () => {
  type Job = {
    name: string;
    strategy: { matrix: { lane: string; shard: string; include: string } };
    steps: {
      name?: string;
      run?: string;
      if?: string;
      uses?: string;
      with?: Record<string, string>;
    }[];
  };
  const source = loadYamlFile(".github/workflows/source-journeys.yml") as {
    jobs: Record<string, Job>;
  };
  const job = source.jobs["source-desktop"];
  // INF-1417: preserve the ordinary eight jobs and split fresh-state checks four ways.
  it("splits starters into disjoint lanes and adds four isolated fresh-state jobs to the full alpha", () => {
    const lanes = (suite: string, lane = "parallel") =>
      workflowValue(job?.strategy.matrix.lane ?? "", { inputs: { suite, lane } });
    const shards = (suite: string) =>
      workflowValue(job?.strategy.matrix.shard ?? "", { inputs: { suite } });
    const extra = (suite: string) =>
      workflowValue(job?.strategy.matrix.include ?? "", { inputs: { suite } });
    expect(lanes("starter")).toEqual(["parallel", "desktop"]);
    expect(shards("starter")).toEqual([1]);
    expect(extra("starter")).toEqual([]);
    expect(lanes("full")).toEqual(["parallel", "desktop"]);
    expect(shards("full")).toEqual([1, 2, 3, 4]);
    expect(extra("full")).toEqual([1, 2, 3, 4].map((shard) => ({ lane: "alone", shard })));
    expect(lanes("alone")).toEqual(["alone"]);
    expect(shards("alone")).toEqual([1, 2, 3, 4]);
    expect(extra("alone")).toEqual([]);
    expect(lanes("affected", "desktop")).toEqual(["desktop"]);
    expect(extra("affected")).toEqual([]);
    // A release's stable promotion reads every `verify / linux-e2e / …` job by name.
    const name = (lane: string, shard: number) =>
      workflowString(job?.name ?? "", { inputs: { suite: "full" }, matrix: { lane, shard } });
    for (const shard of shards("full") as number[]) {
      expect(name("alone", shard)).toBe(`journeys (run alone ${shard}/4)`);
    }
    expect(name("desktop", 2)).toBe("journeys (desktop 2/4)");
  });
  it.each(["parallel", "desktop"])(
    "runs the %s starter and overflow files through their lane",
    (lane) => {
      const dir = scratchDir("infinitary-journey-placement-");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const commands: Record<string, string> = {
        "xvfb-run": '#!/bin/sh\nshift 3\nexec "$@"\n',
        xdotool:
          '#!/bin/sh\nif [ "$1" = getmouselocation ]; then echo "x:2559 y:1599 screen:0 window:0"; fi\n',
        pnpm: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\n',
      };
      for (const [name, body] of Object.entries(commands)) {
        const path = join(bin, name);
        writeFileSync(path, body);
        chmodSync(path, 0o755);
      }
      const command = job?.steps.find((step) =>
        step.name?.startsWith("Run the journeys with"),
      )?.run;
      expect(command).toBeDefined();
      for (const suite of ["starter", "affected"]) {
        const log = join(dir, `${suite}.log`);
        const files =
          lane === "desktop"
            ? "tests/e2e/keyboard-routing.spec.ts"
            : "tests/e2e/task-browser.spec.ts";
        const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", command ?? ""], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            COMMAND_LOG: log,
            RUNNER_OS: "Linux",
            SUITE: suite,
            LANE: lane,
            FILES: files,
            SCREEN: "2560x1600x24",
            SHARD: "1",
          },
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        const call = readFileSync(log, "utf8");
        expect(call).toContain("exec playwright test --no-deps");
        expect(call.includes("--project=desktop")).toBe(lane === "desktop");
        expect(call.includes("--project=application")).toBe(lane === "parallel");
        if (suite === "affected")
          expect(call.trim()).toBe(
            `exec playwright test --no-deps ${lane === "desktop" ? "--project=desktop" : "--project=renderer --project=application"} ${files}`,
          );
        else {
          expect(call).toContain("tests/e2e/devices.spec.ts");
          expect(call).toContain("tests/e2e/source-start.spec.ts");
        }
      }
    },
  );
  // INF-1417: execute each fresh-state share's real shell entry point, both in
  // full verification and the hosted-only proof request, preserving result retention.
  it.each(["full", "alone"].flatMap((suite) => [1, 2, 3, 4].map((shard) => ({ suite, shard }))))(
    "runs fresh-state share $shard in $suite and keeps its distinct result",
    ({ suite, shard }) => {
      const dir = scratchDir("infinitary-journey-alone-");
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const commands: Record<string, string> = {
        "xvfb-run": '#!/bin/sh\nshift 3\nexec "$@"\n',
        xdotool:
          '#!/bin/sh\nif [ "$1" = getmouselocation ]; then echo "x:2559 y:1599 screen:0 window:0"; fi\n',
        node: '#!/bin/sh\nprintf "node %s\\n" "$*" >> "$COMMAND_LOG"\n',
        pnpm: '#!/bin/sh\nprintf "pnpm %s\\n" "$*" >> "$COMMAND_LOG"\n',
      };
      for (const [name, body] of Object.entries(commands)) {
        const path = join(bin, name);
        writeFileSync(path, body);
        chmodSync(path, 0o755);
      }
      const command = job?.steps.find((step) =>
        step.name?.startsWith("Run the journeys with"),
      )?.run;
      const log = join(dir, "alone.log");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", command ?? ""], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          COMMAND_LOG: log,
          RUNNER_OS: "Linux",
          SUITE: suite,
          LANE: "alone",
          SCREEN: "2560x1600x24",
          SHARD: String(shard),
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const [, selected, out] =
        /^node scripts\/e2e-alone\.ts --shard (\S+) --out (\S+)$/.exec(
          readFileSync(log, "utf8").trim(),
        ) ?? [];
      expect(selected).toBe(`${shard}/4`);
      expect(out, "the job runs the pass alone, over every spec file").toBeTruthy();
      const onAlone = (step: { if?: string } | undefined) =>
        workflowValue(step?.if ?? "", { matrix: { lane: "alone" } }) === true &&
        workflowValue(step?.if ?? "", { matrix: { lane: "desktop" } }) === false;
      const kept = job?.steps.find(
        (step) =>
          step.uses === "actions/upload-artifact@v4" &&
          step.with?.path === `Application Support/firstmate/${out}/`,
      );
      expect(workflowString(kept?.with?.name ?? "", { matrix: { shard } })).toBe(
        `e2e-alone-${shard}`,
      );
      expect(onAlone(kept)).toBe(true);
      const summarize = job?.steps.find((step) => step.run?.includes("--summarize"));
      expect(summarize?.run).toBe(
        `node scripts/e2e-alone.ts --summarize ${out} | tee -a "$GITHUB_STEP_SUMMARY"`,
      );
      expect(onAlone(summarize)).toBe(true);
    },
  );
});

// INF-1613's submitted unblock answer: absent storage never stops tap releases;
// partial configuration is an error, not an accidental silent installer opt-out.
it("selects Homebrew/Linux-only before storage setup and refuses partial R2 configuration", () => {
  const workflow = loadYamlFile(".github/workflows/release.yml") as {
    jobs: { release: { steps: { id?: string; run?: string }[] } };
  };
  const command = workflow.jobs.release.steps.find((step) => step.id === "visibility")?.run;
  if (!command) throw new Error("Missing download activation command");
  for (const configuration of ["absent", "complete", "partial"]) {
    const folder = scratchDir("infinitary-r2-activation-");
    const output = join(folder, "output");
    const result = spawnSync("bash", ["-e", "-c", command], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        R2_ENDPOINT: configuration === "absent" ? "" : "https://account.r2.cloudflarestorage.com",
        R2_BUCKET: configuration === "absent" ? "" : "installers",
        HAS_ACCESS_KEY: configuration === "absent" ? "false" : "true",
        HAS_SECRET_KEY: configuration === "complete" ? "true" : "false",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(folder, "summary"),
      },
    });
    if (configuration === "partial") {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Incomplete download storage configuration");
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`direct=${configuration === "complete"}\n`);
    }
  }
});
