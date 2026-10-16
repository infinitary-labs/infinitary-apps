#!/bin/bash
# check-helper.sh - the app runs work for another Mac's first mate with no
# window (docs/helper.md): its own executable, started as `<app> work ...`,
# answers its version and says it has joined nothing, with an empty
# environment under a throwaway macOS home. It is started on the runner's
# own architecture, and on Intel through Rosetta when an Apple silicon
# runner has it; the summary names the architectures it started on. The
# first start of the Intel slice through Rosetta translates it, which takes
# a while once.
#
# Run by verify.yml's package smoke on the dev bundle and by release.yml on
# the signed app. CFFIXED_USER_HOME is what Electron's appData follows on
# macOS (HOME alone does not move it), so the run never reaches this
# account's real ~/Library/Application Support.
#
#   check-helper.sh <app>
set -euo pipefail

APP_DIR="${1:-}"
fail() {
  echo "check-helper: FAIL: $1" >&2
  exit 1
}
[[ -n "$APP_DIR" && -d "$APP_DIR" ]] || fail "usage: check-helper.sh <app>"
APP_DIR="${APP_DIR%/}"

EXECUTABLE="$APP_DIR/Contents/MacOS/$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP_DIR/Contents/Info.plist")"
[[ -x "$EXECUTABLE" ]] || fail "no executable at $EXECUTABLE"
case "$(uname -m)" in
  arm64) HOST_ARCH=arm64 ;;
  *) HOST_ARCH=x86_64 ;;
esac
FAKE_HOME="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/infinitary-work-check.XXXXXX")" && pwd -P)"
ERRORS="$FAKE_HOME/stderr.txt"
trap 'rm -rf "$FAKE_HOME"' EXIT

run() {
  env -i HOME="$FAKE_HOME" CFFIXED_USER_HOME="$FAKE_HOME" /usr/bin/arch "-$ARCH" "$EXECUTABLE" work "$@" 2>"$ERRORS"
}

VERSION=""
STARTED=()
for ARCH in arm64 x86_64; do
  if [[ "$ARCH" != "$HOST_ARCH" ]]; then
    # Only an Apple silicon runner with Rosetta starts the other slice.
    [[ "$HOST_ARCH" == arm64 ]] && /usr/bin/arch -x86_64 /usr/bin/true 2>/dev/null || continue
  fi
  ANSWER="$(run version)" \
    || fail "the app did not start to run work on $ARCH: $ANSWER $(tail -5 "$ERRORS")"
  [[ "$ANSWER" == "Infinitary "*" · contract "* ]] \
    || fail "the app answered '$ANSWER' on $ARCH, not its version"
  STATUS="$(run status)" \
    || fail "the app could not say what it runs work for on $ARCH: $STATUS $(tail -5 "$ERRORS")"
  [[ "$STATUS" == "This user has not joined Infinitary yet." ]] \
    || fail "the app said '$STATUS' on $ARCH with nothing joined"
  VERSION="$ANSWER"
  STARTED+=("$ARCH")
done
[[ -n "$VERSION" ]] || fail "the app was started to run work on no architecture"
echo "$VERSION, started with no window on ${STARTED[*]}"
