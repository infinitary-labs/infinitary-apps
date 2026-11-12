#!/bin/bash
# apt-install.sh - installs packages with apt on a disposable Linux runner,
# first taking over from the machine's own automatic updates
# (docs/testing.md, "The runner's automatic updates").
#
# usage: apt-install.sh [apt-get install option]... <package or path to a .deb>...
#
# A fresh Ubuntu machine may start its automatic updates as it boots, and
# they hold apt's locks: the list refresh holds the package lists' lock, and
# unattended-upgrade holds dpkg's. A plain apt-get stops at once on a held
# lock, with exit code 100, and the job with it. So this turns the automatic
# updates off for the rest of the machine's life, which only a disposable
# runner may do: a run that starts later ends without touching apt. It then
# waits for a run already going to end, since apt's daily script holds its
# daily_lock for its whole run, and meanwhile asks that run's
# unattended-upgrade to stop, as the package's own shutdown helper does; it
# stops after the package it is installing. apt-get then waits for dpkg's
# lock should anything else hold it. Every wait lasts as long as the calling
# step lets it.
#
# A mirror can also stall the list refresh partway: a connection that keeps
# sending a little never trips apt's own timer, which ends only a connection
# silent for 30 seconds, so apt-get update would wait until the step's limit
# ends the job. apt prints a line as it starts each file or gives one up, so
# a refresh that prints nothing for $quiet seconds has stalled: this ends it
# and starts a fresh one, with new connections.
#
# A mirror part way through its own update can serve a package list that the
# index it already served does not describe, and apt-get update then fails
# with status 100 ("File has unexpected size ... Mirror sync in progress?");
# the same refresh passes once the mirror's update has moved on. So a refresh
# that fails waits $pause seconds and starts again. Stalled and failed
# refreshes share one count, up to $tries refreshes in all; anything else
# stops at once with its own status.
set -euo pipefail

# Longer than apt's own longest silence, about a minute while it retries a
# silent connection, and short enough that every try and the install fit in
# the ten minutes each install step allows.
quiet=90
# Time for a mirror's update to move on between a failed refresh and the
# next, short enough that the pauses, every try and the install still fit in
# those ten minutes.
pause=60
tries=3

# One apt-get update, its lines passed through. It answers apt-get's own exit
# status, or 124 when apt printed nothing for $quiet seconds and was ended.
refresh_lists() {
  local lines pid line status=0
  exec {lines}< <(exec sudo apt-get -o DPkg::Lock::Timeout=-1 update 2>&1)
  pid=$!
  while :; do
    IFS= read -r -t "$quiet" -u "$lines" line || { status=$?; break; }
    printf '%s\n' "$line"
  done
  if [ "$status" -gt 128 ]; then
    # sudo passes the signal on to apt-get, whose download methods end with it.
    sudo kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" || true
    exec {lines}<&-
    return 124
  fi
  if [ -n "$line" ]; then printf '%s\n' "$line"; fi
  exec {lines}<&-
  wait "$pid"
}

echo 'APT::Periodic::Enable "0";' | sudo tee /etc/apt/apt.conf.d/99-runner-no-automatic-updates >/dev/null
said=""
until sudo flock --nonblock /var/lib/apt/daily_lock true; do
  if [ -z "$said" ]; then
    echo "apt-install: the machine's automatic update is running; asking it to stop and waiting for it to end"
    said=1
  fi
  if [ -f /var/run/unattended-upgrades.pid ]; then
    sudo kill -TERM "$(cat /var/run/unattended-upgrades.pid 2>/dev/null)" 2>/dev/null || true
  fi
  sleep 1
done
try=1
until refresh_lists; do
  status=$?
  case "$status" in
    124) what="the package lists printed nothing for $quiet seconds, so the download has stalled"; delay=0 ;;
    100) what="refreshing the package lists failed, as it does while a mirror is part way through its own update"; delay=$pause ;;
    *) exit "$status" ;;
  esac
  if [ "$try" -ge "$tries" ]; then
    echo "apt-install: $what; that was the last of $tries tries, so giving up"
    exit "$status"
  fi
  try=$((try + 1))
  if [ "$delay" -gt 0 ]; then
    echo "apt-install: $what; starting it again in $delay seconds (try $try of $tries)"
    sleep "$delay"
  else
    echo "apt-install: $what; starting it again (try $try of $tries)"
  fi
done
sudo apt-get -o DPkg::Lock::Timeout=-1 install -y "$@"
