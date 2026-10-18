#!/bin/bash
# provision.sh - runs once inside the virtual Mac as the image's user, from
# image.sh, which passes NODE_MAJOR, PNPM_VERSION and CLAUDE_CODE_VERSION.
# Each part checks itself, so a build that finishes has all of them.
set -euxo pipefail
: "${NODE_MAJOR:?}" "${PNPM_VERSION:?}" "${CLAUDE_CODE_VERSION:?}"
SHARE="/Volumes/My Shared Files/share"
WORK="$(mktemp -d)"

# Node and pnpm, as the Mac mini's checks set them up (actions/setup-node's
# latest $NODE_MAJOR, and package.json's packageManager).
NODE_DIST="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
curl -fsSL "$NODE_DIST/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
NODE_TAR="$(awk '/darwin-arm64\.tar\.xz$/ { print $2 }' "$WORK/SHASUMS256.txt")"
curl -fsSL "$NODE_DIST/$NODE_TAR" -o "$WORK/$NODE_TAR"
(cd "$WORK" && grep " $NODE_TAR\$" SHASUMS256.txt | shasum -a 256 -c -)
rm -rf "$HOME/node"
mkdir -p "$HOME/node"
tar -xJf "$WORK/$NODE_TAR" -C "$HOME/node" --strip-components 1
export PATH="$HOME/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" CI=true
npm install -g "pnpm@$PNPM_VERSION"
test "$(pnpm --version)" = "$PNPM_VERSION"

# Claude Code where the app looks first (docs/testing.md, "The Claude Code
# the app finds first"): knownClaudeHomes reads ~/.local/bin and
# ~/.claude/local before /opt/homebrew/bin, and the base image has none in
# the first two, so Homebrew's copy is the one the journeys run. Homebrew's
# npm installs into /opt/homebrew; Node's own npm would put it in ~/node/bin,
# which the app never reads.
/opt/homebrew/bin/npm install -g --force --prefix /opt/homebrew "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"
for dir in "$HOME/.local/bin" "$HOME/.claude/local" /opt/homebrew/bin; do
  if [ -x "$dir/claude" ]; then
    test "$("$dir/claude" --version | awk '{ print $1 }')" = "$CLAUDE_CODE_VERSION"
    break
  fi
done
test -x /opt/homebrew/bin/claude

# Microphone access for the guest agent (docs/testing.md, "The runner's
# microphone access"). coreaudiod asks macOS on behalf of the responsible
# process, the agent that runs every `tart exec`. Homebrew's build is only
# linker-signed, and a grant row's code requirement cannot match that, so
# the agent is signed ad hoc and granted by its cdhash. The running agent
# keeps its old signature until the image next starts.
AGENT="$(readlink -f /opt/homebrew/bin/tart-guest-agent)"
sudo -n codesign -f -s - "$AGENT"
codesign -v "$AGENT"
REQUIREMENT="$(codesign -d -r- "$AGENT" 2>&1 | sed -n 's/^# designated => //p')"
[[ "$REQUIREMENT" == cdhash* ]]
echo "$REQUIREMENT" | csreq -r- -b "$WORK/agent.req"
TCC_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
sqlite3 "$TCC_DB" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, flags, indirect_object_identifier) VALUES ('kTCCServiceMicrophone', '$AGENT', 1, 2, 3, 1, X'$(xxd -p "$WORK/agent.req" | tr -d '\n')', 0, 'UNUSED');"
test "$(sqlite3 "$TCC_DB" "SELECT auth_value FROM access WHERE service = 'kTCCServiceMicrophone' AND client = '$AGENT'")" = 2
killall -u "$(whoami)" tccd || true

# A warm pnpm store and Playwright's window recorder, from the working copy
# image.sh bundled, so each job's install only links.
WARM="$HOME/warm/Application Support/infinitary"
mkdir -p "$WARM"
git -C "$WARM" init -q
git -C "$WARM" fetch -q "$SHARE/repo.bundle" HEAD
git -C "$WARM" checkout -q --detach FETCH_HEAD
(cd "$WARM" && pnpm install --frozen-lockfile && pnpm exec playwright install ffmpeg)
rm -rf "$HOME/warm" "$WORK"

node --version
pnpm --version
/opt/homebrew/bin/claude --version
df -h /
