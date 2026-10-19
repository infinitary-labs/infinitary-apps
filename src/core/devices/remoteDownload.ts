import releaseIdentity from "../../../packaging/release-identity.json" with { type: "json" };
import { shellWord } from "./shellWord";

export const UPDATE_STARTING = "infinitary:starting-update";
export const DOWNLOAD_FETCHED = "infinitary:downloaded";
export const RELEASE_REQUIREMENT = `anchor apple generic and identifier "${releaseIdentity.bundleId}" and certificate leaf[subject.OU] = "${releaseIdentity.teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
export const VERIFY_MAC_APP = `/usr/bin/codesign --verify --deep --strict -R ${shellWord("=" + RELEASE_REQUIREMENT)} "$B" || exit 7`;
export const DOWNLOAD_READY = "infinitary:ready-to-update";
export const DOWNLOAD_INSTALL = "install";
/** Two minutes with no byte moving stops a download (docs/devices.md, "Downloading over the connection"). */
export const DOWNLOAD_IDLE_SECONDS = 120;

/** Runs on an older Mac too: only the instructions travel over SSH.
 * $1 is the destination, $2 the published SHA-256, $3 the HTTPS address.
 * Optional: $4 stops it after that many seconds with no byte moving, for a
 * caller with no watch of its own - a join command, or a Mac updated over
 * the connection. $5, in seconds since 1970, is when a copy of the same app
 * from elsewhere must be able to finish instead, at $6 bytes a second: it
 * stops once the time left before $5 is no more than a copy of the stated
 * size needs at that rate - a join command, whose link lasts only so long.
 * Either stop exits 6, as a failed fetch does.
 * Only a checked, completely unpacked app is moved into the destination.
 * stdout carries byte observations, not shell output interpreted as words.
 */
export const MAC_DOWNLOAD = [
  'W="$(mktemp -d "$1/.infinitary-fetch-XXXXXX")" || exit 6',
  'P=""',
  'cleanup() { if [ -n "$P" ]; then kill "$P" 2>/dev/null; wait "$P" 2>/dev/null; fi; rm -rf "$W"; }',
  "trap cleanup EXIT",
  "trap 'exit 6' HUP INT TERM PIPE",
  'F="$W/app.zip"; L=0; Q=0',
  '/usr/bin/curl -q -fsSL --no-buffer --max-filesize 2147483648 --proto "=https" --proto-redir "=https" --connect-timeout 15 -D "$W/headers" -o "$F" "$3" & P=$!',
  // Reset on each response: never use a redirect's Content-Length.
  `count() { N="$(stat -f %z "$F" 2>/dev/null)"; N="\${N:-0}"; [ "$N" -le 2147483648 ] || exit 6; Z="$(awk '/^HTTP/ {n=0} tolower($1)=="content-length:" {gsub("\\r", "", $2); n=$2} END {print n+0}' "$W/headers" 2>/dev/null)"; printf "infinitary:download=%s %s\\n" "$N" "\${Z:-0}" || exit 6; }`,
  // Seconds with nothing moving, counted once a second; a heartbeat never resets them.
  `while kill -0 "$P" 2>/dev/null; do count; if [ "$N" -gt "$L" ]; then L=$N; Q=0; else Q=$((Q + 1)); fi; if [ -n "$4" ] && [ "$Q" -ge "$4" ]; then exit 6; fi; if [ -n "$5" ] && [ "$(date +%s)" -ge $(( $5 - \${Z:-0} / \${6:-2147483647} )) ]; then exit 6; fi; sleep 1; done`,
  'wait "$P"; E=$?; P=""',
  "count",
  '[ "$E" = 0 ] || exit 6',
  `printf "${DOWNLOAD_FETCHED}\\n"`,
  'H="$(/usr/bin/shasum -a 256 "$F")" || exit 7',
  '[ "${H%% *}" = "$2" ] || exit 7',
  'mkdir "$W/unpacked" || exit 8',
  '/usr/bin/ditto -x -k "$F" "$W/unpacked" || exit 8',
  'B=""; for b in "$W/unpacked"/*.app; do B="$b"; break; done',
  '[ -d "$B" ] || exit 8',
  VERIFY_MAC_APP,
  'mv "$B" "$1/" || exit 8',
  // Each line is a whole command, so the same steps also run as one line (`oneLine`).
].join("\n");

/** A script whose every line is a whole command, as one line: a command a person pastes in Terminal. */
export function oneLine(script: string): string {
  return script.split("\n").join("; ");
}

/** Same work-update entry point as a sent zip; failure leaves its private folder behind nowhere. */
export const MAC_DOWNLOAD_UPDATE = [
  'T="$(mktemp -d -t firstmate)" || exit 3',
  "trap 'rm -rf \"$T\"' EXIT",
  "trap 'exit 6' HUP INT TERM PIPE",
  `/bin/sh -c ${shellWord(MAC_DOWNLOAD)} infinitary "$T" "$4" "$5" || exit $?`,
  'B=""; for b in "$T"/*.app; do B="$b"; break; done',
  '[ -d "$B" ] || exit 8',
  `printf "${DOWNLOAD_READY}\\n"`,
  "IFS= read -r C || exit 6",
  `[ "$C" = ${DOWNLOAD_INSTALL} ] || exit 6`,
  '"$B/Contents/MacOS/$(basename "$B" .app)" work update --fetched "$B" --from-home --home "$1" --device "$2" ${3:+--on-home-mac "$3"}',
].join("\n");

export function readDownloadCount(line: string): { received: number; total?: number } | null {
  const match = /^infinitary:download=(\d+) (\d+)$/.exec(line);
  if (!match) return null;
  const received = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(received) || !Number.isSafeInteger(total)) return null;
  return { received, ...(total > 0 && received <= total ? { total } : {}) };
}
