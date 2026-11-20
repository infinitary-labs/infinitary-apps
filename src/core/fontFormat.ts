/**
 * What a project font file is, read from its own header (docs/card-authoring.md,
 * "Fonts by reference"). Pure and dependency-free like `./pictureFormat`: a
 * WOFF2, WOFF, TrueType or OpenType font whose header agrees with the file's
 * size and whose table directory lies inside it, or the one reason it is
 * not, worded for the crewmate who named it.
 *
 * Reading the header is a check of the file, not of its glyphs: the host
 * still loads the font in its own font engine before it keeps one
 * (`TypefaceProbe`, `src/core/pi/cardImages.ts`), and the frame's engine
 * checks it again, so a file whose structure is right and whose tables are
 * not is refused all the same.
 */

export type FontKind = "woff2" | "woff" | "ttf" | "otf";

export type FontRead = { ok: true; kind: FontKind } | { ok: false; reason: string };

class Refusal extends Error {}

function refuse(reason: string): never {
  throw new Refusal(reason);
}

const NOT_A_FONT = "is not a WOFF2, WOFF, TrueType or OpenType font";
const COLLECTION =
  "is a font collection, which a preview cannot load; name one font's own file instead";

/** The SFNT flavors a font may declare: TrueType outlines (two spellings) or OpenType CFF. */
const SFNT_FLAVORS: Readonly<Record<string, FontKind>> = {
  "\u0000\u0001\u0000\u0000": "ttf",
  true: "ttf",
  OTTO: "otf",
};

function tag(bytes: Buffer, at: number): string {
  return bytes.toString("latin1", at, at + 4);
}

/** A table's tag as words can carry it: printable, trimmed, never control characters. */
function tableName(bytes: Buffer, at: number): string {
  return tag(bytes, at)
    .replace(/[^\x20-\x7e]/g, "?")
    .trim();
}

/** A block the header names - metadata or private data - is absent, or lies inside the file. */
function blockInside(bytes: Buffer, offset: number, length: number, where: number): void {
  if (offset === 0 && length === 0) return;
  if (offset < where || offset + length > bytes.length) {
    refuse(`${NOT_A_FONT}: a block its header names lies outside the file`);
  }
}

/** The header's stated length is the file's own, or the file was cut short or padded. */
function sized(bytes: Buffer, stated: number): void {
  if (stated !== bytes.length) {
    refuse(
      `is cut short or damaged: its header says ${stated} bytes, but the file holds ${bytes.length}`,
    );
  }
}

/** An SFNT's offset table and table records, every table inside the file. */
function sfnt(bytes: Buffer, kind: FontKind): FontKind {
  if (bytes.length < 12) refuse(`${NOT_A_FONT}: it ends inside its header`);
  const tables = bytes.readUInt16BE(4);
  const directoryEnd = 12 + 16 * tables;
  if (tables === 0) refuse(`${NOT_A_FONT}: it names no tables`);
  if (directoryEnd > bytes.length) refuse("is cut short: its table directory runs past its end");
  for (let i = 0; i < tables; i++) {
    const at = 12 + 16 * i;
    const offset = bytes.readUInt32BE(at + 8);
    const length = bytes.readUInt32BE(at + 12);
    if (offset < directoryEnd || offset + length > bytes.length) {
      refuse(`is damaged: its ${tableName(bytes, at)} table lies outside the file`);
    }
  }
  return kind;
}

/** A WOFF 1.0 file: its header and table directory, every compressed table inside the file. */
function woff(bytes: Buffer): FontKind {
  if (bytes.length < 44) refuse(`${NOT_A_FONT}: it ends inside its header`);
  const flavor = tag(bytes, 4);
  if (flavor === "ttcf") refuse(COLLECTION);
  if (!SFNT_FLAVORS[flavor]) refuse(`${NOT_A_FONT}: its header names no font flavor`);
  sized(bytes, bytes.readUInt32BE(8));
  const tables = bytes.readUInt16BE(12);
  if (tables === 0) refuse(`${NOT_A_FONT}: it names no tables`);
  if (bytes.readUInt16BE(14) !== 0) refuse(`${NOT_A_FONT}: its header is malformed`);
  const directoryEnd = 44 + 20 * tables;
  if (directoryEnd > bytes.length) refuse("is cut short: its table directory runs past its end");
  for (let i = 0; i < tables; i++) {
    const at = 44 + 20 * i;
    const offset = bytes.readUInt32BE(at + 4);
    const compressed = bytes.readUInt32BE(at + 8);
    const original = bytes.readUInt32BE(at + 12);
    if (offset < directoryEnd || offset + compressed > bytes.length || compressed > original) {
      refuse(`is damaged: its ${tableName(bytes, at)} table lies outside the file`);
    }
  }
  blockInside(bytes, bytes.readUInt32BE(24), bytes.readUInt32BE(28), directoryEnd);
  blockInside(bytes, bytes.readUInt32BE(36), bytes.readUInt32BE(40), directoryEnd);
  return "woff";
}

/** WOFF2's variable-length number: at most five bytes, no leading zero, within 32 bits. */
function base128(bytes: Buffer, at: { offset: number }): number {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (at.offset >= bytes.length) refuse("is cut short: its table directory runs past its end");
    const byte = bytes[at.offset++] as number;
    if (i === 0 && byte === 0x80) refuse(`${NOT_A_FONT}: its table directory is malformed`);
    value = value * 128 + (byte & 0x7f);
    if (value > 0xffffffff) refuse(`${NOT_A_FONT}: its table directory is malformed`);
    if ((byte & 0x80) === 0) return value;
  }
  return refuse(`${NOT_A_FONT}: its table directory is malformed`);
}

/** The two WOFF2 tables whose transform is the default: `glyf` and `loca`, by index or by tag. */
const GLYF_LOCA = new Set([10, 11]);

/**
 * A WOFF2 file: its header, its table directory, and its compressed tables
 * after the directory - all inside the file. Decompressing them is the font
 * engine's work, in the host's test load.
 */
function woff2(bytes: Buffer): FontKind {
  if (bytes.length < 48) refuse(`${NOT_A_FONT}: it ends inside its header`);
  const flavor = tag(bytes, 4);
  if (flavor === "ttcf") refuse(COLLECTION);
  if (!SFNT_FLAVORS[flavor]) refuse(`${NOT_A_FONT}: its header names no font flavor`);
  sized(bytes, bytes.readUInt32BE(8));
  const tables = bytes.readUInt16BE(12);
  if (tables === 0) refuse(`${NOT_A_FONT}: it names no tables`);
  if (bytes.readUInt16BE(14) !== 0) refuse(`${NOT_A_FONT}: its header is malformed`);
  const compressed = bytes.readUInt32BE(20);
  const at = { offset: 48 };
  for (let i = 0; i < tables; i++) {
    if (at.offset >= bytes.length) refuse("is cut short: its table directory runs past its end");
    const flags = bytes[at.offset++] as number;
    const known = flags & 0x3f;
    let glyfOrLoca = GLYF_LOCA.has(known);
    if (known === 0x3f) {
      if (at.offset + 4 > bytes.length)
        refuse("is cut short: its table directory runs past its end");
      glyfOrLoca = ["glyf", "loca"].includes(tag(bytes, at.offset));
      at.offset += 4;
    }
    base128(bytes, at);
    const version = flags >> 6;
    // glyf and loca are transformed unless marked with the null transform (3);
    // every other table is transformed only when marked with one.
    if (glyfOrLoca ? version === 0 : version !== 0) base128(bytes, at);
  }
  const dataEnd = at.offset + compressed;
  if (compressed === 0 || dataEnd > bytes.length) {
    refuse("is cut short: its compressed tables run past its end");
  }
  blockInside(bytes, bytes.readUInt32BE(28), bytes.readUInt32BE(32), dataEnd);
  blockInside(bytes, bytes.readUInt32BE(40), bytes.readUInt32BE(44), dataEnd);
  return "woff2";
}

function font(bytes: Buffer): FontKind {
  if (bytes.length < 4) refuse(NOT_A_FONT);
  const signature = tag(bytes, 0);
  if (signature === "wOF2") return woff2(bytes);
  if (signature === "wOFF") return woff(bytes);
  if (signature === "ttcf") refuse(COLLECTION);
  const flavor = SFNT_FLAVORS[signature];
  if (!flavor) refuse(NOT_A_FONT);
  return sfnt(bytes, flavor);
}

/**
 * The font a file's bytes state, or why it is not one: a WOFF2 or WOFF whose
 * header states the file's own length and whose table directory and tables
 * lie inside it, or a TrueType or OpenType font whose table records do; a
 * font collection is refused, since a preview's `@font-face` loads one face.
 */
export function readFont(bytes: Buffer): FontRead {
  try {
    return { ok: true, kind: font(bytes) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}
