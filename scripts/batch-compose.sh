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
set -euo pipefail

mode="${1:?compose or apply}"
shift
expected=""
if [ "$mode" = apply ]; then
  expected="${1:?the tree the compose job reported}"
  shift
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
    [ "$mode" = apply ] || echo "merged $number"
  elif [ "$mode" = apply ]; then
    echo "::error title=Batch did not compose::#$number no longer merges onto the batch"
    exit 1
  elif git merge-tree --write-tree --no-messages "$base" "$version" >/dev/null; then
    echo "conflict-batch $number"
  else
    echo "conflict-main $number"
  fi
done

tree="$(git rev-parse "$head^{tree}")"
if [ "$mode" = apply ]; then
  if [ "$tree" != "$expected" ]; then
    echo "::error title=Batch composed differently::this job built tree $tree, the batch is $expected"
    exit 1
  fi
  git checkout --quiet --detach "$head"
  echo "Composed batch $head (tree $tree) onto $base"
else
  echo "tree $tree"
fi
