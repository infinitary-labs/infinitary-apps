/**
 * What a demo recording is, read from its own boxes (demo videos,
 * docs/card-authoring.md "Demo recordings"). Pure and
 * dependency-free like `./pictureFormat`: a structurally valid, silent
 * H.264 MP4 within the demo limits and what it states about itself, or the
 * one reason it is not, worded for the crewmate who recorded it.
 *
 * Reading the boxes is a check of the file, not of its pictures: the host
 * still decodes frames from the start, middle and end before it keeps one
 * (`MediaProbe`, `src/core/pi/cardImages.ts`), so a file whose boxes are
 * right and whose pictures are not is refused all the same.
 */

/** The longest a demo may play. */
export const MAX_DEMO_SECONDS = 30;
/** The most frames a second a demo may play. */
export const MAX_DEMO_FRAME_RATE = 30;
/** A demo's longer side, at most. */
export const MAX_DEMO_LONG_SIDE = 1920;
/** A demo's shorter side, at most. */
export const MAX_DEMO_SHORT_SIDE = 1080;

/** The H.264 profiles a demo may use: each is 8-bit 4:2:0 here, and every Chromium decodes it. */
const PROFILES: Readonly<Record<number, string>> = { 66: "Baseline", 77: "Main", 100: "High" };

/** The MP4 brands an `ftyp` may name; a QuickTime movie or a 3GP file is not a demo. */
const BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso7",
  "iso8",
  "iso9",
  "mp41",
  "mp42",
  "avc1",
]);

/** Boxes that make an MP4 fragmented: its samples are not in the one index this reads. */
const FRAGMENTED = new Set(["moof", "mfra", "sidx", "styp", "mvex"]);

export type DemoVideo = {
  /** The size it is shown at (its track header's), in pixels. */
  width: number;
  height: number;
  /** How long it plays. */
  durationMs: number;
  /** How many pictures it holds. */
  frames: number;
  /** Its H.264 profile's name. */
  profile: string;
};

export type DemoVideoRead = { ok: true; video: DemoVideo } | { ok: false; reason: string };

type Box = { type: string; start: number; content: number; end: number };

class Refusal extends Error {}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

/** The boxes that tile `[from, to)` exactly, in order; a box past the end or a gap is a refusal. */
function boxes(bytes: Buffer, from: number, to: number): Box[] {
  const found: Box[] = [];
  let offset = from;
  while (offset < to) {
    if (to - offset < 8) refuse("is not a structurally valid MP4: it ends inside a box header");
    const small = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    let size: number;
    if (small === 1) {
      if (to - offset < 16) refuse("is not a structurally valid MP4: it ends inside a box header");
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
        refuse("is not a structurally valid MP4: a box runs past the end of the file");
      }
      size = Number(large);
      header = 16;
    } else if (small === 0) {
      size = to - offset;
    } else {
      size = small;
    }
    if (type === "uuid") header += 16;
    if (size < header || offset + size > to) {
      refuse("is not a structurally valid MP4: a box runs past the end of the file");
    }
    found.push({ type, start: offset, content: offset + header, end: offset + size });
    offset += size;
  }
  return found;
}

function only(list: Box[], type: string, what: string): Box {
  const matches = list.filter((box) => box.type === type);
  if (matches.length !== 1) refuse(`is not a structurally valid MP4: it needs exactly one ${what}`);
  return matches[0] as Box;
}

function need(box: Box, bytes: number): void {
  if (box.end - box.content < bytes) {
    refuse(`is not a structurally valid MP4: its ${box.type} box is too short`);
  }
}

/** A full box's version byte, after checking it is one the reader knows. */
function version(bytes: Buffer, box: Box): 0 | 1 {
  need(box, 4);
  const value = bytes[box.content];
  if (value !== 0 && value !== 1) {
    refuse(`is not a structurally valid MP4: its ${box.type} box has an unknown version`);
  }
  return value;
}

/** A 64-bit count that must fit a JavaScript number. */
function readCount(bytes: Buffer, offset: number, wide: boolean): number {
  if (!wide) return bytes.readUInt32BE(offset);
  const value = bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    refuse("is not a structurally valid MP4: a duration or offset is out of range");
  }
  return Number(value);
}

/** `(timescale, duration)` from an `mvhd` or `mdhd`, whose layouts agree up to there. */
function timing(bytes: Buffer, box: Box): { timescale: number; duration: number } {
  const wide = version(bytes, box) === 1;
  const at = box.content + 4 + (wide ? 16 : 8);
  need(box, at - box.content + (wide ? 12 : 8));
  const timescale = bytes.readUInt32BE(at);
  const duration = readCount(bytes, at + 4, wide);
  if (timescale === 0) refuse(`is not a structurally valid MP4: its ${box.type} has no timescale`);
  return { timescale, duration };
}

/** An RBSP bit reader over an SPS, with its emulation-prevention bytes taken out. */
function bitReader(nal: Buffer) {
  const clean: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    clean.push(nal[i] as number);
  }
  let bit = 0;
  const one = (): number => {
    const byte = clean[bit >> 3];
    if (byte === undefined)
      refuse("is not a structurally valid MP4: its H.264 settings are cut short");
    const value = (byte >> (7 - (bit & 7))) & 1;
    bit += 1;
    return value;
  };
  return {
    skip(count: number) {
      for (let i = 0; i < count; i++) one();
    },
    /** An unsigned Exp-Golomb number. */
    ue(): number {
      let zeros = 0;
      while (one() === 0) {
        zeros += 1;
        if (zeros > 31) refuse("is not a structurally valid MP4: its H.264 settings are malformed");
      }
      let value = 0;
      for (let i = 0; i < zeros; i++) value = value * 2 + one();
      return 2 ** zeros - 1 + value;
    },
  };
}

/**
 * The profile an `avcC` names, after checking its first sequence parameter
 * set says 8-bit 4:2:0 - the pictures every Chromium decodes.
 */
function avcProfile(bytes: Buffer, avcC: Box): string {
  need(avcC, 7);
  const at = avcC.content;
  if (bytes[at] !== 1) refuse("is not a structurally valid MP4: its H.264 settings are malformed");
  const profileIdc = bytes[at + 1] as number;
  const profile = PROFILES[profileIdc];
  if (!profile) {
    refuse(
      "uses an H.264 profile a demo cannot: encode it as High, Main or Baseline, 8-bit 4:2:0 (yuv420p)",
    );
  }
  const sets = (bytes[at + 5] as number) & 0x1f;
  if (sets < 1) refuse("is not a structurally valid MP4: its H.264 settings name no picture size");
  const length = bytes.readUInt16BE(at + 6);
  if (at + 8 + length > avcC.end || length < 4) {
    refuse("is not a structurally valid MP4: its H.264 settings are cut short");
  }
  const sps = bytes.subarray(at + 8, at + 8 + length);
  if (((sps[0] as number) & 0x1f) !== 7) {
    refuse("is not a structurally valid MP4: its H.264 settings are malformed");
  }
  if (sps[1] !== profileIdc) refuse("is not a structurally valid MP4: its H.264 settings disagree");
  if (profileIdc === 100) {
    const reader = bitReader(sps.subarray(4));
    reader.ue(); // seq_parameter_set_id
    const chroma = reader.ue();
    if (chroma === 3) reader.skip(1);
    const lumaDepth = reader.ue();
    const chromaDepth = reader.ue();
    if (chroma !== 1 || lumaDepth !== 0 || chromaDepth !== 0) {
      refuse("is not 8-bit 4:2:0 video: encode it with the pixel format yuv420p");
    }
  }
  return profile;
}

/** Every sample's bytes lie inside the file's media data, as its sample table places them. */
function checkSamples(bytes: Buffer, stbl: Box[], media: Box[], frames: number): void {
  const stsz = only(stbl, "stsz", "sample size table");
  version(bytes, stsz);
  need(stsz, 12);
  const fixed = bytes.readUInt32BE(stsz.content + 4);
  const count = bytes.readUInt32BE(stsz.content + 8);
  if (count !== frames) refuse("is not a structurally valid MP4: its sample tables disagree");
  if (fixed === 0) need(stsz, 12 + 4 * count);
  const sizeOf = (index: number) =>
    fixed !== 0 ? fixed : bytes.readUInt32BE(stsz.content + 12 + 4 * index);

  const offsetBox = stbl.find((box) => box.type === "stco" || box.type === "co64");
  if (!offsetBox) refuse("is not a structurally valid MP4: it has no chunk offset table");
  version(bytes, offsetBox);
  need(offsetBox, 8);
  const wide = offsetBox.type === "co64";
  const chunks = bytes.readUInt32BE(offsetBox.content + 4);
  need(offsetBox, 8 + chunks * (wide ? 8 : 4));
  if (chunks < 1 || chunks > frames) {
    refuse("is not a structurally valid MP4: its chunk table does not match its samples");
  }

  const stsc = only(stbl, "stsc", "sample-to-chunk table");
  version(bytes, stsc);
  need(stsc, 8);
  const runs = bytes.readUInt32BE(stsc.content + 4);
  need(stsc, 8 + runs * 12);
  if (runs < 1) refuse("is not a structurally valid MP4: its sample-to-chunk table is empty");

  const inMedia = (from: number, to: number) =>
    media.some((box) => from >= box.content && to <= box.end);
  let sample = 0;
  for (let run = 0; run < runs; run++) {
    const at = stsc.content + 8 + run * 12;
    const first = bytes.readUInt32BE(at);
    const perChunk = bytes.readUInt32BE(at + 4);
    const next = run + 1 < runs ? bytes.readUInt32BE(at + 12) : chunks + 1;
    if (first < 1 || next <= first || next > chunks + 1 || perChunk < 1) {
      refuse("is not a structurally valid MP4: its sample-to-chunk table is malformed");
    }
    for (let chunk = first; chunk < next; chunk++) {
      let offset = readCount(bytes, offsetBox.content + 8 + (chunk - 1) * (wide ? 8 : 4), wide);
      for (let i = 0; i < perChunk; i++) {
        if (sample >= frames)
          refuse("is not a structurally valid MP4: it names more samples than it holds");
        const size = sizeOf(sample);
        if (size === 0 || !inMedia(offset, offset + size)) {
          refuse("is not a structurally valid MP4: a picture lies outside its media data");
        }
        offset += size;
        sample += 1;
      }
    }
  }
  if (sample !== frames) refuse("is not a structurally valid MP4: its sample tables disagree");
}

/**
 * The demo a file's bytes state, or why it is not one: an MP4 (`ftyp`
 * first, every box in bounds and the boxes tiling the file), not
 * fragmented, with one track - H.264 video, no sound - inside the demo
 * limits, whose every sample lies in its media data.
 */
export function readDemoVideo(bytes: Buffer): DemoVideoRead {
  try {
    return { ok: true, video: demoVideo(bytes) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}

function demoVideo(bytes: Buffer): DemoVideo {
  if (bytes.length < 8 || bytes.toString("latin1", 4, 8) !== "ftyp") {
    refuse("is not an MP4: it does not start with an ftyp box");
  }
  const top = boxes(bytes, 0, bytes.length);
  const ftyp = top[0] as Box;
  need(ftyp, 8);
  const brands = [bytes.toString("latin1", ftyp.content, ftyp.content + 4)];
  for (let at = ftyp.content + 8; at + 4 <= ftyp.end; at += 4) {
    brands.push(bytes.toString("latin1", at, at + 4));
  }
  if (!brands.some((brand) => BRANDS.has(brand))) {
    refuse("is not an MP4: encode it as an .mp4 file, not a QuickTime or other movie");
  }
  if (top.some((box) => FRAGMENTED.has(box.type))) {
    refuse("is a fragmented MP4: encode it as one plain .mp4 file (with -movflags +faststart)");
  }
  const media = top.filter((box) => box.type === "mdat");
  if (media.length === 0) refuse("is not a structurally valid MP4: it holds no media data");
  const moovBox = only(top, "moov", "movie box");
  const moov = boxes(bytes, moovBox.content, moovBox.end);
  if (moov.some((box) => FRAGMENTED.has(box.type))) {
    refuse("is a fragmented MP4: encode it as one plain .mp4 file (with -movflags +faststart)");
  }
  const movie = timing(bytes, only(moov, "mvhd", "movie header"));
  const tracks = moov.filter((box) => box.type === "trak");
  if (tracks.length === 0) refuse("is not a structurally valid MP4: it has no track");

  const handlers = tracks.map((trak) => {
    const children = boxes(bytes, trak.content, trak.end);
    const mdia = only(children, "mdia", "media box");
    const mdiaChildren = boxes(bytes, mdia.content, mdia.end);
    const hdlr = only(mdiaChildren, "hdlr", "handler");
    need(hdlr, 12);
    return {
      children,
      mdiaChildren,
      handler: bytes.toString("latin1", hdlr.content + 8, hdlr.content + 12),
    };
  });
  if (handlers.some((track) => track.handler === "soun")) {
    refuse("carries sound: a demo is silent, so encode it without audio (-an)");
  }
  if (tracks.length !== 1 || handlers[0]?.handler !== "vide") {
    refuse("must hold exactly one video track and nothing else");
  }
  const { children, mdiaChildren } = handlers[0] as (typeof handlers)[number];

  // The track header: the size the video is shown at.
  const tkhd = only(children, "tkhd", "track header");
  const wideHeader = version(bytes, tkhd) === 1;
  const sizeAt = tkhd.content + 4 + (wideHeader ? 32 : 20) + 52;
  need(tkhd, sizeAt - tkhd.content + 8);
  const shownWidth = bytes.readUInt32BE(sizeAt) >>> 16;
  const shownHeight = bytes.readUInt32BE(sizeAt + 4) >>> 16;

  const track = timing(bytes, only(mdiaChildren, "mdhd", "media header"));
  const minf = only(mdiaChildren, "minf", "media information box");
  const minfChildren = boxes(bytes, minf.content, minf.end);
  const stblBox = only(minfChildren, "stbl", "sample table");
  const stbl = boxes(bytes, stblBox.content, stblBox.end);

  // The one sample description: H.264, and the size it is coded at.
  const stsd = only(stbl, "stsd", "sample description");
  version(bytes, stsd);
  need(stsd, 8);
  if (bytes.readUInt32BE(stsd.content + 4) !== 1) {
    refuse("must describe its pictures one way: re-encode it as one H.264 stream");
  }
  const entries = boxes(bytes, stsd.content + 8, stsd.end);
  const entry = entries[0] as Box;
  if (entries.length !== 1 || (entry.type !== "avc1" && entry.type !== "avc3")) {
    refuse("is not H.264 video: encode it with H.264 (libx264) in an .mp4 file");
  }
  need(entry, 78);
  const codedWidth = bytes.readUInt16BE(entry.content + 24);
  const codedHeight = bytes.readUInt16BE(entry.content + 26);
  const avcC = boxes(bytes, entry.content + 78, entry.end).find((box) => box.type === "avcC");
  if (!avcC) refuse("is not a structurally valid MP4: its H.264 settings are missing");
  const profile = avcProfile(bytes, avcC);

  const width = shownWidth || codedWidth;
  const height = shownHeight || codedHeight;
  if (width === 0 || height === 0 || codedWidth === 0 || codedHeight === 0) {
    refuse("is not a structurally valid MP4: it states no picture size");
  }
  for (const [w, h] of [
    [width, height],
    [codedWidth, codedHeight],
  ] as const) {
    if (Math.max(w, h) > MAX_DEMO_LONG_SIDE || Math.min(w, h) > MAX_DEMO_SHORT_SIDE) {
      refuse(
        `is ${w} × ${h}: a demo is at most ${MAX_DEMO_LONG_SIDE} × ${MAX_DEMO_SHORT_SIDE}, so scale it down`,
      );
    }
  }

  // How long it plays, and how many pictures a second.
  const seconds = Math.max(movie.duration / movie.timescale, track.duration / track.timescale);
  if (!(seconds > 0)) refuse("is not a structurally valid MP4: it states no duration");
  if (seconds > MAX_DEMO_SECONDS) {
    refuse(
      `runs ${seconds.toFixed(1)} seconds: a demo runs at most ${MAX_DEMO_SECONDS}, so trim it to the action`,
    );
  }
  const stts = only(stbl, "stts", "time-to-sample table");
  version(bytes, stts);
  need(stts, 8);
  const runs = bytes.readUInt32BE(stts.content + 4);
  need(stts, 8 + runs * 8);
  let frames = 0;
  for (let run = 0; run < runs; run++) frames += bytes.readUInt32BE(stts.content + 8 + run * 8);
  if (frames < 1) refuse("is not a structurally valid MP4: it holds no pictures");
  const trackSeconds = track.duration / track.timescale;
  if (frames > Math.ceil((trackSeconds || seconds) * MAX_DEMO_FRAME_RATE) + 1) {
    refuse(
      `plays more than ${MAX_DEMO_FRAME_RATE} frames a second: encode it at ${MAX_DEMO_FRAME_RATE} or fewer (24 is the target)`,
    );
  }
  checkSamples(bytes, stbl, media, frames);
  return { width, height, durationMs: Math.round(seconds * 1000), frames, profile };
}
