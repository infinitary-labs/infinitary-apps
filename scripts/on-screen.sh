#!/usr/bin/env bash
# on-screen.sh - runs a command on a fresh virtual screen with the pointer
# parked on its last pixel (docs/testing.md, "The Linux source desktop").
#
# usage: SCREEN=2560x1600x24 scripts/on-screen.sh <command> [argument]...
#
# With no window manager the window under the pointer takes the keyboard, so
# the pointer waits on the screen's last pixel, where no window reaches.
# park-pointer.ts moves it there through the X library Electron loads, and
# stops unless the pointer is there, so the screen needs only Xvfb. Xvfb runs
# with -noreset: otherwise it resets as its last client leaves - the park,
# before any app opens - and puts the pointer back at the screen's centre,
# where every app window opens.
set -euo pipefail
: "${SCREEN:?SCREEN names the virtual screen, such as 2560x1600x24}"
park="$(dirname "$0")/park-pointer.ts"
exec xvfb-run -a -s "-screen 0 $SCREEN -noreset" sh -c '
  park=$1; shift
  width=${SCREEN%%x*}; height=${SCREEN#*x}; height=${height%%x*}
  node "$park" $((width - 1)) $((height - 1)) || exit 1
  exec "$@"' on-screen "$park" "$@"
