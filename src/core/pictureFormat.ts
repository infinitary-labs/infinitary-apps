/**
 * What a picture file is, read from its own header (card pictures, phase 2;
 * release-notes hero pictures, docs/release-notes.md). Pure and
 * dependency-free, so the release scripts load it with Node's type stripping
 * as well as the core: a structurally valid PNG, JPEG or WebP and the size it
 * states, or nothing.
 */

export type PictureSize = { width: number; height: number };

export type PictureFormat = {
  extension: "png" | "jpg" | "webp";
  label: string;
  size: (bytes: Buffer) => PictureSize | undefined;
};

export const PICTURE_FORMATS: readonly PictureFormat[] = [
  { extension: "png", label: "PNG", size: pngSize },
  { extension: "jpg", label: "JPEG", size: jpegSize },
  { extension: "webp", label: "WebP", size: webpSize },
];

/** The format and size a file's bytes declare, or undefined when it is none of the three. */
export function readPicture(
  bytes: Buffer,
): { format: PictureFormat; size: PictureSize } | undefined {
  for (const format of PICTURE_FORMATS) {
    const size = format.size(bytes);
    if (size) return { format, size };
  }
  return undefined;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** A structurally complete PNG - signature, IHDR first, every chunk in bounds, IEND last - and its size. */
function pngSize(bytes: Buffer): PictureSize | undefined {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  let offset = 8;
  let chunks = 0;
  let size: PictureSize | undefined;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return undefined;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    chunks += 1;
    if (chunks === 1) {
      if (type !== "IHDR" || length !== 13) return undefined;
      const width = bytes.readUInt32BE(offset + 8);
      const height = bytes.readUInt32BE(offset + 12);
      if (width === 0 || height === 0) return undefined;
      size = { width, height };
    }
    if (type === "IEND") return length === 0 && end === bytes.length ? size : undefined;
    offset = end;
  }
  return undefined;
}

/**
 * A JPEG whose marker segments walk cleanly from the start-of-image marker
 * to a start-of-frame that states a non-zero size, before any scan data.
 */
function jpegSize(bytes: Buffer): PictureSize | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] as number;
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // The first scan, or the end of the image, before any frame header.
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 7) return undefined;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

/**
 * A WebP whose RIFF container states exactly the file's length and whose
 * first chunk - lossy `VP8 `, lossless `VP8L` or extended `VP8X` - states a
 * size.
 */
function webpSize(bytes: Buffer): PictureSize | undefined {
  if (bytes.length < 20) return undefined;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
    return undefined;
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) return undefined;
  const type = bytes.toString("ascii", 12, 16);
  const length = bytes.readUInt32LE(16);
  const data = 20;
  if (data + length > bytes.length) return undefined;
  let size: PictureSize | undefined;
  if (type === "VP8 " && length >= 10) {
    // A key frame's start code, then two 14-bit dimensions.
    if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) {
      return undefined;
    }
    size = {
      width: bytes.readUInt16LE(data + 6) & 0x3fff,
      height: bytes.readUInt16LE(data + 8) & 0x3fff,
    };
  } else if (type === "VP8L" && length >= 5) {
    if (bytes[data] !== 0x2f) return undefined;
    const bits = bytes.readUInt32LE(data + 1);
    size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  } else if (type === "VP8X" && length >= 10) {
    size = { width: bytes.readUIntLE(data + 4, 3) + 1, height: bytes.readUIntLE(data + 7, 3) + 1 };
  }
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}
