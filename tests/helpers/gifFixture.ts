import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * GIFs built block by block, for the GIF demo checks
 * (`src/core/gifFormat.ts`). Each frame's picture data is real LZW - nine-bit
 * codes with a clear code before the table would grow - so a decoder draws
 * it; `MOVING_BOX_GIF` is a real single-play recording from the pinned
 * encoder.
 */

/** A 3-second, 480 × 270, 10 frames-a-second single-play GIF of a box sliding right, made by the pinned encoder. */
export const MOVING_BOX_GIF = fileURLToPath(
  new URL("../fixtures/demo/moving-box.gif", import.meta.url),
);
export const MOVING_BOX_GIF_SIZE = {
  width: 480,
  height: 270,
  durationMs: 3000,
  frames: 30,
} as const;

export function movingBoxGifBytes(): Buffer {
  return readFileSync(MOVING_BOX_GIF);
}

export type GifOptions = {
  width?: number;
  height?: number;
  frames?: number;
  /** Each frame's delay in centiseconds: one for all, or one each. */
  delay?: number | number[];
  /** A loop instruction's application block before the frames. */
  loop?: "NETSCAPE2.0" | "ANIMEXTS1.0";
  /** An application block that is not a loop instruction (an XMP packet's). */
  xmp?: boolean;
  /** A frame's box, which may lie outside the picture. */
  frame?: { left: number; top: number; width: number; height: number };
  /** No global color table, so frames have no colors. */
  noColors?: boolean;
  /** The first frame's codes stop this many pixels short. */
  shortBy?: number;
  /** The first frame's first code names an entry the table does not hold. */
  garbled?: boolean;
  /** Bytes after the trailer. */
  trailing?: boolean;
  /** Cut the file this many bytes before its end. */
  truncate?: number;
};

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

/** Data sub-blocks of at most 255 bytes, and their terminator. */
function subBlocks(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let at = 0; at < data.length; at += 255) {
    const piece = data.subarray(at, at + 255);
    parts.push(Buffer.from([piece.length]), piece);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * Nine-bit LZW codes, least significant bit first, for `count` pixels of an
 * 8-bit index each: `pixel(at)` gives the index at that place.
 */
function lzw(count: number, pixel: (at: number) => number, garbled: boolean): Buffer {
  const CLEAR = 256;
  const END = 257;
  // A literal after a clear adds nothing; each one after adds one entry, so
  // a clear every 254 literals keeps the table under 512 and codes at 9 bits.
  const codes = count + Math.ceil(count / 254) + 3;
  const out = Buffer.alloc(Math.ceil((codes * 9) / 8));
  let length = 0;
  let bits = 0;
  let held = 0;
  const put = (code: number) => {
    bits |= code << held;
    held += 9;
    while (held >= 8) {
      out[length++] = bits & 0xff;
      bits >>>= 8;
      held -= 8;
    }
  };
  if (garbled) {
    put(CLEAR);
    put(400);
  }
  for (let at = 0; at < count; at++) {
    if (at % 254 === 0) put(CLEAR);
    put(pixel(at));
  }
  put(END);
  if (held > 0) out[length++] = bits & 0xff;
  return out.subarray(0, length);
}

/** A GIF of `frames` frames, each a band that moves right, single-play unless `loop`. */
export function gif(options: GifOptions = {}): Buffer {
  const width = options.width ?? 64;
  const height = options.height ?? 36;
  const frames = options.frames ?? 20;
  const parts: Buffer[] = [Buffer.from("GIF89a", "latin1"), u16(width), u16(height)];
  if (options.noColors) {
    parts.push(Buffer.from([0x00, 0, 0]));
  } else {
    // A global table of 256 colors (size field 7), a grey ramp.
    parts.push(Buffer.from([0xf7, 0, 0]));
    const table = Buffer.alloc(768);
    for (let i = 0; i < 256; i++) table.fill(i, i * 3, i * 3 + 3);
    parts.push(table);
  }
  if (options.loop) {
    parts.push(Buffer.from([0x21, 0xff, 11]), Buffer.from(options.loop, "latin1"));
    parts.push(Buffer.from([3, 1, 0, 0, 0]));
  }
  if (options.xmp) {
    parts.push(Buffer.from([0x21, 0xff, 11]), Buffer.from("XMP DataXMP", "latin1"));
    parts.push(subBlocks(Buffer.from("<x:xmpmeta/>", "latin1")));
  }
  for (let index = 0; index < frames; index++) {
    const delay = Array.isArray(options.delay)
      ? (options.delay[index] ?? 10)
      : (options.delay ?? 10);
    parts.push(Buffer.from([0x21, 0xf9, 4, 0x04]), u16(delay), Buffer.from([0, 0]));
    const box = options.frame ?? { left: 0, top: 0, width, height };
    parts.push(Buffer.from([0x2c]), u16(box.left), u16(box.top), u16(box.width), u16(box.height));
    parts.push(Buffer.from([0x00]));
    const count = box.width * box.height - (index === 0 ? (options.shortBy ?? 0) : 0);
    const band = Math.floor((index / Math.max(1, frames)) * box.width);
    const pixel = (at: number) => (Math.abs((at % box.width) - band) < 8 ? 220 : 30);
    const garbled = index === 0 && options.garbled === true;
    parts.push(Buffer.from([8]), subBlocks(lzw(count, pixel, garbled)));
  }
  parts.push(Buffer.from([0x3b]));
  if (options.trailing) parts.push(Buffer.from([1, 2, 3]));
  const whole = Buffer.concat(parts);
  return options.truncate ? whole.subarray(0, whole.length - options.truncate) : whole;
}

/**
 * The same GIF told to loop forever: a NETSCAPE2.0 block (loop count 0)
 * after its header and global color table, where encoders write it.
 */
export function looping(bytes: Buffer): Buffer {
  const packed = bytes[10] as number;
  const header = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
  const block = Buffer.concat([
    Buffer.from([0x21, 0xff, 11]),
    Buffer.from("NETSCAPE2.0", "latin1"),
    Buffer.from([3, 1, 0, 0, 0]),
  ]);
  return Buffer.concat([bytes.subarray(0, header), block, bytes.subarray(header)]);
}
