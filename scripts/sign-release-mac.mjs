#!/usr/bin/env node
// electron-builder's `mac.sign` hook for the release (electron-builder.yml).
//
// It signs exactly as electron-builder's own signer would, with one addition:
// the files signed under the app's identifier get an explicit designated
// requirement naming every team in packaging/release-identity.json
// (src/shared/releaseRequirement.ts). Squirrel.Mac installs an update only when
// it satisfies the running copy's designated requirement, so a copy signed this
// way accepts the next team's release.
//
// Those files are the app bundle and the background file beside its main
// executable, which carries the app's bundle id (scripts/place-mac-app-launcher.mjs)
// and needs the app's designated requirement too, so the Keychain and macOS's
// permissions take a run from it for the app itself (scripts/verify-app.sh
// checks both).
//
// The main executable needs nothing of its own: signing the bundle replaces its
// signature with the bundle's. A helper, framework or other nested executable
// has its own identifier, so the requirement would leave each one failing it
// and `codesign --verify --strict`. electron-builder's `mac.requirements` would
// apply one requirement to every file it signs, which is why this is a hook.

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { RELEASE_DESIGNATED_REQUIREMENT } from "../src/shared/releaseRequirement.ts";
import { MAC_BACKGROUND_SUFFIX } from "./place-mac-app-launcher.mjs";

/**
 * electron-builder's signer (`@electron/osx-sign` behind its own retry), not a
 * dependency of this repo: reached through electron-builder, as
 * scripts/sign-local-mac.mjs reaches osx-sign.
 */
function resolveMacCodeSign() {
  const require = createRequire(import.meta.url);
  const electronBuilder = createRequire(require.resolve("electron-builder/package.json"));
  const appBuilderLib = createRequire(electronBuilder.resolve("app-builder-lib/package.json"));
  return appBuilderLib("app-builder-lib/out/codeSign/macCodeSign");
}

/**
 * The signer's options: electron-builder's, with the requirement on the app
 * bundle and its background file. The signer names the bundle as it was given
 * and each file inside it by its resolved path.
 */
export function releaseSignOptions(configuration) {
  const inheritedOptionsForFile = configuration.optionsForFile;
  const executables = join(resolve(configuration.app), "Contents", "MacOS");
  const signedAsApp = (filePath) =>
    filePath === configuration.app ||
    (dirname(filePath) === executables && filePath.endsWith(MAC_BACKGROUND_SUFFIX));
  return {
    ...configuration,
    optionsForFile: (filePath) => {
      const inherited = inheritedOptionsForFile ? inheritedOptionsForFile(filePath) : {};
      return signedAsApp(filePath)
        ? { ...inherited, requirements: `=${RELEASE_DESIGNATED_REQUIREMENT}` }
        : inherited;
    },
  };
}

export async function sign(configuration) {
  await resolveMacCodeSign().sign(releaseSignOptions(configuration));
}

export default sign;
