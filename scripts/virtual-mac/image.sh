#!/bin/bash
# image.sh - build the one virtual Mac image every project's Mac jobs run in
# (docs/testing.md, "A virtual Mac as a runner"): a clone of Cirrus Labs'
# Xcode image with Node and pnpm, a warm pnpm store, the Claude Code this
# Mac's own journeys find, microphone access for the guest agent, and a check
# that every project's jobs find their tools and no signing identity
# (provision.sh does the inside). The placement service clones it for each
# job and brings its own GitHub runner, so the image holds none.
#
# usage: scripts/virtual-mac/image.sh [name]       (default: infinitary-lane)
#
# TART names tart (default: tart on PATH); tart keeps the image under its own
# TART_HOME (default ~/.tart). BASE_IMAGE, CPUS, MEMORY_MB and
# CLAUDE_CODE_VERSION override the defaults below. The image is rebuilt from
# the base every time, so a fix lands here and in no image by hand.
set -euo pipefail

NAME="${1:-infinitary-lane}"
BASE_IMAGE="${BASE_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-xcode:26.4}"
CPUS="${CPUS:-6}"
MEMORY_MB="${MEMORY_MB:-16384}"
NODE_MAJOR=24
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/virtual-mac/vm.sh
source "$ROOT/scripts/virtual-mac/vm.sh"

# The Claude Code the app finds first on this Mac: knownClaudeHomes
# (src/core/claude/claudeCli.ts) looks in these folders in this order before
# the search path. The image installs the same version where the app finds
# it first in the guest.
host_claude_version() {
  local dir
  for dir in "$HOME/.local/bin" "$HOME/.claude/local" /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$dir/claude" ]; then
      "$dir/claude" --version | awk '{ print $1 }'
      return
    fi
  done
  if command -v claude > /dev/null; then
    claude --version | awk '{ print $1 }'
  fi
}

CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-$(host_claude_version)}"
PNPM_VERSION="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$ROOT/package.json")"
for value in "$CLAUDE_CODE_VERSION" "$PNPM_VERSION"; do
  if ! [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Expected a version like 1.2.3, got '$value'. Set CLAUDE_CODE_VERSION when this Mac has no Claude Code." >&2
    exit 2
  fi
done
command -v "$TART" > /dev/null || {
  echo "tart is not installed (brew install cirruslabs/cli/tart), or set TART." >&2
  exit 2
}

# Built under another name and renamed only once provisioning passed, so a
# failed build never leaves a half-made image under the lane's name.
BUILDING="$NAME-building"
SHARE="$(mktemp -d "${TMPDIR:-/tmp}/virtual-mac-image.XXXXXX")"
cleanup() {
  stop_vm "$BUILDING"
  "$TART" delete "$BUILDING" > /dev/null 2>&1 || true
  rm -rf "$SHARE"
}
trap cleanup EXIT

cp "$ROOT/scripts/virtual-mac/provision.sh" "$SHARE/provision.sh"
# The working copy's own lockfile warms the image's pnpm store.
git -C "$ROOT" bundle create -q "$SHARE/repo.bundle" HEAD

echo "Building $NAME from $BASE_IMAGE: Node $NODE_MAJOR, pnpm $PNPM_VERSION, Claude Code $CLAUDE_CODE_VERSION"
"$TART" delete "$BUILDING" > /dev/null 2>&1 || true
"$TART" clone "$BASE_IMAGE" "$BUILDING"
"$TART" set "$BUILDING" --cpu "$CPUS" --memory "$MEMORY_MB"
start_vm "$BUILDING" "$SHARE/tart-run.log" "$SHARED/share/provision.sh" "--dir=share:$SHARE:ro"
"$TART" exec "$BUILDING" /bin/bash -lc \
  "NODE_MAJOR=$NODE_MAJOR PNPM_VERSION=$PNPM_VERSION CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION /bin/bash '$SHARED/share/provision.sh'"
stop_vm "$BUILDING"
"$TART" delete "$NAME" > /dev/null 2>&1 || true
"$TART" rename "$BUILDING" "$NAME"
echo "$NAME is ready."
