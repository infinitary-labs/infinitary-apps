// Infinitary's own executables on a Mac (scripts/mac-app-launcher.m;
// docs/run.md, "Opened while it runs"): compiled for both chips into one
// file each and put in place of Electron's main executable,
// Contents/MacOS/<name>, and beside it as Contents/MacOS/<name> Background,
// the file a start that shows no window runs from.
//
// The background file carries the app's bundle id in an Info.plist of its
// own, which codesign takes as the file's signing identifier, so the release
// and the local package sign it under the app's own name, as they sign the
// main executable, with nothing in their signing set up for it. It is also
// signed ad hoc as it is compiled: the signing pass signs the files of
// Contents/MacOS in the order it lists them, and the main executable's
// signature seals the files beside it, which codesign refuses while one of
// them carries no signature at all. The signing pass then replaces it.
//
// Each records the macOS SDK Electron's own executable records, not the one
// the packaging Mac's developer tools hold: AppKit chooses which of its
// behaviors a window gets by the SDK the main executable records, so the
// window keeps Electron's whichever Xcode packaged the app.
//
// electron-builder runs it as part of afterPack (scripts/after-pack.mjs) on
// each architecture's bundle and on the final universal one, before the
// fuses flip and before signing. A file that already holds both chips is one
// @electron/universal takes as it is, so neither needs a line in
// mac.x64ArchFiles. The build compiles each once and puts the same files in
// each bundle.
//
// Only a Mac builds the Mac app, with Apple's developer tools; a build
// without them stops here with the compiler's words rather than ship
// Electron's executable in its place.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The launcher's source. */
export const MAC_APP_LAUNCHER_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "mac-app-launcher.m",
);

/** The background file's name beside the main executable's (BACKGROUND_SUFFIX in the source). */
export const MAC_BACKGROUND_SUFFIX = " Background";

/** The macOS SDK version `file` records it was built with, the first one it lists. */
function recordedSdk(file) {
  const shown = execFileSync("/usr/bin/xcrun", ["vtool", "-show-build", file], {
    encoding: "utf8",
  });
  const sdk = /^\s*sdk (\S+)$/m.exec(shown)?.[1];
  if (!sdk) throw new Error(`no macOS SDK version recorded in ${file}`);
  return sdk;
}

/** One value of a bundle's Info.plist, as text. */
function infoValue(bundle, key) {
  return execFileSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", join(bundle, "Contents", "Info.plist")],
    { encoding: "utf8" },
  ).trim();
}

/** `text` as plist string content. */
function plistText(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Compiles the launcher to `out` for both Mac chips, for macOS `oldest` and
 * later, recording macOS SDK `sdk`; with `bundleId`, the file carries an
 * Info.plist naming it, as the background file does. Throws with the
 * compiler's words when it fails.
 */
export function compileMacAppLauncher(out, oldest, sdk, bundleId) {
  // A build for two chips leaves empty folders in the compiler's temporary
  // folder, so it gets one of its own, removed after it.
  const scratch = mkdtempSync(join(tmpdir(), "infinitary-app-launcher-build-"));
  const ownInfo = [];
  if (bundleId) {
    const info = join(scratch, "Info.plist");
    writeFileSync(
      info,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "\t<key>CFBundleIdentifier</key>",
        `\t<string>${plistText(bundleId)}</string>`,
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
    ownInfo.push("-sectcreate", "__TEXT", "__info_plist", info);
  }
  const run = spawnSync(
    "/usr/bin/xcrun",
    [
      "clang",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
      `-mmacosx-version-min=${oldest}`,
      "-fobjc-arc",
      "-O2",
      "-Wall",
      "-Werror",
      "-framework",
      "Foundation",
      // Electron Framework's own libraries are found beside it, as from
      // Electron's executable.
      "-Wl,-rpath,@executable_path/../Frameworks",
      `-Wl,-platform_version,macos,${oldest},${sdk}`,
      ...ownInfo,
      "-o",
      out,
      MAC_APP_LAUNCHER_SOURCE,
    ],
    { encoding: "utf8", env: { ...process.env, TMPDIR: `${scratch}/` } },
  );
  rmSync(scratch, { recursive: true, force: true });
  if (run.status !== 0) {
    throw new Error(
      `could not compile the app's own executable: ${run.error?.message ?? run.stderr.trim()}`,
    );
  }
}

/** What this build compiled, by the oldest macOS, the SDK and the bundle id it was compiled for. */
const compiled = new Map();

/**
 * The launcher compiled for macOS `oldest` and SDK `sdk` (and `bundleId`),
 * compiling it the first time it is asked for; with `bundleId`, signed ad hoc
 * under it.
 */
function launcherFor(oldest, sdk, bundleId) {
  const key = JSON.stringify([oldest, sdk, bundleId ?? null]);
  const known = compiled.get(key);
  if (known) return known;
  const dir = mkdtempSync(join(tmpdir(), "infinitary-app-launcher-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "launcher");
  compileMacAppLauncher(out, oldest, sdk, bundleId);
  if (bundleId) {
    // An ad-hoc signature reaches no keychain; codesign names it by the
    // bundle id the file carries.
    const signed = spawnSync("/usr/bin/codesign", ["--sign", "-", "--force", out], {
      encoding: "utf8",
    });
    if (signed.status !== 0) {
      throw new Error(
        `could not sign the background file ad hoc: ${signed.error?.message ?? signed.stderr.trim()}`,
      );
    }
  }
  compiled.set(key, out);
  return out;
}

/** Puts `source` at `target` whole, as an executable, so nothing of a file there before stays behind. */
function put(source, target) {
  const beside = `${target}.launcher`;
  copyFileSync(source, beside);
  chmodSync(beside, 0o755);
  renameSync(beside, target);
}

/**
 * Puts the launcher in place of `bundle`'s main executable and the
 * background file beside it, for the oldest macOS its Info.plist names and
 * the SDK the executable it replaces records.
 */
export function placeMacAppLauncher(bundle) {
  const executable = join(bundle, "Contents", "MacOS", infoValue(bundle, "CFBundleExecutable"));
  if (!existsSync(executable)) throw new Error(`no main executable at ${executable}`);
  const oldest = infoValue(bundle, "LSMinimumSystemVersion");
  const sdk = recordedSdk(executable);
  put(launcherFor(oldest, sdk), executable);
  put(
    launcherFor(oldest, sdk, infoValue(bundle, "CFBundleIdentifier")),
    `${executable}${MAC_BACKGROUND_SUFFIX}`,
  );
}

/** electron-builder's afterPack step for a Mac bundle; any other system's is left as it is. */
export default function placeMacAppLauncherAfterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  placeMacAppLauncher(
    join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
  );
}
