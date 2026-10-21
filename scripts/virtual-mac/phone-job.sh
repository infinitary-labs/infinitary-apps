#!/bin/bash
# phone-job.sh - runs inside the phone check's virtual Mac from phone.sh.
#   prepare <in folder>: unpack the committed version phone.sh shared there
#     and install its packages.
#   gate <out folder> <device>...: run scripts/test-phone.ts for the device,
#     or with --both for one build run on both at once when it names two
#     (INF-662), copy each one's results to <out folder>/<device>, and fail
#     when any device failed.
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

# both <out folder>: one gate that builds once and runs the iPhone and the iPad
# at once; it marks each device's lines itself and writes <device> folders.
both() {
  local out="$1" code
  echo "== iphone and ipad began ($(stamp))"
  # INF-662 piece 2: the clone has 6 cores and 16 GB, room for two simulators at a time.
  node scripts/test-phone.ts --both --simulators 2 --evidence "$RESULTS/both"
  code="$?"
  mkdir -p "$out"
  cp -R "$RESULTS/both/." "$out/" 2> /dev/null || true
  echo "== iphone and ipad ended: exit $code ($(stamp))"
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
    case "$*" in
      iphone | ipad) device "$out" "$1" ;;
      "iphone ipad") both "$out" ;;
      *) exit 2 ;;
    esac
    ;;
  *)
    echo "usage: phone-job.sh prepare <in folder> | gate <out folder> <iphone|ipad>..." >&2
    exit 2
    ;;
esac
