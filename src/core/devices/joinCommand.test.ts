import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileSizeWords } from "@shared/attachments";
import { FETCH_APP_PATH } from "@shared/connection";
import type { DeviceChip, DeviceSystem } from "@shared/devices";
import {
  buildPairingLink,
  DOWNLOAD_COMMAND_LINK_TTL_MS,
  deviceInviteSchema,
  deviceNameSchema,
  dialAddressSchema,
  pairingLinkSchema,
  parsePairingLink,
} from "@shared/devices";
import { LINUX_NEEDS } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { macRelease } from "../../../tests/helpers/macRelease";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type HomeConnection, startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
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
  commandUsed,
  lingerStays,
  macAsk,
  otherVersion,
  sandboxOff,
} from "../helper/words";
import { linuxUpdateCommand } from "../update/linuxInstall";
import { buildDownloadUrl } from "../update/updateChannels";
import { claimLink } from "./dial";
import type { FarBuild } from "./farBuilds";
import { APPIMAGE_LIBRARIES } from "./farSystems";
import { createKeyIdentity } from "./identity";
import { joinCommand, shellWord } from "./joinCommand";
import { DevicePairing } from "./pairing";
import { publishedAssetName } from "./publishedBuilds";

/**
 * The one command that joins a computer to this home (docs/devices.md,
 * "Joining by a command"), run as a person runs it: by the Mac's own
 * `/bin/sh`, its own curl and tar, against the real pairing and connection,
 * with a stand-in Firstmate bundle the home sends. The stand-in's program
 * writes down how it was started and what it found beside it, so the test
 * reads whether the command asked first, got the right app, started it with
 * the link, and left nothing behind. The real app joining from a fetched
 * copy is `tests/e2e/run-work.spec.ts`.
 */

// Real processes: sh, curl, tar, and the home's own tar; on a Mac, a local
// HTTPS release with shasum, ditto and a stand-in codesign.
vi.setConfig({ testTimeout: 30_000 });

const standIn = (async (channel) => {
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

const connections: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
});

/**
 * What a stand-in program runs first: it writes down its words but the
 * `--background <file>` the command passes, and writes `background` there,
 * as a real join writes how its work runs in the background (`InBackground`).
 */
function recordWords(record: string, background: string): string {
  return [
    `f=""; n=""; for a in "$@"; do if [ -n "$n" ]; then f="$a"; n=""; elif [ "$a" = --background ]; then n=1; else printf '%s\\n' "$a"; fi; done > ${shellWord(record)}`,
    `if [ -n "$f" ]; then printf '%s' ${shellWord(background)} > "$f"; fi`,
  ].join("\n");
}

/** A stand-in Firstmate bundle: its program writes down its words and its bundle's marker, then answers `exit`. */
function standInBundle(record: string, exit = 0): string {
  const bundle = join(scratchDir("infinitary-command-app-"), "Firstmate 3000.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "Resources", "marker"), "the home's own copy\n");
  const program = join(bundle, "Contents", "MacOS", "Firstmate 3000");
  writeFileSync(
    program,
    [
      "#!/bin/sh",
      recordWords(record, "running"),
      `cat "$4/Contents/Resources/marker" >> ${shellWord(record)}`,
      `echo "Joined (stand-in)."`,
      `exit ${exit}`,
      "",
    ].join("\n"),
  );
  chmodSync(program, 0o755);
  return bundle;
}

async function home(
  options: {
    now?: () => number;
    bundle?: string | null;
    /** The Firstmate it sends a computer that names its system, as `startConnection` takes it. */
    build?: (
      system: DeviceSystem,
      chip: DeviceChip | undefined,
      kind?: "deb",
    ) => Promise<FarBuild | null>;
  } = {},
) {
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-command-home-"), "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    ...(options.now ? { now: options.now } : {}),
  });
  pairings.push(pairing);
  const port = await claimedPort();
  const at = `127.0.0.1:${port}`;
  let fetched = 0;
  const connection = startConnection({
    dispatch: standIn,
    events: new CoreEventBus(),
    devices: pairing,
    port,
    name: () => "MacBook Pro",
    app: () => {
      fetched += 1;
      return options.bundle ?? null;
    },
    ...(options.build ? { build: options.build } : {}),
  });
  connections.push(connection);
  return {
    pairing,
    at,
    fetched: () => fetched,
    /** A link, of the usual lifetime unless the test makes it last as a command that downloads does. */
    invite: async (lastsMs?: number) => {
      const invite = pairing.invite({ kind: "work", at }, lastsMs ? { lastsMs } : {});
      await connection.settled();
      return invite;
    },
  };
}

const LAUNCHER = {
  executable: "/Applications/Firstmate 3000.app/Contents/MacOS/Firstmate 3000",
  args: [],
};

/** This computer's version, as the command carries it; a test's own. */
const VERSION = "0.13.0";

/** The line that updates an Ubuntu package there, at this version's published address. */
const UPDATE_LINE =
  linuxUpdateCommand(
    { chip: "x64", package: "deb" },
    {
      url: `https://github.com/infinitary-labs/homebrew-tap/releases/download/v${VERSION}/infinitary-${VERSION}-linux-amd64.deb`,
      sha256: "a".repeat(64),
    },
  ) ?? "";

/** The command for another computer, but its link. */
const MAC = {
  for: "another-mac",
  homeName: "MacBook Pro",
  launcher: LAUNCHER,
  version: VERSION,
} as const;

/** Runs a command as Terminal would, typing `answer` when it asks; answers its words and exit. */
/** A folder whose `uname` says Darwin, first on the search path; none on a Mac. */
function macUname(): string {
  if (process.platform === "darwin") return "";
  const bin = scratchDir("infinitary-command-mac-bin-");
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
  return `${bin}:`;
}

/** What a stand-in Linux computer has, beyond `uname` saying Linux on x64 (`linuxTools`). */
type LinuxStandIns = {
  /** Whether this user may make a user namespace, which the AppImage's launcher probes; yes unless said. */
  namespaces?: boolean;
  /** The AppImage's libraries it lacks; none unless said. */
  lacks?: readonly string[];
  /**
   * apt there, and whether its libraries take Debian's 64-bit time names;
   * `fails` when its install stops after dpkg unpacked the package (`part`),
   * or after it installed only a package the package needs (`needs`).
   */
  apt?: { t64: boolean; fails?: "part" | "needs" };
  /** What `sudo` lets this account do: install with no password, with the password `secret`, or not at all. */
  sudo?: "free" | "password" | "no";
  /** Something of this account's replaces the package it fetched while sudo asks the password. */
  swaps?: boolean;
  /** Whether systemd lets this user keep its work on after logout itself, or runs at all (`none`, as in a container). */
  linger?: "allowed" | "refused" | "none";
  /** Whether dpkg knows an `infinitary` package there. */
  dpkg?: boolean;
  /** Where apt installs the Ubuntu package's program, the version that program answers, and how its join exits. */
  installs?: { program: string; version: string; exit?: number };
  /** Where the stand-ins write down what they were asked. */
  record: string;
};

/**
 * A folder that stands in a Linux computer on x64, first on the search path:
 * its `uname`; the `unshare` the AppImage's launcher probes; Xvfb,
 * `fusermount`, and `ldconfig`'s list of libraries but those it lacks;
 * and, where said, apt, sudo, loginctl and dpkg-query, each writing down what
 * it was asked. Its sudo runs what it is given as this user, as root would.
 */
function linuxTools(has: LinuxStandIns): string {
  const bin = scratchDir("infinitary-command-linux-bin-");
  const tool = (name: string, lines: readonly string[]) =>
    writeFileSync(join(bin, name), ["#!/bin/sh", ...lines, ""].join("\n"), { mode: 0o755 });
  const lacks = new Set(has.lacks ?? []);
  const record = (name: string) => shellWord(join(has.record, name));
  tool("uname", ['if [ "$1" = -m ]; then echo x86_64; else echo Linux; fi']);
  tool("unshare", [`exit ${has.namespaces === false ? 1 : 0}`]);
  tool("Xvfb", ["exit 0"]);
  tool("fusermount", ["exit 0"]);
  const libraries = Object.values(APPIMAGE_LIBRARIES)
    .flat()
    .filter((library) => !lacks.has(library));
  tool("ldconfig", [
    `printf '\\t%s (libc6,x86-64) => /lib/x86_64-linux-gnu/%s\\n' ${["libc.so.6", ...libraries]
      .map((library) => `${library} ${library}`)
      .join(" ")}`,
  ]);
  if (has.apt) {
    tool("apt-cache", [`exit ${has.apt.t64 ? 0 : 100}`]);
    tool("apt-get", [
      `printf '%s\\n' "$*" >> ${record("apt-get")}`,
      // The package it installs, by its last word, and the program it puts in place.
      'for f in "$@"; do deb="$f"; done',
      `cp "$deb" ${record("installed.deb")}`,
      ...(has.installs ? [`cp ${record("program")} ${shellWord(has.installs.program)}`] : []),
      // dpkg's own rows: a package half configured, or only one the package needs.
      ...(has.apt.fails === "part"
        ? [`echo "iF  infinitary 1.0 amd64 Infinitary" >> ${record("dpkg")}`, "exit 100"]
        : []),
      ...(has.apt.fails === "needs"
        ? [
            `echo "ii  libneeds 1.0 amd64 A package Infinitary needs" >> ${record("dpkg")}`,
            "exit 100",
          ]
        : []),
    ]);
    // `dpkg -l`: every package's row, or the named one's, refused where dpkg knows none.
    tool("dpkg", [
      `if [ -z "$2" ]; then cat ${record("dpkg")} 2>/dev/null; exit 0; fi`,
      `grep " $2 " ${record("dpkg")} 2>/dev/null || { echo "dpkg-query: no packages found matching $2" >&2; exit 1; }`,
    ]);
    if (has.installs) {
      writeFileSync(
        join(has.record, "program"),
        packageProgram(
          has.installs.version,
          join(has.record, "joined"),
          "running",
          has.installs.exit,
        ),
        { mode: 0o755 },
      );
    }
  }
  if (has.sudo) {
    tool("sudo", [
      `printf '%s\\n' "$1" >> ${record("sudo")}`,
      'if [ "$1" = -n ]; then',
      ...(has.sudo === "free"
        ? ["  exit 0"]
        : has.sudo === "password"
          ? ["  echo 'sudo: a password is required' >&2; exit 1"]
          : ["  echo 'Sorry, user may not run sudo on this computer.' >&2; exit 1"]),
      "fi",
      ...(has.sudo === "password"
        ? ['IFS= read -r pw; if [ "$pw" != secret ]; then echo "Sorry, try again." >&2; exit 1; fi']
        : []),
      'SUDO_USER="$(id -un)"; export SUDO_USER',
      // The package is the word after the script's name: `sh -c <script> firstmate <deb> ...`.
      ...(has.swaps ? ['printf "another package\\n" > "$5"'] : []),
      'exec "$@"',
    ]);
  }
  tool("loginctl", [
    `printf '%s\\n' "$*" >> ${record("loginctl")}`,
    ...(has.linger === "none"
      ? ["echo 'System has not been booted with systemd as init system (PID 1).' >&2; exit 1"]
      : []),
    `if [ "$1" = show-user ]; then cat ${record("linger")} 2>/dev/null || echo no; exit 0; fi`,
    `if [ "$2" = --no-ask-password ]; then ${has.linger === "allowed" ? ": ; " : "echo 'Access denied' >&2; exit 1; "}fi`,
    `echo yes > ${record("linger")}`,
  ]);
  if (has.dpkg !== undefined) tool("dpkg-query", [`exit ${has.dpkg ? 0 : 1}`]);
  // macOS's own sha256sum checks no list quietly, as root's install does.
  if (process.platform === "darwin")
    tool("sha256sum", [
      'if [ "$1" = -c ]; then exec shasum -a 256 -c -s; fi',
      'exec shasum -a 256 "$@"',
    ]);
  return `${bin}:`;
}

/**
 * A stand-in for the program an installed Infinitary runs from: it answers
 * its version, and writes down how it was started to join.
 */
function packageProgram(version: string, record: string, background = "running", exit = 0): string {
  return [
    "#!/bin/sh",
    `if [ "$1 $2" = "work version" ]; then echo "Infinitary ${version} · contract 11.0.0"; exit 0; fi`,
    recordWords(record, background),
    exit === 0 ? 'echo "Joined (stand-in)."' : `echo "Did not join (stand-in)."; exit ${exit}`,
    "",
  ].join("\n");
}

function run(
  command: string,
  answer: string,
  tools = macUname(),
  env: Record<string, string> = {},
  /** Hears what it has written so far, each time it writes more. */
  onOut?: (out: string) => void,
): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      // A person's Terminal: the Mac's own programs first, in a UTF-8 locale.
      // The command stops at once on a computer that is not a Mac, so on any
      // other system a stand-in `uname` says Darwin, as the bundle the home
      // sends stands in a Mac's app.
      env: {
        PATH: `${tools}/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: scratchDir("infinitary-command-user-"),
        LANG: "en_US.UTF-8",
        ...env,
      },
      cwd: scratchDir("infinitary-command-cwd-"),
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      onOut?.(out);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    // A command that finishes without reading its answer (one that asks nothing, or stops
    // before asking) can close the pipe before this write lands; its words and exit are the answer.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(answer);
    child.once("close", (code) => resolve({ out, code }));
  });
}

const ME = userInfo().username;

/** As long a computer name as a device's own label may be (`deviceNameSchema`), with the apostrophes quoting makes longest. */
const LONGEST_NAME = "Kun's MacBook Pro, on Sam's desk in the studio's back room by the door".slice(
  0,
  deviceNameSchema.maxLength ?? 0,
);
/** As many addresses as a link carries: its first and every other one it may name (`pairingLinkSchema`'s `also`). */
const MOST_ADDRESSES = 1 + Number(pairingLinkSchema.shape.also.unwrap()._zod.bag.maximum);
/**
 * A dial address as long as a host name may be, 253 characters (RFC 1035),
 * that never answers: `.invalid` names nothing anywhere (RFC 6761).
 */
const longestAddress = (n: number) =>
  `${["a", "b", "c"].map((c) => c.repeat(63)).join(".")}.h${n}${"x".repeat(53 - 1 - String(n).length)}.invalid:65535`;

describe("the command that adds another Mac", () => {
  it("asks first, then gets Firstmate from this Mac with the link, starts it to join, and leaves nothing behind", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const command = joinCommand({
      for: "another-mac",
      link: invite.link,
      homeName: "MacBook Pro",
      launcher: LAUNCHER,
      version: VERSION,
    });
    // One line, with the link in it and nothing from the shell's own words.
    expect(command).not.toContain("\n");
    expect(command.startsWith("'/bin/sh' '-c' ")).toBe(true);

    const { out, code } = await run(command, "yes\n");
    expect(code).toBe(0);
    expect(out).toBe(
      [
        ...macAsk("MacBook Pro", ME),
        "Type yes to agree: Getting Infinitary from MacBook Pro… done.",
        "Joined (stand-in).",
        "",
      ].join("\n"),
    );
    const [work, join_, fetched, bundle, link, marker] = readFileSync(record, "utf8").split("\n");
    expect([work, join_, fetched, link, marker]).toEqual([
      "work",
      "join",
      "--fetched",
      invite.link,
      "the home's own copy",
    ]);
    expect(bundle?.endsWith("/Firstmate 3000.app")).toBe(true);
    // What it unpacked is gone, and the link is still open for the join to use.
    expect(existsSync(bundle ?? "")).toBe(false);
    expect(at.fetched()).toBe(1);
    expect(at.pairing.opened({ code: parsePairingLink(invite.link).code })).toBeNull();
  });

  // Review INF-1241 R8: the longest invitation the home makes still fits what its answer may carry.
  it("fits the invitation with the longest name, every address a link carries and the published lines", async () => {
    const at = await home();
    const invite = await at.invite();
    const addresses = Array.from({ length: MOST_ADDRESSES }, (_, n) => longestAddress(n));
    for (const address of addresses)
      expect(dialAddressSchema.safeParse(address).success).toBe(true);
    const longest = {
      ...invite,
      link: buildPairingLink({
        ...parsePairingLink(invite.link),
        at: addresses[0] ?? "",
        also: addresses.slice(1),
      }),
    };
    // An alpha's version, the longest a release is named by, at its published addresses.
    const version = `${VERSION}-alpha.99`;
    const published = (want: Parameters<typeof publishedAssetName>[1]) =>
      buildDownloadUrl(version, publishedAssetName(version, want) ?? "");
    const text = joinCommand({
      for: "another-mac",
      link: longest.link,
      homeName: LONGEST_NAME,
      launcher: LAUNCHER,
      version,
      download: {
        url: published({ system: "macos", chip: "arm64", kind: "zip" }),
        sha256: "f".repeat(64),
        expiresAt: invite.expiresAt,
      },
      update:
        linuxUpdateCommand(
          { chip: "x64", package: "deb" },
          { url: published({ system: "linux", chip: "x64", kind: "deb" }), sha256: "e".repeat(64) },
        ) ?? "",
    });
    expect(text).not.toContain("\n");
    expect(
      deviceInviteSchema.safeParse({ ...longest, command: { for: "another-mac", text } }).success,
    ).toBe(true);
  });

  it("tries every address a link carries until one answers, and joins there with the longest name in its words", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const link = parsePairingLink(invite.link);
    const away = Array.from({ length: MOST_ADDRESSES - 1 }, (_, n) => longestAddress(n));
    const text = joinCommand({
      ...MAC,
      homeName: LONGEST_NAME,
      link: buildPairingLink({ ...link, at: away[0] ?? "", also: [...away.slice(1), link.at] }),
    });
    const { out, code } = await run(text, "yes\n");
    expect(code).toBe(0);
    expect(out).toBe(
      [
        ...macAsk(LONGEST_NAME, ME),
        `Type yes to agree: Getting Infinitary from ${LONGEST_NAME}… done.`,
        "Joined (stand-in).",
        "",
      ].join("\n"),
    );
    expect(at.fetched()).toBe(1);
  });

  it("changes nothing on a no, and asks nothing of a Mac that is out of reach or is not that Mac", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const command = (link: string) => joinCommand({ ...MAC, link });

    const no = await run(command(invite.link), "no\n");
    expect(no.code).toBe(1);
    expect(no.out).toBe(
      [
        ...macAsk("MacBook Pro", ME),
        "Type yes to agree: Nothing changed on this computer.",
        "",
      ].join("\n"),
    );

    const link = parsePairingLink(invite.link);
    const nobody = buildPairingLink({ ...link, at: `127.0.0.1:${await claimedPort()}` });
    const away = await run(command(nobody), "yes\n");
    expect(away.code).toBe(1);
    expect(away.out).toBe(
      "Could not reach MacBook Pro at 127.0.0.1.\nBoth computers need the same network, or the same private network.\n",
    );

    const impostor = buildPairingLink({ ...link, key: createKeyIdentity("x").pin });
    const other = await run(command(impostor), "yes\n");
    expect(other.code).toBe(1);
    expect(other.out).toBe(
      "Something answered at 127.0.0.1, but not the computer that made this command.\nNothing was sent to it.\n",
    );
    expect(at.fetched()).toBe(0);
    expect(existsSync(record)).toBe(false);
  });

  it("says a command was used, expired or stopped, and gets nothing", async () => {
    let now = 1_000_000;
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ now: () => now, bundle: standInBundle(record) });
    const command = (link: string) => joinCommand({ ...MAC, link });
    const tail = (lines: readonly string[]) => [
      ...macAsk("MacBook Pro", ME),
      "Type yes to agree: Getting Infinitary from MacBook Pro… ",
      ...lines,
      "",
    ];

    const used = await at.invite();
    await claimLink(used.link, {
      kind: "work",
      name: "Another Mac",
      user: { name: "sam", uid: (process.getuid?.() ?? 0) + 1000 },
    });
    expect((await run(command(used.link), "yes\n")).out).toBe(
      tail(commandUsed("MacBook Pro")).join("\n"),
    );

    const stopped = await at.invite();
    at.pairing.stop(stopped.id);
    expect((await run(command(stopped.link), "yes\n")).out).toBe(
      tail(commandClosed("MacBook Pro")).join("\n"),
    );

    const late = await at.invite();
    now += 10 * 60 * 1000;
    expect((await run(command(late.link), "yes\n")).out).toBe(
      tail(commandExpired("MacBook Pro")).join("\n"),
    );
    expect(existsSync(record)).toBe(false);
  });

  it("reads every value as words, so a Mac's name cannot change what runs", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const name = `Sam's "$(touch /tmp/x)" \`id\` Mac`;
    const { out } = await run(joinCommand({ ...MAC, link: invite.link, homeName: name }), "no\n");
    expect(out.split("\n")[0]).toBe(macAsk(name, ME)[0]);
  });
});

/**
 * The command downloads this Mac's published version there first (INF-322,
 * the captain's direction B with Add as well as Update): from a stand-in
 * release over local HTTPS, which the Mac's own curl trusts here alone, its
 * SHA-256 and unpacking real, and the publisher check, which no stand-in app
 * passes, stood in where the command names codesign. Only a Mac downloads;
 * the words and the check before it are the command's own.
 */
describe.runIf(process.platform === "darwin")(
  "the command that adds another Mac, when this Mac's version is published",
  () => {
    /** This Mac's version as its release publishes it, its app marked so a test tells it from the home's. */
    async function published(record: string, paceMs = 0, payload = 0) {
      const app = standInBundle(record);
      writeFileSync(join(app, "Contents", "Resources", "marker"), "the published copy\n");
      // Incompressible bytes, so the release states a size worth reserving time for.
      if (payload)
        writeFileSync(join(app, "Contents", "Resources", "payload"), randomBytes(payload));
      const release = await macRelease(app, "0.13.0", paceMs);
      releases.push(release);
      return release;
    }
    const releases: Awaited<ReturnType<typeof macRelease>>[] = [];
    afterEach(async () => {
      await Promise.all(releases.splice(0).map((release) => release.stop()));
    });

    /** The command for an invite, downloading from `release` until `expiresAt`, its publisher check stood in. */
    function command(
      link: string,
      release: Awaited<ReturnType<typeof macRelease>>,
      expiresAt = Date.now() + 10 * 60_000,
    ): string {
      const text = joinCommand({
        for: "another-mac",
        link,
        homeName: "MacBook Pro",
        launcher: LAUNCHER,
        version: VERSION,
        download: {
          url: release.downloads[release.publicUrl] ?? "",
          sha256: release.sha256,
          expiresAt,
        },
        // The line that updates a Linux computer's package, as long as its release names it.
        update: UPDATE_LINE,
      });
      let stoodIn = text;
      for (const [from, to] of Object.entries(release.programs))
        stoodIn = stoodIn.split(from).join(to);
      return stoodIn;
    }
    const trusting = (release: { cert: string }) => ({ CURL_CA_BUNDLE: release.cert });
    /** What Terminal shows once each count rewrote the line before it. */
    const shown = (out: string) =>
      out
        .split("\n")
        .map((line) => line.split("\r").at(-1)?.replace("\x1b[K", "") ?? "")
        .join("\n");

    it("asks first, downloads it there with its count, checks it, and joins with it, getting nothing from this Mac", async () => {
      const record = join(scratchDir("infinitary-command-record-"), "started");
      const at = await home({
        bundle: standInBundle(join(scratchDir("infinitary-command-home-"), "x")),
      });
      const release = await published(record, 100);
      const invite = await at.invite();
      const text = command(invite.link, release);
      // As long as a command may be, and still one line.
      expect(() =>
        deviceInviteSchema.parse({ ...invite, command: { for: "another-mac", text } }),
      ).not.toThrow();
      expect(text).not.toContain("\n");

      const { out, code } = await run(text, "yes\n", macUname(), trusting(release));
      expect(code).toBe(0);
      const total = fileSizeWords(release.size);
      expect(shown(out)).toBe(
        [
          ...macAsk("MacBook Pro", ME),
          `${COMMAND_DOWNLOADING} ${total} of ${total}, done.`,
          "Joined (stand-in).",
          "",
        ].join("\n"),
      );
      // Each count rewrote the one line, toward the release's own size.
      const erase = "\x1b[K";
      const counts = out
        .split("\r")
        .filter((piece) => piece.startsWith(erase))
        .map((piece) => piece.slice(erase.length).split("\n")[0] ?? "");
      expect(counts.length).toBeGreaterThan(1);
      for (const count of counts) {
        expect(count.startsWith(`${COMMAND_DOWNLOADING} `)).toBe(true);
        expect(count).toContain(` of ${total}`);
      }
      const [, , , bundle, link, marker] = readFileSync(record, "utf8").split("\n");
      expect([link, marker]).toEqual([invite.link, "the published copy"]);
      expect(existsSync(bundle ?? "")).toBe(false);
      // The home only said its code was open: nothing of it was sent, and the code is unspent.
      expect(at.fetched()).toBe(0);
      expect(release.requests()).toBe(1);
      expect(release.verifications()).toHaveLength(1);
      expect(at.pairing.opened({ code: parsePairingLink(invite.link).code })).toBeNull();
    });

    it.each([
      ["did not match", "corrupt", true],
      ["could not be got", "fail", false],
    ] as const)("gets this Mac's copy at once when the download %s", async (_, mode, mismatch) => {
      const record = join(scratchDir("infinitary-command-record-"), "started");
      const at = await home({ bundle: standInBundle(record) });
      const release = await published(join(scratchDir("infinitary-command-release-"), "x"));
      release.mode(mode);
      const invite = await at.invite();
      const { out, code } = await run(
        command(invite.link, release),
        "yes\n",
        macUname(),
        trusting(release),
      );
      expect(code).toBe(0);
      const lines = shown(out).split("\n");
      expect(lines.slice(-4)).toEqual([
        commandDownloadFallback("MacBook Pro", mismatch),
        "Getting Infinitary from MacBook Pro… done.",
        "Joined (stand-in).",
        "",
      ]);
      expect(readFileSync(record, "utf8").split("\n")[5]).toBe("the home's own copy");
      expect(at.fetched()).toBe(1);
    });

    // INF-369 F2, the captain's choice: reserve time sized to the copy, so a slow network still finishes.
    describe("keeps time sized to the copy for getting it from this Mac", () => {
      /** A minute to join, and 20 MiB at the slowest copy rate the reserve allows for: 80 seconds in all. */
      const SIZE = 20 * 1024 * 1024;
      const RESERVE_MS = (60 + SIZE / (1024 * 1024)) * 1000;

      it("stops downloading once only that is left of its link, and gets this Mac's copy in time", async () => {
        const record = join(scratchDir("infinitary-command-record-"), "started");
        const at = await home({ bundle: standInBundle(record) });
        const release = await published(
          join(scratchDir("infinitary-command-release-"), "x"),
          0,
          SIZE,
        );
        release.mode("hang");
        const invite = await at.invite();
        // Ten seconds short of the reserve: its download stops once it hears the size.
        const { out, code } = await run(
          command(invite.link, release, Date.now() + RESERVE_MS - 10_000),
          "yes\n",
          macUname(),
          trusting(release),
        );
        expect(code).toBe(0);
        expect(shown(out)).toContain(
          [
            commandDownloadFallback("MacBook Pro", false),
            "Getting Infinitary from MacBook Pro… done.",
          ].join("\n"),
        );
        // The stalled transfer went with the command's downloader.
        await expect.poll(() => release.active()).toBe(0);
      });

      it("downloads while more is left than a copy of its size needs, though under two minutes", async () => {
        const record = join(scratchDir("infinitary-command-record-"), "started");
        const at = await home({
          bundle: standInBundle(join(scratchDir("infinitary-command-home-"), "x")),
        });
        const release = await published(record, 0, SIZE);
        const invite = await at.invite();
        // Thirty seconds beyond the reserve, and under the two minutes a fixed reserve kept.
        const { out, code } = await run(
          command(invite.link, release, Date.now() + RESERVE_MS + 30_000),
          "yes\n",
          macUname(),
          trusting(release),
        );
        expect(code).toBe(0);
        const total = fileSizeWords(release.size);
        expect(shown(out)).toContain(`${COMMAND_DOWNLOADING} ${total} of ${total}, done.`);
        expect(readFileSync(record, "utf8").split("\n")[5]).toBe("the published copy");
        expect(at.fetched()).toBe(0);
      });
    });

    // INF-369 N1, the captain's choice: links for commands that download last longer from the start.
    it("downloads today's 401 MB app where a ten-minute link would already have fallen back", async () => {
      /** Infinitary 0.4.2-alpha.3's universal zip, as its release states it (INF-322). */
      const TODAYS_APP_BYTES = 420_615_960;
      // Made 140 seconds ago: a ten-minute link would keep too little of what
      // is left for a copy of this size from this Mac, so it would stop at once.
      const at = await home({
        now: () => Date.now() - 140_000,
        bundle: standInBundle(join(scratchDir("infinitary-command-home-"), "x")),
      });
      const release = await published(join(scratchDir("infinitary-command-release-"), "x"));
      release.mode("hang");
      release.stateSize(TODAYS_APP_BYTES);
      const invite = await at.invite(DOWNLOAD_COMMAND_LINK_TTL_MS);
      const total = fileSizeWords(TODAYS_APP_BYTES);
      let counts = 0;
      const ran = run(
        command(invite.link, release, invite.expiresAt),
        "yes\n",
        macUname(),
        trusting(release),
        (out) => {
          counts = out.split("\r").filter((piece) => piece.includes(` of ${total}`)).length;
        },
      );
      // It goes on counting toward the app's own size, with no fallback yet.
      await expect.poll(() => counts, { timeout: 8_000 }).toBeGreaterThan(2);
      // The download stops here, as a dropped connection would end it.
      await release.stop();
      const { out, code } = await ran;
      expect(code).toBe(0);
      const said = shown(out).split("\n");
      expect(said).toContain(commandDownloadFallback("MacBook Pro", false));
      expect(out.indexOf(commandDownloadFallback("MacBook Pro", false))).toBeGreaterThan(
        out.lastIndexOf(` of ${total}`),
      );
    });

    it("says a command was used or expired before it downloads anything", async () => {
      let now = 1_000_000;
      const record = join(scratchDir("infinitary-command-record-"), "started");
      const at = await home({ now: () => now, bundle: standInBundle(record) });
      const release = await published(join(scratchDir("infinitary-command-release-"), "x"));
      const said = (lines: readonly string[]) =>
        [
          ...macAsk("MacBook Pro", ME),
          `Type yes to agree: ${lines[0]}`,
          ...lines.slice(1),
          "",
        ].join("\n");

      const used = await at.invite();
      await claimLink(used.link, {
        kind: "work",
        name: "Another Mac",
        user: { name: "sam", uid: (process.getuid?.() ?? 0) + 1000 },
      });
      expect(
        (await run(command(used.link, release), "yes\n", macUname(), trusting(release))).out,
      ).toBe(said(commandUsed("MacBook Pro")));

      // A command that downloads carries a link that lasts longer, and says so once it expired.
      const late = await at.invite(DOWNLOAD_COMMAND_LINK_TTL_MS);
      now += DOWNLOAD_COMMAND_LINK_TTL_MS;
      expect(
        (await run(command(late.link, release), "yes\n", macUname(), trusting(release))).out,
      ).toBe(said(commandExpired("MacBook Pro", DOWNLOAD_COMMAND_LINK_TTL_MS)));
      expect(release.requests()).toBe(0);
      expect(at.fetched()).toBe(0);
      expect(existsSync(record)).toBe(false);
    });
  },
);

describe("the command run on a Linux computer", () => {
  /** A Linux computer's own files the command reads, none of them there unless a test writes them. */
  function linuxFiles() {
    const dir = scratchDir("infinitary-command-linux-files-");
    return {
      record: scratchDir("infinitary-command-linux-record-"),
      linux: { osRelease: join(dir, "os-release"), packageBin: join(dir, "infinitary") },
    };
  }
  const recorded = (record: string, name: string) =>
    existsSync(join(record, name))
      ? readFileSync(join(record, name), "utf8").trim().split("\n")
      : [];

  it("stops before anything where the AppImage would run without its sandbox, and asks as before where it would not", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const files = linuxFiles();
    const command = joinCommand({ ...MAC, link: invite.link, linux: files.linux });

    const off = await run(
      command,
      "yes\n",
      linuxTools({ namespaces: false, record: files.record }),
    );
    expect(off.code).toBe(1);
    expect(off.out).toBe([...sandboxOff(), ""].join("\n"));
    expect(at.fetched()).toBe(0);
    expect(existsSync(record)).toBe(false);

    const on = await run(command, "no\n", linuxTools({ record: files.record }));
    expect(on.code).toBe(1);
    expect(on.out).toBe(
      [
        ...macAsk("MacBook Pro", ME),
        "Type yes to agree: Nothing changed on this computer.",
        "",
      ].join("\n"),
    );
    expect(at.fetched()).toBe(0);
  });

  // INF-1181's accepted plan: on other Linux, the command names what is missing before asking yes.
  it("names the libraries the AppImage lacks, with the one apt line that installs them, before it asks or gets anything", async () => {
    const at = await home({
      bundle: standInBundle(join(scratchDir("infinitary-command-x-"), "x")),
    });
    const invite = await at.invite();
    const files = linuxFiles();
    const { out, code } = await run(
      joinCommand({ ...MAC, link: invite.link, linux: files.linux }),
      "yes\n",
      linuxTools({
        lacks: ["libfuse.so.2", "libgbm.so.1"],
        apt: { t64: true },
        record: files.record,
      }),
    );
    expect(code).toBe(1);
    const install = `sudo apt-get install -y ${LINUX_NEEDS.libfuse.t64} ${LINUX_NEEDS.gbm.apt}`;
    expect(out).toBe([...commandNeeds("MacBook Pro", "", install), ""].join("\n"));
    expect(at.fetched()).toBe(0);
  });

  // INF-1181's accepted plan: an installed Infinitary joins with no download; after it joins,
  // the work keeps running after logout, or the join names the one sudo line (captain's "linger" pick).
  it.each([
    ["keeps its work on after logout where systemd lets it", "allowed", true],
    ["names the one sudo line where systemd does not let it", "refused", false],
  ] as const)(
    "joins with an Infinitary installed there, gets nothing, and %s",
    async (_, linger, on) => {
      const at = await home({
        bundle: standInBundle(join(scratchDir("infinitary-command-x-"), "x")),
      });
      const invite = await at.invite();
      const files = linuxFiles();
      writeFileSync(files.linux.packageBin, packageProgram(VERSION, join(files.record, "joined")), {
        mode: 0o755,
      });
      const { out, code } = await run(
        joinCommand({ ...MAC, link: invite.link, linux: files.linux }),
        "",
        linuxTools({ linger, record: files.record }),
      );
      expect(code).toBe(0);
      // The installed copy asks its own yes; the command asks nothing of its own.
      expect(out).toBe(["Joined (stand-in).", ...afterLogout(ME, on), ""].join("\n"));
      expect(recorded(files.record, "joined")).toEqual(["work", "join", invite.link]);
      expect(at.fetched()).toBe(0);
    },
  );

  // INF-1241's R4: the after-logout line is about work in the background, so where the join
  // set none up, or setting it up failed, the command says nothing about after logout.
  it.each(["failed", "none"] as const)(
    "says nothing about after logout where the join's work is not in the background (%s)",
    async (background) => {
      const at = await home({
        bundle: standInBundle(join(scratchDir("infinitary-command-x-"), "x")),
      });
      const invite = await at.invite();
      const files = linuxFiles();
      writeFileSync(
        files.linux.packageBin,
        packageProgram(VERSION, join(files.record, "joined"), background),
        { mode: 0o755 },
      );
      const { out, code } = await run(
        joinCommand({ ...MAC, link: invite.link, linux: files.linux }),
        "",
        linuxTools({ linger: "allowed", record: files.record }),
      );
      expect(code).toBe(0);
      expect(out).toBe(["Joined (stand-in).", ""].join("\n"));
      expect(recorded(files.record, "loginctl")).toEqual([]);
    },
  );

  // INF-1181, the captain's "version" pick: stop and print the one line that updates the package.
  it.each([
    ["the line that updates its Ubuntu package", true],
    ["the version alone where no Ubuntu package installed it", false],
  ] as const)(
    "stops when the Infinitary installed there is another version, naming %s",
    async (_, dpkg) => {
      const at = await home({
        bundle: standInBundle(join(scratchDir("infinitary-command-x-"), "x")),
      });
      const invite = await at.invite();
      const files = linuxFiles();
      writeFileSync(
        files.linux.packageBin,
        packageProgram("0.12.0", join(files.record, "joined")),
        { mode: 0o755 },
      );
      const update = UPDATE_LINE;
      const { out, code } = await run(
        joinCommand({ ...MAC, link: invite.link, linux: files.linux, update }),
        "",
        linuxTools({ dpkg, record: files.record }),
      );
      expect(code).toBe(1);
      expect(out).toBe(
        [...otherVersion("MacBook Pro", VERSION, dpkg ? update : null), ""].join("\n"),
      );
      expect(existsSync(join(files.record, "joined"))).toBe(false);
      expect(at.fetched()).toBe(0);
    },
  );

  describe("on Ubuntu 24.04 with no Infinitary", () => {
    /** A home that sends the Ubuntu package it was asked for, and an Ubuntu computer that lacks it. */
    async function ubuntu(
      sudo: "free" | "password" | "no",
      linger?: "none",
      also: { swaps?: boolean; aptFails?: "part" | "needs"; joinExits?: number } = {},
    ) {
      const deb = join(scratchDir("infinitary-command-deb-"), "infinitary.deb");
      writeFileSync(deb, "the home's Ubuntu package\n");
      const asked: (string | undefined)[] = [];
      const at = await home({
        bundle: standInBundle(join(scratchDir("infinitary-command-x-"), "x")),
        build: async (system, chip, kind) => {
          asked.push(`${system} ${chip} ${kind}`);
          if (kind !== "deb") return null;
          const sha256 = createHash("sha256").update(readFileSync(deb)).digest("hex");
          return { form: "deb", path: deb, sha256 };
        },
      });
      const invite = await at.invite();
      const files = linuxFiles();
      writeFileSync(files.linux.osRelease, 'ID=ubuntu\nVERSION_ID="24.04"\n');
      const tools = linuxTools({
        apt: { t64: true, ...(also.aptFails ? { fails: also.aptFails } : {}) },
        sudo,
        ...(also.swaps ? { swaps: true } : {}),
        installs: {
          program: files.linux.packageBin,
          version: VERSION,
          ...(also.joinExits ? { exit: also.joinExits } : {}),
        },
        record: files.record,
        ...(linger ? { linger } : {}),
      });
      const command = joinCommand({ ...MAC, link: invite.link, linux: files.linux });
      return { at, asked, invite, files, tools, command };
    }

    it("asks, gets the Ubuntu package from this computer, installs it with the account's password, and joins with it", async () => {
      const { at, asked, invite, files, tools, command } = await ubuntu("password");
      const { out, code } = await run(command, "yes\nsecret\n", tools);
      expect(code).toBe(0);
      expect(out).toBe(
        [
          ...macAsk("MacBook Pro", ME),
          "Type yes to agree: Getting Infinitary from MacBook Pro… done.",
          COMMAND_INSTALLING,
          "Joined (stand-in).",
          // The install turned linger on in the same sudo step.
          ...afterLogout(ME, true),
          "",
        ].join("\n"),
      );
      expect(asked).toEqual(["linux x64 deb"]);
      // apt installed the package this computer sent, checked again before it did.
      expect(readFileSync(join(files.record, "installed.deb"), "utf8")).toBe(
        "the home's Ubuntu package\n",
      );
      expect(recorded(files.record, "loginctl")).toContain(`enable-linger ${ME}`);
      // Its own program joined, asking nothing again.
      expect(recorded(files.record, "joined")).toEqual(["work", "join", "--agreed", invite.link]);
      expect(at.fetched()).toBe(1);
    });

    // INF-1194's live run: on Ubuntu 24.04 with no systemd running, apt had installed the
    // package when linger failed, and the command said nothing was installed.
    it("installs and joins where systemd does not run, then names the one sudo line for after logout", async () => {
      const { invite, files, tools, command } = await ubuntu("free", "none");
      const { out, code } = await run(command, "yes\n", tools);
      expect(code).toBe(0);
      expect(out).toBe(
        [
          ...macAsk("MacBook Pro", ME),
          "Type yes to agree: Getting Infinitary from MacBook Pro… done.",
          COMMAND_INSTALLING,
          "Joined (stand-in).",
          ...afterLogout(ME, false),
          "",
        ].join("\n"),
      );
      expect(recorded(files.record, "joined")).toEqual(["work", "join", "--agreed", invite.link]);
    });

    it("stops with nothing installed on a wrong password", async () => {
      const { files, tools, command } = await ubuntu("password");
      const { out, code } = await run(command, "yes\nwrong\n", tools);
      expect(code).toBe(1);
      // sudo's own words go to stderr, which reaches the same terminal in its own time.
      expect(out).toContain(COMMAND_INSTALLING);
      expect(out).toContain(commandInstallFailed().join("\n"));
      expect(recorded(files.record, "apt-get")).toEqual([]);
      expect(existsSync(files.linux.packageBin)).toBe(false);
    });

    // Review INF-1241 R2: the fetched package sits in this account's own folder while sudo
    // asks the password, so root installs only its own copy, and only if it matches.
    it("installs nothing where the package changed while sudo asked the password", async () => {
      const { files, tools, command } = await ubuntu("password", undefined, { swaps: true });
      const { out, code } = await run(command, "yes\nsecret\n", tools);
      expect(code).toBe(1);
      expect(out).toContain(commandInstallFailed().join("\n"));
      expect(recorded(files.record, "apt-get")).toEqual([]);
      expect(existsSync(files.linux.packageBin)).toBe(false);
      expect(recorded(files.record, "joined")).toEqual([]);
    });

    // Review INF-1241 R3: apt can stop after dpkg unpacked part of the package.
    it("says part of it stays installed, with the line that removes it, where apt stopped part way", async () => {
      const { files, tools, command } = await ubuntu("free", undefined, { aptFails: "part" });
      const { out, code } = await run(command, "yes\n", tools);
      expect(code).toBe(1);
      expect(out).toContain(commandInstallFailed("part").join("\n"));
      expect(out).not.toContain(commandInstallFailed().join("\n"));
      expect(recorded(files.record, "joined")).toEqual([]);
    });

    // Review INF-1241 at fdfbdd6: apt can install what the package needs, then stop before
    // it unpacks the package, which leaves no record of the package itself.
    it("says the packages it needs stay installed where apt stopped before it unpacked the package", async () => {
      const { files, tools, command } = await ubuntu("free", undefined, { aptFails: "needs" });
      const { out, code } = await run(command, "yes\n", tools);
      expect(code).toBe(1);
      expect(out).toContain(commandInstallFailed("needs").join("\n"));
      expect(out).not.toContain(commandInstallFailed().join("\n"));
      expect(recorded(files.record, "joined")).toEqual([]);
    });

    // Review INF-1241 R3: a join that stops after the install leaves the package and linger on.
    it("names how to turn linger off again where the join stops after the install turned it on", async () => {
      const { files, tools, command } = await ubuntu("password", undefined, { joinExits: 1 });
      const { out, code } = await run(command, "yes\nsecret\n", tools);
      expect(code).toBe(1);
      expect(out).toBe(
        [
          ...macAsk("MacBook Pro", ME),
          "Type yes to agree: Getting Infinitary from MacBook Pro… done.",
          COMMAND_INSTALLING,
          "Did not join (stand-in).",
          ...lingerStays(ME),
          "",
        ].join("\n"),
      );
      expect(existsSync(files.linux.packageBin)).toBe(true);
    });

    it("stops before it asks where the account cannot install software", async () => {
      const { at, asked, files, tools, command } = await ubuntu("no");
      const { out, code } = await run(command, "yes\n", tools);
      expect(code).toBe(1);
      expect(out).toBe([...commandCannotInstall(), ""].join("\n"));
      expect(asked).toEqual([]);
      expect(at.fetched()).toBe(0);
      expect(existsSync(files.linux.packageBin)).toBe(false);
    });
  });
});

describe("the command that runs work as another user on this Mac", () => {
  it("starts this Mac's own app in its work mode with the link", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const bundle = standInBundle(record);
    const at = await home();
    const invite = await at.invite();
    const command = joinCommand({
      for: "another-user",
      link: invite.link,
      homeName: "MacBook Pro",
      launcher: { executable: join(bundle, "Contents", "MacOS", "Firstmate 3000"), args: [] },
      version: VERSION,
    });
    expect(command).toBe(
      [join(bundle, "Contents", "MacOS", "Firstmate 3000"), "work", "join", invite.link]
        .map(shellWord)
        .join(" "),
    );
    const { code } = await run(command, "");
    expect(code).toBe(0);
    expect(readFileSync(record, "utf8").split("\n").slice(0, 3)).toEqual([
      "work",
      "join",
      invite.link,
    ]);
    expect(at.fetched()).toBe(0);
  });
});

describe("getting Firstmate from this Mac", () => {
  /** One request to the fetch path, as a client that checks nothing; answers its status and body. */
  function fetchApp(
    at: string,
    options: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: string }> {
    const [host, port] = at.split(":");
    return new Promise((resolve, reject) => {
      const asked = request(
        {
          host,
          port: Number(port),
          method: options.method ?? "POST",
          path: FETCH_APP_PATH,
          rejectUnauthorized: false,
          headers: { "content-type": "application/json", ...options.headers },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("latin1"),
            }),
          );
        },
      );
      asked.once("error", reject);
      asked.end(options.body ?? "");
    });
  }

  it("sends the app only for an open link made for a computer that runs work, and never spends it", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const code = parsePairingLink(invite.link).code;
    const sent = await fetchApp(at.at, { body: JSON.stringify({ code }) });
    expect(sent.status).toBe(200);
    // A gzip stream: its first two bytes.
    expect(sent.body.charCodeAt(0)).toBe(0x1f);
    expect(sent.body.charCodeAt(1)).toBe(0x8b);
    expect(at.pairing.opened({ code })).toBeNull();

    const view = at.pairing.invite({ kind: "view", at: at.at });
    const viewCode = parsePairingLink(view.link).code;
    expect(await fetchApp(at.at, { body: JSON.stringify({ code: viewCode }) })).toMatchObject({
      status: 409,
    });
    expect(await fetchApp(at.at, { body: JSON.stringify({ code: "C".repeat(43) }) })).toMatchObject(
      { status: 401 },
    );
    expect(await fetchApp(at.at, { body: JSON.stringify({ code: 7 }) })).toMatchObject({
      status: 400,
    });
    // With no code, only a computer already on the list gets it, by its key.
    expect(await fetchApp(at.at, { body: "{}" })).toMatchObject({ status: 401 });
    expect(await fetchApp(at.at, { method: "GET" })).toMatchObject({ status: 405 });
    expect(
      await fetchApp(at.at, { body: JSON.stringify({ code }), headers: { origin: "https://x" } }),
    ).toMatchObject({ status: 403 });
    expect(
      await fetchApp(at.at, {
        body: JSON.stringify({ code }),
        headers: { "content-type": "text/plain" },
      }),
    ).toMatchObject({ status: 415 });
    // No refusal echoes the code.
    for (const body of [
      JSON.stringify({ code: viewCode }),
      JSON.stringify({ code: "C".repeat(43) }),
    ])
      expect((await fetchApp(at.at, { body })).body).not.toContain(viewCode);
  });

  it("says when this copy cannot send itself", async () => {
    const at = await home({ bundle: null });
    const invite = await at.invite();
    const answer = await fetchApp(at.at, {
      body: JSON.stringify({ code: parsePairingLink(invite.link).code }),
    });
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ refused: "none" });
  });
});
