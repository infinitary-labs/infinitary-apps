#!/usr/bin/env node
// electron-builder's `mac.sign` hook for electron-builder.dev.yml.
//
// electron-builder discovers signing identities with `security find-identity
// -v`, which only lists certificates that pass trust evaluation. The local
// certificate is deliberately self-signed and untrusted (trusting it would
// need an interactive authorization prompt), so the packager can never find
// it on its own. The overlay therefore keeps `identity: "-"` purely as the
// discovery placeholder that keeps electron-builder on its signing path, and
// this hook replaces the ad-hoc signature with the real local identity.
//
// It has to be `sign` and not `afterPack`: electron-builder flips the electron
// fuses AFTER the universal merge and immediately BEFORE signing, so anything
// earlier would be invalidated by the fuse edit (which is what made the dev
// overlay ad-hoc re-sign in the first place). `afterSign` would work but would
// leave a pointless ad-hoc pass over the whole bundle first.

import { createRequire } from "node:module";
import {
  assertSatisfiesRequirement,
  ensureLocalSigningIdentity,
  readDesignatedRequirement,
  withLocalKeychainOnSearchList,
} from "./local-codesign.mjs";

/**
 * @electron/osx-sign is electron-builder's own signer, not a dependency of
 * this repo; reach it through electron-builder exactly as
 * tests/release-contract.test.ts reaches its other internals, so the local
 * package is signed inside-out by the same code that signs a release.
 */
function resolveOsxSign() {
  const require = createRequire(import.meta.url);
  const electronBuilder = createRequire(require.resolve("electron-builder/package.json"));
  const appBuilderLib = createRequire(electronBuilder.resolve("app-builder-lib/package.json"));
  return appBuilderLib("@electron/osx-sign");
}

export async function sign(configuration) {
  const identity = ensureLocalSigningIdentity({
    log: (message) => console.log(`  • ${message}`),
  });
  const { signAsync } = resolveOsxSign();
  const inheritedOptionsForFile = configuration.optionsForFile;

  // osx-sign forwards `keychain` as codesign --keychain, which only narrows
  // the lookup: codesign still needs the file on the user search list, so it
  // joins the list for this step alone.
  await withLocalKeychainOnSearchList(() =>
    signAsync({
      ...configuration,
      identity: identity.name,
      keychain: identity.paths.keychain,
      // The certificate is untrusted on purpose; validating it would fail for
      // the same reason electron-builder cannot discover it.
      identityValidation: false,
      optionsForFile: (filePath) => ({
        ...(inheritedOptionsForFile ? inheritedOptionsForFile(filePath) : {}),
        // osx-sign defaults to `--timestamp`, i.e. a round trip to Apple's
        // timestamp authority per binary. A local certificate has nothing to
        // timestamp; secure timestamps belong to the release signature.
        timestamp: "none",
      }),
    }),
  );

  assertSatisfiesRequirement(configuration.app, identity.requirement);
  console.log(`  • local designated requirement: ${readDesignatedRequirement(configuration.app)}`);
}

export default sign;
