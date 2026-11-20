#!/bin/bash
# check-app-launch.sh - signature structure is not launchability: prove the
# app actually boots and stays alive, and that it is the release's version,
# before it ships.
#
# usage: check-app-launch.sh <app> <version>
#
# <version> is the release's logical version: stable X.Y.Z, or alpha
# X.Y.Z-alpha.N (docs/alpha.md "The signed channel workflow"). Both bundle
# version fields, CFBundleShortVersionString and CFBundleVersion, carry only
# its numeric core X.Y.Z - nothing relies on macOS accepting a prerelease
# suffix there - while the packaged package.json carries the whole logical
# version, which is what the running app reports (Electron's
# app.getVersion()). The gate proves the two separately: the fields from the
# bundle, the logical version by asking the running app
# (scripts/app-runtime-version.mjs).
set -euo pipefail

APP_DIR="${1:-}"
EXPECTED_VERSION="${2:-}"
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  echo "check-app-launch: FAIL: $1" >&2
  exit 1
}

[[ -d "$APP_DIR" ]] || fail "no app at $APP_DIR"
[[ -n "$EXPECTED_VERSION" ]] || fail "usage: check-app-launch.sh <app> <version>"
[[ "$EXPECTED_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-alpha\.(0|[1-9][0-9]*))?$ ]] \
  || fail "version $EXPECTED_VERSION is neither X.Y.Z nor X.Y.Z-alpha.N"
NUMERIC_CORE="${EXPECTED_VERSION%%-*}"

for FIELD in CFBundleShortVersionString CFBundleVersion; do
  VALUE="$(/usr/libexec/PlistBuddy -c "Print :$FIELD" "$APP_DIR/Contents/Info.plist")"
  [[ "$VALUE" == "$NUMERIC_CORE" ]] \
    || fail "$FIELD is $VALUE, not $NUMERIC_CORE (the numeric core of release $EXPECTED_VERSION)"
done

EXECUTABLE="$APP_DIR/Contents/MacOS/$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP_DIR/Contents/Info.plist")"
# A first launch into a throwaway profile. The release runner is a Mac a
# person uses, so the gate must never boot into that account's real
# Infinitary data (leaving launch markers and queued events behind), nor
# lose to the single-instance lock of a copy already running there.
# Chromium's --user-data-dir is the packaged app's userData; the debugging
# port (any free one, named in the profile) is how the version is asked.
# The app starts in a process group of its own (job control on for its
# start alone), so its Chromium helpers and the children its core spawns can
# be found and stopped with it.
LAUNCH_PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/infinitary-launch-check.XXXXXX")"
# A fresh profile has not checked for updates today, so its first check would
# carry the active mark and count this gate as a computer using Infinitary
# (docs/sharing.md, "The update check's active mark"): mark today already.
printf '{"schemaVersion":1,"day":"%s","month":"%s"}' \
  "$(TZ=America/Los_Angeles date +%Y-%m-%d)" "$(TZ=America/Los_Angeles date +%Y-%m)" \
  >"$LAUNCH_PROFILE/active-mark.json"
set -m
"$EXECUTABLE" --user-data-dir="$LAUNCH_PROFILE" --remote-debugging-port=0 &
APP_PID=$!
set +m

# Whether a process is still running: a child of this script that has
# exited stays a zombie until it is reaped, and a zombie writes nothing.
running() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null)" && [[ "$state" != Z* ]]
}

# Every process still running that can write into the profile: the app's
# group, and any process that names the profile in its arguments, as each
# helper does, whatever group it is in.
profile_writers() {
  ps -axo pid=,pgid=,stat=,command= \
    | GROUP="$APP_PID" PROFILE="$LAUNCH_PROFILE" \
      awk '$3 !~ /^Z/ && ($2 == ENVIRON["GROUP"] || index($0, ENVIRON["PROFILE"])) { print $1 }'
}

# INF-1768: removing the profile while anything still writes into it fails
# with "Directory not empty" after the gate has passed, and leaves the app's
# processes running on the runner. So the app is asked to quit and given
# its own lifecycle's time, whatever is left is stopped outright and reaped,
# and the profile is removed only once nothing can write into it.
cleanup() {
  kill "$APP_PID" 2>/dev/null || true
  for _ in $(seq 1 100); do
    running "$APP_PID" || break
    sleep 0.1
  done
  local writers
  for _ in $(seq 1 50); do
    writers="$(profile_writers)"
    [[ -n "$writers" ]] || break
    # shellcheck disable=SC2086 # one process id per word
    kill -9 $writers 2>/dev/null || true
    sleep 0.1
  done
  wait "$APP_PID" 2>/dev/null || true
  writers="$(profile_writers)"
  [[ -z "$writers" ]] \
    || fail "process(es) ${writers//$'\n'/ } still run with the launch profile $LAUNCH_PROFILE after SIGKILL, so the profile is left in place"
  rm -rf "$LAUNCH_PROFILE"
}
trap cleanup EXIT

sleep 8
kill -0 "$APP_PID" 2>/dev/null \
  || fail "app exited within 8 seconds of launch"

RUNTIME_VERSION="$(node "$SCRIPTS/app-runtime-version.mjs" "$LAUNCH_PROFILE")" \
  || fail "the running app did not report its version"
[[ "$RUNTIME_VERSION" == "$EXPECTED_VERSION" ]] \
  || fail "the running app reports $RUNTIME_VERSION, not $EXPECTED_VERSION"
kill -0 "$APP_PID" 2>/dev/null \
  || fail "app exited after it reported its version"

echo "check-app-launch: OK (bundle fields $NUMERIC_CORE; the running app reports $RUNTIME_VERSION; boots and stays alive)"
