#!/bin/bash
# check-linux-package.sh - installs one Linux package the way a person would
# on its system, then opens it and runs a crew turn
# (tests/installed/installed-package.spec.ts; docs/linux-packages.md, "The
# checks"). linux-packages.yml runs it once a system.
#
# usage: check-linux-package.sh <system> <packages dir> <evidence dir>
#
#   ubuntu-host  this runner's own Ubuntu: the Ubuntu package with apt, its
#                AppArmor profile loaded and the system's restriction on
#                user namespaces left on
#   ubuntu       the Ubuntu package with apt in a clean container of IMAGE
#   fedora       the Fedora package with dnf in a clean container of IMAGE
#   arch         the Arch recipe built with makepkg and installed with
#                pacman in a clean Arch container (Omarchy's base)
#   appimage     the AppImage in a clean container of IMAGE with a desktop's
#                libraries and no git: it must ask for git and quit when told
#                to; then, with git installed, it runs the crew turn
#   nix          the Nix package built with nix-build against NIXPKGS and run
#                from the Nix store on this runner
#
# With OVER set to a Firstmate 3000 version, ubuntu and fedora first install
# Firstmate 3000's published package of that version and open it once as the
# person, then install the package over it as Firstmate 3000's own update
# does (src/core/update/linuxInstall.ts): Firstmate 3000's package must be
# gone and its saved work moved on Infinitary's first launch
# (scripts/check-saved-work-move.sh) before the crew turn.
#
# A container stands in for a clean copy of its system. It runs privileged,
# so Chromium can make its sandbox's namespaces there, and the runner lifts
# Ubuntu's restriction on user namespaces for it, as Fedora, Arch and NixOS
# have none; ubuntu-host keeps that restriction and the package's own
# AppArmor profile. The window is the runner's virtual screen, DISPLAY.
# Environment: IMAGE, NIXPKGS, VERSION (the version the app must report),
# DISPLAY, OVER.
set -euo pipefail

SYSTEM="${1:-}"
PACKAGES="$(cd "${2:-}" && pwd)"
EVIDENCE="${3:-}"
WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="infinitary-check-$SYSTEM"

fail() {
  echo "check-linux-package: FAIL: $1" >&2
  exit 1
}

one() {
  local found
  found="$(find "$PACKAGES" -maxdepth 1 -name "$1" | head -n 1)"
  [[ -n "$found" ]] || fail "no $1 in $PACKAGES"
  echo "$found"
}

mkdir -p "$EVIDENCE"
DEB="$(one '*.deb')"
NODE="$(command -v node)"
NODE_DIR="$(dirname "$(dirname "$NODE")")"
# The journey's own command: the checkout's Playwright, run by this runner's
# Node, which the containers borrow read-only.
JOURNEY=("$NODE" "$WORKSPACE/node_modules/@playwright/test/cli.js" test --config "$WORKSPACE/playwright.installed.config.ts")

in_box() { docker exec "$NAME" bash -euo pipefail -c "$1"; }

# The Ubuntu and Fedora packages replace Firstmate 3000's and leave its
# program path, /opt/firstmate-3000/firstmate-3000, and its command,
# /usr/bin/firstmate-3000, leading to their own program, so an older app
# that installed one as its update starts again (docs/linux-packages.md,
# "The old program path").
# shellcheck disable=SC2016 # the shell in the box expands it
OLD_PATH='for old in /opt/firstmate-3000/firstmate-3000 /usr/bin/firstmate-3000; do
  to="$(readlink -f "$old" || true)"
  [ "$to" = /opt/infinitary/infinitary ] || { echo "$old leads to ${to:-nothing}, not /opt/infinitary/infinitary" >&2; exit 1; }
done'

# Firstmate 3000's published package of OVER, fetched from its tap's
# release and checked against the release's own checksum, for the box to
# install before this package.
OLDER=""
if [[ -n "${OVER:-}" ]]; then
  OLDER="$(mktemp -d)"
fi
older() {
  local base="https://github.com/kunchenguid/homebrew-tap/releases/download/firstmate-3000-v$OVER"
  curl -fsSL --retry 5 --retry-delay 15 --retry-all-errors -o "$OLDER/$1" "$base/$1"
  curl -fsSL --retry 5 --retry-delay 15 --retry-all-errors -o "$OLDER/$1.sha256" "$base/$1.sha256"
  (cd "$OLDER" && sha256sum -c "$1.sha256") >&2
  echo "$OLDER/$1"
}

# As a person, never root: Chromium refuses to run as root with its sandbox on.
as_person() {
  docker exec -u "$(id -u):$(id -g)" -e HOME=/tmp/person -e DISPLAY="$DISPLAY" "$NAME" "$@"
}

# The person's saved work, made by Firstmate 3000 and moved by Infinitary.
SAVED_WORK="$WORKSPACE/scripts/check-saved-work-move.sh"
OLDER_FOLDER=/tmp/person/.config/firstmate-3000

journey_in_box() {
  docker exec -u "$(id -u):$(id -g)" -w "$WORKSPACE" \
    -e HOME=/tmp/person -e DISPLAY="$DISPLAY" -e CI=1 \
    -e INFINITARY_INSTALLED_APP="$1" -e INFINITARY_INSTALLED_VERSION="$VERSION" \
    -e INFINITARY_INSTALLED_EVIDENCE="$EVIDENCE" \
    "$NAME" "${JOURNEY[@]}"
}

start_box() {
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true
  local mounts=(
    -v /tmp/.X11-unix:/tmp/.X11-unix
    -v "$WORKSPACE:$WORKSPACE" -v "$PACKAGES:$PACKAGES:ro" -v "$EVIDENCE:$EVIDENCE"
    -v "$NODE_DIR:$NODE_DIR:ro"
  )
  [[ -z "$OLDER" ]] || mounts+=(-v "$OLDER:$OLDER:ro")
  docker run -d --name "$NAME" --privileged --network host "${mounts[@]}" \
    "$IMAGE" sleep infinity >/dev/null
  in_box "mkdir -p /tmp/person && chown $(id -u):$(id -g) /tmp/person"
  in_box "cat /etc/os-release" | tee "$EVIDENCE/os-release.txt"
}

case "$SYSTEM" in
  ubuntu-host)
    sudo apt-get update -qq
    sudo apt-get install -y "$DEB"
    [[ -f /etc/apparmor.d/infinitary ]] || fail "the package loaded no AppArmor profile"
    bash -euo pipefail -c "$OLD_PATH" || fail "the package left no link at Firstmate 3000's program path"
    cat /etc/os-release > "$EVIDENCE/os-release.txt"
    INFINITARY_INSTALLED_APP=/usr/bin/infinitary INFINITARY_INSTALLED_VERSION="$VERSION" \
      INFINITARY_INSTALLED_EVIDENCE="$EVIDENCE" CI=1 "${JOURNEY[@]}"
    ;;
  ubuntu)
    start_box
    in_box "apt-get update -qq"
    if [[ -n "$OLDER" ]]; then
      OLDER_DEB="$(older "firstmate-3000-$OVER-linux-amd64.deb")"
      in_box "DEBIAN_FRONTEND=noninteractive apt-get install -y '$OLDER_DEB' sqlite3 procps"
      in_box "dpkg-query -W firstmate-3000" | tee "$EVIDENCE/older-package.txt"
      as_person "$SAVED_WORK" make /usr/bin/firstmate-3000 "$OLDER_FOLDER" "$EVIDENCE"
      # Firstmate 3000's own update (src/core/update/linuxInstall.ts).
      in_box "DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades '$DEB'"
      in_box "dpkg -l firstmate-3000 infinitary || true" | tee "$EVIDENCE/packages.txt"
      in_box "! dpkg-query -W -f='\${Status}' firstmate-3000 2>/dev/null | grep -q 'install ok installed'" \
        || fail "Firstmate 3000's package is still installed"
    else
      in_box "DEBIAN_FRONTEND=noninteractive apt-get install -y '$DEB'"
    fi
    in_box "$OLD_PATH" || fail "the package left no link at Firstmate 3000's program path"
    in_box "command -v git"
    [[ -z "$OLDER" ]] || as_person "$SAVED_WORK" moved /usr/bin/infinitary "$OLDER_FOLDER" /tmp/person/.config/infinitary "$EVIDENCE"
    journey_in_box /usr/bin/infinitary
    ;;
  fedora)
    start_box
    if [[ -n "$OLDER" ]]; then
      OLDER_RPM="$(older "firstmate-3000-$OVER-linux-x86_64.rpm")"
      in_box "dnf install -y '$OLDER_RPM' sqlite procps-ng"
      in_box "rpm -q firstmate-3000" | tee "$EVIDENCE/older-package.txt"
      as_person "$SAVED_WORK" make /usr/bin/firstmate-3000 "$OLDER_FOLDER" "$EVIDENCE"
      # Firstmate 3000's own update (src/core/update/linuxInstall.ts).
      in_box "dnf install -y '$(one '*.rpm')'"
      in_box "rpm -q firstmate-3000 infinitary || true" | tee "$EVIDENCE/packages.txt"
      in_box "! rpm -q firstmate-3000" || fail "Firstmate 3000's package is still installed"
    else
      in_box "dnf install -y '$(one '*.rpm')'"
    fi
    in_box "$OLD_PATH" || fail "the package left no link at Firstmate 3000's program path"
    in_box "command -v git"
    [[ -z "$OLDER" ]] || as_person "$SAVED_WORK" moved /usr/bin/infinitary "$OLDER_FOLDER" /tmp/person/.config/infinitary "$EVIDENCE"
    journey_in_box /usr/bin/infinitary
    ;;
  arch)
    start_box
    in_box "pacman -Syu --noconfirm --needed base-devel"
    in_box "useradd -m builder && mkdir /tmp/build && cp '$PACKAGES/aur/PKGBUILD' '$DEB' /tmp/build/ && chown -R builder /tmp/build"
    # The recipe is built as a person, with its checksum checked.
    in_box "cd /tmp/build && su builder -c 'makepkg --cleanbuild --nodeps'"
    in_box "pacman -U --noconfirm /tmp/build/*.pkg.tar.zst"
    in_box "pacman -Qi \$(pacman -Qq | grep '^infinitary')" | tee "$EVIDENCE/pacman.txt"
    in_box "command -v git"
    journey_in_box /usr/bin/infinitary
    ;;
  appimage)
    start_box
    APPIMAGE="$(one '*.AppImage')"
    # A desktop's libraries, and no git.
    in_box "dnf install -y gtk3 nss alsa-lib libXScrnSaver libXtst at-spi2-core mesa-libgbm libsecret libnotify xdg-utils util-linux"
    in_box "! command -v git" || fail "the container already has git"
    in_box "cp '$APPIMAGE' /tmp/person/infinitary.AppImage && chmod 0755 /tmp/person/infinitary.AppImage && chown $(id -u) /tmp/person/infinitary.AppImage"
    # A container has no FUSE: the AppImage's own runtime unpacks and runs it.
    docker exec -d -u "$(id -u):$(id -g)" -e HOME=/tmp/person -e DISPLAY="$DISPLAY" -e APPIMAGE_EXTRACT_AND_RUN=1 \
      "$NAME" bash -c '/tmp/person/infinitary.AppImage > /tmp/person/no-git.log 2>&1; echo $? > /tmp/person/no-git.exit'
    # Only a window on the screen: xdotool matches names without case, and
    # GTK's hidden leader window carries the app's name, "infinitary".
    for _ in $(seq 1 60); do
      xdotool search --onlyvisible --name '^Infinitary$' >/dev/null 2>&1 && break
      sleep 1
    done
    WINDOW="$(xdotool search --onlyvisible --name '^Infinitary$' | head -n 1)" || fail "no question appeared"
    sleep 2
    import -window root "$EVIDENCE/no-git-ask.png"
    # No window manager runs here to give the question the keyboard, so the
    # check presses Quit itself: the left of the two buttons along its foot.
    eval "$(xdotool getwindowgeometry --shell "$WINDOW")"
    xdotool mousemove $((X + WIDTH / 4)) $((Y + HEIGHT - 16)) click 1
    for _ in $(seq 1 30); do
      in_box "test -f /tmp/person/no-git.exit" && break
      sleep 1
    done
    in_box "cat /tmp/person/no-git.log" > "$EVIDENCE/no-git.log" || true
    in_box "test -f /tmp/person/no-git.exit" || fail "the AppImage kept running after Quit"
    in_box "test \"\$(cat /tmp/person/no-git.exit)\" = 0" || fail "the AppImage did not quit cleanly"
    in_box "dnf install -y git"
    docker exec -u "$(id -u):$(id -g)" -w "$WORKSPACE" \
      -e HOME=/tmp/person -e DISPLAY="$DISPLAY" -e CI=1 -e APPIMAGE_EXTRACT_AND_RUN=1 \
      -e INFINITARY_INSTALLED_APP=/tmp/person/infinitary.AppImage -e INFINITARY_INSTALLED_VERSION="$VERSION" \
      -e INFINITARY_INSTALLED_EVIDENCE="$EVIDENCE" \
      "$NAME" "${JOURNEY[@]}"
    ;;
  nix)
    sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null
    mkdir -p "$RUNNER_TEMP/nix"
    cp "$PACKAGES/nix/package.nix" "$DEB" "$RUNNER_TEMP/nix/"
    (cd "$RUNNER_TEMP/nix" && nix-build --out-link result -I "nixpkgs=$NIXPKGS" \
      -E "with import <nixpkgs> {}; callPackage ./package.nix { src = ./$(basename "$DEB"); }")
    APP="$(readlink -f "$RUNNER_TEMP/nix/result")/bin/infinitary"
    echo "$APP" > "$EVIDENCE/nix-store-path.txt"
    # The wrapper's git comes from the store, whatever this runner has.
    grep -q '/nix/store/[^/]*-git-[^/]*/bin' "$APP" || fail "the Nix package does not put its git on the search path"
    INFINITARY_INSTALLED_APP="$APP" INFINITARY_INSTALLED_VERSION="$VERSION" \
      INFINITARY_INSTALLED_EVIDENCE="$EVIDENCE" CI=1 "${JOURNEY[@]}"
    ;;
  *)
    fail "unknown system '$SYSTEM'"
    ;;
esac
echo "check-linux-package: $SYSTEM passed"
