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

# The app starts in a process group of its own (job control on for its
# start alone), so its Chromium helpers and the children its core spawns can
# be found and stopped with it.
set -m
HOME="$FAKE_HOME" CFFIXED_USER_HOME="$FAKE_HOME" "$EXECUTABLE" &
APP_PID=$!
set +m

# Whether a process is still running: a child of this script that has
# exited stays a zombie until it is reaped, and a zombie writes nothing.
running() {
  local state
  state="$(ps -o stat= -p "$1" 2>/dev/null)" && [[ "$state" != Z* ]]
}

# Every process still running that can write into the throwaway home: the
# app's group, and any process that names the home in its arguments, as each
# helper names userData, or in its environment, as every process the app
# started inherits its HOME, whatever group or session it is in. The match
# runs in this shell, where the home is no exported variable, so neither it
# nor ps names the home itself.
home_writers() {
  local pid group state rest
  while read -r pid group state rest; do
    if [[ "$state" != Z* && ("$group" == "$APP_PID" || "$rest" == *"$FAKE_HOME"*) ]]; then
      echo "$pid"
    fi
  done < <(ps -axwwEo pid=,pgid=,stat=,command=)
}

# INF-2110, as INF-1768 in check-app-launch.sh: removing the home while
# anything still writes into it fails with "Directory not empty" after the
# gate has passed. So the app is asked to quit and given its own lifecycle's
# time, whatever is left is stopped outright and reaped, and the home is
# removed only once nothing can write into it.
cleanup() {
  kill "$APP_PID" 2>/dev/null || true
  for _ in $(seq 1 100); do
    running "$APP_PID" || break
    sleep 0.1
  done
  local writers
  for _ in $(seq 1 50); do
    writers="$(home_writers)"
    [[ -n "$writers" ]] || break
    # shellcheck disable=SC2086 # one process id per word
    kill -9 $writers 2>/dev/null || true
    sleep 0.1
  done
  wait "$APP_PID" 2>/dev/null || true
  writers="$(home_writers)"
  [[ -z "$writers" ]] \
    || fail "process(es) ${writers//$'\n'/ } still run with the throwaway home $FAKE_HOME after SIGKILL, so the home is left in place"
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
