#!/bin/bash
# publish-tap.sh - one publication's casks and update targets on the public
# tap, in ONE tap commit (docs/alpha.md "The signed channel workflow").
# release.yml runs it after the public download was fetched back without a
# credential and verified; scripts/tap-publication.ts decides what to write.
#
# usage: publish-tap.sh live|rehearsal|republish|republish-rehearsal
#
#   live       Clones the tap, writes the targets file and the cask of every
#              channel that moves, checks those casks with Homebrew's style
#              cops, commits and pushes. The push is the write boundary: when
#              the tap moved after the clone (another publication, another
#              tool sharing the tap), git refuses it, and the publication is
#              read and written again from the tap's new state - so a late,
#              older publication is refused rather than replacing a newer
#              target, and two publications never overwrite each other. A
#              publication the tap already carries writes nothing.
#   rehearsal  The same reading and writing on an unauthenticated clone of
#              the tap; the files it would commit and the writer's summary are
#              copied to OUT. It never commits or pushes.
#   republish  Republishing the casks (docs/alpha.md "Republishing the
#              casks"; republish-casks.yml): clones the tap, writes each
#              channel's cask as this generator renders it at the target the
#              tap already names, fetches every such target's download back
#              without a credential and checks it against the target's
#              checksum and the release's .sha256 sidecar, runs the style
#              cops, commits and pushes, with the same write boundary as
#              live. The targets file is never written, and casks that are
#              already current write nothing.
#   republish-rehearsal
#              The same on an unauthenticated clone; the casks it would
#              commit and the writer's summary go to OUT. Never commits or
#              pushes.
#
# A rehearsal against a tap that does not exist yet - Infinitary's own,
# before its first release - starts from an empty tap and says so.
#
# Environment: TAP_URL; WORK, a scratch directory; NAMES, whose tap it is:
# infinitary (the default) or firstmate, for the old-cask switch, which
# publishes Infinitary under Firstmate 3000's casks, tags and update files
# (docs/alpha.md "The old-cask switch"). live and rehearsal:
# CHANNEL, VERSION, ZIP_NAME, SHA256, SOURCE_COMMIT; DOWNLOAD_URL, the public
# download that was fetched back and verified - the channel's target must
# name exactly it; LINUX_MANIFEST, when the publication carries Linux
# builds, the manifest of them that was fetched back and verified
# (scripts/linux-recipes.ts release) - the builds file is written in the
# same commit, and the channel's builds must name exactly those files. live
# and republish: HOMEBREW_TAP_TOKEN when the tap needs a credential to push.
# Both rehearsals: OUT.
set -euo pipefail

MODE="${1:-}"

fail() {
  echo "publish-tap: FAIL: $1" >&2
  exit 1
}

case "$MODE" in
  live) KIND=publication PUSH=true ;;
  rehearsal) KIND=publication PUSH=false ;;
  republish) KIND=republication PUSH=true ;;
  republish-rehearsal) KIND=republication PUSH=false ;;
  *) fail "usage: publish-tap.sh live|rehearsal|republish|republish-rehearsal" ;;
esac
REQUIRED=(TAP_URL WORK)
[[ "$KIND" == republication ]] ||
  REQUIRED+=(CHANNEL VERSION ZIP_NAME SHA256 SOURCE_COMMIT DOWNLOAD_URL)
for NAME in "${REQUIRED[@]}"; do
  [[ -n "${!NAME:-}" ]] || fail "missing $NAME"
done
[[ "$PUSH" == true || -n "${OUT:-}" ]] || fail "missing OUT"

SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAP="$WORK/tap"
SUMMARY="$WORK/tap-publication.json"
VERIFIED="$WORK/verified-downloads"
NAMES="${NAMES:-infinitary}"
case "$NAMES" in
  infinitary) TARGETS_FILE=infinitary-updates.json BUILDS_FILE=infinitary-builds.json ;;
  firstmate) TARGETS_FILE=firstmate-3000-updates.json BUILDS_FILE=firstmate-3000-builds.json ;;
  *) fail "NAMES $NAMES is not infinitary or firstmate" ;;
esac
mkdir -p "$WORK"
rm -f "$VERIFIED"

# The tap's token reaches git through a credential helper that reads it from
# the environment, never through a command line.
# shellcheck disable=SC2016 # the helper's own shell expands the token
tap_git() {
  if [[ "$PUSH" == true && -n "${HOMEBREW_TAP_TOKEN:-}" ]]; then
    git -c credential.helper= \
      -c 'credential.helper=!f() { printf "%s\n" "username=x-access-token" "password=$HOMEBREW_TAP_TOKEN"; }; f' \
      "$@"
  else
    git "$@"
  fi
}

# The writer's verdict on the clone in $TAP; a refusal exits with its reason.
advance() {
  local linux=()
  [[ -z "${LINUX_MANIFEST:-}" ]] || linux=(--linux "$LINUX_MANIFEST")
  node "$SCRIPTS/tap-publication.ts" advance --tap "$TAP" --names "$NAMES" --channel "$CHANNEL" \
    --version "$VERSION" --asset "$ZIP_NAME" --sha256 "$SHA256" \
    --source-commit "$SOURCE_COMMIT" ${linux[@]+"${linux[@]}"} "$@" > "$SUMMARY"
}

# shellcheck disable=SC2016 # JavaScript, not shell
summary() {
  node -e '
    const summary = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const lines = process.argv[2] === "files" ? summary.files : summary.notes;
    for (const line of lines) console.log(line);
  ' "$SUMMARY" "$1"
}

# The channel's target is what was verified: the fetched-back download and
# its checksum, whether this publication moved it or the tap already had it.
# shellcheck disable=SC2016 # JavaScript, not shell
check_target() {
  node -e '
    const [file, channel, url, sha256] = process.argv.slice(1);
    const target = JSON.parse(require("node:fs").readFileSync(file, "utf8")).targets[channel];
    if (target?.downloadUrl !== url || target?.sha256 !== sha256) {
      console.error(
        `publish-tap: FAIL: the ${channel} target names ${target?.downloadUrl} (${target?.sha256}), not the verified ${url} (${sha256})`,
      );
      process.exit(1);
    }
  ' "$TAP/$TARGETS_FILE" "$CHANNEL" "$DOWNLOAD_URL" "$SHA256"
}

# The channel's Linux builds are what was verified: every file of the
# manifest for this channel, at the verified download's release, with its
# checksum, whether this publication moved the channel or the tap already
# had it.
# shellcheck disable=SC2016 # JavaScript, not shell
check_builds() {
  [[ -n "${LINUX_MANIFEST:-}" ]] || return 0
  node -e '
    const fs = require("node:fs");
    const [file, manifestFile, channel, url] = process.argv.slice(1);
    const base = url.slice(0, url.lastIndexOf("/") + 1);
    const builds = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const linux = builds.channels?.[channel]?.systems?.linux ?? {};
    const expected = JSON.parse(fs.readFileSync(manifestFile, "utf8"))[channel] ?? {};
    for (const [chip, kinds] of Object.entries(expected)) {
      for (const [kind, { asset, sha256 }] of Object.entries(kinds)) {
        const named = linux[chip]?.[kind];
        if (named?.url !== base + asset || named?.sha256 !== sha256) {
          console.error(
            `publish-tap: FAIL: the ${channel} ${chip} ${kind} build names ${named?.url} (${named?.sha256}), not the verified ${base + asset} (${sha256})`,
          );
          process.exit(1);
        }
      }
    }
  ' "$TAP/$BUILDS_FILE" "$LINUX_MANIFEST" "$CHANNEL" "$DOWNLOAD_URL"
}

# Every download a target names, fetched back the way Homebrew fetches it -
# with no credential - and checked against the target's checksum and the
# release's .sha256 sidecar, so a republished cask names bytes that are
# still published, unchanged. Each download is fetched once per run.
# shellcheck disable=SC2016 # JavaScript, not shell
verify_downloads() {
  local url sha got sidecar
  while read -r url sha; do
    if [[ -f "$VERIFIED" ]] && grep -qxF "$url $sha" "$VERIFIED"; then continue; fi
    rm -f "$WORK/download"
    curl -fsSL --retry 5 --retry-delay 15 --retry-all-errors -o "$WORK/download" "$url" ||
      fail "could not fetch $url without a credential"
    sidecar="$(curl -fsSL --retry 5 --retry-delay 15 --retry-all-errors "$url.sha256")" ||
      fail "could not fetch $url.sha256 without a credential"
    got="$(shasum -a 256 "$WORK/download" | awk '{print $1}')"
    [[ "$got" == "$sha" ]] || fail "$url is $got, not its target's $sha"
    [[ "${sidecar%% *}" == "$sha" ]] || fail "$url.sha256 names ${sidecar%% *}, not its target's $sha"
    echo "$url $sha" >> "$VERIFIED"
    echo "publish-tap: fetched back $url without a credential: sha256 $sha"
  done < <(node -e '
    const { targets } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const target of Object.values(targets)) console.log(`${target.downloadUrl} ${target.sha256}`);
  ' "$TAP/$TARGETS_FILE" | sort -u)
}

# This mode's files in the clone at $TAP, checked before any commit: a
# publication's target is the download release.yml verified, and a
# republication's casks name downloads fetched back just now.
write_files() {
  if [[ "$KIND" == publication ]]; then
    if [[ "$PUSH" == true ]]; then advance; else advance --rehearsal; fi
    check_target
    check_builds
  else
    node "$SCRIPTS/tap-publication.ts" republish --tap "$TAP" --names "$NAMES" > "$SUMMARY"
    [[ -z "$(summary files)" ]] || verify_downloads
  fi
}

style_casks() {
  local casks=() file
  while IFS= read -r file; do
    [[ "$file" == Casks/* ]] && casks+=("$file")
  done < <(summary files)
  if ((${#casks[@]})); then
    # The capability-gated legacy block keeps Homebrew before 6.0.15 working.
    # Retain every other style cop; InstallSteps rejects even a gated block.
    (cd "$TAP" && brew style --except-cops=Cask/InstallSteps "${casks[@]}")
  fi
}

# Whether the tap's repository is missing, as GitHub answers an unsigned
# visitor: a tap not made yet, never one that could not be reached.
tap_missing() {
  local page="${TAP_URL%.git}"
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "$page")" == 404 ]]
}

if [[ "$PUSH" == false ]]; then
  rm -rf "$TAP"
  if ! git clone --quiet --depth 1 "$TAP_URL" "$TAP"; then
    tap_missing || fail "could not clone $TAP_URL"
    echo "publish-tap: $TAP_URL does not exist yet; rehearsing against an empty tap"
    rm -rf "$TAP" && mkdir -p "$TAP"
    git -C "$TAP" init --quiet
    git -C "$TAP" -c user.name=rehearsal -c user.email=rehearsal@localhost \
      commit --quiet --allow-empty -m "an empty tap"
  fi
  write_files
  style_casks
  mkdir -p "$OUT"
  while IFS= read -r FILE; do
    mkdir -p "$OUT/$(dirname "$FILE")"
    cp "$TAP/$FILE" "$OUT/$FILE"
  done < <(summary files)
  cp "$SUMMARY" "$OUT/tap-publication.json"
  echo "publish-tap: rehearsed against the tap at $(git -C "$TAP" rev-parse HEAD); nothing committed or pushed"
  summary notes
  exit 0
fi

for ATTEMPT in 1 2 3 4 5; do
  rm -rf "$TAP"
  tap_git clone --quiet "$TAP_URL" "$TAP"
  BASE="$(git -C "$TAP" rev-parse HEAD)"
  write_files
  FILES=()
  while IFS= read -r FILE; do FILES+=("$FILE"); done < <(summary files)
  if ((${#FILES[@]} == 0)); then
    if [[ "$KIND" == publication ]]; then
      echo "publish-tap: the tap already carries $CHANNEL $VERSION; nothing to write"
    else
      echo "publish-tap: the tap's casks are already current; nothing to write"
    fi
    summary notes
    exit 0
  fi
  style_casks
  git -C "$TAP" add -- "${FILES[@]}"
  if [[ "$KIND" == publication && "$NAMES" == firstmate ]]; then
    MESSAGE=(-m "chore: switch firstmate-3000 to infinitary $VERSION ($CHANNEL)")
  elif [[ "$KIND" == publication ]]; then
    MESSAGE=(-m "chore: publish infinitary $VERSION ($CHANNEL)")
  else
    MESSAGE=(-m "chore: republish $NAMES casks" -m "$(summary notes)")
  fi
  git -C "$TAP" -c user.name="github-actions[bot]" \
    -c user.email="github-actions[bot]@users.noreply.github.com" \
    commit --quiet "${MESSAGE[@]}"
  if tap_git -C "$TAP" push --quiet origin HEAD; then
    if [[ "$KIND" == publication ]]; then
      echo "publish-tap: published $CHANNEL $VERSION in tap commit $(git -C "$TAP" rev-parse HEAD)"
    else
      echo "publish-tap: republished the casks in tap commit $(git -C "$TAP" rev-parse HEAD)"
    fi
    summary notes
    exit 0
  fi
  NOW="$(tap_git ls-remote "$TAP_URL" HEAD | cut -f1)"
  [[ -n "$NOW" && "$NOW" != "$BASE" ]] || fail "the tap refused the push, and it had not moved"
  echo "publish-tap: the tap moved during attempt $ATTEMPT; reading it again"
done
fail "the tap kept moving through five attempts"
