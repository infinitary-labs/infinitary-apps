import { shellWord } from "./shellWord";

export { shellWord } from "./shellWord";

import { dirname } from "node:path";
import { FETCH_APP_PATH, FETCH_APP_SHA256_HEADER } from "@shared/connection";
import { COMPUTER, HERE } from "@shared/deviceNames";
import {
  type DeviceCommandFor,
  DOWNLOAD_COMMAND_LINK_TTL_MS,
  linkAddresses,
  parsePairingLink,
  splitDialAddress,
} from "@shared/devices";
import { settingFrom } from "@shared/envSettings";
import { LINUX_NEEDS, type LinuxInstaller } from "@shared/remoteLogin";
import type { UpdateDownload } from "@shared/work";
import {
  afterLogout,
  COMMAND_DOWNLOADING,
  COMMAND_INSTALLING,
  commandCannotInstall,
  commandClosed,
  commandDownloadFallback,
  commandExpired,
  commandInstallFailed,
  commandNeeds,
  commandNothingToSend,
  commandUsed,
  lingerStays,
  macAsk,
  needsCurl,
  otherSystem,
  otherVersion,
  sandboxOff,
} from "../helper/words";
import { LINUX_APP_FILE, LINUX_TOOL_NEEDS, SANDBOX_PROBE } from "./farSystems";
import { DOWNLOAD_IDLE_SECONDS, MAC_DOWNLOAD, oneLine } from "./remoteDownload";
import { UBUNTU_PACKAGE_BIN, UBUNTU_PACKAGE_RELEASES } from "./ubuntuPackage";

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
 *   Macs then run the same version and need only the same network. On Linux
 *   it joins with an Infinitary installed there, or installs the Ubuntu
 *   package first on Ubuntu 24.04 and 26.04, before it gets the AppImage
 *   (INF-1181).
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
  /**
   * This computer's version, which an Infinitary already installed on a
   * Linux computer must be to join with it (captain's pick on INF-1181).
   */
  version: string;
  /**
   * The one line that updates an Ubuntu package there to this computer's
   * version (`linuxUpdateCommand`), when this version's package is published;
   * absent, the command names the version alone.
   */
  update?: string;
  /**
   * Where a Linux computer says its release and keeps the Ubuntu package's
   * program: the system's own, unless a test stands in its own.
   */
  linux?: { osRelease?: string; packageBin?: string };
};

/** The line each Linux installer installs packages with, the command naming what it needs after it. */
const INSTALL_LINES: Readonly<Record<LinuxInstaller, string>> = {
  apt: "sudo apt-get install -y",
  dnf: "sudo dnf install -y",
  pacman: "sudo pacman -S --needed",
  zypper: "sudo zypper install",
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
    input.version,
    input.update ?? "",
    input.linux?.osRelease ?? "/etc/os-release",
    input.linux?.packageBin ?? UBUNTU_PACKAGE_BIN,
    // The fixed script that finds what Linux lacks, as a value so it is quoted once.
    LINUX_NEEDS_SCRIPT,
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
    .replaceAll(HOST, shellValue("H"))
    .replaceAll(VERSION, shellValue("V"))
    .replaceAll(WHAT, shellValue("Z"));
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
const VERSION = "\u0000version\u0000";
/** What a Linux line names at run time: the packages it lacks, or the line that installs them. */
const WHAT = "\u0000what\u0000";

const NOTHING_CHANGED = `Nothing changed on ${HERE.this}.`;

/**
 * `nm <need> <installer>` sets `n` to the package a Linux computer installs
 * for that need, as the refusal for adding it by its address names it
 * (`LINUX_NEEDS`): `apt64` is apt where libraries take Debian's 64-bit time
 * names, and no installer names what it needs in words.
 */
const NEED_NAMES = `nm() { case "$2:$1" in ${needArms()} *) n="$1";; esac; }`;

/**
 * `nm`'s arms: for each need, the installers that name its package alike, in
 * one arm (`apt*` for apt either way), and then the need's own words for any
 * other, which an installer naming the same needs no arm for.
 */
function needArms(): string {
  const word = (name: string) => (/^[A-Za-z0-9._+-]+$/.test(name) ? name : `"${name}"`);
  const specific: string[] = [];
  const any: string[] = [];
  for (const [need, names] of Object.entries(LINUX_NEEDS)) {
    const t64 = "t64" in names ? names.t64 : names.apt;
    const byName = new Map<string, string[]>();
    const add = (pattern: string, name: string) => {
      if (name !== names.any) byName.set(name, [...(byName.get(name) ?? []), `${pattern}:${need}`]);
    };
    if (t64 !== names.apt) add("apt64", t64);
    add(t64 === names.apt ? "apt*" : "apt", names.apt);
    for (const installer of ["dnf", "pacman", "zypper"] as const) add(installer, names[installer]);
    for (const [name, patterns] of byName)
      specific.push(`${patterns.join("|")}) n=${word(name)};;`);
    any.push(`*:${need}) n=${word(names.any)};;`);
  }
  return [...specific, ...any].join(" ");
}

/** The words for an installed Infinitary of another version, with the line that updates it; said in parts. */
const OTHER_VERSION = otherVersion(NAME, VERSION, WHAT);

/**
 * A script of many lines as one word `printf %b` gives back whole, so the
 * command stays one line: each backslash doubled, each line break `\\n`.
 */
function printable(script: string): string {
  return script.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/**
 * What root runs to install the Ubuntu package this computer sent, `$1`, and
 * keep `$2`'s work on after they log out, as adding the computer by its
 * address does (`INSTALL_AS_ROOT`). The package came over the link's pinned
 * connection with its SHA-256, `$3`, in `FETCH_APP_SHA256_HEADER`; the user's
 * copy can change while sudo asks the password, so root copies it into a
 * folder only root writes and installs that copy only if it matches. Where
 * systemd does not run, linger fails and the install still stands: the
 * command names the sudo line after it joins.
 */
const UBUNTU_INSTALL =
  'd="$(mktemp -d)" || exit 1; chmod 755 "$d"; cp "$1" "$d/i.deb" && printf "%s  %s\\n" "$3" "$d/i.deb" | sha256sum -c --status && DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$d/i.deb"; r=$?; rm -rf "$d"; [ "$r" = 0 ] || exit "$r"; loginctl enable-linger "$2" 2>/dev/null || :';

/** What a Linux computer lacks for the AppImage, as one word the command's `printf %b` gives back. */
const LINUX_NEEDS_SCRIPT = printable(LINUX_TOOL_NEEDS.join("\n"));

/** The arms that set `x` to the line that installs packages with that computer's installer. */
const INSTALL_CASES = Object.entries(INSTALL_LINES)
  .map(
    ([installer, install]) => `${installer === "apt" ? "apt|apt64" : installer}) x="${install}";;`,
  )
  .join(" ");

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
 * computer - `${10}` this computer's version, `${11}` the line that updates
 * an Ubuntu package there to it, or empty, `${12}` the file a Linux computer
 * says its release in and `${13}` the Ubuntu package's program, and any
 * `${14}` the fixed script that finds what Linux lacks for the AppImage, as
 * `printf %b` reads it, and any later words are the link's other addresses.
 *
 * On Linux it first looks for an Infinitary installed there, which joins by
 * itself when it is this computer's version and stops with the line that
 * updates it when not; on Ubuntu 24.04 and 26.04 with none, after the yes it
 * gets the Ubuntu package from this computer and installs it with sudo, as
 * adding the computer by its address does; any other Linux names what the
 * AppImage and its work lack before it asks, and gets the AppImage. A Linux
 * computer that joined keeps its work running after its user logs out where
 * systemd lets that user say so, or names the one line that does.
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
  'L="$1"; N="$2"; A="$3"; H="$4"; P="$5"; C="$6"; D="$7"; S="$8"; E="$9"; V="${10}"; Q="${11}"; R="${12}"; O="${13}"; U="$(id -un)"; M="$(uname -m)"',
  // Firstmate runs on a Mac, and on Linux with an x64 chip: any other computer stops here.
  `case "$(uname -s)" in Darwin) K=/usr/bin/curl; W=macos; if [ "$M" = arm64 ]; then M=arm64; else M=x64; fi;; Linux) K="$(command -v curl)"; W=linux; case "$M" in x86_64|amd64) M=x64;; *) ${say(otherSystem())}; exit 1;; esac;; *) ${say(otherSystem())}; exit 1;; esac`,
  // Whether the account's programs keep running after it logs out.
  'lg() { loginctl show-user "$U" --property=Linger --value 2>/dev/null; }',
  // Joins with the program and words given, then the link. After a Linux
  // computer joined with its work in the background (the join's own outcome,
  // written where `--background` names): it stays on after this user logs out
  // where systemd lets this user say so, or it names the one line that does.
  `j() { b="$(mktemp 2>/dev/null)"; "$@" \${b:+--background "$b"} "$L"; r=$?; o="$(cat "$b" 2>/dev/null)"; [ -n "$b" ] && rm -f "$b"; if [ "$r" = 0 ] && [ "$W" = linux ] && { [ "$o" = running ] || [ "$o" = at-login ]; } && command -v loginctl >/dev/null 2>&1; then if [ "$(lg)" = yes ] || loginctl enable-linger --no-ask-password "$U" >/dev/null 2>&1; then ${say(afterLogout(USER, true))}; else ${say(afterLogout(USER, false))}; fi; fi; }`,
  // An Infinitary installed on Linux - the Ubuntu package's program, or one on
  // the search path - joins by itself, asking its own yes, with nothing got
  // from this computer; one of another version stops with the line that
  // updates it (captain's picks on INF-1181).
  'I=""; if [ "$W" = linux ]; then if [ -x "$O" ]; then I="$O"; else I="$(command -v infinitary 2>/dev/null)"; fi; fi',
  `if [ -n "$I" ]; then v="$("$I" work version 2>/dev/null | head -n 1)"; v="\${v#Infinitary }"; v="\${v%% *}"; if [ "$v" != "$V" ]; then ${say(OTHER_VERSION.slice(0, 1))}; if [ -n "$Q" ] && command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W infinitary >/dev/null 2>&1; then Z="$Q"; ${say(OTHER_VERSION.slice(1, -1))}; else ${say(otherVersion(NAME, VERSION, null).slice(1, -1))}; fi; ${say(OTHER_VERSION.slice(-1))}; exit 1; fi; j "$I" work join; exit "$r"; fi`,
  // Ubuntu 24.04 and 26.04 with none get the Ubuntu package, which keeps the
  // sandbox on and brings git and Xvfb, and install it with sudo, as adding
  // the computer by its address does; an account that may not stops here.
  `Y=""; if [ "$W" = linux ] && [ -r "$R" ]; then i="$(sed -n 's/^ID=//p' "$R" | head -n 1 | tr -d '"')"; j="$(sed -n 's/^VERSION_ID=//p' "$R" | head -n 1 | tr -d '"')"; if [ "$i" = ubuntu ]; then case "$j" in ${UBUNTU_PACKAGE_RELEASES.join("|")}) Y=1;; esac; fi; fi`,
  `if [ -n "$Y" ]; then if ! command -v sudo >/dev/null 2>&1; then ${say(commandCannotInstall())}; exit 1; fi; if ! sudo -n true >/dev/null 2>&1; then case "$(LC_ALL=C sudo -n true 2>&1)" in *"a password is required"*) ;; *) ${say(commandCannotInstall())}; exit 1;; esac; fi`,
  // Any other Linux gets the AppImage, whose own launcher would start it with
  // Chromium's sandbox off where this user cannot make a user namespace;
  // nobody is there to ask each time its work starts, so it stops here, as
  // the look does. Then it names what the AppImage and its work lack, with
  // the line that installs them, before it asks.
  `elif [ "$W" = linux ]; then if ! ${SANDBOX_PROBE}; then ${say(sandboxOff())}; exit 1; fi`,
  `F="$(printf "%b" "\${14}" | /bin/sh 2>/dev/null)"`,
  NEED_NAMES,
  `J="$(printf "%s\\n" "$F" | sed -n 's/^infinitary:installer=//p' | head -n 1)"; if [ "$J" = apt ] && printf "%s\\n" "$F" | grep -q '^infinitary:t64=yes$'; then J=apt64; fi`,
  `Z=""; for n in $(printf "%s\\n" "$F" | sed -n 's/^infinitary:needs=//p'); do nm "$n" "$J"; case "|$Z|" in *"|$n|"*) ;; *) Z="\${Z:+$Z|}$n";; esac; done`,
  `if [ -n "$Z" ]; then x=""; case "$J" in ${INSTALL_CASES} esac; if [ -n "$x" ]; then Z="$x $(printf "%s" "$Z" | sed 's/|/ /g')"; ${say(commandNeeds(NAME, "", WHAT))}; else Z="$(printf "%s" "$Z" | sed 's/|/, /g')"; ${say(commandNeeds(NAME, WHAT, null))}; fi; exit 1; fi`,
  "fi",
  `if [ -z "$K" ]; then ${say(needsCurl(NAME))}; exit 1; fi`,
  // The system's own curl, which checks the pin itself; the home offers only
  // TLS 1.3, and the system's own certificate list is never asked (-k).
  'k() { "$K" -sS --proto "=https" -k --pinnedpubkey "$P" --connect-timeout 10 "$@"; }',
  'k -o /dev/null "https://$A/" 2>/dev/null; r=$?',
  // The first address did not answer: try each later one the link carries, and keep the first that does.
  'if [ "$r" != 0 ]; then bad=$r; shift 14; while [ $# -gt 0 ]; do A="$1"; H="${1%%:*}"; k -o /dev/null "https://$A/" 2>/dev/null; r=$?; if [ "$r" = 0 ]; then bad=0; break; fi; if [ "$r" = 90 ]; then bad=90; fi; shift; done; r=$bad; fi',
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
  `refused() { if grep -q "\\"used\\"" "$T/f" 2>/dev/null; then ${say(commandUsed(NAME))}; elif grep -q "\\"expired\\"" "$T/f" 2>/dev/null; then if [ -n "$D" ]; then ${say(commandExpired(NAME, DOWNLOAD_COMMAND_LINK_TTL_MS))}; else ${say(commandExpired(NAME))}; fi; elif [ "$1" = 404 ]; then ${say(commandNothingToSend(NAME))}; elif [ "$1" = 401 ]; then ${say(commandClosed(NAME))}; else ${say([`Could not get Infinitary from ${NAME}.`, NOTHING_CHANGED])}; fi; rm -rf "$T"; exit 1; }`,
  // A size in the words a file's chip uses, as fileSizeWords says it.
  `z() { awk -v n="$1" 'BEGIN { if (n < 1024) printf "%d B", n; else if (n < 1048576) { k = int(n / 1024 + 0.5); if (k < 1) k = 1; printf "%d KB", k } else if (n < 1073741824) printf "%.1f MB", n / 1048576; else printf "%.1f GB", n / 1073741824 }'; }`,
  // Ubuntu gets the package from this computer, checks it again as root,
  // installs it, which turns linger on too, and joins with its program,
  // which asks nothing: the person said yes above.
  `if [ -n "$Y" ]; then printf "%s" ${line(`Getting Infinitary from ${NAME}… `)}`,
  `s="$(printf "{\\"code\\":\\"%s\\",\\"system\\":\\"linux\\",\\"chip\\":\\"%s\\",\\"package\\":\\"deb\\"}" "$C" "$M" | k -o "$T/f" -w "%{http_code} %header{${FETCH_APP_SHA256_HEADER}}" -H "Content-Type: application/json" --data-binary @- "https://$A${FETCH_APP_PATH}")"; h="\${s#* }"; s="\${s%% *}"`,
  'if [ "$s" != 200 ]; then echo; refused "$s"; fi',
  'F="$T/infinitary.deb"; mv "$T/f" "$F" || { echo; rm -rf "$T"; exit 1; }',
  'echo "done."',
  say([COMMAND_INSTALLING]),
  // Whether linger was on before, and every package's state, so a stop after says what the install left.
  `g="$(lg)"`,
  'x0="$(dpkg -l 2>/dev/null | cksum)"',
  `if ! sudo /bin/sh -c ${shellWord(UBUNTU_INSTALL)} firstmate "$F" "$U" "$h"; then if [ "$(dpkg -l 2>/dev/null | cksum)" = "$x0" ]; then ${say(commandInstallFailed())}; else ${say(commandInstallFailed("part").slice(0, 1))}; if dpkg -l infinitary 2>/dev/null | grep -q "^[a-z][^n]"; then ${say(commandInstallFailed("part").slice(1))}; else ${say(commandInstallFailed("needs").slice(1))}; fi; fi; rm -rf "$T"; exit 1; fi`,
  `rm -rf "$T"; j "$O" work join --agreed; if [ "$r" != 0 ] && [ "$g" != yes ] && [ "$(lg)" = yes ]; then ${say(lingerStays(USER))}; fi; exit "$r"`,
  "fi",
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
  'j "$X" work join --fetched "$B"',
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
