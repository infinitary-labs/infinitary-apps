import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DeviceChip } from "@shared/devices";
import { BUILDS_FILE, BUILDS_URL, parseBuilds } from "../update/releaseBuilds";
import { PUBLIC_RELEASE_NAMES, publicBuildsUrl } from "../update/releaseSource";
import { buildDownloadUrl, INFINITARY_TAP, publicTagFor, TAP_REPO } from "../update/updateChannels";
import { LINUX_APP_FILE } from "./farSystems";

/**
 * The Firstmate published for another system, at this computer's own
 * version (docs/devices.md, "Infinitary for another system"): a Mac's
 * universal zip, or Linux's AppImage on x64, from this version's release on
 * the public tap. Its SHA-256 is the one the tap's builds file names for this
 * version (`infinitary-builds.json`), written after the release fetched
 * every file back and checked it; a version the file no longer names is
 * checked against the `.sha256` its release publishes beside the file. The
 * bytes are kept only once they match, in this computer's own folder, and
 * checked again each time they are used; another version's are deleted.
 *
 * Only an installed release reads the tap. A development run reads a stand-in
 * tap a test names (`standInTapFetch`), or nothing, so it keeps link pairing.
 */

export type PublishedKind = "zip" | "appimage" | "deb";

export type PublishedWant = { system: "macos" | "linux"; chip: DeviceChip; kind: PublishedKind };

/** A published build kept here, its bytes checked against `sha256`. */
export type PublishedBuild = { path: string; sha256: string };

/**
 * Why no build could be had: none is published for that system, chip or
 * version (`none`), the tap could not be reached (`unreachable`), or the
 * bytes did not match their published checksum (`mismatch`).
 */
export class PublishedBuildError extends Error {
  constructor(
    readonly reason: "none" | "unreachable" | "mismatch",
    message: string,
  ) {
    super(message);
    this.name = "PublishedBuildError";
  }
}

export type PublishedBuildsOptions = {
  /** This computer's version of Firstmate, which every build it gets matches. */
  version: string;
  /** Where the checked bytes are kept: `devices/builds/` in the app's own data. */
  dir: string;
  fetchImpl?: typeof fetch;
  /** The builds file; the tap's own unless a test stands one in. */
  buildsUrl?: string;
  maxBytes?: number;
};

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const HEADERS = { "User-Agent": "infinitary" };

/** The name each kind's file has on a release (`electron-builder.yml`, `electron-builder.linux.yml`). */
export function publishedAssetName(version: string, want: PublishedWant): string | null {
  if (want.kind === "zip" && want.system === "macos") return `Infinitary-${version}-universal.zip`;
  if (want.kind === "appimage" && want.system === "linux" && want.chip === "x64")
    return `infinitary-${version}-linux-x86_64.AppImage`;
  if (want.kind === "deb" && want.system === "linux" && want.chip === "x64")
    return `infinitary-${version}-linux-amd64.deb`;
  return null;
}

/** The name it is kept under here, the same at every version. */
function keptName(want: PublishedWant): string {
  if (want.kind === "appimage") return LINUX_APP_FILE;
  if (want.kind === "deb") return "infinitary.deb";
  return "Infinitary.zip";
}

export class PublishedBuilds {
  private readonly fetchImpl: typeof fetch;
  private readonly getting = new Map<string, Promise<PublishedBuild>>();

  constructor(private readonly options: PublishedBuildsOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** The build for `want`, checked; rejects with a `PublishedBuildError`. */
  get(want: PublishedWant): Promise<PublishedBuild> {
    const key = `${want.system}-${want.chip}-${want.kind}`;
    const under = this.getting.get(key);
    if (under) return under;
    const getting = this.fetchChecked(want).finally(() => this.getting.delete(key));
    this.getting.set(key, getting);
    return getting;
  }

  /** Looks up the published address and checksum without fetching the app here. */
  async downloadFor(want: PublishedWant): Promise<{ url: string; sha256: string } | null> {
    const asset = publishedAssetName(this.options.version, want);
    if (!asset || !publicTagFor(this.options.version)) return null;
    return this.publishedDownload(want, asset, AbortSignal.timeout(5_000));
  }

  private async fetchChecked(want: PublishedWant): Promise<PublishedBuild> {
    const { version } = this.options;
    const asset = publishedAssetName(version, want);
    if (!asset || !publicTagFor(version))
      throw new PublishedBuildError(
        "none",
        `No Infinitary ${version} is published for that system.`,
      );
    const folder = join(this.options.dir, version, `${want.system}-${want.chip}`);
    const path = join(folder, keptName(want));
    const recorded = `${path}.sha256`;
    let published: { url: string; sha256: string } | null;
    try {
      published = await this.publishedDownload(want, asset);
    } catch (error) {
      // Offline: bytes kept here once they matched still match what was published.
      const kept = readRecorded(recorded);
      if (kept && (await sha256Of(path)) === kept) return { path, sha256: kept };
      throw error;
    }
    if (!published)
      throw new PublishedBuildError(
        "none",
        `No Infinitary ${version} is published for that system.`,
      );
    if (readRecorded(recorded) === published.sha256 && (await sha256Of(path)) === published.sha256)
      return { path, sha256: published.sha256 };
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    rmSync(recorded, { force: true });
    await this.download(published.url, `${path}.part`, published.sha256);
    renameSync(`${path}.part`, path);
    writeFileSync(recorded, `${published.sha256}\n`, { mode: 0o600 });
    this.forgetOtherVersions();
    return { path, sha256: published.sha256 };
  }

  /**
   * Where the build downloads from and its SHA-256: the builds file's entry
   * when a channel there offers this version, else the release's own
   * `.sha256` beside the file. Null when nothing is published there.
   */
  private async publishedDownload(
    want: PublishedWant,
    asset: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; sha256: string } | null> {
    const { version } = this.options;
    // Old release links remain valid; an exact historical version may still live on the tap.
    const sources = [
      { url: this.options.buildsUrl ?? publicBuildsUrl, names: PUBLIC_RELEASE_NAMES },
      { url: this.options.buildsUrl ?? BUILDS_URL, names: INFINITARY_TAP },
    ];
    for (const source of sources) {
      const allowUnreachable = !this.options.buildsUrl && source.url === publicBuildsUrl;
      const builds = await this.readJson(source.url, signal, allowUnreachable);
      const parsed = builds === null ? null : parseBuilds(builds, source.names);
      for (const entry of [parsed?.channels.stable, parsed?.channels.alpha]) {
        if (entry?.version !== version) continue;
        const download = entry.systems[want.system]?.[want.chip]?.[want.kind];
        if (download) return download;
      }
      const url = buildDownloadUrl(version, asset, source.names);
      const sidecar = await this.readText(`${url}.sha256`, signal, allowUnreachable);
      if (sidecar === null) continue;
      const sha256 = /^([0-9a-f]{64})\b/.exec(sidecar.trim())?.[1];
      if (!sha256 || !SHA256.test(sha256))
        throw new PublishedBuildError(
          "unreachable",
          `The checksum published for ${asset} is unreadable.`,
        );
      return { url, sha256 };
    }
    return null;
  }

  private async readJson(
    url: string,
    signal?: AbortSignal,
    allowUnreachable = false,
  ): Promise<unknown | null> {
    const text = await this.readText(url, signal, allowUnreachable);
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  /** The text at `url`; null on a 404, a rejection when the tap could not be read. */
  private async readText(
    url: string,
    signal?: AbortSignal,
    allowUnreachable = false,
  ): Promise<string | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: HEADERS,
        redirect: "follow",
        ...(signal ? { signal } : {}),
      });
    } catch {
      if (allowUnreachable && !signal?.aborted) return null;
      throw new PublishedBuildError("unreachable", "The release downloads could not be reached.");
    }
    if (response.status === 404) return null;
    if (!response.ok)
      throw new PublishedBuildError(
        "unreachable",
        `The release downloads answered ${response.status}.`,
      );
    return response.text();
  }

  /** Downloads `url` to `file`, refusing bytes whose SHA-256 is not `sha256`. */
  private async download(url: string, file: string, sha256: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: HEADERS, redirect: "follow" });
    } catch {
      throw new PublishedBuildError("unreachable", "The download could not be reached.");
    }
    if (response.status === 404 || !response.body)
      throw new PublishedBuildError("none", `The release has no ${url.split("/").at(-1)}.`);
    if (!response.ok)
      throw new PublishedBuildError("unreachable", `The download answered ${response.status}.`);
    const hash = createHash("sha256");
    const max = this.options.maxBytes ?? MAX_BYTES;
    let size = 0;
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > max) {
          done(new Error("The download is larger than any build."));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        counting,
        createWriteStream(file, { mode: 0o600 }),
      );
    } catch {
      rmSync(file, { force: true });
      throw new PublishedBuildError("unreachable", "The download stopped before it finished.");
    }
    if (hash.digest("hex") !== sha256) {
      rmSync(file, { force: true });
      throw new PublishedBuildError(
        "mismatch",
        "The download did not match its published checksum.",
      );
    }
  }

  /** Another version's builds are of no use once this one's are here. */
  private forgetOtherVersions(): void {
    try {
      for (const entry of readdirSync(this.options.dir)) {
        if (entry !== this.options.version)
          rmSync(join(this.options.dir, entry), { recursive: true, force: true });
      }
    } catch {
      // Nothing kept, or nothing to forget.
    }
  }
}

function readRecorded(file: string): string | null {
  try {
    const said = readFileSync(file, "utf8").trim();
    return SHA256.test(said) ? said : null;
  } catch {
    return null;
  }
}

export async function sha256Of(path: string): Promise<string | null> {
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch {
    return null;
  }
  return hash.digest("hex");
}

/** Where the tap's releases download from, which a stand-in tap's folder mirrors. */
const RELEASES_PREFIX = `https://github.com/${TAP_REPO}/releases/download/`;

/**
 * A development run's stand-in for the public tap (docs/devices.md,
 * "Infinitary for another system"): the builds file and each release's files
 * read from `dir`, laid out as its builds file (`infinitary-builds.json`) and
 * `<tag>/<file>`, so a test exercises every check with no network. A packaged
 * app never reads one.
 */
export function standInTapFetch(dir: string): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const relative =
      url === BUILDS_URL
        ? BUILDS_FILE
        : url.startsWith(RELEASES_PREFIX)
          ? url.slice(RELEASES_PREFIX.length)
          : null;
    const file = relative && !relative.split("/").includes("..") ? join(dir, relative) : null;
    if (!file || !existsSync(file)) return new Response("Not Found", { status: 404 });
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { status: 200 });
  };
}
