#!/usr/bin/env bash
# on-screen.sh - runs a command on a fresh virtual screen with the pointer
# parked on its last pixel (docs/testing.md, "The Linux source desktop").
#
# usage: SCREEN=2560x1600x24 scripts/on-screen.sh <command> [argument]...
#
# With no window manager the window under the pointer takes the keyboard, so
# the pointer waits on the screen's last pixel, where no window reaches.
# Xvfb runs with -noreset: otherwise it resets as its last client leaves -
# xdotool, before any app opens - and puts the pointer back at the screen's
# centre, where every app window opens. It stops unless the pointer is there.
set -euo pipefail
: "${SCREEN:?SCREEN names the virtual screen, such as 2560x1600x24}"
exec xvfb-run -a -s "-screen 0 $SCREEN -noreset" sh -c '
  width=${SCREEN%%x*}; height=${SCREEN#*x}; height=${height%%x*}
  x=$((width - 1)); y=$((height - 1))
  xdotool mousemove "$x" "$y"
  at=$(xdotool getmouselocation)
  case "$at" in
    "x:$x y:$y "*) exec "$@" ;;
    *) echo "The pointer is not on the last pixel at $x,$y: $at" >&2; exit 1 ;;
  esac' on-screen "$@"
