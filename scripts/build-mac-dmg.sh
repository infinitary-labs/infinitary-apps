#!/usr/bin/env bash
# Package the finalized, stapled app without rebuilding or signing it.
# Signing/notarizing the container belongs to the isolated release workflow.
set -euo pipefail
if [[ $# != 3 ]]; then
  echo 'Usage: build-mac-dmg.sh <finalized.app> <logical-version> <output-directory>' >&2
  exit 2
fi
APP="$1"
VERSION="$2"
OUTPUT="$3"
[[ -d "$APP/Contents" ]] || { echo 'The finalized application is missing.' >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-alpha\.[0-9]+)?$ ]] || { echo 'Invalid release version.' >&2; exit 1; }
mkdir -p "$OUTPUT"
# identity=null is deliberate: even identity=- triggers a real keychain lookup.
# --prepackaged keeps the signed app exactly as notarized; no hook modifies it.
pnpm exec electron-builder --mac dmg --universal --publish never \
  --prepackaged "$APP" --config electron-builder.yml \
  -c.mac.identity=null -c.mac.notarize=false -c.dmg.sign=false \
  "-c.extraMetadata.version=$VERSION" "-c.directories.output=$OUTPUT" \
  "-c.artifactName=Infinitary-${VERSION}-mac-universal.dmg"
