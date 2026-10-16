#!/bin/bash
# check-bundled-git.sh - the app's own git in a built bundle (git integration
# phase 2, docs/forge.md "The app's own git"): both architectures' trees, and
# the one-file directory that puts that git first on a crewmate's search
# path. The tree for the machine running the check must answer
# `git --version` through that directory with an empty environment - no
# search path at all - the way a crewmate's shell runs it; the other is
# checked for its architecture. Prints the version on success.
#
# Run by scripts/verify-app.sh (every release gate) and by the package smoke
# in verify.yml on the dev bundle.
#
#   check-bundled-git.sh <app>
set -euo pipefail

APP_DIR="${1:-}"
fail() {
  echo "verify-app: FAIL: $1" >&2
  exit 1
}
[[ -n "$APP_DIR" && -d "$APP_DIR" ]] || fail "usage: check-bundled-git.sh <app>"
APP_DIR="${APP_DIR%/}"

GIT_SHIM="$APP_DIR/Contents/Resources/git-bin/git"
[[ -x "$GIT_SHIM" ]] \
  || fail "the app's git directory (Contents/Resources/git-bin/git) is missing or not executable"
case "$(uname -m)" in
  arm64) HOST_GIT_ARCH=arm64 ;;
  *) HOST_GIT_ARCH=x64 ;;
esac
for GIT_ARCH in arm64 x64; do
  GIT_TREE="$APP_DIR/Contents/Resources/git/darwin-$GIT_ARCH"
  [[ -x "$GIT_TREE/bin/git" ]] \
    || fail "the app's git for $GIT_ARCH (Contents/Resources/git/darwin-$GIT_ARCH/bin/git) is missing or not executable"
  GIT_SLICE="$GIT_ARCH"
  [[ "$GIT_ARCH" == x64 ]] && GIT_SLICE=x86_64
  [[ "$(file -b "$GIT_TREE/bin/git")" == *Mach-O*"$GIT_SLICE"* ]] \
    || fail "the app's git for $GIT_ARCH is not a $GIT_SLICE Mach-O: $(file -b "$GIT_TREE/bin/git")"
done
VERSION="$(env -i INFINITARY_GIT_DIR="$APP_DIR/Contents/Resources/git/darwin-$HOST_GIT_ARCH" "$GIT_SHIM" --version 2>&1)" \
  || fail "the app's git did not run: $VERSION"
[[ "$VERSION" == "git version "* ]] \
  || fail "the app's git answered '$VERSION', not a git version"
echo "$VERSION"
