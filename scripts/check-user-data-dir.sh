#!/bin/bash
# check-user-data-dir.sh - prove which userData folder a packaged app really
# opens (src/shared/userDataFolders.ts): the release opens
# <appData>/infinitary, the local dev bundle opens
# <appData>/infinitary-dev. A fused build cannot be inspected from
# outside, so the app is booted with its macOS home pinned to a throwaway
# directory and the gate reads what it created there.
#
# usage: check-user-data-dir.sh <app> <expected-folder>
#
# CFFIXED_USER_HOME is what Electron's appData follows on macOS (HOME alone
# does not move it), so the run never reaches this account's real
# ~/Library/Application Support - nor loses to the single-instance lock of a
# copy already running there, since that lock lives inside userData.
set -euo pipefail

APP_DIR="${1:-}"
EXPECTED_FOLDER="${2:-}"

fail() {
  echo "check-user-data-dir: FAIL: $1" >&2
  exit 1
}

[[ -d "$APP_DIR" ]] || fail "no app at $APP_DIR"
[[ -n "$EXPECTED_FOLDER" ]] || fail "usage: check-user-data-dir.sh <app> <expected-folder>"

EXECUTABLE="$APP_DIR/Contents/MacOS/$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP_DIR/Contents/Info.plist")"
FAKE_HOME="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/infinitary-user-data-check.XXXXXX")" && pwd -P)"
APP_SUPPORT="$FAKE_HOME/Library/Application Support"

HOME="$FAKE_HOME" CFFIXED_USER_HOME="$FAKE_HOME" "$EXECUTABLE" &
APP_PID=$!
cleanup() {
  kill "$APP_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$APP_PID" 2>/dev/null || break
    sleep 1
  done
  kill -9 "$APP_PID" 2>/dev/null || true
  rm -rf "$FAKE_HOME"
}
trap cleanup EXIT

# The core opens its database at <userData>/firstmate.db early in boot.
for _ in $(seq 1 60); do
  [[ -f "$APP_SUPPORT/$EXPECTED_FOLDER/firstmate.db" ]] && break
  kill -0 "$APP_PID" 2>/dev/null || fail "app exited before it opened a database"
  sleep 1
done

OPENED=()
while IFS= read -r -d '' db; do
  OPENED+=("$(basename "$(dirname "$db")")")
done < <(find "$APP_SUPPORT" -mindepth 2 -maxdepth 2 -name firstmate.db -print0 2>/dev/null)

[[ "${#OPENED[@]}" -gt 0 ]] || fail "no firstmate.db under $APP_SUPPORT within 60 seconds"
[[ "${#OPENED[@]}" -eq 1 && "${OPENED[0]}" == "$EXPECTED_FOLDER" ]] \
  || fail "opened userData folder(s) '${OPENED[*]}', expected only '$EXPECTED_FOLDER'"

echo "check-user-data-dir: OK ($(basename "$APP_DIR") opens <appData>/$EXPECTED_FOLDER)"
