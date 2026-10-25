#!/bin/bash
# INF-80: ordinary Xcode automatic signing, only in the merged workflow.
# No security/keychain commands or upload retry. INF-259 cleanup is list-only pending review.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${GITHUB_REF:-}" != refs/heads/main || "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ]]; then
  echo 'Signing and uploading run only in the dispatched workflow on main.' >&2
  exit 1
fi
if [[ -n "${CHECK_BUILD:-}" ]]; then
  echo 'A status request must never archive or upload.' >&2
  exit 1
fi
: "${RUNNER_TEMP:?Missing runner temporary folder}"
: "${PHONE_RECEIPT:?Missing upload receipt path}"
# Validate before a credential is written or Xcode runs. Values are never evaluated as shell code.
node scripts/phone-release.ts resolve >/dev/null
VERSION="$PHONE_VERSION"
BUILD_NUMBER="$GITHUB_RUN_NUMBER.$GITHUB_RUN_ATTEMPT"

work="$(mktemp -d "$RUNNER_TEMP/infinitary-ios-release.XXXXXX")"
if [[ -n "${GITHUB_ENV:-}" ]]; then printf 'PHONE_RELEASE_WORK=%s\n' "$work" >> "$GITHUB_ENV"; fi
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077
key_path="$(node scripts/phone-release.ts prepare-key "$work/private-keys")"
archive="$work/Infinitary.xcarchive"
export_path="$work/export"

# Use the runner's selected Xcode, shared with the simulator gate; never change xcode-select.
xcodebuild -version
xcodebuild archive \
  -project ios/Infinitary/Infinitary.xcodeproj -scheme Infinitary \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$work/DerivedData" -archivePath "$archive" \
  -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile \
  -allowProvisioningUpdates -authenticationKeyPath "$key_path" \
  -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID" \
  -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID" \
  DEVELOPMENT_TEAM=9T2J7MNUP9 PRODUCT_BUNDLE_IDENTIFIER=com.getinfinitary.infinitary \
  CODE_SIGN_STYLE=Automatic MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" 2>&1 | tee "$work/archive.log"

# Read the actual archive, not just the build settings passed above.
python3 - "$archive/Products/Applications/Infinitary.app/Info.plist" "$VERSION" "$BUILD_NUMBER" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as source:
    info = plistlib.load(source)
expected = {
    'CFBundleDisplayName': 'Infinitary',
    'CFBundleIdentifier': 'com.getinfinitary.infinitary',
    'CFBundleShortVersionString': sys.argv[2],
    'CFBundleVersion': sys.argv[3],
    'DTPlatformName': 'iphoneos',
}
for name, value in expected.items():
    if info.get(name) != value:
        raise SystemExit('Archive identity mismatch: ' + name)
if not info.get('CFBundleIcons', {}).get('CFBundlePrimaryIcon', {}).get('CFBundleIconName'):
    raise SystemExit('Archive has no compiled phone icon')
ipad_orientations = {
    'UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown',
    'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight',
}
if set(info.get('UISupportedInterfaceOrientations~ipad', [])) != ipad_orientations:
    raise SystemExit('Archive must support all four iPad orientations')
if info.get('ITSAppUsesNonExemptEncryption') is not False:
    raise SystemExit('Archive is missing its authentication/TLS encryption declaration')
print('Archived Infinitary with the requested version, build and phone icon.')
PY

xcodebuild -exportArchive -archivePath "$archive" -exportPath "$export_path" \
  -exportOptionsPlist ios/ExportOptions.plist -allowProvisioningUpdates \
  -authenticationKeyPath "$key_path" -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID" \
  -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID" 2>&1 | tee "$work/export.log"

shopt -s nullglob
ipas=("$export_path"/*.ipa)
if [[ ${#ipas[@]} -ne 1 ]]; then
  echo 'Export must produce exactly one IPA; nothing was uploaded.' >&2
  exit 1
fi
node scripts/phone-release.ts receipt attempted
# Key IDs identify the credential; the private key itself is never a command argument.
# An explicit file bypasses altool's earlier cwd/HOME key search locations.
if ! xcrun altool --upload-app --p8-file-path "$key_path" \
  --type ios --file "${ipas[0]}" --apiKey "$APP_STORE_CONNECT_KEY_ID" \
  --apiIssuer "$APP_STORE_CONNECT_ISSUER_ID"; then
  echo 'Upload outcome is not confirmed. Check this version and build in Apple before another upload; do not retry automatically.' >&2
  exit 1
fi
node scripts/phone-release.ts receipt accepted
printf 'Apple accepted Infinitary %s (%s) for processing. Internal TestFlight availability is checked separately.\n' "$VERSION" "$BUILD_NUMBER"

# Keep this inside the release command, after confirmed upload.
# A listing failure must not turn an accepted upload into a reason to upload again.
if ! node scripts/phone-certificates.ts "$work/archive.log" "$work/export.log"; then
  echo "Certificate listing failed; upload remains accepted. No certificates were revoked." >&2
fi
