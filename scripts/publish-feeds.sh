#!/bin/bash
# Advances all public channels atomically after the finalized downloads pass their gates.
# live pushes only the configured feed branch; rehearsal writes a local plan, never a remote.
set -euo pipefail
MODE="${1:-}"
[[ "$MODE" == live || "$MODE" == rehearsal ]] || { echo 'usage: publish-feeds.sh live|rehearsal' >&2; exit 1; }
: "${WORK:?}" "${VERSION:?}" "${CHANNEL:?}" "${SOURCE_COMMIT:?}" "${DIST_ZIP:?}" "${DIST_DMG:?}" "${LINUX_MANIFEST:?}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPTS")"
REPOSITORY="$(node -p 'require(process.argv[1]).repository' "$ROOT/packaging/release-source.json")"
BRANCH="$(node -p 'require(process.argv[1]).feedBranch' "$ROOT/packaging/release-source.json")"
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$BRANCH" =~ ^[A-Za-z0-9_-]+$ ]] || exit 1
mkdir -p "$WORK"
# The helper receives the credential through its environment, never the command line.
feed_git() {
  if [[ -n "${GH_TOKEN:-}" ]]; then
    git -c credential.helper= -c 'credential.helper=!f() { printf "%s\n" "username=x-access-token" "password=$GH_TOKEN"; }; f' "$@"
  else
    git "$@"
  fi
}
DIRECTORY="$WORK/feeds"
git init -q "$DIRECTORY"
git -C "$DIRECTORY" remote add origin "https://github.com/$REPOSITORY.git"
read_branch() {
  local result
  if feed_git -C "$DIRECTORY" ls-remote --exit-code --heads origin "$BRANCH" > "$WORK/ref"; then
    feed_git -C "$DIRECTORY" fetch -q origin "$BRANCH"
    git -C "$DIRECTORY" checkout -q -B "$BRANCH" FETCH_HEAD
  else
    result=$?
    [[ "$result" == 2 ]] || return "$result"
    git -C "$DIRECTORY" checkout -q --orphan "$BRANCH"
  fi
}
read_branch
# A concurrent publication is not overwritten. Re-run from the new remote state on refusal.
node "$SCRIPTS/release-feeds.ts" --directory "$DIRECTORY" --version "$VERSION" --channel "$CHANNEL" \
  --source-commit "$SOURCE_COMMIT" --zip "$DIST_ZIP" --dmg "$DIST_DMG" --linux "$LINUX_MANIFEST" > "$WORK/summary.json"
cat "$WORK/summary.json"
[[ "$MODE" == live ]] || exit 0
git -C "$DIRECTORY" add --all
[[ -n "$(git -C "$DIRECTORY" status --porcelain)" ]] || exit 0
git -C "$DIRECTORY" -c user.name='Infinitary releases' -c user.email='releases@users.noreply.github.com' \
  commit -q -m "chore(releases): publish $VERSION downloads"
feed_git -C "$DIRECTORY" push origin "HEAD:refs/heads/$BRANCH"
