import { crc32, deflateSync } from "node:zlib";

/** A real, deterministic PNG with enough entropy to exercise picture wire-size limits. */
export function customPicture(width = 1920, height = 1228): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // grayscale
  const raw = Buffer.alloc((width + 1) * height);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x <= width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raw[y * (width + 1) + x] = seed >>> 24;
    }
  }
  const chunk = (name: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
