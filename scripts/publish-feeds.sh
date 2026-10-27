#!/bin/bash
# Publish one verified immutable snapshot; switch its R2 pointer last.
# Rehearsals construct metadata locally and have no upload credentials.
set -euo pipefail
exec node "$(dirname "$0")/publish-storage-feeds.ts" "${1:-}"
