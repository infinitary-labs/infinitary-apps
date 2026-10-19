#!/bin/bash
# phone-job.sh - runs inside the phone check's virtual Mac from phone.sh.
#   prepare <in folder>: unpack the committed version phone.sh shared there
#     and install its packages.
#   gate <out folder> <device>...: run scripts/test-phone.ts for each device,
#     both at once when it names two, copy each one's results to
#     <out folder>/<device>, and fail when any device failed.
set -uo pipefail
export PATH="$HOME/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" CI=true
WORKING_COPY="$HOME/job/Application Support/infinitary"
# Results are written inside the virtual Mac, then copied out whole.
RESULTS="$HOME/phone-results"
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# device <out folder> <iphone|ipad>: one device gate, its lines marked with
# its name.
device() {
  local out="$1" name="$2" args code
  args=(--evidence "$RESULTS/$name")
  if [ "$name" = ipad ]; then args=(--ipad "${args[@]}"); fi
  echo "== $name began ($(stamp))"
  node scripts/test-phone.ts "${args[@]}" 2>&1 | while IFS= read -r line; do
    printf '%s: %s\n' "$name" "$line"
  done
  code="${PIPESTATUS[0]}"
  mkdir -p "$out/$name"
  cp -R "$RESULTS/$name/." "$out/$name/" 2> /dev/null || true
  echo "== $name ended: exit $code ($(stamp))"
  return "$code"
}

case "${1:-}" in
  prepare)
    [ "$#" -eq 2 ] || exit 2
    mkdir -p "$WORKING_COPY"
    cd "$WORKING_COPY" || exit 1
    tar -xf "$2/source.tar" || exit 1
    pnpm install --frozen-lockfile
    ;;
  gate)
    [ "$#" -gt 2 ] || exit 2
    out="$2"
    shift 2
    cd "$WORKING_COPY" || exit 1
    pids=()
    for name in "$@"; do
      device "$out" "$name" &
      pids+=("$!")
    done
    status=0
    for pid in "${pids[@]}"; do
      wait "$pid" || status="$?"
    done
    exit "$status"
    ;;
  *)
    echo "usage: phone-job.sh prepare <in folder> | gate <out folder> <iphone|ipad>..." >&2
    exit 2
    ;;
esac
