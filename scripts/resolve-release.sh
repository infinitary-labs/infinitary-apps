#!/bin/bash
# resolve-release.sh - the release's one source commit and its names, before
# anything builds (docs/alpha.md "The signed channel workflow"). release.yml's
# resolve job runs it from the workflow's own commit, in a clone with every
# branch and tag. It reads git and the workflow commit's record of past
# releases, never the source's files, so an older alpha's commit is resolved
# by today's rules.
#
#   alpha   CANDIDATE, the commit the release crewmate committed its notes
#           review on: main's code plus changes under release-notes/ only.
#   stable  PROMOTE, a published alpha: the stable builds that alpha's own
#           commit as the alpha's numeric core and tags it there, with
#           HIGHLIGHTS, the entry ids the captain picked as its highlights,
#           lead first (docs/alpha.md "Promoting an alpha").
#
# A rehearsal may omit any of them and build the checked-out commit. Versions come
# from the newest stable tag: the next patch, or the next minor after a
# breaking change since it; an alpha adds the workflow's run number.
#
# A fresh history - a first commit that takes the archived tree whole, with no
# tag of its own yet - numbers from release-notes/archive.json instead, the
# record of past releases: the next patch or minor above the newest version
# either channel published there. Every version, either way, is newer than
# both channels' archived newest (docs/release-notes.md "A fresh history").
#
# usage: resolve-release.sh       (run in a full clone of the product repository)
#
# The old-cask switch (docs/alpha.md "The old-cask switch"): when the
# workflow commit's packaging/old-cask-switch.json lists this channel, the
# release also publishes Infinitary under Firstmate 3000's cask on
# OLD_TAP_REPO, with OLD_TAP_TAG_PREFIX's tags, the only ones an installed
# Firstmate 3000 accepts.
#
# Environment: CHANNEL (stable or alpha), DRY_RUN (true or false), REF (the
# dispatched ref), RUN_NUMBER, CANDIDATE, PROMOTE, HIGHLIGHTS, TAP_REPO,
# TAP_TAG_PREFIX, OLD_TAP_REPO and OLD_TAP_TAG_PREFIX.
# Every refusal exits 1 and writes nothing. Writes key=value lines to
# GITHUB_OUTPUT (stdout without one).
set -euo pipefail

fail() {
  echo "::error title=Release not resolved::$1" >&2
  exit 1
}

CHANNEL="${CHANNEL:-stable}"
DRY_RUN="${DRY_RUN:-false}"
REF="${REF:-}"
RUN_NUMBER="${RUN_NUMBER:-}"
CANDIDATE="${CANDIDATE:-}"
PROMOTE="${PROMOTE:-}"
# Commas between ids; spaces are dropped.
HIGHLIGHTS="$(tr -d '[:space:]' <<<"${HIGHLIGHTS:-}")"
NOTES_DIR=release-notes
ARCHIVE="$NOTES_DIR/archive.json"
SWITCH=packaging/old-cask-switch.json

# Bare v tags only: a component tag slipping through can ship an empty
# release.
stable_tags() {
  git tag --list 'v*' | grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' | sort -V || true
}

# The newest version a channel (stable or alpha) published from the archived
# history, or nothing when there is no record of past releases. The notes job
# checks the record whole; here only each version's shape.
archived_version() {
  [[ -f "$ARCHIVE" ]] || return 0
  command -v jq >/dev/null || fail "reading $ARCHIVE needs jq"
  local version
  version="$(jq -r --arg channel "$1" '.[$channel] // empty' "$ARCHIVE")" \
    || fail "$ARCHIVE is not the record of past releases"
  [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-alpha\.[1-9][0-9]*)?$ ]] \
    || fail "$ARCHIVE names no newest $1 version"
  echo "$version"
}

# Whether version $1 is newer than $2, for X.Y.Z and X.Y.Z-alpha.N: by numeric
# core, then a stable before its own alphas, then alphas by number.
newer_than() {
  local core1="${1%%-*}" core2="${2%%-*}"
  if [[ "$core1" != "$core2" ]]; then
    [[ "$(printf '%s\n%s\n' "$core1" "$core2" | sort -V | tail -n 1)" == "$core1" ]]
    return
  fi
  [[ "$1" != "$2" ]] || return 1
  [[ "$1" != "$core1" ]] || return 0
  [[ "$2" != "$core2" ]] || return 1
  ((${1##*.} > ${2##*.}))
}

ARCHIVED_STABLE="$(archived_version stable)"
ARCHIVED_ALPHA="$(archived_version alpha)"

# The newest numeric core the archived history published on either channel,
# or nothing.
archived_core() {
  [[ -n "$ARCHIVED_STABLE$ARCHIVED_ALPHA" ]] || return 0
  printf '%s\n%s\n' "${ARCHIVED_STABLE%%-*}" "${ARCHIVED_ALPHA%%-*}" | grep . | sort -V | tail -n 1
}

# Commit messages in (since, until], read whole first: grep -q closing a pipe
# early would fail it under pipefail. With no since, every commit up to until:
# a fresh history's own.
breaking_between() {
  local subjects bodies range="${1:+$1..}$2"
  subjects="$(git log "$range" --format='%s')"
  bodies="$(git log "$range" --format='%b')"
  grep -Eq '^[a-z]+(\([^)]*\))?!:' <<<"$subjects" || grep -q '^BREAKING[ -]CHANGE' <<<"$bodies"
}

releasable_between() {
  breaking_between "$1" "$2" || grep -Eq '^(feat|fix)(\([^)]*\))?:' <<<"$(git log "${1:+$1..}$2" --format='%s')"
}

# The stable after the newest one that the source's changes call for: the
# newest stable tag's, or in a fresh history with none, the archived history's.
next_core() {
  local newest base major minor patch
  newest="$(stable_tags | tail -n 1)"
  if [[ -n "$newest" ]]; then
    base="${newest#v}"
  else
    base="$(archived_core)"
  fi
  [[ -n "$base" ]] || fail "the repository has no stable release to number from"
  IFS=. read -r major minor patch <<<"$base"
  if breaking_between "$newest" "$1"; then
    echo "$major.$((minor + 1)).0"
  else
    echo "$major.$minor.$((patch + 1))"
  fi
}

PROMOTED_FROM=
case "$CHANNEL" in
  alpha)
    [[ -z "$PROMOTE" ]] || fail "promote is for stable; an alpha releases its candidate"
    [[ -z "$HIGHLIGHTS" ]] || fail "highlights are for stable; an alpha keeps the ranks its notes review gave"
    [[ "$DRY_RUN" == true || "$REF" == refs/heads/main ]] || fail "a live alpha is requested from main, not $REF"
    [[ "$RUN_NUMBER" =~ ^[1-9][0-9]*$ ]] || fail "run number '$RUN_NUMBER' is not a positive whole number"
    if [[ -n "$CANDIDATE" ]]; then
      [[ "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]] || fail "candidate '$CANDIDATE' is not a full commit id"
      git cat-file -e "$CANDIDATE^{commit}" 2>/dev/null \
        || fail "candidate $CANDIDATE is on no branch of the repository; push its branch, then dispatch again"
      BASE="$(git merge-base "$CANDIDATE" origin/main)" || fail "candidate $CANDIDATE shares no history with main"
      CODE="$(git diff --name-only "$BASE" "$CANDIDATE" | grep -v "^$NOTES_DIR/" || true)"
      if [[ -n "$CODE" ]]; then
        COUNT="$(wc -l <<<"$CODE" | tr -d ' ')"
        NAMED="$(head -n 5 <<<"$CODE" | tr '\n' ' ' | sed 's/ $//')"
        [[ "$COUNT" -le 5 ]] || NAMED="$NAMED and $((COUNT - 5)) more"
        fail "candidate $CANDIDATE changes more than release notes since main's $BASE ($NAMED); a candidate is main's code plus its notes review"
      fi
      SOURCE_COMMIT="$CANDIDATE"
    elif [[ "$DRY_RUN" == true ]]; then
      SOURCE_COMMIT="$(git rev-parse HEAD)"
    else
      fail "a live alpha releases a candidate, the commit the release crewmate committed its notes review on (docs/alpha.md); give candidate"
    fi
    VERSION="$(next_core "$SOURCE_COMMIT")-alpha.$RUN_NUMBER"
    PUBLIC_TAG="${TAP_TAG_PREFIX}alpha-v$VERSION"
    OLD_PUBLIC_TAG="${OLD_TAP_TAG_PREFIX:-}alpha-v$VERSION"
    CASK_TOKEN=infinitary@alpha
    PRERELEASE=true
    ;;
  stable)
    [[ -z "$CANDIDATE" ]] || fail "candidate is for alpha; a stable promotes a published alpha"
    if [[ -n "$PROMOTE" ]]; then
      [[ "$DRY_RUN" == true || "$REF" == refs/heads/main ]] || fail "a promotion is requested from main, not $REF"
      [[ "$PROMOTE" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-alpha\.[1-9][0-9]*$ ]] \
        || fail "'$PROMOTE' is not an alpha version like 0.1.31-alpha.40"
      # A published alpha has a private release, whose tag names its source commit.
      SOURCE_COMMIT="$(git rev-parse --verify -q "refs/tags/v$PROMOTE^{commit}")" \
        || fail "alpha $PROMOTE is not published: the repository has no tag v$PROMOTE"
      VERSION="${PROMOTE%%-*}"
      # A retried promotion finds its own tag on the same commit and keeps
      # what that version already published.
      RELEASED="$(git rev-parse --verify -q "refs/tags/v$VERSION^{commit}" || true)"
      [[ -z "$RELEASED" || "$RELEASED" == "$SOURCE_COMMIT" ]] \
        || fail "stable $VERSION is already released, from $RELEASED"
      # The latest stable before it: this history's newest stable tag, or in a
      # fresh history with none, the archived history's newest stable, whose
      # commits are not here.
      PREVIOUS="$(stable_tags | grep -vxF "v$VERSION" | tail -n 1 || true)"
      LATEST="${PREVIOUS#v}"
      [[ -n "$LATEST" ]] || LATEST="$ARCHIVED_STABLE"
      [[ -n "$LATEST" ]] || fail "the repository has no stable release to promote past"
      newer_than "$VERSION" "$LATEST" || fail "alpha $PROMOTE is not newer than the latest stable, $LATEST"
      releasable_between "$PREVIOUS" "$SOURCE_COMMIT" \
        || fail "no feat, fix or breaking change between $LATEST and alpha $PROMOTE, so there is nothing to release"
      PROMOTED_FROM="$PROMOTE"
    elif [[ "$DRY_RUN" == true ]]; then
      SOURCE_COMMIT="$(git rev-parse HEAD)"
      VERSION="$(next_core "$SOURCE_COMMIT")"
    else
      fail "a stable promotes a published alpha (docs/alpha.md \"Promoting an alpha\"); give promote, for example 0.1.31-alpha.40"
    fi
    # The captain's picks, checked against the notes by the notes job; here
    # only their shape, so a malformed or missing pick stops the run first.
    if [[ -n "$HIGHLIGHTS" ]]; then
      ID='[a-z0-9][a-z0-9-]{2,79}'
      [[ "$HIGHLIGHTS" =~ ^$ID(,$ID){0,2}$ ]] \
        || fail "highlights '$HIGHLIGHTS' are not one to three entry ids separated by commas, lead first"
      [[ -z "$(tr ',' '\n' <<<"$HIGHLIGHTS" | sort | uniq -d)" ]] \
        || fail "highlights '$HIGHLIGHTS' name a change twice"
    else
      [[ "$DRY_RUN" == true ]] \
        || fail "a stable ships the highlights the captain picked on its card (docs/alpha.md \"Promoting an alpha\"); give highlights, their entry ids lead first"
    fi
    PUBLIC_TAG="${TAP_TAG_PREFIX}v$VERSION"
    OLD_PUBLIC_TAG="${OLD_TAP_TAG_PREFIX:-}v$VERSION"
    CASK_TOKEN=infinitary
    PRERELEASE=false
    ;;
  *)
    fail "channel '$CHANNEL' is neither stable nor alpha"
    ;;
esac

# Numbers never go back across a fresh history: every version is newer than
# the newest each channel published there, unless this is a retry of a
# version already released from this very commit.
if [[ "$(git rev-parse --verify -q "refs/tags/v$VERSION^{commit}" || true)" != "$SOURCE_COMMIT" ]]; then
  for FLOOR in "$ARCHIVED_STABLE" "$ARCHIVED_ALPHA"; do
    [[ -z "$FLOOR" ]] || newer_than "$VERSION" "$FLOOR" \
      || fail "$VERSION is not newer than $FLOOR, which the archived history already published ($ARCHIVE)"
  done
fi

ZIP_NAME="Infinitary-${VERSION}-universal.zip"

# Whether this channel's release also switches Firstmate 3000's cask: the
# switch file lists the channels that do, and none until the captain's step
# 13 (alpha) and 14 (stable) of the rename. A missing or unreadable file
# switches nothing.
OLD_CASK=false
if [[ -f "$SWITCH" ]] && node -e '
  const [file, channel] = process.argv.slice(1);
  const { schemaVersion, channels } = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
  process.exit(schemaVersion === 1 && Array.isArray(channels) && channels.includes(channel) ? 0 : 1);
' "$SWITCH" "$CHANNEL"; then
  OLD_CASK=true
  [[ -n "${OLD_TAP_REPO:-}" && -n "${OLD_TAP_TAG_PREFIX:-}" ]] \
    || fail "$SWITCH switches the $CHANNEL cask, but OLD_TAP_REPO or OLD_TAP_TAG_PREFIX is not set"
fi
{
  echo "channel=$CHANNEL"
  echo "dry_run=$DRY_RUN"
  echo "source_commit=$SOURCE_COMMIT"
  echo "version=$VERSION"
  echo "bundle_version=${VERSION%%-*}"
  echo "tag_name=v$VERSION"
  echo "public_tag=$PUBLIC_TAG"
  echo "zip_name=$ZIP_NAME"
  echo "release_url=https://github.com/$TAP_REPO/releases/tag/$PUBLIC_TAG"
  echo "download_url=https://github.com/$TAP_REPO/releases/download/$PUBLIC_TAG/$ZIP_NAME"
  echo "cask_token=$CASK_TOKEN"
  echo "old_cask=$OLD_CASK"
  # What the switch publishes, named whether or not it is on: a rehearsal
  # writes Firstmate 3000's casks it would switch, for the step that turns it on.
  if [[ -n "${OLD_TAP_REPO:-}" && -n "${OLD_TAP_TAG_PREFIX:-}" ]]; then
    echo "old_public_tag=$OLD_PUBLIC_TAG"
    echo "old_download_url=https://github.com/$OLD_TAP_REPO/releases/download/$OLD_PUBLIC_TAG/$ZIP_NAME"
  fi
  echo "prerelease=$PRERELEASE"
  echo "promoted_from=$PROMOTED_FROM"
  echo "highlights=$HIGHLIGHTS"
} >>"${GITHUB_OUTPUT:-/dev/stdout}"
if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run of infinitary $VERSION ($CHANNEL) from $SOURCE_COMMIT - nothing will be published"
else
  echo "Releasing infinitary $VERSION ($CHANNEL) from $SOURCE_COMMIT"
fi
[[ "$OLD_CASK" != true ]] || echo "The $CHANNEL release also switches Firstmate 3000's cask on $OLD_TAP_REPO ($OLD_PUBLIC_TAG)"
