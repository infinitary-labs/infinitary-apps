#!/bin/bash
# verify-app.sh - release gate: verify structure, signatures, identity,
# hardening, entitlements, and (optionally) Gatekeeper acceptance of
# "Infinitary.app" (a failed gate is the gate working).
#
# Modes:
#   verify-app.sh <app>                 structural + ad-hoc-safe checks
#   verify-app.sh <app> --signed        additionally require Developer ID
#                                       identity, hardened runtime, Team ID,
#                                       and the entitlement allowlist
#   verify-app.sh <app> --signed --gatekeeper
#                                       additionally require a stapled
#                                       notarization ticket and spctl acceptance
#
# Every failed check stops the release. There is no warn-only path.
set -euo pipefail

APP_DIR="${1:-}"
MODE_SIGNED=0
MODE_GATEKEEPER=0
for arg in "${@:2}"; do
  case "$arg" in
    --signed) MODE_SIGNED=1 ;;
    --gatekeeper) MODE_GATEKEEPER=1 ;;
    *) echo "verify-app: FAIL: unknown argument $arg" >&2; exit 1 ;;
  esac
done
if [[ "$MODE_GATEKEEPER" -eq 1 ]]; then
  MODE_SIGNED=1
fi

RELEASE_IDENTITY="$(dirname "$0")/../packaging/release-identity.json"
EXPECTED_BUNDLE_ID="$(plutil -extract bundleId raw -o - "$RELEASE_IDENTITY")"
EXPECTED_TEAM_ID="$(plutil -extract teamId raw -o - "$RELEASE_IDENTITY")"
EXPECTED_EXECUTABLE="Infinitary"
# The file every start with no window runs from (scripts/mac-app-launcher.m;
# docs/run.md, "Opened while it runs"), signed under the app's own identity.
BACKGROUND_EXECUTABLE="$EXPECTED_EXECUTABLE Background"
# The only entitlements any executable may carry (docs/architecture.md
# section 10): JIT for V8 and microphone for hold-to-talk.
ALLOWED_ENTITLEMENTS="com.apple.security.cs.allow-jit com.apple.security.device.audio-input"

fail() {
  echo "verify-app: FAIL: $1" >&2
  exit 1
}

[[ -n "$APP_DIR" ]] || fail "usage: verify-app.sh <app> [--signed] [--gatekeeper]"
[[ -d "$APP_DIR" ]] || fail "no app at $APP_DIR"
APP_DIR="${APP_DIR%/}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

plist_get() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$APP_DIR/Contents/Info.plist" 2>/dev/null || true
}

# ---- Structure ----
[[ "$(plist_get CFBundleIdentifier)" == "$EXPECTED_BUNDLE_ID" ]] \
  || fail "CFBundleIdentifier is '$(plist_get CFBundleIdentifier)', expected $EXPECTED_BUNDLE_ID"
[[ "$(plist_get CFBundleExecutable)" == "$EXPECTED_EXECUTABLE" ]] \
  || fail "CFBundleExecutable mismatch"
[[ "$(plist_get CFBundlePackageType)" == "APPL" ]] \
  || fail "CFBundlePackageType is not APPL"
[[ -x "$APP_DIR/Contents/MacOS/$EXPECTED_EXECUTABLE" ]] \
  || fail "main executable missing or not executable"
[[ -x "$APP_DIR/Contents/MacOS/$BACKGROUND_EXECUTABLE" ]] \
  || fail "the background file (Contents/MacOS/$BACKGROUND_EXECUTABLE) is missing or not executable"
[[ -f "$APP_DIR/Contents/Resources/app.asar" ]] \
  || fail "app.asar missing from bundle"
# F14: the app ships no Claude client - a Claude account runs the machine's
# own Claude Code. The SDK's platform binaries are excluded from the package
# (electron-builder.yml `files`); a copy under the unpacked tree would mean
# that exclusion regressed, and about 600 MB with it.
[[ ! -e "$APP_DIR/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai" ]] \
  || fail "a Claude client is bundled under app.asar.unpacked/node_modules/@anthropic-ai (F14: the machine's own install serves it)"
# The app's own git helper (docs/forge.md): git runs it by path, so it must
# be on disk outside the archive and executable.
[[ -x "$APP_DIR/Contents/Resources/git-askpass" ]] \
  || fail "the git helper (Contents/Resources/git-askpass) is missing or not executable"
# The app's own git (docs/forge.md): scripts/check-bundled-git.sh, the one
# check the package smoke (verify.yml) runs on the dev bundle too.
BUNDLED_GIT_VERSION="$("$SCRIPT_DIR/check-bundled-git.sh" "$APP_DIR")" || exit 1

# ---- Architecture: universal (D-1) ----
# Every Mach-O must carry both arm64 and x86_64, except the files the
# universal merge was told to take as-is: electron-builder.yml's
# mac.x64ArchFiles, the one list, matched by scripts/x64-arch-files.mjs
# exactly as @electron/universal matches it. The whole tree is read before
# anything is judged, so a failure is one line and never a broken pipe.
MACH_O_COUNT=0
SINGLE_ARCH=()
while IFS= read -r -d '' f; do
  DESCRIPTION="$(file -b "$f")"
  [[ "$DESCRIPTION" == *Mach-O* ]] || continue
  MACH_O_COUNT=$((MACH_O_COUNT + 1))
  if [[ "$DESCRIPTION" != *arm64* || "$DESCRIPTION" != *x86_64* ]]; then
    SINGLE_ARCH+=("${f#"$APP_DIR"/}")
  fi
done < <(find "$APP_DIR" -type f -print0)
[[ "$MACH_O_COUNT" -ge 2 ]] \
  || fail "expected at least 2 Mach-O files, found $MACH_O_COUNT"
if [[ "${#SINGLE_ARCH[@]}" -gt 0 ]]; then
  UNCOVERED="$(node "$SCRIPT_DIR/x64-arch-files.mjs" uncovered "${SINGLE_ARCH[@]}")" \
    || fail "could not read mac.x64ArchFiles from electron-builder.yml"
  if [[ -n "$UNCOVERED" ]]; then
    while IFS= read -r rel; do
      echo "verify-app: single-arch Mach-O outside mac.x64ArchFiles: $APP_DIR/$rel ($(file -b "$APP_DIR/$rel"))" >&2
    done <<< "$UNCOVERED"
    fail "Mach-O missing an arm64 or x86_64 slice outside mac.x64ArchFiles (electron-builder.yml)"
  fi
fi

# ---- Version fields must agree ----
SHORT_VERSION="$(plist_get CFBundleShortVersionString)"
[[ -n "$SHORT_VERSION" ]] || fail "CFBundleShortVersionString missing"

echo "verify-app: structure OK ($MACH_O_COUNT Mach-O files, ${#SINGLE_ARCH[@]} single-arch under mac.x64ArchFiles, version $SHORT_VERSION, $BUNDLED_GIT_VERSION)"

if [[ "$MODE_SIGNED" -eq 0 ]]; then
  exit 0
fi

# ---- Signature validity (all nested code + outer seal) ----
codesign --verify --deep --strict --verbose=2 "$APP_DIR" 2>&1 \
  || fail "codesign --verify --deep --strict failed"

# ---- Identity, Team ID, hardened runtime on the app and helpers ----
check_signature() {
  local target="$1"
  local INFO
  INFO="$(codesign -dvvv "$target" 2>&1)" \
    || fail "codesign -dvvv failed on $target"
  echo "$INFO" | grep -q "^Authority=Developer ID Application: Kun Chen ($EXPECTED_TEAM_ID)$" \
    || fail "$target not signed by the expected Developer ID identity"
  echo "$INFO" | grep -q "^TeamIdentifier=$EXPECTED_TEAM_ID$" \
    || fail "$target has wrong Team ID"
  echo "$INFO" | grep -q "flags=0x10000(runtime)" \
    || fail "$target missing hardened runtime"
  echo "$INFO" | grep -q "^Timestamp=" \
    || fail "$target missing secure timestamp"
}
check_signature "$APP_DIR"
check_signature "$APP_DIR/Contents/MacOS/$EXPECTED_EXECUTABLE"
check_signature "$APP_DIR/Contents/MacOS/$BACKGROUND_EXECUTABLE"
while IFS= read -r -d '' helper; do
  check_signature "$helper"
done < <(find "$APP_DIR/Contents/Frameworks" -maxdepth 1 -name "*.app" -print0)

# ---- Entitlement allowlist on every signed executable ----
check_entitlements() {
  local target="$1"
  local XML KEYS
  XML="$(mktemp)"
  codesign -d --entitlements :- --xml "$target" > "$XML" 2>/dev/null || true
  if [[ -s "$XML" ]]; then
    KEYS="$(plutil -convert json -o - "$XML" | python3 -c "import json,sys; print(' '.join(sorted(json.load(sys.stdin).keys())))")"
    for key in $KEYS; do
      echo " $ALLOWED_ENTITLEMENTS " | grep -q " $key " \
        || fail "$target carries entitlement outside the allowlist: $key"
    done
  fi
  rm -f "$XML"
}
check_entitlements "$APP_DIR/Contents/MacOS/$EXPECTED_EXECUTABLE"
check_entitlements "$APP_DIR/Contents/MacOS/$BACKGROUND_EXECUTABLE"
while IFS= read -r -d '' helper_bin; do
  check_entitlements "$helper_bin"
done < <(find "$APP_DIR/Contents/Frameworks" -path "*/MacOS/*" -type f -print0)

# ---- Outer bundle identity ----
APP_INFO="$(codesign -dvvv "$APP_DIR" 2>&1)"
echo "$APP_INFO" | grep -q "^Identifier=$EXPECTED_BUNDLE_ID$" \
  || fail "app signing identifier is not $EXPECTED_BUNDLE_ID"

# ---- The background file signs as the app (docs/run.md, "Opened while it runs") ----
# The same identifier and designated requirement as the app's, so the
# Keychain and macOS's permissions take a run from it for the app itself.
designated() {
  codesign -d -r- "$1" 2>/dev/null | sed -n 's/^designated => //p'
}
BACKGROUND_INFO="$(codesign -dvvv "$APP_DIR/Contents/MacOS/$BACKGROUND_EXECUTABLE" 2>&1)"
echo "$BACKGROUND_INFO" | grep -q "^Identifier=$EXPECTED_BUNDLE_ID$" \
  || fail "the background file's signing identifier is not $EXPECTED_BUNDLE_ID"
APP_REQUIREMENT="$(designated "$APP_DIR")"
[[ -n "$APP_REQUIREMENT" && "$(designated "$APP_DIR/Contents/MacOS/$BACKGROUND_EXECUTABLE")" == "$APP_REQUIREMENT" ]] \
  || fail "the background file's designated requirement is not the app's"

echo "verify-app: signatures OK (Developer ID, hardened runtime, secure timestamps, entitlement allowlist)"

if [[ "$MODE_GATEKEEPER" -eq 0 ]]; then
  exit 0
fi

# ---- Notarization + Gatekeeper (final-artifact gate) ----
xcrun stapler validate "$APP_DIR" >/dev/null \
  || fail "no stapled notarization ticket"
SPCTL_OUT="$(spctl --assess --type execute --verbose=4 "$APP_DIR" 2>&1)" \
  || fail "Gatekeeper assessment failed: $SPCTL_OUT"
echo "$SPCTL_OUT" | grep -q "source=Notarized Developer ID" \
  || fail "Gatekeeper source is not 'Notarized Developer ID'"

echo "verify-app: Gatekeeper OK (notarized, stapled, accepted)"
