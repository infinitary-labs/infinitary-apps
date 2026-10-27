#!/bin/bash
# Real release binaries at ordered fixture versions, never tags or published releases.
set -euo pipefail
node scripts/installer-environment.ts
: "${INSTALLER_FIXTURES:?}" "${CSC_KEYCHAIN:?}" "${APPLE_API_KEY:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}" "${SIGN_IDENTITY:?}"
: "${INSTALLER_EVIDENCE:?}"
mkdir -p "$INSTALLER_FIXTURES" "$INSTALLER_EVIDENCE/notarization"
cp tests/fixtures/installed-updates/versions.json "$INSTALLER_FIXTURES/versions.json"
VERSIONS="$(node -p 'Object.values(require("./tests/fixtures/installed-updates/versions.json")).join(" ")')"
FIRST_ALPHA="$(node -p 'require("./tests/fixtures/installed-updates/versions.json").alphaBefore')"
FIRST_STABLE="$(node -p 'require("./tests/fixtures/installed-updates/versions.json").promotedStable')"
for VERSION in $VERSIONS; do
  OUTPUT="$RUNNER_TEMP/installer-package"
  rm -rf "$OUTPUT"
  pnpm exec electron-builder --mac dir --universal --publish never -c.mac.notarize=false \
    -c.extraMetadata.version="$VERSION" -c.mac.bundleShortVersion="${VERSION%%-*}" \
    -c.mac.bundleVersion="${VERSION%%-*}" -c.directories.output="$OUTPUT"
  APP="$OUTPUT/mac-universal/Infinitary.app"
  scripts/verify-app.sh "$APP" --signed
  SUBMIT="$RUNNER_TEMP/installer-notarize.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$SUBMIT"
  node scripts/installer-notarize.ts "$SUBMIT" "$APP" "$INSTALLER_EVIDENCE/notarization/$VERSION-app.json"
  rm "$SUBMIT"
  scripts/verify-app.sh "$APP" --signed --gatekeeper
  ZIP="$INSTALLER_FIXTURES/Infinitary-$VERSION-universal.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
  if [[ "$VERSION" == "$FIRST_ALPHA" || "$VERSION" == "$FIRST_STABLE" ]]; then
    scripts/build-mac-dmg.sh "$APP" "$VERSION" "$INSTALLER_FIXTURES"
    DMG="$INSTALLER_FIXTURES/Infinitary-$VERSION-mac-universal.dmg"
    codesign --force --sign "$SIGN_IDENTITY" --keychain "$CSC_KEYCHAIN" --timestamp "$DMG"
    node scripts/installer-notarize.ts "$DMG" "$DMG" "$INSTALLER_EVIDENCE/notarization/$VERSION-dmg.json"
    scripts/verify-mac-dmg.sh "$DMG" "$ZIP" "$VERSION"
  fi
done
# A byte-tampered signed bundle, with an honest ZIP digest: native signature validation,
# not the transport checksum, must reject this copy before any installed app changes.
BAD="$RUNNER_TEMP/installer-invalid-signature"
mkdir -p "$BAD"
VERSION="$(node -p 'require("./tests/fixtures/installed-updates/versions.json").alphaAfter')"
ditto -x -k "$INSTALLER_FIXTURES/Infinitary-$VERSION-universal.zip" "$BAD"
printf '\n' >> "$BAD/Infinitary.app/Contents/Resources/app.asar"
ditto -c -k --sequesterRsrc --keepParent "$BAD/Infinitary.app" "$INSTALLER_FIXTURES/invalid-signature.zip"
rm -rf "$BAD" "$RUNNER_TEMP/installer-package"
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
