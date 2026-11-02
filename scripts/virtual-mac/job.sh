#!/bin/bash
# job.sh - runs inside a fresh virtual Mac from run.sh: the steps of
# journeys.yml's affected-journeys job, on the bundled HEAD, with the
# Playwright arguments run.sh wrote to in/args.
set -uo pipefail
IN="/Volumes/My Shared Files/in"
OUT="/Volumes/My Shared Files/out"
export PATH="$HOME/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" CI=true
WORKING_COPY="$HOME/job/Application Support/infinitary"

# step <log name> <command...>: its output goes to out/<log name>.log; a
# failed step ends the job.
step() {
  local log="$1"
  shift
  echo "== $log ($(date -u +%H:%M:%SZ))"
  "$@" > "$OUT/$log.log" 2>&1 || {
    echo "$log failed; its log is $log.log"
    tail -40 "$OUT/$log.log"
    echo 1 > "$OUT/exit"
    exit 1
  }
}

mkdir -p "$WORKING_COPY"
cd "$WORKING_COPY" || exit 1
step checkout bash -c "git init -q && git fetch -q '$IN/repo.bundle' HEAD && git checkout -q --detach FETCH_HEAD"
step install pnpm install --frozen-lockfile
step ffmpeg pnpm exec playwright install ffmpeg
step build pnpm build

echo "== The journeys ($(date -u +%H:%M:%SZ))"
eval "set -- $(cat "$IN/args")"
pnpm exec playwright test --no-deps "$@" 2>&1 | tee "$OUT/test.log"
code="${PIPESTATUS[0]}"
cp -R test-results/runs "$OUT/runs" 2> /dev/null || true
echo "$code" > "$OUT/exit"
echo "== Done: exit $code ($(date -u +%H:%M:%SZ))"
exit "$code"
