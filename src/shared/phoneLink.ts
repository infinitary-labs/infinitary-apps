import { z } from "zod";
import { PAIRING_LINK_PREFIX } from "./devices";

/**
 * Joining a home from the phone by its address (docs/ios.md, "Joining by its
 * address"; docs/devices.md, "A phone that joins by its address"): the phone
 * signs in to the home over SSH and runs one of these fixed commands there.
 * The phone carries them as `scripts/generate-phone-contract.ts` writes them
 * into its generated Swift, so the home's door and the phone read one text.
 *
 * Each command is one line for whatever login shell the account has - sh,
 * bash, zsh, fish or csh - so the script inside its single quotes holds no
 * single quote, no backslash, no `!` and no newline, and runs under
 * `/bin/sh`. Every value it names is its own quoted word after it.
 */

/** The first word of every answer line the phone reads. */
export const PHONE_LINK_HEADER = "infinitary-phone-link";

/**
 * The comment that ends a phone's key line in this computer's
 * `authorized_keys`, as the phone writes it (`PhoneSSHKey.line` in the iOS
 * app); a reset finds the lines phones placed by it.
 */
export const PHONE_KEY_COMMENT = "infinitary-phone";

/** The door's own version, the second word: a phone reads only this one. */
export const PHONE_LINK_VERSION = "1";

/**
 * What an answer says after the header and the version: `link <link>`, or
 * `none <why>`. Each `why` is the home's own finding, which the phone words.
 */
export const PHONE_LINK_NONE = {
  /** No Infinitary is open for this account there. */
  notOpen: "not-open",
  /** An Infinitary is open there that has no door: it is older than this phone. */
  tooOld: "too-old",
  /** A Linux home with no curl, which the door is asked with. */
  noCurl: "no-curl",
  /** The door answered but made no link, as when the saved device list is unreadable. */
  refused: "refused",
} as const;

/** The door's request path on its loopback port. */
export const PHONE_DOOR_PATH = "/phone-link";

/**
 * The same door answers this account's own `infinitary link` (docs/run.md,
 * "A link by command") at this path: `?for=computer` or `?for=phone`, with
 * the same key. Its answer is JSON, `linkCommandAnswerSchema`.
 */
export const LINK_COMMAND_PATH = "/link";

/** What `infinitary link` asks the door for: a computer's link, or a phone's. */
export const linkCommandForSchema = z.enum(["computer", "phone"]);
export type LinkCommandFor = z.infer<typeof linkCommandForSchema>;

/**
 * The door's answer to `infinitary link`: the link pairing made and when it
 * expires, or, with 503, why pairing made none, in pairing's own words.
 */
export const linkCommandAnswerSchema = z.union([
  z.strictObject({
    link: z.string().startsWith(PAIRING_LINK_PREFIX),
    expiresAt: z.number().int().nonnegative(),
  }),
  z.strictObject({ refused: z.string().min(1) }),
]);
export type LinkCommandAnswer = z.infer<typeof linkCommandAnswerSchema>;

/** The header the door's key travels in, as the one line of its key file. */
export const PHONE_DOOR_KEY_HEADER = "x-infinitary-phone-key";

/** The door's two files, in its folder (`AppPaths.phoneDoorDir`). */
export const PHONE_DOOR_FILES = { address: "address", key: "key" } as const;

/** The door's folder, under each data folder the command looks in. */
export const PHONE_DOOR_FOLDER = "phone-door";

/**
 * Where an account's Infinitary keeps its data: the folder this app was told
 * to use, then the release's and a development run's, on a Mac and on Linux.
 * Firstmate 3000's are only looked at for a running app that is too old.
 */
const DATA_FOLDERS = [
  '"$INFINITARY_USER_DATA_DIR"',
  '"$HOME/Library/Application Support/infinitary"',
  '"${XDG_CONFIG_HOME:-$HOME/.config}/infinitary"',
  '"$HOME/.config/infinitary"',
  '"$HOME/Library/Application Support/infinitary-dev"',
  '"${XDG_CONFIG_HOME:-$HOME/.config}/infinitary-dev"',
];
const OLDER_FOLDERS = [
  '"$HOME/Library/Application Support/firstmate-3000"',
  '"$HOME/.config/firstmate-3000"',
];

const say = (words: string) => `echo "$h ${PHONE_LINK_VERSION} ${words}"`;

/**
 * Asks the open Infinitary there for a one-use phone link through its door,
 * with the system's own curl, and prints one answer line. With no door it
 * reads the single-instance lock Chromium keeps in an app's data folder
 * (`SingletonLock`, a link to `<host>-<pid>`): a running app with no door is
 * too old, and no running app is not open.
 */
const LINK_SCRIPT = [
  `h=${PHONE_LINK_HEADER}`,
  `set -- ${DATA_FOLDERS.join(" ")}`,
  "d=",
  `for c do if [ -n "$c" ] && [ -r "$c/${PHONE_DOOR_FOLDER}/${PHONE_DOOR_FILES.key}" ] && [ -r "$c/${PHONE_DOOR_FOLDER}/${PHONE_DOOR_FILES.address}" ]; then d=$c; break; fi; done`,
  `if [ -z "$d" ]; then for c in "$@" ${OLDER_FOLDERS.join(" ")}; do l=$(readlink "$c/SingletonLock" 2>/dev/null) && [ -n "$c" ] && kill -0 "\${l##*-}" 2>/dev/null && { ${say(`none ${PHONE_LINK_NONE.tooOld}`)}; exit 0; }; done; ${say(`none ${PHONE_LINK_NONE.notOpen}`)}; exit 0; fi`,
  `read -r a < "$d/${PHONE_DOOR_FOLDER}/${PHONE_DOOR_FILES.address}"`,
  `case $a in 127.0.0.1:*) ;; *) ${say(`none ${PHONE_LINK_NONE.notOpen}`)}; exit 0 ;; esac`,
  "u=/usr/bin/curl",
  `[ -x "$u" ] || u=$(command -v curl) || { ${say(`none ${PHONE_LINK_NONE.noCurl}`)}; exit 0; }`,
  // -q first: no ~/.curlrc may add options to this request.
  `r=$("$u" -q -s --noproxy "*" --max-time 30 -X POST -H "@$d/${PHONE_DOOR_FOLDER}/${PHONE_DOOR_FILES.key}" "http://$a${PHONE_DOOR_PATH}") || { ${say(`none ${PHONE_LINK_NONE.notOpen}`)}; exit 0; }`,
  'echo "$r"',
].join("; ");

/**
 * Adds `$1`, the phone's own public key line, to that account's
 * `authorized_keys` once, making the folder and the file only that account
 * may change, then says so. It is the one command a password signs in for.
 */
const PLACE_SCRIPT = [
  `h=${PHONE_LINK_HEADER}`,
  "umask 077",
  'S="$HOME/.ssh"',
  'F="$S/authorized_keys"',
  'mkdir -p "$S" || exit 3',
  'chmod go-w "$S" 2>/dev/null',
  'touch "$F" || exit 3',
  'chmod go-w "$F" 2>/dev/null',
  'grep -qxF -- "$1" "$F" || { if [ -s "$F" ] && [ -n "$(tail -c 1 "$F")" ]; then echo >> "$F" || exit 3; fi; echo "$1" >> "$F" || exit 3; }',
  say("placed"),
].join("; ");

/**
 * Joining a home from another computer's first launch by its address
 * (docs/view.md, "Joining by its address"): that computer signs in over SSH
 * and runs this script there, which asks the open Infinitary's door for a
 * one-use computer link, the request `infinitary link` makes. It finds the
 * door as the phone's does; with none, a running app that controls another
 * computer (its `joined/home.json`) says so, any other running app is too
 * old, and none is not open. The door's answer follows `answer` with its
 * status last, which `readComputerLinkAnswer` reads.
 */
export const COMPUTER_LINK_HEADER = "infinitary-computer-link";

export const COMPUTER_LINK_NONE = {
  ...PHONE_LINK_NONE,
  /** The Infinitary open there controls another computer, so it has no door. */
  controls: "controls",
} as const;

const sayComputer = (words: string) => `echo "$h ${PHONE_LINK_VERSION} ${words}"`;

const COMPUTER_LINK_SCRIPT_TEXT = [
  `h=${COMPUTER_LINK_HEADER}`,
  `set -- ${DATA_FOLDERS.join(" ")}`,
  "d=",
  `for c do if [ -n "$c" ] && [ -r "$c/${PHONE_DOOR_FOLDER}/${PHONE_DOOR_FILES.key}" ] && [ -r "$c/${PHONE_DOOR_FOLDER}/${PHONE_DOOR_FILES.address}" ]; then d=$c; break; fi; done`,
  `if [ -z "$d" ]; then for c in "$@" ${OLDER_FOLDERS.join(" ")}; do l=$(readlink "$c/SingletonLock" 2>/dev/null) && [ -n "$c" ] && kill -0 "\${l##*-}" 2>/dev/null && { [ -e "$c/joined/home.json" ] && { ${sayComputer(`none ${COMPUTER_LINK_NONE.controls}`)}; exit 0; }; ${sayComputer(`none ${COMPUTER_LINK_NONE.tooOld}`)}; exit 0; }; done; ${sayComputer(`none ${COMPUTER_LINK_NONE.notOpen}`)}; exit 0; fi`,
  `read -r a < "$d/${PHONE_DOOR_FOLDER}/${PHONE_DOOR_FILES.address}"`,
  `case $a in 127.0.0.1:*) ;; *) ${sayComputer(`none ${COMPUTER_LINK_NONE.notOpen}`)}; exit 0 ;; esac`,
  "u=/usr/bin/curl",
  `[ -x "$u" ] || u=$(command -v curl) || { ${sayComputer(`none ${COMPUTER_LINK_NONE.noCurl}`)}; exit 0; }`,
  // -q first: no ~/.curlrc may add options to this request.
  `r=$("$u" -q -s --noproxy "*" --max-time 30 -X POST -H "@$d/${PHONE_DOOR_FOLDER}/${PHONE_DOOR_FILES.key}" -w " %{http_code}" "http://$a${LINK_COMMAND_PATH}?for=computer") || { ${sayComputer(`none ${COMPUTER_LINK_NONE.notOpen}`)}; exit 0; }`,
  `echo "$h ${PHONE_LINK_VERSION} answer $r"`,
].join("; ");

for (const script of [LINK_SCRIPT, PLACE_SCRIPT, COMPUTER_LINK_SCRIPT_TEXT])
  if (/['\\!\n]/.test(script))
    throw new Error("A phone's fixed command must suit every login shell.");

export const PHONE_LINK_COMMAND = `/bin/sh -c '${LINK_SCRIPT}'`;

/**
 * The command the phone runs, signed in with the password, to let its own
 * key in; the phone adds its key line as one more single-quoted word.
 */
export const PHONE_PLACE_KEY_COMMAND = `/bin/sh -c '${PLACE_SCRIPT}' ${PHONE_LINK_HEADER}`;

/** The answer line the place command prints once the key is in. */
export const PHONE_KEY_PLACED = `${PHONE_LINK_HEADER} ${PHONE_LINK_VERSION} placed`;

/**
 * The computer link script's words for `/bin/sh -c`: the remote command a
 * computer runs over SSH, each word quoted for whatever login shell the
 * account has.
 */
export const COMPUTER_LINK_COMMAND: readonly string[] = [
  "/bin/sh",
  "-c",
  COMPUTER_LINK_SCRIPT_TEXT,
];

export type ComputerLinkNone =
  | (typeof COMPUTER_LINK_NONE)[keyof typeof COMPUTER_LINK_NONE]
  | "unreadable";

/**
 * What the computer link script printed: the link, or why there is none. A
 * door with no `/link` answers 404, which is too old; pairing's own refusal
 * (503) and any other answer made no link.
 */
export function readComputerLinkAnswer(
  stdout: string,
): { link: string } | { none: ComputerLinkNone } {
  const header = `${COMPUTER_LINK_HEADER} ${PHONE_LINK_VERSION} `;
  const at = stdout.indexOf(header);
  if (at < 0) return { none: "unreadable" };
  const said = stdout.slice(at + header.length);
  const none = /^none ([a-z-]+)\s*$/.exec(said)?.[1];
  if (none !== undefined) {
    const known = Object.values(COMPUTER_LINK_NONE) as string[];
    return { none: known.includes(none) ? (none as ComputerLinkNone) : "unreadable" };
  }
  const answer = /^answer ([\s\S]*?)\s*([0-9]{3})\s*$/.exec(said);
  if (!answer) return { none: "unreadable" };
  const status = answer[2];
  if (status === "404") return { none: COMPUTER_LINK_NONE.tooOld };
  if (status !== "200") return { none: COMPUTER_LINK_NONE.refused };
  try {
    const parsed = linkCommandAnswerSchema.safeParse(JSON.parse(answer[1] ?? ""));
    if (parsed.success && "link" in parsed.data) return { link: parsed.data.link };
  } catch {
    // Not JSON: no link.
  }
  return { none: "unreadable" };
}
