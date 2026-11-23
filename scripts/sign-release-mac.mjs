#!/usr/bin/env node
// electron-builder's `mac.sign` hook for the release (electron-builder.yml).
//
// It signs exactly as electron-builder's own signer would, with one addition:
// the app bundle gets an explicit designated requirement naming every team in
// packaging/release-identity.json (src/shared/releaseRequirement.ts). Squirrel.Mac
// installs an update only when it satisfies the running copy's designated
// requirement, so a copy signed this way accepts the next team's release.
//
// Only the app bundle takes it. The requirement names the app's identifier,
// which a helper, framework or nested executable does not have, so giving it
// to them would leave each one failing its own requirement and
// `codesign --verify --strict`. electron-builder's `mac.requirements` would
// apply one requirement to every file it signs, which is why this is a hook.

import { createRequire } from "node:module";
import { RELEASE_DESIGNATED_REQUIREMENT } from "../src/shared/releaseRequirement.ts";

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

/** The signer's options: electron-builder's, with the requirement on the app bundle alone. */
export function releaseSignOptions(configuration) {
  const inheritedOptionsForFile = configuration.optionsForFile;
  return {
    ...configuration,
    optionsForFile: (filePath) => {
      const inherited = inheritedOptionsForFile ? inheritedOptionsForFile(filePath) : {};
      return filePath === configuration.app
        ? { ...inherited, requirements: `=${RELEASE_DESIGNATED_REQUIREMENT}` }
        : inherited;
    },
  };
}

export async function sign(configuration) {
  await resolveMacCodeSign().sign(releaseSignOptions(configuration));
}

export default sign;
