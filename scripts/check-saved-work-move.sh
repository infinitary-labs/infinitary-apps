#!/bin/bash
# check-saved-work-move.sh - the saved work an installed Firstmate 3000 made
# reaches Infinitary on Infinitary's first launch, after an update replaced
# one app with the other (docs/saved-data-compatibility.md, "The one-time
# move"). The old-cask upgrade on a Mac (scripts/check-old-cask-upgrade.sh)
# and the Linux packages installed over Firstmate 3000's
# (scripts/check-linux-package.sh) run it on either side of their update, as
# the person and in the person's own home, which is a throwaway one there.
#
# usage: check-saved-work-move.sh make <Firstmate 3000's program> <its folder> <evidence dir>
#        check-saved-work-move.sh moved <Infinitary's program> <Firstmate 3000's folder> <Infinitary's folder> <evidence dir>
#
#   make   opens Firstmate 3000 once, so its own first launch makes its
#          folder and database, quits it, then adds a row to its settings and
#          a file to its folder, which stand for the person's work
#   moved  opens Infinitary once, as the person does after the update, waits
#          for its one-time move to finish and for it to start again on its
#          own folder, quits it, and checks the row and the file came over
#          unchanged, the database kept every migration Firstmate 3000 had
#          applied, and Firstmate 3000's folder is retired
#
# Neither app sends Diagnostics from a check (FM3000_TELEMETRY and
# INFINITARY_TELEMETRY). Each app is found by its program's path, so a quit
# also reaches the copy the hand-over starts again, which keeps the switches
# APP_SWITCHES names. Needs sqlite3.
set -euo pipefail

STEP="${1:-}"

fail() {
  echo "check-saved-work-move: FAIL: $1" >&2
  exit 1
}

# A process whose command line starts with the program, never this script,
# whose own command line only names it.
running() { pgrep -f "^$1" >/dev/null; }

open_app() {
  local switches=()
  read -r -a switches <<<"${APP_SWITCHES:-}"
  # macOS's Bash 3.2 calls an empty array unbound under set -u.
  FM3000_TELEMETRY=0 INFINITARY_TELEMETRY=0 "$1" ${switches[@]+"${switches[@]}"} >>"$2" 2>&1 &
  disown
}

quit_app() {
  pkill -TERM -f "^$1" || true
  for _ in $(seq 1 30); do
    running "$1" || return 0
    sleep 1
  done
  pkill -KILL -f "^$1" || true
  sleep 1
}

# wait_for <seconds> <program> <what> <command...>: the command succeeds
# while the program runs, or the check fails naming what never came.
wait_for() {
  local seconds="$1" program="$2" what="$3"
  shift 3
  for _ in $(seq 1 "$seconds"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  running "$program" || fail "$(basename "$program") exited before $what"
  fail "no $what within $seconds seconds"
}

# Only a database already there, so a read never makes one. Never
# -readonly: macOS's sqlite3 cannot open read-only a WAL database whose app
# closed it cleanly, which takes the -wal file away.
query() { [[ -f "$1" ]] && sqlite3 "$1" "$2"; }

case "$STEP" in
  make)
    PROGRAM="$(readlink -f "${2:-}")"
    OLDER="${3:-}"
    EVIDENCE="${4:-}"
    [[ -x "$PROGRAM" && -n "$OLDER" && -n "$EVIDENCE" ]] \
      || fail "usage: check-saved-work-move.sh make <Firstmate 3000's program> <its folder> <evidence dir>"
    # An installer's channel marker may be there already; a database never.
    [[ ! -e "$OLDER/firstmate.db" ]] || fail "$OLDER holds a database already: the check needs a person who never opened Firstmate 3000"
    mkdir -p "$EVIDENCE"
    open_app "$PROGRAM" "$EVIDENCE/firstmate-3000.log"
    wait_for 120 "$PROGRAM" "Firstmate 3000 database" \
      query "$OLDER/firstmate.db" "SELECT 1 FROM schema_migrations LIMIT 1"
    # Its first launch goes on past the database; let it settle before it quits.
    sleep 10
    running "$PROGRAM" || fail "Firstmate 3000 exited during its first launch"
    quit_app "$PROGRAM"

    TOKEN="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    sqlite3 "$OLDER/firstmate.db" "INSERT INTO settings (key, value) VALUES ('saved-work-check', '\"$TOKEN\"')"
    mkdir -p "$OLDER/saved-work-check"
    printf '%s\n' "$TOKEN" >"$OLDER/saved-work-check/note.txt"
    printf '%s\n' "$TOKEN" >"$EVIDENCE/saved-work-token.txt"
    query "$OLDER/firstmate.db" "SELECT version FROM schema_migrations ORDER BY version" \
      >"$EVIDENCE/firstmate-3000-migrations.txt"
    echo "check-saved-work-move: Firstmate 3000 made $OLDER, $(wc -l <"$EVIDENCE/firstmate-3000-migrations.txt" | tr -d ' ') migrations, and holds the work to move"
    ;;
  moved)
    PROGRAM="$(readlink -f "${2:-}")"
    OLDER="${3:-}"
    FOLDER="${4:-}"
    EVIDENCE="${5:-}"
    [[ -x "$PROGRAM" && -n "$OLDER" && -n "$FOLDER" && -f "${EVIDENCE:-}/saved-work-token.txt" ]] \
      || fail "usage: check-saved-work-move.sh moved <Infinitary's program> <Firstmate 3000's folder> <Infinitary's folder> <evidence dir>, after make"
    TOKEN="$(cat "$EVIDENCE/saved-work-token.txt")"
    open_app "$PROGRAM" "$EVIDENCE/infinitary.log"
    wait_for 300 "$PROGRAM" "finished move" grep -q '"state": "done"' "$FOLDER/folder-move.json"
    # The hand-over starts the app again on its own folder, whose profile
    # lock only that start makes.
    wait_for 120 "$PROGRAM" "start on Infinitary's own folder" test -L "$FOLDER/SingletonLock"
    sleep 10
    running "$PROGRAM" || fail "Infinitary exited after it started on the moved work"
    quit_app "$PROGRAM"
    cp "$FOLDER/folder-move.json" "$EVIDENCE/folder-move.json"

    grep -q "\"from\": \".*/$(basename "$OLDER")\"" "$FOLDER/folder-move.json" \
      || fail "the move did not come from $OLDER"
    [[ -f "$OLDER/retired-profile.json" ]] || fail "Firstmate 3000's folder is not retired"
    [[ "$(query "$FOLDER/firstmate.db" "SELECT value FROM settings WHERE key = 'saved-work-check'")" == "\"$TOKEN\"" ]] \
      || fail "the settings row Firstmate 3000 kept is not in Infinitary's database"
    [[ "$(cat "$FOLDER/saved-work-check/note.txt" 2>/dev/null)" == "$TOKEN" ]] \
      || fail "the file Firstmate 3000's folder held did not come over unchanged"
    query "$FOLDER/firstmate.db" "SELECT version FROM schema_migrations ORDER BY version" \
      >"$EVIDENCE/infinitary-migrations.txt"
    MISSING="$(comm -23 <(sort "$EVIDENCE/firstmate-3000-migrations.txt") <(sort "$EVIDENCE/infinitary-migrations.txt"))"
    [[ -z "$MISSING" ]] || fail "Infinitary's database lost migrations Firstmate 3000 applied: $MISSING"
    echo "check-saved-work-move: Infinitary moved $OLDER into $FOLDER, opened it, and kept the work: $(wc -l <"$EVIDENCE/firstmate-3000-migrations.txt" | tr -d ' ') migrations then, $(wc -l <"$EVIDENCE/infinitary-migrations.txt" | tr -d ' ') now"
    ;;
  *)
    fail "unknown step '$STEP' (make or moved)"
    ;;
esac
