import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";

// Read the actual packaging input, not a second copy of the source artwork.
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder/package.json"));
const yaml = builder("js-yaml") as { load(text: string): { mac: { icon: string } } };

// The Mac package's icon, as electron-builder.yml hands it to the packager,
// which ships an .icns unchanged.
function macIcon() {
  const config = yaml.load(readFileSync(resolve("electron-builder.yml"), "utf8"));
  const icns = readFileSync(resolve(config.mac.icon));
  expect(icns.toString("ascii", 0, 4), "mac.icon is an icns").toBe("icns");
  expect(icns.readUInt32BE(4)).toBe(icns.length);
  const entries = new Map<string, Buffer>();
  for (let offset = 8; offset < icns.length; ) {
    const length = icns.readUInt32BE(offset + 4);
    entries.set(
      icns.toString("ascii", offset, offset + 4),
      icns.subarray(offset + 8, offset + length),
    );
    offset += length;
  }
  return entries;
}

const isPng = (data: Buffer) => data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";

function iconPixels(png: Buffer) {
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
  const png = macIcon().get("ic10");
  expect(png, "the 1024px entry").toBeDefined();
  const { width, height, alpha } = iconPixels(png ?? Buffer.alloc(0));
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

// The captain's report (INF-1782): the icon drew as a striped square in
// System Settings' Privacy & Security list. electron-builder 26.15's icon tool
// stored the 16-64px sizes as PNG in icp4/icp5/icp6, which macOS's icon
// service decodes as raw pixels at small 1x sizes; macOS reads those sizes
// from ic04/ic05 ARGB, as Apple's iconutil writes them.
it("stores the small Mac icon sizes in a form macOS's icon service draws", () => {
  const entries = macIcon();
  for (const type of ["icp4", "icp5", "icp6"]) {
    const data = entries.get(type);
    expect(data != null && isPng(data), `${type} holds PNG data macOS draws as stripes`).toBe(
      false,
    );
  }
  // Each PNG entry holds the size its type stands for (the builder's tool
  // also wrote 512px into the 256px@2x entry).
  const sizes: Record<string, number> = {
    ic07: 128,
    ic08: 256,
    ic09: 512,
    ic10: 1024,
    ic11: 32,
    ic12: 64,
    ic13: 256,
    ic14: 512,
  };
  for (const [type, data] of entries) {
    if (!isPng(data)) continue;
    expect(sizes[type], `${type} is a known PNG entry`).toBeDefined();
    expect([data.readUInt32BE(16), data.readUInt32BE(20)], type).toEqual([
      sizes[type],
      sizes[type],
    ]);
  }
  // The 1x 16px and 32px pictures are ARGB whose alpha is the rounded, inset
  // body: transparent corners and an opaque centre.
  for (const [type, size] of [
    ["ic04", 16],
    ["ic05", 32],
  ] as const) {
    const data = entries.get(type);
    expect(data?.toString("ascii", 0, 4), `${type} is ARGB`).toBe("ARGB");
    const alpha = unpackBits(data?.subarray(4) ?? Buffer.alloc(0), size * size);
    const at = (x: number, y: number) => alpha[y * size + x];
    expect([at(0, 0), at(size - 1, 0), at(0, size - 1), at(size - 1, size - 1)], type).toEqual([
      0, 0, 0, 0,
    ]);
    expect(at(size / 2, size / 2), type).toBe(255);
  }
});

// icns run-length coding: a byte under 0x80 copies the next n+1 bytes, any
// other repeats the next byte n-0x80+3 times. Returns the first channel.
function unpackBits(data: Buffer, length: number) {
  const out: number[] = [];
  for (let i = 0; out.length < length && i < data.length; ) {
    const n = data[i++] ?? 0;
    if (n < 0x80) {
      for (let k = 0; k <= n; k++) out.push(data[i++] ?? 0);
    } else {
      const value = data[i++] ?? 0;
      for (let k = 0; k < n - 0x80 + 3; k++) out.push(value);
    }
  }
  return out.slice(0, length);
}
