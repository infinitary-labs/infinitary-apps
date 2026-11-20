import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";

/**
 * Real PNG, JPEG and WebP files for the card-picture specs, built at run
 * time so no binary fixture is checked in. Each picture carries a red band on its leading edge
 * and a blue band on its trailing edge, so a crop is visible in a screenshot:
 * a picture shown whole shows both.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

type Rgb = readonly [number, number, number];

/** An 8-bit RGB PNG, `pixel(x, y)` per pixel. */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const LEADING: Rgb = [230, 80, 60];
const TRAILING: Rgb = [60, 120, 230];
const BAND = 40;

/** The middle of a picture: a gradient along its longer axis, tinted per picture. */
function middle(at: number, along: number, tint: number): Rgb {
  return [40 + tint * 24, 180 - Math.floor((at / along) * 120), 160 - tint * 12];
}

/** A picture whose bands run along its longer axis's two ends. */
function bandedPng(width: number, height: number, tint: number): Buffer {
  const along = width >= height ? width : height;
  return encodePng(width, height, (x, y) => {
    const at = width >= height ? x : y;
    if (at < BAND) return LEADING;
    if (at >= along - BAND) return TRAILING;
    return middle(at, along, tint);
  });
}

export type PictureFormat = "png" | "jpeg" | "webp";

export type PictureFixture = {
  /** Where the crewmate writes it, relative to its working copy. */
  path: string;
  alt: string;
  width: number;
  height: number;
  format: PictureFormat;
  tint: number;
  /**
   * The file's bytes. A PNG is encoded here; a JPEG or a WebP comes from
   * the browser's own encoder, in the app, before the crewmate writes it
   * (`encodeInBrowser`), so no binary fixture is checked in.
   */
  bytes?: Buffer;
};

function fixture(
  path: string,
  alt: string,
  width: number,
  height: number,
  { format = "png", tint = 0 }: { format?: PictureFormat; tint?: number } = {},
): PictureFixture {
  return {
    path,
    alt,
    width,
    height,
    format,
    tint,
    ...(format === "png" ? { bytes: bandedPng(width, height, tint) } : {}),
  };
}

/** The locked plan's two binding shapes: a very wide and a very tall picture. */
export const WIDE_PICTURE = fixture("shots/wide.png", "The whole meter row", 2800, 520);
export const TALL_PICTURE = fixture("shots/tall.png", "The full transcript", 900, 2660);
/** A body that carries its picture itself, as a hand-inlined data: URL. */
export const INLINE_PICTURE = fixture("", "The settings screen", 1200, 700);

/**
 * The first group (card pictures, phase 2): a tall lead and two thumbnails
 * in the other two formats a card accepts.
 */
export const FIRST_GROUP: PictureFixture[] = [
  TALL_PICTURE,
  fixture("shots/diff.jpg", "The change, side by side", 1200, 760, { format: "jpeg", tint: 1 }),
  fixture("shots/phone.webp", "The settings view on a phone", 640, 1280, {
    format: "webp",
    tint: 2,
  }),
];

/** The second group: a wide lead and seven more, so two stay behind a "+2". */
export const SECOND_GROUP: PictureFixture[] = [
  WIDE_PICTURE,
  ...[
    [1200, 800],
    [1200, 760],
    [640, 1280],
    [1600, 900],
    [900, 900],
    [1200, 800],
    [2000, 400],
  ].map(([width, height], index) =>
    fixture(`shots/row-${index + 1}.png`, `The row, view ${index + 1}`, width ?? 1, height ?? 1, {
      tint: (index % 4) + 1,
    }),
  ),
];

/**
 * A merge card's before and after pictures: two views the change alters, as
 * they stood, the same two as they are now, and a third that is new.
 */
export const CHANGE_BEFORE_PICTURES: PictureFixture[] = [
  fixture("shots/meters-before.png", "The meter row, before", 1200, 420, { tint: 1 }),
  fixture("shots/transcript-before.png", "The transcript, before", 1200, 700, { tint: 2 }),
];
export const CHANGE_AFTER_PICTURES: PictureFixture[] = [
  fixture("shots/meters-after.png", "The meter row, after", 1200, 420, { tint: 3 }),
  fixture("shots/transcript-after.png", "The transcript, after", 1200, 700, { tint: 4 }),
  fixture("shots/history-after.png", "The history list, new", 1200, 600, { tint: 5 }),
];

/** Every file a crewmate writes into its working copy for the picture cards. */
export const WORKING_COPY_PICTURES: PictureFixture[] = [
  ...new Map([...FIRST_GROUP, ...SECOND_GROUP].map((p) => [p.path, p])).values(),
];

export function bytesOf(picture: PictureFixture): Buffer {
  if (!picture.bytes) throw new Error(`${picture.path} was never encoded`);
  return picture.bytes;
}

export function dataUrl(picture: PictureFixture): string {
  return `data:image/png;base64,${bytesOf(picture).toString("base64")}`;
}

/**
 * Encodes every JPEG and WebP fixture with the app's own browser encoder:
 * the same bands and tint as a PNG fixture, so each is a real file of its
 * format the renderer decodes.
 */
export async function encodeInBrowser(page: Page, pictures: PictureFixture[]): Promise<void> {
  for (const picture of pictures) {
    if (picture.bytes) continue;
    const encoded = await page.evaluate(
      async ({ width, height, tint, type, band, leading, trailing }) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        const along = width >= height ? width : height;
        for (let at = 0; at < along; at += 1) {
          const rgb =
            at < band
              ? leading
              : at >= along - band
                ? trailing
                : [40 + tint * 24, 180 - Math.floor((at / along) * 120), 160 - tint * 12];
          context.fillStyle = `rgb(${rgb.join(",")})`;
          if (width >= height) context.fillRect(at, 0, 1, height);
          else context.fillRect(0, at, width, 1);
        }
        const blob = await canvas.convertToBlob({ type, quality: 0.92 });
        let binary = "";
        for (const byte of new Uint8Array(await blob.arrayBuffer())) {
          binary += String.fromCharCode(byte);
        }
        return { type: blob.type, base64: btoa(binary) };
      },
      {
        width: picture.width,
        height: picture.height,
        tint: picture.tint,
        type: `image/${picture.format}`,
        band: BAND,
        leading: [...LEADING],
        trailing: [...TRAILING],
      },
    );
    if (encoded.type !== `image/${picture.format}`) {
      throw new Error(`the browser encoded ${picture.path} as ${encoded.type}`);
    }
    picture.bytes = Buffer.from(encoded.base64, "base64");
  }
}
