/**
 * What a demo GIF is, read from its own blocks (demo videos,
 * docs/card-authoring.md "Demo recordings"): the single-play fallback for a
 * demo no MP4 could be made of. Pure and dependency-free like
 * `./videoFormat`: a structurally valid GIF within the GIF demo limits that
 * plays once, and what it states about itself, or the one reason it is not,
 * worded for the crewmate who made it.
 *
 * A GIF goes through no player probe: this walk is its whole check, so it
 * decodes every frame's picture data (its LZW codes) to the frame's last
 * pixel, and a frame cut short or garbled is refused here rather than met
 * by the captain as a blank. It times each frame as Chromium shows it - a
 * delay of 10 ms or less is shown for 100 ms - and refuses a loop
 * instruction (a NETSCAPE2.0 or ANIMEXTS1.0 block): with none, a GIF plays
 * once and rests on its last frame.
 */

/** The longest a GIF demo may play. */
export const MAX_GIF_DEMO_SECONDS = 10;
/** The most frames a second a GIF demo may play. */
export const MAX_GIF_DEMO_FRAME_RATE = 10;
/** A GIF demo's longer side, at most. */
export const MAX_GIF_DEMO_LONG_SIDE = 1280;
/** A GIF demo's shorter side, at most. */
export const MAX_GIF_DEMO_SHORT_SIDE = 720;
/** The largest GIF demo a card may play: the fallback is shorter and smaller than an MP4. */
export const MAX_GIF_DEMO_BYTES = 8 * 1024 * 1024;
/** The most frames a GIF demo may hold: its longest length at its highest frame rate. */
export const MAX_GIF_DEMO_FRAMES = MAX_GIF_DEMO_SECONDS * MAX_GIF_DEMO_FRAME_RATE;
/** A refusal's words for a GIF told to loop; a scripted stand-in recognizes them. */
export const GIF_LOOP_WORDS = "carries a loop instruction";

/** The shortest a frame may show, in centiseconds: one frame at the highest frame rate. */
const MIN_DELAY_CS = 100 / MAX_GIF_DEMO_FRAME_RATE;
/** Application extensions that tell a player to loop. */
const LOOPS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0"]);
/** The longest LZW code, and so the size of a decoder's table. */
const MAX_CODES = 4096;

export type DemoGif = {
  /** The size it is shown at (its logical screen), in pixels. */
  width: number;
  height: number;
  /** How long it plays once, as Chromium times its frames. */
  durationMs: number;
  /** How many frames it holds. */
  frames: number;
};

export type DemoGifRead = { ok: true; gif: DemoGif } | { ok: false; reason: string };

class Refusal extends Error {}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

/** Whether the bytes start as a GIF does, so they are read as one rather than as an MP4. */
export function isGif(bytes: Buffer): boolean {
  const signature = bytes.toString("latin1", 0, 6);
  return signature === "GIF89a" || signature === "GIF87a";
}

/**
 * The demo a file's bytes state, or why it is not one: a GIF whose blocks
 * walk from its header to its trailer and end the file, with at least two
 * frames, each inside the picture, with colors and picture data that decode
 * to its last pixel, no loop instruction, and within the GIF demo limits.
 */
export function readDemoGif(bytes: Buffer): DemoGifRead {
  try {
    return { ok: true, gif: demoGif(bytes) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}

/** A walk over the file's bytes that refuses any read past its end. */
class Reader {
  at = 0;
  readonly bytes: Buffer;
  constructor(bytes: Buffer) {
    this.bytes = bytes;
  }

  need(count: number): void {
    if (this.at + count > this.bytes.length) {
      refuse("is not a structurally valid GIF: it ends before its trailer");
    }
  }

  byte(): number {
    this.need(1);
    return this.bytes[this.at++] as number;
  }

  u16(): number {
    this.need(2);
    const value = this.bytes.readUInt16LE(this.at);
    this.at += 2;
    return value;
  }

  skip(count: number): void {
    this.need(count);
    this.at += count;
  }

  /** A run of data sub-blocks to its zero terminator, each a slice of the file. */
  subBlocks(): Buffer[] {
    const blocks: Buffer[] = [];
    for (;;) {
      const size = this.byte();
      if (size === 0) return blocks;
      this.need(size);
      blocks.push(this.bytes.subarray(this.at, this.at + size));
      this.at += size;
    }
  }
}

/** The bytes a color table takes, from a descriptor's packed field. */
function colorTableBytes(packed: number): number {
  return packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
}

/**
 * How many pixels a frame's LZW codes decode to, or undefined when a code
 * names nothing the table holds yet. Only each code's length is kept: the
 * walk proves the codes are whole and fill the frame, not what they draw.
 */
function decodedPixels(data: Buffer, minCodeSize: number): number | undefined {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const lengths = new Uint16Array(MAX_CODES);
  lengths.fill(1, 0, clear);
  let size = minCodeSize + 1;
  let next = end + 1;
  let prev = -1;
  let pixels = 0;
  let bits = 0;
  let held = 0;
  let at = 0;
  for (;;) {
    while (held < size) {
      // Codes that stop without an end code: what decoded is what there is.
      if (at >= data.length) return pixels;
      bits |= (data[at++] as number) << held;
      held += 8;
    }
    const code = bits & ((1 << size) - 1);
    bits >>>= size;
    held -= size;
    if (code === clear) {
      size = minCodeSize + 1;
      next = end + 1;
      prev = -1;
      continue;
    }
    if (code === end) return pixels;
    if (prev === -1) {
      // The first code after a clear is one pixel.
      if (code > clear) return undefined;
      pixels += 1;
      prev = code;
      continue;
    }
    let length: number;
    if (code < next) length = lengths[code] as number;
    else if (code === next) length = (lengths[prev] as number) + 1;
    else return undefined;
    pixels += length;
    if (next < MAX_CODES) {
      lengths[next] = (lengths[prev] as number) + 1;
      next += 1;
      if (next === 1 << size && size < 12) size += 1;
    }
    prev = code;
  }
}

function demoGif(bytes: Buffer): DemoGif {
  if (!isGif(bytes)) refuse("is not a GIF: it does not start with GIF89a or GIF87a");
  const read = new Reader(bytes);
  read.skip(6);
  const width = read.u16();
  const height = read.u16();
  const packed = read.byte();
  read.skip(2);
  if (width === 0 || height === 0) refuse("is not a structurally valid GIF: it states no size");
  if (
    Math.max(width, height) > MAX_GIF_DEMO_LONG_SIDE ||
    Math.min(width, height) > MAX_GIF_DEMO_SHORT_SIDE
  ) {
    refuse(
      `is ${width} × ${height}: a GIF demo is at most ${MAX_GIF_DEMO_LONG_SIDE} × ${MAX_GIF_DEMO_SHORT_SIDE}, so scale it down`,
    );
  }
  const globalColors = colorTableBytes(packed);
  read.skip(globalColors);

  let frames = 0;
  let durationCs = 0;
  // The delay the next frame's Graphic Control Extension states, in centiseconds.
  let delay = 0;
  for (;;) {
    const introducer = read.byte();
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      const label = read.byte();
      const blocks = read.subBlocks();
      if (label === 0xf9) {
        const control = blocks[0];
        if (blocks.length !== 1 || control?.length !== 4) {
          refuse("is not a structurally valid GIF: a frame's timing block is malformed");
        }
        delay = control.readUInt16LE(1);
      } else if (label === 0xff) {
        const name = blocks[0]?.toString("latin1", 0, 11) ?? "";
        if (LOOPS.has(name)) {
          refuse(
            `${GIF_LOOP_WORDS} (its ${name} block): a GIF demo plays once, so make it with -loop -1`,
          );
        }
      }
      continue;
    }
    if (introducer !== 0x2c) {
      refuse("is not a structurally valid GIF: a block of an unknown kind follows its frames");
    }
    const left = read.u16();
    const top = read.u16();
    const frameWidth = read.u16();
    const frameHeight = read.u16();
    const framePacked = read.byte();
    if (frameWidth === 0 || frameHeight === 0) {
      refuse("is not a structurally valid GIF: a frame states no size");
    }
    if (left + frameWidth > width || top + frameHeight > height) {
      refuse("is not a structurally valid GIF: a frame lies outside its picture");
    }
    const localColors = colorTableBytes(framePacked);
    if (globalColors === 0 && localColors === 0) {
      refuse("is not a structurally valid GIF: a frame has no colors to draw with");
    }
    read.skip(localColors);
    const minCodeSize = read.byte();
    if (minCodeSize < 2 || minCodeSize > 8) {
      refuse("is not a structurally valid GIF: a frame's picture data is malformed");
    }
    const pixels = decodedPixels(Buffer.concat(read.subBlocks()), minCodeSize);
    if (pixels === undefined) {
      refuse("is not a structurally valid GIF: a frame's picture data does not decode");
    }
    if (pixels < frameWidth * frameHeight) {
      refuse("is not a structurally valid GIF: a frame's picture data is cut short");
    }
    frames += 1;
    if (frames > MAX_GIF_DEMO_FRAMES) {
      refuse(
        `holds more than ${MAX_GIF_DEMO_FRAMES} frames: a GIF demo plays at most ${MAX_GIF_DEMO_SECONDS} seconds at ${MAX_GIF_DEMO_FRAME_RATE} frames a second`,
      );
    }
    // Chromium shows a frame of 10 ms or less for 100 ms.
    const shown = delay <= 1 ? 10 : delay;
    if (shown < MIN_DELAY_CS) {
      refuse(
        `shows a frame for ${shown * 10} ms: a GIF demo plays at most ${MAX_GIF_DEMO_FRAME_RATE} frames a second, so make it at ${MAX_GIF_DEMO_FRAME_RATE} or fewer`,
      );
    }
    durationCs += shown;
    delay = 0;
  }
  if (read.at !== bytes.length) {
    refuse("is not a structurally valid GIF: bytes follow its trailer");
  }
  if (frames < 2) {
    refuse("holds one picture and does not move: attach it as a picture instead");
  }
  if (durationCs > MAX_GIF_DEMO_SECONDS * 100) {
    refuse(
      `runs ${(durationCs / 100).toFixed(1)} seconds: a GIF demo runs at most ${MAX_GIF_DEMO_SECONDS}, so trim it to the action`,
    );
  }
  return { width, height, durationMs: durationCs * 10, frames };
}
