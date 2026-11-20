import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_MAX_BYTES } from "@shared/attachments";
import { describe, expect, it } from "vitest";
import { jpegImage, pngImage } from "../../tests/helpers/images";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import {
  AttachmentUnavailableError,
  attachmentPath,
  importChosenFile,
  initAttachmentsDir,
  inspectPath,
  keepImages,
  loadImages,
} from "./attachments";

function fresh(): string {
  const dir = scratchDir("infinitary-att-");
  initAttachmentsDir(join(dir, "attachments"));
  return dir;
}

describe("a message's own picture copies", () => {
  it("keeps verified copies privately and reads back the same bytes", () => {
    fresh();
    const id = randomUUID();
    const refs = keepImages(id, [{ ...pngImage, name: "/tmp/../Screen Shot.png" }, jpegImage]);
    expect(refs.map((ref) => [ref.name, ref.mimeType, ref.file.startsWith(`${id}/`)])).toEqual([
      ["Screen Shot.png", "image/png", true],
      ["jpg", "image/jpeg", true],
    ]);
    const file = attachmentPath(refs[0] as (typeof refs)[number]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    expect(loadImages(refs)).toEqual([
      { mimeType: "image/png", data: pngImage.data },
      { mimeType: "image/jpeg", data: jpegImage.data },
    ]);
  });

  it("refuses a picture whose bytes are not the type it claims, and leaves nothing behind", () => {
    const dir = fresh();
    const id = randomUUID();
    expect(() =>
      keepImages(id, [pngImage, { mimeType: "image/png", data: jpegImage.data }]),
    ).toThrow(/do not match/);
    expect(() => statSync(join(dir, "attachments", id))).toThrow();
    expect(() => keepImages(id, [{ mimeType: "image/png", data: "" }])).toThrow();
    expect(() => keepImages("../escape", [pngImage])).toThrow(/malformed/);
  });

  it("blocks a copy that is missing, changed or forged, naming the picture", () => {
    fresh();
    const [ref] = keepImages(randomUUID(), [{ ...pngImage, name: "a.png" }]);
    if (!ref) throw new Error("no ref");
    const file = attachmentPath(ref);
    writeFileSync(file, readFileSync(file).subarray(0, 20));
    expect(() => loadImages([ref])).toThrow(AttachmentUnavailableError);
    rmSync(file);
    expect(() => loadImages([ref])).toThrow(/a\.png.*missing/);
    expect(() => attachmentPath({ file: "../../etc/passwd" })).toThrow(/outside/);
    expect(() => loadImages([{ ...ref, file: "../x.png" }])).toThrow(/outside/);
  });
});

describe("a file the captain chose", () => {
  function write(dir: string, name: string, content: string | Uint8Array): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it("reads text whole, byte for byte, with its BOM and CRLF line endings", async () => {
    const dir = fresh();
    const text = `﻿${"héllo ✓\r\n".repeat(9_000)}`;
    const chosen = await importChosenFile(write(dir, "notes.csv", text));
    expect(chosen).toMatchObject({ kind: "text", name: "notes.csv" });
    if (chosen.kind !== "text") throw new Error("not text");
    expect(Buffer.from(chosen.data).equals(Buffer.from(text, "utf8"))).toBe(true);
    expect(await importChosenFile(write(dir, "empty.txt", ""))).toMatchObject({ kind: "text" });
  });

  it("reads a picture by its bytes whatever its name says", async () => {
    const dir = fresh();
    const path = write(dir, "photo.txt", Buffer.from(pngImage.data, "base64"));
    expect(await importChosenFile(path)).toMatchObject({ kind: "image", mimeType: "image/png" });
  });

  it("gives an unsupported format back as its path alone, spaces and Unicode kept", async () => {
    const dir = fresh();
    const folder = join(dir, "Mes documents été");
    mkdirSync(folder);
    const pdf = write(
      folder,
      "rapport 1.pdf",
      Buffer.from("%PDF-1.7\n\u0000\u0001binary", "latin1"),
    );
    const zip = write(folder, "a.zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0xff, 0xfe]));
    expect(await importChosenFile(pdf)).toEqual({
      kind: "unsupported",
      name: "rapport 1.pdf",
      path: pdf,
    });
    expect(await importChosenFile(zip)).toMatchObject({ kind: "unsupported", path: zip });
  });

  it("does not read an unsupported file past its head", async () => {
    const dir = fresh();
    // Unreadable beyond the first block would fail a full read; only the head is opened for it.
    const path = write(
      dir,
      "big.bin",
      Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.alloc(ATTACHMENT_MAX_BYTES * 2)]),
    );
    expect(await importChosenFile(path)).toMatchObject({ kind: "unsupported" });
  });

  it("refuses an over-cap supported file with its own error, never its path", async () => {
    const dir = fresh();
    const big = write(dir, "log.txt", "a".repeat(ATTACHMENT_MAX_BYTES + 1));
    expect(await importChosenFile(big)).toEqual({ kind: "too-big", name: "log.txt", image: false });
    const png = Buffer.concat([
      Buffer.from(pngImage.data, "base64"),
      Buffer.alloc(ATTACHMENT_MAX_BYTES),
    ]);
    expect(await importChosenFile(write(dir, "big.png", png))).toMatchObject({
      kind: "too-big",
      image: true,
    });
  });

  it("text that turns binary after its head is an unsupported format after all", async () => {
    const dir = fresh();
    const path = write(
      dir,
      "late.dat",
      Buffer.concat([Buffer.from("plain words ".repeat(1000)), Buffer.from([0xff, 0xff])]),
    );
    expect(await importChosenFile(path)).toMatchObject({ kind: "unsupported", path });
  });

  it("never follows a shortcut, enters a folder or reads a missing or unreadable file", async () => {
    const dir = fresh();
    const real = write(dir, "real.txt", "hi");
    const link = join(dir, "link.txt");
    symlinkSync(real, link);
    expect(await importChosenFile(link)).toEqual({ kind: "shortcut", name: "link.txt" });
    expect(await inspectPath(link)).toEqual({ kind: "shortcut" });
    expect(await importChosenFile(dir)).toMatchObject({ kind: "folder" });
    expect(await inspectPath(real)).toEqual({ kind: "regular", path: real });
    expect(await importChosenFile(join(dir, "gone.txt"))).toMatchObject({ kind: "unreadable" });
    const locked = write(dir, "locked.txt", "secret");
    chmodSync(locked, 0o000);
    if (process.getuid?.() !== 0) {
      expect(await importChosenFile(locked)).toMatchObject({ kind: "unreadable" });
    }
    chmodSync(locked, 0o600);
  });

  it("leaves the original untouched", async () => {
    const dir = fresh();
    const path = write(dir, "keep.txt", "same");
    const before = statSync(path);
    await importChosenFile(path);
    expect(readFileSync(path, "utf8")).toBe("same");
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  });
});
