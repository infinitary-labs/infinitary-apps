import { ATTACHMENT_MAX_BYTES, type ChosenFile, type DroppedPath } from "@shared/attachments";
import type { ComposerNotice } from "@shared/composer";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImageAttachment } from "../design/core/ComposerField";
import {
  cancelPending,
  type FileDestination,
  giveFiles,
  isPreparing,
  pickFiles,
  readDroppedFile,
  useIntakeStore,
  whenPrepared,
} from "./intake";

/** Real picture bytes: the intake reads a picture by its content, never its name. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

const png = () => Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
const utf8 = (text: string) => new TextEncoder().encode(text);
const pdfBytes = () =>
  Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00, 0xff, 0xfe]);

function file(name: string, content: Uint8Array | string, type = ""): File {
  return new File([typeof content === "string" ? utf8(content) : (content as BlobPart)], name, {
    type,
  });
}

/** A host that knows where files "live": the path a file name maps to, else none. */
function hostOf(places: Record<string, DroppedPath>, delay?: () => Promise<void>) {
  return {
    dropped: async (f: File): Promise<DroppedPath> => {
      await delay?.();
      return places[f.name] ?? { kind: "no-path" };
    },
    choose: async (): Promise<ChosenFile[] | null> => null,
  };
}

function destination(over: Partial<FileDestination> = {}) {
  const log = {
    images: [] as ImageAttachment[],
    texts: [] as Array<{ text: string; name: string }>,
    notices: [] as ComposerNotice[],
    paths: [] as string[][],
  };
  const dest: FileDestination = {
    key: "main",
    accepts: () => true,
    takesPaths: () => true,
    applyImages: (items) => log.images.push(...items),
    applyText: (text, name) => log.texts.push({ text, name }),
    notice: (notice) => log.notices.push(notice),
    insertPaths: (paths) => log.paths.push(paths),
    ...over,
  };
  return { dest, log };
}

beforeEach(() => {
  useIntakeStore.setState({ pending: {}, status: {} });
});

describe("a dropped file, by what it is", () => {
  it("makes a picture a chip, from its bytes and not its name or type", async () => {
    const host = hostOf({});
    const result = await readDroppedFile(file("shot.txt", png(), "text/plain"), host);
    expect(result).toMatchObject({
      kind: "image",
      item: { name: "shot.txt", mimeType: "image/png", data: PNG_BASE64 },
    });
  });

  it("keeps a text file's every byte: BOM, CRLF, Unicode, 78,438 characters of it", async () => {
    const text = `﻿${"naïve ✓ — résumé\r\n".repeat(4_600)}`.slice(0, 78_438);
    expect(text.length).toBe(78_438);
    const result = await readDroppedFile(file("big.csv", text), hostOf({}));
    if (result.kind !== "text") throw new Error(`not text: ${result.kind}`);
    expect(Buffer.from(utf8(result.text)).equals(Buffer.from(utf8(text)))).toBe(true);
    expect(result.name).toBe("big.csv");
  });

  it("lets an empty text file attach by name", async () => {
    expect(await readDroppedFile(file("empty.txt", ""), hostOf({}))).toEqual({
      kind: "text",
      text: "",
      name: "empty.txt",
    });
  });

  it("turns an unsupported format into its exact path, never a chip, copy or basename", async () => {
    const path = "/Users/me/My Documents/rapport été 2.pdf";
    const host = hostOf({ "rapport été 2.pdf": { kind: "regular", path } });
    expect(await readDroppedFile(file("rapport été 2.pdf", pdfBytes()), host)).toEqual({
      kind: "unsupported",
      path,
    });
    const zip = Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0xff]);
    const zipHost = hostOf({ "a.zip": { kind: "regular", path: "/tmp/a.zip" } });
    expect(await readDroppedFile(file("a.zip", zip), zipHost)).toEqual({
      kind: "unsupported",
      path: "/tmp/a.zip",
    });
  });

  it("explains a generated file with no place on disk instead of inventing a path", async () => {
    expect(await readDroppedFile(file("clip.pdf", pdfBytes()), hostOf({}))).toEqual({
      kind: "unsupported",
      path: null,
    });
    const { dest, log } = destination();
    await giveFiles(dest, [file("clip.pdf", pdfBytes())], hostOf({}));
    expect(log.notices).toEqual(["file-not-local"]);
    expect(log.paths).toEqual([]);
  });

  it("refuses a folder, a shortcut and an oddity by their own words", async () => {
    const places: Record<string, DroppedPath> = {
      dir: { kind: "folder" },
      link: { kind: "shortcut" },
      pipe: { kind: "other" },
    };
    const host = hostOf(places);
    expect(await readDroppedFile(file("dir", ""), host)).toMatchObject({ notice: "file-folder" });
    expect(await readDroppedFile(file("link", "x"), host)).toMatchObject({
      notice: "file-shortcut",
    });
    expect(await readDroppedFile(file("pipe", "x"), host)).toMatchObject({
      notice: "file-unreadable",
    });
  });

  it("keeps an over-cap supported file as an error, not a path", async () => {
    const host = hostOf({
      "big.txt": { kind: "regular", path: "/tmp/big.txt" },
      "big.png": { kind: "regular", path: "/tmp/big.png" },
    });
    const text = new Uint8Array(ATTACHMENT_MAX_BYTES + 1).fill(0x61);
    expect(await readDroppedFile(file("big.txt", text), host)).toEqual({
      kind: "notice",
      notice: "file-too-big",
    });
    const big = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
    big.set(png());
    expect(await readDroppedFile(file("big.png", big), host)).toEqual({
      kind: "notice",
      notice: "picture-too-big",
    });
  });

  it("treats text that turns binary after its head as an unsupported format", async () => {
    const body = new Uint8Array(20_000).fill(0x61);
    body[15_000] = 0xff;
    const host = hostOf({ "late.dat": { kind: "regular", path: "/tmp/late.dat" } });
    expect(await readDroppedFile(file("late.dat", body), host)).toEqual({
      kind: "unsupported",
      path: "/tmp/late.dat",
    });
  });
});

describe("giving a batch to an input", () => {
  it("applies a mixed batch in selection order: chips for what is supported, one block of paths for the rest", async () => {
    const { dest, log } = destination();
    const host = hostOf({
      "a.pdf": { kind: "regular", path: "/Users/me/a b/a.pdf" },
      "b.docx": { kind: "regular", path: "/Users/me/b.docx" },
    });
    await giveFiles(
      dest,
      [
        file("a.pdf", pdfBytes()),
        file("shot.png", png()),
        file("b.docx", pdfBytes()),
        file("n.txt", "hi\r\n"),
      ],
      host,
    );
    expect(log.images.map((i) => i.name)).toEqual(["shot.png"]);
    expect(log.texts).toEqual([{ text: "hi\r\n", name: "n.txt" }]);
    expect(log.paths).toEqual([["/Users/me/a b/a.pdf", "/Users/me/b.docx"]]);
    expect(isPreparing("main")).toBe(false);
    expect(useIntakeStore.getState().status.main).toContain("shot.png ready");
    expect(useIntakeStore.getState().status.main).toContain("Added 2 file paths as text");
  });

  it("on an app controlling another Mac, sends pictures and text on and refuses the rest by one notice, never as a path", async () => {
    const { dest, log } = destination({ takesPaths: () => false });
    const host = hostOf({ "a.pdf": { kind: "regular", path: "/Users/me/a.pdf" } });
    await giveFiles(
      dest,
      [
        file("a.pdf", pdfBytes()),
        file("shot.png", png()),
        file("clip.zip", Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0xff])),
        file("n.txt", "hi\n"),
      ],
      host,
    );
    expect(log.images.map((i) => i.name)).toEqual(["shot.png"]);
    expect(log.texts).toEqual([{ text: "hi\n", name: "n.txt" }]);
    // The PDF with a place on this Mac and the generated archive with none are refused alike.
    expect(log.notices).toEqual(["file-other-mac", "file-other-mac"]);
    expect(log.paths).toEqual([]);
    expect(useIntakeStore.getState().status.main).toContain("shot.png ready");
    expect(useIntakeStore.getState().status.main).not.toContain("file path");
    // Folders and shortcuts keep their own words there too.
    const odd = destination({ takesPaths: () => false });
    await giveFiles(odd.dest, [file("dir", "")], hostOf({ dir: { kind: "folder" } }));
    expect(odd.log.notices).toEqual(["file-folder"]);
  });

  it("leaves everything alone when the input takes no files", async () => {
    const { dest, log } = destination({ accepts: () => false });
    await giveFiles(dest, [file("n.txt", "hi")], hostOf({}));
    expect(log).toEqual({ images: [], texts: [], notices: [], paths: [] });
  });

  it("prepares in view, lets a file be cancelled, and holds a send until the rest is ready", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { dest, log } = destination();
    const done = giveFiles(
      dest,
      [file("keep.txt", "keep"), file("drop.txt", "drop")],
      hostOf({}, () => gate),
    );
    await Promise.resolve();
    expect(useIntakeStore.getState().pending.main?.map((f) => f.name)).toEqual([
      "keep.txt",
      "drop.txt",
    ]);
    const waiting = whenPrepared("main");
    let ready = false;
    void waiting.then(() => {
      ready = true;
    });
    const second = useIntakeStore.getState().pending.main?.[1];
    if (!second) throw new Error("no second file");
    cancelPending("main", second.id);
    release();
    await done;
    await waiting;
    expect(ready).toBe(true);
    expect(log.texts).toEqual([{ text: "keep", name: "keep.txt" }]);
  });

  it("drops a late result once the input stopped taking files, never landing it in another message", async () => {
    let open = true;
    const { dest, log } = destination({ accepts: () => open });
    const host = hostOf({}, async () => {
      open = false;
    });
    await giveFiles(dest, [file("n.txt", "late")], host);
    expect(log.texts).toEqual([]);
    expect(isPreparing("main")).toBe(false);
  });

  it("keeps each input's files separate by key", async () => {
    const main = destination();
    const reply = destination({ key: "card-1" });
    await giveFiles(reply.dest, [file("r.txt", "reply")], hostOf({}));
    expect(reply.log.texts).toHaveLength(1);
    expect(main.log.texts).toHaveLength(0);
    expect(useIntakeStore.getState().status["card-1"]).toContain("r.txt ready");
  });
});

describe("choosing files in the picker", () => {
  it("changes nothing when cancelled", async () => {
    const { dest, log } = destination();
    await pickFiles(dest, { choose: async () => null });
    expect(log).toEqual({ images: [], texts: [], notices: [], paths: [] });
  });

  it("follows the same rule: chips for supported files, the path for the rest, errors by name", async () => {
    const { dest, log } = destination();
    await pickFiles(dest, {
      choose: async () => [
        {
          kind: "image",
          name: "a.jpg",
          mimeType: "image/jpeg",
          data: Uint8Array.from(atob(JPEG_BASE64), (c) => c.charCodeAt(0)),
        },
        { kind: "text", name: "log.txt", data: utf8("﻿line\r\n") },
        { kind: "unsupported", name: "x.xlsx", path: "/Users/me/Q3 plan.xlsx" },
        { kind: "too-big", name: "huge.txt", image: false },
        { kind: "folder", name: "stuff" },
      ],
    });
    expect(log.images.map((i) => i.mimeType)).toEqual(["image/jpeg"]);
    expect(log.texts).toEqual([{ text: "﻿line\r\n", name: "log.txt" }]);
    expect(log.paths).toEqual([["/Users/me/Q3 plan.xlsx"]]);
    expect(log.notices).toEqual(["file-too-big", "file-folder"]);
  });

  it("on an app controlling another Mac, refuses a chosen file that is neither a picture nor text", async () => {
    const { dest, log } = destination({ takesPaths: () => false });
    await pickFiles(dest, {
      choose: async () => [
        { kind: "text", name: "log.txt", data: utf8("line\n") },
        { kind: "unsupported", name: "x.xlsx", path: "/Users/me/Q3 plan.xlsx" },
      ],
    });
    expect(log.texts).toEqual([{ text: "line\n", name: "log.txt" }]);
    expect(log.notices).toEqual(["file-other-mac"]);
    expect(log.paths).toEqual([]);
  });
});
