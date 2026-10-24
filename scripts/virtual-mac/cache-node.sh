#!/bin/bash
# Install provision.sh's checksum-verified Darwin arm64 archive in the layout
# actions/tool-cache reads. No network or machine-wide state is touched here.
set -euo pipefail
ARCHIVE="${1:?Node archive required}"
CACHE="${2:?Tool cache required}"
NAME="$(basename "$ARCHIVE")"
VERSION="${NAME#node-v}"
VERSION="${VERSION%-darwin-arm64.tar.xz}"
[[ "$NAME" == "node-v$VERSION-darwin-arm64.tar.xz" && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Expected a versioned Darwin arm64 Node archive, got $NAME" >&2
  exit 2
}
DEST="$CACHE/node/$VERSION/arm64"
# Never leave a completion marker for an interrupted or failed extraction.
rm -f "$DEST.complete"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xJf "$ARCHIVE" -C "$DEST" --strip-components 1
[ "$("$DEST/bin/node" --version)" = "v$VERSION" ]
touch "$DEST.complete"
printf '%s\n' "$DEST"
