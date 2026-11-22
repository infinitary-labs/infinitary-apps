import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator } from "@playwright/test";
import {
  MAX_GIF_DEMO_BYTES,
  MAX_GIF_DEMO_FRAME_RATE,
  MAX_GIF_DEMO_LONG_SIDE,
  MAX_GIF_DEMO_SECONDS,
  MAX_GIF_DEMO_SHORT_SIDE,
  readDemoGif,
} from "../../src/core/gifFormat";
import { readPicture } from "../../src/core/pictureFormat";
import { readDemoVideo } from "../../src/core/videoFormat";
import { scratchDir } from "../helpers/scratchDirs";
import {
  DemoEncoderUnavailable,
  decodesWhole,
  demoEncoder,
  encoderName,
  fileDigest,
  needH264,
  needWindowRecorder,
  runEncoder,
} from "./demoEncoder";
import { type LaunchedApp, type LaunchOptions, launchApp } from "./launch";
import { resizeWindow, type WindowSize } from "./layout";
import { readyRegion, windowShot } from "./pictures";

/**
 * A demo of a change (docs/testing.md, "Recording a demo"; docs/card-authoring.md
 * "Demo recordings"): the hermetic app recorded while one action plays, made
 * into the silent H.264 MP4 a card plays, with a poster of the settled view
 * at action start and a manifest of how it was made.
 *
 * The app records its ready window until close through Playwright's own recording of
 * the window - browser rendering, never the screen, so the window stays
 * hidden and nothing else on the Mac is in it. `record` marks where the
 * action starts and ends and the region the demo is cropped to; `finish`
 * closes the app and cuts that span out of the recording, at real speed,
 * cropped to the region and scaled to fit 1280 × 720 at 24 frames a second,
 * with the pinned encoder (`./demoEncoder`). The result is checked as the
 * host will check it - its boxes by `readDemoVideo`, every frame decoded, the
 * poster the recording's own shape - so a demo that would be refused on a
 * card fails here first.
 *
 * When no MP4 can be made, `finish` falls back to a single-play GIF of the
 * same span: FFmpeg's palette pass at 10 frames a second, fitted to
 * 1280 × 720 and made smaller until it fits 8 MB, written with no loop
 * instruction (`-loop -1`) and checked by `readDemoGif`, the host's own walk.
 * The manifest says why the MP4 could not be made. A demo that cannot be
 * made either way says why (`DemoEncoderUnavailable`): never a renamed WebM,
 * never a claimed demo.
 */

/** The working target: a demo fits this box, at this many frames a second. */
export const DEMO_TARGET = { width: 1280, height: 720, fps: 24 } as const;
/** The GIF fallback's limits, which are the host's: one short action, played once. */
export const GIF_DEMO_TARGET = {
  width: MAX_GIF_DEMO_LONG_SIDE,
  height: MAX_GIF_DEMO_SHORT_SIDE,
  fps: MAX_GIF_DEMO_FRAME_RATE,
  seconds: MAX_GIF_DEMO_SECONDS,
  bytes: MAX_GIF_DEMO_BYTES,
} as const;
/** The sizes a GIF is tried at, as a share of its fitted size, until it fits its bytes. */
const GIF_SCALES = [1, 0.75, 0.5] as const;
/** A region narrower or shorter than this shows nothing a person could follow. */
const MIN_SIDE = 64;
/** Seconds kept before the action's start and after its end, so neither is cut short. */
const LEAD = 0.5;
/** Hold the marked start across encoder frame rounding before the first result replaces it. */
const START_HOLD = 0.2;
const TAIL = 0.8;
/** The screencast's JPEG quality: its own frames are the demo's source, so none is thrown away. */
const SCREENCAST_QUALITY = 100;
/** H.264 constant quality for the MP4: low enough that dark gradients and glows stay smooth. */
const MP4_CRF = 14;

/**
 * One frame the screencast drew: Chromium sends a JPEG only when the window
 * changes, so a frame holds until the next one's time. The demo is built
 * from these directly. Playwright's own recording of the same frames is a
 * 1 Mbit/s VP8 WebM with a starved keyframe every 5.12 s, which flashes the
 * view grey-purple for one frame and blocks dark gradients before the MP4
 * step ever sees them.
 */
type Frame = {
  file: string;
  /** Seconds after the first frame. */
  at: number;
  /** The window size the frame shows, in its own pixels. */
  width: number;
  height: number;
};

/** The screencast's frames and the second it stopped at, on the same clock. */
type Capture = { frames: Frame[]; end: number };

type Box = { x: number; y: number; width: number; height: number };

type Mark = { label: string; start: number; end: number; crop: Box; scale: number };

export type DemoFiles = {
  /** What was made: the MP4, or the GIF fallback when no MP4 could be. */
  format: "mp4" | "gif";
  /** The recording, `<name>.mp4` or `<name>.gif`. */
  recording: string;
  /** Its poster, `<name>.png`: the settled action-start view by default. */
  poster: string;
  /** How it was made, `<name>.json`: evidence, never what a card is checked against. */
  manifest: string;
  width: number;
  height: number;
  durationMs: number;
  /** Why no MP4 could be made, when the recording is the GIF fallback. */
  fallback?: string;
};

export type DemoRecorder = {
  /** The app being recorded: reach the view through the usual mock providers and seed helpers. */
  launched: LaunchedApp;
  /**
   * Plays `action` once, marking its start and end and cropping the demo to
   * the region's box as it stands at the start - or keeping the whole
   * window, for an action that opens something over it. One action per
   * recording.
   */
  record: (label: string, region: Locator | "window", action: () => Promise<void>) => Promise<void>;
  /** Holds each demonstrated keyboard result long enough to see, after its assertion passes. */
  step: (action: () => Promise<void>) => Promise<void>;
  /**
   * Closes the app and makes the demo: `<dir>/<name>.mp4` - or `.gif` when
   * no MP4 can be made - with `.png` and `.json`. `format` makes that one
   * format only, with no fallback: `"gif"` makes the fallback itself, as a
   * journey that checks it does.
   */
  finish: (out: {
    dir: string;
    name: string;
    poster?: "start" | "first" | "last";
    format?: "mp4" | "gif";
  }) => Promise<DemoFiles>;
};

/**
 * Launches the hermetic app recording, at a fixed window size - the same for
 * a view's demo before the change and after it.
 */
export async function startDemo(
  options: LaunchOptions & { size: WindowSize },
): Promise<DemoRecorder> {
  const { size, ...launch } = options;
  needWindowRecorder();
  const home = launch.homeDir ?? scratchDir("infinitary-demo-home-");
  const launched = await launchApp({
    ...launch,
    homeDir: home,
    // The app's home pinned for macOS's own lookups too.
    env: { ...launch.env, CFFIXED_USER_HOME: home },
  });
  await resizeWindow(launched.app, launched.page, size);
  const frameDir = scratchDir("infinitary-demo-video-");
  const frames: Frame[] = [];
  let firstFrame: number | undefined;
  try {
    // The frames the demo is made from are the ones Chromium draws, kept at
    // JPEG quality 100 and never re-encoded on the way (see `Frame`); their
    // timestamps and the action marks share one wall-clock origin.
    // A clock started after launch can point backwards into the startup reveal.
    await launched.page.screencast.start({
      size,
      quality: SCREENCAST_QUALITY,
      onFrame: ({ data, timestamp, viewportWidth, viewportHeight }) => {
        firstFrame ??= timestamp;
        const file = join(frameDir, `${String(frames.length).padStart(6, "0")}.jpg`);
        writeFileSync(file, data);
        frames.push({
          file,
          at: (timestamp - firstFrame) / 1000,
          width: viewportWidth,
          height: viewportHeight,
        });
      },
    });
  } catch (error) {
    await launched.close();
    throw error;
  }
  const closeApp = launched.close;
  let closing: Promise<void> | undefined;
  let stoppedAt = 0;
  launched.close = () => {
    closing ??= (async () => {
      try {
        await launched.page.screencast.stop();
        stoppedAt = (Date.now() - (firstFrame ?? Date.now())) / 1000;
      } finally {
        await closeApp();
      }
    })();
    return closing;
  };
  const clock = () => {
    if (firstFrame === undefined) throw new Error("The demo has not drawn its first frame.");
    return (Date.now() - firstFrame) / 1000;
  };
  let mark: Mark | undefined;
  return {
    launched,
    record: async (label, region, action) => {
      if (mark) throw new Error("A demo shows one action: record it once.");
      // A screenshot flushes drawing too; box stability alone does not promise a painted view.
      await launched.page.evaluate(() => document.fonts.ready.then(() => undefined));
      const startView = async () => {
        if (region !== "window") await readyRegion(region);
        await launched.page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter(
                (motion) => motion.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY,
              )
              .map((motion) => motion.finished.catch(() => undefined)),
          ),
        );
        // Any clipped capture, Playwright's whole-page screenshot included,
        // briefly crops Chromium's surface, which the recording catches as a
        // frame of only the window's top-left once a Size zooms it.
        return windowShot(launched.page);
      };
      await startView();
      await expect
        .poll(() => firstFrame, { message: "the recording has its first drawn frame" })
        .toBeDefined();
      // Keep a drawn lead-in even when record() is called immediately after launch.
      await launched.page.waitForTimeout(LEAD * 1000);
      await startView();
      const inner = await launched.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      const box = region === "window" ? { x: 0, y: 0, ...inner } : await region.boundingBox();
      if (!box) throw new Error(`The region of "${label}" is not on screen.`);
      if (box.width < MIN_SIDE || box.height < MIN_SIDE) {
        throw new Error(
          `The region of "${label}" is ${Math.round(box.width)} × ${Math.round(box.height)}: crop to the component that shows the action, or record the window.`,
        );
      }
      const start = clock();
      // The video and GIF frame grids can round a near-boundary key result
      // into the poster slot. Keep the marked starting view on both grids.
      await launched.page.waitForTimeout(START_HOLD * 1000);
      await action();
      const end = clock();
      mark = { label, start, end, crop: box, scale: size.width / inner.width };
      // Closing immediately would otherwise discard the requested tail.
      await launched.page.waitForTimeout(TAIL * 1000);
    },
    step: async (action) => {
      await action();
      // Deliberate presentation pacing, not a readiness or performance assertion.
      await launched.page.waitForTimeout(500);
    },
    finish: async ({ dir, name, poster = "start", format }) => {
      await launched.close();
      const taken = mark;
      if (!taken) throw new Error("Nothing was recorded: call record() with the action first.");
      const capture = { frames, end: stoppedAt };
      return makeDemo({ capture, mark: taken, window: size, dir, name, poster }, format);
    },
  };
}

/** The crop in the recording's pixels: inside it, and even on both sides, as H.264 needs. */
function videoCrop(mark: Mark, window: WindowSize): Box {
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  const x = Math.max(0, Math.round(mark.crop.x * mark.scale));
  const y = Math.max(0, Math.round(mark.crop.y * mark.scale));
  return {
    x,
    y,
    width: even(Math.min(mark.crop.width * mark.scale, window.width - x)),
    height: even(Math.min(mark.crop.height * mark.scale, window.height - y)),
  };
}

type DemoInput = {
  capture: Capture;
  mark: Mark;
  window: WindowSize;
  dir: string;
  name: string;
  poster: "start" | "first" | "last";
};

/** The span cut out of the recording: the action, with its lead and tail. */
function span(mark: Mark): { from: number; seconds: number } {
  const from = Math.max(0, mark.start - LEAD);
  return { from, seconds: mark.end + TAIL - from };
}

/**
 * The frames that show the whole window, held until the next one draws and
 * cut to the span: the list FFmpeg's concat reader plays at real time.
 * A frame smaller than the window is a capture cut off by a clipped screenshot
 * or a resize in flight; the frame before it keeps its place instead.
 */
function frameList(capture: Capture, from: number, until: number): string {
  const width = Math.max(0, ...capture.frames.map((frame) => frame.width));
  const height = Math.max(0, ...capture.frames.map((frame) => frame.height));
  const whole = capture.frames.filter((frame) => frame.width === width && frame.height === height);
  const lines = ["ffconcat version 1.0"];
  let last: string | undefined;
  whole.forEach((frame, index) => {
    const start = Math.max(from, frame.at);
    const stop = Math.min(until, whole[index + 1]?.at ?? capture.end);
    if (stop <= start) return;
    last = frame.file;
    lines.push(`file '${frame.file}'`, `duration ${(stop - start).toFixed(6)}`);
  });
  // The concat reader drops the last duration unless its file is named again.
  if (last) lines.push(`file '${last}'`);
  return `${lines.join("\n")}\n`;
}

function frameInput(capture: Capture, mark: Mark): string[] {
  const { from, seconds } = span(mark);
  const list = join(scratchDir("infinitary-demo-frames-"), "frames.ffconcat");
  writeFileSync(list, frameList(capture, from, from + seconds));
  return ["-f", "concat", "-safe", "0", "-i", list];
}

async function makeDemo(input: DemoInput, format?: "mp4" | "gif"): Promise<DemoFiles> {
  await mkdir(input.dir, { recursive: true });
  // No encoder at all: neither can be made, and that is what the crewmate reports.
  const encoder = await demoEncoder();
  if (format === "gif") return encodeGif(encoder, input);
  try {
    return encodeMp4(encoder, input);
  } catch (error) {
    if (format === "mp4" || !(error instanceof DemoEncoderUnavailable)) throw error;
    rmSync(join(input.dir, `${input.name}.mp4`), { force: true });
    try {
      return encodeGif(encoder, input, error.message);
    } catch (fallback) {
      if (!(fallback instanceof DemoEncoderUnavailable)) throw fallback;
      throw new DemoEncoderUnavailable(
        `no MP4 could be made (${error.message}), nor a GIF (${fallback.message})`,
      );
    }
  }
}

function writeManifest(file: string, fields: Record<string, unknown>): void {
  writeFileSync(file, `${JSON.stringify(fields, null, 2)}\n`);
}

function encodeMp4(encoder: string, input: DemoInput): DemoFiles {
  const { capture, mark, window, dir, name } = input;
  needH264(encoder);
  const recording = join(dir, `${name}.mp4`);
  const poster = join(dir, `${name}.png`);
  const manifest = join(dir, `${name}.json`);
  const crop = videoCrop(mark, window);
  const { from, seconds } = span(mark);
  const fit = `scale=w='min(${DEMO_TARGET.width},iw)':h='min(${DEMO_TARGET.height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`;
  // The JPEGs are full-range BT.601; a player reads an untagged HD MP4 as
  // limited-range BT.709, so convert once here and say so in the file.
  const toVideo =
    "scale=in_range=pc:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int";
  runEncoder(encoder, [
    ...frameInput(capture, mark),
    ...[
      "-vf",
      // Even-sized fitted frames need square pixels so the display header
      // and the poster decoded from those frames name the same dimensions.
      `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},${fit},setsar=1,fps=${DEMO_TARGET.fps},${toVideo},format=yuv420p`,
    ],
    ...["-c:v", "libx264", "-profile:v", "high", "-preset", "slow", "-crf", String(MP4_CRF)],
    ...["-x264-params", "aq-mode=3"],
    ...["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1"],
    ...["-color_range", "tv", "-movflags", "+faststart", "-an", recording],
  ]);
  const read = readDemoVideo(readFileSync(recording));
  if (!read.ok) throw new DemoEncoderUnavailable(`the demo would be refused: it ${read.reason}`);
  if (input.poster === "start") {
    runEncoder(encoder, [
      "-ss",
      (mark.start - from).toFixed(3),
      "-i",
      recording,
      "-frames:v",
      "1",
      "-update",
      "1",
      poster,
    ]);
  } else {
    runEncoder(encoder, [
      ...(input.poster === "last" ? ["-sseof", "-0.1"] : []),
      ...["-i", recording, "-frames:v", "1", "-update", "1", poster],
    ]);
  }

  // Checked as the host will check it on a card.
  if (!decodesWhole(encoder, recording)) {
    throw new DemoEncoderUnavailable("the demo does not decode from start to end");
  }
  const still = readPicture(readFileSync(poster));
  if (!still || still.size.width !== read.video.width || still.size.height !== read.video.height) {
    throw new DemoEncoderUnavailable("the poster is not a picture of the recording's own size");
  }
  writeManifest(manifest, {
    name,
    action: mark.label,
    window,
    crop,
    recorded: { from: Number(from.toFixed(3)), seconds: Number(seconds.toFixed(3)) },
    format: "mp4",
    codec: `H.264 ${read.video.profile}, yuv420p, silent`,
    width: read.video.width,
    height: read.video.height,
    durationMs: read.video.durationMs,
    frames: read.video.frames,
    bytes: readFileSync(recording).length,
    sha256: fileDigest(recording),
    poster: {
      file: `${name}.png`,
      frame: input.poster,
      source: "recording",
    },
    encoder: encoderName("libx264"),
  });
  return {
    format: "mp4",
    recording,
    poster,
    manifest,
    width: read.video.width,
    height: read.video.height,
    durationMs: read.video.durationMs,
  };
}

/**
 * The single-play GIF of the same span: at most 10 seconds, fitted to
 * 1280 × 720 at 10 frames a second through FFmpeg's palette pass, and tried
 * smaller until it fits 8 MB. `-loop -1` writes no loop instruction, so it
 * plays once; its poster defaults to the settled view at action start.
 */
function encodeGif(encoder: string, input: DemoInput, fallback?: string): DemoFiles {
  const { capture, mark, window, dir, name } = input;
  const { from, seconds } = span(mark);
  if (seconds > GIF_DEMO_TARGET.seconds) {
    throw new DemoEncoderUnavailable(
      `the action runs ${seconds.toFixed(1)} seconds with its lead and tail, longer than a GIF demo's ${GIF_DEMO_TARGET.seconds}: record a shorter action`,
    );
  }
  const recording = join(dir, `${name}.gif`);
  const poster = join(dir, `${name}.png`);
  const manifest = join(dir, `${name}.json`);
  const crop = videoCrop(mark, window);
  let scale: number = GIF_SCALES[0];
  for (scale of GIF_SCALES) {
    const width = Math.round(GIF_DEMO_TARGET.width * scale);
    const height = Math.round(GIF_DEMO_TARGET.height * scale);
    const fit = `scale=w='min(${width},iw*${scale})':h='min(${height},ih*${scale})':force_original_aspect_ratio=decrease:flags=lanczos`;
    runEncoder(encoder, [
      ...frameInput(capture, mark),
      ...[
        "-vf",
        `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},${fit},fps=${GIF_DEMO_TARGET.fps},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      ],
      ...["-loop", "-1", recording],
    ]);
    if (statSync(recording).size <= GIF_DEMO_TARGET.bytes) break;
  }

  // Checked as the host will check it on a card.
  const bytes = readFileSync(recording);
  if (bytes.length > GIF_DEMO_TARGET.bytes) {
    throw new DemoEncoderUnavailable(
      `the GIF is larger than ${GIF_DEMO_TARGET.bytes / 1024 / 1024} MB even at half its size: crop to a smaller region or record a shorter action`,
    );
  }
  const read = readDemoGif(bytes);
  if (!read.ok) throw new DemoEncoderUnavailable(`the GIF would be refused: it ${read.reason}`);
  if (!decodesWhole(encoder, recording)) {
    throw new DemoEncoderUnavailable("the GIF does not decode from start to end");
  }
  if (input.poster === "start") {
    const frame = Math.min(
      read.gif.frames - 1,
      Math.round((mark.start - from) * GIF_DEMO_TARGET.fps),
    );
    runEncoder(encoder, [
      "-i",
      recording,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-frames:v",
      "1",
      "-update",
      "1",
      poster,
    ]);
  } else {
    const frame = input.poster === "last" ? read.gif.frames - 1 : 0;
    runEncoder(encoder, [
      ...["-i", recording, "-vf", `select=eq(n\\,${frame})`],
      ...["-frames:v", "1", "-update", "1", poster],
    ]);
  }
  const still = readPicture(readFileSync(poster));
  if (!still || still.size.width !== read.gif.width || still.size.height !== read.gif.height) {
    throw new DemoEncoderUnavailable("the poster is not a picture of the GIF's own size");
  }
  writeManifest(manifest, {
    name,
    action: mark.label,
    window,
    crop,
    recorded: { from: Number(from.toFixed(3)), seconds: Number(seconds.toFixed(3)) },
    format: "gif",
    codec: `GIF, single play (no loop instruction), ${GIF_DEMO_TARGET.fps} frames a second`,
    ...(fallback ? { fallback } : {}),
    scale,
    width: read.gif.width,
    height: read.gif.height,
    durationMs: read.gif.durationMs,
    frames: read.gif.frames,
    bytes: bytes.length,
    sha256: fileDigest(recording),
    poster: {
      file: `${name}.png`,
      frame: input.poster,
      source: "recording",
    },
    encoder: encoderName("palettegen and paletteuse"),
  });
  return {
    format: "gif",
    recording,
    poster,
    manifest,
    width: read.gif.width,
    height: read.gif.height,
    durationMs: read.gif.durationMs,
    ...(fallback ? { fallback } : {}),
  };
}
