#!/usr/bin/env bash
# Composes a swept batch onto the checked-out main (docs/testing.md, "The
# swept batch"): each approved change, in batch order, merged the way a merge
# on GitHub combines its files, with a fixed author and date so every job
# builds the same commit. Nothing is pushed.
#
#   batch-compose.sh compose <number:version>...
#     Merges what it can and says, one line each, "merged N", "conflict-main N"
#     (N conflicts with main alone) or "conflict-batch N" (N conflicts only
#     with an earlier change here), then "tree T". It leaves the checkout as is.
#   batch-compose.sh apply <tree> <number:version>...
#     Merges every change, fails on any conflict or when the result's tree is
#     not <tree>, and checks the composed commit out.
#   batch-compose.sh bisect <tree> <number:version>... -- <command>...
#     A paused batch's repair (docs/testing.md, "A paused batch's repair"),
#     from a clean checkout: composes the batch as apply does, runs the
#     command on main alone and with every change, and bisects the changes in
#     batch order with git's own bisect, the command's output going to stderr.
#     It says one line: "fails-main" (the command fails on main alone),
#     "passes-batch" (it passes with every change here) or "first-fails N"
#     (it first fails once change N is composed), and leaves main checked out.
set -euo pipefail

mode="${1:?compose, apply or bisect}"
shift
expected=""
if [ "$mode" = apply ] || [ "$mode" = bisect ]; then
  expected="${1:?the tree the compose job reported}"
  shift
fi
command=()
if [ "$mode" = bisect ]; then
  pairs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do
    pairs+=("$1")
    shift
  done
  [ $# -gt 1 ] || { echo "bisect needs -- and the command that runs the failed file" >&2; exit 2; }
  shift
  command=("$@")
  set -- "${pairs[@]}"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "bisect checks out each composed change, so it needs a checkout with no uncommitted change" >&2
    exit 2
  fi
fi

export GIT_AUTHOR_NAME="Infinitary batch" GIT_AUTHOR_EMAIL="batch@infinitary.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="2000-01-01T00:00:00Z" GIT_COMMITTER_DATE="2000-01-01T00:00:00Z"

# A merge needs the history back to each change's merge base.
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  git fetch --quiet --no-tags --unshallow origin
fi

base="$(git rev-parse HEAD)"
head="$base"
for pair in "$@"; do
  number="${pair%%:*}"
  version="${pair#*:}"
  git cat-file -e "$version^{commit}" 2>/dev/null || git fetch --quiet --no-tags origin "$version"
  if result="$(git merge-tree --write-tree --no-messages "$head" "$version")"; then
    head="$(git commit-tree "${result%%$'\n'*}" -p "$head" -p "$version" -m "Batch: #$number")"
    if [ "$mode" = compose ]; then echo "merged $number"; fi
  elif [ "$mode" != compose ]; then
    echo "::error title=Batch did not compose::#$number no longer merges onto the batch"
    exit 1
  elif git merge-tree --write-tree --no-messages "$base" "$version" >/dev/null; then
    echo "conflict-batch $number"
  else
    echo "conflict-main $number"
  fi
done

tree="$(git rev-parse "$head^{tree}")"
if [ "$mode" = compose ]; then
  echo "tree $tree"
  exit 0
fi
if [ "$tree" != "$expected" ]; then
  echo "::error title=Batch composed differently::this job built tree $tree, the batch is $expected"
  exit 1
fi
if [ "$mode" = apply ]; then
  git checkout --quiet --detach "$head"
  echo "Composed batch $head (tree $tree) onto $base"
  exit 0
fi

# bisect: each composed change is one first-parent step from main to $head,
# so git's bisect walks the changes in batch order. Main is checked out again
# however it ends.
trap 'git bisect reset >/dev/null 2>&1 || true; git checkout --quiet --detach "$base"' EXIT
if ! "${command[@]}" >&2; then
  echo "fails-main"
  exit 0
fi
git checkout --quiet --detach "$head"
if "${command[@]}" >&2; then
  echo "passes-batch"
  exit 0
fi
git checkout --quiet --detach "$base"
git bisect start --first-parent "$head" "$base" >&2
git bisect run "${command[@]}" >&2
first="$(git log -1 --format=%s refs/bisect/bad)"
echo "first-fails ${first#Batch: #}"
