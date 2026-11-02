import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateChannel } from "@shared/update";
import {
  type BuildDownload,
  isLinuxPackage,
  type LinuxPackage,
  UPDATE_CHANNEL_MARKER,
  type UpdateChannelMarker,
} from "./updateChannels";

/**
 * How an installed Linux app updates itself (docs/alpha.md "Updates on
 * Linux"). The one update reader (`updateChecker.ts`) offers its channel's
 * build for this computer's chip and package; this module names which
 * package this installation is, and installs an offered build: a deb or an
 * rpm through the system's installer after the system asks for the
 * person's password, an AppImage in place with no password. An Arch or
 * NixOS installation updates through its own package manager, so the
 * notice names the command instead and nothing here runs for it.
 */

/**
 * The file each package carries in the app's resources folder naming what
 * it is: electron-builder.linux.yml adds it to the deb and the rpm, and the
 * Arch recipe and the Nix package write their own. An AppImage is told by
 * its runtime instead (`APPIMAGE`).
 */
export const PACKAGE_TYPE_FILE = "package-type";

/** This installation, as the update reader keys the builds file. */
export type LinuxInstallation = {
  /** `x64` or `arm64`: the builds file's chip. */
  chip: string;
  /** Which package installed the app; null when it is none Firstmate knows. */
  package: LinuxPackage | null;
  /** The AppImage file the app runs from, for an AppImage. */
  appImage?: string;
};

/**
 * Which Linux package this app was installed from. The AppImage runtime
 * sets `APPIMAGE` to the file and `APPDIR` to where it mounted it, which
 * the running program lives under; a package names itself in its resources
 * folder. A development run names nothing unless `override` stands in for
 * a package (only an unpackaged run passes one).
 */
export function readLinuxInstallation(options: {
  chip: string;
  resourcesDir: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
  override?: string | undefined;
}): LinuxInstallation {
  const { chip, env } = options;
  const appImage = env.APPIMAGE?.trim();
  const runsFromAppImage =
    !!appImage &&
    isAbsolute(appImage) &&
    isFile(appImage) &&
    (options.override === "appimage" ||
      (!!env.APPDIR && options.execPath.startsWith(`${env.APPDIR.replace(/\/+$/, "")}/`)));
  if (options.override !== undefined) {
    const named = options.override.trim();
    if (named === "appimage") {
      return runsFromAppImage ? { chip, package: "appimage", appImage } : { chip, package: null };
    }
    return { chip, package: isLinuxPackage(named) ? named : null };
  }
  if (runsFromAppImage) return { chip, package: "appimage", appImage };
  try {
    const named = readFileSync(join(options.resourcesDir, PACKAGE_TYPE_FILE), "utf8").trim();
    return { chip, package: isLinuxPackage(named) && named !== "appimage" ? named : null };
  } catch {
    return { chip, package: null };
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Quotes one word for a POSIX shell. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The selectable command that installs an offered build by hand: what an
 * Arch or NixOS notice shows, and what a deb, rpm or AppImage notice shows
 * when installing from the app could not finish. Every command checks the
 * build's published checksum before anything installs it.
 */
export function linuxUpdateCommand(
  installation: LinuxInstallation,
  download: BuildDownload,
): string | null {
  const url = shellWord(download.url);
  const name = shellWord(basename(new URL(download.url).pathname));
  const check = (file: string) => `printf '%s  %s\\n' ${download.sha256} ${file} | sha256sum -c`;
  switch (installation.package) {
    case "deb":
      return `cd "$(mktemp -d)" && curl -fLO ${url} && ${check(`./${name}`)} && sudo apt-get install -y ./${name}`;
    case "rpm":
      return `cd "$(mktemp -d)" && curl -fLO ${url} && ${check(`./${name}`)} && sudo dnf install -y ./${name}`;
    case "appimage": {
      if (!installation.appImage) return null;
      const next = shellWord(`${installation.appImage}.new`);
      return `curl -fL -o ${next} ${url} && ${check(next)} && chmod +x ${next} && mv ${next} ${shellWord(installation.appImage)}`;
    }
    case "arch":
      return `cd "$(mktemp -d)" && curl -fL -o PKGBUILD ${url} && ${check("PKGBUILD")} && makepkg -si`;
    case "nix":
      return `nix-env -iE '_: (import <nixpkgs> {}).callPackage (builtins.fetchurl { url = "${download.url}"; sha256 = "${download.sha256}"; }) {}'`;
    default:
      return null;
  }
}

/** The packages the app installs itself, and whether the system asks for a password first. */
export const INSTALLS_IN_APP: Partial<Record<LinuxPackage, { asksPassword: boolean }>> = {
  deb: { asksPassword: true },
  rpm: { asksPassword: true },
  appimage: { asksPassword: false },
};

/** One offered build the app installs: what it is, where it comes from, and the channel it is from. */
export type LinuxInstallPlan = {
  package: LinuxPackage;
  version: string;
  channel: UpdateChannel;
  download: BuildDownload;
  /** The file an AppImage installation replaces. */
  appImage?: string;
};

/** Why an update did not install, in words the update panel shows as they are. */
export class UpdateInstallProblem extends Error {
  override name = "UpdateInstallProblem";
}

/**
 * What runs as the superuser after the system asked for the person's
 * password: it copies the downloaded package into a folder only the
 * superuser can write, checks that copy's checksum again - so the bytes it
 * installs are the bytes that were checked - and hands it to the system's
 * own installer, which brings anything the package depends on.
 */
const PRIVILEGED_INSTALL = `set -eu
src=$1
sum=$2
kind=$3
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
pkg="$dir/infinitary.$kind"
cp "$src" "$pkg"
chmod 0755 "$dir"
chmod 0644 "$pkg"
printf '%s  %s\\n' "$sum" "$pkg" | sha256sum -c --status || exit 65
case $kind in
  deb)
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$pkg"
    else
      dpkg -i "$pkg"
    fi ;;
  rpm)
    if command -v dnf >/dev/null 2>&1; then
      dnf install -y "$pkg"
    else
      rpm -U --oldpackage "$pkg"
    fi ;;
  *) exit 64 ;;
esac
`;

/** pkexec's own exit codes: the person dismissed the prompt, or no prompt could be shown. */
const PROMPT_DISMISSED = 126;
const NO_PROMPT = 127;
const CHECKSUM_MISMATCH = 65;

export type LinuxInstallerOptions = {
  /** The run's own userData: the downloads folder and the channel marker. */
  dataRoot: string;
  fetchImpl: typeof fetch;
  /** Every child's environment (`hostEnv`). */
  env: () => NodeJS.ProcessEnv;
  /** Quits and starts the app again, from `execPath` when the program moved. */
  relaunch: (execPath?: string) => void;
  spawnImpl?: typeof spawn;
};

/**
 * The installer an update notice runs. It downloads the offered build,
 * refuses bytes whose checksum is not the published one, installs them,
 * remembers the channel it installed from - so an alpha installation that
 * took a stable version stays on alpha - and starts the new version.
 */
export function createLinuxInstaller(
  options: LinuxInstallerOptions,
): (plan: LinuxInstallPlan, beforeReplace?: () => Promise<void>) => Promise<void> {
  const spawnImpl = options.spawnImpl ?? spawn;

  async function download(plan: LinuxInstallPlan, file: string): Promise<void> {
    let response: Response;
    try {
      response = await options.fetchImpl(plan.download.url, {
        headers: { "User-Agent": "infinitary" },
        redirect: "follow",
      });
    } catch {
      throw new UpdateInstallProblem(
        "Infinitary could not reach the download. Check your connection and try again.",
      );
    }
    if (!response.ok || !response.body) {
      throw new UpdateInstallProblem(
        `The download did not start (the server answered ${response.status}). Try again later.`,
      );
    }
    const hash = createHash("sha256");
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        hashing,
        createWriteStream(file, { mode: 0o600 }),
      );
    } catch (caught) {
      await rm(file, { force: true });
      const code = (caught as NodeJS.ErrnoException).code;
      throw new UpdateInstallProblem(
        code === "EACCES" || code === "EROFS" || code === "EPERM"
          ? `Infinitary cannot write in ${dirname(file)}. Move the app to a folder you own, such as your home folder, and try again.`
          : "The download stopped before it finished. Try again.",
      );
    }
    if (hash.digest("hex") !== plan.download.sha256) {
      await rm(file, { force: true });
      throw new UpdateInstallProblem(
        "The download did not match its published checksum, so nothing was installed.",
      );
    }
  }

  function runPrivileged(file: string, plan: LinuxInstallPlan): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(
        "pkexec",
        [
          "/bin/sh",
          "-c",
          PRIVILEGED_INSTALL,
          "infinitary-update",
          file,
          plan.download.sha256,
          plan.package,
        ],
        { env: options.env(), stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
      });
      child.once("error", (caught: NodeJS.ErrnoException) => {
        reject(
          new UpdateInstallProblem(
            caught.code === "ENOENT"
              ? "This computer has no way to ask for your password, so nothing was installed."
              : "The system's installer could not start, so nothing was installed.",
          ),
        );
      });
      child.once("close", (code) => {
        if (code === 0) return resolve();
        if (code === PROMPT_DISMISSED) {
          return reject(
            new UpdateInstallProblem("The password prompt was closed, so nothing was installed."),
          );
        }
        if (code === NO_PROMPT) {
          return reject(
            new UpdateInstallProblem(
              "This computer could not ask for your password, so nothing was installed.",
            ),
          );
        }
        if (code === CHECKSUM_MISMATCH) {
          return reject(
            new UpdateInstallProblem(
              "The download did not match its published checksum, so nothing was installed.",
            ),
          );
        }
        const said = stderr
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);
        reject(
          new UpdateInstallProblem(
            `The system's installer stopped, so nothing changed.${said ? ` It said: ${said}` : ""}`,
          ),
        );
      });
    });
  }

  async function rememberChannel(plan: LinuxInstallPlan): Promise<void> {
    const marker: UpdateChannelMarker = {
      schemaVersion: 1,
      channel: plan.channel,
      version: plan.version,
    };
    const path = join(options.dataRoot, UPDATE_CHANNEL_MARKER);
    const temporary = `${path}.${randomBytes(6).toString("hex")}`;
    await writeFile(temporary, `${JSON.stringify(marker)}\n`);
    await rename(temporary, path);
  }

  // `beforeReplace` runs once the download is checked and before anything
  // is replaced (docs/alpha.md, "Saving work before an update"); a throw
  // there replaces nothing.
  return async (plan, beforeReplace) => {
    if (plan.package === "deb" || plan.package === "rpm") {
      const folder = join(options.dataRoot, "updates");
      await rm(folder, { recursive: true, force: true });
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const file = join(folder, basename(new URL(plan.download.url).pathname));
      await download(plan, file);
      try {
        await beforeReplace?.();
        await runPrivileged(file, plan);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
      await rememberChannel(plan);
      options.relaunch();
      return;
    }
    if (plan.package === "appimage") {
      const target = plan.appImage;
      if (!target || !existsSync(target)) {
        throw new UpdateInstallProblem(
          "Infinitary cannot find the AppImage it runs from, so nothing was installed.",
        );
      }
      // Beside the file it replaces, so the swap is one rename on one disk.
      const file = join(
        dirname(target),
        `.${basename(target)}.${randomBytes(6).toString("hex")}.download`,
      );
      await download(plan, file);
      try {
        await beforeReplace?.();
      } catch (caught) {
        await rm(file, { force: true });
        throw caught;
      }
      try {
        await chmod(file, 0o755);
        await rename(file, target);
      } catch {
        await rm(file, { force: true });
        throw new UpdateInstallProblem(
          `Infinitary cannot replace ${target}. Move it to a folder you own, such as your home folder, and try again.`,
        );
      }
      await rememberChannel(plan);
      options.relaunch(target);
      return;
    }
    throw new UpdateInstallProblem("This installation updates from the terminal.");
  };
}
