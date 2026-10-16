import { describe, expect, it } from "vitest";
import {
  collection,
  damagedFontBytes,
  projectFontBytes,
  sampleTables,
  sfnt,
  truncatedFontBytes,
  woff,
} from "../../tests/helpers/fontFixture";
import { readFont } from "./fontFormat";

// INF-128's plan, approved by the captain: the host checks a project font's
// own structure before it keeps one, and refuses a damaged one with the fix.

function reason(bytes: Buffer): string {
  const read = readFont(bytes);
  if (read.ok) throw new Error("expected a refusal");
  return read.reason;
}

const TRUETYPE = "\u0000\u0001\u0000\u0000" as const;

describe("readFont", () => {
  it("reads a project's own WOFF2, as Google Fonts serves it", () => {
    expect(readFont(projectFontBytes())).toEqual({ ok: true, kind: "woff2" });
  });

  it("reads a TrueType, OpenType or WOFF font by its own signature, whatever it is named", () => {
    expect(readFont(sfnt(TRUETYPE, sampleTables()))).toEqual({ ok: true, kind: "ttf" });
    expect(readFont(sfnt("true", sampleTables()))).toEqual({ ok: true, kind: "ttf" });
    expect(readFont(sfnt("OTTO", sampleTables()))).toEqual({ ok: true, kind: "otf" });
    expect(readFont(woff(sfnt(TRUETYPE, sampleTables())))).toEqual({ ok: true, kind: "woff" });
    expect(readFont(woff(sfnt("OTTO", sampleTables())))).toEqual({ ok: true, kind: "woff" });
  });

  it("refuses a WOFF2 or WOFF cut short, naming the size its header claims", () => {
    expect(reason(truncatedFontBytes())).toBe(
      `is cut short or damaged: its header says ${projectFontBytes().length} bytes, but the file holds 2000`,
    );
    const font = woff(sfnt(TRUETYPE, sampleTables()));
    expect(reason(font.subarray(0, font.length - 8))).toMatch(/^is cut short or damaged/);
    expect(reason(projectFontBytes().subarray(0, 30))).toMatch(/ends inside its header/);
  });

  it("leaves a WOFF2 damaged only inside its compressed tables to the font engine", () => {
    // Its header, directory and lengths are whole: only decompressing it finds the damage.
    expect(readFont(damagedFontBytes())).toEqual({ ok: true, kind: "woff2" });
  });

  it("refuses a font whose table lies outside the file", () => {
    const font = sfnt(TRUETYPE, sampleTables());
    // The first table record's offset points past the file's end.
    font.writeUInt32BE(font.length + 4, 12 + 8);
    expect(reason(font)).toBe("is damaged: its OS/2 table lies outside the file");
    const short = sfnt("OTTO", sampleTables());
    expect(reason(short.subarray(0, 40))).toBe(
      "is cut short: its table directory runs past its end",
    );
    const packed = woff(sfnt(TRUETYPE, sampleTables()));
    packed.writeUInt32BE(packed.length, 44 + 4);
    expect(reason(packed)).toBe("is damaged: its OS/2 table lies outside the file");
  });

  it("refuses a font collection, in either wrapping, since a face loads one font", () => {
    const words =
      "is a font collection, which a preview cannot load; name one font's own file instead";
    expect(reason(collection(sfnt(TRUETYPE, sampleTables())))).toBe(words);
    const wrapped = Buffer.from(projectFontBytes());
    wrapped.write("ttcf", 4, "latin1");
    expect(reason(wrapped)).toBe(words);
  });

  it("refuses files that are not fonts at all", () => {
    const notFont = /^is not a WOFF2, WOFF, TrueType or OpenType font/;
    expect(reason(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toMatch(notFont);
    expect(reason(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toMatch(notFont);
    expect(reason(Buffer.alloc(2))).toMatch(notFont);
    expect(reason(sfnt(TRUETYPE, []))).toMatch(/names no tables/);
  });
});
