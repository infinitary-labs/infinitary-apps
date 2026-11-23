import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

/**
 * Font files for the project-font checks (docs/card-authoring.md, "Fonts by
 * reference"). The real one is a project's own typeface, a WOFF2 as a
 * project keeps it, and one that looks nothing like Infinitary's own type;
 * the damaged ones are what a broken download or a careless copy leaves of
 * it. The SFNT, WOFF and collection builders lay out a table directory
 * around the tables they are given, as a font tool would: they test what
 * the file's structure states, never what a font engine makes of the glyphs
 * - only the real WOFF2 does that.
 */

/**
 * Fredoka's Latin subset, weights 300 to 700: a real WOFF2 of 29,704 bytes as
 * Google Fonts serves it, the rounded face of the plan's example project
 * (`tests/fixtures/fonts/OFL.txt`, SIL Open Font License 1.1).
 */
export const PROJECT_FONT_FILE = fileURLToPath(
  new URL("../fixtures/fonts/fredoka-latin.woff2", import.meta.url),
);

export function projectFontBytes(): Buffer {
  return readFileSync(PROJECT_FONT_FILE);
}

/** The real font cut short, as an interrupted download leaves it: its header still claims the whole file. */
export function truncatedFontBytes(length = 2_000): Buffer {
  return projectFontBytes().subarray(0, length);
}

/**
 * The real font with a run of its compressed table data zeroed, as a
 * damaged copy is: the header, the table directory and every length stay
 * whole, so only decompressing it - the font engine's job - finds the damage.
 */
export function damagedFontBytes(): Buffer {
  const bytes = Buffer.from(projectFontBytes());
  bytes.fill(0, 400, 4_400);
  return bytes;
}

export type FontTable = { tag: string; data: Buffer };

/** A few tables with the tags every font carries, filled to plausible lengths. */
export function sampleTables(): FontTable[] {
  return [
    { tag: "OS/2", data: Buffer.alloc(96, 1) },
    { tag: "cmap", data: Buffer.alloc(420, 2) },
    { tag: "head", data: Buffer.alloc(54, 3) },
    { tag: "hhea", data: Buffer.alloc(36, 4) },
    { tag: "maxp", data: Buffer.alloc(32, 5) },
    { tag: "name", data: Buffer.alloc(602, 6) },
    { tag: "post", data: Buffer.alloc(32, 7) },
  ];
}

function padded(data: Buffer): Buffer {
  const pad = (4 - (data.length % 4)) % 4;
  return pad ? Buffer.concat([data, Buffer.alloc(pad)]) : data;
}

/**
 * An SFNT - a TrueType font when `signature` is `0x00010000` or `true`, an
 * OpenType CFF font when it is `OTTO` - with its offset table, one record per
 * table and each table's data four-byte aligned after the directory.
 */
export function sfnt(
  signature: "\u0000\u0001\u0000\u0000" | "true" | "OTTO",
  tables: FontTable[],
): Buffer {
  const head = Buffer.alloc(12 + 16 * tables.length);
  head.write(signature, 0, "latin1");
  head.writeUInt16BE(tables.length, 4);
  let offset = head.length;
  const data: Buffer[] = [];
  tables.forEach((table, i) => {
    const at = 12 + 16 * i;
    head.write(table.tag, at, "latin1");
    head.writeUInt32BE(0, at + 4);
    head.writeUInt32BE(offset, at + 8);
    head.writeUInt32BE(table.data.length, at + 12);
    const block = padded(table.data);
    data.push(block);
    offset += block.length;
  });
  return Buffer.concat([head, ...data]);
}

function tablesOf(font: Buffer): { tag: string; data: Buffer }[] {
  const count = font.readUInt16BE(4);
  return Array.from({ length: count }, (_, i) => {
    const at = 12 + 16 * i;
    const offset = font.readUInt32BE(at + 8);
    return {
      tag: font.toString("latin1", at, at + 4),
      data: font.subarray(offset, offset + font.readUInt32BE(at + 12)),
    };
  });
}

/** The SFNT wrapped as a WOFF 1.0 file, each table deflated as a font tool does when that saves bytes. */
export function woff(font: Buffer): Buffer {
  const tables = tablesOf(font);
  const head = Buffer.alloc(44 + 20 * tables.length);
  head.write("wOFF", 0, "latin1");
  font.copy(head, 4, 0, 4);
  head.writeUInt16BE(tables.length, 12);
  head.writeUInt32BE(font.length, 16);
  let offset = head.length;
  const data: Buffer[] = [];
  tables.forEach((table, i) => {
    const deflated = deflateSync(table.data);
    const stored = deflated.length < table.data.length ? deflated : table.data;
    const at = 44 + 20 * i;
    head.write(table.tag, at, "latin1");
    head.writeUInt32BE(offset, at + 4);
    head.writeUInt32BE(stored.length, at + 8);
    head.writeUInt32BE(table.data.length, at + 12);
    const block = padded(stored);
    data.push(block);
    offset += block.length;
  });
  head.writeUInt32BE(offset, 8);
  return Buffer.concat([head, ...data]);
}

/** The SFNT as the only font of a TrueType collection: a `ttcf` header, then the font with its offsets moved past it. */
export function collection(font: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.write("ttcf", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(16, 12);
  const moved = Buffer.from(font);
  const count = moved.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i + 8;
    moved.writeUInt32BE(moved.readUInt32BE(at) + 16, at);
  }
  return Buffer.concat([header, moved]);
}
