import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * MP4 containers built box by box, for the demo recording checks
 * (`src/core/videoFormat.ts`). Each holds a real H.264 sequence parameter
 * set and a sample table whose every sample lies in its media data, but its
 * samples are filler: these files test what the boxes state, never what a
 * decoder makes of them - `MOVING_BOX_MP4`, a real recording, does that.
 */

/** A 3-second, 480 × 270, 24 frames-a-second H.264 recording of a box sliding right, made by the pinned encoder. */
export const MOVING_BOX_MP4 = fileURLToPath(
  new URL("../fixtures/demo/moving-box.mp4", import.meta.url),
);
export const MOVING_BOX = { width: 480, height: 270, durationMs: 3000, frames: 72 } as const;

export function movingBoxBytes(): Buffer {
  return readFileSync(MOVING_BOX_MP4);
}

/**
 * The same recording with a 3-second AAC tone beside its pictures, as a
 * demo that needs to be heard keeps it: its video copied unchanged, its
 * sound encoded at the voice tool's 24 kHz mono.
 */
export const MOVING_BOX_SOUND_MP4 = fileURLToPath(
  new URL("../fixtures/demo/moving-box-sound.mp4", import.meta.url),
);

export type Mp4Options = {
  width?: number;
  height?: number;
  fps?: number;
  seconds?: number;
  /** The H.264 profile_idc: 66 Baseline, 77 Main, 100 High, 244 High 4:4:4. */
  profile?: number;
  /** chroma_format_idc in a High profile's parameter set: 1 is 4:2:0. */
  chroma?: number;
  /** bit_depth_luma_minus8 in a High profile's parameter set. */
  depth?: number;
  /** The sample entry's type: avc1 is H.264. */
  codec?: string;
  /** A second track with a sound handler. */
  audio?: boolean;
  /** A second video track. */
  secondVideo?: boolean;
  /** The ftyp's major and only brand. */
  brand?: string;
  /** An mvex box in the movie, which makes it fragmented. */
  fragmented?: boolean;
  /** The chunk offset points this many bytes past where the media data starts. */
  shiftSamples?: number;
};

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

export function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, "latin1"), body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Buffer[]): Buffer {
  return box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...payload);
}

/** Bits, written most significant first, with unsigned Exp-Golomb numbers. */
function bits(): {
  bit: (value: number) => void;
  ue: (value: number) => void;
  bytes: () => Buffer;
} {
  const out: number[] = [];
  const bit = (value: number) => out.push(value & 1);
  return {
    bit,
    ue(value: number) {
      const code = (value + 1).toString(2);
      for (let i = 1; i < code.length; i++) bit(0);
      for (const digit of code) bit(Number(digit));
    },
    bytes() {
      // The RBSP stop bit, then zeros to a byte.
      bit(1);
      while (out.length % 8) bit(0);
      const bytes: number[] = [];
      for (let at = 0; at < out.length; at += 8) {
        bytes.push(out.slice(at, at + 8).reduce((byte, value) => byte * 2 + value, 0));
      }
      return Buffer.from(bytes);
    },
  };
}

function sps(profile: number, chroma: number, depth: number): Buffer {
  const rbsp = bits();
  rbsp.ue(0); // seq_parameter_set_id
  if (profile === 100 || profile === 244) {
    rbsp.ue(chroma);
    if (chroma === 3) rbsp.bit(0);
    rbsp.ue(depth);
    rbsp.ue(depth);
  }
  rbsp.ue(0); // log2_max_frame_num_minus4
  return Buffer.concat([Buffer.from([0x67, profile, 0, 30]), rbsp.bytes()]);
}

function videoTrack(
  options: Required<Omit<Mp4Options, "brand" | "fragmented" | "audio" | "secondVideo">>,
  offset: number,
): Buffer {
  const { width, height, fps, seconds, profile, chroma, depth, codec } = options;
  const frames = Math.round(seconds * fps);
  const timescale = fps * 100;
  const set = sps(profile, chroma, depth);
  const avcC = box(
    "avcC",
    Buffer.from([1, profile, 0, 30, 0xff, 0xe1]),
    u16(set.length),
    set,
    Buffer.from([1]),
    u16(4),
    Buffer.from([0x68, 0xee, 0x3c, 0x80]),
  );
  const entry = box(
    codec,
    Buffer.alloc(6),
    u16(1),
    Buffer.alloc(16),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    Buffer.alloc(32),
    u16(0x18),
    u16(0xffff),
    avcC,
  );
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), entry),
    fullBox("stts", 0, 0, u32(1), u32(frames), u32(100)),
    fullBox("stsc", 0, 0, u32(1), u32(1), u32(frames), u32(1)),
    fullBox("stsz", 0, 0, u32(0), u32(frames), ...Array.from({ length: frames }, () => u32(10))),
    fullBox("stco", 0, 0, u32(1), u32(offset)),
  );
  const matrix = Buffer.concat([
    u32(0x10000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x10000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000),
  ]);
  return box(
    "trak",
    fullBox(
      "tkhd",
      0,
      3,
      u32(0),
      u32(0),
      u32(1),
      u32(0),
      u32(seconds * 1000),
      Buffer.alloc(8),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      matrix,
      u32(width << 16),
      u32(height << 16),
    ),
    box(
      "mdia",
      fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(frames * 100), u16(0x55c4), u16(0)),
      fullBox(
        "hdlr",
        0,
        0,
        u32(0),
        Buffer.from("vide"),
        Buffer.alloc(12),
        Buffer.from("VideoHandler\0"),
      ),
      box("minf", stbl),
    ),
  );
}

function soundTrack(): Buffer {
  return box(
    "trak",
    box(
      "mdia",
      fullBox("mdhd", 0, 0, u32(0), u32(0), u32(44100), u32(44100), u16(0x55c4), u16(0)),
      fullBox(
        "hdlr",
        0,
        0,
        u32(0),
        Buffer.from("soun"),
        Buffer.alloc(12),
        Buffer.from("SoundHandler\0"),
      ),
    ),
  );
}

/** An MP4 as `options` describe it: by default a valid 2-second 640 × 360 High-profile 24 fps demo. */
export function mp4(options: Mp4Options = {}): Buffer {
  const track = {
    width: options.width ?? 640,
    height: options.height ?? 360,
    fps: options.fps ?? 24,
    seconds: options.seconds ?? 2,
    profile: options.profile ?? 100,
    chroma: options.chroma ?? 1,
    depth: options.depth ?? 0,
    codec: options.codec ?? "avc1",
    shiftSamples: options.shiftSamples ?? 0,
  };
  const frames = Math.round(track.seconds * track.fps);
  const brand = options.brand ?? "isom";
  const ftyp = box("ftyp", Buffer.from(brand, "latin1"), u32(0x200), Buffer.from(brand, "latin1"));
  const moovFor = (offset: number) =>
    box(
      "moov",
      fullBox(
        "mvhd",
        0,
        0,
        u32(0),
        u32(0),
        u32(1000),
        u32(track.seconds * 1000),
        u32(0x10000),
        u16(0x100),
        Buffer.alloc(10),
        Buffer.alloc(36),
        Buffer.alloc(24),
        u32(options.audio ? 3 : 2),
      ),
      videoTrack(track, offset),
      ...(options.audio ? [soundTrack()] : []),
      ...(options.secondVideo ? [videoTrack(track, offset)] : []),
      ...(options.fragmented ? [box("mvex", fullBox("trex", 0, 0, Buffer.alloc(20)))] : []),
    );
  const placeholder = moovFor(0);
  const mediaStart = ftyp.length + placeholder.length + 8;
  const moov = moovFor(mediaStart + track.shiftSamples);
  return Buffer.concat([ftyp, moov, box("mdat", Buffer.alloc(frames * 10))]);
}
