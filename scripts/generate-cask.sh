#!/bin/bash
# generate-cask.sh - writes one channel's Infinitary Homebrew cask (decision
# D-15; docs/alpha.md "Casks and update targets") to stdout.
#
# CHANNEL picks the cask: stable (the default, `infinitary`) or alpha
# (`infinitary@alpha`). The two casks install the same app, conflict with
# each other, quit the app before replacing it, and record their channel in
# the release data root after every install or upgrade. The notarized app
# needs no quarantine step.
#
# The product repository stays private through the beta gate, so the
# artifact the cask points at is a release asset on the PUBLIC tap itself,
# under the app-prefixed tag of this VERSION (infinitary-v<version>, or
# infinitary-alpha-v<version> for an alpha version), where Homebrew fetches
# it without a credential. A download URL anywhere else - the private
# product repository above all, a foreign host, or another product's or
# version's release on the tap - is refused, as are a version the channel
# does not carry and a malformed checksum, before anything can reach the
# tap. The caveats are the one-paragraph alpha notice and the channel's own
# paragraph.
#
# NAMES=firstmate writes Firstmate 3000's cask of the channel instead, as the
# old-cask switch publishes it: it installs Infinitary for the people who
# installed Firstmate 3000 (docs/alpha.md "The old-cask switch").
#
# The typed producer is src/core/update/tapPublication.ts, run through
# scripts/tap-publication.ts; this wrapper keeps the release workflow's
# interface.
#
# Environment: VERSION, SHA256, DOWNLOAD_URL, CHANNEL (optional, stable),
# NAMES (optional, infinitary)
set -euo pipefail

: "${VERSION:?Missing VERSION}"
: "${SHA256:?Missing SHA256}"
: "${DOWNLOAD_URL:?Missing DOWNLOAD_URL}"

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tap-publication.ts" cask
