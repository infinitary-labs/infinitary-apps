#!/bin/bash
# Stand-in for /usr/bin/security. A shell script rather than node: a test
# makes dozens of these calls, and booting a JS engine for each one is what
# pushed the suite past its timeout on a busy machine.

# Appends the arguments to $1 as one JSON array.
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

log_args "$INFINITARY_FAKE_SECURITY_LOG" "$@"
for arg in "$@"; do
  [ "$arg" = "-u" ] && exit 42
done

# INFINITARY_FAKE_SEARCH_LIST names a file holding the user search list, one path
# per line, so `-s` writes are read back the way the real list is. Without
# it the list is fixed: login plus the local keychain.
list=$INFINITARY_FAKE_SEARCH_LIST
if [ "$1" = "list-keychains" ]; then
  for ((i = 1; i <= $#; i++)); do
    if [ "${!i}" = "-s" ]; then
      [ -n "$list" ] && printf '%s\n' "${@:i+1}" >"$list"
      exit 0
    fi
  done
  [ "$INFINITARY_FAKE_SECURITY_MODE" = "empty" ] && exit 0
  if [ -n "$list" ] && [ -f "$list" ]; then
    while IFS= read -r entry; do
      [ -n "$entry" ] && printf '    "%s"\n' "$entry"
    done <"$list"
  else
    printf '    "%s"\n' "/Users/test/Library/Keychains/login.keychain-db" "$INFINITARY_FAKE_KEYCHAIN"
  fi
  exit 0
fi
# The real create-keychain puts the new file on the user search list.
[ "$1" = "create-keychain" ] && [ -n "$list" ] && printf '%s\n' "${!#}" >>"$list"
# INFINITARY_FAKE_KEYCHAIN_PASSWORDS=1 makes a keychain file hold its password on
# its first line, and "identity" once something is imported, so unlock refuses
# a password the keychain was not made with the way the real one does:
# errSecAuthFailed, exit 51, at once.
if [ "$INFINITARY_FAKE_KEYCHAIN_PASSWORDS" = "1" ]; then
  keychain=${!#}
  case "$1" in
  create-keychain)
    printf '%s\n' "$(after -p "$@")" >"$keychain"
    exit 0
    ;;
  unlock-keychain)
    if [ "$(head -n 1 "$keychain" 2>/dev/null)" != "$(after -p "$@")" ]; then
      echo "security: SecKeychainUnlock $keychain: The user name or passphrase you entered is not correct." >&2
      exit 51
    fi
    exit 0
    ;;
  find-identity)
    grep -qx identity "$keychain" && printf '  1) "Infinitary Local Dev"\n'
    exit 0
    ;;
  import)
    printf 'identity\n' >>"$(after -k "$@")"
    exit 0
    ;;
  esac
fi
if [ "$1" = "find-identity" ]; then
  printf '  1) "Infinitary Local Dev"\n'
  exit 0
fi
[ "$INFINITARY_FAKE_SECURITY_MODE" = "routine" ] && exit 99
exit 0
