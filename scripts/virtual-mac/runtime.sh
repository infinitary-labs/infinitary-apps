#!/bin/bash
# The shared image needs the simulator runtime its jobs pin, not merely any
# available iOS runtime. Locate only an Apple-verified installed disk on the
# build Mac; image.sh shares its folder read-only, and the guest imports it.
# No simulator device, signing material or host runtime is changed.
set -euo pipefail
MODE="${1:?locate|install}"
VERSION="${2:?iOS version}"
case "$MODE" in
  locate)
    xcrun simctl runtime list -j | python3 -c '
import json, sys
version = sys.argv[1]
for runtime in json.load(sys.stdin).values():
    if (runtime.get("version") == version
        and runtime.get("platformIdentifier") == "com.apple.platform.iphonesimulator"
        and runtime.get("state") == "Ready"
        and runtime.get("signatureState") == "Verified"):
        print(runtime["path"])
        break
else:
    sys.exit("Install the required iOS simulator runtime on the build Mac, or set IOS_RUNTIME_DMG to its Apple-supplied disk image.")
' "$VERSION"
    ;;
  install)
    available() { xcrun simctl list runtimes available | grep -F "iOS $VERSION (" > /dev/null; }
    if available; then exit 0; fi
    DISK="${3:?Apple-supplied runtime disk}"
    test -f "$DISK"
    xcrun simctl runtime add "$DISK"
    # Import may succeed without providing the requested runtime. Do not
    # publish an image unless the job's actual runtime is now available.
    available
    ;;
  *) echo "usage: runtime.sh locate <version> | install <version> <disk>" >&2; exit 2 ;;
esac
