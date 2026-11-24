import type { DeviceChip, DeviceSystem } from "@shared/devices";
import { type BuildFlavor, userDataFoldersNewestFirst } from "@shared/userDataFolders";
import { RETIRED_PROFILE_MARKER } from "../storage/retiredProfile";
import { UPDATE_STARTING, VERIFY_MAC_APP } from "./remoteDownload";
import { UBUNTU_KEPT_LINES, UBUNTU_PROBE_LINES } from "./ubuntuPackage";

/**
 * The systems this computer sets Firstmate up on over SSH, each its own
 * adapter (docs/devices.md, "Adding a computer by its address"): what `uname`
 * answers there, the chips it runs on, the published build it takes, where
 * its work keeps its data, its own name, what its work needs that the system
 * may lack, and the shell that unpacks, starts, updates and finds the copy of
 * Firstmate kept there. The look asks the far computer's system first
 * (`LOOK`), then the home uses that system's adapter; a system with no adapter
 * is refused before anything is sent.
 *
 * A Mac keeps every script it had before Linux: the same folders, the same
 * gzipped tar of this Mac's own bundle, the same bootstrap. Windows would be a
 * third adapter, with a shell of its own; none is written yet.
 *
 * Every script is fixed and names no value: each value is its own quoted word
 * after it (`$1`, `$2`, ...), so nothing a name or an address holds can change
 * what runs.
 *
 * A computer's work may be in either spelling's data folder of the Infinitary
 * rename (docs/helper.md, "Under the other name"): the look and the copy kept
 * there are found in each folder in turn, newest spelling first, and never in
 * one that moved, which keeps only the move's recovery copy.
 */

/** How a copy of Firstmate travels over SSH. */
export type CopyForm =
  /** A Mac's own app bundle, as a gzipped tar made as it is sent: a Mac home to a Mac. */
  | "bundle"
  /** A Mac's published universal zip, checked there against its SHA-256 and unpacked with ditto. */
  | "zip"
  /** A Linux AppImage, sent as itself and checked there against its SHA-256. */
  | "appimage"
  /** An Ubuntu package, sent as itself and checked there against its SHA-256. */
  | "deb";

export type FarSystem = {
  system: Extract<DeviceSystem, "macos" | "linux">;
  /** What `uname -s` answers there. */
  uname: string;
  /** The chips Firstmate runs on there, by what `uname -m` answers. */
  chips: Readonly<Record<string, DeviceChip>>;
  /** The kind of published build it takes (`infinitary-builds.json`). */
  published: "zip" | "appimage";
  /** Sets `A`, the folder that holds this user's data folders. */
  appData: string;
  /** Sets `N`, its own name. */
  name: string;
  /**
   * Prints `infinitary:needs=<need>` for each tool or library its work needs
   * that it lacks, `infinitary:installer=<program>` for what installs them
   * there, and `infinitary:sandbox=off` where the copy it gets could not keep
   * Chromium's sandbox on.
   */
  needs: readonly string[];
  /** Extra look lines, each one shell line. Linux also reads the Ubuntu package facts. */
  probe: readonly string[];
  /** Sets `B` to the copy kept in `$D/app` and `X` to its program; leaves `B` empty when there is none. */
  kept: readonly string[];
  /**
   * The bootstrap a setup's own session runs there: a private folder under
   * `/tmp` for the join's socket and a temporary folder for the copy, each
   * said as an `infinitary:` line; then one line, the join's message, on its
   * input; then the copy started as `work join --fetched <app> --from-home`
   * with that line on its input. Exit 3: no folder; 4: the copy did not
   * arrive whole; 5: the home let go first.
   */
  setup: string;
  /** The session that carries the copy into `$1`, the bootstrap's folder, by its form; `$2` its SHA-256. */
  unpack: Partial<Record<CopyForm, string>>;
  /**
   * Updating: the copy on the input, then `work update --fetched <app>
   * --from-home --home "$1" --device "$2" --on-home-mac "$3"`, the flag left
   * out when `$3` is empty; `$4` its SHA-256. Exit 3: no temporary folder;
   * 4: the copy did not arrive whole.
   */
  update: Partial<Record<CopyForm, string>>;
};

/**
 * The data folders' names a script takes as `$1`, newest spelling first,
 * each ended by `/`, which no folder's name holds, and the flavor as `$2`.
 */
export function farFolderArgs(flavor: BuildFlavor): [string, string] {
  return [
    userDataFoldersNewestFirst(flavor)
      .map((name) => `${name}/`)
      .join(""),
    flavor,
  ];
}

/**
 * A development stand-in's value under either of its names, Infinitary's
 * winning when it is set, as `@shared/envSettings` reads them.
 */
function standIn(name: string): string {
  return `\${INFINITARY_${name}-$FM3000_${name}}`;
}

/** Whether a development stand-in names the work folder (`INFINITARY_HELPER_DATA_DIR`, or the older `FM3000_HELPER_DATA_DIR`). */
const DEV_FOLDER = `[ "$2" = dev ] && [ -n "${standIn("HELPER_DATA_DIR")}" ]`;

/**
 * Runs `body` once for each work folder there, in `D`: the one a development
 * stand-in names, or each data folder named in `$1` under `A` in turn, but
 * one that moved (its retired marker), until `body` sets `WS`.
 */
function eachWorkFolder(body: readonly string[]): string[] {
  return [
    "WS=",
    `if ${DEV_FOLDER}; then`,
    `  D="${standIn("HELPER_DATA_DIR")}"`,
    ...body.map((line) => `  ${line}`),
    "else",
    '  WL="$1"',
    '  while [ -z "$WS" ] && [ -n "$WL" ]; do',
    `    case "$WL" in */*) WN="\${WL%%/*}"; WL="\${WL#*/}" ;; *) WN="$WL"; WL="" ;; esac`,
    `    [ -n "$WN" ] && [ ! -e "$A/$WN/${RETIRED_PROFILE_MARKER}" ] || continue`,
    '    D="$A/$WN/work"',
    ...body.map((line) => `    ${line}`),
    "  done",
    "fi",
  ];
}

const DEV_NAME = `if [ "$2" = dev ] && [ -n "${standIn("DEVICE_NAME")}" ]; then N="${standIn("DEVICE_NAME")}"; fi`;

function checksum(sum: string): string[] {
  return [
    'if command -v sha256sum >/dev/null 2>&1; then H="$(sha256sum "$F")"; else H="$(shasum -a 256 "$F")"; fi',
    `[ "\${H%% *}" = "${sum}" ] || { rm -f "$F"; exit 4; }`,
  ];
}

const MAC_BOOTSTRAP_FOLDERS = [
  'R="$(mktemp -d /tmp/infinitary-r-XXXXXX)" || exit 3',
  'T="$(mktemp -d -t firstmate)" || { rm -rf "$R"; exit 3; }',
];

/** The folders a Linux copy goes through: this user's own cache, never a shared `/tmp`, which may forbid running it. */
const LINUX_STAGE = ['C="${XDG_CACHE_HOME:-$HOME/.cache}"', 'mkdir -p "$C" 2>/dev/null'];

const BOOTSTRAP_TAIL = [
  'trap \'rm -rf "$R" "$T"\' EXIT',
  "trap 'exit 5' HUP INT TERM",
  "printf 'infinitary:socket=%s\\n' \"$R/s\"",
  "printf 'infinitary:stage=%s\\n' \"$T\"",
  "IFS= read -r L || exit 5",
];

/**
 * The AppImage's own launcher's probe: where it fails, the launcher starts
 * the app with Chromium's sandbox off, as on Ubuntu 24.04 and later, which
 * keep an app with no profile of its own from making a user namespace
 * (docs/linux-packages.md, "The sandbox"). The look and the command for
 * another computer ask with it before a Linux computer gets the AppImage.
 */
export const SANDBOX_PROBE = "unshare -Ur true >/dev/null 2>&1";

/** The name a Linux copy is kept under there, whatever the release called its file. */
export const LINUX_APP_FILE = "infinitary.AppImage";

/**
 * The libraries the published AppImage needs from a Linux system to start
 * (docs/linux-packages.md, "What the AppImage needs"), by the need the look
 * says for each: FUSE 2's library, which the AppImage's own runtime opens to
 * mount itself, then every library Electron's program is linked against that
 * glibc does not carry. GTK 3 brings the libraries it is built on, so they
 * say `gtk` too. Electron's list comes from its program's own (`readelf -d`),
 * so a new Electron is read again.
 */
export const APPIMAGE_LIBRARIES: Readonly<Record<string, readonly string[]>> = {
  libfuse: ["libfuse.so.2"],
  gtk: [
    "libgtk-3.so.0",
    "libglib-2.0.so.0",
    "libgobject-2.0.so.0",
    "libgio-2.0.so.0",
    "libatk-1.0.so.0",
    "libatk-bridge-2.0.so.0",
    "libatspi.so.0",
    "libcairo.so.2",
    "libpango-1.0.so.0",
    "libcups.so.2",
    "libdbus-1.so.3",
    "libexpat.so.1",
    "libX11.so.6",
    "libXcomposite.so.1",
    "libXdamage.so.1",
    "libXext.so.6",
    "libXfixes.so.3",
    "libXrandr.so.2",
    "libxcb.so.1",
    "libxkbcommon.so.0",
  ],
  nss: ["libnss3.so", "libnssutil3.so", "libsmime3.so", "libnspr4.so"],
  gbm: ["libgbm.so.1"],
  alsa: ["libasound.so.2"],
  udev: ["libudev.so.1"],
};

/** How `ldconfig -p` starts each line of an x64 library: a tab, its name, then its kind. */
const TAB = "\t";

/**
 * Prints `infinitary:needs=<need>` once for each need in `APPIMAGE_LIBRARIES`
 * with a library the dynamic linker's own list lacks. A list that cannot be
 * read, or holds no x64 C library, as on NixOS, says nothing.
 */
const LIBRARY_NEEDS = [
  'L="$(PATH="$PATH:/sbin:/usr/sbin" ldconfig -p 2>/dev/null)"',
  'P=""',
  'case "$L" in',
  `  *"${TAB}libc.so.6 (libc6,x86-64"*)`,
  `    for n in ${Object.entries(APPIMAGE_LIBRARIES)
    .flatMap(([need, libraries]) => libraries.map((library) => `${need}=${library}`))
    .join(" ")}; do`,
  `      case "$L" in *"${TAB}\${n#*=} (libc6,x86-64"*) continue ;; esac`,
  `      case " $P " in *" \${n%%=*} "*) ;; *) P="$P \${n%%=*}"; printf 'infinitary:needs=%s\\n' "\${n%%=*}" ;; esac`,
  "    done",
  "    ;;",
  "esac",
];

/**
 * Prints the program that installs software there, `infinitary:installer=`
 * apt, dnf, pacman or zypper, which names the packages a refusal asks for;
 * with apt, and only once a library is missing (`P`), `infinitary:t64=yes`
 * where its libraries take Debian's 64-bit time names, as Ubuntu 24.04 and
 * Debian 13 do. Asking apt can take seconds where it keeps no cache.
 */
const INSTALLER = [
  "if command -v apt-get >/dev/null 2>&1; then",
  "  printf 'infinitary:installer=apt\\n'",
  "  if [ -n \"$P\" ] && apt-cache show libasound2t64 >/dev/null 2>&1; then printf 'infinitary:t64=yes\\n'; fi",
  "elif command -v dnf >/dev/null 2>&1; then printf 'infinitary:installer=dnf\\n'",
  "elif command -v pacman >/dev/null 2>&1; then printf 'infinitary:installer=pacman\\n'",
  "elif command -v zypper >/dev/null 2>&1; then printf 'infinitary:installer=zypper\\n'",
  "fi",
];

/**
 * What a Linux computer lacks for the AppImage and its work, as
 * `infinitary:needs=` lines, with the program that installs them there: the
 * look's, and the command's before it asks (`joinCommand`).
 */
export const LINUX_TOOL_NEEDS: readonly string[] = [
  "command -v git >/dev/null 2>&1 || printf 'infinitary:needs=git\\n'",
  "command -v Xvfb >/dev/null 2>&1 || printf 'infinitary:needs=xvfb\\n'",
  "command -v fusermount >/dev/null 2>&1 || printf 'infinitary:needs=fuse\\n'",
  ...LIBRARY_NEEDS,
  ...INSTALLER,
];

export const MACOS: FarSystem = {
  system: "macos",
  uname: "Darwin",
  // A Mac's app is universal: one bundle for both chips.
  chips: { arm64: "arm64", x86_64: "x64" },
  published: "zip",
  appData: 'A="$HOME/Library/Application Support"',
  name: 'N="$(/usr/sbin/scutil --get ComputerName 2>/dev/null)"',
  needs: [],
  probe: [],
  kept: [
    'for b in "$D"/app/*.app; do B="$b"; break; done',
    '[ -d "$B" ] || B=""',
    'X="$B/Contents/MacOS/$(basename "$B" .app)"',
  ],
  setup: [
    ...MAC_BOOTSTRAP_FOLDERS,
    ...BOOTSTRAP_TAIL,
    'B=""',
    'for b in "$T"/*.app; do B="$b"; break; done',
    '[ -d "$B" ] || exit 4',
    'printf \'%s\\n\' "$L" | "$B/Contents/MacOS/$(basename "$B" .app)" work join --fetched "$B" --from-home',
  ].join("\n"),
  unpack: {
    bundle: 'tar -xzf - -C "$1"',
    zip: [
      'F="$1/.firstmate.zip"',
      'cat > "$F" || exit 4',
      ...checksum("$2"),
      '/usr/bin/ditto -x -k "$F" "$1" || exit 4',
      'rm -f "$F"',
      'B=""; for b in "$1"/*.app; do B="$b"; break; done',
      '[ -d "$B" ] || exit 4',
      VERIFY_MAC_APP,
    ].join("\n"),
  },
  update: {
    bundle: [
      'T="$(mktemp -d -t firstmate)" || exit 3',
      "trap 'rm -rf \"$T\"' EXIT",
      'tar -xzf - -C "$T" || exit 4',
      'B=""',
      'for b in "$T"/*.app; do B="$b"; break; done',
      '[ -d "$B" ] || exit 4',
      `printf "${UPDATE_STARTING}\\n"`,
      '"$B/Contents/MacOS/$(basename "$B" .app)" work update --fetched "$B" --from-home --home "$1" --device "$2" ${3:+--on-home-mac "$3"}',
    ].join("\n"),
    zip: [
      'T="$(mktemp -d -t firstmate)" || exit 3',
      "trap 'rm -rf \"$T\"' EXIT",
      'F="$T/.firstmate.zip"',
      'cat > "$F" || exit 4',
      ...checksum("$4"),
      '/usr/bin/ditto -x -k "$F" "$T" || exit 4',
      'rm -f "$F"',
      'B=""',
      'for b in "$T"/*.app; do B="$b"; break; done',
      '[ -d "$B" ] || exit 4',
      VERIFY_MAC_APP,
      `printf "${UPDATE_STARTING}\\n"`,
      '"$B/Contents/MacOS/$(basename "$B" .app)" work update --fetched "$B" --from-home --home "$1" --device "$2" ${3:+--on-home-mac "$3"}',
    ].join("\n"),
  },
};

export const LINUX: FarSystem = {
  system: "linux",
  uname: "Linux",
  // Firstmate is published for Linux on x64 alone (docs/linux-packages.md).
  chips: { x86_64: "x64", amd64: "x64" },
  published: "appimage",
  // Where Electron keeps a Linux user's data: XDG_CONFIG_HOME, else ~/.config.
  appData: 'A="${XDG_CONFIG_HOME:-$HOME/.config}"',
  name: 'N="$(hostnamectl --pretty 2>/dev/null)"; [ -n "$N" ] || N="$(uname -n 2>/dev/null)"',
  // git for the work, Xvfb for the display its hidden windows draw on
  // (docs/helper.md, "No screen needed"), FUSE to open the AppImage: its
  // runtime is FUSE 2's, which mounts it with `fusermount`, and the
  // libraries the AppImage needs, with the program that installs them.
  needs: [
    ...LINUX_TOOL_NEEDS,
    // The AppImage's own launcher turns Chromium's sandbox off where this
    // user cannot make a user namespace; it asks with the launcher's probe.
    `${SANDBOX_PROBE} || printf 'infinitary:sandbox=off\\n'`,
  ],
  // Whether systemd runs there, which starting a first mate at boot needs (docs/run.md, "Starting at boot").
  probe: [
    ...UBUNTU_PROBE_LINES,
    "if [ -d /run/systemd/system ]; then printf 'infinitary:systemd=yes\\n'; fi",
  ],
  // Ubuntu 24.04 and 26.04 run from the package; every other Linux keeps the AppImage.
  kept: UBUNTU_KEPT_LINES,
  setup: [
    'R="$(mktemp -d /tmp/infinitary-r-XXXXXX)" || exit 3',
    ...LINUX_STAGE,
    'T="$(mktemp -d "$C/firstmate-XXXXXX")" || { rm -rf "$R"; exit 3; }',
    ...BOOTSTRAP_TAIL,
    `B="$T/${LINUX_APP_FILE}"`,
    '[ -x "$B" ] || exit 4',
    'printf \'%s\\n\' "$L" | "$B" work join --fetched "$B" --from-home',
  ].join("\n"),
  unpack: {
    appimage: [
      "umask 077",
      `F="$1/${LINUX_APP_FILE}.part"`,
      'cat > "$F" || exit 4',
      ...checksum("$2"),
      `chmod 0700 "$F" && mv "$F" "$1/${LINUX_APP_FILE}"`,
    ].join("\n"),
  },
  update: {
    appimage: [
      ...LINUX_STAGE,
      'T="$(mktemp -d "$C/firstmate-XXXXXX")" || exit 3',
      "trap 'rm -rf \"$T\"' EXIT",
      "umask 077",
      `F="$T/${LINUX_APP_FILE}.part"`,
      'cat > "$F" || exit 4',
      ...checksum("$4"),
      `B="$T/${LINUX_APP_FILE}"`,
      'chmod 0700 "$F" && mv "$F" "$B" || exit 4',
      `printf "${UPDATE_STARTING}\\n"`,
      '"$B" work update --fetched "$B" --from-home --home "$1" --device "$2" ${3:+--on-home-mac "$3"}',
    ].join("\n"),
  },
};

/** Every system an adapter is written for, a Mac first: it stands in for a system the look could not tell. */
export const FAR_SYSTEMS: readonly FarSystem[] = [MACOS, LINUX];

export function farSystemOf(uname: string | undefined): FarSystem | null {
  return FAR_SYSTEMS.find((far) => far.uname === uname) ?? null;
}

/**
 * The adapter for a computer on the list, by the system it said in its hello;
 * a Mac for one that never said, since only Macs were added by their address
 * before a computer said its system.
 */
export function farSystemNamed(system: DeviceSystem | undefined): FarSystem | null {
  if (system === undefined) return MACOS;
  return FAR_SYSTEMS.find((far) => far.system === system) ?? null;
}

function bySystem(
  arm: (far: FarSystem) => readonly string[],
  fallback: readonly string[],
): string[] {
  return [
    'case "$(uname -s 2>/dev/null)" in',
    ...FAR_SYSTEMS.flatMap((far) => [
      `  ${far.uname})`,
      ...arm(far).map((line) => `    ${line}`),
      "    ;;",
    ]),
    "  *)",
    ...fallback.map((line) => `    ${line}`),
    "    ;;",
    "esac",
  ];
}

/**
 * The look, as `infinitary:<what>=<value>` lines among whatever that
 * computer's own shell prints: its system and chip, then on a system with an
 * adapter what its work lacks, its user, that user's number, its own name,
 * what it reads at `$3` - the token this computer left there, which only this
 * computer has - and whether that user already joined a Firstmate, with the
 * pin of that Firstmate's key and the id it gave this user, both public, as
 * the grant the work mode keeps names them (`JoinedHome`), from the first
 * work folder holding a grant. With no such grant, the same of the grant its
 * window keeps beside a work folder (`userData/joined/`), when that window
 * joined as a Mac (`windowhome`, `windowdevice`). `$1` names the data folders
 * and `$2` the flavor (`farFolderArgs`); nothing is written there.
 */
export const LOOK = [
  'O="$(uname -s 2>/dev/null)"',
  "printf 'infinitary:os=%s\\n' \"$O\"",
  "printf 'infinitary:arch=%s\\n' \"$(uname -m 2>/dev/null)\"",
  'case "$O" in',
  ...FAR_SYSTEMS.flatMap((far) => [
    `  ${far.uname})`,
    ...[far.name, far.appData, ...far.needs, ...far.probe].map((line) => `    ${line}`),
    "    ;;",
  ]),
  "  *) exit 0 ;;",
  "esac",
  "printf 'infinitary:user=%s\\n' \"$(id -un)\"",
  "printf 'infinitary:uid=%s\\n' \"$(id -u)\"",
  DEV_NAME,
  "printf 'infinitary:name=%s\\n' \"$N\"",
  'if [ -n "$3" ] && [ -f "$3" ] && IFS= read -r H < "$3"; then printf \'infinitary:here=%s\\n\' "$H"; fi',
  'D=""',
  ...eachWorkFolder(['[ ! -f "$D/home.json" ] || WS=1']),
  'if [ -n "$WS" ]; then',
  "  printf 'infinitary:joined=yes\\n'",
  String.raw`  sed -n 's/.*"homeKey"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/infinitary:home=\1/p' "$D/home.json" 2>/dev/null`,
  String.raw`  sed -n 's/.*"deviceId"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/infinitary:device=\1/p' "$D/home.json" 2>/dev/null`,
  String.raw`  if grep -Eq '"app"[[:space:]]*:[[:space:]]*"[^"]*\.AppImage"' "$D/installed.json" 2>/dev/null; then printf 'infinitary:keptappimage=yes\n'; fi`,
  "else",
  "  printf 'infinitary:joined=no\\n'",
  "fi",
  // Its window joined a Firstmate as a Mac while its work kept no grant:
  // that grant's home and id, so the add finds that same entry.
  'if [ -z "$WS" ]; then',
  ...eachWorkFolder(['JH="${D%/*}/joined/home.json"', '[ ! -f "$JH" ] || WS=1']),
  `  if [ -n "$WS" ] && grep -q '"kind"[[:space:]]*:[[:space:]]*"mac"' "$JH" 2>/dev/null; then`,
  String.raw`    sed -n 's/.*"homeKey"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/infinitary:windowhome=\1/p' "$JH" 2>/dev/null`,
  String.raw`    sed -n 's/.*"deviceId"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/infinitary:windowdevice=\1/p' "$JH" 2>/dev/null`,
  "  fi",
  "fi",
].join("\n");

/**
 * Finds the copy of Firstmate kept there for the work of this flavor: sets
 * `D`, `B` and `X` from `$1` and `$2` by that computer's system, a Mac's
 * folders for one with no adapter, as before a computer said its system,
 * from the first work folder that keeps one. The copy's own work mode reads
 * where its work is. No copy anywhere answers `not-joined` and exits 1.
 */
export const KEPT_COPY = [
  ...bySystem((far) => [far.appData], [MACOS.appData]),
  'B=""',
  ...eachWorkFolder(['B=""', ...bySystem((far) => far.kept, MACOS.kept), '[ -z "$B" ] || WS=1']),
  `if [ -z "$B" ]; then printf '%s\\n' '{"firstmate":"refused","reason":"not-joined"}'; exit 1; fi`,
];

/**
 * Removes what Firstmate set up there, with the copy kept there: `$1` and
 * `$2` name the data folders (`farFolderArgs`), `$3` is the home's pin and
 * `$4` the computer's id, which the work mode checks before it removes
 * anything (`other-home`).
 */
export const REMOVE = [...KEPT_COPY, '"$X" work remove --from-home --home "$3" --device "$4"'].join(
  "\n",
);

/**
 * The controller, from the copy of Firstmate kept there: `$1` and `$2` name
 * the data folders (`farFolderArgs`), `$3` the home's pin and `$4` that
 * computer's id, which it checks before it touches anything.
 */
export const CONNECT = [
  ...KEPT_COPY,
  'exec "$X" work connect --from-home --home "$3" --device "$4"',
].join("\n");
