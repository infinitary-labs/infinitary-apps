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
set -euo pipefail

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
sudo apt-get -o DPkg::Lock::Timeout=-1 update
sudo apt-get -o DPkg::Lock::Timeout=-1 install -y "$@"
