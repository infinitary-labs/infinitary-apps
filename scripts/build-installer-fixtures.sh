#!/bin/bash
# Real release binaries at ordered fixture versions, never tags or published releases.
# Apple notarizes each copy while the next one builds: every version has its own
# packaging folder and submission, and its finishing (notarization, Gatekeeper,
# its kept zip and disk image) runs in the background. The step waits for every
# finishing and fails when any one failed (docs/alpha.md, "Isolated signed verification").
set -euo pipefail
node scripts/installer-environment.ts
: "${INSTALLER_FIXTURES:?}" "${CSC_KEYCHAIN:?}" "${APPLE_API_KEY:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}" "${SIGN_IDENTITY:?}"
: "${INSTALLER_EVIDENCE:?}"
mkdir -p "$INSTALLER_FIXTURES" "$INSTALLER_EVIDENCE/notarization"
cp tests/fixtures/installed-updates/versions.json "$INSTALLER_FIXTURES/versions.json"
VERSIONS="$(node -p 'Object.values(require("./tests/fixtures/installed-updates/versions.json")).join(" ")')"
FIRST_ALPHA="$(node -p 'require("./tests/fixtures/installed-updates/versions.json").alphaBefore')"
FIRST_STABLE="$(node -p 'require("./tests/fixtures/installed-updates/versions.json").promotedStable')"

# Everything one version needs once its signed app passed the signed check:
# Apple's answer and ticket, the Gatekeeper check, the kept zip and, for the
# two versions installed from a disk image, that image signed and notarized.
finish() {
  local VERSION="$1" OUTPUT="$2"
  local APP="$OUTPUT/mac-universal/Infinitary.app"
  local SUBMIT="$OUTPUT/notarize.zip"
  node scripts/installer-notarize.ts "$SUBMIT" "$APP" "$INSTALLER_EVIDENCE/notarization/$VERSION-app.json"
  rm "$SUBMIT"
  scripts/verify-app.sh "$APP" --signed --gatekeeper
  local ZIP="$INSTALLER_FIXTURES/Infinitary-$VERSION-universal.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
  if [[ "$VERSION" == "$FIRST_ALPHA" || "$VERSION" == "$FIRST_STABLE" ]]; then
    # Its own folder, so two disk images built at once never share one.
    scripts/build-mac-dmg.sh "$APP" "$VERSION" "$OUTPUT/dmg"
    local DMG="$INSTALLER_FIXTURES/Infinitary-$VERSION-mac-universal.dmg"
    mv "$OUTPUT/dmg/Infinitary-$VERSION-mac-universal.dmg" "$DMG"
    codesign --force --sign "$SIGN_IDENTITY" --keychain "$CSC_KEYCHAIN" --timestamp "$DMG"
    node scripts/installer-notarize.ts "$DMG" "$DMG" "$INSTALLER_EVIDENCE/notarization/$VERSION-dmg.json"
    scripts/verify-mac-dmg.sh "$DMG" "$ZIP" "$VERSION"
  fi
  rm -rf "$OUTPUT"
}

FINISHING=()
FINISHED_VERSIONS=()
# Ends every finishing still running when the step stops early.
trap 'for pid in ${FINISHING[@]+"${FINISHING[@]}"}; do kill "$pid" 2>/dev/null || true; done' EXIT
for VERSION in $VERSIONS; do
  OUTPUT="$RUNNER_TEMP/installer-package-$VERSION"
  rm -rf "$OUTPUT"
  pnpm exec electron-builder --mac dir --universal --publish never -c.mac.notarize=false \
    -c.extraMetadata.version="$VERSION" -c.mac.bundleShortVersion="${VERSION%%-*}" \
    -c.mac.bundleVersion="${VERSION%%-*}" -c.directories.output="$OUTPUT"
  # Only the universal app is kept: each chip's own build is gone once merged.
  find "$OUTPUT" -mindepth 1 -maxdepth 1 ! -name mac-universal -exec rm -rf {} +
  APP="$OUTPUT/mac-universal/Infinitary.app"
  scripts/verify-app.sh "$APP" --signed
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUTPUT/notarize.zip"
  # Each finishing's lines carry its version, since they interleave with the next build's.
  (finish "$VERSION" "$OUTPUT" 2>&1 | sed -u "s/^/[$VERSION] /"; exit "${PIPESTATUS[0]}") &
  FINISHING+=("$!")
  FINISHED_VERSIONS+=("$VERSION")
done
FAILED=()
for i in "${!FINISHING[@]}"; do
  wait "${FINISHING[$i]}" || FAILED+=("${FINISHED_VERSIONS[$i]}")
done
FINISHING=()
if [[ "${#FAILED[@]}" -gt 0 ]]; then
  echo "::error title=Signed test copies::Finishing failed for ${FAILED[*]}; each version's lines above carry its name." >&2
  exit 1
fi
# A byte-tampered signed bundle, with an honest ZIP digest, is made on each
# checking Mac from the alphaAfter copy (scripts/installer-tampered-copy.ts),
# so it is never uploaded.
node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.INSTALLER_FIXTURES;
const files = {};
for (const name of readdirSync(root).filter(name => /\.(zip|dmg)$/.test(name))) {
  const sha256 = createHash('sha256'); const sha512 = createHash('sha512');
  for await (const chunk of createReadStream(join(root, name))) { sha256.update(chunk); sha512.update(chunk); }
  files[name] = { sha256: sha256.digest('hex'), sha512: sha512.digest('base64'), size: statSync(join(root, name)).size };
}
writeFileSync(join(root, 'digests.json'), JSON.stringify(files, null, 2));
JS
