#!/usr/bin/env node
// The reproducible macOS check behind docs/local-code-signing.md: print the
// code identity and designated requirement of every local form, and fail if
// any of them is ad-hoc or signed by something other than this machine's
// local certificate. It reads designated-requirement.txt and does not call
// `security`: verification does not use the private key.
//
// Run it before and after `rm -rf node_modules && pnpm install && pnpm
// codesign:local`, or before and after `pnpm package:mac`: the cdhash moves,
// the designated requirement does not. That stability is exactly what a
// Keychain "Always Allow" grant is matched against.
//
//   node scripts/verify-local-codesign.mjs                # dev run + dist/
//   node scripts/verify-local-codesign.mjs --packaged     # dist/ only
//   node scripts/verify-local-codesign.mjs <path.app ...> # explicit targets
//
// `--packaged` is what `pnpm package:mac` checks: the app it just built. The
// dev Electron is signed by `pnpm dev`, not by an install, so a clone that
// has never run `pnpm dev` can still package.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codesignBin,
  readDesignatedRequirement,
  readStoredRequirement,
  satisfiesRequirement,
} from "./local-codesign.mjs";
import { resolveDevElectronApp } from "./prepare-local-codesign.mjs";

/** Every `*.app` electron-builder may have written under `dist/`. */
export function packagedApps(cwd = process.cwd()) {
  const dist = join(cwd, "dist");
  if (!existsSync(dist)) {
    return [];
  }
  return readdirSync(dist, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = join(dist, entry.name);
      return readdirSync(dir)
        .filter((name) => name.endsWith(".app"))
        .map((name) => join(dir, name));
    });
}

function describe(target) {
  const result = spawnSync(codesignBin(), ["-d", "--verbose=4", target], {
    encoding: "utf8",
  });
  const report = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const field = (name) => new RegExp(`^${name}=(.+)$`, "m").exec(report)?.[1]?.trim() ?? "(none)";
  return {
    identifier: field("Identifier"),
    cdhash: field("CDHash"),
    authority: field("Authority"),
  };
}

function main(argv) {
  if (process.platform !== "darwin") {
    console.log("[infinitary] local code signing is macOS-only - nothing to verify");
    return 0;
  }

  // Read the requirement from disk. Do not call ensureLocalSigningIdentity:
  // that unlocks the signing keychain, and verify does not need the private key.
  const requirement = readStoredRequirement();
  if (requirement === null) {
    console.error(
      "[infinitary] no designated requirement on disk. " +
        "Run `pnpm codesign:local` once the dev Electron is downloaded.",
    );
    return 1;
  }
  const identity = { requirement };
  const packagedOnly = argv.length === 1 && argv[0] === "--packaged";
  const targets = packagedOnly
    ? packagedApps()
    : argv.length > 0
      ? argv
      : [resolveDevElectronApp(), ...packagedApps()].filter(Boolean);

  if (targets.length === 0) {
    console.error(
      packagedOnly
        ? "[infinitary] nothing to verify: dist/ holds no app."
        : "[infinitary] nothing to verify: Electron is not downloaded and dist/ holds no app.",
    );
    return 1;
  }

  console.log(`expected designated requirement: ${identity.requirement}\n`);
  let failed = 0;
  for (const target of targets) {
    const { identifier, cdhash, authority } = describe(target);
    const ok = satisfiesRequirement(target, identity.requirement);
    if (!ok) {
      failed += 1;
    }
    console.log(`${ok ? "ok  " : "FAIL"} ${target}`);
    console.log(`       identifier: ${identifier}`);
    console.log(`       authority:  ${authority}`);
    console.log(`       cdhash:     ${cdhash}   <- moves on every rebuild; the grant does not use it`);
    console.log(`       designated: ${readDesignatedRequirement(target) ?? "(unsigned)"}\n`);
  }

  if (failed > 0) {
    console.error(
      `[infinitary] ${failed} target(s) do not carry the local code identity. ` +
        "Run `pnpm codesign:local` (dev run) or `pnpm package:mac` (local package).",
    );
  }
  return failed > 0 ? 1 : 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}
