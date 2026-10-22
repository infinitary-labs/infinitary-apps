#!/bin/bash
# check-old-cask-upgrade.sh - a person on Firstmate 3000's cask lands on
# Infinitary, with their saved work, through the update they already run:
#
#     brew update && brew upgrade --cask firstmate-3000@alpha
#
# (docs/alpha.md "The old-cask switch"; firstmate-3000 for stable). It taps
# Firstmate 3000's tap as the person did, installs the cask as it stood
# before the switch, opens Firstmate 3000 once so it makes the person's saved
# work (scripts/check-saved-work-move.sh), and upgrades. Then Firstmate
# 3000.app must be gone and Infinitary.app there, the cask's channel marker
# must say the installation came through the old cask, Infinitary's first
# launch must move the saved work and keep the marker, and the app must be
# the version the switch published (scripts/check-app-launch.sh).
#
# usage: check-old-cask-upgrade.sh <alpha|stable> <live|rehearsal> <evidence dir> [version]
#
#   live       Firstmate 3000's tap as published: brew update brings the
#              switched cask, whose version must be [version] when given.
#   rehearsal  before a switched release exists: the switch's own writer
#              (scripts/tap-publication.ts advance --names firstmate) moves
#              the tapped cask, in a commit never pushed, to the newest
#              Infinitary of the channel that Infinitary's tap published, and
#              that build's download goes where Homebrew caches the cask's
#              address, so brew upgrade installs it without brew update.
#
# It writes /Applications and the home it runs in, and brew upgrade quits
# Firstmate 3000 by its bundle id, so it runs only in a throwaway virtual
# Mac (old-cask-upgrade.yml's mini-mac-virtual) and refuses anywhere else.
# Needs Homebrew, Node and, for a rehearsal, the repository's packages.
set -euo pipefail

CHANNEL="${1:-}"
MODE="${2:-}"
EVIDENCE="${3:-}"
VERSION="${4:-}"
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPTS/.." && pwd)"

fail() {
  echo "check-old-cask-upgrade: FAIL: $1" >&2
  exit 1
}

case "$CHANNEL" in
  alpha) TOKEN=firstmate-3000@alpha ;;
  stable) TOKEN=firstmate-3000 ;;
  *) fail "usage: check-old-cask-upgrade.sh <alpha|stable> <live|rehearsal> <evidence dir> [version]" ;;
esac
[[ "$MODE" == live || "$MODE" == rehearsal ]] && [[ -n "$EVIDENCE" ]] \
  || fail "usage: check-old-cask-upgrade.sh <alpha|stable> <live|rehearsal> <evidence dir> [version]"

[[ "$(sysctl -n kern.hv_vmm_present 2>/dev/null)" == 1 ]] \
  || fail "it installs into /Applications and quits apps by their id, so it runs only in a throwaway virtual Mac"

TAP=kunchenguid/tap
OLD_APP="/Applications/Firstmate 3000.app"
NEW_APP="/Applications/Infinitary.app"
SUPPORT="$HOME/Library/Application Support"
OLDER="$SUPPORT/firstmate-3000"
FOLDER="$SUPPORT/infinitary"
for path in "$OLD_APP" "$NEW_APP" "$OLDER" "$FOLDER"; do
  [[ ! -e "$path" ]] || fail "$path is already there: the check needs a Mac that never had Firstmate 3000 or Infinitary"
done
mkdir -p "$EVIDENCE"
WORK="$(mktemp -d)"

# Each brew step is one the check names; the person's install ran no update
# of its own here, since the cask must stay as it was before the switch.
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1
# Both apps draw in software in a virtual Mac, as the journeys there do
# (docs/testing.md, "Drawing in software").
export APP_SWITCHES=--disable-gpu

# The channel marker the switched cask writes (markerContent in
# src/core/update/tapPublication.ts).
MARKER="{\"schemaVersion\":1,\"channel\":\"$CHANNEL\",\"cameThroughOldCask\":true}"
marker_is_the_switch() {
  [[ "$(cat "$FOLDER/update-channel.json" 2>/dev/null)" == "$MARKER" ]]
}

# -- Firstmate 3000, as the person installed it.
brew tap "$TAP"
# Homebrew 6 and later load a third-party tap's casks only once it is trusted.
if brew trust --help >/dev/null 2>&1; then brew trust --tap "$TAP"; fi
TAPPED="$(brew --repository "$TAP")"
CASK_FILE="Casks/$TOKEN.rb"
BEFORE=""
for commit in $(git -C "$TAPPED" log --format=%H -- "$CASK_FILE"); do
  if git -C "$TAPPED" show "$commit:$CASK_FILE" | grep -q '^  app "Firstmate 3000.app"$'; then
    BEFORE="$commit"
    break
  fi
done
[[ -n "$BEFORE" ]] || fail "no commit of $TAP has $CASK_FILE install Firstmate 3000"
# The tap as the person last updated it: the branch and what it knows of the
# tap's own, so brew update fetches everything since, the switch included.
UPSTREAM="$(git -C "$TAPPED" rev-parse --abbrev-ref '@{upstream}')"
git -C "$TAPPED" reset --quiet --hard "$BEFORE"
git -C "$TAPPED" update-ref "refs/remotes/$UPSTREAM" "$BEFORE"
cp "$TAPPED/$CASK_FILE" "$EVIDENCE/cask-before.rb"
brew install --cask "$TAP/$TOKEN" 2>&1 | tee "$EVIDENCE/brew-install.txt"
[[ -d "$OLD_APP" ]] || fail "$TOKEN did not install Firstmate 3000.app"
brew list --cask --versions | tee "$EVIDENCE/casks-before.txt"
"$SCRIPTS/check-saved-work-move.sh" make "$OLD_APP/Contents/MacOS/Firstmate 3000" "$OLDER" "$EVIDENCE"

# -- The switch.
if [[ "$MODE" == live ]]; then
  brew update 2>&1 | tee "$EVIDENCE/brew-update.txt"
  EXPECTED="$(node -e '
    const [file, channel] = process.argv.slice(1);
    process.stdout.write(JSON.parse(require("node:fs").readFileSync(file, "utf8")).targets[channel].version);
  ' "$TAPPED/firstmate-3000-updates.json" "$CHANNEL")"
  [[ -z "$VERSION" || "$VERSION" == "$EXPECTED" ]] \
    || fail "Firstmate 3000's tap offers $CHANNEL $EXPECTED, not $VERSION"
else
  # The newest Infinitary of the channel in the history of Infinitary's tap:
  # its update target and the Linux builds the writer carries beside it.
  git clone --quiet https://github.com/infinitary-labs/homebrew-tap.git "$WORK/infinitary-tap"
  PICKED=""
  for commit in $(git -C "$WORK/infinitary-tap" log --format=%H -- infinitary-updates.json); do
    git -C "$WORK/infinitary-tap" show "$commit:infinitary-updates.json" >"$WORK/targets.json"
    git -C "$WORK/infinitary-tap" show "$commit:infinitary-builds.json" >"$WORK/builds.json" 2>/dev/null || continue
    if node -e '
      const fs = require("node:fs");
      const [targetsFile, buildsFile, channel, out] = process.argv.slice(1);
      const target = JSON.parse(fs.readFileSync(targetsFile, "utf8")).targets[channel];
      if (!target || target.version.includes("-alpha.") !== (channel === "alpha")) process.exit(1);
      const builds = JSON.parse(fs.readFileSync(buildsFile, "utf8")).channels;
      const manifest = {};
      for (const [name, entry] of Object.entries(builds)) {
        const linux = entry.version === target.version && entry.systems?.linux?.x64;
        if (!linux) continue;
        manifest[name] = { x64: {} };
        for (const [kind, file] of Object.entries(linux))
          manifest[name].x64[kind] = { asset: file.url.split("/").pop(), sha256: file.sha256 };
      }
      if (!manifest[channel]) process.exit(1);
      fs.writeFileSync(out + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
      const lines = [target.version, target.downloadUrl, target.sha256, target.sourceCommit];
      fs.writeFileSync(out + "/published.txt", lines.join("\n") + "\n");
    ' "$WORK/targets.json" "$WORK/builds.json" "$CHANNEL" "$WORK"; then
      PICKED="$commit"
      break
    fi
  done
  [[ -n "$PICKED" ]] || fail "Infinitary's tap never published a $CHANNEL build"
  { read -r EXPECTED; read -r DOWNLOAD_URL; read -r SHA256; read -r SOURCE_COMMIT; } <"$WORK/published.txt"
  cp "$WORK/published.txt" "$EVIDENCE/rehearsed-build.txt"
  node "$ROOT/scripts/tap-publication.ts" advance --tap "$TAPPED" --names firstmate \
    --channel "$CHANNEL" --version "$EXPECTED" --asset "${DOWNLOAD_URL##*/}" \
    --sha256 "$SHA256" --source-commit "$SOURCE_COMMIT" --linux "$WORK/manifest.json" \
    | tee "$EVIDENCE/tap-publication.json"
  git -C "$TAPPED" add --all
  git -C "$TAPPED" -c user.name="old-cask upgrade check" -c user.email=check@invalid \
    commit --quiet -m "Rehearse the switch to Infinitary $EXPECTED"
  CACHED="$(brew --cache --cask "$TAP/$TOKEN")"
  mkdir -p "$(dirname "$CACHED")"
  curl -fsSL --retry 5 --retry-delay 15 --retry-all-errors -o "$CACHED" "$DOWNLOAD_URL"
  [[ "$(shasum -a 256 "$CACHED" | awk '{print $1}')" == "$SHA256" ]] \
    || fail "Infinitary's published download is not the build its tap names"
fi
cp "$TAPPED/$CASK_FILE" "$EVIDENCE/cask-after.rb"
grep -q '^  app "Infinitary.app"$' "$TAPPED/$CASK_FILE" \
  || fail "$CASK_FILE does not install Infinitary.app: the switch has not reached $TAP"

# -- The person's update.
brew upgrade --cask "$TOKEN" 2>&1 | tee "$EVIDENCE/brew-upgrade.txt"
brew list --cask --versions | tee "$EVIDENCE/casks-after.txt"
[[ ! -e "$OLD_APP" ]] || fail "Firstmate 3000.app is still installed after the upgrade"
[[ -d "$NEW_APP" ]] || fail "the upgrade did not install Infinitary.app"
cp "$FOLDER/update-channel.json" "$EVIDENCE/update-channel.json" 2>/dev/null || true
marker_is_the_switch || fail "the cask's channel marker is not $MARKER"

# -- Infinitary's first launch, and the version it is.
"$SCRIPTS/check-saved-work-move.sh" moved "$NEW_APP/Contents/MacOS/Infinitary" "$OLDER" "$FOLDER" "$EVIDENCE"
marker_is_the_switch || fail "the move did not keep the cask's channel marker"
"$SCRIPTS/check-app-launch.sh" "$NEW_APP" "$EXPECTED" 2>&1 | tee "$EVIDENCE/app-launch.txt"

echo "check-old-cask-upgrade: brew upgrade --cask $TOKEN replaced Firstmate 3000 with Infinitary $EXPECTED ($MODE), which moved the saved work and kept the old cask's channel" \
  | tee "$EVIDENCE/summary.txt"
