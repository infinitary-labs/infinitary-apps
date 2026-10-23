#!/bin/bash
# phone.sh - the phone check's device gates in a fresh virtual Mac cloned
# from the lane's image (image.sh), with no Mac check lease: phone.yml runs
# it when the repository variable PHONE_VIRTUAL_MAC is set (docs/ios.md,
# "The phone check in a virtual Mac"). Its clone has one fixed name, so one
# phone check runs at a time (phone.yml's mac-mini-phone queue, which this
# variable keeps): phone checks wait only for each other, never for journeys (the captain's INF-517 answer on INF-79's rule).
#
# usage: scripts/virtual-mac/phone.sh start <results folder>
#        scripts/virtual-mac/phone.sh gate <iphone|ipad>...
#        scripts/virtual-mac/phone.sh delete
#
# start deletes a clone an earlier check left, clones IMAGE (default
# infinitary-lane) as PHONE_VM (default <IMAGE>-phone), starts it with the
# working copy's committed version and installs its packages. gate runs
# scripts/test-phone.ts in the clone for the device it names, or for both at
# once from one build when it names two, and copies each device's results into
# <results folder>/<device>, where the Mac mini's gates write them; it exits
# with the gate's own exit code. delete stops and deletes the clone.
set -euo pipefail

IMAGE="${IMAGE:-infinitary-lane}"
NAME="${PHONE_VM:-$IMAGE-phone}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The clone's shared input folder outlives each step: the clone runs from
# start to delete.
WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/$NAME"
# shellcheck source=scripts/virtual-mac/vm.sh
source "$ROOT/scripts/virtual-mac/vm.sh"

usage() {
  echo "usage: scripts/virtual-mac/phone.sh start <results folder> | gate <iphone|ipad>... | delete" >&2
  exit 2
}
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Stops and deletes the clone; fails when it is still there afterwards.
delete_clone() {
  stop_vm "$NAME"
  "$TART" delete "$NAME" > /dev/null 2>&1 || true
  rm -rf "$WORK"
  if "$TART" list --source local --quiet | grep -xF "$NAME" > /dev/null; then
    echo "The virtual Mac $NAME could not be deleted." >&2
    return 1
  fi
}

case "${1:-}" in
  start)
    [ "$#" -eq 2 ] || usage
    mkdir -p "$2"
    OUT="$(cd "$2" && pwd)"
    delete_clone
    mkdir -p "$WORK/in"
    cp "$ROOT/scripts/virtual-mac/phone-job.sh" "$WORK/in/phone-job.sh"
    # The committed version only, as a file tree: a pull request's checkout
    # is shallow, and a bundle of it cannot be fetched into an empty clone.
    git -C "$ROOT" archive --format=tar -o "$WORK/in/source.tar" HEAD
    echo "== Starting $NAME, a fresh clone of $IMAGE, at $(git -C "$ROOT" rev-parse --short HEAD) ($(stamp))"
    "$TART" clone "$IMAGE" "$NAME"
    start_vm "$NAME" "$WORK/tart-run.log" "$SHARED/in/phone-job.sh" "--dir=in:$WORK/in:ro" "--dir=out:$OUT"
    echo "== The virtual Mac started ($(stamp))"
    "$TART" exec "$NAME" /bin/bash -lc "/bin/bash '$SHARED/in/phone-job.sh' prepare '$SHARED/in'"
    ;;
  gate)
    shift
    [ "$#" -gt 0 ] || usage
    for device in "$@"; do
      case "$device" in
        iphone | ipad) ;;
        *) usage ;;
      esac
    done
    "$TART" exec "$NAME" /bin/bash -lc "/bin/bash '$SHARED/in/phone-job.sh' gate '$SHARED/out' $*"
    ;;
  delete)
    [ "$#" -eq 1 ] || usage
    delete_clone
    echo "== Deleted $NAME ($(stamp))"
    ;;
  *) usage ;;
esac
