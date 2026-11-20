#!/usr/bin/env node
// Puts each Electron zip a package reads into the download cache
// electron-builder reads, checked against the checksums Electron's own package
// ships, so electron-builder finds them there with no request to GitHub's
// release server.
//
// electron-builder downloads every Electron zip a package needs itself, and
// for each one fetches Electron's SHASUMS256.txt fresh even when the zip is
// cached. A universal Mac package reads both Mac zips, while an install keeps
// only the machine's own (action.yml beside this file). Main's check run
// 42463836430 and the alpha run 42464772458 failed when that server answered
// 504 there, in the Mac check's package step and in the release's Mac and
// Linux package steps.
//
// This reads the zips through electron-builder's own downloader, so they land
// where electron-builder looks, and checks each against Electron's bundled
// checksums.json the way Electron's own installer checks its zip: a cached zip
// needs no request, and a missing one is downloaded once and kept in the
// cache. Each package step runs it first and then has electron-builder read
// that cache with its own checksum download off, since every zip it reads
// there was checked here a moment before.
//
// The cache is the one electron_config_cache names, as this action sets it,
// or else electron-builder's own default, a machine's persistent cache.
//
// It lives beside the action so a release's jobs run the workflow's own copy:
// a stable builds an older alpha's commit, which may predate it.
//
// Usage, from the project's folder:
//   node .github/actions/electron-download/zips.mjs <platform> <arch>...
import { createRequire } from "node:module";
import { basename, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * electron-builder's own Electron downloader, reached through the project's
 * electron-builder the way scripts/sign-local-mac.mjs reaches its signer, so
 * a zip lands in the cache folder electron-builder's lookup computes.
 */
function builderDownloader(project) {
  const electronBuilder = createRequire(project.resolve("electron-builder/package.json"));
  const appBuilderLib = createRequire(electronBuilder.resolve("app-builder-lib/package.json"));
  return appBuilderLib("@electron/get");
}

/**
 * Reads the installed Electron's zip for each arch into `cacheRoot`, or
 * electron-builder's default cache when it names none, checked against
 * Electron's bundled checksums, and returns each zip's path there and whether
 * it had to be downloaded, telling `onZip` as each one is read.
 */
export async function readElectronZips({
  platform,
  arches,
  cacheRoot,
  cwd = process.cwd(),
  onZip = () => {},
}) {
  const project = createRequire(join(cwd, "package.json"));
  const electron = createRequire(project.resolve("electron/package.json"));
  const { version } = electron("./package.json");
  const checksums = electron("./checksums.json");
  const { downloadArtifact } = builderDownloader(project);
  const zips = [];
  for (const arch of arches) {
    // With the checksums given, the zip is the one thing it may download.
    let downloaded = false;
    const path = await downloadArtifact({
      version,
      artifactName: "electron",
      platform,
      arch,
      ...(cacheRoot ? { cacheRoot } : {}),
      checksums,
      downloadOptions: {
        getProgressCallback: async () => {
          downloaded = true;
        },
      },
    });
    // electron-builder finds only what is in the cache; a zip anywhere else
    // would leave it downloading, with no checksum, the one this checked.
    const inside = cacheRoot ? relative(cacheRoot, path) : "";
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`${basename(path)} was kept outside the download cache, at ${path}`);
    }
    zips.push({ path, downloaded });
    onZip({ path, downloaded });
  }
  return zips;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [platform, ...arches] = process.argv.slice(2);
  if (!platform || arches.length === 0) {
    console.error("usage: node .github/actions/electron-download/zips.mjs <platform> <arch>...");
    process.exit(2);
  }
  try {
    // Each zip's line comes as it is read, so a failed download follows the zips it did read.
    await readElectronZips({
      platform,
      arches,
      cacheRoot: process.env.electron_config_cache || undefined,
      onZip: ({ path, downloaded }) =>
        console.log(
          `[infinitary] ${basename(path)} ${downloaded ? "was downloaded into" : "was already in"} the download cache, checked against Electron's checksums`,
        ),
    });
  } catch (error) {
    console.error(`[infinitary] Electron's zips could not be read into the download cache: ${error.stack ?? error}`);
    process.exit(1);
  }
}
