#!/bin/bash
# fetch-back-copies.sh - the release publication job's fetch-back: every copy
# on every named place is fetched back and checked against the upload job's
# list, with the app's own gates run again on what came back, before any cask
# or feed moves (.github/workflows/release.yml, docs/alpha.md "The signed
# channel workflow").
#
# usage: fetch-back-copies.sh <place>...
#
#   record      the record's copies, read with GH_TOKEN (the product
#               repository is private); the Linux release is laid out from
#               them in $RUNNER_TEMP/linux-release for the steps after it
#   cloudflare  every Cloudflare download, keyless, beside DOWNLOAD_URL
#   tap         the tap's copies as Homebrew fetches them, keyless, beside
#               TAP_DOWNLOAD_URL
#   old-tap     Firstmate 3000's copies as Homebrew fetches them, keyless,
#               beside OLD_DOWNLOAD_URL
#
# The places are read at once: each check reads only its own place into its
# own folders, so none waits on another (they took 3.3, 3.0, 1.7 and 0.8
# minutes one after another). Each place's log is printed whole once every
# check ended, in the order named, and the run fails naming each place whose
# check failed. Only the record's check holds the token; the keyless ones run
# with none, as the people who download do.
#
# It runs in the source checkout, whose scripts/ holds the Mac gates, and
# fetches through the workflow's own fetcher beside it (INF-3224). It writes
# each place's outcome, passed or failed, to $GITHUB_OUTPUT under its name.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FETCH="$HERE/fetch-without-credential.sh"
EXPECTED="$RUNNER_TEMP/expected/files.sha256"
RECORD_TOKEN="${GH_TOKEN:-}"
unset GH_TOKEN

(($# > 0)) || {
  echo "usage: fetch-back-copies.sh <record|cloudflare|tap|old-tap>..." >&2
  exit 2
}
for PLACE in "$@"; do
  case "$PLACE" in
    record | cloudflare | tap | old-tap) ;;
    *)
      echo "fetch-back-copies: no place named $PLACE" >&2
      exit 2
      ;;
  esac
done

# Each copy and its sidecar from a place's folder, keyless, checked against
# the sidecar and the upload job's list; the disk image only where named.
keyless() {
  local whose="$1" base="$2" dir="$3" image="$4" NAME
  rm -rf "$dir" && mkdir -p "$dir"
  while read -r _ NAME; do
    [[ "$image" == with-image || "$NAME" != "$DMG_NAME" ]] || continue
    "$FETCH" "$base/$NAME" "$dir/$NAME"
    "$FETCH" "$base/$NAME.sha256" "$dir/$NAME.sha256"
    (cd "$dir" && shasum -a 256 -c "$NAME.sha256")
    grep -qxF -- "$(cd "$dir" && shasum -a 256 "$NAME")" "$EXPECTED" \
      || { echo "::error title=A copy differs::$whose $NAME is not the file the upload job uploaded." >&2; exit 1; }
  done < "$EXPECTED"
}

# The app inside a fetched zip, unpacked to its own folder and gated again.
gate_zip() {
  local zip="$1" extract="$2"
  rm -rf "$extract" && mkdir -p "$extract"
  ditto -x -k "$zip" "$extract"
  scripts/verify-app.sh "$extract/$APP_NAME" --signed --gatekeeper
  scripts/check-app-launch.sh "$extract/$APP_NAME" "$VERSION"
}

# The record's copies; the recipes rendered again from its packages must be
# the ones fetched, and give the manifest the tap writer and the feeds read.
check_record() {
  local DIR="$RUNNER_TEMP/recorded-verify" NAME
  rm -rf "$DIR" && mkdir -p "$DIR"
  while read -r _ NAME; do
    GH_TOKEN="$RECORD_TOKEN" gh release download "$TAG_NAME" --repo "$GITHUB_REPOSITORY" --pattern "$NAME" --pattern "$NAME.sha256" --dir "$DIR"
    (cd "$DIR" && shasum -a 256 -c "$NAME.sha256")
    grep -qxF -- "$(cd "$DIR" && shasum -a 256 "$NAME")" "$EXPECTED" \
      || { echo "::error title=A copy differs::The record's $NAME is not the file the upload job uploaded." >&2; exit 1; }
  done < "$EXPECTED"
  gate_zip "$DIR/$ZIP_NAME" "$RUNNER_TEMP/recorded-extract"
  [[ ! -f "$DIR/$DMG_NAME" ]] || scripts/verify-mac-dmg.sh "$DIR/$DMG_NAME" "$DIR/$ZIP_NAME" "$VERSION"
  local PACKAGES="$RUNNER_TEMP/recorded-packages"
  rm -rf "$PACKAGES" && mkdir -p "$PACKAGES"
  while IFS= read -r NAME; do
    case "$NAME" in *.deb | *.rpm | *.AppImage) cp "$DIR/$NAME" "$PACKAGES/" ;; esac
  done < "$RUNNER_TEMP/expected/linux.txt"
  local LINUX="$RUNNER_TEMP/linux-release"
  rm -rf "$LINUX"
  node scripts/linux-recipes.ts release --version "$VERSION" --packages "$PACKAGES" --out "$LINUX" >/dev/null
  diff "$LINUX/assets.txt" "$RUNNER_TEMP/expected/linux.txt"
  while IFS= read -r NAME; do cmp "$LINUX/$NAME" "$DIR/$NAME"; done < "$LINUX/assets.txt"
  echo "fetched back and checked every recorded file: $(wc -l < "$EXPECTED" | tr -d ' ') files"
}

# Neither the installer nor the updater requires a GitHub sign-in.
check_cloudflare() {
  local DIR="$RUNNER_TEMP/public-verify"
  keyless "Cloudflare's" "${DOWNLOAD_URL%/*}" "$DIR" with-image
  gate_zip "$DIR/$ZIP_NAME" "$RUNNER_TEMP/public-extract"
  scripts/verify-mac-dmg.sh "$DIR/$DMG_NAME" "$DIR/$ZIP_NAME" "$VERSION"
  echo "fetched back every download without a credential: $(wc -l < "$EXPECTED" | tr -d ' ') files"
}

# The unauthenticated GET the cask performs, so a private, missing or
# altered asset fails the release before the tap learns of it.
check_tap() {
  local DIR="$RUNNER_TEMP/homebrew-verify"
  keyless "The tap's" "${TAP_DOWNLOAD_URL%/*}" "$DIR" without-image
  gate_zip "$DIR/$ZIP_NAME" "$RUNNER_TEMP/homebrew-extract"
  echo "fetched back every tap file without a credential"
}

check_old_tap() {
  keyless "Firstmate 3000's" "${OLD_DOWNLOAD_URL%/*}" "$RUNNER_TEMP/old-public-verify" without-image
  echo "fetched back every Firstmate 3000 file without a credential"
}

LOGS="$(mktemp -d "$RUNNER_TEMP/fetch-back-logs.XXXXXX")"
STARTED=$SECONDS
PIDS=()
for PLACE in "$@"; do
  (
    trap 'echo "$((SECONDS - STARTED))" > "$LOGS/$PLACE.took"' EXIT
    "check_${PLACE//-/_}"
  ) > "$LOGS/$PLACE.log" 2>&1 &
  PIDS+=("$!")
done

FAILED=()
ENDED=()
for AT in "${!PIDS[@]}"; do
  PLACE="${*:AT+1:1}"
  if wait "${PIDS[$AT]}"; then OUTCOME=passed; else OUTCOME=failed; FAILED+=("$PLACE"); fi
  echo "$PLACE=$OUTCOME" >> "${GITHUB_OUTPUT:-/dev/null}"
  ENDED+=("$PLACE: $OUTCOME after $(cat "$LOGS/$PLACE.took" 2>/dev/null || echo '?')s")
done
for PLACE in "$@"; do
  echo "::group::$PLACE"
  cat "$LOGS/$PLACE.log"
  echo "::endgroup::"
done
printf '%s\n' "${ENDED[@]}"
rm -rf "$LOGS"
if ((${#FAILED[@]} > 0)); then
  echo "::error title=A place's copies failed their check::fetch-back-copies: ${FAILED[*]} failed; nothing moves until every place's copies pass." >&2
  exit 1
fi
echo "fetch-back-copies: every copy on $* passed, checked at once in $((SECONDS - STARTED))s"
