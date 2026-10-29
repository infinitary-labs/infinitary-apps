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
# Fresh clones must start with a complete setup-node cache, not download Node
# again. fm-placer points the runner at this same path outside its wiped _work.
export RUNNER_TOOL_CACHE="$HOME/tool-cache"
NODE_HOME="$(/bin/bash "$SHARE/cache-node.sh" "$WORK/$NODE_TAR" "$RUNNER_TOOL_CACHE")"
rm -rf "$HOME/node"
ln -s "$NODE_HOME" "$HOME/node"
export PATH="$HOME/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" CI=true
# The full Mac gate reads TOML through Python's standard library and checks
# casks against the installed Homebrew, including its tap-trust command.
# The Xcode base's system Python and old Homebrew do not supply these.
brew update
brew install python bash
python3 -c 'import tomllib'
brew help trust > /dev/null
# The simulator admission wrappers use coproc (Bash 4+); macOS ships 3.2.
# Jobs prepend /opt/homebrew/bin, so verify the Bash they will resolve.
bash -c 'test "${BASH_VERSINFO[0]}" -ge 4'
bash --version
# Both Tart services otherwise select system Python and give their children
# background scheduling. Keep the responsible agent and its microphone grant;
# the builder verifies the saved and loaded settings after a clean reboot.
/bin/bash "$SHARE/guest-services.sh" configure
# The app also asks the user's login shell for its child-process path.
for profile in "$HOME/.zprofile" "$HOME/.bash_profile"; do
  printf '\nexport PATH="$HOME/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\n' >> "$profile"
done
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
SIGNING_HOME="$WORK/signing-home"
mkdir -p "$SIGNING_HOME"
# Even inside this disposable guest, signing tools get an explicit scratch
# home and material folder, never the provisioning user's own home.
signing_tool() {
  /usr/bin/env HOME="$SIGNING_HOME" INFINITARY_LOCAL_CODESIGN_DIR="$SIGNING_HOME/material" "$@"
}
sudo -n /usr/bin/env HOME="$SIGNING_HOME" INFINITARY_LOCAL_CODESIGN_DIR="$SIGNING_HOME/material" codesign -f -s - "$AGENT"
signing_tool codesign -v "$AGENT"
REQUIREMENT="$(signing_tool codesign -d -r- "$AGENT" 2>&1 | sed -n 's/^# designated => //p')"
[[ "$REQUIREMENT" == cdhash* ]]
echo "$REQUIREMENT" | csreq -r- -b "$WORK/agent.req"
TCC_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
sqlite3 "$TCC_DB" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, flags, indirect_object_identifier) VALUES ('kTCCServiceMicrophone', '$AGENT', 1, 2, 3, 1, X'$(xxd -p "$WORK/agent.req" | tr -d '\n')', 0, 'UNUSED');"
test "$(sqlite3 "$TCC_DB" "SELECT auth_value FROM access WHERE service = 'kTCCServiceMicrophone' AND client = '$AGENT'")" = 2
killall -u "$(whoami)" tccd || true

# What every project's Mac jobs find in a virtual place (INF-603): one image
# serves them all (docs/testing.md, "One image for every project"). These are
# the tools their workflows name: sshhip's simulator suite checks node,
# python3, perl, gh, git, xcodebuild and swift; the phone check and the suite
# boot an iOS simulator.
for tool in git gh python3 perl swift xcodebuild xcrun; do
  command -v "$tool"
done
# The phone check's pin (scripts/phone-pin.json, INF-1645): the base's
# Xcode and the iOS simulator build the check accepts alone. Xcode's own
# simulator cannot host the check's devices, so Apple's download adds the
# pinned build beside it.
: "${PIN_XCODE:?}" "${PIN_IOS_BUILD:?}"
test "$(xcodebuild -version | sed -n 's/^Xcode //p')" = "$PIN_XCODE"
pinned_runtime() { xcrun simctl list runtimes available | grep -F " - $PIN_IOS_BUILD)" > /dev/null; }
pinned_runtime || xcodebuild -downloadPlatform iOS -buildVersion "$PIN_IOS_BUILD"
pinned_runtime
# sshhip's complete suite passes --runtime 26.1 explicitly. The base has
# only its own Xcode's simulators, which are not a substitute for that job's fixture.
/bin/bash "$SHARE/runtime.sh" install "${IOS_RUNTIME_VERSION:?}" "${IOS_RUNTIME_DMG:?}"

# Nothing that signs as the captain: a job that signs with his Apple
# certificates asks for the real Mac, and the image holds no identity.
signing_tool security find-identity -v -p codesigning | grep '^ *0 valid identities found' > /dev/null

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
