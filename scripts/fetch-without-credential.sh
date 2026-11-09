#!/bin/bash
# fetch-without-credential.sh - fetch one public download with no credential,
# the unauthenticated GET Homebrew, a person and the app's updater make, so the
# release's fetch-back steps check the copy those people would get
# (.github/workflows/release.yml, docs/alpha.md "The signed channel workflow").
#
# usage: fetch-without-credential.sh <url> <file>
#
# Only an answer about the file fails the fetch: a refusal, such as the 404 a
# private or missing release asset gets, is tried five more times 15 seconds
# apart, as the steps always did, and then fails. A server error (HTTP 5xx,
# 408 or 429), a lost or stalled connection, or a host that cannot be reached
# says nothing about the file: during its own incident GitHub answered most
# keyless downloads 504 for over twenty minutes (INF-3224), and an alpha failed
# twice although every copy was right. Those are waited out, 30 seconds apart,
# for up to FETCH_PATIENCE_SECONDS for each file (1,800 by default, which
# leaves the publication job's 90 minutes room for the checks after it), each
# wait named in the log; the fetch fails only when the host is still not
# answering.
# FETCH_PAUSE_SECONDS and FETCH_REFUSAL_PAUSE_SECONDS change the two pauses.
set -euo pipefail

URL="${1:-}"
OUT="${2:-}"
PATIENCE="${FETCH_PATIENCE_SECONDS:-1800}"
PAUSE="${FETCH_PAUSE_SECONDS:-30}"
REFUSAL_PAUSE="${FETCH_REFUSAL_PAUSE_SECONDS:-15}"

fail() {
  echo "::error title=A download could not be fetched::fetch-without-credential: $1" >&2
  exit 1
}

[[ -n "$URL" && -n "$OUT" ]] || fail "usage: fetch-without-credential.sh <url> <file>"

# curl's exits for a host that did not answer: resolving (5, 6), connecting
# (7, 35), a stall past the limits below (28), and a connection lost
# mid-answer (16, 18, 52, 55, 56, 92, 95). Any other exit, such as a full
# disk, fails at once.
not_answering() {
  case "$1" in
    5 | 6 | 7 | 16 | 18 | 28 | 35 | 52 | 55 | 56 | 92 | 95) return 0 ;;
    *) return 1 ;;
  esac
}

STARTED=$SECONDS
REFUSALS=0
while :; do
  STATUS=0
  CODE="$(curl --silent --show-error --location --connect-timeout 30 \
    --speed-limit 1 --speed-time 120 --output "$OUT" --write-out '%{http_code}' -- "$URL")" ||
    STATUS=$?
  if ((STATUS == 0)) && [[ "$CODE" == 2?? ]]; then exit 0; fi
  rm -f "$OUT"
  if ((STATUS != 0)) && ! not_answering "$STATUS"; then
    fail "$URL: curl stopped with exit $STATUS"
  fi
  if ((STATUS != 0)) || [[ "$CODE" == 5?? || "$CODE" == 408 || "$CODE" == 429 ]]; then
    WAITED=$((SECONDS - STARTED))
    ANSWER="HTTP $CODE"
    ((STATUS == 0)) || ANSWER="no answer (curl exit $STATUS)"
    ((WAITED < PATIENCE)) ||
      fail "$URL still gave $ANSWER after ${WAITED}s of waiting; the host is not answering, so the file is unchecked"
    echo "fetch-without-credential: $URL gave $ANSWER after ${WAITED}s; the host is not answering, trying again in ${PAUSE}s" >&2
    sleep "$PAUSE"
    continue
  fi
  REFUSALS=$((REFUSALS + 1))
  ((REFUSALS <= 5)) || fail "$URL answered HTTP $CODE on six tries: it is missing, private or moved"
  echo "fetch-without-credential: $URL answered HTTP $CODE; trying again in ${REFUSAL_PAUSE}s" >&2
  sleep "$REFUSAL_PAUSE"
done
