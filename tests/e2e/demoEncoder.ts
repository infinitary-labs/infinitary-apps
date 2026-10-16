import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * The encoder a demo recording is made with (docs/testing.md, "Recording a
 * demo"): one pinned FFmpeg build, fetched once per machine on first use and
 * checked against its published SHA-256 before it ever runs. It is a
 * development tool only - the app ships no FFmpeg, and nothing here is
 * installed with the project's dependencies, so a checkout that records no
 * demo never downloads it.
 *
 * The build is ffmpeg-static's release `b6.1.1` (with libx264), the same
 * binaries its npm package installs, taken straight from its GitHub
 * release: each archive's digest below is the one that release publishes,
 * and `ffmpeg` is the FFmpeg major version those bytes report. The Mac
 * builds are FFmpeg 6; the release's Linux build is John Van Sickle's
 * static FFmpeg 7. Moving the pin is a change of these three lines and their
 * digests, never a download of whatever is newest.
 */

const RELEASE = "b6.1.1";
const PINNED: Readonly<Record<string, { asset: string; sha256: string; ffmpeg: number }>> = {
  "darwin-arm64": {
    asset: "ffmpeg-darwin-arm64.gz",
    sha256: "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
    ffmpeg: 6,
  },
  "darwin-x64": {
    asset: "ffmpeg-darwin-x64.gz",
    sha256: "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
    ffmpeg: 6,
  },
  "linux-x64": {
    asset: "ffmpeg-linux-x64.gz",
    sha256: "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa",
    ffmpeg: 7,
  },
};

/** Why no demo can be encoded here, worded for the crewmate who reads it. */
export class DemoEncoderUnavailable extends Error {}

function cacheDir(): string {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
  return join(base, "infinitary-dev", `ffmpeg-${RELEASE}`);
}

/** The pinned build's own words about itself: the FFmpeg version its pin publishes. */
function preflight(binary: string, ffmpeg: number): void {
  const version = spawnSync(binary, ["-hide_banner", "-version"], { encoding: "utf8" });
  if (
    version.status !== 0 ||
    !new RegExp(`^ffmpeg version ${ffmpeg}\\.`, "m").test(version.stdout)
  ) {
    throw new DemoEncoderUnavailable(`the pinned encoder at ${binary} does not run here`);
  }
}

/** How a demo's manifest names the encoder that made it, with what it used (`libx264`). */
export function encoderName(used: string): string {
  const pin = PINNED[`${process.platform}-${process.arch}`];
  return `ffmpeg-static ${RELEASE} (FFmpeg ${pin?.ffmpeg ?? "unknown"}, ${used})`;
}

/**
 * Throws `DemoEncoderUnavailable` when the encoder cannot make an MP4 demo:
 * the pinned build carries libx264, so this is a build that does not run
 * the way it was published. A GIF needs only FFmpeg's own GIF encoder.
 */
export function needH264(binary: string): void {
  const encoders = spawnSync(binary, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (encoders.status !== 0 || !/\blibx264\b/.test(encoders.stdout)) {
    throw new DemoEncoderUnavailable(`the pinned encoder at ${binary} cannot encode H.264`);
  }
}

/**
 * The pinned encoder's path, fetched and checked on first use. Throws
 * `DemoEncoderUnavailable` on a platform it has no build for, when the
 * download fails, when the bytes are not the pinned ones, or when it does
 * not run: then neither an MP4 nor a GIF can be made here.
 */
export async function demoEncoder(): Promise<string> {
  const platform = `${process.platform}-${process.arch}`;
  const pin = PINNED[platform];
  if (!pin) throw new DemoEncoderUnavailable(`no pinned encoder is published for ${platform}`);
  const dir = cacheDir();
  const binary = join(dir, `ffmpeg-${platform}`);
  if (!existsSync(binary)) {
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}/${pin.asset}`;
    let archive: Buffer;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      archive = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new DemoEncoderUnavailable(
        `the pinned encoder could not be downloaded (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== pin.sha256) {
      throw new DemoEncoderUnavailable(
        `the downloaded encoder is not the pinned one (sha256 ${digest}, expected ${pin.sha256})`,
      );
    }
    mkdirSync(dir, { recursive: true });
    // Written beside its place and renamed in, so a half-written binary never runs.
    const partial = `${binary}.${process.pid}.partial`;
    writeFileSync(partial, gunzipSync(archive), { mode: 0o755 });
    chmodSync(partial, 0o755);
    renameSync(partial, binary);
  }
  preflight(binary, pin.ffmpeg);
  return binary;
}

/**
 * Playwright's own window recorder: `page.screencast` writes the window through
 * Playwright's FFmpeg build, which installing the project's dependencies
 * does not fetch. Check it before launch rather than discovering a missing
 * recorder after opening the app. Installed on first use by Playwright, into
 * Playwright's cache, and nothing once it is there. Throws
 * `DemoEncoderUnavailable` when it cannot be installed: then no demo can be
 * recorded here.
 */
export function needWindowRecorder(): void {
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  const run = spawnSync(process.execPath, [cli, "install", "ffmpeg"], { encoding: "utf8" });
  if (run.status !== 0) {
    // Its errors, once each: the installer repeats them per retry, between stack frames.
    const errors = new Set(
      `${run.stderr ?? ""}\n${run.stdout ?? ""}`
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("Error")),
    );
    const said = [...errors].join(" ") || run.error?.message || `exit ${run.status}`;
    throw new DemoEncoderUnavailable(
      `Playwright's window recorder could not be installed: ${said}`,
    );
  }
  // Only a download says anything, so a run's log names the machine that lacked it.
  const said = run.stdout.trim().split("\n").at(-1);
  if (said) console.log(`[demo] ${said}`);
}

/** Runs the encoder, throwing its own last words when it fails. */
export function runEncoder(binary: string, args: readonly string[]): void {
  const run = spawnSync(binary, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0) {
    const said = (run.stderr || run.error?.message || "").trim().split("\n").slice(-3).join(" ");
    throw new DemoEncoderUnavailable(`the encoder failed: ${said || `exit ${run.status}`}`);
  }
}

/** Whether a file decodes from start to end with the pinned build. */
export function decodesWhole(binary: string, file: string): boolean {
  const run = spawnSync(binary, ["-hide_banner", "-v", "error", "-i", file, "-f", "null", "-"], {
    encoding: "utf8",
  });
  return run.status === 0 && run.stderr.trim() === "";
}

/** The digest of a file, for the manifest. */
export function fileDigest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
