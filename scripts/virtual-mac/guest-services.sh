#!/bin/bash
# The two Tart services must give their children the job's tool path and
# Interactive scheduling. Configure on disk; verify the loaded services only
# after a clean shutdown and fresh boot, without replacing the responsible
# agent (which owns the microphone grant).
set -euo pipefail

case "${1:-}" in configure|verify) ;; *) echo "usage: guest-services.sh configure|verify" >&2; exit 2 ;; esac
for domain in system "gui/$(id -u)"; do
  if [ "$domain" = system ]; then
    label=org.cirruslabs.tart-guest-daemon
    plist="/Library/LaunchDaemons/$label.plist"
  else
    label=org.cirruslabs.tart-guest-agent
    plist="/Library/LaunchAgents/$label.plist"
  fi
  if [ "$1" = configure ]; then
    sudo -n /usr/libexec/PlistBuddy -c \
      "Set :EnvironmentVariables:PATH $HOME/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$plist"
    sudo -n /usr/libexec/PlistBuddy -c 'Set :ProcessType Interactive' "$plist" ||
      sudo -n /usr/libexec/PlistBuddy -c 'Add :ProcessType string Interactive' "$plist"
  else
    test "$(sudo -n /usr/libexec/PlistBuddy -c 'Print :ProcessType' "$plist")" = Interactive
    sudo -n /bin/launchctl print "$domain/$label" | grep 'spawn type = interactive'
  fi
done
if [ "$1" = verify ]; then
  # A reading, not a fixed priority assertion: the scheduler can adjust it.
  ps -o pid=,pri=,command= -p "$$"
fi
