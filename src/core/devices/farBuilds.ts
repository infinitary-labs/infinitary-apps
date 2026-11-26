import { createReadStream } from "node:fs";
import type { Readable, Writable } from "node:stream";
import type { DeviceChip } from "@shared/devices";
import type { RemoteLoginRefusal } from "@shared/remoteLogin";
import { packApp } from "./appArchive";
import type { CopyForm, FarSystem } from "./farSystems";
import {
  PublishedBuildError,
  type PublishedBuilds,
  type PublishedKind,
  sha256Of,
} from "./publishedBuilds";

/**
 * Which Firstmate another computer gets from this one (docs/devices.md,
 * "Infinitary for another system"): this computer's own, when that computer
 * runs the same system and chip - a Mac's universal bundle for any Mac, an
 * AppImage for Linux on its chip - or else the Firstmate published for that
 * system at this computer's version, checked against its SHA-256
 * (`PublishedBuilds`). A Mac may first download that published version itself,
 * with this home's bundle kept as the immediate fallback.
 */

/** A copy ready to go: its form, its file, and the SHA-256 the other side checks, except a bundle's. */
export type FarBuild =
  | { form: "bundle"; path: string }
  | { form: Exclude<CopyForm, "bundle">; path: string; sha256: string };

export type FarBuildRefusal = Extract<
  RemoteLoginRefusal,
  "cannot-send" | "no-build" | "build-unverified"
>;

/** This computer's own app, as another computer of its system may get it. */
type OwnBuild = { system: "macos"; path: string } | { system: "linux"; path: string };

/**
 * What this computer's own app is, by its path: a Mac's `.app` bundle, or a
 * Linux AppImage file; null for anything it cannot send whole (a Linux
 * package, a run from source with no stand-in).
 */
export function ownBuildOf(path: string | null): OwnBuild | null {
  if (!path) return null;
  if (path.endsWith(".app")) return { system: "macos", path };
  if (path.endsWith(".AppImage")) return { system: "linux", path };
  return null;
}

export type FarBuildsOptions = {
  /** This computer's own app, or null when it cannot send itself (`appBundleOf`). */
  own: () => string | null;
  /** The published builds, or null where none may be read: a development run with no stand-in tap. */
  published: PublishedBuilds | null;
  /** This computer's own chip, which its own AppImage runs on. */
  chip: DeviceChip | null;
};

export class FarBuilds {
  constructor(private readonly options: FarBuildsOptions) {}

  canSendAny(): boolean {
    return this.ownFor() !== null || this.options.published !== null;
  }

  canSend(far: FarSystem, chip: DeviceChip): boolean {
    return this.ownFor(far, chip) !== null || this.options.published !== null;
  }

  /** Whether it reads the published builds at all: an installed release, or a test's stand-in tap. */
  readsPublished(): boolean {
    return this.options.published !== null;
  }

  /** Whether that computer's copy must be got from the published release first. */
  fetches(far: FarSystem, chip: DeviceChip): boolean {
    return this.ownFor(far, chip) === null;
  }

  /** A Mac may fetch this version itself; development and unpublished builds still send. */
  async downloadFor(far: FarSystem, chip: DeviceChip) {
    if (far.system !== "macos") return null;
    try {
      return (
        (await this.options.published?.downloadFor({ system: "macos", chip, kind: "zip" })) ?? null
      );
    } catch {
      // An offline home can still send its own bundle.
      return null;
    }
  }

  /**
   * Where this version's Ubuntu package is published, for the line that
   * updates an older one there; null where none is, or none could be read.
   */
  async ubuntuPackageDownload(): Promise<{ url: string; sha256: string } | null> {
    try {
      return (
        (await this.options.published?.downloadFor({
          system: "linux",
          chip: "x64",
          kind: "deb",
        })) ?? null
      );
    } catch {
      return null;
    }
  }

  async for(
    far: FarSystem,
    chip: DeviceChip,
    kind: PublishedKind = far.published,
  ): Promise<FarBuild | { refusal: FarBuildRefusal }> {
    const own = kind === far.published ? this.ownFor(far, chip) : null;
    if (own?.system === "macos") return { form: "bundle", path: own.path };
    if (own) {
      const sha256 = await sha256Of(own.path);
      return sha256 ? { form: "appimage", path: own.path, sha256 } : { refusal: "cannot-send" };
    }
    const { published } = this.options;
    if (!published) return { refusal: "cannot-send" };
    try {
      const got = await published.get({ system: far.system, chip, kind });
      return { form: kind, path: got.path, sha256: got.sha256 };
    } catch (error) {
      if (error instanceof PublishedBuildError && error.reason === "mismatch")
        return { refusal: "build-unverified" };
      console.warn("[devices] could not get a published Infinitary:", error);
      return { refusal: "no-build" };
    }
  }

  private ownFor(far?: FarSystem, chip?: DeviceChip): OwnBuild | null {
    const own = ownBuildOf(this.options.own());
    if (!own || !far) return own;
    if (own.system !== far.system) return null;
    // A Mac's bundle is universal; an AppImage runs on the chip it was built for.
    if (own.system === "linux" && chip !== this.options.chip) return null;
    return own;
  }
}

/**
 * The copy's bytes as they go, made as they are sent: a bundle as one
 * gzipped tar (`packApp`), anything else as the file itself. `ended` settles
 * once all of it was read, and rejects when packing stopped; `stop` ends it
 * early.
 */
export function copyStream(build: FarBuild): {
  stream: Readable;
  ended: Promise<void>;
  stop: () => void;
} {
  if (build.form === "bundle") {
    const tar = packApp(build.path);
    const ended = new Promise<void>((resolve, reject) => {
      tar.once("error", reject);
      tar.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`Packing Infinitary stopped (${code}).`)),
      );
    });
    return {
      stream: tar.stdout,
      ended,
      stop: () => {
        if (tar.exitCode === null) tar.kill();
      },
    };
  }
  const stream = createReadStream(build.path);
  const ended = new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.once("end", resolve);
    stream.once("close", () => reject(new Error("The copy stopped before its end.")));
  });
  return { stream, ended, stop: () => stream.destroy() };
}

/**
 * Sends the copy into the other computer's input: a bundle as one gzipped
 * tar made as it goes, anything else as its file; `sent` hears the size of
 * each piece as it is handed over.
 */
export function sendCopy(
  build: FarBuild,
  sink: Writable,
  sent?: (bytes: number) => void,
): Promise<void> {
  const { stream, ended, stop } = copyStream(build);
  // SSH may stop reading long before tar fills its output pipe (INF-320).
  const closed = () => stop();
  sink.once("close", closed);
  sink.once("error", closed);
  if (sent) stream.on("data", (chunk: Buffer) => sent(chunk.length));
  stream.pipe(sink, { end: false });
  return ended.finally(() => {
    sink.off("close", closed);
    sink.off("error", closed);
    stream.unpipe(sink);
    stop();
  });
}
