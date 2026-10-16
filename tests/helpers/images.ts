/** Real picture bytes, so a test passes the content check the app makes on every picture it keeps. */
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

export const pngImage = { mimeType: "image/png" as const, data: PNG_BASE64 };
export const jpegImage = { mimeType: "image/jpeg" as const, data: JPEG_BASE64 };

/**
 * A lossy WebP's container and key-frame header stating `width` by
 * `height`, padded to at least `bytes` long: what the app's header reader
 * checks (src/core/pictureFormat.ts), with no pixels to decode. For tests
 * that read a picture's size, never for one that draws it.
 */
export function webpBytes(width: number, height: number, bytes = 0): Buffer {
  const frame = Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0, 0, 0, 0]);
  frame.writeUInt16LE(width, 6);
  frame.writeUInt16LE(height, 8);
  const data = Buffer.concat([frame, Buffer.alloc(Math.max(0, bytes - 30))]);
  const padded = data.length % 2 ? Buffer.concat([data, Buffer.alloc(1)]) : data;
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(12 + padded.length, 4);
  head.write("WEBP", 8, "ascii");
  head.write("VP8 ", 12, "ascii");
  head.writeUInt32LE(data.length, 16);
  return Buffer.concat([head, padded]);
}
