#!/usr/bin/env node
// Electron 43's published npm tarball dropped the `postinstall` lifecycle
// script that used to download Electron.app: the registry metadata still
// lists `scripts.postinstall = node install.js`, but the tarball's own
// package.json has no `scripts` field at all, only `bin` entries (`electron`,
// `install-electron`). pnpm therefore has no lifecycle hook to run for the
// electron package, so a plain `pnpm install` leaves node_modules/electron
// with just the Node wrapper and no binary - anything that reads its
// dist/path.txt directly (electron-vite's dev/build) fails with
// "Electron uninstall" instead of self-healing.
//
// Run electron's own installer (install.js, aka the `install-electron` bin)
// here rather than reimplementing the download. It already no-ops fast
// (no network) once dist/ matches the installed version, so this step stays
// cheap on every repeat install.
import { createRequire } from "node:module";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveElectronDir(cwd = process.cwd()) {
  const require = createRequire(join(cwd, "package.json"));
  return dirname(require.resolve("electron/package.json"));
}

export function ensureElectronInstalled(electronDir, { spawnSync = nodeSpawnSync } = {}) {
  const result = spawnSync(process.execPath, [join(electronDir, "install.js")], {
    stdio: "inherit",
  });

  if (result.error || result.status !== 0) {
    const reason = result.error
      ? result.error.message
      : result.status !== null
        ? `exit code ${result.status}`
        : `signal ${result.signal}`;
    console.error(
      `[infinitary] Electron binary could not be downloaded (electron's installer failed: ${reason}). ` +
        "pnpm install cannot finish without a runnable Electron binary - check network access and re-run `pnpm install`.",
    );
    return 1;
  }

  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exit(ensureElectronInstalled(resolveElectronDir()));
}
