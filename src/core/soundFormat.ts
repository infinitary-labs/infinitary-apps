import {
  aacTrack,
  type Box,
  BRANDS,
  boxes,
  FRAGMENTED,
  need,
  only,
  Refusal,
  refuse,
  timing,
} from "./videoFormat";

/**
 * What a card's sound clip is, read from its own bytes (docs/card-authoring.md
 * "Sound clips"). Pure and dependency-free like `./videoFormat`: an M4A
 * holding one AAC track and nothing else, an MP3 that is Layer III frames
 * from its start to its end, or a WAV holding PCM data, with how long it
 * plays - or the one reason it is not, worded for the crewmate who made it.
 *
 * Reading the bytes is a check of the file, not of its sound: the host still
 * decodes it at its start, middle and end before it keeps one (`MediaProbe`,
 * `src/core/pi/cardImages.ts`). A clip has no length limit; only its size is
 * held, by the card's check.
 */

export const SOUND_HOLDS_PICTURES =
  "holds pictures: a sound clip is sound alone, so take the video out (-vn), or show it as a demo";

export type SoundKind = "m4a" | "mp3" | "wav";

export type SoundClip = { kind: SoundKind; durationMs: number };

export type SoundClipRead = { ok: true; clip: SoundClip } | { ok: false; reason: string };

/** The brands an M4A's `ftyp` may name: a demo's, and the one an `.m4a` encoder writes. */
const SOUND_BRANDS = new Set([...BRANDS, "M4A "]);

const NOT_A_CLIP =
  "is not an M4A, MP3 or WAV sound clip: encode it as one (an .m4a with AAC, an .mp3, or a .wav)";

/**
 * The clip a file's bytes state, or why it is not one. Its kind is read from
 * the bytes, never from its name.
 */
export function readSoundClip(bytes: Buffer): SoundClipRead {
  try {
    if (bytes.length >= 8 && bytes.toString("latin1", 4, 8) === "ftyp") {
      return { ok: true, clip: { kind: "m4a", durationMs: m4aMs(bytes) } };
    }
    if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF") {
      if (bytes.toString("latin1", 8, 12) !== "WAVE") refuse(NOT_A_CLIP);
      return { ok: true, clip: { kind: "wav", durationMs: wavMs(bytes) } };
    }
    if (isMp3Start(bytes)) return { ok: true, clip: { kind: "mp3", durationMs: mp3Ms(bytes) } };
    refuse(NOT_A_CLIP);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}

/** The length of an M4A: one AAC track, no picture, every sample in its media data. */
function m4aMs(bytes: Buffer): number {
  const top = boxes(bytes, 0, bytes.length);
  const ftyp = top[0] as Box;
  need(ftyp, 8);
  const brands = [bytes.toString("latin1", ftyp.content, ftyp.content + 4)];
  for (let at = ftyp.content + 8; at + 4 <= ftyp.end; at += 4) {
    brands.push(bytes.toString("latin1", at, at + 4));
  }
  if (!brands.some((brand) => SOUND_BRANDS.has(brand))) {
    refuse("is not an M4A: encode it as an .m4a file with AAC, not a QuickTime or other movie");
  }
  if (top.some((box) => FRAGMENTED.has(box.type))) {
    refuse("is a fragmented M4A: encode it as one plain .m4a file (with -movflags +faststart)");
  }
  const media = top.filter((box) => box.type === "mdat");
  if (media.length === 0) refuse("is not a structurally valid MP4: it holds no media data");
  const moovBox = only(top, "moov", "movie box");
  const moov = boxes(bytes, moovBox.content, moovBox.end);
  if (moov.some((box) => FRAGMENTED.has(box.type))) {
    refuse("is a fragmented M4A: encode it as one plain .m4a file (with -movflags +faststart)");
  }
  const movie = timing(bytes, only(moov, "mvhd", "movie header"));
  const tracks = moov
    .filter((box) => box.type === "trak")
    .map((trak) => {
      const mdia = only(boxes(bytes, trak.content, trak.end), "mdia", "media box");
      const mdiaChildren = boxes(bytes, mdia.content, mdia.end);
      const hdlr = only(mdiaChildren, "hdlr", "handler");
      need(hdlr, 12);
      return {
        mdiaChildren,
        handler: bytes.toString("latin1", hdlr.content + 8, hdlr.content + 12),
      };
    });
  if (tracks.length === 0) refuse("is not a structurally valid MP4: it has no track");
  if (tracks.some((track) => track.handler === "vide")) {
    refuse(SOUND_HOLDS_PICTURES);
  }
  if (tracks.length !== 1 || tracks[0]?.handler !== "soun") {
    refuse("must hold exactly one sound track and nothing else");
  }
  const { mdiaChildren } = tracks[0] as (typeof tracks)[number];
  const track = aacTrack(bytes, mdiaChildren, media);
  const seconds = Math.max(movie.duration / movie.timescale, track.seconds);
  if (!(seconds > 0)) refuse("is not a structurally valid MP4: it states no duration");
  return Math.round(seconds * 1000);
}

/** A WAV's length: a `fmt ` of PCM, then its `data`, every chunk inside the file. */
function wavMs(bytes: Buffer): number {
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) {
    refuse("is not a structurally valid WAV: its size does not match the file");
  }
  let format: { byteRate: number; blockAlign: number } | undefined;
  let data = 0;
  let at = 12;
  while (at < bytes.length) {
    if (bytes.length - at < 8) refuse("is not a structurally valid WAV: it ends inside a chunk");
    const id = bytes.toString("latin1", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const content = at + 8;
    if (content + size > bytes.length) {
      refuse("is not a structurally valid WAV: a chunk runs past the end of the file");
    }
    if (id === "fmt ") {
      if (format) refuse("is not a structurally valid WAV: it describes its sound twice");
      format = pcmFormat(bytes, content, size);
    } else if (id === "data") {
      if (!format) refuse("is not a structurally valid WAV: its sound comes before its format");
      if (data > 0) refuse("is not a structurally valid WAV: it holds its sound twice");
      if (size === 0 || size % format.blockAlign !== 0) {
        refuse("is not a structurally valid WAV: its sound is cut short");
      }
      data = size;
    }
    // A chunk of odd size is followed by one byte of padding.
    at = content + size + (size % 2);
  }
  if (!format || data === 0) refuse("is not a structurally valid WAV: it holds no sound");
  return Math.round((data / format.byteRate) * 1000);
}

function pcmFormat(
  bytes: Buffer,
  content: number,
  size: number,
): { byteRate: number; blockAlign: number } {
  if (size < 16) refuse("is not a structurally valid WAV: its format is cut short");
  const tag = bytes.readUInt16LE(content);
  const channels = bytes.readUInt16LE(content + 2);
  const sampleRate = bytes.readUInt32LE(content + 4);
  const byteRate = bytes.readUInt32LE(content + 8);
  const blockAlign = bytes.readUInt16LE(content + 12);
  const bits = bytes.readUInt16LE(content + 14);
  // The extensible form names its own format in the first two bytes of its subformat.
  const pcm = tag === 1 || (tag === 0xfffe && size >= 40 && bytes.readUInt16LE(content + 24) === 1);
  if (!pcm) refuse("is not PCM sound: encode the WAV as plain PCM (-c:a pcm_s16le)");
  if (
    channels < 1 ||
    sampleRate < 1 ||
    ![8, 16, 24, 32].includes(bits) ||
    blockAlign !== (channels * bits) / 8 ||
    byteRate !== sampleRate * blockAlign
  ) {
    refuse("is not a structurally valid WAV: its format disagrees with itself");
  }
  return { byteRate, blockAlign };
}

/** Kilobits a second by bitrate index for Layer III: MPEG-1, then MPEG-2 and 2.5. */
const MP3_BITRATES = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
] as const;

/** Samples a second by sample-rate index, for MPEG-1, MPEG-2 and MPEG-2.5. */
const MP3_RATES: Readonly<Record<number, readonly number[]>> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

type Mp3Frame = { length: number; samples: number; rate: number; sideInfo: number };

/** The Layer III frame whose header starts at `at`, or undefined where none does. */
function mp3Frame(bytes: Buffer, at: number): Mp3Frame | undefined {
  if (at + 4 > bytes.length) return undefined;
  const header = bytes.readUInt32BE(at);
  if (header >>> 21 !== 0x7ff) return undefined;
  const versionBits = (header >>> 19) & 3;
  const layer = (header >>> 17) & 3;
  const bitrateIndex = (header >>> 12) & 15;
  const rateIndex = (header >>> 10) & 3;
  const padding = (header >>> 9) & 1;
  const mono = ((header >>> 6) & 3) === 3;
  const rates = MP3_RATES[versionBits];
  if (!rates || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
    return undefined;
  }
  const mpeg1 = versionBits === 3;
  const kbps = (MP3_BITRATES[mpeg1 ? 0 : 1][bitrateIndex] as number) * 1000;
  const rate = rates[rateIndex] as number;
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * kbps) / rate) + padding;
  // Where an encoder's Xing or Info frame writes its tag: after the header and side information.
  const sideInfo = 4 + (mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17);
  return { length, samples, rate, sideInfo };
}

/** The bytes an ID3v2 tag at `at` takes, header and footer included, or 0 where none starts. */
function id3Length(bytes: Buffer, at: number): number {
  if (at + 10 > bytes.length || bytes.toString("latin1", at, at + 3) !== "ID3") return 0;
  let size = 0;
  for (let i = 0; i < 4; i++) {
    const byte = bytes[at + 6 + i] as number;
    if (byte & 0x80) refuse("is not a structurally valid MP3: its tag is malformed");
    size = size * 128 + byte;
  }
  const footer = ((bytes[at + 5] as number) & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

function isMp3Start(bytes: Buffer): boolean {
  return (
    (bytes.length >= 10 && bytes.toString("latin1", 0, 3) === "ID3") ||
    mp3Frame(bytes, 0) !== undefined
  );
}

/**
 * An MP3's length: its tags, then Layer III frames one after another to its
 * end, where an ID3v1 tag may close it. An encoder's Xing or Info frame
 * holds no sound, so it adds no time.
 */
function mp3Ms(bytes: Buffer): number {
  let at = 0;
  for (let tag = id3Length(bytes, at); tag > 0; tag = id3Length(bytes, at)) {
    at += tag;
    if (at > bytes.length) refuse("is not a structurally valid MP3: its tag runs past the end");
  }
  let seconds = 0;
  let frames = 0;
  while (at < bytes.length) {
    const rest = bytes.length - at;
    if (rest === 128 && bytes.toString("latin1", at, at + 3) === "TAG") break;
    const frame = mp3Frame(bytes, at);
    if (!frame) {
      refuse(
        frames === 0
          ? "is not an MP3 made of Layer III frames: encode it again as an .mp3 (-c:a libmp3lame)"
          : "is not a structurally valid MP3: something other than sound lies between its frames",
      );
    }
    if (frame.length > rest) refuse("is not a structurally valid MP3: its last frame is cut short");
    const tagged = bytes.toString("latin1", at + frame.sideInfo, at + frame.sideInfo + 4);
    const info = frames === 0 && (tagged === "Xing" || tagged === "Info");
    if (!info) seconds += frame.samples / frame.rate;
    frames += 1;
    at += frame.length;
  }
  if (!(seconds > 0)) refuse("is not a structurally valid MP3: it holds no sound");
  return Math.round(seconds * 1000);
}
