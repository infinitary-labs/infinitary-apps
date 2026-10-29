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
# TART_HOME (default ~/.tart). The base is Cirrus Labs' image of the Xcode
# scripts/phone-pin.json names, and provisioning refuses it unless it holds
# that Xcode and the pinned iOS simulator (INF-1645). BASE_IMAGE, CPUS, MEMORY_MB and
# CLAUDE_CODE_VERSION override the defaults below. IOS_RUNTIME_VERSION defaults
# to 26.1 (the simulator suite's pin). IOS_RUNTIME_DMG can name its Apple-supplied
# disk; otherwise runtime.sh locates a verified installed copy on this Mac.
# That disk is shared read-only, never copied into a host staging folder.
# The image is rebuilt from
# the base every time, so a fix lands here and in no image by hand.
set -euo pipefail

NAME="${1:-infinitary-lane}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pin() { python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$ROOT/scripts/phone-pin.json" "$1"; }
PIN_XCODE="$(pin xcode)"
PIN_IOS_BUILD="$(pin iosBuild)"
BASE_IMAGE="${BASE_IMAGE:-ghcr.io/cirruslabs/macos-tahoe-xcode:$PIN_XCODE}"
CPUS="${CPUS:-6}"
MEMORY_MB="${MEMORY_MB:-16384}"
NODE_MAJOR=24
IOS_RUNTIME_VERSION="${IOS_RUNTIME_VERSION:-26.1}"
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

IOS_RUNTIME_DMG="${IOS_RUNTIME_DMG:-$(/bin/bash "$ROOT/scripts/virtual-mac/runtime.sh" locate "$IOS_RUNTIME_VERSION")}"
[ -f "$IOS_RUNTIME_DMG" ] || { echo "The required Apple-supplied iOS runtime disk is missing." >&2; exit 2; }
RUNTIME_DIR="$(cd "$(dirname "$IOS_RUNTIME_DMG")" && pwd)"
RUNTIME_DISK="$SHARED/ios-runtime/$(basename "$IOS_RUNTIME_DMG")"
printf -v RUNTIME_ENV 'IOS_RUNTIME_VERSION=%q IOS_RUNTIME_DMG=%q PIN_XCODE=%q PIN_IOS_BUILD=%q' "$IOS_RUNTIME_VERSION" "$RUNTIME_DISK" "$PIN_XCODE" "$PIN_IOS_BUILD"

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
cp "$ROOT/scripts/virtual-mac/cache-node.sh" "$SHARE/cache-node.sh"
cp "$ROOT/scripts/virtual-mac/guest-services.sh" "$SHARE/guest-services.sh"
cp "$ROOT/scripts/virtual-mac/runtime.sh" "$SHARE/runtime.sh"
# The working copy's own lockfile warms the image's pnpm store.
git -C "$ROOT" bundle create -q "$SHARE/repo.bundle" HEAD

echo "Building $NAME from $BASE_IMAGE: Node $NODE_MAJOR, pnpm $PNPM_VERSION, Claude Code $CLAUDE_CODE_VERSION"
"$TART" delete "$BUILDING" > /dev/null 2>&1 || true
"$TART" clone "$BASE_IMAGE" "$BUILDING"
"$TART" set "$BUILDING" --cpu "$CPUS" --memory "$MEMORY_MB"
start_vm "$BUILDING" "$SHARE/tart-run.log" "$SHARED/share/provision.sh" "--dir=share:$SHARE:ro" "--dir=ios-runtime:$RUNTIME_DIR:ro"
"$TART" exec "$BUILDING" /bin/bash -lc \
  "NODE_MAJOR=$NODE_MAJOR PNPM_VERSION=$PNPM_VERSION CLAUDE_CODE_VERSION=$CLAUDE_CODE_VERSION $RUNTIME_ENV /bin/bash '$SHARED/share/provision.sh'"
shutdown_vm "$BUILDING"
# The runner starts through tart exec without a login shell. Verify that
# environment after a fresh boot, not the provisioner's exported PATH.
start_vm "$BUILDING" "$SHARE/tart-check.log" "$SHARED/share/provision.sh" "--dir=share:$SHARE:ro"
TOOL_CHECK='set -e; command -v python3; python3 -c "import tomllib"; bash -c '\''test "${BASH_VERSINFO[0]}" -ge 4'\''; brew help trust >/dev/null; openssl version; node --version; pnpm --version'
"$TART" exec "$BUILDING" /bin/bash "$SHARED/share/guest-services.sh" verify
"$TART" exec "$BUILDING" /bin/bash -c "$TOOL_CHECK"
"$TART" exec "$BUILDING" /bin/zsh -ilc "$TOOL_CHECK"
"$TART" exec "$BUILDING" /bin/bash -lc "$TOOL_CHECK"
# Verify the cache survived reboot and is the same installation on the job's PATH.
"$TART" exec "$BUILDING" /bin/bash -c 'set -e; version="$("$HOME/node/bin/node" --version)"; cached="$HOME/tool-cache/node/${version#v}/arm64"; test -f "$cached.complete"; test "$("$cached/bin/node" --version)" = "$version"; test "$HOME/node/bin/node" -ef "$cached/bin/node"'
shutdown_vm "$BUILDING"
"$TART" delete "$NAME" > /dev/null 2>&1 || true
"$TART" rename "$BUILDING" "$NAME"
echo "$NAME is ready."
