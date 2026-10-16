#!/bin/bash
# publish-release-asset.sh - puts one signed zip and its .sha256 sidecar on a
# GitHub release without ever replacing published bytes (docs/alpha.md "The
# signed channel workflow"). release.yml runs it for the product
# repository's private release (the record) and then for the public tap's.
#
# usage: publish-release-asset.sh adopt|match <repo> <tag> <zip>
#
# A release that does not exist yet is created first: TITLE, NOTES_FILE,
# TARGET (the commit or branch a new tag is cut at), PRERELEASE=true for an
# alpha, LATEST=false to keep it off the repository's "latest" badge. GitHub
# never shows a prerelease as latest, but --latest=false alone only declines
# to mark a full release: while no release is marked, GitHub shows the
# newest full release as latest anyway. So a full release kept off the
# badge first marks the release showing now, and checks it still shows once
# the new one exists, marking it again if it moved. Then,
# when the release already carries the zip - a retry of the same release,
# whose rebuild never reproduces the same bytes - the published bytes win:
#
#   adopt  the record: the release's tag must name SOURCE_COMMIT, and the
#          published zip is fetched back and becomes this run's artifact;
#   match  every further copy: the published zip must be byte-identical to
#          <zip>, or the release fails.
#
# Nothing is uploaded with --clobber. A missing sidecar is uploaded for the
# artifact; a present one must name exactly its checksum.
#
# Writes zip=<the artifact now published>, sha256=<its checksum> and
# state=uploaded|identical|adopted to GITHUB_OUTPUT (stdout without one).
# Environment: GH_TOKEN for gh, WORK (a scratch directory), and the fields
# above.
set -euo pipefail

MODE="${1:-}"
REPO="${2:-}"
TAG="${3:-}"
ZIP="${4:-}"

fail() {
  echo "publish-release-asset: FAIL: $1" >&2
  exit 1
}

[[ "$MODE" == adopt || "$MODE" == match ]] && [[ -n "$REPO" && -n "$TAG" && -f "$ZIP" ]] \
  || fail "usage: publish-release-asset.sh adopt|match <repo> <tag> <zip>"
: "${WORK:?Missing WORK}"
ZIP_NAME="$(basename "$ZIP")"
OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"

sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# The release the repository shows as latest, as "<id> <tag>", or nothing
# when it has no full release to show.
latest_release() {
  local latest
  if latest="$(gh api "repos/$REPO/releases/latest" --jq '"\(.id) \(.tag_name)"' 2>/dev/null)"; then
    echo "$latest"
  elif [[ -n "$(gh api --paginate "repos/$REPO/releases?per_page=100" \
    --jq '.[] | select(.draft == false and .prerelease == false) | .tag_name')" ]]; then
    fail "could not read which release $REPO shows as latest"
  fi
}
mark_latest() { gh api --method PATCH "repos/$REPO/releases/${1%% *}" -f make_latest=true >/dev/null; }

if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  : "${TITLE:?Missing TITLE}" "${NOTES_FILE:?Missing NOTES_FILE}" "${TARGET:?Missing TARGET}"
  CREATE=(--repo "$REPO" --target "$TARGET" --title "$TITLE" --notes-file "$NOTES_FILE")
  [[ "${PRERELEASE:-false}" == true ]] && CREATE+=(--prerelease)
  [[ "${LATEST:-}" == false ]] && CREATE+=(--latest=false)
  HOLD_LATEST=false
  KEEP_LATEST=""
  if [[ "${LATEST:-}" == false && "${PRERELEASE:-false}" != true ]]; then
    HOLD_LATEST=true
    KEEP_LATEST="$(latest_release)"
    [[ -z "$KEEP_LATEST" ]] || mark_latest "$KEEP_LATEST"
  fi
  gh release create "$TAG" "${CREATE[@]}"
  if [[ -n "$KEEP_LATEST" ]]; then
    if [[ "$(latest_release)" != "$KEEP_LATEST" ]]; then
      mark_latest "$KEEP_LATEST"
      [[ "$(latest_release)" == "$KEEP_LATEST" ]] \
        || fail "$REPO shows $(latest_release) as latest, not ${KEEP_LATEST#* }, after creating $TAG"
    fi
    echo "publish-release-asset: $REPO still shows ${KEEP_LATEST#* } as latest" >&2
  elif [[ "$HOLD_LATEST" == true ]]; then
    echo "publish-release-asset: $REPO had no full release, so GitHub shows $TAG as latest" >&2
  fi
fi

if [[ "$MODE" == adopt ]]; then
  : "${SOURCE_COMMIT:?Missing SOURCE_COMMIT}"
  TAG_COMMIT="$(gh api "repos/$REPO/commits/$TAG" --jq .sha)"
  [[ "$TAG_COMMIT" == "$SOURCE_COMMIT" ]] \
    || fail "$REPO's tag $TAG names $TAG_COMMIT, not this release's source $SOURCE_COMMIT"
fi

ASSETS="$(gh release view "$TAG" --repo "$REPO" --json assets --jq '.assets[].name')"
has_asset() { grep -qxF -- "$1" <<<"$ASSETS"; }

ARTIFACT="$ZIP"
LOCAL_SHA="$(sha_of "$ZIP")"
if has_asset "$ZIP_NAME"; then
  PUBLISHED="$WORK/published"
  rm -rf "$PUBLISHED" && mkdir -p "$PUBLISHED"
  gh release download "$TAG" --repo "$REPO" --pattern "$ZIP_NAME" --dir "$PUBLISHED"
  PUBLISHED_SHA="$(sha_of "$PUBLISHED/$ZIP_NAME")"
  if [[ "$PUBLISHED_SHA" == "$LOCAL_SHA" ]]; then
    STATE=identical
  elif [[ "$MODE" == adopt ]]; then
    ARTIFACT="$PUBLISHED/$ZIP_NAME"
    STATE=adopted
  else
    fail "$REPO $TAG already carries $ZIP_NAME with sha256 $PUBLISHED_SHA, not $LOCAL_SHA; published bytes never change"
  fi
else
  # No --clobber: an asset that appeared since the listing fails the upload.
  gh release upload "$TAG" --repo "$REPO" "$ZIP"
  STATE=uploaded
fi
SHA256="$(sha_of "$ARTIFACT")"

SIDECAR="$WORK/sidecar"
rm -rf "$SIDECAR" && mkdir -p "$SIDECAR"
if has_asset "$ZIP_NAME.sha256"; then
  gh release download "$TAG" --repo "$REPO" --pattern "$ZIP_NAME.sha256" --dir "$SIDECAR"
  read -r SIDECAR_SHA SIDECAR_NAME <"$SIDECAR/$ZIP_NAME.sha256"
  [[ "$SIDECAR_SHA" == "$SHA256" && "$SIDECAR_NAME" == "$ZIP_NAME" ]] \
    || fail "$REPO $TAG's $ZIP_NAME.sha256 names $SIDECAR_SHA $SIDECAR_NAME, not $SHA256 $ZIP_NAME"
else
  printf '%s  %s\n' "$SHA256" "$ZIP_NAME" >"$SIDECAR/$ZIP_NAME.sha256"
  gh release upload "$TAG" --repo "$REPO" "$SIDECAR/$ZIP_NAME.sha256"
fi

{
  echo "zip=$ARTIFACT"
  echo "sha256=$SHA256"
  echo "state=$STATE"
} >>"$OUTPUT"
echo "publish-release-asset: $REPO $TAG carries $ZIP_NAME ($STATE, sha256 $SHA256)" >&2
