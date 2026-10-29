# shellcheck shell=bash
# Source before starting a VM. Re-enter the whole lifecycle under the placement
# command, not only tart run: the borrow ends when this command ends.
borrow_virtual_mac() {
  local label="$1"
  shift
  if [ -z "${CI:-}" ] && [ -z "${BORROWED_PLACE:-}" ] && command -v borrow-virtual-mac > /dev/null; then
    exec borrow-virtual-mac --label "${BORROW_LABEL:-$label}" --minutes "${BORROW_MINUTES:?Set BORROW_MINUTES to the expected run length in minutes}" -- /bin/bash "$0" "$@"
  fi
}
