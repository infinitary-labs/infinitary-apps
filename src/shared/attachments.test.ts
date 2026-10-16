import { describe, expect, it } from "vitest";
import {
  attachmentWords,
  classifyHead,
  decodeText,
  looksLikeText,
  pathInsertion,
  safeDisplayName,
  sniffImageType,
} from "./attachments";

const bytes = (...values: number[]) => new Uint8Array(values);
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("file classes", () => {
  it("knows the four picture types by their leading bytes, not a name", () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageType(utf8("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(utf8("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(utf8("not a picture.png"))).toBeUndefined();
  });

  it("calls strict UTF-8 text, a BOM included, text; binary and bad UTF-8 are not", () => {
    expect(looksLikeText(utf8("line one\r\nline two\r\n"))).toBe(true);
    expect(looksLikeText(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69))).toBe(true);
    expect(looksLikeText(utf8("日本語 ✓"))).toBe(true);
    expect(looksLikeText(bytes(0xff, 0xfe, 0x41))).toBe(false);
    expect(looksLikeText(bytes(0x68, 0x00, 0x69))).toBe(false);
    expect(looksLikeText(utf8("%PDF-1.7\n%âãÏÓ\n\u0000"))).toBe(false);
  });

  it("keeps a BOM and every line ending when it decodes", () => {
    const text = "﻿a\r\nb\rc\n";
    expect(decodeText(utf8(text))).toBe(text);
    expect(decodeText(bytes(0xff, 0xff))).toBeUndefined();
  });

  it("lets a head cut mid-character stay text, and sends everything else past the head to unsupported", () => {
    const head = utf8("日本語").subarray(0, 7);
    expect(looksLikeText(head)).toBe(false);
    expect(classifyHead(head, 9_000)).toEqual({ kind: "text" });
    expect(classifyHead(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00), 4000)).toEqual({
      kind: "unsupported",
    });
    expect(classifyHead(new Uint8Array(), 0)).toEqual({ kind: "text" });
    expect(classifyHead(utf8("GIF89a"), 6)).toEqual({ kind: "image", mimeType: "image/gif" });
  });
});

describe("names and paths", () => {
  it("shows a file by its last segment, as text, bounded and free of controls", () => {
    expect(safeDisplayName("/Users/x/Documents/My Report.pdf")).toBe("My Report.pdf");
    expect(safeDisplayName("..\\..\\secret\u0007.txt")).toBe("secret.txt");
    expect(safeDisplayName("")).toBe("file");
    expect(safeDisplayName("a".repeat(400)).length).toBe(120);
    expect(attachmentWords([{ name: "a.png" }, { name: "b.png" }])).toBe(
      "2 pictures: a.png, b.png",
    );
  });

  it("types paths at the caret one per line, set apart from the words around them", () => {
    const paths = ["/Users/me/My Folder/réport 1.pdf", "/tmp/a b/c.zip"];
    expect(pathInsertion("", 0, 0, paths)).toBe(paths.join("\n"));
    expect(pathInsertion("see ", 4, 4, ["/a.pdf"])).toBe("\n/a.pdf");
    expect(pathInsertion("see this", 4, 4, ["/a.pdf"])).toBe("\n/a.pdf\n");
    expect(pathInsertion("line\n", 5, 5, ["/a.pdf"])).toBe("/a.pdf");
    expect(pathInsertion("a\nb", 2, 2, ["/a.pdf"])).toBe("/a.pdf\n");
    expect(pathInsertion("x", 0, 0, [])).toBe("");
  });
});
