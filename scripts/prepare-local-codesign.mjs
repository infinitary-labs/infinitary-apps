#!/usr/bin/env node
// Makes `pnpm dev` launch an Electron main executable with the stable local
// code identity described in scripts/local-codesign.mjs.
//
// Signs from `predev` (so an Electron upgrade, a re-download, or a wiped
// node_modules is re-signed at the moment it matters) and from `pnpm
// codesign:local`. Both are idempotent. When designated-requirement.txt
// exists and the dev Electron already satisfies it, this returns without
// calling `security` against the local signing keychain: `codesign --verify`
// does not use the private key. Signing runs only when that check fails, or
// when there is no stored requirement yet.
//
// From an install (`postinstall`, or any other stage in INSTALL_STAGES) it
// only checks, and never calls `security` or signs. An install is not
// something a person always asked for: pnpm installs on its own before a
// `pnpm run` or `pnpm exec` whose packages are out of date - after a branch is
// brought up to date with a new version, say - and the app installs every
// working copy it makes for a crewmate. Signing can unlock, rebuild, or
// regenerate the machine's one signing keychain, so it waits for `pnpm dev`.
//
// The stock Electron.app is signed top-level only, with `--identifier` set to
// the dev appId. Top-level is enough because the Keychain request comes from
// the main process, which IS `Electron.app/Contents/MacOS/Electron`; the
// nested helpers and frameworks keep the linker's ad-hoc signatures exactly as
// they arrive from Electron's own download, and `codesign --verify --strict`
// on the bundle passes either way.
//
// Failure is a warning, never an error, unless `--strict` is passed (which is
// what `pnpm codesign:local` does): a developer whose signing setup is broken
// should still get a running app - they just get the macOS prompt back.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronDir } from "./ensure-electron-installed.mjs";
import {
  LOCAL_IDENTITY_NAME,
  LOCAL_SIGNING_IDENTIFIER,
  assertSatisfiesRequirement,
  dropLocalKeychainFromSearchList,
  ensureLocalSigningIdentity,
  localCodesignPaths,
  readDesignatedRequirement,
  readStoredRequirement,
  satisfiesRequirement,
  signWithLocalIdentity,
} from "./local-codesign.mjs";

const PREFIX = "[infinitary]";

/**
 * The lifecycle stages a package manager runs as part of an install; it names
 * the running one in `npm_lifecycle_event`. Run from any of them, this script
 * only checks.
 */
export const INSTALL_STAGES = new Set(["preinstall", "install", "postinstall", "prepare"]);

/**
 * The bundle electron-vite launches. `path.txt` is electron's own record of
 * its executable relative to `dist/` (electron/index.js reads the same file);
 * follow it rather than assuming the bundle name, and sign the enclosing .app
 * so the main executable is sealed together with its bundle.
 */
export function resolveDevElectronApp(cwd = process.cwd()) {
  const electronDir = resolveElectronDir(cwd);
  const pathFile = join(electronDir, "path.txt");
  if (!existsSync(pathFile)) {
    return null;
  }
  const executable = join(electronDir, "dist", readFileSync(pathFile, "utf8").trim());
  const bundle = executable.replace(/\.app\/Contents\/MacOS\/[^/]+$/, ".app");
  const target = bundle.endsWith(".app") ? bundle : executable;
  return existsSync(target) ? target : null;
}

export function prepareLocalCodesign({ cwd = process.cwd(), log = console.log, app } = {}) {
  const target = app !== undefined ? app : resolveDevElectronApp(cwd);
  const stored = readStoredRequirement();
  const note = (message) => log(`${PREFIX} ${message}`);

  // Routine install and dev. Verification does not open the signing keychain.
  // The one allowed `security` call is list-keychains, once, to take this file
  // off the user search list. It does not open the keychain.
  if (stored !== null && target !== null && satisfiesRequirement(target, stored)) {
    dropLocalKeychainFromSearchList({ log: note, once: true });
    log(`${PREFIX} dev Electron already carries the local code identity`);
    log(`${PREFIX} designated requirement: ${readDesignatedRequirement(target)}`);
    return { name: LOCAL_IDENTITY_NAME, requirement: stored, paths: localCodesignPaths() };
  }

  if (target === null) {
    log(
      `${PREFIX} Electron is not downloaded yet - skipping the dev signing step. ` +
        "Run `pnpm codesign:local` (or `pnpm dev`) once it is.",
    );
    dropLocalKeychainFromSearchList({ log: note, once: true });
    return null;
  }

  const identity = ensureLocalSigningIdentity({ log: note });

  if (satisfiesRequirement(target, identity.requirement)) {
    log(`${PREFIX} dev Electron already carries the local code identity`);
  } else {
    signWithLocalIdentity(target, { identifier: LOCAL_SIGNING_IDENTIFIER });
    assertSatisfiesRequirement(target, identity.requirement);
    log(`${PREFIX} signed ${target} with "${identity.name}"`);
  }

  log(`${PREFIX} designated requirement: ${readDesignatedRequirement(target)}`);
  return identity;
}

/**
 * The install-time step: say whether the dev Electron carries the local code
 * identity, and touch nothing. It reads designated-requirement.txt and runs
 * `codesign --verify`, which does not use the private key; it never calls
 * `security`, never signs, and never writes the signing material.
 */
export function checkLocalCodesign({ cwd = process.cwd(), log = console.log, app } = {}) {
  const target = app !== undefined ? app : resolveDevElectronApp(cwd);
  if (target === null) {
    log(`${PREFIX} Electron is not downloaded yet - \`pnpm dev\` signs it once it is.`);
    return false;
  }
  const stored = readStoredRequirement();
  if (stored !== null && satisfiesRequirement(target, stored)) {
    log(`${PREFIX} dev Electron already carries the local code identity`);
    return true;
  }
  log(
    `${PREFIX} dev Electron does not carry the local code identity yet - ` +
      "`pnpm dev` (or `pnpm codesign:local`) signs it; an install never opens the signing keychain.",
  );
  return false;
}

function main(argv, stage = process.env.npm_lifecycle_event) {
  if (process.platform !== "darwin") {
    return 0;
  }
  const strict = argv.includes("--strict");
  try {
    if (INSTALL_STAGES.has(stage)) {
      checkLocalCodesign();
      return 0;
    }
    prepareLocalCodesign();
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `${PREFIX} local code signing could not be prepared: ${reason}\n` +
        `${PREFIX} The app still runs, but macOS will keep asking for the Claude credential. ` +
        "See docs/local-code-signing.md, then re-run `pnpm codesign:local`.",
    );
    return strict ? 1 : 0;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
