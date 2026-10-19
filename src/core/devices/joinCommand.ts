import { shellWord } from "./shellWord";

export { shellWord } from "./shellWord";

import { dirname } from "node:path";
import { FETCH_APP_PATH } from "@shared/connection";
import { COMPUTER, HERE } from "@shared/deviceNames";
import {
  type DeviceCommandFor,
  DOWNLOAD_COMMAND_LINK_TTL_MS,
  linkAddresses,
  parsePairingLink,
  splitDialAddress,
} from "@shared/devices";
import { settingFrom } from "@shared/envSettings";
import type { UpdateDownload } from "@shared/work";
import {
  COMMAND_DOWNLOADING,
  commandClosed,
  commandDownloadFallback,
  commandExpired,
  commandUsed,
  macAsk,
  needsCurl,
  otherSystem,
  sandboxOff,
} from "../helper/words";
import { LINUX_APP_FILE, SANDBOX_PROBE } from "./farSystems";
import { DOWNLOAD_IDLE_SECONDS, MAC_DOWNLOAD, oneLine } from "./remoteDownload";

/**
 * The one command that joins a computer to this home (docs/devices.md,
 * "Joining by a command"; design skill `components/devices/AddAMac`). It
 * carries a link inside it, with the link's rules: it works once, for ten
 * minutes, and exists only in this Mac's own window.
 *
 * - **Running as another user on this Mac**: this Mac's own app, started in
 *   its work mode with the link (`<app> work join <link>`). The app asks
 *   its yes and joins.
 * - **Another Mac**: one line for Terminal there that checks the home's key,
 *   asks its yes, and only then gets Firstmate: this Mac's published version,
 *   downloaded there and checked, when this Mac's version is published, or
 *   else from this Mac with the same link (`FETCH_APP_PATH`). It unpacks it
 *   and has it join with `--fetched`, so the person is not asked twice. Both
 *   Macs then run the same version and need only the same network.
 *
 * The other Mac's shell runs the second as `/bin/sh -c <script> <values>`:
 * the script is the same every time and names no value, and every value -
 * the link, this Mac's name, its address - is its own quoted word after it,
 * so nothing a name holds can change what runs.
 */

/** How this app starts itself: its executable, and before `work` the folder an unpackaged run loads. */
export type AppLauncher = { executable: string; args: readonly string[] };

export type JoinCommandInput = {
  for: DeviceCommandFor;
  /** The link the command carries. */
  link: string;
  /** This Mac's own name, which the other Mac's question says. */
  homeName: string;
  /** This app as another user here starts it. */
  launcher: AppLauncher;
  /**
   * Where this Mac's version is published for a Mac, with its SHA-256, and
   * when the link stops working, in milliseconds since 1970: the command
   * downloads it there first. Absent for a development or unpublished
   * version, which the command gets from this Mac.
   */
  download?: UpdateDownload & { expiresAt: number };
};

/**
 * What a command keeps of its link's thirty minutes for getting Firstmate from
 * this Mac instead of its download (INF-369 F2, the captain's choice: time
 * sized to the copy, so a slow network still finishes): a minute to unpack
 * it and join, plus the time a copy of the download's stated size needs at
 * `SLOW_COPY_BYTES_PER_SECOND` - the copy from here is the same app,
 * compressed alike. Its download stops once less is left (`MAC_DOWNLOAD`'s
 * `$5` and `$6`).
 */
const JOIN_SECONDS = 60;
/** The slowest copy from this Mac the reserve allows for: 1 MB a second, as on a phone's hotspot. */
const SLOW_COPY_BYTES_PER_SECOND = 1024 * 1024;

/** The command for a link: the words a person pastes into Terminal. */
export function joinCommand(input: JoinCommandInput): string {
  if (input.for === "another-user")
    return [input.launcher.executable, ...input.launcher.args, "work", "join", input.link]
      .map(shellWord)
      .join(" ");
  const link = parsePairingLink(input.link);
  const targets = linkAddresses(link);
  const host = splitDialAddress(targets[0] ?? link.at)?.host ?? link.at;
  const values = [
    input.link,
    input.homeName,
    targets[0] ?? link.at,
    host,
    // curl's pin: SHA-256 of the home's public key, in standard base64.
    `sha256//${Buffer.from(link.key, "base64url").toString("base64")}`,
    link.code,
    // Where to download it, and until when; empty words when it gets it from here.
    input.download?.url ?? "",
    input.download?.sha256 ?? "",
    input.download ? String(Math.floor(input.download.expiresAt / 1000) - JOIN_SECONDS) : "",
    ...targets.slice(1),
  ];
  return ["/bin/sh", "-c", MAC_SCRIPT, "firstmate", ...values].map(shellWord).join(" ");
}

/** A line of words for `printf` in the script, with `$N` and `$U` standing for this Mac's name and the user. */
function line(text: string): string {
  const quoted = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replaceAll(NAME, shellValue("N"))
    .replaceAll(USER, shellValue("U"))
    .replaceAll(HOST, shellValue("H"));
  return `"${quoted}"`;
}

/**
 * A value the script holds, braced: in a UTF-8 Terminal a letter right after
 * a name, such as the ellipsis after this Mac's name, would otherwise be
 * read as part of the name.
 */
function shellValue(name: string): string {
  return `\${${name}}`;
}

function say(lines: readonly string[]): string {
  return lines.map((text) => `printf "%s\\n" ${line(text)}`).join("; ");
}

// Stand-ins the script fills from its values at run time.
const NAME = "\u0000name\u0000";
const USER = "\u0000user\u0000";
const HOST = "\u0000host\u0000";

const NOTHING_CHANGED = `Nothing changed on ${HERE.this}.`;

/**
 * The other computer's side, in order: check it runs a system Firstmate runs
 * on - a Mac, or Linux on x64 where the AppImage would keep Chromium's
 * sandbox on - check the home answers with its key, ask, get
 * Firstmate for that system, unpack it, join with it. `$1` is the link, `$2`
 * this computer's name, `$3` its address, `$4` its host for the words, `$5`
 * curl's pin and `$6` the link's code, which `FETCH_APP_PATH` reads and
 * never spends; `$7`, `$8` and `$9` are where this computer's version is
 * published for a Mac, its SHA-256, and when a copy from this computer must
 * be done by instead, in seconds since 1970 - empty when it is got from this
 * computer - and any later words are the link's other addresses.
 *
 * A Mac given a download asks the home first whether the code is still open
 * (`check`), then downloads and checks it there with `MAC_DOWNLOAD`, its
 * count rewritten in place, and stops after two minutes with nothing moving
 * or once what is left of the link is only what a copy from this computer
 * needs (`JOIN_SECONDS`); one that could not, or whose
 * download did not match, says so and gets it from this computer. A
 * request to this computer names the system and chip (`W`, `M`), so the
 * home answers the Firstmate for them (docs/devices.md, "Firstmate for
 * another system"): a Mac unpacks the home's gzipped tar, or the published
 * zip with its own ditto; Linux keeps the AppImage as it came. Nothing is
 * fetched, written or sent before the yes; a refusal says what happened and
 * that nothing changed, and what was unpacked is deleted whatever the join
 * answered.
 */
const MAC_SCRIPT = [
  'L="$1"; N="$2"; A="$3"; H="$4"; P="$5"; C="$6"; D="$7"; S="$8"; E="$9"; U="$(id -un)"; M="$(uname -m)"',
  // Firstmate runs on a Mac, and on Linux with an x64 chip: any other computer stops here.
  `case "$(uname -s)" in Darwin) K=/usr/bin/curl; W=macos; if [ "$M" = arm64 ]; then M=arm64; else M=x64; fi;; Linux) K="$(command -v curl)"; W=linux; case "$M" in x86_64|amd64) M=x64;; *) ${say(otherSystem())}; exit 1;; esac;; *) ${say(otherSystem())}; exit 1;; esac`,
  // Linux gets the AppImage, whose own launcher would start it with Chromium's
  // sandbox off where this user cannot make a user namespace; nobody is there
  // to ask each time its work starts, so it stops here, as the look does.
  `if [ "$W" = linux ] && ! ${SANDBOX_PROBE}; then ${say(sandboxOff(NAME))}; exit 1; fi`,
  `if [ -z "$K" ]; then ${say(needsCurl(NAME))}; exit 1; fi`,
  // The system's own curl, which checks the pin itself; the home offers only
  // TLS 1.3, and the system's own certificate list is never asked (-k).
  'k() { "$K" -sS --proto "=https" -k --pinnedpubkey "$P" --connect-timeout 10 "$@"; }',
  'k -o /dev/null "https://$A/" 2>/dev/null; r=$?',
  // The first address did not answer: try each later one the link carries, and keep the first that does.
  'if [ "$r" != 0 ]; then bad=$r; shift 9; while [ $# -gt 0 ]; do A="$1"; H="${1%%:*}"; k -o /dev/null "https://$A/" 2>/dev/null; r=$?; if [ "$r" = 0 ]; then bad=0; break; fi; if [ "$r" = 90 ]; then bad=90; fi; shift; done; r=$bad; fi',
  `if [ "$r" = 90 ]; then ${say([`Something answered at ${HOST}, but not the ${COMPUTER.one} that made this command.`, "Nothing was sent to it."])}; exit 1; fi`,
  `if [ "$r" != 0 ]; then ${say([`Could not reach ${NAME} at ${HOST}.`, `Both ${COMPUTER.many} need the same network, or the same private network.`])}; exit 1; fi`,
  say(macAsk(NAME, USER)),
  'printf "%s" "Type yes to agree: "; read -r a || a=""',
  `if [ "$a" != yes ]; then ${say([NOTHING_CHANGED])}; exit 1; fi`,
  // Linux keeps the copy in this user's own cache, never a shared /tmp, which may forbid running it.
  'if [ "$W" = linux ]; then G="${XDG_CACHE_HOME:-$HOME/.cache}"; mkdir -p "$G" && T="$(mktemp -d "$G/firstmate-XXXXXX")" || exit 1; else T="$(mktemp -d)" || exit 1; fi',
  // Stopped part way, as by Control-C, it leaves nothing it fetched.
  `trap 'rm -rf "$T"; exit 1' HUP INT TERM`,
  // What the home answered for a code it would not take, said as words, with nothing kept.
  `refused() { if grep -q "\\"used\\"" "$T/f" 2>/dev/null; then ${say(commandUsed(NAME))}; elif grep -q "\\"expired\\"" "$T/f" 2>/dev/null; then if [ -n "$D" ]; then ${say(commandExpired(NAME, DOWNLOAD_COMMAND_LINK_TTL_MS))}; else ${say(commandExpired(NAME))}; fi; elif [ "$1" = 401 ]; then ${say(commandClosed(NAME))}; else ${say([`Could not get Infinitary from ${NAME}.`, NOTHING_CHANGED])}; fi; rm -rf "$T"; exit 1; }`,
  // A size in the words a file's chip uses, as fileSizeWords says it.
  `z() { awk -v n="$1" 'BEGIN { if (n < 1024) printf "%d B", n; else if (n < 1048576) { k = int(n / 1024 + 0.5); if (k < 1) k = 1; printf "%d KB", k } else if (n < 1073741824) printf "%.1f MB", n / 1048576; else printf "%.1f GB", n / 1073741824 }'; }`,
  'B=""',
  // Each element is a whole command: a line that ends in "then" takes the next command with it.
  `if [ "$W" = macos ] && [ -n "$D" ]; then s="$(printf "{\\"code\\":\\"%s\\",\\"check\\":true}" "$C" | k -o "$T/f" -w "%{http_code}" -H "Content-Type: application/json" --data-binary @- "https://$A${FETCH_APP_PATH}")"`,
  'if [ "$s" != 204 ]; then refused "$s"; fi',
  `printf "%s" ${line(COMMAND_DOWNLOADING)}`,
  // Each count rewrites the line; the first, with nothing yet and no size, says nothing.
  `{ /bin/sh -c ${shellWord(oneLine(MAC_DOWNLOAD))} infinitary "$T" "$S" "$D" ${DOWNLOAD_IDLE_SECONDS} "$E" ${SLOW_COPY_BYTES_PER_SECOND} 2>/dev/null; echo "$?" > "$T/e"; } | while IFS= read -r l; do case "$l" in infinitary:download=*) set -- \${l#infinitary:download=}; if [ "$1" -gt 0 ] || [ "$2" -gt 0 ]; then if [ "$2" -gt 0 ] && [ "$1" -le "$2" ]; then w="$(z "$1") of $(z "$2")"; else w="$(z "$1") so far"; fi; printf "\\r\\033[K%s %s" ${line(COMMAND_DOWNLOADING)} "$w"; fi;; esac; done`,
  'e="$(cat "$T/e" 2>/dev/null)"',
  `if [ "$e" = 0 ]; then echo ", done."; B="$(ls -d "$T"/*.app | head -n 1)"; elif [ "$e" = 7 ]; then echo; ${say([commandDownloadFallback(NAME, true)])}; else echo; ${say([commandDownloadFallback(NAME, false)])}; fi`,
  "fi",
  `if [ -z "$B" ]; then printf "%s" ${line(`Getting Infinitary from ${NAME}… `)}`,
  `s="$(printf "{\\"code\\":\\"%s\\",\\"system\\":\\"%s\\",\\"chip\\":\\"%s\\"}" "$C" "$W" "$M" | k -o "$T/f" -w "%{http_code}" -H "Content-Type: application/json" --data-binary @- "https://$A${FETCH_APP_PATH}")"`,
  'if [ "$s" != 200 ]; then echo; refused "$s"; fi',
  `if [ "$W" = linux ]; then B="$T/${LINUX_APP_FILE}"; mv "$T/f" "$B" && chmod 0700 "$B" || { echo; ${say([`Could not get Infinitary from ${NAME}.`, NOTHING_CHANGED])}; rm -rf "$T"; exit 1; }; echo "done."`,
  `else if [ "$(head -c 2 "$T/f")" = PK ]; then /usr/bin/ditto -x -k "$T/f" "$T"; else tar -xzf "$T/f" -C "$T"; fi || { echo; ${say([`Could not get Infinitary from ${NAME}.`, NOTHING_CHANGED])}; rm -rf "$T"; exit 1; }`,
  'rm -f "$T/f"; echo "done."',
  'B="$(ls -d "$T"/*.app | head -n 1)"; fi',
  "fi",
  'if [ "$W" = linux ]; then X="$B"; else X="$B/Contents/MacOS/$(basename "$B" .app)"; fi',
  '"$X" work join --fetched "$B" "$L"; r=$?',
  'rm -rf "$T"; exit "$r"',
].join("; ");

/**
 * This app as it sends itself to a computer of its own system: on a Mac the
 * installed bundle this runs from, `<name>.app` three folders above its
 * executable; on Linux the AppImage file it runs from (`appImage`), since a
 * Linux package cannot be sent whole. A development run has none unless
 * `INFINITARY_APP_BUNDLE` names one, as a test's stand-in does.
 */
export function appBundleOf(input: {
  packaged: boolean;
  executable: string;
  env: NodeJS.ProcessEnv;
  /** The AppImage file an installed Linux app runs from, if it is one. */
  appImage?: string | null;
}): string | null {
  if (!input.packaged) return settingFrom(input.env, "APP_BUNDLE")?.trim() || null;
  if (input.appImage?.endsWith(".AppImage")) return input.appImage;
  const bundle = dirname(dirname(dirname(input.executable)));
  return bundle.endsWith(".app") ? bundle : null;
}
