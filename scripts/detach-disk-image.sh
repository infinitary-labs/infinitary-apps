#!/bin/bash
# detach-disk-image.sh - detach a read-only disk image that a release check
# mounted at a mount point of its own, once the check is done with it.
#
# usage: detach-disk-image.sh <mount point>
#
# macOS's own background scans, such as XProtect Remediator, run as the
# system, walk files anywhere on the Mac and can hold one on the image for a
# moment; an unmount at that moment answers "Resource busy" (status 16). That
# hold is invisible to this account's process listing and outside every check,
# so it must not fail a check whose image passed: the image is read-only and
# mounted only for this check, so nothing on it can be lost. A busy image is
# therefore listed with what this account can see holding it, then detached by
# force. Only a forced detach that also fails fails the caller.
set -euo pipefail

MOUNT="${1:?usage: detach-disk-image.sh <mount point>}"

hdiutil detach "$MOUNT" && exit 0
echo "detach-disk-image: $MOUNT is busy; what this account can see holding it:" >&2
lsof -n "$MOUNT" >&2 || echo "detach-disk-image: nothing; the holder runs as another user, such as the system, or has let go" >&2
hdiutil detach -force "$MOUNT"
echo "detach-disk-image: detached $MOUNT by force" >&2
