#!/bin/bash
# Stand-in for /usr/bin/codesign; a shell script for the reason security.sh gives.

log_args() {
  local file=$1 out="[" sep="" arg
  shift
  for arg in "$@"; do
    arg=${arg//\\/\\\\}
    out+="$sep\"${arg//\"/\\\"}\""
    sep=","
  done
  printf '%s]\n' "$out" >>"$file"
}

# The value after flag $1 in the remaining arguments.
after() {
  local flag=$1
  shift
  while [ $# -gt 0 ]; do
    if [ "$1" = "$flag" ]; then
      printf '%s' "$2"
      return
    fi
    shift
  done
}

has() {
  local flag=$1
  shift
  for arg in "$@"; do
    [ "$arg" = "$flag" ] && return 0
  done
  return 1
}

log_args "$INFINITARY_FAKE_CODESIGN_LOG" "$@"

if has --verify "$@"; then
  seen=$(cat "$INFINITARY_FAKE_VERIFY_COUNT")
  seen=${seen:-0}
  echo $((seen + 1)) >"$INFINITARY_FAKE_VERIFY_COUNT"
  # INFINITARY_FAKE_VERIFY_FAIL_FIRST=N fails the first N verifications.
  [ -n "$INFINITARY_FAKE_VERIFY_FAIL_FIRST" ] && [ "$seen" -lt "$INFINITARY_FAKE_VERIFY_FAIL_FIRST" ] && exit 1
  exit 0
fi

if has --sign "$@"; then
  # INFINITARY_FAKE_CODESIGN_HOLD names a file: signing blocks until it exists,
  # so a test decides when this signer's codesign ends. A test that is gone
  # (its directory removed) releases it too, so no hold outlives its test.
  hold=$INFINITARY_FAKE_CODESIGN_HOLD
  while [ -n "$hold" ] && [ ! -e "$hold" ] && [ -d "${hold%/*}" ]; do
    sleep 0.01
  done
  # The real codesign answers "no identity found" when the --keychain file is
  # not on the user search list, even though --keychain names it.
  if [ -n "$INFINITARY_FAKE_SEARCH_LIST" ]; then
    keychain=$(after --keychain "$@")
    if ! { [ -f "$INFINITARY_FAKE_SEARCH_LIST" ] && grep -qxF -- "$keychain" "$INFINITARY_FAKE_SEARCH_LIST"; }; then
      echo "$(after --sign "$@"): no identity found" >&2
      exit 1
    fi
  fi
  if [ "$INFINITARY_FAKE_CODESIGN_SIGN_FAIL" = "1" ]; then
    echo "signing failed" >&2
    exit 1
  fi
  exit 0
fi

if has --verbose=4 "$@"; then
  printf 'Identifier=com.getinfinitary.infinitary.dev\nAuthority=Infinitary Local Dev\nCDHash=abc\n' >&2
  exit 0
fi

if has -r- "$@"; then
  printf 'designated => %s\n' "$INFINITARY_FAKE_REQUIREMENT"
  exit 0
fi
exit 0
