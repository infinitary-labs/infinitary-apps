import type { Writable } from "node:stream";

/**
 * Adding an Ubuntu 24.04 or 26.04 computer by its address (docs/devices.md,
 * "The Ubuntu package"): the look reads the release, whether that account
 * may install software, and the installed package's version. A missing or
 * different package is installed from the tap's deb, with that account's
 * password on `sudo -S`'s input, never as an argument, and linger is turned
 * on in the same step where systemd runs. The work then runs from the
 * package at `/opt/infinitary`, which already loads its AppArmor profile, so
 * Ubuntu's limit stays on. Other Linux systems keep the AppImage.
 */

/** Releases whose address setup installs the Ubuntu package. */
export const UBUNTU_PACKAGE_RELEASES = ["24.04", "26.04"] as const;

export const UBUNTU_PACKAGE_BIN = "/opt/infinitary/infinitary";

/**
 * Where Firstmate 3000's Ubuntu package put its program. Infinitary's
 * package replaces that package and leaves this path as a link to its own
 * program (docs/linux-packages.md, "The old program path").
 */
export const FIRSTMATE_PACKAGE_BIN = "/opt/firstmate-3000/firstmate-3000";

/** What `sudo -n true` found: install with no password, a password, or not at all. */
export type SudoRight = "free" | "password" | "no";

/**
 * Whether the package there is this computer's version. A deb writes a
 * prerelease hyphen as `~`, and may add a numeric revision.
 */
export function packageVersionsMatch(installed: string, app: string): boolean {
  if (!installed || !app) return false;
  const norm = (value: string) =>
    value
      .trim()
      .replace(/^[0-9]+:/, "")
      .replace(/-\d+$/, "")
      .replace(/-/g, "~");
  return norm(installed) === norm(app);
}

export function ubuntuPackageRelease(look: {
  distro?: string | undefined;
  release?: string | undefined;
}): (typeof UBUNTU_PACKAGE_RELEASES)[number] | null {
  if (look.distro !== "ubuntu") return null;
  const release = look.release ?? "";
  return (UBUNTU_PACKAGE_RELEASES as readonly string[]).includes(release)
    ? (release as (typeof UBUNTU_PACKAGE_RELEASES)[number])
    : null;
}

/**
 * What an Ubuntu package computer still needs before the work starts:
 * nothing when the package already matches, an install when this account
 * may, a password when `sudo` will ask, or a refusal when it may not.
 */
export function ubuntuInstallNeed(
  look: { sudo?: SudoRight | undefined; pkg?: string | undefined },
  appVersion: string,
): "ready" | "install" | "ask" | "refused" {
  if (packageVersionsMatch(look.pkg ?? "", appVersion)) return "ready";
  if (look.sudo === "free") return "install";
  if (look.sudo === "password") return "ask";
  return "refused";
}

/**
 * Look lines for every Linux computer: the distro and release, the installed
 * `infinitary` deb version, and whether this account may install
 * software. Each line is one shell line, so the look can indent it.
 */
export const UBUNTU_PROBE_LINES: readonly string[] = [
  "if [ -r /etc/os-release ]; then",
  "  ID=\"$(sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '\"')\"",
  "  VER=\"$(sed -n 's/^VERSION_ID=//p' /etc/os-release | head -n 1 | tr -d '\"')\"",
  "  printf 'infinitary:distro=%s\\n' \"$ID\"",
  "  printf 'infinitary:release=%s\\n' \"$VER\"",
  "fi",
  "if command -v dpkg-query >/dev/null 2>&1; then",
  "  PKG=\"$(dpkg-query -W -f '${Version}' infinitary 2>/dev/null || true)\"",
  "  printf 'infinitary:pkg=%s\\n' \"$PKG\"",
  "fi",
  "if sudo -n true >/dev/null 2>&1; then",
  "  printf 'infinitary:sudo=free\\n'",
  "else",
  '  MSG="$(sudo -n true 2>&1 || true)"',
  '  case "$MSG" in',
  "    *\"a password is required\"*) printf 'infinitary:sudo=password\\n' ;;",
  "    *) printf 'infinitary:sudo=no\\n' ;;",
  "  esac",
  "fi",
];

/**
 * Finds the copy the work runs from. On Ubuntu 24.04 and 26.04 the package's
 * own program wins, so removing the computer does not need an AppImage kept
 * there; a computer still on Firstmate 3000's package runs from its program
 * until it takes Infinitary's. Anywhere else, the AppImage kept in the work
 * folder, as before.
 */
export const UBUNTU_KEPT_LINES: readonly string[] = [
  'U=""',
  `for u in ${UBUNTU_PACKAGE_BIN} ${FIRSTMATE_PACKAGE_BIN}; do if [ -x "$u" ]; then U="$u"; break; fi; done`,
  'if [ -n "$U" ] && [ -r /etc/os-release ]; then',
  "  ID=\"$(sed -n 's/^ID=//p' /etc/os-release | head -n 1 | tr -d '\"')\"",
  "  VER=\"$(sed -n 's/^VERSION_ID=//p' /etc/os-release | head -n 1 | tr -d '\"')\"",
  '  if [ "$ID" = ubuntu ] && { [ "$VER" = 24.04 ] || [ "$VER" = 26.04 ]; }; then B="$U"; X="$B"; fi',
  "fi",
  'if [ -z "${B:-}" ]; then',
  '  for b in "$D"/app/*.AppImage; do B="$b"; break; done',
  '  [ -f "$B" ] || B=""',
  '  X="$B"',
  "fi",
];

/**
 * Receives the deb on its input into this user's cache, checks `$1` (its
 * SHA-256) and says where it is. Exit 4: it did not arrive whole.
 */
export const RECEIVE_DEB = [
  "umask 077",
  'C="${XDG_CACHE_HOME:-$HOME/.cache}"',
  'mkdir -p "$C" || exit 3',
  'T="$(mktemp -d "$C/firstmate-XXXXXX")" || exit 3',
  'F="$T/infinitary.deb"',
  'cat > "$F" || { rm -rf "$T"; exit 4; }',
  'if command -v sha256sum >/dev/null 2>&1; then H="$(sha256sum "$F")"; else H="$(shasum -a 256 "$F")"; fi',
  '[ "${H%% *}" = "$1" ] || { rm -rf "$T"; exit 4; }',
  "printf 'infinitary:deb=%s\\n' \"$F\"",
].join("\n");

/** What the install says when it could not turn on linger, on a line of its own. */
export const LINGER_OFF_LINE = "infinitary:linger=off";

/**
 * What root runs, with `$1` the deb and `$2` its SHA-256: copy into a
 * root-owned folder, check and install that copy, turn on linger for the
 * account that asked, and delete the deb. The account can change its cache
 * at any time, but never the checked copy apt reads. Root's copy is removed
 * on exit, including a failed check or install.
 * Where systemd does not run, as in a container or WSL without it, linger
 * fails and the install still stands: the step says `LINGER_OFF_LINE`, so
 * the home names the sudo line once the work joined. The password is not in
 * this script.
 */
export const INSTALL_AS_ROOT = [
  "set -eu",
  'src="$1"',
  'sum="$2"',
  'd="$(mktemp -d /tmp/infinitary-install-XXXXXX)"',
  "trap 'rm -rf \"$d\"' EXIT",
  "trap 'exit 1' HUP INT TERM",
  'deb="$d/infinitary.deb"',
  'cp -- "$src" "$deb"',
  // Set the file's mode before exposing the directory, even with a permissive source/umask.
  // Keep unverified contents private: the source could point at a root-only file.
  'chmod 644 "$deb"',
  'printf \'%s  %s\\n\' "$sum" "$deb" | sha256sum -c --status || exit 65',
  // Root owns both; apt's unprivileged reader may now read, but nobody else may write.
  'chmod 755 "$d"',
  "export DEBIAN_FRONTEND=noninteractive",
  'apt-get install -y --allow-downgrades "$deb"',
  'user="${SUDO_USER:-$USER}"',
  `loginctl enable-linger "$user" 2>/dev/null || printf '%s\\n' ${LINGER_OFF_LINE}`,
  'rm -f "$src"',
].join("\n");

export function lingerOff(stdout: string): boolean {
  return stdout.split("\n").some((line) => line.trim() === LINGER_OFF_LINE);
}

/**
 * The command root runs. A password, when one is needed, is `sudo -S`'s
 * input, never a word of this command.
 */
export function sudoInstallCommand(
  debPath: string,
  sha256: string,
  needsPassword: boolean,
): readonly string[] {
  const sudo = needsPassword ? ["sudo", "-S", "-p", "", "--"] : ["sudo", "-n", "--"];
  return [...sudo, "/bin/sh", "-c", INSTALL_AS_ROOT, "firstmate", debPath, sha256];
}

/**
 * Starts the installed package's join. The home writes one line, the link,
 * and this pipes it to the package. No copy is kept in the work folder.
 * The captain agreed on the home (`--agreed`), so nobody there is asked:
 * with no copy the home sent, the join would ask its input, which holds
 * only the link, and decline.
 */
export const PACKAGE_SETUP = [
  'R="$(mktemp -d /tmp/infinitary-r-XXXXXX)" || exit 3',
  "trap 'rm -rf \"$R\"' EXIT",
  "trap 'exit 5' HUP INT TERM",
  "printf 'infinitary:socket=%s\\n' \"$R/s\"",
  "IFS= read -r L || exit 5",
  `[ -x ${UBUNTU_PACKAGE_BIN} ] || exit 4`,
  `printf '%s\\n' "$L" | ${UBUNTU_PACKAGE_BIN} work join --from-home --agreed`,
].join("\n");

/** sudo's own note that the password did not work. Nothing else is read as that. */
export function sudoRejected(stderr: string): boolean {
  return /sorry, try again|incorrect password|no password was provided/i.test(stderr);
}

/**
 * Writes the password and a newline to `sudo -S`'s input, then zeroes the
 * copy. The password is not an argument and is not logged.
 */
export function writeSecret(password: Buffer, sink: Writable): Promise<void> {
  const once = Buffer.concat([password, Buffer.from("\n")]);
  return new Promise((resolve, reject) => {
    sink.write(once, (error) => {
      once.fill(0);
      if (error) reject(error);
      else resolve();
    });
  });
}
