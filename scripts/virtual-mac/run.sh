#!/bin/bash
# run.sh - run journeys in a fresh virtual Mac cloned from the lane's image
# (image.sh), the way the Mac mini's journeys check runs them (journeys.yml),
# then delete the clone. The working copy's committed HEAD rides in; changes
# not yet committed do not.
#
# usage: scripts/virtual-mac/run.sh <playwright test arguments...>
#   e.g. scripts/virtual-mac/run.sh tests/e2e/mic-access.spec.ts
#
# IMAGE names the image (default infinitary-lane). The run's log, its
# test-results/runs/ and its exit code land in OUT (default
# test-results/virtual-mac/<UTC start>/ in this working copy). Exits with
# the journeys' own exit code.
set -euo pipefail

[ "$#" -gt 0 ] || {
  echo "usage: scripts/virtual-mac/run.sh <playwright test arguments...>" >&2
  exit 2
}
IMAGE="${IMAGE:-infinitary-lane}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT:-$ROOT/test-results/virtual-mac/$(date -u +%Y%m%dT%H%M%SZ)}"
# shellcheck source=scripts/virtual-mac/vm.sh
source "$ROOT/scripts/virtual-mac/vm.sh"

NAME="$IMAGE-run-$$"
IN="$(mktemp -d "${TMPDIR:-/tmp}/virtual-mac-run.XXXXXX")"
mkdir -p "$OUT"
cleanup() {
  stop_vm "$NAME"
  "$TART" delete "$NAME" > /dev/null 2>&1 || true
  rm -rf "$IN"
}
trap cleanup EXIT

cp "$ROOT/scripts/virtual-mac/job.sh" "$IN/job.sh"
git -C "$ROOT" bundle create -q "$IN/repo.bundle" HEAD
printf '%q ' "$@" > "$IN/args"

echo "Running in $NAME, a fresh clone of $IMAGE, at $(git -C "$ROOT" rev-parse --short HEAD): $*"
"$TART" clone "$IMAGE" "$NAME"
start_vm "$NAME" "$OUT/tart-run.log" "$SHARED/in/job.sh" "--dir=in:$IN:ro" "--dir=out:$OUT"
"$TART" exec "$NAME" /bin/bash -lc "/bin/bash '$SHARED/in/job.sh'" 2>&1 | tee "$OUT/job.log" || true
exit "$(cat "$OUT/exit" 2> /dev/null || echo 1)"
