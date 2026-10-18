# shellcheck shell=bash
# Sourced by image.sh and run.sh: start a virtual Mac without a window, wait
# for its guest agent and shared folders, and stop it again.

TART="${TART:-tart}"
# Where the guest sees the folders a --dir share names.
# shellcheck disable=SC2034 # read by the scripts that source this one
SHARED="/Volumes/My Shared Files"

# vm_exec <name> <seconds> <command...>: tart exec, given up after <seconds>
# (an exec into a guest that is still starting can hang).
vm_exec() {
  local name="$1" seconds="$2"
  shift 2
  perl -e 'alarm shift; exec @ARGV' "$seconds" "$TART" exec "$name" "$@"
}

# start_vm <name> <log> <file the guest must see> [--dir=...]...
start_vm() {
  local name="$1" log="$2" ready="$3"
  shift 3
  "$TART" run "$name" --no-graphics "$@" > "$log" 2>&1 &
  VM_PID=$!
  for _ in $(seq 1 100); do
    if vm_exec "$name" 30 test -e "$ready" > /dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$VM_PID" 2> /dev/null; then
      echo "The virtual Mac $name stopped while starting:" >&2
      cat "$log" >&2
      return 1
    fi
    sleep 3
  done
  echo "The virtual Mac $name did not answer within 5 minutes." >&2
  return 1
}

stop_vm() {
  local name="$1"
  "$TART" stop "$name" --timeout 60 > /dev/null 2>&1 || true
  if [ -n "${VM_PID:-}" ]; then
    wait "$VM_PID" 2> /dev/null || true
    VM_PID=
  fi
}
