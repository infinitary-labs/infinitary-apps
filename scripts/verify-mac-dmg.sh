#!/bin/bash
# The finalized installer must contain exactly the finalized ZIP's app and an Applications link.
set -euo pipefail
DMG="${1:?usage: verify-mac-dmg.sh disk-image zip version}"
ZIP="${2:?}"
VERSION="${3:?}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/infinitary-dmg-check.XXXXXX")"
MOUNT="$WORK/mount"
MOUNTED=false
cleanup() {
  if [[ "$MOUNTED" == true ]]; then
    "$SCRIPTS/detach-disk-image.sh" "$MOUNT" || return
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
xcrun stapler validate "$DMG"
codesign --verify --strict "$DMG"
spctl --assess --type open --context context:primary-signature "$DMG"
mkdir -p "$MOUNT" "$WORK/zip" "$WORK/Applications"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$DMG" >/dev/null
MOUNTED=true
[[ -L "$MOUNT/Applications" && "$(readlink "$MOUNT/Applications")" == /Applications ]]
[[ -f "$MOUNT/.DS_Store" ]]
[[ -n "$(find "$MOUNT" -maxdepth 2 -name '.background*' -print -quit)" ]]
ditto -x -k "$ZIP" "$WORK/zip"
diff -qr "$WORK/zip/Infinitary.app" "$MOUNT/Infinitary.app"
ditto "$MOUNT/Infinitary.app" "$WORK/Applications/Infinitary.app"
# Verify the installed ownership facts too: custom attributes are not part of diff's file comparison.
RECEIPT="$SCRIPTS/../packaging/mac-installation.json"
ATTRIBUTE="$(node -p 'require(process.argv[1]).attribute' "$RECEIPT")"
RESOURCE="$(node -p 'require(process.argv[1]).path' "$RECEIPT")"
DIRECT="$(node -p 'require(process.argv[1]).direct' "$RECEIPT")"
for APP in "$WORK/zip/Infinitary.app" "$MOUNT/Infinitary.app" "$WORK/Applications/Infinitary.app"; do
  [[ "$(xattr -p "$ATTRIBUTE" "$APP/$RESOURCE")" == "$DIRECT" ]] || {
    echo 'The installer or updater lost its direct-install ownership receipt.' >&2
    exit 1
  }
done
"$SCRIPTS/verify-app.sh" "$WORK/Applications/Infinitary.app" --signed --gatekeeper
"$SCRIPTS/check-app-launch.sh" "$WORK/Applications/Infinitary.app" "$VERSION"
echo 'Installer verified: notarized image, Applications link, identical finalized app, direct-install ownership, copied app launches.'
