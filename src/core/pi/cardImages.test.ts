import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import {
  cardTypefaceNames,
  demoSources,
  isPlayableDemoSource,
  isViewablePictureSource,
  parseCardMediaFileName,
  parseCardPictureFileName,
  parseCardTypefaceFileName,
} from "@shared/cardPictures";
import { describe, expect, it } from "vitest";
import {
  collection,
  projectFontBytes,
  sampleTables,
  sfnt,
  truncatedFontBytes,
  woff,
} from "../../../tests/helpers/fontFixture";
import { gif, MOVING_BOX_GIF_SIZE, movingBoxGifBytes } from "../../../tests/helpers/gifFixture";
import { box, MOVING_BOX, movingBoxBytes, mp4 } from "../../../tests/helpers/mp4Fixture";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { MAX_GIF_DEMO_BYTES } from "../gifFormat";
import { readDemoVideo } from "../videoFormat";
import {
  type CardPictureRoot,
  keepContentFile,
  keepPictureFile,
  MAX_CARD_PICTURE_BYTES,
  MAX_DEMO_BYTES,
  MAX_TYPEFACE_BYTES,
  type MediaProbe,
  TYPEFACE_UNREAD_WORDS,
  type TypefaceProbe,
  verifyCardImages,
} from "./cardImages";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A real grayscale PNG, optionally padded with an ancillary chunk to a size. */
function png(width: number, height: number, padding = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...(padding ? [chunk("zzZz", Buffer.alloc(padding))] : []),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A baseline JPEG's marker structure: SOI, APP0, SOF0 stating the size, a scan, EOI. */
function jpeg(width: number, height: number): Buffer {
  const segment = (marker: number, data: Buffer) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(data.length + 2, 2);
    return Buffer.concat([head, data]);
  };
  const frame = Buffer.alloc(15);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame[5] = 3;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    segment(0xc0, frame),
    segment(0xda, Buffer.alloc(10)),
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
}

function riff(type: string, data: Buffer): Buffer {
  const padded = data.length % 2 ? Buffer.concat([data, Buffer.alloc(1)]) : data;
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(12 + padded.length, 4);
  head.write("WEBP", 8, "ascii");
  head.write(type, 12, "ascii");
  head.writeUInt32LE(data.length, 16);
  return Buffer.concat([head, padded]);
}

/** A WebP in each of its three first-chunk shapes. */
const webp = {
  lossy(width: number, height: number): Buffer {
    const data = Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0, 0, 0, 0]);
    data.writeUInt16LE(width, 6);
    data.writeUInt16LE(height, 8);
    return riff("VP8 ", data);
  },
  lossless(width: number, height: number): Buffer {
    const data = Buffer.alloc(5);
    data[0] = 0x2f;
    data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
    return riff("VP8L", data);
  },
  extended(width: number, height: number): Buffer {
    const data = Buffer.alloc(10);
    data.writeUIntLE(width - 1, 4, 3);
    data.writeUIntLE(height - 1, 7, 3);
    return riff("VP8X", data);
  },
};

async function root(): Promise<CardPictureRoot> {
  const base = scratchDir("fm-card-pictures-");
  const worktree = join(base, "worktree");
  await mkdir(join(worktree, "shots"), { recursive: true });
  return { worktree, dir: join(base, "crewmates", "t1", "cards"), taskId: "t1" };
}

async function copies(at: CardPictureRoot): Promise<string[]> {
  try {
    return (await readdir(at.dir)).sort();
  } catch {
    return [];
  }
}

describe("verifyCardImages", () => {
  it("copies a named picture under the task and rewrites only its src, width and height", async () => {
    const at = await root();
    const bytes = png(3, 2);
    await writeFile(join(at.worktree, "shots", "screen.png"), bytes);
    const before = '<p>The settings screen is <b>ready</b>.</p>\n<figure aria-label="Settings">';
    const after = "<figcaption>As it looks now</figcaption></figure>\n<p>Done.</p>";

    const { body, pictures } = await verifyCardImages(
      `${before}<img class="shot" src="shots/screen.png" alt='Settings in the "ready" state' width="10">${after}`,
      at,
    );

    expect(pictures).toEqual([
      {
        id: expect.any(String),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        alt: 'Settings in the "ready" state',
        width: 3,
        height: 2,
        group: 0,
      },
    ]);
    const id = pictures[0]?.id ?? "";
    expect(body).toBe(
      `${before}<img class="shot" src="app-frame://images/${id}.png" alt="Settings in the &quot;ready&quot; state" width="3" height="2">${after}`,
    );
    // The name locates its own file: the task, then 32 hex of randomness.
    expect(parseCardPictureFileName(`${id}.png`)).toEqual({
      taskId: "t1",
      fileName: `${id}.png`,
      contentType: "image/png",
    });
    expect(await copies(at)).toEqual([`${id}.png`]);
    expect(await readFile(join(at.dir, `${id}.png`))).toEqual(bytes);
  });

  it("accepts PNG, JPEG and WebP, each sized from its own header", async () => {
    const at = await root();
    const files: [string, Buffer, number, number, string][] = [
      ["a.png", png(40, 30), 40, 30, "png"],
      ["b.jpg", jpeg(1200, 760), 1200, 760, "jpg"],
      ["c.webp", webp.lossy(640, 1280), 640, 1280, "webp"],
      ["d.webp", webp.lossless(2800, 520), 2800, 520, "webp"],
      ["e.webp", webp.extended(900, 2660), 900, 2660, "webp"],
    ];
    for (const [name, bytes] of files) await writeFile(join(at.worktree, "shots", name), bytes);

    const { body, pictures } = await verifyCardImages(
      files.map(([name]) => `<img src="shots/${name}" alt="${name}">`).join(""),
      at,
    );

    expect(pictures.map((p) => [p.alt, p.width, p.height])).toEqual(
      files.map(([name, , width, height]) => [name, width, height]),
    );
    for (const [index, [, bytes, , , extension]] of files.entries()) {
      const file = `${pictures[index]?.id}.${extension}`;
      expect(body).toContain(`src="app-frame://images/${file}"`);
      expect(await readFile(join(at.dir, file))).toEqual(bytes);
    }
  });

  it("numbers groups in body order: each fm-pictures figure is one, a lone picture its own", async () => {
    const at = await root();
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      await writeFile(join(at.worktree, "shots", `${name}.png`), png(4, 4));
    }
    const img = (name: string) => `<img src="shots/${name}.png" alt="${name}">`;

    const { pictures } = await verifyCardImages(
      `<p>Before and after.</p><figure class="fm-pictures">${img("a")}${img("b")}<figcaption>Two</figcaption></figure>` +
        `<p>A lone one.</p>${img("c")}` +
        `<details><summary>More</summary><figure class="wide fm-pictures">${img("d")}${img("e")}</figure></details>` +
        `<figure aria-label="Not a group">${img("f")}</figure>`,
      at,
    );

    expect(pictures.map((p) => [p.alt, p.group])).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 1],
      ["d", 2],
      ["e", 2],
      ["f", 3],
    ]);
  });

  it("leaves a picture named by a URL verbatim, with no working copy needed: the frame is the boundary", async () => {
    const body =
      `<p>Drawn here.</p><img src="data:image/png;base64,${png(1, 1).toString("base64")}" alt="">` +
      '<img src="https://example.com/a.png" alt="Remote"><img src="//example.com/b.png">';
    expect(await verifyCardImages(body, undefined)).toEqual({ body, pictures: [] });
  });

  it("refuses a picture from a working copy where there is none", async () => {
    await expect(
      verifyCardImages('<img src="shots/screen.png" alt="No copy">', undefined),
    ).rejects.toThrow(/no working copy/);
  });

  it("refuses a picture with no alt text", async () => {
    const at = await root();
    await writeFile(join(at.worktree, "shots", "screen.png"), png(1, 1));
    await expect(verifyCardImages('<img src="shots/screen.png">', at)).rejects.toThrow(
      /needs alt text/,
    );
    await expect(verifyCardImages('<img src="shots/screen.png" alt=" ">', at)).rejects.toThrow(
      /needs alt text/,
    );
  });

  it("refuses absolute paths, traversal and symlink escapes", async () => {
    const at = await root();
    const outside = scratchDir("fm-card-outside-");
    const file = join(outside, "outside.png");
    await writeFile(file, png(1, 1));
    await symlink(file, join(at.worktree, "linked.png"));

    await expect(verifyCardImages(`<img src="${file}" alt="Outside">`, at)).rejects.toThrow(
      /relative/,
    );
    await expect(
      verifyCardImages('<img src="../../outside.png" alt="Outside">', at),
    ).rejects.toThrow(/file not found|stay inside/);
    await expect(verifyCardImages('<img src="linked.png" alt="Outside">', at)).rejects.toThrow(
      /stay inside/,
    );
  });

  it("shows a picture from the task's evidence folder by absolute path, and only from there", async () => {
    const at = await root();
    const evidenceDir = join(at.worktree, "..", "crewmates", "t1", "evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "after.png"), png(4, 3));
    const outside = scratchDir("fm-card-outside-");
    await writeFile(join(outside, "other.png"), png(1, 1));
    const withEvidence = { ...at, evidenceDir };
    const named = join(evidenceDir, "after.png");

    const { body, pictures } = await verifyCardImages(
      `<img src="${named}" alt="After the change">`,
      withEvidence,
    );
    expect(pictures).toMatchObject([{ alt: "After the change", width: 4, height: 3 }]);
    expect(body).not.toContain(evidenceDir);
    expect(await copies(at)).toHaveLength(1);

    await expect(
      verifyCardImages(`<img src="${join(outside, "other.png")}" alt="Elsewhere">`, withEvidence),
    ).rejects.toThrow(/inside the task's evidence folder/);
    // Without an evidence folder the old rule stands.
    await expect(
      verifyCardImages(`<img src="${named}" alt="After the change">`, at),
    ).rejects.toThrow(/relative/);
  });

  it("refuses files that merely claim to be pictures, and GIF", async () => {
    const at = await root();
    await writeFile(join(at.worktree, "fake.png"), "not an image");
    await writeFile(join(at.worktree, "cut.png"), png(2, 2).subarray(0, 40));
    await writeFile(
      join(at.worktree, "anim.gif"),
      Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;"),
    );

    for (const name of ["fake.png", "cut.png"]) {
      await expect(verifyCardImages(`<img src="${name}" alt="Not one">`, at)).rejects.toThrow(
        /structurally valid PNG, JPEG or WebP/,
      );
    }
    // A GIF is never a picture: it is a demo's recording ("GIF demos" below).
    await expect(verifyCardImages('<img src="anim.gif" alt="Not one">', at)).rejects.toThrow(
      /anim.gif is a GIF; a GIF moves, so it is a demo/,
    );
  });

  it("caps a card's pictures by total size, not by count, and leaves nothing behind", async () => {
    const at = await root();
    // Nine pictures just over 7 MB each: every one is under the 8 MB cap,
    // together they pass 64 MB.
    const each = Math.ceil(MAX_CARD_PICTURE_BYTES / 9) + 1024;
    const big = png(1, 1, each);
    for (let n = 0; n < 9; n += 1) await writeFile(join(at.worktree, `big${n}.png`), big);
    const img = (n: number) => `<img src="big${n}.png" alt="Big ${n}">`;

    await expect(
      verifyCardImages([0, 1, 2, 3, 4, 5, 6, 7, 8].map(img).join(""), at),
    ).rejects.toThrow(/total at most 64MB/);
    expect(await copies(at)).toEqual([]);

    // Many small pictures are fine: there is no count cap.
    await writeFile(join(at.worktree, "small.png"), png(2, 2));
    for (let n = 0; n < 12; n += 1) await writeFile(join(at.worktree, `s${n}.png`), png(2, 2 + n));
    const many = Array.from({ length: 12 }, (_, n) => `<img src="s${n}.png" alt="Small ${n}">`);
    const { pictures } = await verifyCardImages(many.join(""), at);
    expect(pictures).toHaveLength(12);
  });

  it("refuses one bad picture and copies none of the good ones", async () => {
    const at = await root();
    await writeFile(join(at.worktree, "good.png"), png(1, 1));
    await expect(
      verifyCardImages('<img src="good.png" alt="Good"><img src="missing.png" alt="Gone">', at),
    ).rejects.toThrow(/file not found: missing.png/);
    expect(await copies(at)).toEqual([]);
  });
});

// INF-145's re-review: a copy named by its bytes is skipped only when it holds
// exactly them, and replaced whole, so a frame reading it never meets half of one.
describe("keepContentFile", () => {
  it("writes a font's copy once, leaves one holding its bytes alone, and replaces any other whole", async () => {
    const dir = scratchDir("fm-card-keep-");
    const file = join(dir, `t1-${"a".repeat(32)}.woff2`);
    const bytes = projectFontBytes();

    keepContentFile(file, bytes);
    expect(await readFile(file)).toEqual(bytes);
    const first = await stat(file);
    keepContentFile(file, bytes);
    // Left alone: the same file, not a fresh one renamed over it.
    expect((await stat(file)).ino).toBe(first.ino);

    // Damaged in place at its own size, which a size check would have kept.
    const damaged = Buffer.from(bytes);
    damaged.fill(0, 400, 800);
    await writeFile(file, damaged);
    keepContentFile(file, bytes);
    expect(await readFile(file)).toEqual(bytes);
    // Nothing temporary is left beside it.
    expect(await readdir(dir)).toEqual([`t1-${"a".repeat(32)}.woff2`]);
  });
});

describe("keepPictureFile", () => {
  it("keeps one copy of a picture by its content, named so the frame serves and the viewer opens it", async () => {
    const base = scratchDir("fm-kept-pictures-");
    const dir = join(base, "crewmates", "release-notes", "cards");
    const first = join(base, "a.webp");
    const same = join(base, "b.webp");
    await writeFile(first, webp.lossy(1200, 600));
    await writeFile(same, webp.lossy(1200, 600));
    const kept = keepPictureFile(first, { dir, taskId: "release-notes" });
    expect(kept).toMatchObject({ width: 1200, height: 600 });
    expect(kept?.id).toMatch(/^release-notes-[0-9a-f]{32}$/);
    expect(isViewablePictureSource(kept?.src ?? "")).toBe(true);
    expect(parseCardPictureFileName(`${kept?.id}.webp`)?.taskId).toBe("release-notes");
    // The same bytes again, from another file: the same copy.
    expect(keepPictureFile(same, { dir, taskId: "release-notes" })).toEqual(kept);
    expect(await readdir(dir)).toEqual([`${kept?.id}.webp`]);
    expect(await readFile(join(dir, `${kept?.id}.webp`))).toEqual(webp.lossy(1200, 600));
  });

  it("keeps nothing for a missing file or one that only claims to be a picture", async () => {
    const base = scratchDir("fm-kept-pictures-");
    const dir = join(base, "kept");
    await writeFile(join(base, "fake.webp"), "RIFF....WEBPnot a picture");
    expect(keepPictureFile(join(base, "fake.webp"), { dir, taskId: "release-notes" })).toBe(
      undefined,
    );
    expect(keepPictureFile(join(base, "gone.webp"), { dir, taskId: "release-notes" })).toBe(
      undefined,
    );
    expect(await copies({ worktree: base, dir, taskId: "release-notes" })).toEqual([]);
  });
});

/** A probe that decodes what the boxes state, as the host's does for a sound recording. */
const decodes: MediaProbe = async ({ bytes }) => {
  const read = readDemoVideo(bytes);
  if (!read.ok) return { ok: false, reason: "the decoder could not open it" };
  const { width, height, durationMs } = read.video;
  return { ok: true, width, height, durationMs };
};

/** A task root with the host's probe, `decodes` unless named; `null` is a host with none. */
async function demoRoot(probe: MediaProbe | null = decodes): Promise<CardPictureRoot> {
  const at = await root();
  return probe ? { ...at, probe } : at;
}

const demo = (recording: string, poster = "shots/poster.png", caption = "Drag the row") =>
  `<figure class="demo" data-inf-demo="${recording}"><img src="${poster}" alt="${caption}, before and after"><figcaption>${caption}.</figcaption></figure>`;

describe("verifyCardImages: demo recordings", () => {
  it("copies the recording beside its poster, rewrites only the demo's reference and length, and records it on the poster", async () => {
    const at = await demoRoot();
    const recording = movingBoxBytes();
    await writeFile(join(at.worktree, "shots", "demo.mp4"), recording);
    await writeFile(join(at.worktree, "shots", "poster.png"), png(48, 27));
    const lead = "<h3>After</h3><p>Dragging a row moves it.</p>";

    const { body, pictures } = await verifyCardImages(`${lead}${demo("shots/demo.mp4")}`, at);

    const poster = pictures[0];
    const media = poster?.demo;
    expect(pictures).toEqual([
      {
        id: expect.any(String),
        sha256: createHash("sha256").update(png(48, 27)).digest("hex"),
        alt: "Drag the row, before and after",
        width: 48,
        height: 27,
        group: 0,
        demo: {
          id: expect.any(String),
          kind: "mp4",
          width: MOVING_BOX.width,
          height: MOVING_BOX.height,
          durationMs: MOVING_BOX.durationMs,
          bytes: recording.length,
          sha256: createHash("sha256").update(recording).digest("hex"),
        },
      },
    ]);
    expect(body).toBe(
      `${lead}<figure class="demo" data-inf-demo="app-frame://media/${media?.id}.mp4" data-inf-demo-duration="3000"><img src="app-frame://images/${poster?.id}.png" alt="Drag the row, before and after" width="48" height="27"><figcaption>Drag the row.</figcaption></figure>`,
    );
    expect(parseCardMediaFileName(`${media?.id}.mp4`)?.taskId).toBe("t1");
    expect(isPlayableDemoSource(`app-frame://media/${media?.id}.mp4`)).toBe(true);
    expect(await copies(at)).toEqual([`${media?.id}.mp4`, `${poster?.id}.png`].sort());
    expect(await readFile(join(at.dir, `${media?.id}.mp4`))).toEqual(recording);
  });

  it("plays a recording from the task's evidence folder, keeps one copy of a file named twice, and overwrites an author's own length", async () => {
    const at = await demoRoot();
    const evidenceDir = join(at.worktree, "..", "crewmates", "t1", "evidence");
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, "after.mp4"), mp4());
    await writeFile(join(evidenceDir, "after.png"), png(64, 36));
    const recording = join(evidenceDir, "after.mp4");
    const poster = join(evidenceDir, "after.png");
    const lied = `<figure data-inf-demo="${recording}" data-inf-demo-duration="1"><img src="${poster}" alt="Again"></figure>`;

    const { body, pictures } = await verifyCardImages(`${demo(recording, poster)}${lied}`, {
      ...at,
      evidenceDir,
    });
    expect(pictures.map((picture) => picture.demo?.id)).toEqual([
      pictures[0]?.demo?.id,
      pictures[0]?.demo?.id,
    ]);
    expect(body).not.toContain(evidenceDir);
    expect(body.match(/data-inf-demo-duration="2000"/g)).toHaveLength(2);
    expect(await copies(at)).toHaveLength(2);
  });

  it("copies a demo marked in Firstmate 3000's spelling, and leaves no path in the working copy under either name", async () => {
    const at = await demoRoot();
    await writeFile(join(at.worktree, "shots", "demo.mp4"), movingBoxBytes());
    await writeFile(join(at.worktree, "shots", "poster.png"), png(48, 27));
    const theirs = demo("shots/demo.mp4").replace("data-inf-demo", "data-fm-demo");

    const { body, pictures } = await verifyCardImages(theirs, at);

    const media = pictures[0]?.demo;
    expect(media?.kind).toBe("mp4");
    const src = `app-frame://media/${media?.id}.mp4`;
    expect(body).toContain(`data-fm-demo="${src}"`);
    expect(body).toContain(`data-inf-demo="${src}"`);
    expect(body).toContain('data-fm-demo-duration="3000"');
    expect(body).not.toContain("shots/demo.mp4");
    expect(demoSources(body)).toEqual(new Set([src]));
  });

  it("refuses a demo whose markup is not one figure holding one named poster", async () => {
    const at = await demoRoot();
    await writeFile(join(at.worktree, "shots", "demo.mp4"), mp4());
    await writeFile(join(at.worktree, "shots", "poster.png"), png(64, 36));
    const poster = '<img src="shots/poster.png" alt="Poster">';
    for (const [markup, refusal] of [
      [`<div data-inf-demo="shots/demo.mp4">${poster}</div>`, /belongs on the <figure>/],
      [`<figure data-inf-demo="shots/demo.mp4"></figure>`, /exactly one <img>/],
      [`<figure data-inf-demo="shots/demo.mp4">${poster}${poster}</figure>`, /exactly one <img>/],
      [
        `<figure data-inf-demo="shots/demo.mp4"><img src="data:image/png;base64,iVBORw0KGgo=" alt="P"></figure>`,
        /exactly one <img>/,
      ],
      [
        `<figure data-inf-demo="shots/demo.mp4"><figure data-inf-demo="shots/demo.mp4">${poster}</figure></figure>`,
        /cannot sit inside another/,
      ],
      [`<figure data-inf-demo="https://example.com/a.mp4">${poster}</figure>`, /never a URL/],
      [
        `<figure data-inf-demo="app-frame://media/t1-${"a".repeat(32)}.mp4">${poster}</figure>`,
        /never a URL/,
      ],
      [`<figure data-inf-demo="">${poster}</figure>`, /never a URL/],
    ] as const) {
      await expect(verifyCardImages(markup, at), markup).rejects.toThrow(refusal);
    }
    expect(await copies(at)).toEqual([]);
  });

  it("refuses a recording outside its homes, missing, too large or not a demo MP4, naming why", async () => {
    const at = await demoRoot();
    await writeFile(join(at.worktree, "shots", "poster.png"), png(64, 36));
    const outside = scratchDir("fm-card-outside-");
    await writeFile(join(outside, "elsewhere.mp4"), mp4());
    await symlink(join(outside, "elsewhere.mp4"), join(at.worktree, "linked.mp4"));
    await writeFile(join(at.worktree, "big.mp4"), Buffer.alloc(MAX_DEMO_BYTES + 1));
    await writeFile(join(at.worktree, "loud.mp4"), mp4({ audio: true }));
    await writeFile(join(at.worktree, "long.mp4"), mp4({ seconds: 45 }));
    await writeFile(join(at.worktree, "fake.mp4"), "not a recording");

    for (const [recording, refusal] of [
      [join(outside, "elsewhere.mp4"), /relative/],
      ["linked.mp4", /stay inside the task's working copy/],
      ["../../elsewhere.mp4", /file not found|stay inside/],
      ["missing.mp4", /file not found: missing.mp4/],
      ["big.mp4", /no larger than 16MB/],
      ["loud.mp4", /loud.mp4 carries sound: a demo is silent/],
      ["long.mp4", /runs 45.0 seconds/],
      ["fake.mp4", /does not start with an ftyp box/],
    ] as const) {
      await expect(verifyCardImages(demo(recording), at), recording).rejects.toThrow(refusal);
    }
    expect(await copies(at)).toEqual([]);
  });

  it("refuses a poster that is not the recording's shape", async () => {
    const at = await demoRoot();
    await writeFile(join(at.worktree, "shots", "demo.mp4"), mp4({ width: 640, height: 360 }));
    await writeFile(join(at.worktree, "shots", "poster.png"), png(40, 40));
    await expect(verifyCardImages(demo("shots/demo.mp4"), at)).rejects.toThrow(
      /its poster is 40 × 40, which is not the shape of shots\/demo.mp4 \(640 × 360\)/,
    );
  });

  it("refuses a recording the host's probe cannot play, or that plays other than it states, or with no probe at all", async () => {
    const cases: [MediaProbe | null, RegExp][] = [
      [
        async () => ({ ok: false, reason: "no frame decoded at 1.0 seconds" }),
        /did not play back: no frame decoded at 1.0 seconds/,
      ],
      [
        async () => {
          throw new Error("the probe ran past 5 seconds");
        },
        /did not play back: the probe ran past 5 seconds/,
      ],
      [
        async () => ({ ok: true, width: 320, height: 180, durationMs: 2000 }),
        /played back at 320 × 180/,
      ],
      [
        async () => ({ ok: true, width: 640, height: 360, durationMs: 9000 }),
        /for 9.0 seconds, not the 640 × 360 and 2.0 seconds/,
      ],
      [null, /cannot play a recording here to check it/],
    ];
    for (const [probe, refusal] of cases) {
      const at = await demoRoot(probe);
      await writeFile(join(at.worktree, "shots", "demo.mp4"), mp4());
      await writeFile(join(at.worktree, "shots", "poster.png"), png(64, 36));
      await expect(verifyCardImages(demo("shots/demo.mp4"), at)).rejects.toThrow(refusal);
      expect(await copies(at)).toEqual([]);
    }
  });

  it("counts recordings in a card's total, and a demo in a card with no working copy is refused", async () => {
    const at = await demoRoot();
    await writeFile(join(at.worktree, "shots", "poster.png"), png(64, 36));
    // Seven pictures just under the 8 MB cap fit a card; a 9 MB recording
    // beside them tips it past 64 MB, though the recording is under its own cap.
    const big = png(1, 1, 8 * 1024 * 1024 - 64 * 1024);
    for (let n = 0; n < 7; n += 1) await writeFile(join(at.worktree, `big${n}.png`), big);
    const pictures = [0, 1, 2, 3, 4, 5, 6].map((n) => `<img src="big${n}.png" alt="Big ${n}">`);
    await expect(verifyCardImages(pictures.join(""), at)).resolves.toBeTruthy();
    const padded = Buffer.concat([mp4(), box("free", Buffer.alloc(9 * 1024 * 1024))]);
    expect(padded.length).toBeLessThan(MAX_DEMO_BYTES);
    await writeFile(join(at.worktree, "shots", "demo.mp4"), padded);
    const before = (await copies(at)).length;
    await expect(verifyCardImages(pictures.join("") + demo("shots/demo.mp4"), at)).rejects.toThrow(
      /pictures, recordings and fonts may total at most 64MB/,
    );
    expect(await copies(at)).toHaveLength(before);

    await expect(verifyCardImages(demo("shots/demo.mp4"), undefined)).rejects.toThrow(
      /no working copy here/,
    );
  });
});

describe("verifyCardImages: GIF demos", () => {
  /** A probe that fails the test if it is ever asked: a GIF's walk is its whole check. */
  const neverAsked: MediaProbe = async () => {
    throw new Error("a GIF demo went to the probe");
  };

  it("copies a single-play GIF as the demo, by its own walk and with no probe", async () => {
    const at = await demoRoot(neverAsked);
    const recording = movingBoxGifBytes();
    await writeFile(join(at.worktree, "shots", "demo.gif"), recording);
    await writeFile(join(at.worktree, "shots", "poster.png"), png(48, 27));

    const { body, pictures } = await verifyCardImages(demo("shots/demo.gif"), at);

    const poster = pictures[0];
    const media = poster?.demo;
    expect(media).toEqual({
      id: expect.any(String),
      kind: "gif",
      width: MOVING_BOX_GIF_SIZE.width,
      height: MOVING_BOX_GIF_SIZE.height,
      durationMs: MOVING_BOX_GIF_SIZE.durationMs,
      bytes: recording.length,
      sha256: createHash("sha256").update(recording).digest("hex"),
    });
    expect(body).toBe(
      `<figure class="demo" data-inf-demo="app-frame://media/${media?.id}.gif" data-inf-demo-duration="3000"><img src="app-frame://images/${poster?.id}.png" alt="Drag the row, before and after" width="48" height="27"><figcaption>Drag the row.</figcaption></figure>`,
    );
    expect(isPlayableDemoSource(`app-frame://media/${media?.id}.gif`)).toBe(true);
    expect(await copies(at)).toEqual([`${media?.id}.gif`, `${poster?.id}.png`].sort());
    expect(await readFile(join(at.dir, `${media?.id}.gif`))).toEqual(recording);
  });

  it("keeps a GIF demo where the host has no probe at all", async () => {
    const at = await demoRoot(null);
    await writeFile(join(at.worktree, "shots", "demo.gif"), gif());
    await writeFile(join(at.worktree, "shots", "poster.png"), png(64, 36));
    const { pictures } = await verifyCardImages(demo("shots/demo.gif"), at);
    expect(pictures[0]?.demo).toMatchObject({ kind: "gif", durationMs: 2000 });
  });

  it("refuses a GIF that loops, runs past its limits, is too large or is not a GIF, naming why", async () => {
    const at = await demoRoot(neverAsked);
    await writeFile(join(at.worktree, "shots", "poster.png"), png(64, 36));
    await writeFile(join(at.worktree, "loops.gif"), gif({ loop: "NETSCAPE2.0" }));
    await writeFile(join(at.worktree, "long.gif"), gif({ frames: 60, delay: 20 }));
    await writeFile(join(at.worktree, "fast.gif"), gif({ delay: 4 }));
    await writeFile(join(at.worktree, "still.gif"), gif({ frames: 1 }));
    await writeFile(join(at.worktree, "cut.gif"), gif({ shortBy: 5 }));
    await writeFile(join(at.worktree, "fake.gif"), "not a recording");
    // Over the GIF's own cap, though under an MP4's.
    const big = Buffer.concat([gif({ trailing: false }), Buffer.alloc(MAX_GIF_DEMO_BYTES)]);
    expect(big.length).toBeLessThan(MAX_DEMO_BYTES);
    await writeFile(join(at.worktree, "big.gif"), big);

    for (const [recording, refusal] of [
      ["loops.gif", /loops.gif carries a loop instruction \(its NETSCAPE2.0 block\)/],
      ["long.gif", /runs 12.0 seconds: a GIF demo runs at most 10/],
      ["fast.gif", /plays at most 10 frames a second/],
      ["still.gif", /holds one picture and does not move/],
      ["cut.gif", /picture data is cut short/],
      ["fake.gif", /fake.gif is not a GIF/],
      ["big.gif", /is a GIF larger than 8MB/],
    ] as const) {
      await expect(verifyCardImages(demo(recording), at), recording).rejects.toThrow(refusal);
    }
    expect(await copies(at)).toEqual([]);
  });

  it("refuses a GIF named as a picture, pointing it at a demo figure", async () => {
    const at = await demoRoot(neverAsked);
    await writeFile(join(at.worktree, "shots", "moves.gif"), gif());
    await expect(
      verifyCardImages('<img src="shots/moves.gif" alt="It moves">', at),
    ).rejects.toThrow(
      /shots\/moves.gif is a GIF; a GIF moves, so it is a demo: name it in <figure data-inf-demo=/,
    );
    // A poster must be a still too.
    await expect(verifyCardImages(demo("shots/moves.gif", "shots/moves.gif"), at)).rejects.toThrow(
      /is a GIF; a GIF moves/,
    );
    expect(await copies(at)).toEqual([]);
  });
});

// INF-128's plan, approved by the captain ("a way for a card to use the
// project's own font files"): a preview's @font-face names a font file by
// path, and the host checks, loads, keeps and serves its own copy.
describe("verifyCardImages: project fonts", () => {
  /** A loader that loads every font, and the content types of each card's fonts it was handed together. */
  function loads(): TypefaceProbe & { asked: string[][] } {
    const asked: string[][] = [];
    return Object.assign(
      async (typefaces: readonly { contentType: string }[]) => {
        asked.push(typefaces.map(({ contentType }) => contentType));
        return typefaces.map(() => ({ ok: true as const }));
      },
      { asked },
    );
  }

  async function fontRoot(probe: TypefaceProbe | null = loads()): Promise<CardPictureRoot> {
    const at = await root();
    return probe ? { ...at, typefaceProbe: probe } : at;
  }

  const face = (src: string, family = "Wallet") =>
    `@font-face{font-family:"${family}";src:url("${src}") format("woff2")}`;
  const preview = (sheet: string) =>
    `<p>The balance screen.</p><style>${sheet}.b{font-family:"Wallet"}</style><div class="b">$42.50</div>`;

  it("copies a font an @font-face names by path and rewrites only that url(), once however often or however it is named", async () => {
    const probe = loads();
    const at = await fontRoot(probe);
    const bytes = projectFontBytes();
    await writeFile(join(at.worktree, "shots", "Fredoka-600.woff2"), bytes);
    const sheet =
      "@font-face { font-family: 'Wallet'; font-weight: 600;\n" +
      "  /* src: url(shots/missing.woff2) */\n" +
      "  src: local(\"Fredoka\"), url( 'shots/Fredoka-600.woff2' ) format('woff2'); }\n" +
      `${face("./shots/../shots/Fredoka-600.woff2", "Wallet bold")}` +
      ".hero { background: url(shots/missing.png); }";

    const { body, pictures } = await verifyCardImages(preview(sheet), at);

    expect(pictures).toEqual([]);
    const [name, ...others] = cardTypefaceNames(body);
    expect(others).toEqual([]);
    const typeface = parseCardTypefaceFileName(name ?? "");
    expect(typeface).toMatchObject({ taskId: "t1", kind: "woff2", contentType: "font/woff2" });
    const kept = `url("app-frame://typefaces/${name}")`;
    expect(body).toBe(
      preview(
        "@font-face { font-family: 'Wallet'; font-weight: 600;\n" +
          "  /* src: url(shots/missing.woff2) */\n" +
          `  src: local(\"Fredoka\"), ${kept} format('woff2'); }\n` +
          `@font-face{font-family:"Wallet bold";src:${kept} format("woff2")}` +
          ".hero { background: url(shots/missing.png); }",
      ),
    );
    expect(await copies(at)).toEqual([name]);
    expect(await readFile(join(at.dir, name ?? ""))).toEqual(bytes);
    // Loaded once, as the font it is by its own bytes, though spelled two ways.
    expect(probe.asked).toEqual([["font/woff2"]]);
  });

  // INF-145's review: a fresh name for each copy made every revision of a
  // font preview read as "Preview updated", whatever it changed.
  it("names a font's copy by its own bytes, so a revision keeps it and a changed font gets another", async () => {
    const probe = loads();
    const at = await fontRoot(probe);
    const bytes = projectFontBytes();
    const other = woff(sfnt("\u0000\u0001\u0000\u0000", sampleTables()));
    await writeFile(join(at.worktree, "shots", "face.woff2"), bytes);
    await writeFile(join(at.worktree, "shots", "other.woff"), other);
    const named = `t1-${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.woff2`;

    const first = await verifyCardImages(preview(face("shots/face.woff2")), at);
    const again = await verifyCardImages(preview(face("shots/face.woff2")), at);
    expect(cardTypefaceNames(first.body)).toEqual([named]);
    expect(again.body).toBe(first.body);
    expect(await copies(at)).toEqual([named]);

    // Two fonts on one card load together, in one window.
    const both = await verifyCardImages(
      preview(face("shots/face.woff2") + face("shots/other.woff", "Other")),
      at,
    );
    expect(probe.asked.at(-1)).toEqual(["font/woff2", "font/woff"]);
    expect(cardTypefaceNames(both.body)).toEqual([
      named,
      `t1-${createHash("sha256").update(other).digest("hex").slice(0, 32)}.woff`,
    ]);
  });

  it("takes a font from the evidence folder by absolute path, and leaves one named by a URL as written", async () => {
    const at = await fontRoot();
    const evidenceDir = join(at.worktree, "..", "crewmates", "t1", "evidence");
    await mkdir(evidenceDir, { recursive: true });
    const linked = join(evidenceDir, "NunitoSans-400.woff2");
    await writeFile(linked, projectFontBytes());
    const urls =
      face("https://fonts.example/nunito.woff2", "Web") +
      face("data:font/woff2;base64,d09GMgABAAA=", "Inline") +
      face("app-frame://typefaces/t0-0123456789abcdef0123456789abcdef.woff2", "Copied");

    const { body } = await verifyCardImages(preview(face(linked) + urls), {
      ...at,
      evidenceDir,
    });
    expect(body).not.toContain(evidenceDir);
    expect(body).toContain(urls);
    expect(await copies(at)).toHaveLength(1);
    // A body whose fonts are all URLs needs no working copy: the frame loads none of them.
    await expect(verifyCardImages(preview(urls), undefined)).resolves.toEqual({
      body: preview(urls),
      pictures: [],
    });
  });

  it("refuses a font outside its homes, missing, too large, not a font, cut short or a collection, naming why", async () => {
    const at = await fontRoot();
    const outside = scratchDir("fm-card-outside-");
    await writeFile(join(outside, "outside.woff2"), projectFontBytes());
    await symlink(join(outside, "outside.woff2"), join(at.worktree, "linked.woff2"));
    await mkdir(join(at.worktree, "folder.woff2"));
    const big = sfnt("\u0000\u0001\u0000\u0000", [
      { tag: "glyf", data: Buffer.alloc(MAX_TYPEFACE_BYTES) },
    ]);
    await writeFile(join(at.worktree, "big.ttf"), big);
    await writeFile(join(at.worktree, "shot.woff2"), png(2, 2));
    await writeFile(join(at.worktree, "cut.woff2"), truncatedFontBytes());
    await writeFile(
      join(at.worktree, "family.ttc"),
      collection(sfnt("\u0000\u0001\u0000\u0000", sampleTables())),
    );

    const cases: [string, RegExp][] = [
      [join(outside, "outside.woff2"), /Card font refused: src must be a path relative/],
      ["../../outside.woff2", /Card font refused: (file not found|path must stay inside)/],
      ["linked.woff2", /Card font refused: path must stay inside the task's working copy/],
      ["missing.woff2", /Card font refused: file not found: missing.woff2/],
      ["folder.woff2", /folder.woff2 must be a regular font file no larger than 8MB/],
      ["big.ttf", /big.ttf must be a regular font file no larger than 8MB/],
      ["shot.woff2", /shot.woff2 is not a WOFF2, WOFF, TrueType or OpenType font/],
      [
        "cut.woff2",
        new RegExp(
          `cut.woff2 is cut short or damaged: its header says ${projectFontBytes().length} bytes`,
        ),
      ],
      ["family.ttc", /family.ttc is a font collection, which a preview cannot load/],
    ];
    for (const [src, refusal] of cases) {
      await expect(verifyCardImages(preview(face(src)), at), src).rejects.toThrow(refusal);
    }
    expect(await copies(at)).toEqual([]);
  });

  it("refuses a font the host's font engine cannot load, or with no loader at all, and keeps none of the card", async () => {
    const cases: [TypefaceProbe | null, RegExp][] = [
      [
        async (typefaces) =>
          typefaces.map(() => ({
            ok: false,
            reason: "its sanitizer said: Failed to convert WOFF 2.0 font to SFNT",
          })),
        new RegExp(
          `face.woff2 ${TYPEFACE_UNREAD_WORDS}: its sanitizer said: Failed to convert WOFF 2.0 font to SFNT\\. Name an undamaged copy`,
        ),
      ],
      [
        async () => {
          throw new Error("it did not load within 5 seconds");
        },
        new RegExp(`${TYPEFACE_UNREAD_WORDS}: it did not load within 5 seconds`),
      ],
      [null, /cannot load a font here to check it, so draw the preview in the app's own typefaces/],
    ];
    for (const [probe, refusal] of cases) {
      const at = await fontRoot(probe);
      await writeFile(join(at.worktree, "shots", "face.woff2"), projectFontBytes());
      await writeFile(join(at.worktree, "shots", "screen.png"), png(3, 2));
      const body = `${preview(face("shots/face.woff2"))}<img src="shots/screen.png" alt="The screen">`;
      await expect(verifyCardImages(body, at)).rejects.toThrow(refusal);
      // Every file is checked before any is kept, so the picture stays behind too.
      expect(await copies(at)).toEqual([]);
    }
  });

  it("counts fonts in a card's total with its pictures, and refuses a font with no working copy", async () => {
    const at = await fontRoot();
    const big = png(1, 1, 8 * 1024 * 1024 - 64 * 1024);
    for (let n = 0; n < 8; n += 1) await writeFile(join(at.worktree, `big${n}.png`), big);
    const pictures = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `<img src="big${n}.png" alt="Big ${n}">`);
    await writeFile(
      join(at.worktree, "face.otf"),
      sfnt("OTTO", [{ tag: "CFF ", data: Buffer.alloc(1024 * 1024) }]),
    );
    await expect(verifyCardImages(pictures.join(""), at)).resolves.toBeTruthy();
    const before = (await copies(at)).length;
    await expect(
      verifyCardImages(pictures.join("") + preview(face("face.otf")), at),
    ).rejects.toThrow(/pictures, recordings and fonts may total at most 64MB/);
    expect(await copies(at)).toHaveLength(before);

    await expect(verifyCardImages(preview(face("face.otf")), undefined)).rejects.toThrow(
      /Card font refused: there is no working copy here to name a font file from/,
    );
  });
});
