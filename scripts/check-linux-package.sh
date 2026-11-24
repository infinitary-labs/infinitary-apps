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
#                to; then, with git installed, it runs the crew turn. The
#                container's own xdotool and ImageMagick work the question,
#                so the runner needs only Xvfb
#   nix          the Nix package built with nix-build against NIXPKGS and run
#                from the Nix store on this runner
#
# A container stands in for a clean copy of its system. It runs privileged,
# so Chromium can make its sandbox's namespaces there, and the runner lifts
# Ubuntu's restriction on user namespaces for it, as Fedora, Arch and NixOS
# have none; ubuntu-host keeps that restriction and the package's own
# AppArmor profile. It shares the runner's shared memory, as an app shares its
# computer's: Chromium keeps the window's frames and pictures in /dev/shm, and
# the journey needs nearly 58 MiB there, within a few MiB of Docker's own
# 64 MiB, where a copy that finds no room makes the browser stop the GPU
# process and the screenshot fail. The window is the runner's virtual screen,
# DISPLAY.
# Environment: IMAGE, NIXPKGS, VERSION (the version the app must report),
# DISPLAY.
set -euo pipefail

SYSTEM="${1:-}"
PACKAGES="$(cd "${2:-}" && pwd)"
EVIDENCE="${3:-}"
WORKSPACE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="infinitary-check-$SYSTEM"
SECRET_POLICY=/usr/share/polkit-1/actions/app.infinitary.secrets.approve.policy

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

# A screen tool run in the box as the person, on the runner's virtual screen.
on_screen() {
  docker exec -u "$(id -u):$(id -g)" -e HOME=/tmp/person -e DISPLAY="$DISPLAY" "$NAME" "$@"
}

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

# As a person, never root: Chromium refuses to run as root with its sandbox on.
journey_in_box() {
  docker exec -u "$(id -u):$(id -g)" -w "$WORKSPACE" \
    -e HOME=/tmp/person -e DISPLAY="$DISPLAY" -e CI=1 \
    -e INFINITARY_INSTALLED_APP="$1" -e INFINITARY_INSTALLED_VERSION="$VERSION" \
    -e INFINITARY_INSTALLED_EVIDENCE="$EVIDENCE" -e INFINITARY_INSTALLED_SECRET_POLICY="$SECRET_POLICY" \
    "$NAME" "${JOURNEY[@]}"
}

start_box() {
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --privileged --network host --ipc host \
    -v /tmp/.X11-unix:/tmp/.X11-unix \
    -v "$WORKSPACE:$WORKSPACE" -v "$PACKAGES:$PACKAGES:ro" -v "$EVIDENCE:$EVIDENCE" \
    -v "$NODE_DIR:$NODE_DIR:ro" \
    "$IMAGE" sleep infinity >/dev/null
  in_box "mkdir -p /tmp/person && chown $(id -u):$(id -g) /tmp/person"
  in_box "cat /etc/os-release" | tee "$EVIDENCE/os-release.txt"
}

case "$SYSTEM" in
  ubuntu-host)
    "$WORKSPACE/scripts/apt-install.sh" "$DEB"
    [[ -f /etc/apparmor.d/infinitary ]] || fail "the package loaded no AppArmor profile"
    bash -euo pipefail -c "$OLD_PATH" || fail "the package left no link at Firstmate 3000's program path"
    cat /etc/os-release > "$EVIDENCE/os-release.txt"
    INFINITARY_INSTALLED_APP=/usr/bin/infinitary INFINITARY_INSTALLED_VERSION="$VERSION" \
      INFINITARY_INSTALLED_EVIDENCE="$EVIDENCE" INFINITARY_INSTALLED_SECRET_POLICY="$SECRET_POLICY" \
      CI=1 "${JOURNEY[@]}"
    ;;
  ubuntu)
    start_box
    in_box "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y '$DEB'"
    in_box "$OLD_PATH" || fail "the package left no link at Firstmate 3000's program path"
    in_box "command -v git"
    journey_in_box /usr/bin/infinitary
    ;;
  fedora)
    start_box
    in_box "dnf install -y '$(one '*.rpm')'"
    in_box "$OLD_PATH" || fail "the package left no link at Firstmate 3000's program path"
    in_box "command -v git"
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
    in_box "dnf install -y gtk3 nss alsa-lib libXScrnSaver libXtst at-spi2-core mesa-libgbm libsecret libnotify xdg-utils util-linux"
    # The screen tools come from the box's own packages, as its desktop
    # libraries do, so nothing here downloads from the runner's own mirrors.
    in_box "dnf install -y --setopt=install_weak_deps=False xdotool ImageMagick"
    in_box "! command -v git" || fail "the container already has git"
    in_box "cp '$APPIMAGE' /tmp/person/infinitary.AppImage && chmod 0755 /tmp/person/infinitary.AppImage && chown $(id -u) /tmp/person/infinitary.AppImage"
    # A container has no FUSE: the AppImage's own runtime unpacks and runs it.
    docker exec -d -u "$(id -u):$(id -g)" -e HOME=/tmp/person -e DISPLAY="$DISPLAY" -e APPIMAGE_EXTRACT_AND_RUN=1 \
      "$NAME" bash -c '/tmp/person/infinitary.AppImage > /tmp/person/no-git.log 2>&1; echo $? > /tmp/person/no-git.exit'
    # Only a window on the screen: xdotool matches names without case, and
    # GTK's hidden leader window carries the app's name, "infinitary".
    for _ in $(seq 1 60); do
      on_screen xdotool search --onlyvisible --name '^Infinitary$' >/dev/null 2>&1 && break
      sleep 1
    done
    WINDOW="$(on_screen xdotool search --onlyvisible --name '^Infinitary$' | head -n 1)" || fail "no question appeared"
    sleep 2
    on_screen import -window root "$EVIDENCE/no-git-ask.png"
    # No window manager runs here to give the question the keyboard, so the
    # check presses Quit itself: the left of the two buttons along its foot.
    eval "$(on_screen xdotool getwindowgeometry --shell "$WINDOW")"
    on_screen xdotool mousemove $((X + WIDTH / 4)) $((Y + HEIGHT - 16)) click 1
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
    # Resolve once: the package and its native-module check need the same libc,
    # not this Ubuntu runner's Node with libraries from a newer Nix system.
    NIX_SOURCE="$(nix-instantiate --find-file nixpkgs -I "nixpkgs=$NIXPKGS")"
    (cd "$RUNNER_TEMP/nix" && nix-build --out-link result -I "nixpkgs=$NIX_SOURCE" \
      -E "with import <nixpkgs> {}; callPackage ./package.nix { src = ./$(basename "$DEB"); }")
    NATIVE_NODE="$(nix-build --no-out-link -I "nixpkgs=$NIX_SOURCE" '<nixpkgs>' -A nodejs)/bin/node"
    printf '%s\n' "$NIX_SOURCE" "$NATIVE_NODE" > "$EVIDENCE/nix-native-runtime.txt"
    APP="$(readlink -f "$RUNNER_TEMP/nix/result")/bin/infinitary"
    echo "$APP" > "$EVIDENCE/nix-store-path.txt"
    # The wrapper's git comes from the store, whatever this runner has.
    grep -q '/nix/store/[^/]*-git-[^/]*/bin' "$APP" || fail "the Nix package does not put its git on the search path"
    INFINITARY_INSTALLED_APP="$APP" INFINITARY_INSTALLED_VERSION="$VERSION" \
      INFINITARY_INSTALLED_EVIDENCE="$EVIDENCE" \
      INFINITARY_INSTALLED_SECRET_POLICY="$(dirname "$(dirname "$APP")")/share/polkit-1/actions/$(basename "$SECRET_POLICY")" \
      INFINITARY_INSTALLED_SECRET_MODULE="$(dirname "$(dirname "$APP")")/lib/infinitary/resources/app.asar.unpacked/node_modules/koffi" \
      INFINITARY_INSTALLED_SECRET_NODE="$NATIVE_NODE" \
      CI=1 "${JOURNEY[@]}"
    ;;
  *)
    fail "unknown system '$SYSTEM'"
    ;;
esac
echo "check-linux-package: $SYSTEM passed"
