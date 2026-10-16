import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";

// Read the actual packaging input, not a second copy of the source artwork.
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder/package.json"));
const yaml = builder("js-yaml") as { load(text: string): { mac: { icon: string } } };

function iconPixels() {
  const config = yaml.load(readFileSync(resolve("electron-builder.yml"), "utf8"));
  const png = readFileSync(resolve(config.mac.icon));
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8);
  const channels = png[25] === 6 ? 4 : 3;
  expect([2, 6]).toContain(png[25]);
  expect(png[28]).toBe(0); // non-interlaced
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= channels ? (pixels[i - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[i - stride] ?? 0) : 0;
      const diagonal = y > 0 && x >= channels ? (pixels[i - stride - channels] ?? 0) : 0;
      const p = left + up - diagonal;
      const a = Math.abs(p - left);
      const b = Math.abs(p - up);
      const c = Math.abs(p - diagonal);
      const paeth = a <= b && a <= c ? left : b <= c ? up : diagonal;
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth][filter ?? 0] ?? 0;
      pixels[i] = ((raw[y * (stride + 1) + x + 1] ?? 0) + prediction) & 255;
    }
  }
  return {
    width,
    height,
    alpha: (x: number, y: number) => (channels === 4 ? pixels[(y * width + x) * 4 + 3] : 255),
  };
}

it("supplies a rounded, inset icon to macOS versions that do not apply a system mask", () => {
  const { width, height, alpha } = iconPixels();
  expect(width).toBe(1024);
  expect(height).toBe(1024);
  for (const [x, y] of [
    [0, 0],
    [1023, 0],
    [0, 1023],
    [1023, 1023],
    [100, 100],
    [923, 100],
    [100, 923],
    [923, 923],
  ]) {
    expect(alpha(x ?? 0, y ?? 0), `transparent rounded corner (${x},${y})`).toBe(0);
  }
  for (let i = 0; i < 1024; i++) {
    expect(alpha(i, 0)).toBe(0);
    expect(alpha(0, i)).toBe(0);
    expect(alpha(i, 1023)).toBe(0);
    expect(alpha(1023, i)).toBe(0);
  }
  // An approximately 100px margin, with an opaque body rather than a shrunken glyph.
  expect(alpha(90, 512)).toBe(0);
  expect(alpha(110, 512)).toBe(255);
  expect(alpha(512, 90)).toBe(0);
  expect(alpha(512, 110)).toBe(255);
  expect(alpha(512, 512)).toBe(255);
});
