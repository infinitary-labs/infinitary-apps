import { CONNECTION_PORT } from "@shared/connection";
import { type CopyForm, type FarSystem, LINUX_APP_FILE } from "./farSystems";

/**
 * The shell that sets a first mate up on another computer over SSH, from
 * the welcome screen's Another computer (docs/first-launch.md, "Setting it
 * up from here"): the copy kept where this account keeps its
 * apps, then the copy's own `start-at-boot`, which starts a first mate
 * there with the record that account already has, or a fresh one. Each
 * script is fixed and names no value: values are quoted words after it.
 */

/** Where the copy is kept there: this account's own Applications folder, as on a Mac. */
// i18n-exempt: a shell script run on the other computer, never shown
const KEPT_FOLDER = 'K="$HOME/Applications"';

/**
 * Takes the copy on its input into a private folder beside where it is
 * kept, checked with the far system's own unpack (`$1` its SHA-256), then
 * moves it into place and says where as `infinitary:kept=<path>`. A copy
 * kept there before is replaced; the account's data is never touched.
 * Exit 3: no folder; 4: the copy did not arrive whole. Null for a form the
 * system does not take.
 */
export function homeReceive(far: FarSystem, form: CopyForm): string | null {
  const unpack = far.unpack[form];
  if (!unpack) return null;
  // i18n-exempt: a shell script run on the other computer, never shown
  const place =
    far.system === "macos"
      ? [
          'B=""',
          'for b in "$T"/*.app; do B="$b"; break; done',
          '[ -d "$B" ] || exit 4',
          'N="$K/$(basename "$B")"',
          'rm -rf "$N" && mv "$B" "$N" || exit 4',
        ]
      : [`N="$K/${LINUX_APP_FILE}"`, `mv -f "$T/${LINUX_APP_FILE}" "$N" || exit 4`];
  // i18n-exempt: a shell script run on the other computer, never shown
  return [
    'S="$1"',
    KEPT_FOLDER,
    'mkdir -p "$K" || exit 3',
    'T="$(mktemp -d "$K/.infinitary-XXXXXX")" || exit 3',
    "trap 'rm -rf \"$T\"' EXIT",
    "trap 'exit 5' HUP INT TERM",
    'set -- "$T" "$S"',
    // The far system's own unpack reads `$1` as the folder and `$2` as the checksum.
    "(",
    unpack,
    ") || exit 4",
    ...place,
    "printf 'infinitary:kept=%s\\n' \"$N\"",
  ].join("\n");
}

/**
 * Prints `infinitary:private=yes` when this computer has an IPv4 address on
 * a local or private network (as `dialNetwork` reads one: 10/8, 172.16/12,
 * 192.168/16, or Tailscale's 100.64/10), which a computer joining it dials.
 */
// i18n-exempt: a shell script run on the other computer, never shown
const PRIVATE_ADDRESS = [
  'A="$(ip -o -4 addr show 2>/dev/null || ifconfig 2>/dev/null)"',
  "if printf '%s\\n' \"$A\" | grep -Eq 'inet (10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.)'; then printf 'infinitary:private=yes\\n'; fi",
];

/**
 * Prints `infinitary:firewall=<name>` for the Linux firewall that may keep
 * this computer's other computers out, read as `firewallKeepsOut` reads it
 * there (src/core/devices/firewall.ts): ufw on, firewalld running without
 * the port open outside Fedora Workstation's zone, or NixOS's own.
 */
// i18n-exempt: a shell script run on the other computer, never shown
const FIREWALL = [
  "if grep -Eqi '^[[:space:]]*ENABLED[[:space:]]*=[[:space:]]*yes[[:space:]]*$' /etc/ufw/ufw.conf 2>/dev/null; then",
  "  printf 'infinitary:firewall=ufw\\n'",
  "elif command -v systemctl >/dev/null 2>&1; then",
  "  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld.service; then",
  `    if ! firewall-cmd --query-port=${CONNECTION_PORT}/tcp >/dev/null 2>&1 && [ "$(firewall-cmd --get-default-zone 2>/dev/null)" != FedoraWorkstation ]; then printf 'infinitary:firewall=firewalld\\n'; fi`,
  "  elif [ -e /etc/NIXOS ] && systemctl is-active --quiet firewall.service; then",
  "    printf 'infinitary:firewall=nixos\\n'",
  "  fi",
  "fi",
];

/**
 * Starts a first mate there with the program at `$1` (the kept app, or the
 * Ubuntu package's program): first what the welcome screen says of that
 * computer - a private address, its firewall, and on a Mac whether this
 * account is logged in, since its agent starts only in a logged-in session
 * - then `start-at-boot`, its exit as `infinitary:boot=<code>`, then on
 * Linux whether this account lingers. Exit 4: no program there.
 */
// i18n-exempt: a shell script run on the other computer, never shown
export const HOME_START = [
  'P="$1"',
  'O="$(uname -s 2>/dev/null)"',
  'case "$O" in',
  '  Darwin) X="$P/Contents/MacOS/$(basename "$P" .app)" ;;',
  '  *) X="$P" ;;',
  "esac",
  '[ -x "$X" ] || exit 4',
  ...PRIVATE_ADDRESS,
  'if [ "$O" = Darwin ]; then',
  "  launchctl print \"gui/$(id -u)\" >/dev/null 2>&1 || printf 'infinitary:login=no\\n'",
  "else",
  ...FIREWALL.map((line) => `  ${line}`),
  "fi",
  '"$X" start-at-boot </dev/null >/dev/null 2>&1',
  "printf 'infinitary:boot=%s\\n' \"$?\"",
  'if [ "$O" != Darwin ]; then',
  '  L="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"',
  "  [ \"$L\" = yes ] || printf 'infinitary:linger=off\\n'",
  "fi",
].join("\n");

/** The account a root sign-in makes there for the first mate. */
export const HOME_ACCOUNT = "infinitary";

/**
 * What root runs once the person agreed to make an account there: an
 * ordinary account named `$1` with a home folder, the keys root's own SSH
 * lets in added to its own, owned by it alone, and linger on so its first
 * mate runs before anyone logs in. An account of that name already there
 * is kept, and only the keys it lacks are added. Says
 * `infinitary:account=<name>` once it can sign in. Exit 6: no keys to carry.
 */
// i18n-exempt: a shell script run on the other computer, never shown
export const MAKE_ACCOUNT = [
  "set -eu",
  'U="$1"',
  '[ -s "$HOME/.ssh/authorized_keys" ] || exit 6',
  'id -u "$U" >/dev/null 2>&1 || useradd -m -s /bin/sh "$U"',
  'H="$(getent passwd "$U" | cut -d: -f6)"',
  '[ -n "$H" ] && [ -d "$H" ]',
  'mkdir -p "$H/.ssh"',
  'touch "$H/.ssh/authorized_keys"',
  'while IFS= read -r k; do [ -z "$k" ] || grep -qxF -- "$k" "$H/.ssh/authorized_keys" || printf \'%s\\n\' "$k" >> "$H/.ssh/authorized_keys"; done < "$HOME/.ssh/authorized_keys"',
  'chown -R "$U:" "$H/.ssh"',
  'chmod 700 "$H/.ssh"',
  'chmod 600 "$H/.ssh/authorized_keys"',
  'loginctl enable-linger "$U" 2>/dev/null || true',
  "printf 'infinitary:account=%s\\n' \"$U\"",
].join("\n");

/** What `HOME_START` said of that computer. */
export type HomeStarted = {
  /** What `start-at-boot` exited with; null when the script never said. */
  boot: number | null;
  /** It has an address on a local or private network. */
  private: boolean;
  /** A Mac where this account is not logged in: its first mate starts at its next login. */
  waitsForLogin: boolean;
  /** A Linux account that does not linger: its first mate stops when it logs out. */
  lingerOff: boolean;
  firewall?: "ufw" | "firewalld" | "nixos";
};

export function readHomeStarted(stdout: string): HomeStarted {
  const said = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = /^infinitary:([a-z]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && !said.has(match[1])) said.set(match[1], match[2] ?? "");
  }
  const boot = said.get("boot");
  const firewall = said.get("firewall");
  return {
    boot: boot !== undefined && /^[0-9]{1,3}$/.test(boot) ? Number(boot) : null,
    private: said.get("private") === "yes",
    waitsForLogin: said.get("login") === "no",
    lingerOff: said.get("linger") === "off",
    ...(firewall === "ufw" || firewall === "firewalld" || firewall === "nixos" ? { firewall } : {}),
  };
}
